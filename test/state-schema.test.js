import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateMap, getStateMapSchemaInfo } from "../src/state-map.js";

function tempState(t) {
  const directory = mkdtempSync(join(tmpdir(), "web-review-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function recordPath(stateDir, namespace, key) {
  const directory = join(stateDir, namespace);
  mkdirSync(directory, { recursive: true });
  const file = `${createHash("sha256").update(String(key)).digest("hex")}.json`;
  return join(directory, file);
}

function writeLegacyRecord(stateDir, namespace, key, value, extra = {}) {
  const path = recordPath(stateDir, namespace, key);
  writeFileSync(path, JSON.stringify({ key, value, ...extra }), "utf8");
  return path;
}

test("legacy v1 records migrate sequentially and persist current schema envelopes", (t) => {
  const stateDir = tempState(t);
  const path = writeLegacyRecord(stateDir, "migration-demo", "alpha", { name: "Alpha" });
  const calls = [];

  const map = createStateMap("migration-demo", {
    stateDir,
    schemaVersion: 3,
    migrations: {
      1: (value, context) => {
        calls.push(`${context.fromVersion}->${context.toVersion}`);
        return { ...value, enabled: true };
      },
      2: (value, context) => {
        calls.push(`${context.fromVersion}->${context.toVersion}`);
        return { ...value, label: value.name.toUpperCase() };
      },
    },
  });

  assert.deepEqual(map.get("alpha"), { name: "Alpha", enabled: true, label: "ALPHA" });
  assert.deepEqual(calls, ["1->2", "2->3"]);
  assert.deepEqual(getStateMapSchemaInfo(map), { durable: true, namespace: "migration-demo", schemaVersion: 3 });

  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.formatVersion, 1);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.key, "alpha");
  assert.equal(record.value.label, "ALPHA");

  const manifest = JSON.parse(readFileSync(join(stateDir, "migration-demo", "_schema.json"), "utf8"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.namespace, "migration-demo");
  assert.equal(manifest.schemaVersion, 3);

  const reopened = createStateMap("migration-demo", {
    stateDir,
    schemaVersion: 3,
    migrations: {
      1: () => { throw new Error("v1 migration must not rerun"); },
      2: () => { throw new Error("v2 migration must not rerun"); },
    },
  });
  assert.equal(reopened.get("alpha").label, "ALPHA");
});

test("missing migration path blocks loading without rewriting the old record", (t) => {
  const stateDir = tempState(t);
  const path = writeLegacyRecord(stateDir, "missing-migration", "alpha", { count: 1 });
  const before = readFileSync(path, "utf8");

  assert.throws(() => createStateMap("missing-migration", {
    stateDir,
    schemaVersion: 3,
    migrations: {
      1: (value) => ({ ...value, count: 2 }),
    },
  }), /Missing durable state migration.*v2 -> v3/i);

  assert.equal(readFileSync(path, "utf8"), before);
});

test("future record or manifest schema is rejected instead of being silently downgraded", (t) => {
  const stateDir = tempState(t);
  writeLegacyRecord(stateDir, "future-record", "alpha", { value: true }, { formatVersion: 1, schemaVersion: 4 });
  assert.throws(() => createStateMap("future-record", { stateDir, schemaVersion: 3 }), /future schema v4/i);

  const namespace = join(stateDir, "future-manifest");
  mkdirSync(namespace, { recursive: true });
  writeFileSync(join(namespace, "_schema.json"), JSON.stringify({
    formatVersion: 1,
    namespace: "future-manifest",
    schemaVersion: 5,
    updatedAt: new Date().toISOString(),
  }), "utf8");
  assert.throws(() => createStateMap("future-manifest", { stateDir, schemaVersion: 3 }), /future schema v5/i);
});

test("existing v1 namespace is normalized without a migration function", (t) => {
  const stateDir = tempState(t);
  const path = writeLegacyRecord(stateDir, "legacy-v1", "alpha", { preserved: true });
  const map = createStateMap("legacy-v1", { stateDir });
  assert.deepEqual(map.get("alpha"), { preserved: true });
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.formatVersion, 1);
});
