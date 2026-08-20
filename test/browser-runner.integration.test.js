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
            <p id="status">idle</p>
            <label>Email <input id="email" aria-label="Email" /></label>
            <button id="primary" aria-label="Primary action">Continue</button>
            <button id="secondary" aria-label="Secondary action">Continue</button>
          </main>
          <script>
            document.getElementById('primary').addEventListener('click', () => {
              document.getElementById('status').textContent = 'clicked';
            });
          </script>
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

test("BrowserRunner captures screenshot, DOM paths, document geometry, and viewport in real Chromium", { timeout: 30_000 }, async (t) => {
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
  assert.ok(capture.document.scrollWidth >= 900);
  assert.ok(capture.document.scrollHeight >= 700);
  assert.ok(capture.screenshotBase64.length > 100);

  const heading = capture.structure.find((element) => element.tag === "h1" && element.text === "Evidence works");
  assert.ok(heading, "expected the visible h1 in the structure snapshot");
  assert.ok(heading.rect.width > 0);
  assert.ok(heading.rect.height > 0);
  assert.match(heading.path, /h1#headline$/);
  assert.match(heading.parentPath, /main$/);

  const button = capture.structure.find((element) => element.tag === "button" && element.selector === "button#primary");
  assert.equal(button?.name, "Primary action");
  assert.equal(capture.consoleErrors.length, 0);
});

test("runAction captures before and after evidence around one exact role locator", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));

  const runner = new BrowserRunner({ allowPrivateTargets: true });
  const result = await runner.runAction({
    url: fixture.url,
    viewport: { width: 900, height: 700 },
    action: {
      type: "click",
      locator: { strategy: "role", role: "button", name: "Primary action", exact: true },
    },
  });

  const beforeStatus = result.before.structure.find((element) => element.selector === "p#status");
  const afterStatus = result.after.structure.find((element) => element.selector === "p#status");
  assert.equal(beforeStatus?.text, "idle");
  assert.equal(afterStatus?.text, "clicked");
  assert.equal(result.resolvedLocator.strategy, "role");
  assert.equal(result.resolvedLocator.matched.tag, "button");
  assert.equal(result.resolvedLocator.matched.ariaLabel, "Primary action");
  assert.ok(result.before.screenshotBase64.length > 100);
  assert.ok(result.after.screenshotBase64.length > 100);
});

test("runAction refuses an ambiguous exact locator instead of guessing", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));

  const runner = new BrowserRunner({ allowPrivateTargets: true });
  await assert.rejects(
    () => runner.runAction({
      url: fixture.url,
      viewport: { width: 900, height: 700 },
      action: { type: "click", locator: { strategy: "text", text: "Continue", exact: true } },
    }),
    /match exactly one element; matched 2/,
  );
});