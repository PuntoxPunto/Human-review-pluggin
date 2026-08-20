import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RemoteBrowserRunner } from "../src/web-review/remote-browser-runner.js";
import { BrowserRunner as ConfiguredBrowserRunner } from "../src/web-review/browser-runner-entry.js";

const WORKER_PORT = 8896;
const TOKEN = "test-browser-worker-token-12345";

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><main><h1>Remote runner fixture</h1><button>Continue</button></main></body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function waitForWorker() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser worker did not become healthy in time.");
}

test("isolated browser worker requires auth and returns real Chromium evidence", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.server.close());

  const worker = spawn(process.execPath, ["browser-worker.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(WORKER_PORT),
      BROWSER_WORKER_TOKEN: TOKEN,
      BROWSER_WORKER_ALLOW_PRIVATE: "true",
      BROWSER_WORKER_MAX_CONCURRENCY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (!worker.killed) worker.kill("SIGTERM"); });
  const health = await waitForWorker();
  assert.equal(health.ok, true);
  assert.equal(health.max_concurrency, 1);
  assert.match(health.target_policy, /private-allowed-test-mode/);

  const unauthorized = new RemoteBrowserRunner({
    baseUrl: `http://127.0.0.1:${WORKER_PORT}`,
    token: "wrong-but-long-enough-token",
    allowInsecure: true,
  });
  await assert.rejects(() => unauthorized.capture({ url: fixture.url }), /Unauthorized/);

  const remote = new RemoteBrowserRunner({
    baseUrl: `http://127.0.0.1:${WORKER_PORT}`,
    token: TOKEN,
    allowInsecure: true,
  });
  const capture = await remote.capture({ url: fixture.url, viewport: { width: 900, height: 700 } });
  assert.equal(capture.viewport.width, 900);
  assert.match(capture.screenshotBase64, /^[A-Za-z0-9+/=]+$/);
  assert.ok(capture.structure.some((element) => element.text?.includes("Remote runner fixture")));

  const old = {
    mode: process.env.WEB_REVIEW_BROWSER_MODE,
    url: process.env.WEB_REVIEW_BROWSER_RUNNER_URL,
    token: process.env.WEB_REVIEW_BROWSER_RUNNER_TOKEN,
    insecure: process.env.WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE,
  };
  process.env.WEB_REVIEW_BROWSER_MODE = "remote";
  process.env.WEB_REVIEW_BROWSER_RUNNER_URL = `http://127.0.0.1:${WORKER_PORT}`;
  process.env.WEB_REVIEW_BROWSER_RUNNER_TOKEN = TOKEN;
  process.env.WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE = "true";
  t.after(() => {
    for (const [key, value] of Object.entries({
      WEB_REVIEW_BROWSER_MODE: old.mode,
      WEB_REVIEW_BROWSER_RUNNER_URL: old.url,
      WEB_REVIEW_BROWSER_RUNNER_TOKEN: old.token,
      WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE: old.insecure,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const configured = new ConfiguredBrowserRunner();
  assert.ok(configured instanceof RemoteBrowserRunner);
  const configuredCapture = await configured.capture({ url: fixture.url, viewport: { width: 800, height: 600 } });
  assert.equal(configuredCapture.viewport.height, 600);
});
