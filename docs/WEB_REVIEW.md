# Web Review — M1 through M10

Web Review extends Human Review with live-browser QA for public staging URLs using reproducible Playwright evidence. Human Review remains the source of truth for direct human HTML edits.

## Implemented milestones

### M1/M2 — live browser and evidence

- real Playwright Chromium capture with screenshot, DOM paths, geometry, viewport/scroll, document dimensions and browser diagnostics
- explicit `review -> run -> evidence` lineage
- public HTTP(S)/SSRF boundary

### M3/M4 — geometry, cockpit and human decisions

- deterministic overflow/clipping and heuristic overlap findings
- evidence-scoped FindingStore and Web Review MCP Apps cockpit
- stable finding fingerprints, `new|accepted|rejected`, persistent comments
- human decisions survive analyzer refreshes

### M5/M6 — bounded actions and scroll/framing

- exact-one-match `click`, `fill`, `scroll_into_view`
- before/after evidence
- progress/element/measure scroll checkpoints
- measurable `center_offset_px`
- deterministic checkpoint positioning even with page smooth-scroll CSS

### M7 — multi-step scenarios

- 1–20 bounded action/scroll steps in one Chromium session
- initial and per-step evidence
- state persists across steps
- ambiguous locator stops the scenario while retaining prior and failure-state evidence

### M8 — bounded semantic locator recovery

- compact recovery context from immutable visible evidence
- ChatGPT proposes; Chromium verifies exact-one-match
- non-mutating verification with `scroll_into_view`
- only verified candidates may create reusable recipes
- recipe verification count and intent-aware identity

### M9 — human-gated multimodal visual critic

- `get_web_visual_critic_context`
- `submit_web_visual_findings`
- ChatGPT performs multimodal judgment over immutable evidence; the plugin does not call another model/API
- visual proposals are `info|warning|error`, confidence capped at `0.90`
- provenance partitioning: `deterministic` and `visual_critic`
- refreshing one source never deletes the other
- cockpit v3 distinguishes measured vs perceptual findings

### M10 — reference / baseline comparison

- `compare_web_evidence`
- `get_web_reference_comparison`
- `submit_web_reference_findings`
- compares two immutable evidence snapshots only when viewport dimensions are identical
- reference and candidate may belong to different Web Reviews / staging URLs
- deterministic comparison reports matched, added, removed and materially changed DOM targets
- changed targets include exact position/size deltas plus text-change state
- comparison also reports scroll and document-dimension deltas
- the comparison result is stored separately from findings and preserves the raw objective delta history
- both screenshots are returned in explicit order: reference first, candidate second
- a raw difference is never automatically classified as a regression
- ChatGPT may interpret the pair multimodally and submit `reference_critic` proposals
- `reference_critic` severity is limited to `info|warning|error`; confidence is capped at `0.90`
- optional target paths must resolve exactly one element in the candidate evidence
- `reference_critic` findings are stored on the candidate evidence and require Human Accept/Reject before implementation
- the active baseline interpretation replaces only the candidate's `reference_critic` partition; deterministic and `visual_critic` findings are preserved
- reference fingerprints include `comparisonId`, so decisions survive re-submission of the same comparison but do not leak to a different baseline
- cockpit v4 renders three provenance classes: deterministic, visual critic and baseline critic

## Architecture

```text
ChatGPT semantic + multimodal reasoning
  |
  +-- Playwright / Chromium
  |     +-- immutable EvidenceStore
  |     +-- geometry measurements
  |     +-- actions / scroll / scenarios
  |
  +-- semantic recovery
  |     +-- candidate reasoning
  |     +-- exact Chromium verification
  |     +-- reusable recipes
  |
  +-- visual review
  |     +-- visual_critic
  |     +-- human decisions
  |
  +-- baseline review
        +-- reference evidence
        +-- candidate evidence
        +-- deterministic structural deltas
        +-- multimodal reference_critic
        +-- human decisions
```

## Evidence and trust invariant

Raw browser evidence is immutable. Derived interpretation never changes the underlying screenshots or browser measurements.

```text
browser measurement / exact evidence
        > accepted human interpretation
        > unaccepted visual/reference critic proposal
        > model assumption
```

A raw difference between baseline and candidate proves change, not defect.

## Baseline comparison contract

A valid comparison requires identical viewport width and height. This prevents the system from presenting responsive-layout differences as if they were regressions from one state.

```text
reference evidence
       +
 candidate evidence
       ↓
compare_web_evidence
       ↓
objective deltas
  matched / changed
  added / removed
  scroll delta
  document delta
       +
reference screenshot → candidate screenshot
       ↓
ChatGPT multimodal interpretation
       ↓
submit_web_reference_findings
       ↓
reference_critic on candidate
       ↓
Human Accept / Reject / Comment
```

The reference and candidate can come from different URLs or reviews, which permits approved-production-vs-staging and previous-release-vs-current comparisons.

### Material geometry delta

For a matched DOM path, M10 records a changed element when text changes or when position/size changes by more than 2 px on any measured axis.

```text
dx = candidate.left   - reference.left
dy = candidate.top    - reference.top
dw = candidate.width  - reference.width
dh = candidate.height - reference.height
```

These values are evidence. Whether the movement is desirable remains a review decision.

## Finding provenance

```text
deterministic      browser-measured single-state issues
visual_critic      perceptual issues in one evidence snapshot
reference_critic   perceptual regression interpretation against a baseline
```

Source partitions cannot overwrite one another. Human decisions/comments survive matching reanalysis within the same provenance and comparison context.

## Cockpit v4

```text
solid overlay    deterministic
dashed overlay   visual critic
dotted overlay   baseline critic
```

All three use the same Human Accept / Reject / Reset / Comment workflow. The handoff back to ChatGPT explicitly requires acting only on accepted findings.

## Security boundary

Production targets remain restricted to public HTTP(S); private/reserved destinations and blocked subrequests are rejected. No arbitrary JavaScript evaluation tool is exposed to the model. Baseline comparison operates only on evidence already captured by the bounded browser layer.

## Acceptance gates

All M1–M9 gates remain mandatory.

M10 additionally requires CI to prove:

1. `compare_web_evidence`, `get_web_reference_comparison`, and `submit_web_reference_findings` are discoverable with correct closed-world read/write annotations;
2. identical viewport dimensions are mandatory;
3. deterministic comparison correctly separates matched, changed, added and removed elements;
4. text changes and measurable geometry deltas are preserved as explicit evidence;
5. scroll and document-size differences are reported separately;
6. stored comparison metadata preserves reference/candidate evidence lineage;
7. `reference_critic` decisions/comments survive re-submission of the same comparison;
8. a different comparison ID does not inherit a previous baseline decision;
9. deterministic and visual-critic partitions survive reference-critic refreshes;
10. cockpit v4 exposes baseline provenance and source-aware human handoff;
11. all previous Human Review, Chromium, semantic recovery, visual critic and AppDeploy gates remain green.

## Next slice

M11 should begin the bounded correction loop: convert only accepted findings into a fix plan, modify a candidate artifact through an authorized code/deploy integration, capture fresh evidence, and compare the post-fix candidate against its pre-fix evidence/baseline before declaring success. The first version should remain human-gated and stop before any autonomous merge or production deployment.
