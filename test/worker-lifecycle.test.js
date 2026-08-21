import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const TOKEN = "test-browser-worker-token-12345";
const PORT = 8898;

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><main><h1>Drain fixture</h1></main></body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function waitForJson(path, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
      const body = await response.json();
      if (predicate(response, body)) return { response, body };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

function browserRequest(url, requestId) {
  return fetch(`http://127.0.0.1:${PORT}/v1/browser/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${TOKEN}`,
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      operation: "capture",
      payload: { url, viewport: { width: 800, height: 600 }, timeoutMs: 10_000 },
    }),
  });
}

test("worker becomes unready, rejects new jobs and force-drains active browser process groups", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.close());

  const worker = spawn(process.execPath, ["browser-worker.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      BROWSER_WORKER_TOKEN: TOKEN,
      BROWSER_WORKER_ALLOW_PRIVATE: "true",
      BROWSER_WORKER_MAX_CONCURRENCY: "1",
      BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE: "20",
      BROWSER_WORKER_HARD_JOB_TIMEOUT_MS: "15000",
      BROWSER_WORKER_DRAIN_GRACE_MS: "1000",
      BROWSER_JOB_TEST_DELAY_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });

  let stdout = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });

  const initialReady = await waitForJson("/ready", (response, body) => response.status === 200 && body.ready === true);
  assert.equal(initialReady.body.state, "ready");

  const activeRequest = browserRequest(fixture.url, "m17-active-job");
  await waitForJson("/health", (_response, body) => body.active_jobs === 1);

  worker.kill("SIGTERM");
  const draining = await waitForJson("/ready", (response, body) => response.status === 503 && body.state === "draining");
  assert.equal(draining.body.ready, false);
  assert.equal(draining.body.active_jobs, 1);
  assert.equal(draining.body.drain_reason, "SIGTERM");

  const rejected = await browserRequest(fixture.url, "m17-rejected-during-drain");
  assert.equal(rejected.status, 503);
  const rejectedBody = await rejected.json();
  assert.match(rejectedBody.error, /draining/i);

  const metricsResponse = await fetch(`http://127.0.0.1:${PORT}/metrics`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /web_review_browser_ready 0/);
  assert.match(metrics, /web_review_browser_rejected_total\{reason="draining"\} 1/);

  const activeResponse = await activeRequest;
  assert.equal(activeResponse.status, 503);
  const activeBody = await activeResponse.json();
  assert.match(activeBody.error, /terminated while the worker was draining/i);

  const exitResult = await Promise.race([
    once(worker, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Worker did not exit after forced drain.")), 8_000)),
  ]);
  assert.ok(Array.isArray(exitResult));

  const logLines = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const drainStarted = logLines.find((entry) => entry.event === "worker_draining");
  const drainForced = logLines.find((entry) => entry.event === "worker_drain_forced");
  assert.equal(drainStarted?.reason, "SIGTERM");
  assert.equal(drainForced?.terminated_jobs, 1);
});
