const $ = (id) => document.getElementById(id);

const state = {
  review: null,
  evidence: null,
  findings: [],
  activeFindingId: null,
  savingDecision: false,
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
  if (message.method === "ui/notifications/tool-result") hydrate(message.params);
}, { passive: true });

const bridgeReady = (async () => {
  try {
    await rpcRequest("ui/initialize", {
      appInfo: { name: "web-review-widget", version: "0.3.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    });
    rpcNotify("ui/notifications/initialized", {});
  } catch (error) {
    console.error("Web Review bridge initialization failed", error);
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

function hydrate(response) {
  const meta = hiddenMetaFrom(response);
  const webReview = meta?.web_review;
  if (!webReview?.evidence) return;
  state.review = webReview.review || null;
  state.evidence = webReview.evidence;
  state.findings = Array.isArray(webReview.findings) ? webReview.findings : [];
  state.activeFindingId = state.findings[0]?.id || null;
  state.savingDecision = false;
  render();
}

function hydrateFromOpenAI() {
  const meta = window.openai?.toolResponseMetadata?.mcp_tool_result?._meta
    || window.openai?.toolResponseMetadata?.call_tool_result?._meta;
  if (meta) hydrate({ _meta: meta });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function sourceOf(finding) {
  return finding?.source || "deterministic";
}

function sourceLabel(finding) {
  return sourceOf(finding) === "visual_critic" ? "visual critic" : "deterministic";
}

function findingCounts() {
  const counts = { total: state.findings.length, info: 0, warning: 0, error: 0, critical: 0, new: 0, accepted: 0, rejected: 0, deterministic: 0, visual_critic: 0 };
  for (const finding of state.findings) {
    if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
    if (Object.hasOwn(counts, finding.status)) counts[finding.status] += 1;
    const source = sourceOf(finding);
    if (Object.hasOwn(counts, source)) counts[source] += 1;
  }
  return counts;
}

function activeFinding() {
  return state.findings.find((finding) => finding.id === state.activeFindingId) || null;
}

function render() {
  const evidence = state.evidence;
  if (!evidence) return;
  $("title").textContent = state.review?.title || evidence.title || "Web Review";
  $("meta").textContent = `${evidence.finalUrl} · ${evidence.viewport.width}×${evidence.viewport.height} · evidence ${evidence.id}`;
  $("shot").src = `data:${evidence.screenshotMimeType || "image/png"};base64,${evidence.screenshotBase64}`;
  $("sendDecisions").disabled = false;
  const counts = findingCounts();
  $("counts").innerHTML = [
    `<span class="pill">${counts.total} total</span>`,
    counts.deterministic ? `<span class="pill">${counts.deterministic} deterministic</span>` : "",
    counts.visual_critic ? `<span class="pill">${counts.visual_critic} visual</span>` : "",
    counts.error ? `<span class="pill">${counts.error} error</span>` : "",
    counts.warning ? `<span class="pill">${counts.warning} warning</span>` : "",
    counts.accepted ? `<span class="pill">${counts.accepted} accepted</span>` : "",
    counts.rejected ? `<span class="pill">${counts.rejected} rejected</span>` : "",
    counts.new ? `<span class="pill">${counts.new} undecided</span>` : "",
  ].join("");
  $("findings").innerHTML = state.findings.length ? state.findings.map((finding) => {
    const source = sourceOf(finding);
    return `
    <button class="finding ${source} ${finding.status || "new"} ${finding.id === state.activeFindingId ? "active" : ""}" data-finding-id="${escapeHtml(finding.id)}" type="button">
      <strong>${escapeHtml(finding.title)} <span class="status">${escapeHtml(finding.status || "new")}</span><span class="source ${source}">${escapeHtml(sourceLabel(finding))}</span></strong>
      <p>${escapeHtml(finding.description)}</p>
      <div class="severity">${escapeHtml(finding.severity)} · ${Math.round((finding.confidence || 0) * 100)}% confidence${finding.comments?.length ? ` · ${finding.comments.length} comment${finding.comments.length === 1 ? "" : "s"}` : ""}</div>
    </button>`;
  }).join("") : '<div class="empty">No findings in this capture.</div>';
  document.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFindingId = button.dataset.findingId;
      renderFindingsOnly();
      renderDecisionPanel();
      renderOverlay();
    });
  });
  renderDecisionPanel();
  renderOverlay();
}

function renderFindingsOnly() {
  document.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.classList.toggle("active", button.dataset.findingId === state.activeFindingId);
  });
}

function renderDecisionPanel() {
  const finding = activeFinding();
  const panel = $("decisionPanel");
  if (!finding) {
    panel.innerHTML = state.findings.length ? '<div class="empty">Select a finding to review it.</div>' : "";
    return;
  }
  const comments = Array.isArray(finding.comments) ? finding.comments : [];
  const target = finding.target?.path || finding.target?.selector || "Page-level finding";
  const source = sourceOf(finding);
  panel.innerHTML = `
    <div class="decision">
      <h2>${escapeHtml(finding.title)} · ${escapeHtml(finding.status || "new")} <span class="source ${source}">${escapeHtml(sourceLabel(finding))}</span></h2>
      <div class="target">${escapeHtml(target)}</div>
      ${source === "visual_critic" ? '<div class="target">Perceptual proposal; lower trust than deterministic browser measurements until accepted by a human.</div>' : ""}
      ${comments.length ? `<div class="comments">${comments.map((comment) => `<div class="comment">${escapeHtml(comment.text)}</div>`).join("")}</div>` : ""}
      <textarea id="decisionComment" placeholder="Optional instruction or context for ChatGPT"></textarea>
      <div class="decision-actions">
        <button data-decision="accepted" type="button" ${state.savingDecision ? "disabled" : ""}>Accept</button>
        <button data-decision="rejected" type="button" ${state.savingDecision ? "disabled" : ""}>Reject</button>
        <button data-decision="new" type="button" ${state.savingDecision ? "disabled" : ""}>Reset</button>
        <button id="addComment" type="button" ${state.savingDecision ? "disabled" : ""}>Add comment</button>
      </div>
    </div>`;
  panel.querySelectorAll("[data-decision]").forEach((button) => {
    button.addEventListener("click", () => saveDecision(button.dataset.decision));
  });
  $("addComment")?.addEventListener("click", () => saveDecision(finding.status || "new", { requireComment: true }));
}

async function saveDecision(status, { requireComment = false } = {}) {
  const finding = activeFinding();
  if (!finding || !state.evidence || state.savingDecision) return;
  const comment = $("decisionComment")?.value.trim() || "";
  if (requireComment && !comment) {
    $("decisionComment")?.focus();
    return;
  }
  state.savingDecision = true;
  renderDecisionPanel();
  try {
    const result = await callTool("set_web_finding_decision", {
      evidence_id: state.evidence.id,
      finding_id: finding.id,
      status,
      ...(comment ? { comment } : {}),
    });
    const structured = result?.structuredContent || result;
    const updated = structured?.finding;
    if (updated?.id) {
      state.findings = state.findings.map((item) => item.id === updated.id ? { ...item, ...updated, source: item.source || updated.source || "deterministic" } : item);
    }
  } catch (error) {
    console.error("Could not save Web Review decision", error);
  } finally {
    state.savingDecision = false;
    render();
  }
}

function renderOverlay() {
  const evidence = state.evidence;
  const image = $("shot");
  const overlay = $("overlay");
  if (!evidence || !image.clientWidth || !image.clientHeight) {
    overlay.innerHTML = "";
    return;
  }
  const scaleX = image.clientWidth / evidence.viewport.width;
  const scaleY = image.clientHeight / evidence.viewport.height;
  const findings = state.activeFindingId
    ? state.findings.filter((finding) => finding.id === state.activeFindingId)
    : state.findings.filter((finding) => ["error", "warning"].includes(finding.severity) && finding.status !== "rejected");
  overlay.innerHTML = findings.filter((finding) => finding.rect).map((finding) => {
    const rect = finding.rect;
    const left = Math.max(0, rect.left) * scaleX;
    const top = Math.max(0, rect.top) * scaleY;
    const right = Math.min(evidence.viewport.width, rect.right) * scaleX;
    const bottom = Math.min(evidence.viewport.height, rect.bottom) * scaleY;
    const width = Math.max(2, right - left);
    const height = Math.max(2, bottom - top);
    return `<div class="box ${escapeHtml(finding.severity)} ${escapeHtml(sourceOf(finding))}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px"></div>`;
  }).join("");
}

async function sendDecisions() {
  if (!state.evidence) return;
  const button = $("sendDecisions");
  button.disabled = true;
  button.textContent = "Sending…";
  const prompt = `Read Web Review findings for evidence ${state.evidence.id}. Act only on accepted findings and explicit human comments. Do not apply rejected findings. Preserve the browser evidence as the verification baseline and respect each finding's source: deterministic measurements outrank visual-critic proposals unless the human explicitly accepts the visual finding.`;
  try {
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
    } else {
      await rpcRequest("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
    }
  } catch (error) {
    console.warn("Web Review decisions were saved, but automatic follow-up was unavailable.", error);
  } finally {
    button.disabled = false;
    button.textContent = "Send decisions";
  }
}

$("shot").addEventListener("load", renderOverlay);
window.addEventListener("resize", renderOverlay, { passive: true });
$("sendDecisions").addEventListener("click", () => sendDecisions());
$("fullscreen").addEventListener("click", async () => {
  try {
    await bridgeReady;
    await rpcRequest("ui/request-display-mode", { mode: "fullscreen" });
  } catch (error) {
    if (window.openai?.requestDisplayMode) await window.openai.requestDisplayMode({ mode: "fullscreen" });
  }
});

hydrateFromOpenAI();