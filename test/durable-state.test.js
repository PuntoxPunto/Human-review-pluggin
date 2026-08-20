import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../src/store.js";
import { WebReviewStore } from "../src/web-review/store.js";
import { EvidenceStore } from "../src/web-review/evidence-store.js";
import { FindingStore } from "../src/web-review/finding-store.js";
import { ReferenceComparisonStore } from "../src/web-review/reference-store.js";
import { FixPlanStore } from "../src/web-review/fix-plan-store.js";

function withDurableState(t) {
  const previous = process.env.WEB_REVIEW_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "web-review-state-"));
  process.env.WEB_REVIEW_STATE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_REVIEW_STATE_DIR;
    else process.env.WEB_REVIEW_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function capture() {
  return {
    finalUrl: "https://example.com/",
    title: "Durable example",
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0 },
    document: { scrollWidth: 1280, scrollHeight: 1400, clientWidth: 1280, clientHeight: 800 },
    screenshotBase64: Buffer.from("durable-png").toString("base64"),
    structure: [{
      tag: "button", selector: "button.cta", path: "main > button", parentPath: "main", role: "button", name: "Continue", text: "Continue",
      rect: { x: 100, y: 100, width: 120, height: 40, top: 100, right: 220, bottom: 140, left: 100 },
      position: "static", zIndex: "auto", overflowX: "visible", overflowY: "visible",
    }],
    consoleErrors: [], networkErrors: [],
  };
}

test("Human/Web Review, evidence, findings, baselines and fix decisions survive restart", (t) => {
  withDurableState(t);

  const humanA = new ReviewStore();
  const human = humanA.create({ title: "Durable HTML", html: "<main><h1>Original</h1></main>" });
  humanA.saveDraft(human.id, {
    draftHtml: "<main><h1>Edited by human</h1></main>",
    edits: [{ id: "edit_1", kind: "edited", before: "Original", after: "Edited by human" }],
    comments: [{ id: "comment_1", kind: "element", quote: "Edited by human", feedback: "Keep this wording." }],
  });
  const submitted = humanA.submit(human.id, {
    draftHtml: "<main><h1>Edited by human</h1></main>",
    edits: [{ id: "edit_1", kind: "edited", before: "Original", after: "Edited by human" }],
    comments: [{ id: "comment_1", kind: "element", quote: "Edited by human", feedback: "Keep this wording." }],
  });

  const webA = new WebReviewStore();
  const evidenceA = new EvidenceStore();
  const findingsA = new FindingStore();
  const referencesA = new ReferenceComparisonStore();
  const fixesA = new FixPlanStore();

  const web = webA.create({ title: "Durable web", url: "https://example.com/", viewport: { width: 1280, height: 800 } });
  const run = webA.beginRun(web.id);
  const evidence = evidenceA.put({ reviewId: web.id, runId: run.id, capture: capture() });
  webA.completeRun(web.id, run.id, evidence.id);

  const target = capture().structure[0];
  const storedFindings = findingsA.replaceForEvidence({
    reviewId: web.id,
    evidenceId: evidence.id,
    findings: [{ type: "element_horizontal_clipping", severity: "error", confidence: 0.99, title: "CTA clipped", description: "Measured clipping.", target, related: null, rect: target.rect, metrics: { overflow_px: 12 } }],
  });
  const accepted = findingsA.decide(evidence.id, storedFindings[0].id, { status: "accepted", comment: "Fix before release." });

  const comparison = referencesA.put({
    referenceEvidenceId: evidence.id,
    candidateEvidenceId: evidence.id,
    result: {
      reference: { evidenceId: evidence.id, reviewId: web.id, url: "https://example.com/", viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, document: capture().document },
      candidate: { evidenceId: evidence.id, reviewId: web.id, url: "https://example.com/", viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, document: capture().document },
      metrics: { matched: 1, unchanged: 1, changed: 0, added: 0, removed: 0, scroll_dx: 0, scroll_dy: 0, document_width_delta: 0, document_height_delta: 0 },
      changed: [], added: [], removed: [],
    },
  });

  const plan = fixesA.create({ reviewId: web.id, evidenceId: evidence.id, items: [{
    findingId: accepted.id, fingerprint: accepted.fingerprint, source: accepted.source, type: accepted.type,
    title: accepted.title, description: accepted.description, target: accepted.target, related: null, comments: accepted.comments,
    comparisonId: comparison.id, referenceEvidenceId: evidence.id, verificationPolicy: "human_recheck",
  }] });
  const attempt = fixesA.addAttempt(plan.id, {
    status: "needs_review", baseEvidenceId: evidence.id, postFixEvidenceId: evidence.id, postFixReviewId: web.id,
    changeSummary: "Adjusted CTA spacing.", changeReference: "commit:abc123",
    results: [{ finding_id: accepted.id, fingerprint: accepted.fingerprint, source: accepted.source, status: "needs_review", reason: "Needs visual confirmation." }],
    comparison: { metrics: { changed: 1 } },
  });
  fixesA.reviewAttemptItem(plan.id, attempt.attempt.id, accepted.id, { status: "resolved", comment: "Verified visually." });

  const humanB = new ReviewStore();
  const webB = new WebReviewStore();
  const evidenceB = new EvidenceStore();
  const findingsB = new FindingStore();
  const referencesB = new ReferenceComparisonStore();
  const fixesB = new FixPlanStore();

  const restoredHuman = humanB.get(human.id);
  assert.equal(restoredHuman.status, "feedback_pending");
  assert.match(restoredHuman.draftHtml, /Edited by human/);
  assert.equal(humanB.feedback(human.id, submitted.pendingBatch.id).comments[0].feedback, "Keep this wording.");

  const restoredWeb = webB.get(web.id);
  assert.equal(restoredWeb.status, "reviewing");
  assert.deepEqual(restoredWeb.evidenceIds, [evidence.id]);
  assert.equal(restoredWeb.runs[0].status, "completed");

  const restoredEvidence = evidenceB.get(evidence.id, { includeScreenshot: true });
  assert.equal(restoredEvidence.screenshotBase64, capture().screenshotBase64);
  assert.equal(restoredEvidence.structure[0].path, "main > button");

  const restoredFinding = findingsB.get(evidence.id, accepted.id);
  assert.equal(restoredFinding.status, "accepted");
  assert.equal(restoredFinding.comments[0].text, "Fix before release.");
  assert.equal(referencesB.get(comparison.id).referenceEvidenceId, evidence.id);

  const restoredPlan = fixesB.get(plan.id);
  assert.equal(restoredPlan.status, "verified");
  assert.equal(restoredPlan.attempts[0].reviewDecisions[0].status, "resolved");
  assert.equal(restoredPlan.attempts[0].reviewDecisions[0].comment, "Verified visually.");
});
