import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BrowserRunner } from "../src/web-review/browser-runner.js";

async function startFixtureServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><head><title>Recovery Fixture</title></head><body>
        <p id="status">idle</p>
        <button aria-label="Primary action">Continue</button>
        <button aria-label="Secondary action">Continue</button>
      </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

test("verified recovery candidate resolves exactly one element without click or fill", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const runner = new BrowserRunner({ allowPrivateTargets: true });

  const result = await runner.runAction({
    url: fixture.url,
    viewport: { width: 800, height: 600 },
    action: {
      type: "scroll_into_view",
      locator: { strategy: "role", role: "button", name: "Primary action", exact: true },
    },
  });

  assert.equal(result.resolvedLocator.strategy, "role");
  assert.equal(result.resolvedLocator.matched.ariaLabel, "Primary action");
  assert.equal(result.before.structure.find((element) => element.selector === "p#status")?.text, "idle");
  assert.equal(result.after.structure.find((element) => element.selector === "p#status")?.text, "idle");
  assert.ok(result.after.screenshotBase64.length > 100);
});

test("ambiguous recovery candidate remains rejected by exact-one-match gate", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const runner = new BrowserRunner({ allowPrivateTargets: true });

  await assert.rejects(
    () => runner.runAction({
      url: fixture.url,
      viewport: { width: 800, height: 600 },
      action: { type: "scroll_into_view", locator: { strategy: "text", text: "Continue", exact: true } },
    }),
    /match exactly one element; matched 2/,
  );
});