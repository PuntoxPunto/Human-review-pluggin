# Web Review — M1 through M9

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

- `get_web_visual_critic_context` returns the immutable screenshot plus compact visible-element anchors
- ChatGPT itself performs the multimodal judgment; the plugin does not make a second model/API call
- `submit_web_visual_findings` stores structured perceptual proposals tied to the selected evidence
- visual proposals may be page-level or anchored to an exact evidence path/selector
- optional target/related anchors must resolve exactly one evidence element
- visual finding severity is restricted to `info|warning|error`; visual proposals cannot self-declare `critical`
- visual confidence is capped at `0.90`
- FindingStore is partitioned by provenance: `deterministic` and `visual_critic`
- refreshing one source never deletes the other source
- fingerprints include source so deterministic and perceptual findings cannot collide
- human Accept/Reject/comments survive re-submission within each source
- submitting visual findings ensures a deterministic geometry partition exists for the evidence
- cockpit v3 shows source badges and uses solid overlays for deterministic findings, dashed overlays for visual-critic findings
- the cockpit explicitly labels visual findings as lower-trust until a human accepts them

Still deferred:

- automatic recovery/replay inside a failed stateful scenario;
- reference/baseline comparison;
- autonomous fix/deploy/retest.

## Architecture

```text
ChatGPT semantic + multimodal reasoning
  |
  +-- deterministic Human/Web Review tools
  |     +-- BrowserRunner -> Playwright / Chromium
  |     +-- EvidenceStore
  |     +-- Geometry Analyzer
  |     +-- actions / scroll / scenarios
  |     +-- recovery verification / recipes
  |
  +-- visual critic protocol
        +-- immutable screenshot context
        +-- structured visual proposals
        +-- FindingStore source partition
        +-- human accept / reject / comments
        +-- Web Review cockpit v3
```

## Evidence and trust invariant

Raw browser evidence is immutable. Every derived layer references an evidence ID.

```text
browser measurement / evidence
        > accepted human interpretation
        > unaccepted visual-critic proposal
        > model assumption
```

Human decisions control whether a derived finding becomes an implementation task. A rejected finding must never be applied.

## Finding provenance

Every stored finding has a source:

```text
deterministic
visual_critic
```

`replaceForEvidence(... source="deterministic")` replaces only deterministic findings. `source="visual_critic"` replaces only visual proposals. Matching fingerprints preserve IDs, decisions and comments within that source.

This prevents a geometry refresh from erasing multimodal review and prevents a new critic pass from rewriting browser-measured truth.

## Visual critic protocol

```text
select immutable evidence / checkpoint
        ↓
get_web_visual_critic_context
        ↓
ChatGPT inspects screenshot + anchors
        ↓
submit_web_visual_findings
        ↓
visual_critic findings in cockpit
        ↓
human Accept / Reject / Comment
        ↓
accepted findings may become implementation work
```

The critic should identify perceptual problems geometry alone cannot prove: weak hierarchy, inconsistent spacing rhythm, poor composition, typography imbalance, low perceived contrast, awkward animation state, confusing affordance, visually undesirable overlap, or reference mismatch.

It should not duplicate deterministic overflow/clipping merely because those issues are already visible in the screenshot.

## Locator and recovery contract

Normal browser execution still requires exact role+name, exact visible text, or CSS with exactly one match. Semantic recovery can propose a candidate but cannot execute it until deterministic Chromium verification succeeds.

## Scroll/framing semantics

`center_offset_px = 0` means exact vertical center; positive means too low and negative means too high. Positioning checkpoints temporarily neutralize smooth-scroll only to choose the observation state; visual animations remain enabled.

## Cockpit v3

The cockpit displays deterministic and visual findings together but keeps their provenance visible:

```text
solid overlay   deterministic
 dashed overlay  visual critic
```

Both sources use the same human decision workflow. The UI handoff instructs ChatGPT to act only on accepted findings and to treat deterministic measurements as stronger evidence than unaccepted critic proposals.

## Security boundary

Production targets remain restricted to public HTTP(S); private/reserved destinations and blocked subrequests are rejected. No arbitrary JavaScript evaluation tool is exposed to the model. Browser execution should ultimately run in an isolated worker/container with egress controls, quotas and authorization.

## Acceptance gates

All M1–M8 gates remain mandatory.

M9 additionally requires CI to prove:

1. `get_web_visual_critic_context` is model-visible, read-only and closed-world;
2. `submit_web_visual_findings` is model-visible, state-writing, closed-world and idempotent;
3. the Web Review resource is independently versioned to cockpit v3;
4. deterministic and visual partitions coexist without overwriting one another;
5. deterministic refresh preserves visual findings and their human decisions/comments;
6. visual re-submission preserves matching visual finding decisions/comments and leaves deterministic findings untouched;
7. source-aware summary counts remain correct;
8. visual schema excludes `critical` severity and caps confidence at 0.90;
9. cockpit v3 renders deterministic/visual provenance and source-aware handoff language;
10. all prior Human Review, Chromium, recovery and AppDeploy gates remain green.

## Next slice

M10 should add reference/baseline comparison: associate evidence with a reference screenshot or prior accepted evidence, compare the same viewport/checkpoint states, and let the multimodal critic propose evidence-backed differences without turning raw pixel difference into automatic design truth.