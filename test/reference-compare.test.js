import test from "node:test";
import assert from "node:assert/strict";
import { compareEvidence } from "../src/web-review/reference-compare.js";
import { ReferenceComparisonStore } from "../src/web-review/reference-store.js";
import { FindingStore } from "../src/web-review/finding-store.js";

const rect = (left, top, width = 100, height = 40) => ({
  x: left, y: top, width, height,
  top, left, right: left + width, bottom: top + height,
});

function evidence(id, structure, overrides = {}) {
  return {
    id,
    reviewId: overrides.reviewId || `review_${id}`,
    finalUrl: overrides.finalUrl || `https://example.com/${id}`,
    viewport: overrides.viewport || { width: 1280, height: 800 },
    scroll: overrides.scroll || { x: 0, y: 0 },
    document: overrides.document || { scrollWidth: 1280, scrollHeight: 1800, clientWidth: 1280, clientHeight: 800 },
    structure,
  };
}

function element(path, text, box, overrides = {}) {
  return {
    path,
    selector: overrides.selector || path,
    tag: overrides.tag || "div",
    name: overrides.name || null,
    text,
    rect: box,
    ...overrides,
  };
}

test("reference comparison separates changed, added and removed elements", () => {
  const reference = evidence("ref", [
    element("main > h1", "Old headline", rect(100, 100, 400, 60), { tag: "h1" }),
    element("main > button", "Start", rect(100, 220, 120, 44), { tag: "button", name: "Start" }),
    element("main > p.old", "Legacy", rect(100, 320, 200, 40), { tag: "p" }),
  ]);
  const candidate = evidence("candidate", [
    element("main > h1", "New headline", rect(120, 105, 420, 60), { tag: "h1" }),
    element("main > button", "Start", rect(100, 220, 120, 44), { tag: "button", name: "Start" }),
    element("main > p.new", "Added", rect(100, 380, 200, 40), { tag: "p" }),
  ], {
    scroll: { x: 0, y: 50 },
    document: { scrollWidth: 1280, scrollHeight: 1900, clientWidth: 1280, clientHeight: 800 },
  });

  const result = compareEvidence(reference, candidate);
  assert.equal(result.metrics.matched, 2);
  assert.equal(result.metrics.changed, 1);
  assert.equal(result.metrics.added, 1);
  assert.equal(result.metrics.removed, 1);
  assert.equal(result.metrics.scroll_dy, 50);
  assert.equal(result.metrics.document_height_delta, 100);
  assert.equal(result.changed[0].path, "main > h1");
  assert.equal(result.changed[0].text_changed, true);
  assert.deepEqual(result.changed[0].delta, { dx: 20, dy: 5, dw: 20, dh: 0 });
});

test("reference comparison refuses mismatched viewports", () => {
  const reference = evidence("ref", []);
  const candidate = evidence("candidate", [], { viewport: { width: 390, height: 844 } });
  assert.throws(() => compareEvidence(reference, candidate), /requires identical viewports/);
});

test("reference comparison store keeps immutable pair metadata", () => {
  const store = new ReferenceComparisonStore();
  const result = compareEvidence(evidence("ref", []), evidence("candidate", []));
  const saved = store.put({ referenceEvidenceId: "ref", candidateEvidenceId: "candidate", result });
  assert.match(saved.id, /^refcmp_/);
  assert.equal(store.get(saved.id).referenceEvidenceId, "ref");
  assert.equal(store.get(saved.id).candidateEvidenceId, "candidate");
});

test("reference critic decisions persist only for the same comparison fingerprint", () => {
  const store = new FindingStore();
  const base = {
    source: "reference_critic",
    comparisonId: "refcmp_1",
    referenceEvidenceId: "ev_ref",
    type: "visual_regression",
    severity: "warning",
    confidence: 0.8,
    title: "Hero framing regressed",
    description: "Candidate hero is visually lower than the approved baseline.",
    target: null,
    related: null,
    rect: null,
    metrics: {},
  };
  const first = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_candidate", findings: [base], source: "reference_critic" });
  store.decide("ev_candidate", first[0].id, { status: "accepted", comment: "Restore baseline framing." });
  const rerun = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_candidate", findings: [{ ...base, description: "Still lower." }], source: "reference_critic" });
  assert.equal(rerun[0].id, first[0].id);
  assert.equal(rerun[0].status, "accepted");
  assert.equal(rerun[0].comments[0].text, "Restore baseline framing.");

  const newBaseline = store.replaceForEvidence({ reviewId: "webrev_1", evidenceId: "ev_candidate", findings: [{ ...base, comparisonId: "refcmp_2" }], source: "reference_critic" });
  assert.notEqual(newBaseline[0].id, first[0].id);
  assert.equal(newBaseline[0].status, "new");
});

test("reference critic refresh preserves deterministic and visual critic partitions", () => {
  const store = new FindingStore();
  const common = { severity: "warning", confidence: 0.8, target: null, related: null, rect: null, metrics: {} };
  store.replaceForEvidence({
    reviewId: "webrev_1",
    evidenceId: "ev_candidate",
    source: "deterministic",
    findings: [{ ...common, source: "deterministic", type: "overflow", title: "Overflow", description: "Measured overflow." }],
  });
  store.replaceForEvidence({
    reviewId: "webrev_1",
    evidenceId: "ev_candidate",
    source: "visual_critic",
    findings: [{ ...common, source: "visual_critic", type: "weak_hierarchy", title: "Weak hierarchy", description: "Perceptual issue." }],
  });
  store.replaceForEvidence({
    reviewId: "webrev_1",
    evidenceId: "ev_candidate",
    source: "reference_critic",
    findings: [{ ...common, source: "reference_critic", comparisonId: "refcmp_1", referenceEvidenceId: "ev_ref", type: "baseline_regression", title: "Baseline regression", description: "Relative issue." }],
  });

  assert.equal(store.list("ev_candidate", { source: "deterministic" }).length, 1);
  assert.equal(store.list("ev_candidate", { source: "visual_critic" }).length, 1);
  assert.equal(store.list("ev_candidate", { source: "reference_critic" }).length, 1);

  store.replaceForEvidence({
    reviewId: "webrev_1",
    evidenceId: "ev_candidate",
    source: "reference_critic",
    findings: [{ ...common, source: "reference_critic", comparisonId: "refcmp_2", referenceEvidenceId: "ev_ref_2", type: "baseline_regression", title: "New baseline regression", description: "Different baseline." }],
  });

  assert.equal(store.list("ev_candidate", { source: "deterministic" }).length, 1);
  assert.equal(store.list("ev_candidate", { source: "visual_critic" }).length, 1);
  assert.equal(store.list("ev_candidate", { source: "reference_critic" }).length, 1);
  assert.equal(store.summary("ev_candidate").reference_critic, 1);
});
