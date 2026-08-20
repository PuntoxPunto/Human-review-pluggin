import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertSafeHttpUrl } from "../src/web-review/url-policy.js";
import { WebReviewStore } from "../src/web-review/store.js";
import { EvidenceStore } from "../src/web-review/evidence-store.js";

test("private network addresses are rejected", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("192.168.1.20"), true);
  assert.equal(isPrivateAddress("::1"), true);
  await assert.rejects(() => assertSafeHttpUrl("http://127.0.0.1:8080/"), /Private or local/);
  await assert.rejects(() => assertSafeHttpUrl("file:///etc/passwd"), /only supports/);
  await assert.rejects(() => assertSafeHttpUrl("https://user:pass@example.com/"), /credentials/);
});

test("test-only private target override accepts local fixtures", async () => {
  assert.equal(await assertSafeHttpUrl("http://127.0.0.1:8080/#fragment", { allowPrivate: true }), "http://127.0.0.1:8080/");
});

test("web review sessions preserve run and evidence lineage", () => {
  const reviews = new WebReviewStore();
  const evidence = new EvidenceStore();
  const review = reviews.create({
    title: "Example",
    url: "https://example.com/",
    viewport: { width: 1280, height: 800 },
  });
  const run = reviews.beginRun(review.id);
  const saved = evidence.put({
    reviewId: review.id,
    runId: run.id,
    capture: {
      finalUrl: "https://example.com/",
      title: "Example Domain",
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      screenshotBase64: Buffer.from("png").toString("base64"),
      structure: [{ tag: "h1", selector: "h1", role: null, name: "Example Domain", text: "Example Domain", rect: { x: 0, y: 0, width: 100, height: 40, top: 0, right: 100, bottom: 40, left: 0 }, position: "static", zIndex: "auto", overflowX: "visible", overflowY: "visible" }],
      consoleErrors: [],
      networkErrors: [],
    },
  });
  const completed = reviews.completeRun(review.id, run.id, saved.id);
  assert.equal(completed.status, "reviewing");
  assert.deepEqual(completed.evidenceIds, [saved.id]);
  assert.equal(completed.runs[0].evidenceId, saved.id);
  assert.equal(evidence.summary(saved.id).structure_count, 1);
});

test("failed browser runs remain auditable", () => {
  const reviews = new WebReviewStore();
  const review = reviews.create({ title: "Broken", url: "https://example.com/" });
  const run = reviews.beginRun(review.id);
  const failed = reviews.failRun(review.id, run.id, new Error("navigation failed"));
  assert.equal(failed.status, "error");
  assert.equal(failed.runs[0].status, "failed");
  assert.match(failed.runs[0].error, /navigation failed/);
});
