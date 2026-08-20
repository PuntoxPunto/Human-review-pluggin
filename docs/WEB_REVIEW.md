# Web Review — M1/M2 vertical slice

This change extends Human Review without replacing its HTML editing loop. Human Review remains the source of truth for direct human edits; Web Review adds a second review mode for public live/staging URLs.

## Scope

Implemented in this slice:

1. `create_web_review` — creates a live URL review session.
2. `capture_web_review` — opens the target in real Chromium via Playwright and captures evidence.
3. `get_web_evidence` — retrieves structured browser evidence and optionally the screenshot.
4. Public-target URL policy that rejects non-HTTP(S), embedded credentials, localhost, and private/link-local network addresses.
5. Evidence lineage: `review -> run -> evidence`.
6. Real Chromium integration test in CI.

Not implemented yet:

- interactive Web Review cockpit;
- semantic/LLM browser actions;
- overlap/overflow findings;
- scroll/motion sampling;
- visual critic;
- reference comparison;
- autonomous fix/retest.

## Architecture

```text
ChatGPT
  |
  | create_web_review / capture_web_review / get_web_evidence
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
  |          +-- visible DOM structure
  |          +-- bounding rectangles
  |          +-- viewport + scroll
  |          +-- console errors
  |          +-- network failures
  |
  +-- EvidenceStore
         immutable capture records
```

The browser runner is deliberately isolated from the existing Human Review store and widget so that browser execution can later move to a Docker/remote runner without changing the Human Review editing contract.

## Evidence contract

Each capture receives stable lineage IDs:

```text
webrev_* -> run_* -> ev_*
```

Evidence contains:

- final URL after navigation;
- document title;
- viewport dimensions;
- scroll position;
- PNG screenshot;
- up to 600 visible DOM/geometry records from the current viewport;
- console/page errors;
- failed or blocked network requests.

A visible element record contains:

- tag;
- selector hint;
- ARIA role when available;
- accessible-ish name/text hints;
- bounding rectangle;
- position/z-index;
- overflow styles.

This representation is intentionally smaller and more structured than shipping the complete raw page HTML to the model.

## Security boundary

Live browser automation creates an SSRF risk. Production Web Review therefore rejects:

- protocols other than HTTP(S);
- URLs containing credentials;
- localhost and `.local` hosts;
- loopback, RFC1918/private, link-local, multicast/reserved IPv4 targets;
- loopback, unique-local and link-local IPv6 targets;
- requests whose DNS resolution points to a blocked address.

The same policy is applied to browser requests so a public page cannot intentionally redirect the browser to a private target. `allowPrivateTargets` exists only for controlled test fixtures.

This is an initial network boundary, not a complete production sandbox. Browser execution should ultimately run in an isolated worker/container with egress controls, resource quotas, time limits, and per-user authorization.

## Runtime requirements

Install dependencies and Chromium:

```bash
npm install
npx playwright install --with-deps chromium
```

Then:

```bash
npm test
npm start
```

CI performs the same Chromium installation and runs a real browser integration fixture.

## Acceptance gate for M1/M2

The slice passes when CI proves that BrowserRunner can:

1. launch Chromium;
2. navigate to a controlled page;
3. capture a non-empty PNG screenshot;
4. report the requested viewport;
5. discover visible page elements;
6. produce non-zero geometry for the target heading;
7. preserve review/run/evidence lineage;
8. keep the existing Human Review MCP loop green.

## Next implementation slice

M3 should build the Web Review cockpit on top of this evidence contract, then add deterministic geometry findings (`overflow`, `viewport`, `overlap`, `center offset`) before introducing visual LLM critique or semantic Playwright actions.
