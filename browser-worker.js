import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BrowserRunner } from "./src/web-review/browser-runner.js";

const TOKEN = String(process.env.BROWSER_WORKER_TOKEN || "");
if (TOKEN.length < 16) throw new Error("BROWSER_WORKER_TOKEN of at least 16 characters is required.");

const PORT = Number(process.env.PORT || process.env.BROWSER_WORKER_PORT || 8890);
const MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BROWSER_WORKER_MAX_CONCURRENCY || 2)));
const MAX_BODY_BYTES = Math.max(16_384, Math.min(1_048_576, Number(process.env.BROWSER_WORKER_MAX_BODY_BYTES || 524_288)));
const MAX_OPERATION_TIMEOUT_MS = Math.max(5_000, Math.min(120_000, Number(process.env.BROWSER_WORKER_MAX_OPERATION_TIMEOUT_MS || 45_000)));
const ALLOW_PRIVATE = process.env.BROWSER_WORKER_ALLOW_PRIVATE === "true";
const OPERATIONS = new Set(["capture", "runAction", "runScrollCheckpoints", "runScenario"]);
const runner = new BrowserRunner({ allowPrivateTargets: ALLOW_PRIVATE });
let activeJobs = 0;

function authorized(header) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "web-review-browser-worker",
      active_jobs: activeJobs,
      max_concurrency: MAX_CONCURRENCY,
      target_policy: ALLOW_PRIVATE ? "private-allowed-test-mode" : "public-http-only",
      operations: [...OPERATIONS],
    });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/browser/run") return json(res, 404, { ok: false, error: "Not found." });
  if (!authorized(req.headers.authorization)) return json(res, 401, { ok: false, error: "Unauthorized." });
  if (activeJobs >= MAX_CONCURRENCY) return json(res, 429, { ok: false, error: "Browser worker concurrency limit reached." });

  activeJobs += 1;
  try {
    const body = await readJson(req);
    const operation = String(body.operation || "");
    if (!OPERATIONS.has(operation)) return json(res, 400, { ok: false, error: "Unsupported browser operation." });
    const payload = boundedPayload(body.payload);
    const result = await runner[operation](payload);
    return json(res, 200, { ok: true, result });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return json(res, safeStatus, { ok: false, error: String(error?.message || error || "Browser worker error").slice(0, 2000) });
  } finally {
    activeJobs -= 1;
  }
});

server.listen(PORT, () => {
  console.log(`Web Review browser worker listening on http://localhost:${PORT}`);
});
