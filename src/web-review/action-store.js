import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ActionRunStore {
  #runs = new Map();

  start({ reviewId, action, viewport }) {
    const id = `actrun_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const run = {
      id,
      reviewId,
      action: clone(action),
      viewport: clone(viewport),
      status: "running",
      beforeEvidenceId: null,
      afterEvidenceId: null,
      resolvedLocator: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.#runs.set(id, run);
    return clone(run);
  }

  complete(id, { beforeEvidenceId, afterEvidenceId, resolvedLocator }) {
    const run = this.#mustGet(id);
    run.status = "completed";
    run.beforeEvidenceId = beforeEvidenceId;
    run.afterEvidenceId = afterEvidenceId;
    run.resolvedLocator = clone(resolvedLocator);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  fail(id, error) {
    const run = this.#mustGet(id);
    run.status = "failed";
    run.error = String(error?.message || error || "Unknown browser action error").slice(0, 2000);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  get(id) {
    return clone(this.#mustGet(id));
  }

  #mustGet(id) {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Action run ${id} was not found.`);
    return run;
  }
}