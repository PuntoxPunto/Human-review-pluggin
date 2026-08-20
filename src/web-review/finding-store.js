import { createHash, randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprint(finding) {
  const stable = JSON.stringify({
    type: finding.type,
    target: finding.target?.path || finding.target?.selector || null,
    related: finding.related?.path || finding.related?.selector || null,
    metrics: finding.metrics || {},
  });
  return `fp_${createHash("sha256").update(stable).digest("hex").slice(0, 20)}`;
}

export class FindingStore {
  #byEvidence = new Map();

  replaceForEvidence({ reviewId, evidenceId, findings }) {
    const previous = this.#byEvidence.get(evidenceId) || [];
    const previousByFingerprint = new Map(previous.map((finding) => [finding.fingerprint, finding]));
    const now = new Date().toISOString();
    const stored = findings.slice(0, 100).map((finding) => {
      const findingFingerprint = fingerprint(finding);
      const prior = previousByFingerprint.get(findingFingerprint);
      return {
        ...clone(finding),
        id: prior?.id || finding.id || `finding_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        fingerprint: findingFingerprint,
        reviewId,
        evidenceId,
        status: prior?.status || finding.status || "new",
        comments: clone(prior?.comments || finding.comments || []),
        decidedAt: prior?.decidedAt || finding.decidedAt || null,
        createdAt: prior?.createdAt || finding.createdAt || now,
        updatedAt: now,
      };
    });
    this.#byEvidence.set(evidenceId, stored);
    return clone(stored);
  }

  list(evidenceId) {
    return clone(this.#byEvidence.get(evidenceId) || []);
  }

  get(evidenceId, findingId) {
    const finding = (this.#byEvidence.get(evidenceId) || []).find((item) => item.id === findingId);
    if (!finding) throw new Error(`Finding ${findingId} was not found for evidence ${evidenceId}.`);
    return clone(finding);
  }

  decide(evidenceId, findingId, { status, comment = "" }) {
    if (!["new", "accepted", "rejected"].includes(status)) {
      throw new Error("Finding status must be new, accepted, or rejected.");
    }
    const findings = this.#byEvidence.get(evidenceId) || [];
    const finding = findings.find((item) => item.id === findingId);
    if (!finding) throw new Error(`Finding ${findingId} was not found for evidence ${evidenceId}.`);

    const text = String(comment || "").trim();
    const now = new Date().toISOString();
    finding.status = status;
    finding.decidedAt = status === "new" ? null : now;
    finding.updatedAt = now;
    if (text) {
      finding.comments.push({
        id: `fcomment_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        text: text.slice(0, 4000),
        createdAt: now,
      });
    }
    return clone(finding);
  }

  summary(evidenceId) {
    const findings = this.#byEvidence.get(evidenceId) || [];
    const counts = {
      total: findings.length,
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
      new: 0,
      accepted: 0,
      rejected: 0,
    };
    for (const finding of findings) {
      if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
      if (Object.hasOwn(counts, finding.status)) counts[finding.status] += 1;
    }
    return counts;
  }
}
