import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { assertSafeHttpUrl } from "./url-policy.js";
import { analyzeGeometry } from "./geometry.js";
import { WEB_REVIEW_TEMPLATE_URI } from "./ui.js";

const NOAUTH = [{ type: "noauth" }];
const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
});
const rectSchema = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  top: z.number(), right: z.number(), bottom: z.number(), left: z.number(),
});
const targetSchema = z.object({
  selector: z.string(),
  path: z.string(),
  tag: z.string(),
  name: z.string().nullable(),
  rect: rectSchema,
}).nullable();
const findingSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.enum(["info", "warning", "error", "critical"]),
  confidence: z.number(),
  title: z.string(),
  description: z.string(),
  target: targetSchema,
  related: targetSchema,
  rect: rectSchema.nullable(),
  metrics: z.record(z.string(), z.number()),
  status: z.string(),
});

const evidenceSummarySchema = {
  evidence_id: z.string(),
  review_id: z.string(),
  run_id: z.string(),
  url: z.string(),
  title: z.string(),
  viewport: viewportSchema,
  scroll: z.object({ x: z.number(), y: z.number() }),
  structure_count: z.number().int(),
  console_error_count: z.number().int(),
  network_error_count: z.number().int(),
};

function findingCounts(findings) {
  const counts = { total: findings.length, info: 0, warning: 0, error: 0, critical: 0 };
  for (const finding of findings) {
    if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

export function registerWebReviewTools(server, { store, evidenceStore, findingStore, runner }) {
  registerAppTool(server, "create_web_review", {
    title: "Create live web review",
    description: "Create a review session for a public live/staging URL. Use capture_web_review next to observe the page with Playwright.",
    inputSchema: {
      title: z.string().min(1).max(160),
      url: z.string().url().max(2048),
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      review_id: z.string(),
      title: z.string(),
      status: z.string(),
      url: z.string(),
      viewport: viewportSchema,
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Creating web review…",
      "openai/toolInvocation/invoked": "Web review created",
    },
  }, async ({ title, url, viewport }) => {
    const safeUrl = await assertSafeHttpUrl(url);
    const review = store.create({ title, url: safeUrl, viewport });
    return {
      structuredContent: {
        review_id: review.id,
        title: review.title,
        status: review.status,
        url: review.targetUrl,
        viewport: review.viewport,
      },
      content: [{ type: "text", text: `Created Web Review ${review.id} for ${review.targetUrl}. Call capture_web_review to collect browser evidence.` }],
    };
  });

  registerAppTool(server, "capture_web_review", {
    title: "Capture live browser evidence",
    description: "Open a Web Review target in real Chromium, capture screenshot and DOM/geometry evidence, then run deterministic geometry checks. Call open_web_review next to inspect the capture in the cockpit.",
    inputSchema: {
      review_id: z.string().min(1),
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      ...evidenceSummarySchema,
      finding_count: z.number().int(),
      error_count: z.number().int(),
      warning_count: z.number().int(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Inspecting live page…",
      "openai/toolInvocation/invoked": "Browser evidence captured",
    },
  }, async ({ review_id, viewport }) => {
    const review = store.get(review_id);
    const run = store.beginRun(review_id, { viewport });
    try {
      const capture = await runner.capture({ url: review.targetUrl, viewport: run.viewport });
      const evidence = evidenceStore.put({ reviewId: review_id, runId: run.id, capture });
      const findings = findingStore.replaceForEvidence({
        reviewId: review_id,
        evidenceId: evidence.id,
        findings: analyzeGeometry(evidence),
      });
      store.completeRun(review_id, run.id, evidence.id);
      const summary = evidenceStore.summary(evidence.id);
      const counts = findingCounts(findings);
      const complete = evidenceStore.get(evidence.id, { includeScreenshot: true });
      return {
        structuredContent: {
          ...summary,
          finding_count: counts.total,
          error_count: counts.error + counts.critical,
          warning_count: counts.warning,
        },
        content: [
          { type: "text", text: `Captured ${summary.url} at ${summary.viewport.width}x${summary.viewport.height}. Evidence ${summary.evidence_id} has ${counts.total} deterministic geometry findings (${counts.error + counts.critical} errors, ${counts.warning} warnings). Call open_web_review to inspect the annotated screenshot.` },
          { type: "image", data: complete.screenshotBase64, mimeType: complete.screenshotMimeType },
        ],
      };
    } catch (error) {
      store.failRun(review_id, run.id, error);
      throw error;
    }
  });

  registerAppTool(server, "analyze_web_geometry", {
    title: "Analyze web geometry",
    description: "Re-run deterministic overflow, clipping, and candidate-overlap analysis for a previously captured Web Review evidence snapshot.",
    inputSchema: { evidence_id: z.string().min(1) },
    outputSchema: {
      evidence_id: z.string(),
      review_id: z.string(),
      total: z.number().int(),
      info: z.number().int(),
      warning: z.number().int(),
      error: z.number().int(),
      critical: z.number().int(),
      findings: z.array(findingSchema),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ evidence_id }) => {
    const evidence = evidenceStore.get(evidence_id);
    const findings = findingStore.replaceForEvidence({
      reviewId: evidence.reviewId,
      evidenceId: evidence.id,
      findings: analyzeGeometry(evidence),
    });
    const counts = findingCounts(findings);
    return {
      structuredContent: { evidence_id, review_id: evidence.reviewId, ...counts, findings },
      content: [{ type: "text", text: `Geometry analysis produced ${counts.total} findings: ${counts.error + counts.critical} errors, ${counts.warning} warnings, ${counts.info} informational candidates.` }],
    };
  });

  registerAppTool(server, "open_web_review", {
    title: "Open Web Review cockpit",
    description: "Render the latest or selected Web Review evidence snapshot in the QA cockpit with deterministic findings overlaid on the Playwright screenshot.",
    inputSchema: {
      review_id: z.string().min(1),
      evidence_id: z.string().min(1).optional(),
    },
    outputSchema: {
      review_id: z.string(),
      evidence_id: z.string(),
      title: z.string(),
      status: z.string(),
      finding_count: z.number().int(),
      error_count: z.number().int(),
      warning_count: z.number().int(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { resourceUri: WEB_REVIEW_TEMPLATE_URI, visibility: ["model"] },
      "openai/outputTemplate": WEB_REVIEW_TEMPLATE_URI,
      "openai/toolInvocation/invoking": "Opening Web Review…",
      "openai/toolInvocation/invoked": "Web Review ready",
    },
  }, async ({ review_id, evidence_id }) => {
    const review = store.get(review_id);
    const selectedEvidenceId = evidence_id || review.evidenceIds.at(-1);
    if (!selectedEvidenceId) throw new Error(`Web Review ${review_id} has no captured evidence yet. Call capture_web_review first.`);
    const evidence = evidenceStore.get(selectedEvidenceId, { includeScreenshot: true });
    if (evidence.reviewId !== review_id) throw new Error(`Evidence ${selectedEvidenceId} does not belong to Web Review ${review_id}.`);
    let findings = findingStore.list(selectedEvidenceId);
    if (!findings.length) {
      findings = findingStore.replaceForEvidence({
        reviewId: review_id,
        evidenceId: selectedEvidenceId,
        findings: analyzeGeometry(evidence),
      });
    }
    const counts = findingCounts(findings);
    return {
      structuredContent: {
        review_id,
        evidence_id: selectedEvidenceId,
        title: review.title,
        status: review.status,
        finding_count: counts.total,
        error_count: counts.error + counts.critical,
        warning_count: counts.warning,
      },
      content: [{ type: "text", text: `Opened ${review.title} evidence ${selectedEvidenceId} with ${counts.total} deterministic findings.` }],
      _meta: {
        web_review: {
          review: { id: review.id, title: review.title, targetUrl: review.targetUrl, status: review.status },
          evidence,
          findings,
        },
      },
    };
  });

  registerAppTool(server, "get_web_evidence", {
    title: "Read browser evidence",
    description: "Read structured evidence from a previous Web Review capture. Returns visible DOM and geometry records plus browser errors; optionally returns the screenshot again.",
    inputSchema: {
      evidence_id: z.string().min(1),
      max_elements: z.number().int().min(1).max(200).default(80),
      include_screenshot: z.boolean().default(true),
    },
    outputSchema: {
      ...evidenceSummarySchema,
      document: z.object({
        scrollWidth: z.number(), scrollHeight: z.number(), clientWidth: z.number(), clientHeight: z.number(),
      }),
      structure: z.array(z.object({
        tag: z.string(),
        selector: z.string(),
        path: z.string(),
        parentPath: z.string().nullable(),
        role: z.string().nullable(),
        name: z.string().nullable(),
        text: z.string().nullable(),
        rect: rectSchema,
        position: z.string(),
        zIndex: z.string(),
        overflowX: z.string(),
        overflowY: z.string(),
      })),
      console_errors: z.array(z.string()),
      network_errors: z.array(z.object({ url: z.string(), error: z.string() })),
      truncated: z.boolean(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ evidence_id, max_elements, include_screenshot }) => {
    const evidence = evidenceStore.get(evidence_id, { includeScreenshot: include_screenshot });
    const summary = evidenceStore.summary(evidence_id);
    const structure = evidence.structure.slice(0, max_elements);
    const structuredContent = {
      ...summary,
      document: evidence.document,
      structure,
      console_errors: evidence.consoleErrors,
      network_errors: evidence.networkErrors,
      truncated: evidence.structure.length > structure.length,
    };
    const content = [{ type: "text", text: `Loaded evidence ${evidence_id}. Showing ${structure.length} of ${evidence.structure.length} visible elements.` }];
    if (include_screenshot && evidence.screenshotBase64) {
      content.push({ type: "image", data: evidence.screenshotBase64, mimeType: evidence.screenshotMimeType });
    }
    return { structuredContent, content };
  });
}
