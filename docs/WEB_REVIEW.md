# Web Review — M1 through M6

Web Review extends Human Review with live-browser QA for public staging URLs using reproducible Playwright evidence. Human Review remains the source of truth for direct human HTML edits.

## Implemented milestones

### M1/M2 — live browser and evidence

- `create_web_review`, `capture_web_review`, `get_web_evidence`
- real Playwright Chromium capture
- screenshot, DOM paths, geometry, viewport/scroll, document dimensions, console/network errors
- explicit `review -> run -> evidence` lineage
- SSRF-oriented public target and subrequest policy

### M3 — geometry findings and cockpit

- deterministic `horizontal_overflow` and `element_horizontal_clipping`
- heuristic non-blocking `candidate_overlap`
- `analyze_web_geometry`, immutable evidence-scoped findings, `open_web_review`
- MCP Apps screenshot/finding cockpit

### M4 — human QA decisions

- stable finding fingerprints based on type + DOM target identity
- `new`, `accepted`, `rejected` decisions and persistent comments
- analyzer refresh preserves human decisions/comments
- private `set_web_finding_decision`, model-visible `get_web_findings`
- cockpit v2 Accept / Reject / Reset / Add comment / Send decisions

### M5 — deterministic browser actions

- `run_web_action`, `get_web_action_run`
- bounded `click`, `fill`, `scroll_into_view`
- exact role+name, exact text, or CSS locators
- exact-one-match invariant: ambiguity fails instead of guessing
- immutable before/after evidence in the same Chromium session
- real Chromium tests prove DOM mutation and ambiguous-locator rejection

### M6 — deterministic scroll and framing evidence

- `run_web_scroll_checkpoints`, `get_web_scroll_run`
- 1–20 checkpoints captured in one Chromium session
- `progress`: sample an exact fraction of document scroll range
- `element`: align one exact element to viewport `start`, `center`, or `end`
- `measure`: measure one exact element without changing scroll
- every checkpoint creates immutable screenshot + DOM/geometry evidence and deterministic findings
- element checkpoints store the exact resolved locator
- `center_offset_px` measures framing relative to viewport center

`center_offset_px` semantics:

```text
0      exact vertical center
> 0    element center is below viewport center
< 0    element center is above viewport center
```

This turns a navigation problem such as “the CTA reached the section, but the user still has to scroll before the animation is properly framed” into measurable browser evidence instead of subjective inspection.

Still deferred:

- combined multi-action scenarios;
- semantic LLM locator recovery and reusable action recipes;
- visual LLM critic;
- reference comparison;
- autonomous fix/deploy/retest.

## Architecture

```text
ChatGPT
  |
  +-- Human Review tools
  |
  +-- Web Review tools
        +-- WebReviewStore
        +-- BrowserRunner -> Playwright / Chromium
        +-- EvidenceStore
        +-- Geometry Analyzer
        +-- FindingStore
        +-- ActionRunStore
        +-- ScrollRunStore
        +-- Web Review MCP Apps cockpit
```

## Evidence invariant

Raw browser evidence is immutable. Findings, decisions, action metadata, and scroll-run metadata reference evidence IDs.

```text
webrev_*
  +-- run_*       -> ev_*
  +-- actrun_*    -> before ev_* / after ev_*
  +-- scrollrun_* -> checkpoint ev_* -> checkpoint ev_* -> ...
```

A successful browser command is never equivalent to a verified result. The evidence after the command/checkpoint is the verification state.

## Locator contract

Deterministic browser operations accept only:

```text
role + accessible name
exact visible text
CSS selector
```

Every locator must match exactly one element. Zero or multiple matches fail explicitly; later semantic recovery may repair that failure but cannot silently override it.

## Scroll checkpoint contract

`progress` uses the browser's actual scrollable range (`document height - viewport height`).

`element` computes an explicit scroll target from the element rectangle and requested alignment, then remeasures the element after scrolling.

`measure` is useful after a click/navigation or another checkpoint when we want to verify framing without changing browser state.

The run preserves checkpoint order and each evidence ID so motion-heavy pages can later be replayed as a sequence rather than judged from one static screenshot.

## Geometry and human decision semantics

`horizontal_overflow` and `element_horizontal_clipping` are high-confidence browser-measured findings. `candidate_overlap` remains heuristic and non-blocking until confirmed by human or visual critique.

```text
Human accepted/rejected decision
  > deterministic analyzer refresh
  > model assumption
```

Rejected findings must not become implementation tasks.

## Security boundary

Production targets are restricted to public HTTP(S); private/reserved destinations and blocked subrequests are rejected. Browser execution should ultimately live in an isolated worker/container with egress controls, quotas, deadlines, and per-user authorization.

No arbitrary JavaScript evaluation tool is exposed to the model. Internal browser code uses fixed evaluation routines only for measurement and deterministic scrolling.

## Runtime

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

## Acceptance gates

### M1–M5

All prior real Chromium, Human Review, MCP, geometry, decision and deterministic-action gates remain mandatory.

### M6

CI must additionally prove:

1. `run_web_scroll_checkpoints` and `get_web_scroll_run` are model-visible with correct write/read annotations;
2. `progress=0` captures the top of the page and `progress=0.5` produces a materially different `scrollY` on a tall fixture;
3. an exact element requested with `align=center` is measured within a small tolerance of `center_offset_px = 0`;
4. a following `measure` checkpoint confirms the same framing without moving the page;
5. every checkpoint contains screenshot + DOM/geometry evidence;
6. exact locator semantics remain enforced;
7. all M1–M5 gates remain green.

## Next slice

M7 should build deterministic multi-step scenarios from the already-verified action and scroll primitives, with explicit evidence gates between meaningful steps. Semantic locator recovery should come after scenarios, so successful recoveries can be persisted as reusable action recipes instead of becoming one-off LLM guesses.