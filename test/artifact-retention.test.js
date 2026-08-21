import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../src/web-review/evidence-store.js";
import { FindingStore } from "../src/web-review/finding-store.js";
import { ReferenceComparisonStore } from "../src/web-review/reference-store.js";
import { FixPlanStore } from "../src/web-review/fix-plan-store.js";
import { collectProtectedEvidenceIds, runArtifactRetention } from "../src/web-review/retention.js";
import { createStateMap } from "../src/state-map.js";

function withStateDir(t) {
  const previous = process.env.WEB_REVIEW_STATE_DIR;
  const directory = mkdtempSync(join(tmpdir(), "web-review-retention-"));
  process.env.WEB_REVIEW_STATE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_REVIEW_STATE_DIR;
    else process.env.WEB_REVIEW_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function capture(label) {
  return {
    finalUrl: `https://example.com/${label}`,
    title: label,
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0 },
    document: { scrollWidth: 1280, scrollHeight: 1200, clientWidth: 1280, clientHeight: 800 },
    screenshotBase64: Buffer.from(`png:${label}`).toString("base64"),
    structure: [{
      tag: "main", selector: "main", path: "body > main", parentPath: "body", role: null,
      name: label, text: label,
      rect: { x: 0, y: 0, width: 1280, height: 800, top: 0, right: 1280, bottom: 800, left: 0 },
      position: "static", zIndex: "auto", overflowX: "visible", overflowY: "visible",
    }],
    consoleErrors: [],
    networkErrors: [],
  };
}

function comparisonResult(reference, candidate) {
  return {
    reference: {
      evidenceId: reference.id, reviewId: reference.reviewId, url: `https://example.com/${reference.id}`,
      viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
      document: { scrollWidth: 1280, scrollHeight: 1200, clientWidth: 1280, clientHeight: 800 },
    },
    candidate: {
      evidenceId: candidate.id, reviewId: candidate.reviewId, url: `https://example.com/${candidate.id}`,
      viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
      document: { scrollWidth: 1280, scrollHeight: 1200, clientWidth: 1280, clientHeight: 800 },
    },
    viewport: { width: 1280, height: 800 },
    metrics: { matched: 1, added: 0, removed: 0, changed: 0, scroll_dx: 0, scroll_dy: 0, document_width_delta: 0, document_height_delta: 0 },
    added: [], removed: [], changed: [],
  };
}

test("retention prunes only old unreferenced screenshot blobs and preserves evidence metadata", (t) => {
  withStateDir(t);
  const evidenceStore = new EvidenceStore();
  const findingStore = new FindingStore();
  const referenceStore = new ReferenceComparisonStore();
  const fixPlanStore = new FixPlanStore();
  const reviewId = "webrev_retention";
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const old = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"].map((date) => `${date}T12:00:00.000Z`);

  const orphan = evidenceStore.put({ reviewId, runId: "run_orphan", capture: capture("orphan"), capturedAt: old[0] });
  const baseline = evidenceStore.put({ reviewId, runId: "run_baseline", capture: capture("baseline"), capturedAt: old[1] });
  const withFinding = evidenceStore.put({ reviewId, runId: "run_finding", capture: capture("finding"), capturedAt: old[2] });
  const fixBase = evidenceStore.put({ reviewId, runId: "run_fix", capture: capture("fix"), capturedAt: old[3] });
  const latest = evidenceStore.put({ reviewId, runId: "run_latest", capture: capture("latest"), capturedAt: "2026-08-20T12:00:00.000Z" });

  findingStore.replaceForEvidence({
    reviewId,
    evidenceId: withFinding.id,
    findings: [{
      type: "candidate_overlap", severity: "warning", confidence: 0.7,
      title: "Review overlap", description: "Keep evidence for review.",
      target: null, related: null, rect: null, metrics: {},
    }],
  });

  referenceStore.put({
    referenceEvidenceId: baseline.id,
    candidateEvidenceId: latest.id,
    result: comparisonResult(baseline, latest),
  });

  fixPlanStore.create({
    reviewId,
    evidenceId: fixBase.id,
    items: [{
      findingId: "finding_fix", fingerprint: "fp_fix", source: "deterministic", type: "element_horizontal_clipping",
      severity: "error", title: "Fix clipping", description: "Protected by fix plan.", target: null, related: null,
      comments: [], comparisonId: null, referenceEvidenceId: null, verificationPolicy: "deterministic_recheck",
    }],
  });

  const protectedIds = new Set(collectProtectedEvidenceIds({ findingStore, referenceStore, fixPlanStore }));
  assert.deepEqual(protectedIds, new Set([baseline.id, latest.id, withFinding.id, fixBase.id]));

  const dryRun = runArtifactRetention({
    evidenceStore, findingStore, referenceStore, fixPlanStore,
    retentionDays: 30,
    keepLatestPerReview: 1,
    dryRun: true,
    now,
  });
  assert.equal(dryRun.candidate_count, 1);
  assert.equal(dryRun.candidates[0].evidence_id, orphan.id);
  assert.equal(dryRun.pruned_count, 0);
  assert.equal(evidenceStore.get(orphan.id, { includeScreenshot: true }).screenshotAvailable, true);

  const applied = runArtifactRetention({
    evidenceStore, findingStore, referenceStore, fixPlanStore,
    retentionDays: 30,
    keepLatestPerReview: 1,
    dryRun: false,
    now,
  });
  assert.equal(applied.candidate_count, 1);
  assert.equal(applied.pruned_count, 1);
  assert.ok(applied.bytes_reclaimed > 0);

  const metadata = evidenceStore.get(orphan.id);
  assert.equal(metadata.screenshotAvailable, false);
  assert.equal(metadata.structure[0].text, "orphan");
  assert.equal(metadata.finalUrl, "https://example.com/orphan");
  assert.ok(metadata.screenshotPrunedAt);

  const missingAllowed = evidenceStore.get(orphan.id, { includeScreenshot: true, allowMissingScreenshot: true });
  assert.equal(missingAllowed.screenshotBase64, null);
  assert.equal(missingAllowed.screenshotAvailable, false);
  assert.throws(() => evidenceStore.get(orphan.id, { includeScreenshot: true }), /no longer retained/i);

  for (const id of [baseline.id, withFinding.id, fixBase.id, latest.id]) {
    assert.equal(evidenceStore.get(id, { includeScreenshot: true }).screenshotAvailable, true);
  }

  const restarted = new EvidenceStore();
  assert.equal(restarted.get(orphan.id).screenshotAvailable, false);
  assert.equal(restarted.get(baseline.id, { includeScreenshot: true }).screenshotAvailable, true);
});

test("legacy inline screenshots remain readable and can be pruned without deleting metadata", (t) => {
  withStateDir(t);
  const state = createStateMap("web-evidence");
  const screenshotBase64 = Buffer.from("legacy-png").toString("base64");
  state.set("ev_legacy", {
    id: "ev_legacy", reviewId: "webrev_legacy", runId: "run_legacy", capturedAt: "2026-01-01T00:00:00.000Z",
    finalUrl: "https://example.com/legacy", title: "legacy",
    viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 },
    document: { scrollWidth: 800, scrollHeight: 600, clientWidth: 800, clientHeight: 600 },
    screenshotBase64, screenshotMimeType: "image/png",
    structure: [], consoleErrors: [], networkErrors: [],
  });

  const evidenceStore = new EvidenceStore();
  assert.equal(evidenceStore.get("ev_legacy", { includeScreenshot: true }).screenshotBase64, screenshotBase64);
  const result = evidenceStore.pruneScreenshots({ olderThanMs: 0, keepLatestPerReview: 0, dryRun: false, now: Date.parse("2026-08-21T12:00:00.000Z") });
  assert.equal(result.pruned_count, 1);
  assert.equal(evidenceStore.get("ev_legacy").finalUrl, "https://example.com/legacy");
  assert.equal(evidenceStore.get("ev_legacy").screenshotAvailable, false);
});
