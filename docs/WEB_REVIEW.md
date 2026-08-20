# Web Review — M1/M2/M3

Web Review extends Human Review without replacing its HTML editing loop. Human Review remains the source of truth for direct human edits; Web Review adds a second review mode for public live/staging URLs and a read-only QA cockpit built from reproducible Playwright evidence.

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

1. `capture_web_review` automatically runs deterministic geometry analysis after capture.
2. `analyze_web_geometry` can rerun geometry analysis against stored evidence without another browser navigation.
3. `open_web_review` renders the selected or latest evidence snapshot in a dedicated MCP Apps cockpit.
4. The cockpit shows the Playwright screenshot, finding counts, a finding rail, confidence, and scaled bounding overlays.
5. Evidence elements now include DOM paths and parent paths so containment can be distinguished from sibling overlap.
6. Findings are stored separately from browser evidence so later critic/human decisions do not mutate the raw capture.

Still deferred:

- interactive browser actions from the cockpit;
- accept/reject/comment workflow for Web Review findings;
- scroll/motion sampling;
- semantic/LLM browser actions and action recipes;
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
  | open_web_review
  v
MCP server
  |
  +-- WebReviewStore
  |      review -> runs -> evidence ids
  |
  +-- BrowserRunner
  |      Playwright -> Chromium
  |          |
  |          +-- screenshot
  |          +-- visible DOM + DOM paths
  |          +-- bounding rectangles
  |          +-- viewport + scroll + document metrics
  |          +-- console errors
  |          +-- network failures
  |
  +-- EvidenceStore
  |      immutable capture records
  |
  +-- Geometry Analyzer
  |      overflow / clipping / overlap candidates
  |
  +-- FindingStore
  |      evidence-scoped findings
  |
  +-- Web Review MCP Apps UI
         screenshot + overlays + finding rail
```

The browser runner remains isolated from the Human Review store/widget so browser execution can later move to a Docker/remote runner without changing the Human Review editing contract.

## Evidence contract

Each capture receives stable lineage IDs:

```text
webrev_* -> run_* -> ev_*
```

Evidence contains:

- final URL after navigation;
- document title;
- viewport dimensions;
- document scroll/client dimensions;
- scroll position;
- PNG screenshot;
- up to 600 visible DOM/geometry records from the current viewport;
- console/page errors;
- failed or blocked network requests.

A visible element record contains:

- tag;
- compact selector hint;
- DOM path and parent path;
- ARIA role when available;
- accessible-ish name/text hints;
- bounding rectangle;
- position/z-index;
- overflow styles.

This representation is intentionally smaller and more structured than shipping the complete raw page HTML to the model.

## Deterministic geometry findings

M3 deliberately starts with browser-measurable checks rather than an LLM judging screenshots.

### `horizontal_overflow`

Compares document `scrollWidth` against viewport width. Confidence is high (`0.99`) because the browser measurement is deterministic.

### `element_horizontal_clipping`

Flags visible elements crossing the left/right viewport boundary by more than 2px. Larger clipping is elevated from warning to error.

### `candidate_overlap`

Compares meaningful visible sibling elements and reports sufficiently large rectangle intersections. Parent/child containment is excluded using DOM paths.

This finding is intentionally heuristic:

- it is `info` or `warning`, never a hard error in M3;
- confidence stays below `0.8`;
- it should later be confirmed by visual critique or a human before becoming a blocking QA gate.

This distinction is important: browser geometry can prove that rectangles intersect, but it cannot by itself prove that the overlap is undesirable.

## Cockpit contract

`open_web_review` does not navigate again. It opens one immutable evidence snapshot, which means the screenshot, viewport, DOM geometry, and findings shown in the UI all refer to the same browser state.

The widget receives the full screenshot and findings through hidden tool-result metadata rather than expanding them into model-visible structured content.

The initial cockpit is intentionally read-only. Human finding decisions and browser interactions should be added as separate state transitions instead of overloading the raw evidence layer.

## Security boundary

Live browser automation creates an SSRF risk. Production Web Review therefore rejects:

- protocols other than HTTP(S);
- URLs containing credentials;
- localhost and `.local` hosts;
- loopback, RFC1918/private, CGNAT, link-local, benchmark, documentation, multicast, and other reserved IPv4 targets;
- loopback, mapped, unique-local, link-local, multicast, and documentation IPv6 targets;
- requests whose DNS resolution points to a blocked address.

The same policy is applied to browser requests so a public page cannot intentionally request a private target. `allowPrivateTargets` exists only for controlled test fixtures.

This is an initial application boundary, not a complete production sandbox. Browser execution should ultimately run in an isolated worker/container with egress controls, resource quotas, time limits, and per-user authorization.

## Runtime requirements

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

CI performs the same Chromium installation and runs a real browser fixture.

## Acceptance gates

### M1/M2 gate

CI must prove that BrowserRunner can launch Chromium, navigate, capture a non-empty PNG, report viewport and document geometry, discover visible elements, and preserve review/run/evidence lineage while the original Human Review MCP loop remains green.

### M3 gate

CI must additionally prove that:

1. document overflow generates the expected deterministic finding;
2. viewport clipping generates an element-scoped finding;
3. meaningful sibling overlap produces only a heuristic candidate;
4. parent-child containment is not treated as overlap;
5. browser evidence contains stable DOM/parent paths;
6. ChatGPT discovers both Human Review and Web Review MCP Apps resources;
7. `open_web_review` points at the Web Review cockpit resource;
8. capture is correctly annotated as state-writing, not read-only.

## Next slice

The next recommended slice is M4/M5 foundation: add human finding decisions (`accept`, `reject`, `comment`) and deterministic browser scenarios/actions before introducing semantic LLM recovery. Scroll/motion sampling should follow immediately after because motion-heavy pages require evidence at multiple scroll states rather than a single viewport capture.
