import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertSafeHttpUrl } from "../src/web-review/url-policy.js";
import { WebReviewStore } from "../src/web-review/store.js";
import { EvidenceStore } from "../src/web-review/evidence-store.js";
import { FindingStore } from "../src/web-review/finding-store.js";

test("private and reserved network addresses are rejected", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("100.64.1.2"), true);
  assert.equal(isPrivateAddress("192.168.1.20"), true);
  assert.equal(isPrivateAddress("198.18.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("ff02::1"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
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

test("human finding decisions and comments survive deterministic reanalysis", () => {
  const store = new FindingStore();
  const base = {
    type: "element_horizontal_clipping",
    severity: "error",
    confidence: 0.99,
    title: "Element extends outside viewport",
    description: "CTA is clipped by 32px.",
    target: { selector: "button.cta", path: "body > main > button", tag: "button", name: "Continue", rect: { x: 980, y: 100, width: 52, height: 40, top: 100, right: 1032, bottom: 140, left: 980 } },
    related: null,
    rect: { x: 980, y: 100, width: 52, height: 40, top: 100, right: 1032, bottom: 140, left: 980 },
    metrics: { overflow_px: 32 },
  };

  const first = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [base] });
  const decided = store.decide("ev_1", first[0].id, { status: "accepted", comment: "Fix this CTA before release." });
  assert.equal(decided.status, "accepted");
  assert.equal(decided.comments.length, 1);

  const rerun = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [{ ...base, description: "CTA remains clipped." }] });
  assert.equal(rerun[0].id, first[0].id);
  assert.equal(rerun[0].status, "accepted");
  assert.equal(rerun[0].comments[0].text, "Fix this CTA before release.");
  assert.equal(store.summary("ev_1").accepted, 1);
  assert.equal(rerun[0].source, "deterministic");
});

test("deterministic and visual critic finding partitions do not overwrite each other", () => {
  const store = new FindingStore();
  const target = { selector: "section.hero", path: "body > main > section.hero", tag: "section", name: "Hero", rect: { x: 0, y: 0, width: 1000, height: 700, top: 0, right: 1000, bottom: 700, left: 0 } };
  const deterministic = {
    type: "element_horizontal_clipping",
    severity: "error",
    confidence: 0.99,
    title: "Element clipped",
    description: "Measured clipping.",
    target,
    related: null,
    rect: target.rect,
    metrics: { overflow_px: 20 },
  };
  const visual = {
    source: "visual_critic",
    type: "visual_hierarchy",
    severity: "warning",
    confidence: 0.72,
    title: "Hero hierarchy feels weak",
    description: "Primary message does not dominate visually.",
    target,
    related: null,
    rect: target.rect,
    metrics: {},
  };

  const deterministicStored = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [deterministic] });
  const visualStored = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [visual], source: "visual_critic" });
  store.decide("ev_1", visualStored[0].id, { status: "accepted", comment: "Increase visual emphasis." });

  const geometryRerun = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [{ ...deterministic, description: "Measured again." }] });
  assert.equal(geometryRerun[0].id, deterministicStored[0].id);
  assert.equal(store.list("ev_1", { source: "visual_critic" }).length, 1);
  assert.equal(store.list("ev_1", { source: "visual_critic" })[0].status, "accepted");

  const visualRerun = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_1", findings: [{ ...visual, description: "Hierarchy still appears weak." }], source: "visual_critic" });
  assert.equal(visualRerun[0].id, visualStored[0].id);
  assert.equal(visualRerun[0].status, "accepted");
  assert.equal(visualRerun[0].comments[0].text, "Increase visual emphasis.");
  assert.equal(store.list("ev_1", { source: "deterministic" }).length, 1);
  assert.deepEqual(store.summary("ev_1"), {
    total: 2,
    info: 0,
    warning: 1,
    error: 1,
    critical: 0,
    new: 1,
    accepted: 1,
    rejected: 0,
    deterministic: 1,
    visual_critic: 1,
    reference_critic: 0,
  });
});