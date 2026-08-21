import { randomUUID } from "node:crypto";
import { createStateMap } from "../state-map.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ArtifactStore {
  #artifacts = createStateMap("web-artifacts");

  putScreenshot({ evidenceId, data, mimeType = "image/png", createdAt = new Date().toISOString() }) {
    if (!data) throw new Error("Screenshot artifact data is required.");
    const id = `artifact_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const artifact = {
      id,
      evidenceId,
      kind: "screenshot",
      mimeType,
      data,
      bytes: Buffer.from(data, "base64").byteLength,
      createdAt,
    };
    this.#artifacts.set(id, artifact);
    return clone({ ...artifact, data: undefined });
  }

  get(id) {
    const artifact = this.#artifacts.get(id);
    if (!artifact) throw new Error(`Artifact ${id} was not found.`);
    return clone(artifact);
  }

  has(id) {
    return this.#artifacts.has(id);
  }

  delete(id) {
    return this.#artifacts.delete(id);
  }
}
