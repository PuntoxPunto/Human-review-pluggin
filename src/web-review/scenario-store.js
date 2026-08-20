import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ScenarioRunStore {
  #runs = new Map();

  start({ reviewId, name, steps, viewport }) {
    const run = {
      id: `scenario_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      reviewId,
      name: String(name || "Web Review scenario").trim().slice(0, 160),
      requestedSteps: clone(steps),
      viewport: clone(viewport),
      status: "running",
      initialEvidenceId: null,
      steps: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.#runs.set(run.id, run);
    return clone(run);
  }

  complete(id, { initialEvidenceId, steps }) {
    const run = this.#mustGet(id);
    run.status = "completed";
    run.initialEvidenceId = initialEvidenceId;
    run.steps = clone(steps);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  fail(id, error, { initialEvidenceId = null, steps = [] } = {}) {
    const run = this.#mustGet(id);
    run.status = "failed";
    run.initialEvidenceId = initialEvidenceId;
    run.steps = clone(steps);
    run.error = String(error?.message || error || "Unknown scenario error").slice(0, 2000);
    run.completedAt = new Date().toISOString();
    return clone(run);
  }

  get(id) {
    return clone(this.#mustGet(id));
  }

  #mustGet(id) {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Scenario run ${id} was not found.`);
    return run;
  }
}