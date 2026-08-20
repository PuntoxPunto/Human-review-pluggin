import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function effectiveResultStatus(result, reviewDecisions) {
  if (result.status !== "needs_review") return result.status;
  const latest = [...reviewDecisions].reverse().find((decision) => decision.findingId === result.finding_id);
  if (!latest || latest.status === "needs_review") return "needs_review";
  return latest.status;
}

export function computeReviewedAttemptStatus(attempt) {
  const effective = attempt.results.map((result) => effectiveResultStatus(result, attempt.reviewDecisions || []));
  if (effective.some((status) => status === "unresolved")) return "unresolved";
  if (effective.some((status) => status === "needs_review")) return "needs_review";
  return "verified";
}

export class FixPlanStore {
  #plans = new Map();

  create({ reviewId, evidenceId, items }) {
    if (!items.length) throw new Error("A fix plan requires at least one accepted finding.");
    const now = new Date().toISOString();
    const plan = {
      id: `fixplan_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      reviewId,
      evidenceId,
      status: "planned",
      items: clone(items),
      attempts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#plans.set(plan.id, plan);
    return clone(plan);
  }

  get(id) {
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    return clone(plan);
  }

  getAttempt(id, attemptId = null) {
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    const attempt = attemptId
      ? plan.attempts.find((item) => item.id === attemptId)
      : plan.attempts.at(-1);
    if (!attempt) throw new Error(attemptId ? `Fix attempt ${attemptId} was not found in plan ${id}.` : `Fix plan ${id} has no verification attempts.`);
    return clone(attempt);
  }

  addAttempt(id, attempt) {
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    const stored = {
      id: `fixattempt_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      ...clone(attempt),
      automaticStatus: attempt.status,
      reviewDecisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    plan.attempts.push(stored);
    plan.status = stored.status;
    plan.updatedAt = stored.updatedAt;
    return { plan: clone(plan), attempt: clone(stored) };
  }

  reviewAttemptItem(id, attemptId, findingId, { status, comment = "" }) {
    if (!["resolved", "unresolved", "needs_review"].includes(status)) {
      throw new Error("Fix item review status must be resolved, unresolved, or needs_review.");
    }
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    const attempt = plan.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error(`Fix attempt ${attemptId} was not found in plan ${id}.`);
    const result = attempt.results.find((item) => item.finding_id === findingId);
    if (!result) throw new Error(`Finding ${findingId} is not part of fix attempt ${attemptId}.`);
    if (result.status !== "needs_review") {
      throw new Error(`Finding ${findingId} has automatic status ${result.status}; human review cannot override deterministic verification.`);
    }

    const now = new Date().toISOString();
    attempt.reviewDecisions.push({
      id: `fixdecision_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      findingId,
      status,
      comment: String(comment || "").trim().slice(0, 4000),
      decidedAt: now,
    });
    attempt.status = computeReviewedAttemptStatus(attempt);
    attempt.updatedAt = now;
    if (plan.attempts.at(-1)?.id === attempt.id) plan.status = attempt.status;
    plan.updatedAt = now;
    return { plan: clone(plan), attempt: clone(attempt) };
  }
}
