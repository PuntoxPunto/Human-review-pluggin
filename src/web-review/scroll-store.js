import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ScrollRunStore {
  #runs = new Map();

  start({ reviewId, checkpoints, viewport }) {
    const run = {
      id: `scrollrun_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      reviewId,
      checkpoints: clone(checkpoints),
      viewport: clone(viewport),
      status: "running",
      steps: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.#runs.set(run.id, run);
    return clone(run);
  }

  complete(id, steps) {
    const run = this.#mustGet(id);
    run.status = "completed";
    run.steps = clone(steps);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  fail(id, error) {
    const run = this.#mustGet(id);
    run.status = "failed";
    run.error = String(error?.message || error || "Unknown scroll review error").slice(0, 2000);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  get(id) {
    return clone(this.#mustGet(id));
  }

  #mustGet(id) {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Scroll run ${id} was not found.`);
    return run;
  }
}