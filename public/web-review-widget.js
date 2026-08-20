const $ = (id) => document.getElementById(id);

const state = {
  review: null,
  evidence: null,
  findings: [],
  activeFindingId: null,
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
      appInfo: { name: "web-review-widget", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    });
    rpcNotify("ui/notifications/initialized", {});
  } catch (error) {
    console.error("Web Review bridge initialization failed", error);
  }
})();

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
  state.activeFindingId = null;
  render();
}

function hydrateFromOpenAI() {
  const meta = window.openai?.toolResponseMetadata?.mcp_tool_result?._meta
    || window.openai?.toolResponseMetadata?.call_tool_result?._meta;
  if (meta) hydrate({ _meta: meta });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function findingCounts() {
  const counts = { total: state.findings.length, info: 0, warning: 0, error: 0, critical: 0 };
  for (const finding of state.findings) if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
  return counts;
}

function render() {
  const evidence = state.evidence;
  if (!evidence) return;
  $("title").textContent = state.review?.title || evidence.title || "Web Review";
  $("meta").textContent = `${evidence.finalUrl} · ${evidence.viewport.width}×${evidence.viewport.height} · evidence ${evidence.id}`;
  $("shot").src = `data:${evidence.screenshotMimeType || "image/png"};base64,${evidence.screenshotBase64}`;
  const counts = findingCounts();
  $("counts").innerHTML = [
    `<span class="pill">${counts.total} total</span>`,
    counts.error ? `<span class="pill">${counts.error} error</span>` : "",
    counts.warning ? `<span class="pill">${counts.warning} warning</span>` : "",
    counts.info ? `<span class="pill">${counts.info} info</span>` : "",
  ].join("");
  $("findings").innerHTML = state.findings.length ? state.findings.map((finding) => `
    <button class="finding ${finding.id === state.activeFindingId ? "active" : ""}" data-finding-id="${escapeHtml(finding.id)}" type="button">
      <strong>${escapeHtml(finding.title)}</strong>
      <p>${escapeHtml(finding.description)}</p>
      <div class="severity">${escapeHtml(finding.severity)} · ${Math.round((finding.confidence || 0) * 100)}% confidence</div>
    </button>
  `).join("") : '<div class="empty">No deterministic geometry findings in this capture.</div>';
  document.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFindingId = button.dataset.findingId;
      renderFindingsOnly();
      renderOverlay();
    });
  });
  renderOverlay();
}

function renderFindingsOnly() {
  document.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.classList.toggle("active", button.dataset.findingId === state.activeFindingId);
  });
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
    : state.findings.filter((finding) => ["error", "warning"].includes(finding.severity));
  overlay.innerHTML = findings.filter((finding) => finding.rect).map((finding) => {
    const rect = finding.rect;
    const left = Math.max(0, rect.left) * scaleX;
    const top = Math.max(0, rect.top) * scaleY;
    const right = Math.min(evidence.viewport.width, rect.right) * scaleX;
    const bottom = Math.min(evidence.viewport.height, rect.bottom) * scaleY;
    const width = Math.max(2, right - left);
    const height = Math.max(2, bottom - top);
    return `<div class="box ${escapeHtml(finding.severity)}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px"></div>`;
  }).join("");
}

$("shot").addEventListener("load", renderOverlay);
window.addEventListener("resize", renderOverlay, { passive: true });
$("fullscreen").addEventListener("click", async () => {
  try {
    await bridgeReady;
    await rpcRequest("ui/request-display-mode", { mode: "fullscreen" });
  } catch (error) {
    if (window.openai?.requestDisplayMode) await window.openai.requestDisplayMode({ mode: "fullscreen" });
  }
});

hydrateFromOpenAI();
