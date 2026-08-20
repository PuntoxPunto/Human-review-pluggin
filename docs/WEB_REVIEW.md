# Web Review — M1/M2/M3/M4

Web Review extends Human Review without replacing its HTML editing loop. Human Review remains the source of truth for direct human edits; Web Review adds live-browser QA for public staging URLs using reproducible Playwright evidence.

## Implemented scope

### M1/M2 — live browser and evidence

1. `create_web_review` creates a live URL review session.
2. `capture_web_review` opens the target in real Chromium via Playwright.
3. Each capture stores screenshot, visible DOM structure, bounding geometry, viewport/scroll, document dimensions, console errors, and network failures.
4. `get_web_evidence` retrieves structured evidence and optionally the screenshot.
5. Public-target policy rejects non-HTTP(S), credentials, localhost, private/link-local/reserved addresses, and blocked subrequests.
6. Evidence lineage is explicit: `review -> run -> evidence`.
7. CI installs Chromium and runs a real browser integration fixture.

### M3 — deterministic findings and cockpit

1. Captures automatically run deterministic geometry analysis.
2. `analyze_web_geometry` reruns analysis against stored evidence without another navigation.
3. `open_web_review` renders one immutable evidence snapshot in a dedicated MCP Apps cockpit.
4. The cockpit shows screenshot, finding counts, issue rail, confidence, and scaled overlays.
5. Evidence elements include DOM paths and parent paths so containment can be distinguished from sibling overlap.
6. Findings are stored separately from raw browser evidence.

### M4 — human QA decisions

1. Each finding has a stable fingerprint based on finding type and target/related DOM identity.
2. Human decisions are stored as `new`, `accepted`, or `rejected`.
3. Findings support persistent human comments.
4. Re-running `analyze_web_geometry` preserves matching decisions and comments instead of replacing them.
5. `set_web_finding_decision` is an app-private tool used by the cockpit.
6. `get_web_findings` is model-visible so ChatGPT can read accepted/rejected findings and human comments.
7. The Web Review cockpit v2 adds Accept, Reject, Reset, Add comment, decision counts, and Send decisions.
8. Sending decisions asks ChatGPT to act only on accepted findings and explicit human comments and to ignore rejected findings.

Still deferred:

- deterministic browser action/scenario execution;
- scroll/motion sampling;
- semantic/LLM browser recovery and action recipes;
- visual LLM critic;
- reference comparison;
- autonomous fix/retest.

## Architecture

```text
ChatGPT
  |
  | create_web_review
  | capture_web_review
  | analyze_web_geometry
  | get_web_findings
  | open_web_review
  v
MCP server
  |
  +-- WebReviewStore
  |      review -> runs -> evidence ids
  |
  +-- BrowserRunner
  |      Playwright -> Chromium
  |          +-- screenshot
  |          +-- DOM paths + geometry
  |          +-- viewport / scroll / document metrics
  |          +-- console + network failures
  |
  +-- EvidenceStore
  |      immutable capture records
  |
  +-- Geometry Analyzer
  |      overflow / clipping / overlap candidates
  |
  +-- FindingStore
  |      fingerprint + status + comments
  |
  +-- Web Review MCP Apps UI
         evidence overlay + human decisions
```

The raw evidence layer remains immutable. Human decisions and later critic output are additional state layers referencing that evidence.

## Evidence contract

Each capture receives stable lineage IDs:

```text
webrev_* -> run_* -> ev_*
```

Evidence includes final URL, title, viewport, document dimensions, scroll position, PNG screenshot, visible DOM/geometry records, console/page errors, and failed or blocked requests.

A visible element record includes tag, selector hint, DOM path, parent path, ARIA role/name hints, bounding rectangle, position/z-index, and overflow styles.

## Geometry semantics

### `horizontal_overflow`

Browser-measured document overflow. High-confidence deterministic evidence.

### `element_horizontal_clipping`

Visible element extending beyond the horizontal viewport boundary. High-confidence browser evidence.

### `candidate_overlap`

Meaningful sibling rectangle intersection with parent-child containment excluded. This remains heuristic (`info`/`warning`, confidence below `0.8`) and is not a blocking failure until confirmed by a human or visual critic.

## Human decision contract

A human decision is not part of the immutable evidence; it references a finding derived from that evidence.

Priority is:

```text
Human accepted/rejected decision
  > deterministic analyzer refresh
  > model assumption
```

Reanalysis preserves decisions by matching a stable fingerprint:

```text
type + target DOM identity + related DOM identity
```

Metrics such as overlap area or overflow pixels are deliberately not part of the fingerprint so analyzer refinements cannot silently discard a human decision.

When the cockpit sends decisions back to ChatGPT, the model should call `get_web_findings`, act on accepted findings and explicit comments, and not turn rejected findings into implementation tasks.

## Cockpit contract

`open_web_review` never navigates again. Screenshot, viewport, geometry, and findings always refer to the same immutable evidence snapshot.

Cockpit mutations are restricted to decision state via the private `set_web_finding_decision` tool. The widget cannot modify raw evidence.

## Security boundary

Live browser automation creates an SSRF risk. Production Web Review rejects non-HTTP(S), embedded credentials, localhost/local domains, private/link-local/reserved IP ranges, and browser subrequests resolving to blocked addresses.

`allowPrivateTargets` exists only for controlled test fixtures. Production browser execution should ultimately live in an isolated worker/container with egress controls, quotas, time limits, and per-user authorization.

## Runtime

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

## Acceptance gates

### M1/M2

Real Chromium must navigate, capture PNG evidence, report viewport/document geometry, discover visible elements, preserve lineage, and keep the Human Review loop green.

### M3

CI must validate overflow, clipping, heuristic overlap, parent-child exclusion, DOM paths, dual MCP Apps resources, and correct Web Review cockpit routing.

### M4

CI must additionally prove that:

1. human decision tools are discovered with correct model/app visibility;
2. the cockpit resource is versioned independently from the previous read-only resource;
3. accepted/rejected status and comments survive deterministic reanalysis;
4. fingerprints remain stable even if finding metrics or descriptions change;
5. the original Human Review direct-edit loop remains green;
6. real Chromium integration remains green.

## Next slice

M5 should introduce deterministic browser actions and scenarios without LLM recovery: locate using stable role/text/path primitives, execute one bounded action, capture evidence after the action, and link before/after evidence through one scenario step. Semantic recovery and reusable action recipes should only be introduced once those deterministic primitives pass their own browser gates.