import test from "node:test";
import assert from "node:assert/strict";
import { FixPlanStore } from "../src/web-review/fix-plan-store.js";
import {
  evaluateFixPlanItem,
  overallFixStatus,
  selectAcceptedFindings,
  snapshotFixFinding,
} from "../src/web-review/fix-tools.js";

const rect = { x: 10, y: 20, width: 100, height: 40, top: 20, right: 110, bottom: 60, left: 10 };
const target = { selector: "button.cta", path: "body > main > button.cta", tag: "button", name: "Continue", rect };

function finding(overrides = {}) {
  return {
    id: overrides.id || "finding_1",
    fingerprint: overrides.fingerprint || "fp_1",
    source: overrides.source || "deterministic",
    type: overrides.type || "element_horizontal_clipping",
    severity: overrides.severity || "error",
    confidence: 0.99,
    title: overrides.title || "CTA clipped",
    description: overrides.description || "CTA extends beyond the viewport.",
    target: overrides.target === undefined ? target : overrides.target,
    related: null,
    rect,
    metrics: {},
    status: overrides.status || "accepted",
    comments: overrides.comments || [{ id: "c1", text: "Fix before release.", createdAt: "2026-08-20T00:00:00Z" }],
    ...overrides,
  };
}

function postEvidence(structure = [{ path: target.path, selector: target.selector }]) {
  return { id: "ev_after", structure };
}

test("fix plan selection includes only accepted findings by default", () => {
  const accepted = finding({ id: "accepted" });
  const rejected = finding({ id: "rejected", status: "rejected" });
  const pending = finding({ id: "pending", status: "new" });
  assert.deepEqual(selectAcceptedFindings([accepted, rejected, pending]).map((item) => item.id), ["accepted"]);
});

test("explicit fix plan selection rejects non-accepted findings", () => {
  const accepted = finding({ id: "accepted" });
  const rejected = finding({ id: "rejected", status: "rejected" });
  assert.throws(() => selectAcceptedFindings([accepted, rejected], ["rejected"], "ev_1"), /only accepted findings/);
  assert.throws(() => selectAcceptedFindings([accepted], ["missing"], "ev_1"), /was not found/);
});

test("fix plan snapshot freezes provenance, comments and conservative verification policy", () => {
  const clipping = snapshotFixFinding(finding());
  assert.equal(clipping.verificationPolicy, "deterministic_recheck");
  assert.equal(clipping.comments[0].text, "Fix before release.");
  assert.equal(clipping.target.path, target.path);

  const overlap = snapshotFixFinding(finding({ type: "candidate_overlap", fingerprint: "fp_overlap" }));
  assert.equal(overlap.verificationPolicy, "human_recheck");

  const visual = snapshotFixFinding(finding({ source: "visual_critic", type: "visual_hierarchy", fingerprint: "fp_visual" }));
  assert.equal(visual.verificationPolicy, "human_recheck");

  const baseline = snapshotFixFinding(finding({ source: "reference_critic", type: "baseline_regression", fingerprint: "fp_ref", comparisonId: "refcmp_1", referenceEvidenceId: "ev_ref" }));
  assert.equal(baseline.verificationPolicy, "human_recheck");
  assert.equal(baseline.comparisonId, "refcmp_1");
  assert.equal(baseline.referenceEvidenceId, "ev_ref");
});

test("high-confidence deterministic item is unresolved when the same fingerprint reproduces", () => {
  const item = snapshotFixFinding(finding());
  const result = evaluateFixPlanItem(item, postEvidence(), [{ fingerprint: item.fingerprint }]);
  assert.equal(result.status, "unresolved");
});

test("high-confidence deterministic item resolves only when target remains and fingerprint disappears", () => {
  const item = snapshotFixFinding(finding());
  const result = evaluateFixPlanItem(item, postEvidence(), []);
  assert.equal(result.status, "resolved");
});

test("target disappearance requires review rather than claiming deterministic resolution", () => {
  const item = snapshotFixFinding(finding());
  const result = evaluateFixPlanItem(item, postEvidence([]), []);
  assert.equal(result.status, "needs_review");
  assert.match(result.reason, /no longer resolves/);
});

test("heuristic and perceptual findings always require fresh review", () => {
  const overlap = snapshotFixFinding(finding({ type: "candidate_overlap", fingerprint: "fp_overlap" }));
  const visual = snapshotFixFinding(finding({ source: "visual_critic", type: "visual_hierarchy", fingerprint: "fp_visual" }));
  const baseline = snapshotFixFinding(finding({ source: "reference_critic", type: "baseline_regression", fingerprint: "fp_ref" }));
  assert.equal(evaluateFixPlanItem(overlap, postEvidence(), []).status, "needs_review");
  assert.equal(evaluateFixPlanItem(visual, postEvidence(), []).status, "needs_review");
  assert.equal(evaluateFixPlanItem(baseline, postEvidence(), []).status, "needs_review");
});

test("overall fix status prioritizes unresolved, then needs_review, then verified", () => {
  assert.equal(overallFixStatus([{ status: "resolved" }]), "verified");
  assert.equal(overallFixStatus([{ status: "resolved" }, { status: "needs_review" }]), "needs_review");
  assert.equal(overallFixStatus([{ status: "needs_review" }, { status: "unresolved" }]), "unresolved");
});

test("fix plan store preserves attempt history and change references", () => {
  const store = new FixPlanStore();
  const plan = store.create({ reviewId: "webrev_1", evidenceId: "ev_before", items: [snapshotFixFinding(finding())] });
  assert.match(plan.id, /^fixplan_/);
  assert.equal(plan.status, "planned");
  const stored = store.addAttempt(plan.id, {
    status: "verified",
    baseEvidenceId: "ev_before",
    postFixEvidenceId: "ev_after",
    postFixReviewId: "webrev_2",
    changeSummary: "Adjusted CTA width.",
    changeReference: "commit:abc123",
    results: [{ status: "resolved" }],
    comparison: { metrics: { changed: 1 } },
  });
  assert.match(stored.attempt.id, /^fixattempt_/);
  assert.equal(stored.plan.status, "verified");
  assert.equal(store.get(plan.id).attempts[0].changeReference, "commit:abc123");
});
