import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

function safeNamespace(value) {
  const namespace = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(namespace)) throw new Error(`Invalid durable state namespace: ${namespace}.`);
  return namespace;
}

function fileNameForKey(key) {
  return `${createHash("sha256").update(String(key)).digest("hex")}.json`;
}

class DirectoryBackedMap extends Map {
  constructor(namespace, stateDir) {
    super();
    this.namespace = safeNamespace(namespace);
    this.directory = resolve(stateDir, this.namespace);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      let record;
      try {
        record = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`Could not load durable state file ${path}: ${error.message}`);
      }
      if (!record || typeof record.key !== "string" || !("value" in record)) {
        throw new Error(`Invalid durable state record: ${path}`);
      }
      super.set(record.key, record.value);
    }
  }

  #path(key) {
    return join(this.directory, fileNameForKey(key));
  }

  #persist(key) {
    if (!super.has(key)) return;
    const target = this.#path(key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ key: String(key), value: super.get(key) });
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  }

  set(key, value) {
    super.set(String(key), value);
    this.#persist(String(key));
    return this;
  }

  touch(key) {
    const normalized = String(key);
    if (!super.has(normalized)) throw new Error(`Cannot persist missing durable state key ${normalized}.`);
    this.#persist(normalized);
  }

  delete(key) {
    const normalized = String(key);
    const existed = super.delete(normalized);
    if (existed) rmSync(this.#path(normalized), { force: true });
    return existed;
  }

  clear() {
    for (const key of [...super.keys()]) this.delete(key);
  }
}

export function createStateMap(namespace, { stateDir = process.env.WEB_REVIEW_STATE_DIR } = {}) {
  return stateDir ? new DirectoryBackedMap(namespace, stateDir) : new Map();
}

export function isDurableStateMap(map) {
  return typeof map?.touch === "function";
}

export function persistStateMapEntry(map, key) {
  if (typeof map?.touch === "function") map.touch(key);
}
