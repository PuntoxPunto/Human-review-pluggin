import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";
import { registerWebRecoveryTools } from "./recovery-tools.js";

const NOAUTH = [{ type: "noauth" }];
const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
});
const locatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1).max(80), name: z.string().min(1).max(300), exact: z.boolean().default(true) }),
  z.object({ strategy: z.literal("text"), text: z.string().min(1).max(500), exact: z.boolean().default(true) }),
  z.object({ strategy: z.literal("css"), selector: z.string().min(1).max(1000) }),
]);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), locator: locatorSchema }),
  z.object({ type: z.literal("fill"), locator: locatorSchema, value: z.string().max(10_000) }),
  z.object({ type: z.literal("scroll_into_view"), locator: locatorSchema }),
]);

export function registerWebActionTools(server, { reviewStore, evidenceStore, findingStore, actionStore, runner }) {
  registerAppTool(server, "run_web_action", {
    title: "Run deterministic web action",
    description: "Execute one bounded Playwright action using an exact deterministic locator. The locator must match exactly one element. Captures immutable evidence immediately before and after the action.",
    inputSchema: {
      review_id: z.string().min(1),
      action: actionSchema,
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      action_run_id: z.string(),
      review_id: z.string(),
      before_evidence_id: z.string(),
      after_evidence_id: z.string(),
      final_url: z.string(),
      resolved_locator: z.record(z.string(), z.any()),
      finding_count: z.number().int(),
      error_count: z.number().int(),
      warning_count: z.number().int(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Running browser action…",
      "openai/toolInvocation/invoked": "Browser action complete",
    },
  }, async ({ review_id, action, viewport }) => {
    const review = reviewStore.get(review_id);
    const chosenViewport = viewport || review.viewport;
    const actionRun = actionStore.start({ reviewId: review_id, action, viewport: chosenViewport });
    try {
      const result = await runner.runAction({ url: review.targetUrl, viewport: chosenViewport, action });
      const before = evidenceStore.put({ reviewId: review_id, runId: actionRun.id, capture: result.before });
      const after = evidenceStore.put({ reviewId: review_id, runId: actionRun.id, capture: result.after });
      const findings = findingStore.replaceForEvidence({
        reviewId: review_id,
        evidenceId: after.id,
        findings: analyzeGeometry(after),
      });
      actionStore.complete(actionRun.id, {
        beforeEvidenceId: before.id,
        afterEvidenceId: after.id,
        resolvedLocator: result.resolvedLocator,
      });
      reviewStore.recordEvidence(review_id, after.id);
      const errorCount = findings.filter((finding) => ["error", "critical"].includes(finding.severity)).length;
      const warningCount = findings.filter((finding) => finding.severity === "warning").length;
      const completeAfter = evidenceStore.get(after.id, { includeScreenshot: true });
      return {
        structuredContent: {
          action_run_id: actionRun.id,
          review_id,
          before_evidence_id: before.id,
          after_evidence_id: after.id,
          final_url: completeAfter.finalUrl,
          resolved_locator: result.resolvedLocator,
          finding_count: findings.length,
          error_count: errorCount,
          warning_count: warningCount,
        },
        content: [
          { type: "text", text: `Action ${action.type} completed with exact deterministic locator. Before evidence: ${before.id}. After evidence: ${after.id}. The after state has ${findings.length} geometry findings. Call open_web_review with ${after.id} to inspect it.` },
          { type: "image", data: completeAfter.screenshotBase64, mimeType: completeAfter.screenshotMimeType },
        ],
      };
    } catch (error) {
      actionStore.fail(actionRun.id, error);
      throw error;
    }
  });

  registerAppTool(server, "get_web_action_run", {
    title: "Read deterministic web action run",
    description: "Read the action, exact resolved locator, before/after evidence IDs, and status for a previous deterministic Web Review action run.",
    inputSchema: { action_run_id: z.string().min(1) },
    outputSchema: {
      action_run_id: z.string(),
      review_id: z.string(),
      status: z.string(),
      action: actionSchema,
      viewport: viewportSchema,
      before_evidence_id: z.string().nullable(),
      after_evidence_id: z.string().nullable(),
      resolved_locator: z.record(z.string(), z.any()).nullable(),
      error: z.string().nullable(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ action_run_id }) => {
    const run = actionStore.get(action_run_id);
    return {
      structuredContent: {
        action_run_id: run.id,
        review_id: run.reviewId,
        status: run.status,
        action: run.action,
        viewport: run.viewport,
        before_evidence_id: run.beforeEvidenceId,
        after_evidence_id: run.afterEvidenceId,
        resolved_locator: run.resolvedLocator,
        error: run.error,
      },
      content: [{ type: "text", text: `Loaded action run ${run.id}: ${run.status}.` }],
    };
  });

  registerWebRecoveryTools(server, { reviewStore, evidenceStore, findingStore, runner });
}