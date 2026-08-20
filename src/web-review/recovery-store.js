import { createHash, randomUUID } from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprint({ reviewId, targetUrl, failedLocator }) {
  const stable = JSON.stringify({ reviewId, targetUrl, failedLocator: failedLocator || null });
  return `rfp_${createHash("sha256").update(stable).digest("hex").slice(0, 20)}`;
}

export class RecoveryRecipeStore {
  #recipes = new Map();
  #byFingerprint = new Map();

  save({ reviewId, targetUrl, targetHint = "", failedLocator = null, verifiedLocator, resolvedLocator, evidenceId }) {
    const recipeFingerprint = fingerprint({ reviewId, targetUrl, failedLocator });
    const priorId = this.#byFingerprint.get(recipeFingerprint);
    const now = new Date().toISOString();
    const prior = priorId ? this.#recipes.get(priorId) : null;
    const recipe = {
      id: prior?.id || `recipe_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      fingerprint: recipeFingerprint,
      reviewId,
      targetUrl,
      targetHint: String(targetHint || "").trim().slice(0, 500),
      failedLocator: clone(failedLocator),
      verifiedLocator: clone(verifiedLocator),
      resolvedLocator: clone(resolvedLocator),
      evidenceId,
      verificationCount: (prior?.verificationCount || 0) + 1,
      createdAt: prior?.createdAt || now,
      updatedAt: now,
    };
    this.#recipes.set(recipe.id, recipe);
    this.#byFingerprint.set(recipeFingerprint, recipe.id);
    return clone(recipe);
  }

  list(reviewId) {
    return [...this.#recipes.values()]
      .filter((recipe) => recipe.reviewId === reviewId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  get(id) {
    const recipe = this.#recipes.get(id);
    if (!recipe) throw new Error(`Recovery recipe ${id} was not found.`);
    return clone(recipe);
  }
}