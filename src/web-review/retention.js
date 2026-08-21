import { EvidenceStore } from "./evidence-store.js";
import { FindingStore } from "./finding-store.js";
import { ReferenceComparisonStore } from "./reference-store.js";
import { FixPlanStore } from "./fix-plan-store.js";

export function collectProtectedEvidenceIds({ findingStore, referenceStore, fixPlanStore }) {
  const protectedIds = new Set();
  for (const id of findingStore.referencedEvidenceIds()) protectedIds.add(id);
  for (const id of referenceStore.referencedEvidenceIds()) protectedIds.add(id);
  for (const id of fixPlanStore.referencedEvidenceIds()) protectedIds.add(id);
  return [...protectedIds];
}

export function runArtifactRetention({
  evidenceStore = new EvidenceStore(),
  findingStore = new FindingStore(),
  referenceStore = new ReferenceComparisonStore(),
  fixPlanStore = new FixPlanStore(),
  retentionDays = 30,
  keepLatestPerReview = 5,
  dryRun = true,
  now = Date.now(),
} = {}) {
  const days = Math.max(0, Math.min(3650, Number(retentionDays) || 0));
  const keepLatest = Math.max(0, Math.min(100, Number(keepLatestPerReview) || 0));
  const protectedEvidenceIds = collectProtectedEvidenceIds({ findingStore, referenceStore, fixPlanStore });
  const result = evidenceStore.pruneScreenshots({
    olderThanMs: days * 24 * 60 * 60 * 1000,
    keepLatestPerReview: keepLatest,
    protectedEvidenceIds,
    dryRun,
    now,
  });
  return {
    ...result,
    retention_days: days,
    canonical_reference_count: protectedEvidenceIds.length,
  };
}
