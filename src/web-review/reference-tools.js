import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";
import { compareEvidence } from "./reference-compare.js";
import { ReferenceComparisonStore } from "./reference-store.js";

const NOAUTH = [{ type: "noauth" }];
const comparisonStore = new ReferenceComparisonStore();
const rectSchema = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  top: z.number(), right: z.number(), bottom: z.number(), left: z.number(),
});
const proposalSchema = z.object({
  type: z.string().regex(/^[a-z0-9_\-]+$/).min(1).max(80),
  severity: z.enum(["info", "warning", "error"]),
  confidence: z.number().min(0).max(0.9),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1200),
  target_path: z.string().min(1).max(1200).nullable().optional(),
});

function targetFromElement(element) {
  if (!element) return null;
  return {
    selector: element.selector,
    path: element.path,
    tag: element.tag,
    name: element.name || null,
    rect: element.rect,
  };
}

function resolveCandidateTarget(evidence, requestedPath) {
  if (!requestedPath) return null;
  const matches = evidence.structure.filter((element) => element.path === requestedPath || element.selector === requestedPath);
  if (matches.length !== 1) {
    throw new Error(`target_path must resolve exactly one element in candidate evidence ${evidence.id}; matched ${matches.length}.`);
  }
  return targetFromElement(matches[0]);
}

function buildReferenceFinding(comparison, candidateEvidence, proposal) {
  const target = resolveCandidateTarget(candidateEvidence, proposal.target_path);
  return {
    source: "reference_critic",
    comparisonId: comparison.id,
    referenceEvidenceId: comparison.referenceEvidenceId,
    type: proposal.type,
    severity: proposal.severity,
    confidence: Math.min(0.9, proposal.confidence),
    title: proposal.title,
    description: proposal.description,
    target,
    related: null,
    rect: target?.rect || null,
    metrics: {},
  };
}

function summary(comparison) {
  const { result } = comparison;
  return {
    comparison_id: comparison.id,
    reference_evidence_id: comparison.referenceEvidenceId,
    candidate_evidence_id: comparison.candidateEvidenceId,
    reference_review_id: comparison.referenceReviewId,
    candidate_review_id: comparison.candidateReviewId,
    viewport: result.viewport,
    metrics: result.metrics,
    added: result.added,
    removed: result.removed,
    changed: result.changed,
  };
}

export function registerWebReferenceTools(server, { reviewStore, evidenceStore, findingStore }) {
  registerAppTool(server, "compare_web_evidence", {
    title: "Compare candidate evidence to baseline",
    description: "Compare two immutable Web Review evidence snapshots at the same viewport. Computes deterministic DOM/geometry/text deltas and returns both screenshots for multimodal baseline inspection. A difference is not automatically a regression.",
    inputSchema: {
      reference_evidence_id: z.string().min(1),
      candidate_evidence_id: z.string().min(1),
      max_deltas: z.number().int().min(1).max(200).default(80),
    },
    outputSchema: {
      comparison_id: z.string(),
      reference_evidence_id: z.string(),
      candidate_evidence_id: z.string(),
      reference_review_id: z.string(),
      candidate_review_id: z.string(),
      viewport: z.object({ width: z.number(), height: z.number() }),
      metrics: z.object({
        matched: z.number().int(),
        added: z.number().int(),
        removed: z.number().int(),
        changed: z.number().int(),
        scroll_dx: z.number(),
        scroll_dy: z.number(),
        document_width_delta: z.number(),
        document_height_delta: z.number(),
      }),
      added: z.array(z.record(z.string(), z.any())),
      removed: z.array(z.record(z.string(), z.any())),
      changed: z.array(z.record(z.string(), z.any())),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Comparing evidence…",
      "openai/toolInvocation/invoked": "Evidence comparison ready",
    },
  }, async ({ reference_evidence_id, candidate_evidence_id, max_deltas }) => {
    if (reference_evidence_id === candidate_evidence_id) throw new Error("Reference and candidate evidence must be different snapshots.");
    const reference = evidenceStore.get(reference_evidence_id, { includeScreenshot: true });
    const candidate = evidenceStore.get(candidate_evidence_id, { includeScreenshot: true });
    reviewStore.get(reference.reviewId);
    reviewStore.get(candidate.reviewId);
    const result = compareEvidence(reference, candidate, { maxDeltas: max_deltas });
    const comparison = comparisonStore.put({ referenceEvidenceId: reference.id, candidateEvidenceId: candidate.id, result });
    return {
      structuredContent: summary(comparison),
      content: [
        { type: "text", text: `Baseline comparison ${comparison.id}: ${result.metrics.changed} matched elements changed, ${result.metrics.added} added, ${result.metrics.removed} removed. Differences are evidence, not automatic regressions. Inspect the reference image first and candidate image second.` },
        { type: "image", data: reference.screenshotBase64, mimeType: reference.screenshotMimeType },
        { type: "image", data: candidate.screenshotBase64, mimeType: candidate.screenshotMimeType },
      ],
    };
  });

  registerAppTool(server, "get_web_reference_comparison", {
    title: "Read baseline comparison",
    description: "Read a stored deterministic baseline comparison and return the reference/candidate screenshots again for multimodal inspection.",
    inputSchema: { comparison_id: z.string().min(1) },
    outputSchema: {
      comparison_id: z.string(),
      reference_evidence_id: z.string(),
      candidate_evidence_id: z.string(),
      reference_review_id: z.string(),
      candidate_review_id: z.string(),
      viewport: z.object({ width: z.number(), height: z.number() }),
      metrics: z.record(z.string(), z.number()),
      added: z.array(z.record(z.string(), z.any())),
      removed: z.array(z.record(z.string(), z.any())),
      changed: z.array(z.record(z.string(), z.any())),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ comparison_id }) => {
    const comparison = comparisonStore.get(comparison_id);
    const reference = evidenceStore.get(comparison.referenceEvidenceId, { includeScreenshot: true });
    const candidate = evidenceStore.get(comparison.candidateEvidenceId, { includeScreenshot: true });
    return {
      structuredContent: summary(comparison),
      content: [
        { type: "text", text: `Loaded baseline comparison ${comparison.id}. Reference image is first; candidate image is second.` },
        { type: "image", data: reference.screenshotBase64, mimeType: reference.screenshotMimeType },
        { type: "image", data: candidate.screenshotBase64, mimeType: candidate.screenshotMimeType },
      ],
    };
  });

  registerAppTool(server, "submit_web_reference_findings", {
    title: "Submit baseline regression findings",
    description: "Store ChatGPT's multimodal interpretation of one baseline comparison as lower-trust reference_critic findings on the candidate evidence. Replaces only the candidate's active reference_critic partition; deterministic and absolute visual findings are preserved. Human accept/reject is still required before implementation.",
    inputSchema: {
      comparison_id: z.string().min(1),
      findings: z.array(proposalSchema).max(40),
    },
    outputSchema: {
      comparison_id: z.string(),
      candidate_evidence_id: z.string(),
      reference_evidence_id: z.string(),
      finding_count: z.number().int(),
      findings: z.array(z.record(z.string(), z.any())),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Saving baseline critique…",
      "openai/toolInvocation/invoked": "Baseline critique saved",
    },
  }, async ({ comparison_id, findings }) => {
    const comparison = comparisonStore.get(comparison_id);
    const candidate = evidenceStore.get(comparison.candidateEvidenceId);
    reviewStore.get(candidate.reviewId);
    if (!findingStore.list(candidate.id, { source: "deterministic" }).length) {
      findingStore.replaceForEvidence({ reviewId: candidate.reviewId, evidenceId: candidate.id, findings: analyzeGeometry(candidate), source: "deterministic" });
    }
    const normalized = findings.map((proposal) => buildReferenceFinding(comparison, candidate, proposal));
    const stored = findingStore.replaceForEvidence({
      reviewId: candidate.reviewId,
      evidenceId: candidate.id,
      findings: normalized,
      source: "reference_critic",
    });
    return {
      structuredContent: {
        comparison_id,
        candidate_evidence_id: candidate.id,
        reference_evidence_id: comparison.referenceEvidenceId,
        finding_count: stored.length,
        findings: stored,
      },
      content: [{ type: "text", text: `Stored ${stored.length} baseline-regression proposals on candidate evidence ${candidate.id}. They require human acceptance before implementation.` }],
    };
  });
}
