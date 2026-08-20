# Web Review — M1 through M11

Web Review extends Human Review with live-browser QA for public staging URLs using reproducible Playwright evidence. Human Review remains the source of truth for direct human edits and explicit QA decisions.

## Implemented milestones

### M1–M4 — browser evidence, geometry and human decisions

- real Playwright Chromium screenshots, visible DOM paths, geometry, viewport/scroll, document dimensions and browser diagnostics
- immutable `review -> run -> evidence` lineage
- deterministic overflow/clipping and heuristic overlap findings
- stable findings with `new|accepted|rejected` decisions and persistent comments

### M5–M7 — deterministic interaction, scroll and scenarios

- exact-one-match `click`, `fill`, `scroll_into_view`
- before/after evidence
- progress/element/measure scroll checkpoints with measurable `center_offset_px`
- 1–20 bounded action/scroll steps in one Chromium session
- ambiguous locators stop execution and preserve failure evidence

### M8 — bounded semantic locator recovery

- ChatGPT proposes locator candidates from compact immutable evidence
- Chromium must verify exactly one match before a candidate can be used or persisted as a recipe
- recovery verification is non-mutating and no second model/API is embedded in the plugin

### M9 — human-gated multimodal visual critic

- `get_web_visual_critic_context`
- `submit_web_visual_findings`
- ChatGPT inspects immutable screenshots and submits lower-trust perceptual findings
- visual severity is limited to `info|warning|error`, confidence capped at `0.90`
- visual findings require human Accept/Reject before implementation

### M10 — reference / baseline comparison

- `compare_web_evidence`
- `get_web_reference_comparison`
- `submit_web_reference_findings`
- identical viewport dimensions are required
- deterministic matched/changed/added/removed DOM deltas, text changes, geometry deltas, scroll deltas and document-size deltas
- explicit screenshot order: reference first, candidate second
- measured difference proves change, not regression
- `reference_critic` stores human-gated multimodal baseline interpretations
- cockpit v4 displays deterministic, visual and baseline provenance separately

### M11 — human-gated fix verification loop

- `create_web_fix_plan`
- `get_web_fix_plan`
- `record_web_fix_attempt`
- fix plans freeze only findings whose human status is `accepted`
- a plan snapshots the finding fingerprint, provenance, target, description, comments and baseline context before any code change
- the plugin does **not** edit source code, deploy, merge, or claim that an external change happened
- code/deploy changes must occur through a separately authorized integration; the resulting public/staging state must then be captured as fresh Web Review evidence
- `record_web_fix_attempt` compares original evidence to fresh post-fix evidence and stores the change summary/reference supplied by the authorized external workflow
- post-fix verification re-runs deterministic geometry and returns original screenshot first, post-fix screenshot second
- automatic closure is intentionally limited to high-confidence `horizontal_overflow` and `element_horizontal_clipping`
- an eligible deterministic finding is `resolved` only when its original target still exists and its exact fingerprint no longer reproduces
- if the same fingerprint still exists, the item is `unresolved`
- if the original target disappears, the item is `needs_review`; disappearance alone is never accepted as proof of a fix
- heuristic `candidate_overlap`, `visual_critic` and `reference_critic` findings always remain `needs_review` until fresh multimodal/human verification
- overall attempt status is `unresolved` if any item persists, otherwise `needs_review` if any item still needs judgment, otherwise `verified`
- every attempt is retained in `FixPlanStore` with post-fix evidence lineage and optional external commit/deploy reference

## Architecture

```text
Human decision
    ↓
accepted findings
    ↓
create_web_fix_plan
    ↓
frozen fix plan / evidence baseline
    ↓
AUTHORIZED EXTERNAL CHANGE
(GitHub / editor / deploy system outside Web Review)
    ↓
fresh Playwright evidence
    ↓
record_web_fix_attempt
    ├─ deterministic geometry recheck
    ├─ pre/post structural comparison
    ├─ screenshots before/after
    └─ conservative resolution gate
          ↓
   verified | needs_review | unresolved
```

The plugin is a verifier and evidence system, not an unbounded code-execution agent.

## Evidence and trust hierarchy

```text
immutable browser measurement
        > explicit human decision
        > unaccepted visual/reference proposal
        > model assumption
```

A successful browser action is not proof of correctness. A changed screenshot is not proof of improvement. A disappeared DOM target is not proof that a bug was fixed.

## Finding provenance

```text
deterministic      browser-measured single-state findings
visual_critic      perceptual findings over one screenshot
reference_critic   perceptual regression findings against a baseline
```

Source partitions cannot overwrite one another. Human comments and decisions survive matching source refreshes.

## M11 verification policies

### `deterministic_recheck`

Currently limited to:

```text
horizontal_overflow
element_horizontal_clipping
```

These findings have a sufficiently direct browser-measurement interpretation for bounded automatic closure.

### `human_recheck`

Used for:

```text
candidate_overlap
visual_critic
reference_critic
```

These require contextual/perceptual judgment and therefore cannot turn an attempt into `verified` without a later review step.

## Security / authorization boundary

Production browser targets remain public HTTP(S) only; private/reserved destinations and blocked subrequests are rejected. No arbitrary JavaScript evaluation tool is exposed. M11 also preserves a strict write boundary:

```text
Web Review can plan + verify
Web Review cannot silently modify source
Web Review cannot silently deploy
Web Review cannot merge
```

Any source/deploy integration used by ChatGPT must retain its own authorization and change controls.

## Acceptance gates

All M1–M10 gates remain mandatory.

M11 additionally requires CI to prove:

1. `create_web_fix_plan`, `get_web_fix_plan` and `record_web_fix_attempt` are model-visible and closed-world with correct read/write annotations;
2. default plan selection includes only accepted findings;
3. explicitly selecting a `new` or `rejected` finding fails;
4. frozen plan items retain provenance, comments, target and baseline identifiers;
5. only high-confidence overflow/clipping receive `deterministic_recheck` policy;
6. heuristic overlap, visual and baseline findings receive `human_recheck`;
7. a reproduced deterministic fingerprint yields `unresolved`;
8. an absent fingerprint with the same original target yields `resolved`;
9. target disappearance yields `needs_review`, never automatic success;
10. overall status precedence is `unresolved > needs_review > verified`;
11. attempt history preserves change summary/reference and evidence lineage;
12. pre/post viewport mismatch remains rejected by the M10 comparison contract;
13. all prior Human Review, Chromium, recovery, visual/baseline critic and AppDeploy gates remain green.

## Next slice

M12 should close the perceptual side of the fix loop: attach a fresh visual/baseline review to a specific fix attempt, allow explicit human confirmation of `needs_review` items, and compute a final attempt verdict without weakening the deterministic evidence rules. Source modification/deployment should remain externally authorized; autonomous production merge/deploy remains out of scope.
