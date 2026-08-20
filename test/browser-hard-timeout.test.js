import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createBrowserJobEnvironment } from "../src/web-review/browser-job-process.js";

const PORT = 8897;
const TOKEN = "hard-timeout-worker-token-12345";

async function waitForWorker() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hard-timeout worker did not become healthy in time.");
}

test("browser child environment excludes worker/API secrets", () => {
  const env = createBrowserJobEnvironment({
    allowPrivate: true,
    baseEnv: {
      PATH: "/bin",
      HOME: "/tmp/home",
      BROWSER_WORKER_TOKEN: "must-not-pass",
      WEB_REVIEW_BROWSER_RUNNER_TOKEN: "must-not-pass",
      OPENAI_API_KEY: "must-not-pass",
      BROWSER_JOB_TEST_DELAY_MS: "123",
    },
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.BROWSER_JOB_ALLOW_PRIVATE, "true");
  assert.equal(env.BROWSER_JOB_TEST_DELAY_MS, "123");
  assert.equal(env.BROWSER_WORKER_TOKEN, undefined);
  assert.equal(env.WEB_REVIEW_BROWSER_RUNNER_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("worker hard-kills an overlong browser child and releases capacity", { timeout: 20_000 }, async (t) => {
  const worker = spawn(process.execPath, ["browser-worker.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      BROWSER_WORKER_TOKEN: TOKEN,
      BROWSER_WORKER_MAX_CONCURRENCY: "1",
      BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE: "20",
      BROWSER_WORKER_HARD_JOB_TIMEOUT_MS: "1000",
      BROWSER_JOB_TEST_DELAY_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (!worker.killed) worker.kill("SIGTERM"); });

  const initial = await waitForWorker();
  assert.equal(initial.execution_model, "child-process-per-job");
  assert.equal(initial.hard_job_timeout_ms, 1000);

  const response = await fetch(`http://127.0.0.1:${PORT}/v1/browser/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-request-id": "hard-timeout-test-1",
    },
    body: JSON.stringify({ operation: "capture", payload: { url: "https://example.com/", viewport: { width: 800, height: 600 } } }),
  });
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("x-request-id"), "hard-timeout-test-1");
  const body = await response.json();
  assert.match(body.error, /hard timeout/i);

  const after = await fetch(`http://127.0.0.1:${PORT}/health`).then((item) => item.json());
  assert.equal(after.active_jobs, 0);
  assert.equal(after.totals.started, 1);
  assert.equal(after.totals.failed, 1);
  assert.equal(after.totals.hard_timeouts, 1);

  const metrics = await fetch(`http://127.0.0.1:${PORT}/metrics`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((item) => item.text());
  assert.match(metrics, /web_review_browser_hard_timeouts_total 1/);
  assert.match(metrics, /web_review_browser_active_jobs 0/);
});
