import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";
import { compareEvidence } from "./reference-compare.js";
import { FixPlanStore } from "./fix-plan-store.js";

const NOAUTH = [{ type: "noauth" }];
const fixPlanStore = new FixPlanStore();

function sourceOf(finding) {
  return finding.source || "deterministic";
}

function snapshotFinding(finding) {
  const source = sourceOf(finding);
  return {
    findingId: finding.id,
    fingerprint: finding.fingerprint,
    source,
    type: finding.type,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    target: finding.target || null,
    related: finding.related || null,
    comments: finding.comments || [],
    comparisonId: finding.comparisonId || null,
    referenceEvidenceId: finding.referenceEvidenceId || null,
    verificationPolicy: source === "deterministic" ? "deterministic_recheck" : "human_recheck",
  };
}

function targetStillExists(evidence, target) {
  if (!target) return true;
  const identity = target.path || target.selector;
  if (!identity) return false;
  return evidence.structure.some((element) => element.path === identity || element.selector === identity);
}

function evaluateItem(item, postEvidence, postDeterministic) {
  if (item.verificationPolicy !== "deterministic_recheck") {
    return {
      finding_id: item.findingId,
      fingerprint: item.fingerprint,
      source: item.source,
      status: "needs_review",
      reason: "Perceptual or baseline findings require fresh multimodal/human review on post-fix evidence.",
    };
  }

  const reproduced = postDeterministic.some((finding) => finding.fingerprint === item.fingerprint);
  if (reproduced) {
    return {
      finding_id: item.findingId,
      fingerprint: item.fingerprint,
      source: item.source,
      status: "unresolved",
      reason: "The same deterministic finding fingerprint is still present in post-fix evidence.",
    };
  }

  if (!targetStillExists(postEvidence, item.target)) {
    return {
      finding_id: item.findingId,
      fingerprint: item.fingerprint,
      source: item.source,
      status: "needs_review",
      reason: "The original target no longer resolves in post-fix evidence, so disappearance cannot be treated as proof of resolution.",
    };
  }

  return {
    finding_id: item.findingId,
    fingerprint: item.fingerprint,
    source: item.source,
    status: "resolved",
    reason: "The original target still exists and the accepted deterministic finding no longer reproduces.",
  };
}

function overallStatus(results) {
  if (results.some((result) => result.status === "unresolved")) return "unresolved";
  if (results.some((result) => result.status === "needs_review")) return "needs_review";
  return "verified";
}

export function registerWebFixTools(server, { reviewStore, evidenceStore, findingStore }) {
  registerAppTool(server, "create_web_fix_plan", {
    title: "Create accepted-finding fix plan",
    description: "Freeze accepted Web Review findings from one evidence snapshot into a human-gated fix plan. Only accepted findings may enter the plan. This tool does not edit source code, deploy, merge, or claim a fix was applied.",
    inputSchema: {
      evidence_id: z.string().min(1),
      finding_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    },
    outputSchema: {
      fix_plan_id: z.string(),
      review_id: z.string(),
      evidence_id: z.string(),
      status: z.string(),
      item_count: z.number().int(),
      items: z.array(z.record(z.string(), z.any())),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Creating fix plan…",
      "openai/toolInvocation/invoked": "Fix plan created",
    },
  }, async ({ evidence_id, finding_ids }) => {
    const evidence = evidenceStore.get(evidence_id);
    reviewStore.get(evidence.reviewId);
    const allFindings = findingStore.list(evidence_id);
    let selected;
    if (finding_ids?.length) {
      const unique = [...new Set(finding_ids)];
      selected = unique.map((id) => {
        const finding = allFindings.find((item) => item.id === id);
        if (!finding) throw new Error(`Finding ${id} was not found for evidence ${evidence_id}.`);
        if (finding.status !== "accepted") throw new Error(`Finding ${id} is ${finding.status}; only accepted findings may enter a fix plan.`);
        return finding;
      });
    } else {
      selected = allFindings.filter((finding) => finding.status === "accepted");
    }
    if (!selected.length) throw new Error(`Evidence ${evidence_id} has no accepted findings to plan.`);
    const plan = fixPlanStore.create({
      reviewId: evidence.reviewId,
      evidenceId: evidence_id,
      items: selected.map(snapshotFinding),
    });
    return {
      structuredContent: {
        fix_plan_id: plan.id,
        review_id: plan.reviewId,
        evidence_id: plan.evidenceId,
        status: plan.status,
        item_count: plan.items.length,
        items: plan.items,
      },
      content: [{ type: "text", text: `Created fix plan ${plan.id} from ${plan.items.length} accepted findings. Apply changes only through an authorized external code/deploy integration, then capture fresh Web Review evidence and call record_web_fix_attempt.` }],
    };
  });

  registerAppTool(server, "get_web_fix_plan", {
    title: "Read Web Review fix plan",
    description: "Read a human-gated fix plan, its frozen accepted findings, and all verification attempts.",
    inputSchema: { fix_plan_id: z.string().min(1) },
    outputSchema: { fix_plan: z.record(z.string(), z.any()) },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ fix_plan_id }) => {
    const plan = fixPlanStore.get(fix_plan_id);
    return {
      structuredContent: { fix_plan: plan },
      content: [{ type: "text", text: `Loaded fix plan ${plan.id}: ${plan.status}, ${plan.items.length} frozen accepted findings, ${plan.attempts.length} verification attempts.` }],
    };
  });

  registerAppTool(server, "record_web_fix_attempt", {
    title: "Verify a Web Review fix attempt",
    description: "Record an externally authorized code/deploy attempt by comparing the plan's original evidence with fresh post-fix evidence. Re-runs deterministic geometry and auto-resolves only findings that can be proven absent while their original target still exists. Visual/baseline findings remain needs_review. This tool never edits code or deploys.",
    inputSchema: {
      fix_plan_id: z.string().min(1),
      post_fix_evidence_id: z.string().min(1),
      change_summary: z.string().min(1).max(4000),
      change_reference: z.string().max(2048).optional(),
    },
    outputSchema: {
      fix_plan_id: z.string(),
      attempt_id: z.string(),
      status: z.enum(["verified", "needs_review", "unresolved"]),
      base_evidence_id: z.string(),
      post_fix_evidence_id: z.string(),
      resolved_count: z.number().int(),
      unresolved_count: z.number().int(),
      needs_review_count: z.number().int(),
      results: z.array(z.record(z.string(), z.any())),
      comparison: z.record(z.string(), z.any()),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Verifying fix attempt…",
      "openai/toolInvocation/invoked": "Fix attempt verified",
    },
  }, async ({ fix_plan_id, post_fix_evidence_id, change_summary, change_reference }) => {
    const plan = fixPlanStore.get(fix_plan_id);
    const baseEvidence = evidenceStore.get(plan.evidenceId, { includeScreenshot: true });
    const postEvidence = evidenceStore.get(post_fix_evidence_id, { includeScreenshot: true });
    reviewStore.get(baseEvidence.reviewId);
    reviewStore.get(postEvidence.reviewId);
    if (postEvidence.id === baseEvidence.id) throw new Error("Post-fix evidence must be a fresh snapshot, not the plan's original evidence.");

    const comparison = compareEvidence(baseEvidence, postEvidence, { maxDeltas: 120 });
    const postDeterministic = findingStore.replaceForEvidence({
      reviewId: postEvidence.reviewId,
      evidenceId: postEvidence.id,
      findings: analyzeGeometry(postEvidence),
      source: "deterministic",
    });
    const results = plan.items.map((item) => evaluateItem(item, postEvidence, postDeterministic));
    const status = overallStatus(results);
    const resolvedCount = results.filter((item) => item.status === "resolved").length;
    const unresolvedCount = results.filter((item) => item.status === "unresolved").length;
    const needsReviewCount = results.filter((item) => item.status === "needs_review").length;
    const stored = fixPlanStore.addAttempt(fix_plan_id, {
      status,
      baseEvidenceId: baseEvidence.id,
      postFixEvidenceId: postEvidence.id,
      postFixReviewId: postEvidence.reviewId,
      changeSummary: change_summary,
      changeReference: change_reference || null,
      results,
      comparison,
    });

    return {
      structuredContent: {
        fix_plan_id,
        attempt_id: stored.attempt.id,
        status,
        base_evidence_id: baseEvidence.id,
        post_fix_evidence_id: postEvidence.id,
        resolved_count: resolvedCount,
        unresolved_count: unresolvedCount,
        needs_review_count: needsReviewCount,
        results,
        comparison,
      },
      content: [
        { type: "text", text: `Fix attempt ${stored.attempt.id}: ${resolvedCount} deterministically resolved, ${unresolvedCount} unresolved, ${needsReviewCount} require visual/human review. Status: ${status}. Original image is first; post-fix image is second.` },
        { type: "image", data: baseEvidence.screenshotBase64, mimeType: baseEvidence.screenshotMimeType },
        { type: "image", data: postEvidence.screenshotBase64, mimeType: postEvidence.screenshotMimeType },
      ],
    };
  });
}
