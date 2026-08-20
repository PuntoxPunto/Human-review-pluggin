import test from "node:test";
import assert from "node:assert/strict";
import { FixPlanStore, computeReviewedAttemptStatus } from "../src/web-review/fix-plan-store.js";

function createPlanWithAttempt(results, automaticStatus = "needs_review") {
  const store = new FixPlanStore();
  const plan = store.create({
    reviewId: "webrev_1",
    evidenceId: "ev_before",
    items: results.map((result) => ({ findingId: result.finding_id, title: result.finding_id })),
  });
  const added = store.addAttempt(plan.id, {
    status: automaticStatus,
    baseEvidenceId: "ev_before",
    postFixEvidenceId: "ev_after",
    postFixReviewId: "webrev_2",
    changeSummary: "Changed layout.",
    changeReference: "commit:abc",
    results,
    comparison: { metrics: {} },
  });
  return { store, planId: plan.id, attemptId: added.attempt.id };
}

test("reviewed attempt status starts from immutable automatic results", () => {
  const attempt = {
    results: [
      { finding_id: "a", status: "resolved" },
      { finding_id: "b", status: "needs_review" },
    ],
    reviewDecisions: [],
  };
  assert.equal(computeReviewedAttemptStatus(attempt), "needs_review");
  attempt.reviewDecisions.push({ findingId: "b", status: "resolved" });
  assert.equal(computeReviewedAttemptStatus(attempt), "verified");
});

test("human can resolve a needs_review item and complete the latest attempt", () => {
  const { store, planId, attemptId } = createPlanWithAttempt([
    { finding_id: "auto", status: "resolved" },
    { finding_id: "visual", status: "needs_review" },
  ]);
  const reviewed = store.reviewAttemptItem(planId, attemptId, "visual", { status: "resolved", comment: "Looks correct after the fix." });
  assert.equal(reviewed.attempt.automaticStatus, "needs_review");
  assert.equal(reviewed.attempt.status, "verified");
  assert.equal(reviewed.plan.status, "verified");
  assert.equal(reviewed.attempt.reviewDecisions.length, 1);
  assert.equal(reviewed.attempt.reviewDecisions[0].comment, "Looks correct after the fix.");
});

test("human unresolved decision keeps the attempt blocked", () => {
  const { store, planId, attemptId } = createPlanWithAttempt([
    { finding_id: "visual", status: "needs_review" },
  ]);
  const reviewed = store.reviewAttemptItem(planId, attemptId, "visual", { status: "unresolved", comment: "Still visually broken." });
  assert.equal(reviewed.attempt.status, "unresolved");
  assert.equal(reviewed.plan.status, "unresolved");
});

test("resetting a human decision returns the item to needs_review without deleting audit history", () => {
  const { store, planId, attemptId } = createPlanWithAttempt([
    { finding_id: "visual", status: "needs_review" },
  ]);
  store.reviewAttemptItem(planId, attemptId, "visual", { status: "resolved", comment: "First pass." });
  const reset = store.reviewAttemptItem(planId, attemptId, "visual", { status: "needs_review", comment: "Recheck requested." });
  assert.equal(reset.attempt.status, "needs_review");
  assert.equal(reset.attempt.reviewDecisions.length, 2);
  assert.equal(reset.attempt.reviewDecisions[1].status, "needs_review");
});

test("human review cannot override automatic resolved or unresolved results", () => {
  const { store, planId, attemptId } = createPlanWithAttempt([
    { finding_id: "resolved", status: "resolved" },
    { finding_id: "blocked", status: "unresolved" },
  ], "unresolved");
  assert.throws(() => store.reviewAttemptItem(planId, attemptId, "resolved", { status: "unresolved" }), /cannot override deterministic verification/);
  assert.throws(() => store.reviewAttemptItem(planId, attemptId, "blocked", { status: "resolved" }), /cannot override deterministic verification/);
  assert.equal(store.getAttempt(planId, attemptId).status, "unresolved");
});

test("an automatic unresolved result dominates human resolution of other review items", () => {
  const { store, planId, attemptId } = createPlanWithAttempt([
    { finding_id: "blocked", status: "unresolved" },
    { finding_id: "visual", status: "needs_review" },
  ], "unresolved");
  const reviewed = store.reviewAttemptItem(planId, attemptId, "visual", { status: "resolved" });
  assert.equal(reviewed.attempt.status, "unresolved");
});

test("reviewing an older attempt does not replace the plan status of the latest attempt", () => {
  const store = new FixPlanStore();
  const plan = store.create({ reviewId: "webrev_1", evidenceId: "ev_before", items: [{ findingId: "visual", title: "Visual" }] });
  const first = store.addAttempt(plan.id, {
    status: "needs_review",
    baseEvidenceId: "ev_before",
    postFixEvidenceId: "ev_after_1",
    postFixReviewId: "webrev_2",
    changeSummary: "Attempt one",
    results: [{ finding_id: "visual", status: "needs_review" }],
    comparison: { metrics: {} },
  });
  store.addAttempt(plan.id, {
    status: "unresolved",
    baseEvidenceId: "ev_before",
    postFixEvidenceId: "ev_after_2",
    postFixReviewId: "webrev_3",
    changeSummary: "Attempt two",
    results: [{ finding_id: "visual", status: "unresolved" }],
    comparison: { metrics: {} },
  });
  const reviewedOld = store.reviewAttemptItem(plan.id, first.attempt.id, "visual", { status: "resolved" });
  assert.equal(reviewedOld.attempt.status, "verified");
  assert.equal(reviewedOld.plan.status, "unresolved");
});
