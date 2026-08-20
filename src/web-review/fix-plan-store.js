import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FixPlanStore {
  #plans = new Map();

  create({ reviewId, evidenceId, items }) {
    if (!items.length) throw new Error("A fix plan requires at least one accepted finding.");
    const plan = {
      id: `fixplan_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      reviewId,
      evidenceId,
      status: "planned",
      items: clone(items),
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#plans.set(plan.id, plan);
    return clone(plan);
  }

  get(id) {
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    return clone(plan);
  }

  addAttempt(id, attempt) {
    const plan = this.#plans.get(id);
    if (!plan) throw new Error(`Fix plan ${id} was not found.`);
    const stored = {
      id: `fixattempt_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      ...clone(attempt),
      createdAt: new Date().toISOString(),
    };
    plan.attempts.push(stored);
    plan.status = stored.status;
    plan.updatedAt = new Date().toISOString();
    return { plan: clone(plan), attempt: clone(stored) };
  }
}
