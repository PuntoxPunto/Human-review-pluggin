# Web Review — M1 through M8

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
- deterministic checkpoint positioning even with page smooth-scroll CSS

### M7 — deterministic multi-step scenarios

- `run_web_scenario`, `get_web_scenario_run`
- 1–20 action/scroll steps in one Chromium session
- initial evidence plus evidence after every completed step
- state persists across fill/click/scroll/measure
- ambiguous locator stops the scenario and preserves prior/failure evidence

### M8 — bounded semantic locator recovery

- `get_web_locator_recovery_context`
- `verify_web_locator_recovery`
- `get_web_locator_recipes`
- recovery context ranks a compact shortlist from immutable visible evidence
- ChatGPT is the semantic reasoning layer; the plugin does not call a second LLM/API
- candidates expose role/name, text, and CSS-path locator options
- PT-BR/Spanish accented hints are normalized for ranking
- a proposed candidate is never trusted until Chromium proves exactly one match
- verification uses only the bounded `scroll_into_view` primitive: it does not click or fill
- verification produces fresh evidence whether the candidate succeeds or remains ambiguous
- only successful exact-one-match verification may create/update a reusable recipe
- recipe identity includes review, URL, failed locator and target intent
- repeated verification updates the same recipe and increments its verification count

Still deferred:

- automatic replay/recovery inside a failed multi-step scenario;
- visual LLM critic;
- reference comparison;
- autonomous fix/deploy/retest.

## Architecture

```text
ChatGPT semantic reasoning
  |
  +-- deterministic Human/Web Review tools
        +-- BrowserRunner -> Playwright / Chromium
        +-- EvidenceStore
        +-- Geometry Analyzer / FindingStore
        +-- ActionRunStore / ScrollRunStore / ScenarioRunStore
        +-- RecoveryRecipeStore
        +-- Web Review MCP Apps cockpit
```

## Evidence invariant

Raw browser evidence is immutable. Findings, human decisions, execution metadata and recovery recipes reference evidence IDs.

```text
webrev_*
  +-- run_*        -> ev_*
  +-- actrun_*     -> before ev_* / after ev_*
  +-- scrollrun_*  -> checkpoint ev_* -> ...
  +-- scenario_*   -> initial ev_* -> step ev_* -> ...
  +-- recipe_*     -> verified locator + verification ev_*
```

A successful browser command or model suggestion is never equivalent to a verified result.

## Locator and recovery contract

Normal execution accepts only role+accessible-name, exact visible text, or CSS selector and requires exactly one match.

Recovery is deliberately separated:

```text
deterministic locator fails
        ↓
select immutable evidence
        ↓
get_web_locator_recovery_context
        ↓
ChatGPT reasons over screenshot + compact candidates
        ↓
proposed deterministic locator
        ↓
verify_web_locator_recovery
        ↓
exactly one Chromium match?
   no ──────── yes
   ↓            ↓
refine       optional recipe
                ↓
         run bounded action
```

The recovery context only contains elements visible in the selected evidence snapshot. If the intended target belongs to another scroll state, capture/select the appropriate M6/M7 evidence first. This keeps context compact instead of sending the entire DOM to the model.

A verified recipe is an evidence-backed hint, not a permanent bypass. Re-verify when route, page state, markup or UI version may have changed.

## Scroll/framing semantics

`center_offset_px = 0` means exact vertical center; positive means too low and negative means too high. Checkpoint positioning temporarily overrides smooth-scroll only while selecting the observation state, then restores page behavior. Visual animations remain enabled.

## Geometry and human decisions

`horizontal_overflow` and `element_horizontal_clipping` are high-confidence browser evidence. `candidate_overlap` remains heuristic until human/visual confirmation.

```text
Human accepted/rejected decision
  > deterministic analyzer refresh
  > model assumption
```

## Security boundary

Production targets are restricted to public HTTP(S); private/reserved destinations and blocked subrequests are rejected. No arbitrary JavaScript evaluation tool is exposed to the model. Browser execution should ultimately live in an isolated worker/container with explicit egress controls, quotas and authorization.

## Acceptance gates

M1–M7 gates remain mandatory.

M8 additionally requires CI to prove:

1. recovery context, verification and recipe tools are discoverable with correct read/write/open-world annotations;
2. semantic ranking prefers the intended interactive element from compact evidence;
3. accented PT-BR hints normalize correctly;
4. a unique candidate can be verified in real Chromium with `scroll_into_view` without triggering click/fill side effects;
5. an ambiguous candidate still fails the exact-one-match gate;
6. repeated verification preserves recipe identity and increments verification count;
7. changing recovery intent creates a distinct recipe;
8. all M1–M7 tests and the AppDeploy transport probe remain green.

## Next slice

M9 should add a visual critic over selected immutable evidence and scroll/scenario checkpoints. The critic should produce proposed visual findings with lower trust than deterministic geometry, then feed those proposals through the existing human accept/reject workflow before any fix loop.