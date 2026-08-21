import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const STORAGE_FORMAT_VERSION = 1;
const MANIFEST_FILE = "_schema.json";

function safeNamespace(value) {
  const namespace = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(namespace)) throw new Error(`Invalid durable state namespace: ${namespace}.`);
  return namespace;
}

function validSchemaVersion(value, label = "schemaVersion") {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1000) {
    throw new Error(`${label} must be an integer between 1 and 1000.`);
  }
  return version;
}

function fileNameForKey(key) {
  return `${createHash("sha256").update(String(key)).digest("hex")}.json`;
}

function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(value);
  writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function migrationFor(migrations, fromVersion) {
  if (migrations instanceof Map) return migrations.get(fromVersion) || migrations.get(String(fromVersion));
  return migrations?.[fromVersion] || migrations?.[String(fromVersion)] || null;
}

function migrateValue({ namespace, key, value, fromVersion, toVersion, migrations }) {
  let current = value;
  let version = fromVersion;
  while (version < toVersion) {
    const migrate = migrationFor(migrations, version);
    if (typeof migrate !== "function") {
      throw new Error(`Missing durable state migration for namespace ${namespace}: v${version} -> v${version + 1} (key ${key}).`);
    }
    current = migrate(current, { namespace, key, fromVersion: version, toVersion: version + 1 });
    if (current === undefined) {
      throw new Error(`Durable state migration for namespace ${namespace} returned undefined for key ${key} at v${version} -> v${version + 1}.`);
    }
    version += 1;
  }
  return current;
}

class DirectoryBackedMap extends Map {
  constructor(namespace, stateDir, { schemaVersion = 1, migrations = {} } = {}) {
    super();
    this.namespace = safeNamespace(namespace);
    this.schemaVersion = validSchemaVersion(schemaVersion);
    this.directory = resolve(stateDir, this.namespace);
    this.manifestPath = join(this.directory, MANIFEST_FILE);
    this.migrations = migrations || {};
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });

    const manifest = this.#readManifest();
    if (manifest && manifest.schemaVersion > this.schemaVersion) {
      throw new Error(`Durable state namespace ${this.namespace} uses future schema v${manifest.schemaVersion}; this process supports v${this.schemaVersion}.`);
    }

    for (const name of readdirSync(this.directory)) {
      if (name === MANIFEST_FILE || !name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      const record = this.#readRecord(path);
      const recordVersion = validSchemaVersion(record.schemaVersion ?? 1, `schemaVersion in ${path}`);
      if (recordVersion > this.schemaVersion) {
        throw new Error(`Durable state record ${path} uses future schema v${recordVersion}; namespace ${this.namespace} supports v${this.schemaVersion}.`);
      }

      let value = record.value;
      if (recordVersion < this.schemaVersion) {
        value = migrateValue({
          namespace: this.namespace,
          key: record.key,
          value,
          fromVersion: recordVersion,
          toVersion: this.schemaVersion,
          migrations: this.migrations,
        });
        this.#writeRecord(path, record.key, value);
      } else if (record.schemaVersion === undefined || record.formatVersion === undefined) {
        // M14-M18 legacy records are schema v1; normalize their envelope lazily.
        this.#writeRecord(path, record.key, value);
      }
      super.set(record.key, value);
    }

    this.#writeManifest();
  }

  #readManifest() {
    if (!existsSync(this.manifestPath)) return null;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(this.manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not load durable state manifest ${this.manifestPath}: ${error.message}`);
    }
    if (!manifest || manifest.formatVersion !== STORAGE_FORMAT_VERSION || manifest.namespace !== this.namespace) {
      throw new Error(`Invalid durable state manifest: ${this.manifestPath}`);
    }
    return {
      ...manifest,
      schemaVersion: validSchemaVersion(manifest.schemaVersion, `schemaVersion in ${this.manifestPath}`),
    };
  }

  #writeManifest() {
    atomicWriteJson(this.manifestPath, {
      formatVersion: STORAGE_FORMAT_VERSION,
      namespace: this.namespace,
      schemaVersion: this.schemaVersion,
      updatedAt: new Date().toISOString(),
    });
  }

  #readRecord(path) {
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Could not load durable state file ${path}: ${error.message}`);
    }
    if (!record || typeof record.key !== "string" || !("value" in record)) {
      throw new Error(`Invalid durable state record: ${path}`);
    }
    if (record.formatVersion !== undefined && record.formatVersion !== STORAGE_FORMAT_VERSION) {
      throw new Error(`Unsupported durable state storage format v${record.formatVersion} in ${path}.`);
    }
    return record;
  }

  #writeRecord(path, key, value) {
    atomicWriteJson(path, {
      formatVersion: STORAGE_FORMAT_VERSION,
      schemaVersion: this.schemaVersion,
      key: String(key),
      value,
    });
  }

  #path(key) {
    return join(this.directory, fileNameForKey(key));
  }

  #persist(key) {
    if (!super.has(key)) return;
    this.#writeRecord(this.#path(key), key, super.get(key));
  }

  set(key, value) {
    const normalized = String(key);
    super.set(normalized, value);
    this.#persist(normalized);
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

export function createStateMap(namespace, { stateDir = process.env.WEB_REVIEW_STATE_DIR, schemaVersion = 1, migrations = {} } = {}) {
  return stateDir ? new DirectoryBackedMap(namespace, stateDir, { schemaVersion, migrations }) : new Map();
}

export function isDurableStateMap(map) {
  return typeof map?.touch === "function";
}

export function getStateMapSchemaInfo(map) {
  if (!isDurableStateMap(map)) return { durable: false, namespace: null, schemaVersion: null };
  return { durable: true, namespace: map.namespace, schemaVersion: map.schemaVersion };
}

export function persistStateMapEntry(map, key) {
  if (typeof map?.touch === "function") map.touch(key);
}
