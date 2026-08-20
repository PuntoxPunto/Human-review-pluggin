import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BrowserRunner } from "../src/web-review/browser-runner.js";

async function startFixtureServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>Web Review Fixture</title></head>
        <body style="margin:0">
          <main>
            <h1 id="headline">Evidence works</h1>
            <button aria-label="Primary action">Continue</button>
          </main>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

test("BrowserRunner captures screenshot, visible DOM geometry, and viewport in real Chromium", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));

  const runner = new BrowserRunner({ allowPrivateTargets: true });
  const capture = await runner.capture({
    url: fixture.url,
    viewport: { width: 900, height: 700 },
  });

  assert.equal(capture.title, "Web Review Fixture");
  assert.deepEqual(capture.viewport, { width: 900, height: 700 });
  assert.deepEqual(capture.scroll, { x: 0, y: 0 });
  assert.ok(capture.screenshotBase64.length > 100);

  const heading = capture.structure.find((element) => element.tag === "h1" && element.text === "Evidence works");
  assert.ok(heading, "expected the visible h1 in the structure snapshot");
  assert.ok(heading.rect.width > 0);
  assert.ok(heading.rect.height > 0);

  const button = capture.structure.find((element) => element.tag === "button");
  assert.equal(button?.name, "Primary action");
  assert.equal(capture.consoleErrors.length, 0);
});
