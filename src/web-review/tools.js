import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { assertSafeHttpUrl } from "./url-policy.js";

const NOAUTH = [{ type: "noauth" }];
const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
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

export function registerWebReviewTools(server, { store, evidenceStore, runner }) {
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
    description: "Open a Web Review target in real Chromium using Playwright and capture the visible viewport, DOM/geometry structure, console errors, and network failures.",
    inputSchema: {
      review_id: z.string().min(1),
      viewport: viewportSchema.optional(),
    },
    outputSchema: evidenceSummarySchema,
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
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
      const capture = await runner.capture({
        url: review.targetUrl,
        viewport: run.viewport,
      });
      const evidence = evidenceStore.put({ reviewId: review_id, runId: run.id, capture });
      store.completeRun(review_id, run.id, evidence.id);
      const summary = evidenceStore.summary(evidence.id);
      const complete = evidenceStore.get(evidence.id, { includeScreenshot: true });
      return {
        structuredContent: summary,
        content: [
          { type: "text", text: `Captured ${summary.url} at ${summary.viewport.width}x${summary.viewport.height}. Evidence ${summary.evidence_id} contains ${summary.structure_count} visible DOM/geometry records, ${summary.console_error_count} console errors, and ${summary.network_error_count} network errors.` },
          { type: "image", data: complete.screenshotBase64, mimeType: complete.screenshotMimeType },
        ],
      };
    } catch (error) {
      store.failRun(review_id, run.id, error);
      throw error;
    }
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
      structure: z.array(z.object({
        tag: z.string(),
        selector: z.string(),
        role: z.string().nullable(),
        name: z.string().nullable(),
        text: z.string().nullable(),
        rect: z.object({
          x: z.number(), y: z.number(), width: z.number(), height: z.number(),
          top: z.number(), right: z.number(), bottom: z.number(), left: z.number(),
        }),
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
