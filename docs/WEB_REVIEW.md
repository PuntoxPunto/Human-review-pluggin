# Web Review — M1 through M5

Web Review extends Human Review with live-browser QA for public staging URLs using reproducible Playwright evidence. Human Review remains the source of truth for direct human HTML edits.

## Implemented milestones

### M1/M2 — live browser and evidence

- `create_web_review`
- `capture_web_review`
- `get_web_evidence`
- real Playwright Chromium capture
- screenshot, DOM paths, geometry, viewport/scroll, document dimensions, console/network errors
- explicit `review -> run -> evidence` lineage
- SSRF-oriented public target and subrequest policy
- real Chromium CI fixture

### M3 — geometry findings and cockpit

- deterministic `horizontal_overflow` and `element_horizontal_clipping`
- heuristic non-blocking `candidate_overlap`
- `analyze_web_geometry`
- immutable evidence-scoped `FindingStore`
- `open_web_review`
- Web Review MCP Apps screenshot/finding cockpit

### M4 — human QA decisions

- stable finding fingerprints based on type + DOM target identity
- `new`, `accepted`, `rejected` decisions
- persistent finding comments
- analyzer refresh preserves human decisions/comments
- private `set_web_finding_decision`
- model-visible `get_web_findings`
- cockpit v2 Accept / Reject / Reset / Add comment / Send decisions

### M5 — deterministic browser actions

- `run_web_action`
- `get_web_action_run`
- bounded actions: `click`, `fill`, `scroll_into_view`
- deterministic locators only: exact `role + name`, exact text, or CSS
- locator must resolve exactly one element; zero or multiple matches fail instead of guessing
- each action captures immutable before and after evidence in the same browser session
- the exact resolved locator is stored with the action run
- after evidence receives geometry findings and becomes the latest review evidence
- real Chromium tests prove DOM state changes after an exact click and rejection of ambiguous locators

Still deferred:

- multi-step scenario orchestration;
- scroll/motion sampling checkpoints;
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
        |
        +-- WebReviewStore
        +-- BrowserRunner
        |     Playwright -> Chromium
        +-- EvidenceStore
        +-- Geometry Analyzer
        +-- FindingStore
        +-- ActionRunStore
        +-- Web Review MCP Apps cockpit
```

## Evidence invariant

Raw browser evidence is immutable. Findings, human decisions, and action metadata are separate layers that reference evidence IDs.

```text
webrev_* -> run_* / actrun_* -> ev_*
```

For deterministic actions:

```text
before evidence
      ↓
exact locator resolution
      ↓
click / fill / scroll_into_view
      ↓
after evidence
      ↓
geometry analysis
```

An action is never considered verified merely because Playwright returned without throwing; the after evidence is the verification state.

## Locator contract

M5 deliberately does not ask an LLM to improvise element selection.

Allowed strategies:

```text
role + accessible name
exact visible text
CSS selector
```

The locator must match exactly one element. Ambiguity is an explicit failure and should later trigger semantic recovery rather than silent fallback.

The action run records the locator request plus the element actually matched (`tag`, text hint, ARIA label) so future recipe/recovery work has an auditable baseline.

## Geometry semantics

`horizontal_overflow` and `element_horizontal_clipping` are high-confidence browser-measured findings. `candidate_overlap` remains heuristic and non-blocking until confirmed by human or visual critique.

## Human decision priority

```text
Human accepted/rejected decision
  > deterministic analyzer refresh
  > model assumption
```

A rejected finding must not become an implementation task. Accepted findings and explicit human comments may be handed back to ChatGPT via `get_web_findings`.

## Security boundary

Production targets are restricted to public HTTP(S). Local/private/link-local/reserved destinations and blocked browser subrequests are rejected. Browser execution should ultimately live in an isolated worker/container with explicit egress controls, quotas, deadlines, and per-user authorization.

M5 does not expose arbitrary JavaScript evaluation through MCP. Browser mutation is limited to the three bounded action types above.

## Runtime

```bash
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

## Acceptance gates

### M1/M2

Real Chromium navigation/capture, evidence lineage, SSRF policy, original Human Review loop.

### M3

Geometry detection, DOM containment semantics, dual MCP Apps discovery, cockpit routing.

### M4

Decision tool visibility, v2 cockpit, persistent human decisions/comments, Human Review and Chromium regression gates.

### M5

CI must additionally prove:

1. `run_web_action` and `get_web_action_run` are model-visible with correct write/read annotations;
2. exact role+name click changes the DOM between before and after evidence in real Chromium;
3. before and after both contain screenshots and structured DOM evidence;
4. the action run stores the exact matched element descriptor;
5. ambiguous locators fail before mutation instead of choosing one candidate;
6. no arbitrary evaluation/action primitive is exposed to the model;
7. all M1-M4 gates remain green.

## Next slice

M6 should add deterministic multi-step scenarios and scroll/motion checkpoints. A scenario should be a sequence of already-verified action primitives with evidence at each important step. Only after that should semantic recovery be introduced to repair stale/ambiguous locators and persist successful resolutions as action recipes.