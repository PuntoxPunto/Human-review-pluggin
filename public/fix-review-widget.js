const $ = (id) => document.getElementById(id);

const state = {
  plan: null,
  attempt: null,
  baseEvidence: null,
  postEvidence: null,
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
      appInfo: { name: "fix-review-widget", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    });
    rpcNotify("ui/notifications/initialized", {});
  } catch (error) {
    console.error("Fix Review bridge initialization failed", error);
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
  const fixReview = meta?.fix_review;
  if (!fixReview?.plan || !fixReview?.attempt) return;
  state.plan = fixReview.plan;
  state.attempt = fixReview.attempt;
  state.baseEvidence = fixReview.baseEvidence || null;
  state.postEvidence = fixReview.postEvidence || null;
  state.activeFindingId = state.activeFindingId && state.plan.items.some((item) => item.findingId === state.activeFindingId)
    ? state.activeFindingId
    : state.plan.items[0]?.findingId || null;
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

function resultFor(findingId) {
  return state.attempt?.results?.find((result) => result.finding_id === findingId) || null;
}

function latestDecision(findingId) {
  const decisions = Array.isArray(state.attempt?.reviewDecisions) ? state.attempt.reviewDecisions : [];
  return [...decisions].reverse().find((decision) => decision.findingId === findingId) || null;
}

function effectiveStatus(findingId) {
  const result = resultFor(findingId);
  if (!result) return "needs_review";
  if (result.status !== "needs_review") return result.status;
  const decision = latestDecision(findingId);
  if (!decision || decision.status === "needs_review") return "needs_review";
  return decision.status;
}

function activeItem() {
  return state.plan?.items?.find((item) => item.findingId === state.activeFindingId) || null;
}

function counts() {
  const output = { resolved: 0, unresolved: 0, needs_review: 0 };
  for (const item of state.plan?.items || []) output[effectiveStatus(item.findingId)] += 1;
  return output;
}

function render() {
  if (!state.plan || !state.attempt) return;
  $("title").textContent = `Fix Review · ${state.attempt.status}`;
  $("meta").textContent = `${state.plan.id} · attempt ${state.attempt.id} · automatic ${state.attempt.automaticStatus || state.attempt.status}`;
  if (state.baseEvidence) $("beforeShot").src = `data:${state.baseEvidence.screenshotMimeType || "image/png"};base64,${state.baseEvidence.screenshotBase64}`;
  if (state.postEvidence) $("afterShot").src = `data:${state.postEvidence.screenshotMimeType || "image/png"};base64,${state.postEvidence.screenshotBase64}`;
  $("sendDecisions").disabled = false;

  const c = counts();
  $("counts").innerHTML = [
    `<span class="pill">${c.resolved} resolved</span>`,
    c.unresolved ? `<span class="pill">${c.unresolved} unresolved</span>` : "",
    c.needs_review ? `<span class="pill">${c.needs_review} needs review</span>` : "",
  ].join("");

  const metrics = state.attempt.comparison?.metrics || {};
  $("summary").innerHTML = [
    `<strong>Attempt status:</strong> ${escapeHtml(state.attempt.status)}`,
    ` · automatic: ${escapeHtml(state.attempt.automaticStatus || state.attempt.status)}`,
    metrics.changed !== undefined ? ` · DOM changed: ${escapeHtml(metrics.changed)}` : "",
    metrics.added !== undefined ? ` · added: ${escapeHtml(metrics.added)}` : "",
    metrics.removed !== undefined ? ` · removed: ${escapeHtml(metrics.removed)}` : "",
    state.attempt.changeReference ? `<br><strong>Change reference:</strong> ${escapeHtml(state.attempt.changeReference)}` : "",
    state.attempt.changeSummary ? `<br><strong>Change summary:</strong> ${escapeHtml(state.attempt.changeSummary)}` : "",
  ].join("");

  $("items").innerHTML = state.plan.items.map((item) => {
    const result = resultFor(item.findingId);
    const effective = effectiveStatus(item.findingId);
    const source = item.source || "deterministic";
    return `
      <button type="button" class="item ${escapeHtml(effective)} ${item.findingId === state.activeFindingId ? "active" : ""}" data-finding-id="${escapeHtml(item.findingId)}">
        <strong>${escapeHtml(item.title)} <span class="badge">${escapeHtml(effective)}</span></strong>
        <p>${escapeHtml(item.description)}</p>
        <div class="small">${escapeHtml(source)} · automatic ${escapeHtml(result?.status || "unknown")}${item.verificationPolicy ? ` · ${escapeHtml(item.verificationPolicy)}` : ""}</div>
      </button>`;
  }).join("");

  document.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFindingId = button.dataset.findingId;
      render();
    });
  });
  renderDecisionPanel();
}

function renderDecisionPanel() {
  const item = activeItem();
  const panel = $("decisionPanel");
  if (!item) {
    panel.innerHTML = '<div class="empty">Select a fix item.</div>';
    return;
  }
  const result = resultFor(item.findingId);
  const decision = latestDecision(item.findingId);
  const effective = effectiveStatus(item.findingId);
  const locked = result?.status !== "needs_review";
  const comments = (item.comments || []).map((comment) => comment.text).filter(Boolean);
  panel.innerHTML = `
    <div class="panel">
      <h2>${escapeHtml(item.title)} · ${escapeHtml(effective)}</h2>
      <p>${escapeHtml(result?.reason || "No automatic assessment available.")}</p>
      ${comments.length ? `<p><strong>Original human context:</strong> ${comments.map(escapeHtml).join(" · ")}</p>` : ""}
      ${decision?.comment ? `<p><strong>Latest review comment:</strong> ${escapeHtml(decision.comment)}</p>` : ""}
      ${locked
        ? `<p><strong>Locked:</strong> automatic status ${escapeHtml(result?.status || "unknown")} cannot be overridden by human review in this cockpit.</p>`
        : `<textarea id="reviewComment" placeholder="Optional reason or instruction"></textarea>
           <div class="actions">
             <button data-review-status="resolved" type="button" ${state.savingDecision ? "disabled" : ""}>Resolved</button>
             <button data-review-status="unresolved" type="button" ${state.savingDecision ? "disabled" : ""}>Still unresolved</button>
             <button data-review-status="needs_review" type="button" ${state.savingDecision ? "disabled" : ""}>Reset</button>
           </div>`}
    </div>`;
  if (!locked) {
    panel.querySelectorAll("[data-review-status]").forEach((button) => {
      button.addEventListener("click", () => saveDecision(button.dataset.reviewStatus));
    });
  }
}

async function saveDecision(status) {
  const item = activeItem();
  if (!item || !state.plan || !state.attempt || state.savingDecision) return;
  const comment = $("reviewComment")?.value.trim() || "";
  state.savingDecision = true;
  renderDecisionPanel();
  try {
    const response = await callTool("set_web_fix_item_decision", {
      fix_plan_id: state.plan.id,
      attempt_id: state.attempt.id,
      finding_id: item.findingId,
      status,
      ...(comment ? { comment } : {}),
    });
    const structured = response?.structuredContent || response;
    if (structured?.attempt) state.attempt = structured.attempt;
  } catch (error) {
    console.error("Could not save fix review decision", error);
  } finally {
    state.savingDecision = false;
    render();
  }
}

async function sendDecisions() {
  if (!state.plan || !state.attempt) return;
  const button = $("sendDecisions");
  button.disabled = true;
  button.textContent = "Sending…";
  const prompt = `Read fix plan ${state.plan.id} with get_web_fix_plan and inspect attempt ${state.attempt.id}. Treat verified as the only completed state. If unresolved, report the blocking items and do not claim the fix succeeded. If needs_review, report the remaining human-review items. Preserve the automatic deterministic assessment and the human fix-review decisions separately.`;
  try {
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
    } else {
      await rpcRequest("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
    }
  } catch (error) {
    console.warn("Fix Review decisions were saved, but automatic follow-up was unavailable.", error);
  } finally {
    button.disabled = false;
    button.textContent = "Send decisions";
  }
}

$("sendDecisions").addEventListener("click", sendDecisions);
$("fullscreen").addEventListener("click", async () => {
  try {
    await bridgeReady;
    await rpcRequest("ui/request-display-mode", { mode: "fullscreen" });
  } catch (error) {
    if (window.openai?.requestDisplayMode) await window.openai.requestDisplayMode({ mode: "fullscreen" });
  }
});

hydrateFromOpenAI();