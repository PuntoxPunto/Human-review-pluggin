import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";
import { ScenarioRunStore } from "./scenario-store.js";

const NOAUTH = [{ type: "noauth" }];
const scenarioStore = new ScenarioRunStore();
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
const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), progress: z.number().min(0).max(1), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("element"), locator: locatorSchema, align: z.enum(["start", "center", "end"]).default("center"), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("measure"), locator: locatorSchema, label: z.string().max(120).optional() }),
]);
const scenarioStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), label: z.string().max(120).optional(), action: actionSchema }),
  z.object({ kind: z.literal("scroll"), label: z.string().max(120).optional(), checkpoint: checkpointSchema }),
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

function findingCounts(findings) {
  return {
    finding_count: findings.length,
    error_count: findings.filter((finding) => ["error", "critical"].includes(finding.severity)).length,
    warning_count: findings.filter((finding) => finding.severity === "warning").length,
  };
}

function storeCapture({ reviewId, runId, capture, evidenceStore, findingStore, reviewStore }) {
  const evidence = evidenceStore.put({ reviewId, runId, capture });
  const findings = findingStore.replaceForEvidence({
    reviewId,
    evidenceId: evidence.id,
    findings: analyzeGeometry(evidence),
  });
  reviewStore.recordEvidence(reviewId, evidence.id);
  return { evidence, findings, counts: findingCounts(findings) };
}

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
        const stored = storeCapture({ reviewId: review_id, runId: scrollRun.id, capture: step.capture, evidenceStore, findingStore, reviewStore });
        storedSteps.push({
          index: step.index,
          evidence_id: stored.evidence.id,
          kind: step.checkpoint.kind,
          label: step.checkpoint.label || null,
          scroll_y: step.capture.scroll.y,
          requested_progress: step.checkpoint.kind === "progress" ? step.checkpoint.progress : null,
          center_offset_px: step.result.measurement?.centerOffsetPx ?? null,
          ...stored.counts,
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

  registerAppTool(server, "run_web_scenario", {
    title: "Run deterministic Web Review scenario",
    description: "Run 1-20 already-bounded action/scroll steps in one Chromium session. Captures initial evidence and immutable evidence after every step. Exact locators remain mandatory; a failed step is captured and stops the scenario without guessing.",
    inputSchema: {
      review_id: z.string().min(1),
      name: z.string().min(1).max(160).default("Web Review scenario"),
      steps: z.array(scenarioStepSchema).min(1).max(20),
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      scenario_run_id: z.string(),
      review_id: z.string(),
      status: z.enum(["completed", "failed"]),
      initial_evidence_id: z.string(),
      latest_evidence_id: z.string(),
      completed_step_count: z.number().int(),
      failed_step_index: z.number().int().nullable(),
      error: z.string().nullable(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Running browser scenario…",
      "openai/toolInvocation/invoked": "Browser scenario captured",
    },
  }, async ({ review_id, name, steps, viewport }) => {
    const review = reviewStore.get(review_id);
    const chosenViewport = viewport || review.viewport;
    const scenarioRun = scenarioStore.start({ reviewId: review_id, name, steps, viewport: chosenViewport });
    try {
      const result = await runner.runScenario({ url: review.targetUrl, viewport: chosenViewport, steps });
      const initial = storeCapture({ reviewId: review_id, runId: scenarioRun.id, capture: result.initial, evidenceStore, findingStore, reviewStore });
      const storedSteps = [];
      for (const step of result.steps) {
        let evidenceId = null;
        let counts = { finding_count: 0, error_count: 0, warning_count: 0 };
        if (step.capture) {
          const stored = storeCapture({ reviewId: review_id, runId: scenarioRun.id, capture: step.capture, evidenceStore, findingStore, reviewStore });
          evidenceId = stored.evidence.id;
          counts = stored.counts;
        }
        storedSteps.push({
          index: step.index,
          step: step.step,
          status: step.status,
          evidence_id: evidenceId,
          result: step.result,
          error: step.error,
          ...counts,
        });
      }
      if (result.status === "completed") {
        scenarioStore.complete(scenarioRun.id, { initialEvidenceId: initial.evidence.id, steps: storedSteps });
      } else {
        scenarioStore.fail(scenarioRun.id, result.error, { initialEvidenceId: initial.evidence.id, steps: storedSteps });
      }
      const latestEvidenceId = [...storedSteps].reverse().find((step) => step.evidence_id)?.evidence_id || initial.evidence.id;
      const latest = evidenceStore.get(latestEvidenceId, { includeScreenshot: true });
      const failedStep = storedSteps.find((step) => step.status === "failed");
      const completedStepCount = storedSteps.filter((step) => step.status === "completed").length;
      return {
        structuredContent: {
          scenario_run_id: scenarioRun.id,
          review_id,
          status: result.status,
          initial_evidence_id: initial.evidence.id,
          latest_evidence_id: latestEvidenceId,
          completed_step_count: completedStepCount,
          failed_step_index: failedStep?.index ?? null,
          error: result.error,
        },
        content: [
          { type: "text", text: result.status === "completed"
            ? `Scenario ${scenarioRun.id} completed all ${storedSteps.length} deterministic steps in one Chromium session. Initial evidence: ${initial.evidence.id}. Latest evidence: ${latestEvidenceId}.`
            : `Scenario ${scenarioRun.id} stopped at step ${failedStep?.index ?? "unknown"} after ${completedStepCount} completed steps. Failure state was captured as ${latestEvidenceId}: ${result.error}` },
          { type: "image", data: latest.screenshotBase64, mimeType: latest.screenshotMimeType },
        ],
      };
    } catch (error) {
      scenarioStore.fail(scenarioRun.id, error);
      throw error;
    }
  });

  registerAppTool(server, "get_web_scenario_run", {
    title: "Read deterministic Web Review scenario run",
    description: "Read a previous scenario including requested steps, initial evidence, per-step evidence/results/errors, and the exact point of failure if the scenario stopped early.",
    inputSchema: { scenario_run_id: z.string().min(1) },
    outputSchema: {
      scenario_run_id: z.string(),
      review_id: z.string(),
      name: z.string(),
      status: z.enum(["running", "completed", "failed"]),
      viewport: viewportSchema,
      requested_steps: z.array(scenarioStepSchema),
      initial_evidence_id: z.string().nullable(),
      steps: z.array(z.object({
        index: z.number().int(),
        step: scenarioStepSchema,
        status: z.enum(["completed", "failed"]),
        evidence_id: z.string().nullable(),
        result: z.record(z.string(), z.any()).nullable(),
        error: z.string().nullable(),
        finding_count: z.number().int(),
        error_count: z.number().int(),
        warning_count: z.number().int(),
      })),
      error: z.string().nullable(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ scenario_run_id }) => {
    const run = scenarioStore.get(scenario_run_id);
    return {
      structuredContent: {
        scenario_run_id: run.id,
        review_id: run.reviewId,
        name: run.name,
        status: run.status,
        viewport: run.viewport,
        requested_steps: run.requestedSteps,
        initial_evidence_id: run.initialEvidenceId,
        steps: run.steps,
        error: run.error,
      },
      content: [{ type: "text", text: `Loaded scenario ${run.id}: ${run.status}, ${run.steps.filter((step) => step.status === "completed").length}/${run.requestedSteps.length} steps completed.` }],
    };
  });
}