const $ = (id) => document.getElementById(id);
const frame = $("artifact");
const device = $("device");

const state = {
  reviewId: null,
  title: "Human Review",
  version: 0,
  html: "",
  comments: [],
  edits: [],
  selected: null,
  selection: null,
  commentTarget: null,
  editStarts: new WeakMap(),
  dirty: false,
  saveTimer: null,
};

let rpcId = 0;
const pendingRequests = new Map();

function rpcNotify(method, params) {
  window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
}

function rpcRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pendingRequests.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;

  if (typeof message.id === "number") {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(message.error);
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "ui/notifications/tool-result") hydrateFromResult(message.params);
}, { passive: true });

const bridgeReady = (async () => {
  try {
    await rpcRequest("ui/initialize", {
      appInfo: { name: "human-review-widget", version: "0.2.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    });
    rpcNotify("ui/notifications/initialized", {});
  } catch (error) {
    console.error("MCP Apps bridge initialization failed", error);
  }
})();

async function callTool(name, args) {
  await bridgeReady;
  return rpcRequest("tools/call", { name, arguments: args });
}

function hiddenMetaFrom(response) {
  return response?._meta
    || response?.mcp_tool_result?._meta
    || window.openai?.toolResponseMetadata?.mcp_tool_result?._meta
    || window.openai?.toolResponseMetadata?.call_tool_result?._meta
    || null;
}

function hydrateFromResult(response) {
  const structured = response?.structuredContent || response?.mcp_tool_result?.structuredContent || response;
  const meta = hiddenMetaFrom(response);
  const review = meta?.review;
  if (!structured?.review_id && !review?.id) return;

  state.reviewId = structured?.review_id || review.id;
  state.title = structured?.title || review?.title || "Human Review";
  state.version = structured?.source_version || review?.sourceVersion || 0;
  if (review?.html) {
    state.html = review.html;
    state.comments = Array.isArray(review.comments) ? review.comments : [];
    state.edits = Array.isArray(review.edits) ? review.edits : [];
    renderArtifact();
  }
  renderRail();
  $("status").textContent = structured?.status || "editing";
}

function hydrateFromOpenAI() {
  const structured = window.openai?.toolOutput;
  const meta = window.openai?.toolResponseMetadata?.mcp_tool_result?._meta
    || window.openai?.toolResponseMetadata?.call_tool_result?._meta;
  if (structured || meta) hydrateFromResult({ structuredContent: structured, _meta: meta });
}

function closestBlock(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el) return null;
  return el.closest("section,article,header,footer,nav,main,div,p,h1,h2,h3,h4,h5,h6,ul,ol,li,figure,blockquote,img,button,a") || el;
}

function ensureBlockId(el) {
  if (!el.dataset.hrId) el.dataset.hrId = `block_${crypto.randomUUID().slice(0, 8)}`;
  return el.dataset.hrId;
}

function blockLabel(el) {
  const text = (el.innerText || el.alt || el.getAttribute?.("aria-label") || el.tagName || "Block")
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 72) : el.tagName;
}

function installArtifactEditing() {
  const doc = frame.contentDocument;
  if (!doc?.body) return;

  const uiStyle = doc.createElement("style");
  uiStyle.dataset.humanReviewUi = "";
  uiStyle.textContent = `
    [data-hr-selected] { outline: 2px solid #625cff !important; outline-offset: 2px !important; }
    body { min-height: 100vh; }
  `;
  doc.head?.appendChild(uiStyle);
  doc.body.contentEditable = "true";
  doc.body.spellcheck = true;

  doc.addEventListener("click", (event) => {
    const block = closestBlock(event.target);
    if (!block || block === doc.body || block === doc.documentElement) return;
    selectBlock(block);
  });

  doc.addEventListener("mouseup", () => {
    const selection = frame.contentWindow?.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      state.selection = null;
      renderControls();
      return;
    }
    const quote = selection.toString().replace(/\s+/g, " ").trim();
    if (!quote) return;
    const range = selection.getRangeAt(0);
    const pre = doc.createRange();
    pre.selectNodeContents(doc.body);
    pre.setEnd(range.startContainer, range.startOffset);
    const bodyText = doc.body.innerText || doc.body.textContent || "";
    const start = pre.toString().length;
    const end = start + selection.toString().length;
    state.selection = {
      quote,
      anchor: {
        prefix: bodyText.slice(Math.max(0, start - 32), start),
        quote: selection.toString(),
        suffix: bodyText.slice(end, end + 32),
      },
    };
    renderControls();
  });

  doc.addEventListener("beforeinput", (event) => {
    const block = closestBlock(event.target);
    if (!block || block === doc.body) return;
    ensureBlockId(block);
    if (!state.editStarts.has(block)) {
      state.editStarts.set(block, { html: block.innerHTML, text: block.innerText || block.textContent || "" });
    }
  });

  doc.addEventListener("input", (event) => {
    const block = closestBlock(event.target);
    if (!block || block === doc.body) return;
    const id = ensureBlockId(block);
    const start = state.editStarts.get(block) || { html: "", text: "" };
    upsertEdit({
      id: `edit_${id}`,
      label: blockLabel(block),
      kind: "edited",
      before: start.text,
      after: block.innerText || block.textContent || "",
      before_html: start.html,
      after_html: block.innerHTML,
    });
    scheduleSave();
  });
}

function selectBlock(block) {
  const doc = frame.contentDocument;
  doc?.querySelectorAll("[data-hr-selected]").forEach((el) => el.removeAttribute("data-hr-selected"));
  state.selected = block;
  if (block) {
    ensureBlockId(block);
    block.setAttribute("data-hr-selected", "");
  }
  renderControls();
}

function cleanClone(doc) {
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelectorAll("[data-human-review-ui]").forEach((el) => el.remove());
  clone.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeAttribute("draggable");
    el.removeAttribute("data-hr-selected");
    el.removeAttribute("data-hr-id");
  });
  return clone;
}

function serializeArtifact() {
  const doc = frame.contentDocument;
  if (!doc?.documentElement) return state.html;
  return `<!doctype html>\n${cleanClone(doc).outerHTML}`;
}

function upsertEdit(edit) {
  const index = state.edits.findIndex((item) => item.id === edit.id);
  if (index >= 0) state.edits[index] = edit;
  else state.edits.push(edit);
  state.dirty = true;
  renderRail();
}

function moveSelected(direction) {
  const el = state.selected;
  if (!el?.parentElement) return;
  const beforeText = el.innerText || el.textContent || "";
  if (direction < 0 && el.previousElementSibling) el.parentElement.insertBefore(el, el.previousElementSibling);
  if (direction > 0 && el.nextElementSibling) el.parentElement.insertBefore(el.nextElementSibling, el);
  const id = ensureBlockId(el);
  upsertEdit({ id: `move_${id}`, label: blockLabel(el), kind: "moved", before: beforeText, after: beforeText });
  scheduleSave();
}

function deleteSelected() {
  const el = state.selected;
  if (!el) return;
  const id = ensureBlockId(el);
  const before = el.innerText || el.textContent || "";
  const beforeHtml = el.outerHTML;
  el.remove();
  state.selected = null;
  upsertEdit({ id: `delete_${id}`, label: before.slice(0, 72) || "Deleted block", kind: "deleted", before, after: "", before_html: beforeHtml, after_html: "" });
  scheduleSave();
  renderControls();
}

function openComposer(kind) {
  const target = kind === "selection"
    ? state.selection
    : state.selected ? { quote: blockLabel(state.selected), anchor: null } : null;
  if (!target) return;
  state.commentTarget = { kind, ...target };
  $("composerQuote").textContent = target.quote;
  $("commentText").value = "";
  $("composer").classList.add("active");
  $("commentText").focus();
}

function saveComment() {
  const feedback = $("commentText").value.trim();
  if (!feedback || !state.commentTarget) return;
  const target = state.commentTarget;
  state.comments.push({
    id: `comment_${crypto.randomUUID().slice(0, 8)}`,
    kind: target.kind,
    quote: target.quote,
    anchor: target.anchor || null,
    feedback,
  });
  state.commentTarget = null;
  $("composer").classList.remove("active");
  state.dirty = true;
  renderRail();
  scheduleSave();
}

function cancelComment() {
  state.commentTarget = null;
  $("composer").classList.remove("active");
}

function renderArtifact() {
  frame.onload = () => {
    installArtifactEditing();
    state.selected = null;
    state.selection = null;
    renderControls();
  };
  frame.srcdoc = state.html;
}

function renderControls() {
  $("commentSelection").disabled = !state.selection;
  $("commentBlock").disabled = !state.selected;
  $("moveUp").disabled = !state.selected;
  $("moveDown").disabled = !state.selected;
  $("deleteBlock").disabled = !state.selected;
}

function renderRail() {
  $("commentCount").textContent = String(state.comments.length);
  $("editCount").textContent = String(state.edits.length);
  $("comments").innerHTML = state.comments.length ? state.comments.map((comment) => `
    <div class="card"><strong>${escapeHtml(comment.kind === "selection" ? "Selection" : "Block")}</strong><div class="quote">${escapeHtml(comment.quote)}</div><div class="body">${escapeHtml(comment.feedback)}</div></div>
  `).join("") : '<div class="empty">No comments yet.</div>';
  $("edits").innerHTML = state.edits.length ? state.edits.map((edit) => `
    <div class="card"><strong>${escapeHtml(edit.kind)}</strong><div class="quote">${escapeHtml(edit.label || edit.before || "Change")}</div></div>
  `).join("") : '<div class="empty">No direct edits yet.</div>';
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function scheduleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveDraft().catch(console.error), 700);
}

async function saveDraft() {
  if (!state.reviewId) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const draftHtml = serializeArtifact();
  const result = await callTool("save_review_draft", {
    review_id: state.reviewId,
    draft_html: draftHtml,
    edits: state.edits,
    comments: state.comments,
  });
  const structured = result?.structuredContent || result;
  if (structured?.draft_version) state.version = structured.draft_version;
  state.html = draftHtml;
  state.dirty = false;
  $("status").textContent = "saved";
}

async function submitReview() {
  $("submit").disabled = true;
  $("submit").textContent = "Sending…";
  try {
    if (state.dirty) await saveDraft();
    const draftHtml = serializeArtifact();
    const result = await callTool("submit_review", {
      review_id: state.reviewId,
      draft_html: draftHtml,
      edits: state.edits,
      comments: state.comments,
    });
    const structured = result?.structuredContent || result;
    const batchId = structured?.batch_id;
    $("status").textContent = "feedback sent";
    const prompt = `Apply Human Review feedback batch ${batchId} for review ${state.reviewId}. Preserve direct user edits exactly unless a comment explicitly asks to change one.`;
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
    } else {
      try {
        await rpcRequest("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
      } catch (error) {
        console.warn("Feedback submitted, but automatic follow-up was unavailable.", error);
      }
    }
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "Send changes";
  }
}

$("desktop").addEventListener("click", () => device.classList.remove("mobile"));
$("mobile").addEventListener("click", () => device.classList.add("mobile"));
$("fullscreen").addEventListener("click", async () => {
  try {
    await bridgeReady;
    await rpcRequest("ui/request-display-mode", { mode: "fullscreen" });
  } catch (error) {
    if (window.openai?.requestDisplayMode) await window.openai.requestDisplayMode({ mode: "fullscreen" });
  }
});
$("commentSelection").addEventListener("click", () => openComposer("selection"));
$("commentBlock").addEventListener("click", () => openComposer("element"));
$("saveComment").addEventListener("click", saveComment);
$("cancelComment").addEventListener("click", cancelComment);
$("moveUp").addEventListener("click", () => moveSelected(-1));
$("moveDown").addEventListener("click", () => moveSelected(1));
$("deleteBlock").addEventListener("click", deleteSelected);
$("submit").addEventListener("click", () => submitReview().catch((error) => {
  console.error(error);
  $("status").textContent = "error";
}));

renderRail();
renderControls();
hydrateFromOpenAI();
