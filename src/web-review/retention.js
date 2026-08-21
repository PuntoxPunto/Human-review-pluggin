import { EvidenceStore } from "./evidence-store.js";
import { FindingStore } from "./finding-store.js";
import { ReferenceComparisonStore } from "./reference-store.js";
import { FixPlanStore } from "./fix-plan-store.js";

function boundedInteger(value, { name, min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

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
  const days = boundedInteger(retentionDays, { name: "retentionDays", min: 0, max: 3650 });
  const keepLatest = boundedInteger(keepLatestPerReview, { name: "keepLatestPerReview", min: 0, max: 100 });
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
