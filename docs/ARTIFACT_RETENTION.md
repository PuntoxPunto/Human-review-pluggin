# Web Review Artifact Retention

M18 separates heavy screenshot blobs from durable Web Review evidence metadata and adds a dry-run-first retention workflow.

## What retention removes

Retention removes only retained screenshot bytes. It does **not** delete the evidence record.

The following remain available after screenshot expiry:

- evidence ID, review/run lineage and timestamps;
- final URL and viewport/scroll state;
- DOM/geometry structure captured by Playwright;
- console/network diagnostics;
- deterministic findings;
- visual/baseline finding records and human decisions/comments;
- reference-comparison records;
- fix plans, verification attempts and human Fix Review decisions.

A pruned evidence record is marked with `screenshotPrunedAt` and reports `screenshotAvailable=false`.

## Storage model

New screenshots are stored separately under the durable `web-artifacts` namespace. Evidence stores only an artifact ID, MIME type and byte count.

Existing M14 state that still has `screenshotBase64` inline remains readable. The retention job can prune those legacy inline blobs while keeping their evidence metadata, so no one-time destructive migration is required for M18.

## Protection graph

Before selecting candidates, retention reads canonical state and protects evidence referenced by:

- `FindingStore`;
- `ReferenceComparisonStore` as reference or candidate evidence;
- `FixPlanStore`, including original evidence, referenced baseline evidence and verification-attempt pre/post evidence.

It also keeps the newest N screenshot artifacts per Web Review regardless of age. Manual/local screenshot protection markers are honored as an additional safeguard.

Only screenshots that are old enough, outside the newest-N window and absent from the canonical protection graph become candidates.

## Dry run first

Retention is not exposed as an MCP/model-facing tool. It is an operator command.

A durable state directory is mandatory:

```text
WEB_REVIEW_STATE_DIR=/var/lib/web-review
```

Preview candidates without deleting anything:

```text
npm run retention:report
```

Defaults:

```text
WEB_REVIEW_SCREENSHOT_RETENTION_DAYS=30
WEB_REVIEW_SCREENSHOT_KEEP_LATEST=5
```

Example:

```text
WEB_REVIEW_STATE_DIR=/var/lib/web-review \
WEB_REVIEW_SCREENSHOT_RETENTION_DAYS=45 \
WEB_REVIEW_SCREENSHOT_KEEP_LATEST=8 \
npm run retention:report
```

The report includes candidate IDs, candidate bytes, protection counts and expected reclaimable bytes.

Apply only after inspecting the dry run:

```text
WEB_REVIEW_STATE_DIR=/var/lib/web-review npm run retention:apply
```

`WEB_REVIEW_RETENTION_APPLY=true node scripts/retention.js` is equivalent.

## Single-writer boundary

The M14 filesystem adapter remains a single-writer backend. Do not run the retention process concurrently against the same `WEB_REVIEW_STATE_DIR` while another process is mutating that state.

For a VPS/Coolify deployment, run retention in a maintenance window or stop/drain the MCP process using the same state volume first. A future database/object-storage adapter should implement transactional or distributed coordination before enabling concurrent GC.

## Behavior after screenshot expiry

`open_web_review` and `get_web_evidence` continue to work. The cockpit switches to an explicit metadata-only state and retains findings/decisions.

Operations that genuinely require pixels—visual critique, baseline image inspection, visual Fix Review or screenshot-backed locator recovery—must not fabricate an image. If the required screenshot has expired, the evidence store raises a clear error instructing the caller to capture fresh browser evidence.

This keeps the trust model explicit:

```text
retained DOM/geometry != retained visual evidence
```

## Non-goals in M18

M18 does not:

- delete complete evidence records;
- delete review sessions or human decisions;
- expose GC to ChatGPT as an autonomous tool;
- run deletion automatically on process startup;
- implement object storage, distributed locks or horizontal multi-writer retention;
- define legal/compliance retention periods for a particular organization.

Those policies should be layered on top of the safe metadata/blob split introduced here.
