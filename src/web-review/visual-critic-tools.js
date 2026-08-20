import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const NOAUTH = [{ type: "noauth" }];
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
  related_path: z.string().min(1).max(1200).nullable().optional(),
});
const targetOutputSchema = z.object({
  selector: z.string(),
  path: z.string(),
  tag: z.string(),
  name: z.string().nullable(),
  rect: rectSchema,
}).nullable();
const visualFindingSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  source: z.literal("visual_critic"),
  type: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  confidence: z.number().max(0.9),
  title: z.string(),
  description: z.string(),
  target: targetOutputSchema,
  related: targetOutputSchema,
  rect: rectSchema.nullable(),
  metrics: z.record(z.string(), z.number()),
  status: z.enum(["new", "accepted", "rejected"]),
  comments: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string() })),
  decidedAt: z.string().nullable(),
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

function resolveEvidenceTarget(evidence, requestedPath, fieldName) {
  if (!requestedPath) return null;
  const matches = evidence.structure.filter((element) => element.path === requestedPath || element.selector === requestedPath);
  if (matches.length !== 1) {
    throw new Error(`${fieldName} must resolve exactly one element in evidence ${evidence.id}; matched ${matches.length}.`);
  }
  return targetFromElement(matches[0]);
}

function buildVisualFinding(evidence, proposal) {
  const target = resolveEvidenceTarget(evidence, proposal.target_path, "target_path");
  const related = resolveEvidenceTarget(evidence, proposal.related_path, "related_path");
  return {
    source: "visual_critic",
    type: proposal.type,
    severity: proposal.severity,
    confidence: Math.min(0.9, proposal.confidence),
    title: proposal.title,
    description: proposal.description,
    target,
    related,
    rect: target?.rect || null,
    metrics: {},
  };
}

export function registerWebVisualCriticTools(server, { reviewStore, evidenceStore, findingStore }) {
  registerAppTool(server, "get_web_visual_critic_context", {
    title: "Inspect evidence for visual critique",
    description: "Return one immutable Playwright screenshot and compact evidence context for multimodal visual critique. Inspect the image yourself, distinguish observed visual issues from deterministic geometry, then call submit_web_visual_findings with only evidence-grounded proposals.",
    inputSchema: { evidence_id: z.string().min(1) },
    outputSchema: {
      evidence_id: z.string(),
      review_id: z.string(),
      final_url: z.string(),
      viewport: z.object({ width: z.number(), height: z.number() }),
      scroll: z.object({ x: z.number(), y: z.number() }),
      deterministic_finding_count: z.number().int(),
      existing_visual_finding_count: z.number().int(),
      visible_elements: z.array(z.object({
        path: z.string(),
        selector: z.string(),
        tag: z.string(),
        role: z.string().nullable(),
        name: z.string().nullable(),
        text: z.string().nullable(),
        rect: rectSchema,
      })),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ evidence_id }) => {
    const evidence = evidenceStore.get(evidence_id, { includeScreenshot: true });
    reviewStore.get(evidence.reviewId);
    const deterministic = findingStore.list(evidence_id, { source: "deterministic" });
    const visual = findingStore.list(evidence_id, { source: "visual_critic" });
    return {
      structuredContent: {
        evidence_id,
        review_id: evidence.reviewId,
        final_url: evidence.finalUrl,
        viewport: evidence.viewport,
        scroll: evidence.scroll,
        deterministic_finding_count: deterministic.length,
        existing_visual_finding_count: visual.length,
        visible_elements: evidence.structure.slice(0, 120).map((element) => ({
          path: element.path,
          selector: element.selector,
          tag: element.tag,
          role: element.role,
          name: element.name,
          text: element.text,
          rect: element.rect,
        })),
      },
      content: [
        { type: "text", text: `Inspect immutable evidence ${evidence_id} visually. Geometry already has ${deterministic.length} deterministic findings; do not duplicate them unless the screenshot reveals a distinct perceptual problem. Visual proposals are lower-trust and require human accept/reject before implementation.` },
        { type: "image", data: evidence.screenshotBase64, mimeType: evidence.screenshotMimeType },
      ],
    };
  });

  registerAppTool(server, "submit_web_visual_findings", {
    title: "Submit visual critic findings",
    description: "Store multimodal visual-critic proposals for one immutable evidence snapshot. Replaces only the visual_critic partition, never deterministic findings. Optional target/related paths must resolve exactly one element in that evidence. Visual findings cannot be critical and confidence is capped at 0.90. Existing human decisions/comments on matching visual findings are preserved.",
    inputSchema: {
      evidence_id: z.string().min(1),
      findings: z.array(proposalSchema).max(40),
    },
    outputSchema: {
      evidence_id: z.string(),
      review_id: z.string(),
      visual_finding_count: z.number().int(),
      findings: z.array(visualFindingSchema),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Saving visual critique…",
      "openai/toolInvocation/invoked": "Visual critique saved",
    },
  }, async ({ evidence_id, findings }) => {
    const evidence = evidenceStore.get(evidence_id);
    reviewStore.get(evidence.reviewId);
    const normalized = findings.map((proposal) => buildVisualFinding(evidence, proposal));
    const stored = findingStore.replaceForEvidence({
      reviewId: evidence.reviewId,
      evidenceId: evidence_id,
      findings: normalized,
      source: "visual_critic",
    });
    return {
      structuredContent: {
        evidence_id,
        review_id: evidence.reviewId,
        visual_finding_count: stored.length,
        findings: stored,
      },
      content: [{ type: "text", text: `Stored ${stored.length} visual-critic proposals for ${evidence_id}. They remain lower-trust findings and require human accept/reject before becoming implementation tasks.` }],
    };
  });
}