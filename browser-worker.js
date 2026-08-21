import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { runBrowserJobProcess, terminateActiveBrowserJobs } from "./src/web-review/browser-job-process.js";

const TOKEN = String(process.env.BROWSER_WORKER_TOKEN || "");
if (TOKEN.length < 16) throw new Error("BROWSER_WORKER_TOKEN of at least 16 characters is required.");

const PORT = Number(process.env.PORT || process.env.BROWSER_WORKER_PORT || 8890);
const MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BROWSER_WORKER_MAX_CONCURRENCY || 2)));
const MAX_BODY_BYTES = Math.max(16_384, Math.min(1_048_576, Number(process.env.BROWSER_WORKER_MAX_BODY_BYTES || 524_288)));
const MAX_OPERATION_TIMEOUT_MS = Math.max(5_000, Math.min(120_000, Number(process.env.BROWSER_WORKER_MAX_OPERATION_TIMEOUT_MS || 45_000)));
const HARD_JOB_TIMEOUT_MS = Math.max(1_000, Math.min(180_000, Number(process.env.BROWSER_WORKER_HARD_JOB_TIMEOUT_MS || 60_000)));
const DRAIN_GRACE_MS = Math.max(1_000, Math.min(300_000, Number(process.env.BROWSER_WORKER_DRAIN_GRACE_MS || Math.min(180_000, HARD_JOB_TIMEOUT_MS + 15_000))));
const MAX_JOB_OUTPUT_BYTES = Math.max(1_048_576, Math.min(64 * 1024 * 1024, Number(process.env.BROWSER_WORKER_MAX_JOB_OUTPUT_BYTES || 24 * 1024 * 1024)));
const MAX_REQUESTS_PER_MINUTE = Math.max(1, Math.min(10_000, Number(process.env.BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE || 60)));
const ALLOW_PRIVATE = process.env.BROWSER_WORKER_ALLOW_PRIVATE === "true";
const OPERATIONS = new Set(["capture", "runAction", "runScrollCheckpoints", "runScenario"]);
let activeJobs = 0;
let rateWindowStartedAt = Date.now();
let rateWindowCount = 0;
let lifecycleState = "ready";
let drainStartedAt = null;
let drainReason = null;
let drainTimer = null;
let serverClosing = false;
const metrics = {
  jobsStarted: 0,
  jobsSucceeded: 0,
  jobsFailed: 0,
  hardTimeouts: 0,
  drainsStarted: 0,
  forcedDrains: 0,
  rejectedAuth: 0,
  rejectedRate: 0,
  rejectedConcurrency: 0,
  rejectedDraining: 0,
  totalDurationMs: 0,
  byOperation: Object.fromEntries([...OPERATIONS].map((name) => [name, 0])),
};

function authorized(header) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requestId(req) {
  const supplied = String(req.headers["x-request-id"] || "");
  return /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : `browserreq_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function json(res, status, body, id = null, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...(id ? { "x-request-id": id } : {}),
    ...headers,
  });
  res.end(payload);
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "web-review-browser-worker", event, ...fields }));
}

function rateAllowed() {
  const now = Date.now();
  if (now - rateWindowStartedAt >= 60_000) {
    rateWindowStartedAt = now;
    rateWindowCount = 0;
  }
  if (rateWindowCount >= MAX_REQUESTS_PER_MINUTE) return false;
  rateWindowCount += 1;
  return true;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
  }
}

function boundedPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("payload must be an object."), { statusCode: 400 });
  const next = structuredClone(payload);
  const requested = Number(next.timeoutMs || 30_000);
  next.timeoutMs = Math.max(1_000, Math.min(MAX_OPERATION_TIMEOUT_MS, Number.isFinite(requested) ? requested : 30_000));
  return next;
}

function prometheusMetrics() {
  const lines = [
    "# TYPE web_review_browser_jobs_started_total counter",
    `web_review_browser_jobs_started_total ${metrics.jobsStarted}`,
    "# TYPE web_review_browser_jobs_succeeded_total counter",
    `web_review_browser_jobs_succeeded_total ${metrics.jobsSucceeded}`,
    "# TYPE web_review_browser_jobs_failed_total counter",
    `web_review_browser_jobs_failed_total ${metrics.jobsFailed}`,
    "# TYPE web_review_browser_hard_timeouts_total counter",
    `web_review_browser_hard_timeouts_total ${metrics.hardTimeouts}`,
    "# TYPE web_review_browser_drains_started_total counter",
    `web_review_browser_drains_started_total ${metrics.drainsStarted}`,
    "# TYPE web_review_browser_forced_drains_total counter",
    `web_review_browser_forced_drains_total ${metrics.forcedDrains}`,
    "# TYPE web_review_browser_rejected_total counter",
    `web_review_browser_rejected_total{reason=\"auth\"} ${metrics.rejectedAuth}`,
    `web_review_browser_rejected_total{reason=\"rate\"} ${metrics.rejectedRate}`,
    `web_review_browser_rejected_total{reason=\"concurrency\"} ${metrics.rejectedConcurrency}`,
    `web_review_browser_rejected_total{reason=\"draining\"} ${metrics.rejectedDraining}`,
    "# TYPE web_review_browser_ready gauge",
    `web_review_browser_ready ${lifecycleState === "ready" ? 1 : 0}`,
    "# TYPE web_review_browser_active_jobs gauge",
    `web_review_browser_active_jobs ${activeJobs}`,
    "# TYPE web_review_browser_job_duration_ms_total counter",
    `web_review_browser_job_duration_ms_total ${metrics.totalDurationMs}`,
  ];
  for (const [operation, count] of Object.entries(metrics.byOperation)) {
    lines.push(`web_review_browser_operation_total{operation=\"${operation}\"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

function lifecycleSnapshot() {
  return {
    state: lifecycleState,
    ready: lifecycleState === "ready",
    active_jobs: activeJobs,
    drain_started_at: drainStartedAt,
    drain_reason: drainReason,
    drain_grace_ms: DRAIN_GRACE_MS,
  };
}

function closeServer({ forced = false } = {}) {
  if (serverClosing) return;
  serverClosing = true;
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  server.close(() => {
    log("worker_stopped", { forced, active_jobs: activeJobs, drain_reason: drainReason });
  });
  server.closeIdleConnections?.();
}

function finishDrainIfIdle() {
  if (lifecycleState === "draining" && activeJobs === 0) closeServer({ forced: false });
}

function beginDrain(reason) {
  if (lifecycleState === "draining") return;
  lifecycleState = "draining";
  drainStartedAt = new Date().toISOString();
  drainReason = String(reason || "shutdown").slice(0, 80);
  metrics.drainsStarted += 1;
  log("worker_draining", { reason: drainReason, active_jobs: activeJobs, grace_ms: DRAIN_GRACE_MS });
  if (activeJobs === 0) {
    closeServer({ forced: false });
    return;
  }
  drainTimer = setTimeout(() => {
    metrics.forcedDrains += 1;
    const terminatedJobs = terminateActiveBrowserJobs();
    log("worker_drain_forced", { reason: drainReason, active_jobs: activeJobs, terminated_jobs: terminatedJobs });
    closeServer({ forced: true });
  }, DRAIN_GRACE_MS);
  drainTimer.unref?.();
}

const server = createServer(async (req, res) => {
  const id = requestId(req);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "web-review-browser-worker",
      ...lifecycleSnapshot(),
      max_concurrency: MAX_CONCURRENCY,
      max_requests_per_minute: MAX_REQUESTS_PER_MINUTE,
      hard_job_timeout_ms: HARD_JOB_TIMEOUT_MS,
      target_policy: ALLOW_PRIVATE ? "private-allowed-test-mode" : "public-http-only",
      execution_model: "child-process-per-job",
      operations: [...OPERATIONS],
      totals: { started: metrics.jobsStarted, succeeded: metrics.jobsSucceeded, failed: metrics.jobsFailed, hard_timeouts: metrics.hardTimeouts, drains: metrics.drainsStarted, forced_drains: metrics.forcedDrains },
    }, id);
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    const ready = lifecycleState === "ready";
    return json(res, ready ? 200 : 503, { ok: ready, service: "web-review-browser-worker", ...lifecycleSnapshot() }, id, ready ? {} : { "retry-after": "1" });
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    if (!authorized(req.headers.authorization)) {
      metrics.rejectedAuth += 1;
      return json(res, 401, { ok: false, error: "Unauthorized." }, id);
    }
    const payload = prometheusMetrics();
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-request-id": id });
    return res.end(payload);
  }
  if (req.method !== "POST" || url.pathname !== "/v1/browser/run") return json(res, 404, { ok: false, error: "Not found." }, id);
  if (!authorized(req.headers.authorization)) {
    metrics.rejectedAuth += 1;
    log("request_rejected", { request_id: id, reason: "auth" });
    return json(res, 401, { ok: false, error: "Unauthorized." }, id);
  }
  if (lifecycleState !== "ready") {
    metrics.rejectedDraining += 1;
    log("request_rejected", { request_id: id, reason: "draining", active_jobs: activeJobs });
    return json(res, 503, { ok: false, error: "Browser worker is draining and is not accepting new jobs." }, id, { "retry-after": "1", "connection": "close" });
  }
  if (!rateAllowed()) {
    metrics.rejectedRate += 1;
    log("request_rejected", { request_id: id, reason: "rate" });
    return json(res, 429, { ok: false, error: "Browser worker rate limit reached." }, id);
  }
  if (activeJobs >= MAX_CONCURRENCY) {
    metrics.rejectedConcurrency += 1;
    log("request_rejected", { request_id: id, reason: "concurrency", active_jobs: activeJobs });
    return json(res, 429, { ok: false, error: "Browser worker concurrency limit reached." }, id);
  }

  activeJobs += 1;
  const startedAt = Date.now();
  let operation = "unknown";
  let outcome = "rejected";
  try {
    const body = await readJson(req);
    operation = String(body.operation || "");
    if (!OPERATIONS.has(operation)) return json(res, 400, { ok: false, error: "Unsupported browser operation." }, id);
    metrics.jobsStarted += 1;
    metrics.byOperation[operation] += 1;
    log("job_started", { request_id: id, operation, active_jobs: activeJobs });
    const payload = boundedPayload(body.payload);
    const result = await runBrowserJobProcess({
      operation,
      payload,
      allowPrivate: ALLOW_PRIVATE,
      hardTimeoutMs: HARD_JOB_TIMEOUT_MS,
      maxOutputBytes: MAX_JOB_OUTPUT_BYTES,
    });
    metrics.jobsSucceeded += 1;
    outcome = "succeeded";
    return json(res, 200, { ok: true, result }, id);
  } catch (error) {
    metrics.jobsFailed += 1;
    if (error?.code === "BROWSER_JOB_HARD_TIMEOUT") metrics.hardTimeouts += 1;
    outcome = error?.code === "BROWSER_JOB_HARD_TIMEOUT" ? "hard_timeout" : error?.code === "BROWSER_JOB_DRAIN_TERMINATED" ? "drain_terminated" : "failed";
    const status = Number(error?.statusCode || 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return json(res, safeStatus, { ok: false, error: String(error?.message || error || "Browser worker error").slice(0, 2000) }, id);
  } finally {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    activeJobs -= 1;
    log("job_finished", { request_id: id, operation, outcome, duration_ms: durationMs, active_jobs: activeJobs });
    finishDrainIfIdle();
  }
});

process.once("SIGTERM", () => beginDrain("SIGTERM"));
process.once("SIGINT", () => beginDrain("SIGINT"));

server.listen(PORT, () => {
  log("worker_started", {
    port: PORT,
    max_concurrency: MAX_CONCURRENCY,
    max_requests_per_minute: MAX_REQUESTS_PER_MINUTE,
    hard_job_timeout_ms: HARD_JOB_TIMEOUT_MS,
    drain_grace_ms: DRAIN_GRACE_MS,
    execution_model: "child-process-per-job",
    target_policy: ALLOW_PRIVATE ? "private-allowed-test-mode" : "public-http-only",
  });
});
