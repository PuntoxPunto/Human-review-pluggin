import { randomUUID } from "node:crypto";
import { sanitizeReviewHtml, stripTags } from "./sanitize.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ReviewStore {
  #reviews = new Map();

  create({ title, html }) {
    const now = new Date().toISOString();
    const cleanHtml = sanitizeReviewHtml(html);
    const review = {
      id: `rev_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      title: String(title || "Untitled HTML review").trim().slice(0, 160),
      status: "editing",
      sourceVersion: 1,
      draftVersion: 1,
      canonicalHtml: cleanHtml,
      draftHtml: cleanHtml,
      edits: [],
      comments: [],
      pendingBatch: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#reviews.set(review.id, review);
    return clone(review);
  }

  get(id) {
    const review = this.#reviews.get(id);
    if (!review) throw new Error(`Review ${id} was not found.`);
    return clone(review);
  }

  saveDraft(id, { draftHtml, edits = [], comments = [] }) {
    const review = this.#mustGet(id);
    review.draftHtml = sanitizeReviewHtml(draftHtml);
    review.edits = clone(edits);
    review.comments = clone(comments);
    review.draftVersion += 1;
    review.status = "editing";
    review.updatedAt = new Date().toISOString();
    return clone(review);
  }

  submit(id, { draftHtml, edits = [], comments = [] }) {
    const review = this.#mustGet(id);
    review.draftHtml = sanitizeReviewHtml(draftHtml);
    review.edits = clone(edits);
    review.comments = clone(comments);
    review.draftVersion += 1;
    const batchId = `batch_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    review.pendingBatch = {
      id: batchId,
      baseSourceVersion: review.sourceVersion,
      userEditedHtml: review.draftHtml,
      edits: clone(review.edits),
      comments: clone(review.comments),
      submittedAt: new Date().toISOString(),
    };
    review.status = "feedback_pending";
    review.updatedAt = new Date().toISOString();
    return clone(review);
  }

  feedback(id, batchId) {
    const review = this.#mustGet(id);
    if (!review.pendingBatch || review.pendingBatch.id !== batchId) {
      throw new Error(`Feedback batch ${batchId} was not found for ${id}.`);
    }
    return clone(review.pendingBatch);
  }

  apply(id, { batchId, html, overriddenEditIds = [] }) {
    const review = this.#mustGet(id);
    const batch = review.pendingBatch;
    if (!batch || batch.id !== batchId) {
      throw new Error(`Feedback batch ${batchId} is not pending for ${id}.`);
    }

    const cleanHtml = sanitizeReviewHtml(html);
    const candidateText = stripTags(cleanHtml);
    const overrides = new Set(overriddenEditIds);
    const conflicts = [];

    for (const edit of batch.edits) {
      if (edit.kind !== "edited" || overrides.has(edit.id)) continue;
      const after = String(edit.after ?? "").replace(/\s+/g, " ").trim();
      if (after && !candidateText.includes(after)) conflicts.push(edit.id);
    }

    if (conflicts.length) {
      return { ok: false, conflicts, review: clone(review) };
    }

    review.canonicalHtml = cleanHtml;
    review.draftHtml = cleanHtml;
    review.sourceVersion += 1;
    review.draftVersion = review.sourceVersion;
    review.status = "editing";
    review.edits = [];
    review.comments = [];
    review.pendingBatch = null;
    review.updatedAt = new Date().toISOString();
    return { ok: true, conflicts: [], review: clone(review) };
  }

  #mustGet(id) {
    const review = this.#reviews.get(id);
    if (!review) throw new Error(`Review ${id} was not found.`);
    return review;
  }
}
