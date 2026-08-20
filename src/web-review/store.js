import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeViewport(viewport = {}) {
  const width = Number(viewport.width ?? 1440);
  const height = Number(viewport.height ?? 900);
  if (!Number.isInteger(width) || width < 320 || width > 3840) throw new Error("Viewport width must be an integer between 320 and 3840.");
  if (!Number.isInteger(height) || height < 320 || height > 2160) throw new Error("Viewport height must be an integer between 320 and 2160.");
  return { width, height };
}

export class WebReviewStore {
  #reviews = new Map();

  create({ title, url, viewport }) {
    const now = new Date().toISOString();
    const review = {
      id: `webrev_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      mode: "web",
      title: String(title || "Untitled web review").trim().slice(0, 160),
      targetUrl: url,
      viewport: normalizeViewport(viewport),
      status: "ready",
      runs: [],
      evidenceIds: [],
      findings: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#reviews.set(review.id, review);
    return clone(review);
  }

  get(id) {
    return clone(this.#mustGet(id));
  }

  beginRun(id, { viewport } = {}) {
    const review = this.#mustGet(id);
    const run = {
      id: `run_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      status: "running",
      viewport: normalizeViewport(viewport ?? review.viewport),
      startedAt: new Date().toISOString(),
      completedAt: null,
      evidenceId: null,
      error: null,
    };
    review.runs.push(run);
    review.status = "running";
    review.updatedAt = run.startedAt;
    return clone(run);
  }

  completeRun(id, runId, evidenceId) {
    const review = this.#mustGet(id);
    const run = review.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run ${runId} was not found for ${id}.`);
    run.status = "completed";
    run.evidenceId = evidenceId;
    run.completedAt = new Date().toISOString();
    review.status = "reviewing";
    this.#appendEvidence(review, evidenceId);
    review.updatedAt = run.completedAt;
    return clone(review);
  }

  recordEvidence(id, evidenceId) {
    const review = this.#mustGet(id);
    this.#appendEvidence(review, evidenceId);
    review.status = "reviewing";
    review.updatedAt = new Date().toISOString();
    return clone(review);
  }

  failRun(id, runId, error) {
    const review = this.#mustGet(id);
    const run = review.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run ${runId} was not found for ${id}.`);
    run.status = "failed";
    run.error = String(error?.message || error || "Unknown browser error").slice(0, 2000);
    run.completedAt = new Date().toISOString();
    review.status = "error";
    review.updatedAt = run.completedAt;
    return clone(review);
  }

  #appendEvidence(review, evidenceId) {
    if (!review.evidenceIds.includes(evidenceId)) review.evidenceIds.push(evidenceId);
  }

  #mustGet(id) {
    const review = this.#reviews.get(id);
    if (!review) throw new Error(`Web Review ${id} was not found.`);
    return review;
  }
}

export { normalizeViewport };