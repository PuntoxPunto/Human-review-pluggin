# Web Review Durable State — M14

M14 adds an opt-in directory-backed state backend without changing existing MCP tool contracts.

Enable it with:

```text
WEB_REVIEW_STATE_DIR=/var/lib/web-review/state
```

When the variable is absent, stores retain their previous in-memory behavior.

## Persisted canonical state

M14 persists the state that must survive a process restart to preserve human intent and evidence lineage:

- Human Review sessions, direct edits, comments, pending feedback batch and applied source version;
- Web Review sessions, capture runs and evidence IDs;
- immutable evidence including screenshot, DOM/geometry, viewport, console and network diagnostics;
- findings across deterministic / visual critic / reference critic provenance;
- human finding decisions and comments;
- reference comparison lineage and objective deltas;
- fix plans, verification attempts and Fix Review human decisions.

Action-run, scroll-run, scenario-run and locator-recovery recipe caches remain ephemeral in M14. They are not treated as canonical user decisions and can be migrated in a later adapter if operational replay requires it.

## Storage layout

Each namespace receives its own directory. Every logical record is stored as one JSON file named by a SHA-256 hash of its key. The record itself contains the original key and value.

Writes use a temporary file followed by atomic rename. Namespace directories are created with mode `0700`; new state records are written with mode `0600` where supported.

Example:

```text
$WEB_REVIEW_STATE_DIR/
  human-reviews/
  web-reviews/
  web-evidence/
  web-findings/
  web-reference-comparisons/
  web-fix-plans/
```

## Restart semantics

Store constructors load existing records synchronously before serving requests. In-place mutations explicitly flush the affected record, so human decisions are not lost merely because the object remained in memory.

The acceptance test creates and mutates all canonical state classes, constructs fresh store instances against the same directory, and verifies that edits, screenshots, findings, baseline lineage and Fix Review decisions survive reconstruction.

## Deployment guidance

This backend is intended for a **single-writer process with a persistent mounted volume**, such as a VPS/Coolify deployment.

It is not a distributed database and should not be used as shared writable state across multiple MCP replicas. There is no inter-process file locking or distributed transaction layer in M14.

For horizontal/serverless deployment, the next storage adapter should provide the same logical map semantics over a durable database/object store and add explicit schema versioning, migrations, retention and garbage collection.

## Evidence size

Evidence JSON currently includes screenshot Base64 in the evidence record. This keeps restart semantics simple and exact but is not the final high-volume design. A future object-storage adapter should separate large screenshot/artifact blobs from metadata while preserving immutable evidence IDs and checksums.

## Health endpoint note

The legacy `/health` payload still reports the original in-memory storage label because M14 deliberately avoids rewriting `server.js` while the storage contract is being stabilized. Deployment documentation and `WEB_REVIEW_STATE_DIR` are authoritative for this slice; health/metrics reporting of storage mode belongs in the observability hardening slice.
