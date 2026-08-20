import { createHash, randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceOf(finding) {
  return finding.source || "deterministic";
}

function fingerprint(finding) {
  const stable = JSON.stringify({
    source: sourceOf(finding),
    type: finding.type,
    target: finding.target?.path || finding.target?.selector || null,
    related: finding.related?.path || finding.related?.selector || null,
  });
  return `fp_${createHash("sha256").update(stable).digest("hex").slice(0, 20)}`;
}

export class FindingStore {
  #byEvidence = new Map();

  replaceForEvidence({ reviewId, evidenceId, findings, source = "deterministic" }) {
    const previous = this.#byEvidence.get(evidenceId) || [];
    const sourcePrevious = previous.filter((finding) => sourceOf(finding) === source);
    const previousByFingerprint = new Map(sourcePrevious.map((finding) => [finding.fingerprint, finding]));
    const now = new Date().toISOString();
    const stored = findings.slice(0, 100).map((finding) => {
      const normalized = { ...clone(finding), source: finding.source || source };
      if (normalized.source !== source) {
        throw new Error(`Finding source ${normalized.source} does not match replacement source ${source}.`);
      }
      const findingFingerprint = fingerprint(normalized);
      const prior = previousByFingerprint.get(findingFingerprint);
      return {
        ...normalized,
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
    const otherSources = previous.filter((finding) => sourceOf(finding) !== source);
    this.#byEvidence.set(evidenceId, [...otherSources, ...stored]);
    return clone(stored);
  }

  list(evidenceId, { source = null } = {}) {
    const findings = this.#byEvidence.get(evidenceId) || [];
    return clone(source ? findings.filter((finding) => sourceOf(finding) === source) : findings);
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
      deterministic: 0,
      visual_critic: 0,
    };
    for (const finding of findings) {
      if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
      if (Object.hasOwn(counts, finding.status)) counts[finding.status] += 1;
      const source = sourceOf(finding);
      if (Object.hasOwn(counts, source)) counts[source] += 1;
    }
    return counts;
  }
}