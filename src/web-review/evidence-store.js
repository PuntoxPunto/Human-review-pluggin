import { randomUUID } from "node:crypto";
import { createStateMap, persistStateMapEntry } from "../state-map.js";
import { ArtifactStore } from "./artifact-store.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function protectionReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(reason)) throw new Error("Screenshot protection reason must be a short lowercase identifier.");
  return reason;
}

function cloneWithoutScreenshot(evidence) {
  const copy = clone(evidence);
  delete copy.screenshotBase64;
  return copy;
}

function screenshotBytesFromInline(evidence) {
  if (!evidence.screenshotBase64) return 0;
  try { return Buffer.from(evidence.screenshotBase64, "base64").byteLength; } catch { return 0; }
}

export class EvidenceStore {
  #evidence;
  #artifacts;

  constructor({ artifactStore = null } = {}) {
    this.#evidence = createStateMap("web-evidence");
    this.#artifacts = artifactStore || new ArtifactStore();
  }

  put({ reviewId, runId, capture, capturedAt = new Date().toISOString() }) {
    const id = `ev_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const artifact = this.#artifacts.putScreenshot({
      evidenceId: id,
      data: capture.screenshotBase64,
      mimeType: "image/png",
      createdAt: capturedAt,
    });
    const evidence = {
      id,
      reviewId,
      runId,
      capturedAt,
      finalUrl: capture.finalUrl,
      title: capture.title,
      viewport: capture.viewport,
      scroll: capture.scroll,
      document: capture.document,
      screenshotArtifactId: artifact.id,
      screenshotMimeType: artifact.mimeType,
      screenshotBytes: artifact.bytes,
      screenshotProtection: [],
      screenshotPrunedAt: null,
      structure: capture.structure,
      consoleErrors: capture.consoleErrors,
      networkErrors: capture.networkErrors,
    };
    this.#evidence.set(id, evidence);
    return this.get(id);
  }

  #mustGet(id) {
    const evidence = this.#evidence.get(id);
    if (!evidence) throw new Error(`Evidence ${id} was not found.`);
    return evidence;
  }

  #hasScreenshot(evidence) {
    if (evidence.screenshotBase64) return true;
    return Boolean(evidence.screenshotArtifactId && this.#artifacts.has(evidence.screenshotArtifactId));
  }

  get(id, { includeScreenshot = false, allowMissingScreenshot = false } = {}) {
    const stored = this.#mustGet(id);
    const evidence = clone(stored);
    evidence.screenshotAvailable = this.#hasScreenshot(stored);
    evidence.screenshotProtection = clone(stored.screenshotProtection || []);
    evidence.screenshotBytes = Number(stored.screenshotBytes || screenshotBytesFromInline(stored) || 0);

    if (!includeScreenshot) return cloneWithoutScreenshot(evidence);

    if (!evidence.screenshotBase64 && stored.screenshotArtifactId && this.#artifacts.has(stored.screenshotArtifactId)) {
      const artifact = this.#artifacts.get(stored.screenshotArtifactId);
      evidence.screenshotBase64 = artifact.data;
      evidence.screenshotMimeType = artifact.mimeType;
      evidence.screenshotBytes = artifact.bytes;
      evidence.screenshotAvailable = true;
    }

    if (!evidence.screenshotBase64) {
      evidence.screenshotBase64 = null;
      evidence.screenshotAvailable = false;
      if (!allowMissingScreenshot) {
        throw new Error(`Screenshot artifact for evidence ${id} is no longer retained. Structured DOM/geometry evidence remains available; capture fresh evidence for visual analysis.`);
      }
    }
    return clone(evidence);
  }

  requireScreenshot(id, { protectReason = null } = {}) {
    const evidence = this.get(id, { includeScreenshot: true });
    if (protectReason) this.protectScreenshot(id, protectReason);
    return evidence;
  }

  protectScreenshot(id, reason) {
    const evidence = this.#mustGet(id);
    if (!this.#hasScreenshot(evidence)) {
      throw new Error(`Cannot protect screenshot for evidence ${id} because the artifact is no longer retained.`);
    }
    const normalized = protectionReason(reason);
    const protections = Array.isArray(evidence.screenshotProtection) ? evidence.screenshotProtection : [];
    if (!protections.some((item) => item.reason === normalized)) {
      protections.push({ reason: normalized, protectedAt: new Date().toISOString() });
      evidence.screenshotProtection = protections;
      persistStateMapEntry(this.#evidence, id);
    }
    return this.get(id);
  }

  pruneScreenshot(id, { prunedAt = new Date().toISOString() } = {}) {
    const evidence = this.#mustGet(id);
    const protections = Array.isArray(evidence.screenshotProtection) ? evidence.screenshotProtection : [];
    if (protections.length) {
      return { evidence_id: id, pruned: false, reason: "protected", protections: clone(protections), bytes_reclaimed: 0 };
    }

    let removed = false;
    let bytes = Number(evidence.screenshotBytes || screenshotBytesFromInline(evidence) || 0);
    if (evidence.screenshotBase64) {
      delete evidence.screenshotBase64;
      removed = true;
    }
    if (evidence.screenshotArtifactId) {
      if (!bytes && this.#artifacts.has(evidence.screenshotArtifactId)) bytes = this.#artifacts.get(evidence.screenshotArtifactId).bytes;
      removed = this.#artifacts.delete(evidence.screenshotArtifactId) || removed;
    }
    if (!removed) return { evidence_id: id, pruned: false, reason: "already_missing", protections: [], bytes_reclaimed: 0 };

    evidence.screenshotArtifactId = null;
    evidence.screenshotPrunedAt = prunedAt;
    evidence.screenshotBytes = bytes;
    persistStateMapEntry(this.#evidence, id);
    return { evidence_id: id, pruned: true, reason: "retention", protections: [], bytes_reclaimed: bytes };
  }

  list() {
    return [...this.#evidence.keys()].map((id) => this.get(id));
  }

  pruneScreenshots({ olderThanMs = 30 * 24 * 60 * 60 * 1000, keepLatestPerReview = 5, protectedEvidenceIds = [], dryRun = true, now = Date.now() } = {}) {
    const retentionMs = Math.max(0, Number(olderThanMs) || 0);
    const keepLatest = Math.max(0, Math.min(100, Number(keepLatestPerReview) || 0));
    const canonicalProtected = new Set([...protectedEvidenceIds].map(String));
    const currentTime = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(currentTime)) throw new Error("Retention now must be a valid timestamp.");

    const evidence = this.list().filter((item) => item.screenshotAvailable);
    const latestProtected = new Set();
    const byReview = new Map();
    for (const item of evidence) {
      const group = byReview.get(item.reviewId) || [];
      group.push(item);
      byReview.set(item.reviewId, group);
    }
    for (const group of byReview.values()) {
      group.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      for (const item of group.slice(0, keepLatest)) latestProtected.add(item.id);
    }

    const candidates = [];
    let localProtectedCount = 0;
    let canonicalProtectedCount = 0;
    let youngCount = 0;
    let latestCount = 0;
    for (const item of evidence) {
      const protections = item.screenshotProtection || [];
      if (protections.length) {
        localProtectedCount += 1;
        continue;
      }
      if (canonicalProtected.has(item.id)) {
        canonicalProtectedCount += 1;
        continue;
      }
      if (latestProtected.has(item.id)) {
        latestCount += 1;
        continue;
      }
      const capturedAt = Date.parse(item.capturedAt);
      if (!Number.isFinite(capturedAt) || currentTime - capturedAt < retentionMs) {
        youngCount += 1;
        continue;
      }
      candidates.push({
        evidence_id: item.id,
        review_id: item.reviewId,
        captured_at: item.capturedAt,
        screenshot_bytes: item.screenshotBytes || 0,
      });
    }

    let prunedCount = 0;
    let bytesReclaimed = 0;
    if (!dryRun) {
      for (const candidate of candidates) {
        const result = this.pruneScreenshot(candidate.evidence_id, { prunedAt: new Date(currentTime).toISOString() });
        if (result.pruned) {
          prunedCount += 1;
          bytesReclaimed += result.bytes_reclaimed;
        }
      }
    }

    return {
      dry_run: Boolean(dryRun),
      retention_ms: retentionMs,
      keep_latest_per_review: keepLatest,
      screenshot_count: evidence.length,
      candidate_count: candidates.length,
      protected_count: localProtectedCount + canonicalProtectedCount,
      local_protected_count: localProtectedCount,
      canonical_protected_count: canonicalProtectedCount,
      latest_kept_count: latestCount,
      young_kept_count: youngCount,
      pruned_count: prunedCount,
      bytes_reclaimed: bytesReclaimed,
      candidate_bytes: candidates.reduce((sum, item) => sum + (item.screenshot_bytes || 0), 0),
      candidates,
    };
  }

  summary(id) {
    const evidence = this.get(id);
    return {
      evidence_id: evidence.id,
      review_id: evidence.reviewId,
      run_id: evidence.runId,
      url: evidence.finalUrl,
      title: evidence.title,
      viewport: evidence.viewport,
      scroll: evidence.scroll,
      structure_count: evidence.structure.length,
      console_error_count: evidence.consoleErrors.length,
      network_error_count: evidence.networkErrors.length,
    };
  }
}
