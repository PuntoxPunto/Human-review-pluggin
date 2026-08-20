# Web Review — M1 through M7

Web Review extends Human Review with live-browser QA for public staging URLs using reproducible Playwright evidence. Human Review remains the source of truth for direct human HTML edits.

## Implemented milestones

### M1/M2 — live browser and evidence

- `create_web_review`, `capture_web_review`, `get_web_evidence`
- real Playwright Chromium capture
- screenshots, DOM paths, geometry, viewport/scroll, document dimensions, console/network errors
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

### M6 — deterministic scroll and framing evidence

- `run_web_scroll_checkpoints`, `get_web_scroll_run`
- `progress`, `element`, and `measure` checkpoints
- exact `start`, `center`, and `end` element alignment
- `center_offset_px` turns framing into measurable evidence
- checkpoint positioning remains deterministic even when the page uses `scroll-behavior:smooth`

`center_offset_px` semantics:

```text
0      exact vertical center
> 0    element center is below viewport center
< 0    element center is above viewport center
```

### M7 — deterministic multi-step scenarios

- `run_web_scenario`, `get_web_scenario_run`
- 1–20 action/scroll steps run in one Chromium session
- initial immutable evidence is captured before the first step
- every successful step produces its own screenshot + DOM/geometry evidence and findings
- browser state persists across `fill`, `click`, scroll and measurement steps
- a failing step stops the scenario rather than guessing or silently recovering
- the failure-state viewport is captured when possible
- completed steps and evidence remain auditable after a later step fails
- scenario lineage is stored separately from raw evidence

Still deferred:

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
        +-- ScenarioRunStore
        +-- Web Review MCP Apps cockpit
```

## Evidence invariant

Raw browser evidence is immutable. Findings, decisions and execution metadata reference evidence IDs.

```text
webrev_*
  +-- run_*        -> ev_*
  +-- actrun_*     -> before ev_* / after ev_*
  +-- scrollrun_*  -> checkpoint ev_* -> checkpoint ev_* -> ...
  +-- scenario_*   -> initial ev_* -> step ev_* -> step ev_* -> ...
```

A successful browser command is never equivalent to a verified result. The evidence after the command/checkpoint is the verification state.

## Locator contract

Deterministic browser operations accept only:

```text
role + accessible name
exact visible text
CSS selector
```

Every locator must match exactly one element. Zero or multiple matches fail explicitly. M7 does not contain semantic fallback.

## Scenario contract

A scenario is composed only from primitives already verified in M5/M6:

```text
initial evidence
   ↓
action or scroll step
   ↓
evidence + findings
   ↓
next step in same browser session
```

A failed step produces:

```text
scenario.status = failed
failed step index
error message
all prior completed step evidence
failure-state evidence when the page is still capturable
```

This makes a failure diagnosable instead of reducing it to a Playwright exception.

## Scroll checkpoint contract

`progress` uses the actual scrollable range. `element` computes an explicit target and remeasures after scrolling. `measure` observes framing without changing scroll.

For deterministic observation, checkpoint positioning temporarily overrides page smooth-scroll behavior only while setting the requested viewport position, then restores the page style. Visual animations are not globally disabled.

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

No arbitrary JavaScript evaluation tool is exposed to the model. Internal browser code uses fixed evaluation routines only for deterministic interaction and measurement.

## Runtime

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

## Acceptance gates

### M1–M6

All prior Chromium, Human Review, MCP, geometry, decision, action, smooth-scroll and framing gates remain mandatory.

### M7

CI must additionally prove:

1. `run_web_scenario` and `get_web_scenario_run` are model-visible with correct write/read annotations;
2. a `fill -> click -> element center -> measure` scenario retains browser state across all steps in one real Chromium session;
3. the click observes the value filled in the previous step, proving the page was not reloaded between steps;
4. scenario scroll checkpoints retain the M6 centering tolerance;
5. initial evidence and every completed step contain non-empty screenshots and structured evidence;
6. an ambiguous locator stops the scenario instead of choosing a candidate;
7. a failed scenario retains completed steps and captures the failure-state viewport when possible;
8. all M1–M6 gates remain green.

## Next slice

M8 should introduce semantic locator recovery only as a bounded fallback after deterministic resolution fails. The LLM should propose candidate locators; deterministic Playwright verification must prove exactly-one-match before execution. Successful recoveries can then be persisted as reusable recipes instead of one-off guesses.