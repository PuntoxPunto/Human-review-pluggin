# Web Review Durable State Schema Migrations

M19 adds explicit schema versions to the single-writer filesystem state introduced in M14.

## Record envelope

New durable records are stored as:

```json
{
  "formatVersion": 1,
  "schemaVersion": 1,
  "key": "...",
  "value": {}
}
```

Each namespace also has `_schema.json`:

```json
{
  "formatVersion": 1,
  "namespace": "web-evidence",
  "schemaVersion": 1,
  "updatedAt": "..."
}
```

`formatVersion` describes the generic filesystem/envelope format. `schemaVersion` describes the application value stored inside one namespace. They are deliberately separate.

## Backward compatibility

M14-M18 records have `{ key, value }` without version fields. M19 treats those records as schema v1 and rewrites only their envelope to the current storage format when the namespace is opened.

No application-value migration is required for this normalization.

## Declaring a namespace migration

`createStateMap` accepts a target schema version and sequential migration functions:

```js
const records = createStateMap("example", {
  schemaVersion: 3,
  migrations: {
    1: (value) => ({ ...value, enabled: true }),
    2: (value) => ({ ...value, label: value.name ?? "Untitled" }),
  },
});
```

The key `1` means `v1 -> v2`; key `2` means `v2 -> v3`.

Migration functions receive a context object:

```js
(value, {
  namespace,
  key,
  fromVersion,
  toVersion,
}) => migratedValue
```

A migration must return a value. Returning `undefined` aborts loading.

## Atomicity and crash recovery

Migration is record-by-record:

1. read the record and its schema version;
2. run every required migration in memory;
3. atomically write the fully migrated record through temp-file + rename;
4. continue with the next record;
5. update the namespace manifest only after all records loaded successfully.

This means a process crash may leave some records already upgraded and others still old. On the next startup each record's own `schemaVersion` is authoritative, so already-upgraded records are not migrated twice.

## Fail-closed behavior

Startup is rejected when:

- a required `vN -> vN+1` migration function is missing;
- a migration returns `undefined`;
- a record has a schema newer than the running code supports;
- `_schema.json` declares a future namespace schema;
- the storage `formatVersion` is unsupported;
- a manifest or record is malformed/corrupt.

Web Review does not attempt automatic downgrade.

## Deployment rule

Once a deployment writes a newer namespace schema, rolling back to application code that only understands an older schema is intentionally blocked.

For a schema-changing release:

1. take a durable volume/database backup or snapshot;
2. drain/stop writers;
3. deploy the code that includes every required migration step;
4. start one writer and allow the namespace to migrate;
5. run normal acceptance/health checks;
6. only then resume regular operation.

Do not perform a blind binary rollback after state has been migrated. Restore the compatible state snapshot as part of a rollback procedure.

## Current M19 state

All existing Human/Web Review namespaces remain application schema v1. M19 introduces the versioning/migration mechanism without changing the value shape of those namespaces.

A future value-shape change should bump only the affected namespace and register its migration chain; unrelated state must not be rewritten merely because the application version changed.

## Horizontal storage

This mechanism versions application records independently of the physical backend. The same schema/migration contract should be reused when Web Review gains a database/object-storage adapter, while transaction/locking semantics will be provided by that backend instead of the current single-writer filesystem rule.
