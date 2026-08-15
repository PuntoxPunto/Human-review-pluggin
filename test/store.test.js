import test from "node:test";
import assert from "node:assert/strict";
import { ReviewStore } from "../src/store.js";
import { sanitizeReviewHtml } from "../src/sanitize.js";

test("sanitizer strips active HTML", () => {
  const html = sanitizeReviewHtml(`
    <html><body onclick="alert(1)">
      <script>alert(1)</script>
      <a href="javascript:alert(1)">go</a>
      <h1>Hello</h1>
    </body></html>
  `);
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test("submitted feedback uses the human-edited HTML as source of truth", () => {
  const store = new ReviewStore();
  const review = store.create({ title: "Landing", html: "<h1>Start free trial</h1>" });
  const submitted = store.submit(review.id, {
    draftHtml: "<h1>Probar gratis</h1>",
    edits: [{ id: "edit_1", kind: "edited", before: "Start free trial", after: "Probar gratis" }],
    comments: [{ id: "comment_1", kind: "element", quote: "Probar gratis", feedback: "Make the section warmer." }],
  });
  const batch = store.feedback(review.id, submitted.pendingBatch.id);
  assert.match(batch.userEditedHtml, /Probar gratis/);
  assert.equal(batch.edits[0].after, "Probar gratis");
});

test("apply rejects accidental reversion of a direct text edit", () => {
  const store = new ReviewStore();
  const review = store.create({ title: "Landing", html: "<h1>Start free trial</h1>" });
  const submitted = store.submit(review.id, {
    draftHtml: "<h1>Probar gratis</h1>",
    edits: [{ id: "edit_1", kind: "edited", before: "Start free trial", after: "Probar gratis" }],
    comments: [],
  });
  const result = store.apply(review.id, {
    batchId: submitted.pendingBatch.id,
    html: "<h1>Start free trial</h1>",
    overriddenEditIds: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, ["edit_1"]);
});

test("apply permits an explicit user-requested override", () => {
  const store = new ReviewStore();
  const review = store.create({ title: "Landing", html: "<h1>Start free trial</h1>" });
  const submitted = store.submit(review.id, {
    draftHtml: "<h1>Probar gratis</h1>",
    edits: [{ id: "edit_1", kind: "edited", before: "Start free trial", after: "Probar gratis" }],
    comments: [{ id: "comment_1", kind: "element", quote: "Probar gratis", feedback: "Rewrite this CTA." }],
  });
  const result = store.apply(review.id, {
    batchId: submitted.pendingBatch.id,
    html: "<h1>Empezar ahora</h1>",
    overriddenEditIds: ["edit_1"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.review.sourceVersion, 2);
});
