import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ReferenceComparisonStore {
  #comparisons = new Map();

  put({ referenceEvidenceId, candidateEvidenceId, result }) {
    const id = `refcmp_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const comparison = {
      id,
      referenceEvidenceId,
      candidateEvidenceId,
      referenceReviewId: result.reference.reviewId,
      candidateReviewId: result.candidate.reviewId,
      createdAt: new Date().toISOString(),
      result: clone(result),
    };
    this.#comparisons.set(id, comparison);
    return clone(comparison);
  }

  get(id) {
    const comparison = this.#comparisons.get(id);
    if (!comparison) throw new Error(`Reference comparison ${id} was not found.`);
    return clone(comparison);
  }
}
