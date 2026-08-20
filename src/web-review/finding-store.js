import { randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class FindingStore {
  #byEvidence = new Map();

  replaceForEvidence({ reviewId, evidenceId, findings }) {
    const stored = findings.slice(0, 100).map((finding) => ({
      ...clone(finding),
      id: finding.id || `finding_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      reviewId,
      evidenceId,
      status: finding.status || "new",
      createdAt: finding.createdAt || new Date().toISOString(),
    }));
    this.#byEvidence.set(evidenceId, stored);
    return clone(stored);
  }

  list(evidenceId) {
    return clone(this.#byEvidence.get(evidenceId) || []);
  }

  summary(evidenceId) {
    const findings = this.#byEvidence.get(evidenceId) || [];
    const counts = { total: findings.length, info: 0, warning: 0, error: 0, critical: 0 };
    for (const finding of findings) {
      if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
    }
    return counts;
  }
}
