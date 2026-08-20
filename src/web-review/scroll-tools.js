import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";

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
const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), progress: z.number().min(0).max(1), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("element"), locator: locatorSchema, align: z.enum(["start", "center", "end"]).default("center"), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("measure"), locator: locatorSchema, label: z.string().max(120).optional() }),
]);

const stepOutputSchema = z.object({
  index: z.number().int(),
  evidence_id: z.string(),
  kind: z.enum(["progress", "element", "measure"]),
  label: z.string().nullable(),
  scroll_y: z.number(),
  requested_progress: z.number().nullable(),
  center_offset_px: z.number().nullable(),
  finding_count: z.number().int(),
  error_count: z.number().int(),
  warning_count: z.number().int(),
});

export function registerWebScrollTools(server, { reviewStore, evidenceStore, findingStore, scrollStore, runner }) {
  registerAppTool(server, "run_web_scroll_checkpoints", {
    title: "Run deterministic scroll checkpoints",
    description: "Capture 1-20 scroll checkpoints in one Chromium session. Checkpoints can sample document progress, position one exact element at start/center/end, or measure an exact element without scrolling. Every checkpoint produces immutable evidence and geometry findings.",
    inputSchema: {
      review_id: z.string().min(1),
      checkpoints: z.array(checkpointSchema).min(1).max(20),
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      scroll_run_id: z.string(),
      review_id: z.string(),
      steps: z.array(stepOutputSchema),
      latest_evidence_id: z.string(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Sampling scroll states…",
      "openai/toolInvocation/invoked": "Scroll evidence captured",
    },
  }, async ({ review_id, checkpoints, viewport }) => {
    const review = reviewStore.get(review_id);
    const chosenViewport = viewport || review.viewport;
    const scrollRun = scrollStore.start({ reviewId: review_id, checkpoints, viewport: chosenViewport });
    try {
      const captures = await runner.runScrollCheckpoints({ url: review.targetUrl, viewport: chosenViewport, checkpoints });
      const storedSteps = [];
      for (const step of captures) {
        const evidence = evidenceStore.put({ reviewId: review_id, runId: scrollRun.id, capture: step.capture });
        const findings = findingStore.replaceForEvidence({
          reviewId: review_id,
          evidenceId: evidence.id,
          findings: analyzeGeometry(evidence),
        });
        reviewStore.recordEvidence(review_id, evidence.id);
        const errorCount = findings.filter((finding) => ["error", "critical"].includes(finding.severity)).length;
        const warningCount = findings.filter((finding) => finding.severity === "warning").length;
        storedSteps.push({
          index: step.index,
          evidence_id: evidence.id,
          kind: step.checkpoint.kind,
          label: step.checkpoint.label || null,
          scroll_y: step.capture.scroll.y,
          requested_progress: step.checkpoint.kind === "progress" ? step.checkpoint.progress : null,
          center_offset_px: step.result.measurement?.centerOffsetPx ?? null,
          finding_count: findings.length,
          error_count: errorCount,
          warning_count: warningCount,
          resolved_locator: step.result.resolvedLocator || null,
        });
      }
      scrollStore.complete(scrollRun.id, storedSteps);
      const latestEvidenceId = storedSteps.at(-1).evidence_id;
      const latest = evidenceStore.get(latestEvidenceId, { includeScreenshot: true });
      return {
        structuredContent: {
          scroll_run_id: scrollRun.id,
          review_id,
          steps: storedSteps.map(({ resolved_locator, ...step }) => step),
          latest_evidence_id: latestEvidenceId,
        },
        content: [
          { type: "text", text: `Captured ${storedSteps.length} deterministic scroll checkpoints in one browser session. Latest evidence: ${latestEvidenceId}. Center offsets are reported for element/measure checkpoints.` },
          { type: "image", data: latest.screenshotBase64, mimeType: latest.screenshotMimeType },
        ],
      };
    } catch (error) {
      scrollStore.fail(scrollRun.id, error);
      throw error;
    }
  });

  registerAppTool(server, "get_web_scroll_run", {
    title: "Read Web Review scroll run",
    description: "Read the checkpoint sequence, evidence IDs, measured center offsets, and locator resolution metadata for a previous deterministic scroll review.",
    inputSchema: { scroll_run_id: z.string().min(1) },
    outputSchema: {
      scroll_run_id: z.string(),
      review_id: z.string(),
      status: z.string(),
      viewport: viewportSchema,
      checkpoints: z.array(checkpointSchema),
      steps: z.array(z.object({
        index: z.number().int(),
        evidence_id: z.string(),
        kind: z.string(),
        label: z.string().nullable(),
        scroll_y: z.number(),
        requested_progress: z.number().nullable(),
        center_offset_px: z.number().nullable(),
        finding_count: z.number().int(),
        error_count: z.number().int(),
        warning_count: z.number().int(),
        resolved_locator: z.record(z.string(), z.any()).nullable(),
      })),
      error: z.string().nullable(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ scroll_run_id }) => {
    const run = scrollStore.get(scroll_run_id);
    return {
      structuredContent: {
        scroll_run_id: run.id,
        review_id: run.reviewId,
        status: run.status,
        viewport: run.viewport,
        checkpoints: run.checkpoints,
        steps: run.steps,
        error: run.error,
      },
      content: [{ type: "text", text: `Loaded scroll run ${run.id}: ${run.status}, ${run.steps.length} captured checkpoints.` }],
    };
  });
}