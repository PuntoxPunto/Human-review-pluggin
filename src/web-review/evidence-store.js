import { randomUUID } from "node:crypto";
import { createStateMap } from "../state-map.js";

function cloneWithoutScreenshot(evidence) {
  const { screenshotBase64, ...rest } = evidence;
  return JSON.parse(JSON.stringify(rest));
}

export class EvidenceStore {
  #evidence = createStateMap("web-evidence");

  put({ reviewId, runId, capture }) {
    const id = `ev_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const evidence = {
      id,
      reviewId,
      runId,
      capturedAt: new Date().toISOString(),
      finalUrl: capture.finalUrl,
      title: capture.title,
      viewport: capture.viewport,
      scroll: capture.scroll,
      document: capture.document,
      screenshotBase64: capture.screenshotBase64,
      screenshotMimeType: "image/png",
      structure: capture.structure,
      consoleErrors: capture.consoleErrors,
      networkErrors: capture.networkErrors,
    };
    this.#evidence.set(id, evidence);
    return cloneWithoutScreenshot(evidence);
  }

  get(id, { includeScreenshot = false } = {}) {
    const evidence = this.#evidence.get(id);
    if (!evidence) throw new Error(`Evidence ${id} was not found.`);
    if (includeScreenshot) return JSON.parse(JSON.stringify(evidence));
    return cloneWithoutScreenshot(evidence);
  }

  summary(id) {
    const evidence = this.get(id);
    return {
      evidence_id: evidence.id,
      review_id: evidence.reviewId,
      run_id: evidence.runId,
      url: evidence.finalUrl,
      title: evidence.title,
      viewport: evidence.viewport,
      scroll: evidence.scroll,
      structure_count: evidence.structure.length,
      console_error_count: evidence.consoleErrors.length,
      network_error_count: evidence.networkErrors.length,
    };
  }
}
