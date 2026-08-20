import { randomUUID } from "node:crypto";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { analyzeGeometry } from "./geometry.js";
import { buildRecoveryCandidates } from "./recovery.js";
import { RecoveryRecipeStore } from "./recovery-store.js";

const NOAUTH = [{ type: "noauth" }];
const recipeStore = new RecoveryRecipeStore();
const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
});
const locatorSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1).max(80), name: z.string().min(1).max(300), exact: z.boolean().default(true) }),
  z.object({ strategy: z.literal("text"), text: z.string().min(1).max(500), exact: z.boolean().default(true) }),
  z.object({ strategy: z.literal("css"), selector: z.string().min(1).max(1000) }),
]);
const locatorOptionSchema = z.union([
  z.object({ strategy: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean() }),
  z.object({ strategy: z.literal("text"), text: z.string(), exact: z.boolean() }),
  z.object({ strategy: z.literal("css"), selector: z.string() }),
]);
const candidateSchema = z.object({
  rank: z.number().int(),
  score: z.number(),
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  selector: z.string(),
  path: z.string(),
  rect: z.record(z.string(), z.number()),
  locator_options: z.array(locatorOptionSchema),
});
const recipeSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  reviewId: z.string(),
  targetUrl: z.string(),
  targetHint: z.string(),
  failedLocator: locatorSchema.nullable(),
  verifiedLocator: locatorSchema,
  resolvedLocator: z.record(z.string(), z.any()),
  evidenceId: z.string(),
  verificationCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function parseMatchCount(error) {
  const match = String(error?.message || error || "").match(/matched (\d+)/i);
  return match ? Number(match[1]) : null;
}

function storeEvidence({ reviewId, runId, capture, evidenceStore, findingStore, reviewStore }) {
  const evidence = evidenceStore.put({ reviewId, runId, capture });
  const findings = findingStore.replaceForEvidence({
    reviewId,
    evidenceId: evidence.id,
    findings: analyzeGeometry(evidence),
  });
  reviewStore.recordEvidence(reviewId, evidence.id);
  return { evidence, findings };
}

export function registerWebRecoveryTools(server, { reviewStore, evidenceStore, findingStore, runner }) {
  registerAppTool(server, "get_web_locator_recovery_context", {
    title: "Build locator recovery context",
    description: "Read one immutable evidence snapshot and return a compact ranked shortlist of visible DOM candidates plus deterministic locator options. ChatGPT may use this semantic context to propose a candidate, but no candidate is trusted until verify_web_locator_recovery proves exactly one Playwright match.",
    inputSchema: {
      evidence_id: z.string().min(1),
      target_hint: z.string().min(1).max(500),
      max_candidates: z.number().int().min(1).max(30).default(12),
    },
    outputSchema: {
      evidence_id: z.string(),
      review_id: z.string(),
      final_url: z.string(),
      target_hint: z.string(),
      candidates: z.array(candidateSchema),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ evidence_id, target_hint, max_candidates }) => {
    const evidence = evidenceStore.get(evidence_id, { includeScreenshot: true });
    const candidates = buildRecoveryCandidates(evidence, target_hint, max_candidates);
    return {
      structuredContent: {
        evidence_id,
        review_id: evidence.reviewId,
        final_url: evidence.finalUrl,
        target_hint,
        candidates,
      },
      content: [
        { type: "text", text: `Recovery context for ${target_hint}: ${candidates.length} visible candidates ranked from immutable evidence ${evidence_id}. Select or refine a deterministic locator, then call verify_web_locator_recovery; do not execute an unverified locator.` },
        { type: "image", data: evidence.screenshotBase64, mimeType: evidence.screenshotMimeType },
      ],
    };
  });

  registerAppTool(server, "verify_web_locator_recovery", {
    title: "Verify locator recovery candidate",
    description: "Verify a proposed locator in real Chromium without clicking or filling. Verification uses the bounded scroll_into_view primitive, requires exactly one match, captures evidence, and saves a reusable recipe only when verification succeeds.",
    inputSchema: {
      review_id: z.string().min(1),
      candidate_locator: locatorSchema,
      failed_locator: locatorSchema.nullable().optional(),
      target_hint: z.string().max(500).default(""),
      save_recipe: z.boolean().default(true),
      viewport: viewportSchema.optional(),
    },
    outputSchema: {
      review_id: z.string(),
      verified: z.boolean(),
      match_count: z.number().int().nullable(),
      evidence_id: z.string(),
      before_evidence_id: z.string().nullable(),
      resolved_locator: z.record(z.string(), z.any()).nullable(),
      recipe_id: z.string().nullable(),
      error: z.string().nullable(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Verifying locator candidate…",
      "openai/toolInvocation/invoked": "Locator candidate verified",
    },
  }, async ({ review_id, candidate_locator, failed_locator, target_hint, save_recipe, viewport }) => {
    const review = reviewStore.get(review_id);
    const chosenViewport = viewport || review.viewport;
    const recoveryRunId = `recoveryrun_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    try {
      const result = await runner.runAction({
        url: review.targetUrl,
        viewport: chosenViewport,
        action: { type: "scroll_into_view", locator: candidate_locator },
      });
      const before = evidenceStore.put({ reviewId: review_id, runId: recoveryRunId, capture: result.before });
      const stored = storeEvidence({ reviewId: review_id, runId: recoveryRunId, capture: result.after, evidenceStore, findingStore, reviewStore });
      const recipe = save_recipe ? recipeStore.save({
        reviewId: review_id,
        targetUrl: review.targetUrl,
        targetHint: target_hint,
        failedLocator: failed_locator || null,
        verifiedLocator: candidate_locator,
        resolvedLocator: result.resolvedLocator,
        evidenceId: stored.evidence.id,
      }) : null;
      const complete = evidenceStore.get(stored.evidence.id, { includeScreenshot: true });
      return {
        structuredContent: {
          review_id,
          verified: true,
          match_count: 1,
          evidence_id: stored.evidence.id,
          before_evidence_id: before.id,
          resolved_locator: result.resolvedLocator,
          recipe_id: recipe?.id || null,
          error: null,
        },
        content: [
          { type: "text", text: `Verified exactly one element for the proposed locator. Evidence: ${stored.evidence.id}.${recipe ? ` Saved recipe ${recipe.id}.` : ""} Use the verified locator for the bounded action; the verification itself did not click or fill.` },
          { type: "image", data: complete.screenshotBase64, mimeType: complete.screenshotMimeType },
        ],
      };
    } catch (error) {
      const capture = await runner.capture({ url: review.targetUrl, viewport: chosenViewport });
      const stored = storeEvidence({ reviewId: review_id, runId: recoveryRunId, capture, evidenceStore, findingStore, reviewStore });
      const complete = evidenceStore.get(stored.evidence.id, { includeScreenshot: true });
      const message = String(error?.message || error || "Locator verification failed").slice(0, 2000);
      return {
        structuredContent: {
          review_id,
          verified: false,
          match_count: parseMatchCount(error),
          evidence_id: stored.evidence.id,
          before_evidence_id: null,
          resolved_locator: null,
          recipe_id: null,
          error: message,
        },
        content: [
          { type: "text", text: `Locator candidate was not verified and was not saved: ${message}. Evidence ${stored.evidence.id} captures the fresh verification page state. Build/refine recovery context before proposing another locator.` },
          { type: "image", data: complete.screenshotBase64, mimeType: complete.screenshotMimeType },
        ],
      };
    }
  });

  registerAppTool(server, "get_web_locator_recipes", {
    title: "Read verified locator recipes",
    description: "Read locator recovery recipes for one Web Review. Every recipe was previously proven to match exactly one element in Chromium; recipes are evidence-backed hints, not permission to bypass deterministic verification when page state or markup changed.",
    inputSchema: { review_id: z.string().min(1) },
    outputSchema: {
      review_id: z.string(),
      recipes: z.array(recipeSchema),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { securitySchemes: NOAUTH, ui: { visibility: ["model"] } },
  }, async ({ review_id }) => {
    reviewStore.get(review_id);
    const recipes = recipeStore.list(review_id);
    return {
      structuredContent: { review_id, recipes },
      content: [{ type: "text", text: `Loaded ${recipes.length} verified locator recovery recipes for ${review_id}. Re-verify a recipe when the page state or markup may have changed.` }],
    };
  });
}