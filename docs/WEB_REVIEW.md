# Web Review — M1 through M12

Web Review extends Human Review with reproducible Playwright Chromium evidence, deterministic QA, multimodal critique, human decisions, baseline comparison, and a human-gated fix verification loop.

## Implemented milestones

### M1–M4 — evidence, geometry and human decisions

- real Chromium screenshots, visible DOM paths, geometry, viewport/scroll, document dimensions and browser diagnostics
- immutable review/run/evidence lineage
- deterministic overflow/clipping plus heuristic overlap findings
- stable finding fingerprints, `new|accepted|rejected` decisions and comments

### M5–M7 — bounded interaction, scroll and scenarios

- exact-one-match `click`, `fill`, `scroll_into_view`
- immutable before/after evidence
- progress/element/measure scroll checkpoints and `center_offset_px`
- bounded multi-step scenarios in one Chromium session with auditable failure state

### M8 — semantic locator recovery

- ChatGPT reasons over compact evidence and proposes deterministic candidates
- Chromium exact-one-match verification is mandatory before execution or recipe persistence
- no second LLM/API is embedded in the plugin

### M9 — multimodal visual critic

- screenshot + evidence context for ChatGPT vision
- lower-trust `visual_critic` findings with confidence capped at `0.90`
- human Accept/Reject is required before implementation

### M10 — baseline comparison

- deterministic reference/candidate deltas for matched/changed/added/removed elements, text, geometry, scroll and document size
- identical viewport requirement
- explicit reference-first / candidate-second screenshots
- `reference_critic` stores human-gated multimodal regression interpretations
- change is evidence, not automatic proof of regression

### M11 — bounded fix verification

- `create_web_fix_plan`, `get_web_fix_plan`, `record_web_fix_attempt`
- plans contain only accepted findings and freeze fingerprints, provenance, targets, comments and baseline context
- source/deploy changes remain external and separately authorized
- fresh post-fix evidence is mandatory
- automatic closure only for high-confidence `horizontal_overflow` / `element_horizontal_clipping`
- same fingerprint => `unresolved`
- fingerprint gone while target remains => `resolved`
- target disappearance => `needs_review`
- overlap/visual/baseline findings always require review

### M12 — human Fix Review completion

- `open_web_fix_review`
- private app-only `set_web_fix_item_decision`
- new `ui://widget/fix-review/v1.html` MCP Apps cockpit
- immutable automatic assessment is retained separately as `automaticStatus`
- every human decision is appended to `reviewDecisions`; reset does not erase history
- human controls are available only for items whose automatic result is `needs_review`
- automatic `resolved` and `unresolved` results are locked and cannot be overridden in the cockpit
- side-by-side immutable before/after screenshots plus change summary/reference and structural delta counts
- allowed human decisions: `resolved`, `unresolved`, `needs_review` (reset)
- latest human decision determines the effective status only for the corresponding review-required item
- final attempt status remains `unresolved > needs_review > verified`
- an automatic unresolved item always blocks final success even when all other items are human-resolved
- reviewing an older attempt does not overwrite the fix plan status produced by the latest attempt
- Fix Review can hand the final state back to ChatGPT, which must treat only `verified` as complete

## Trust hierarchy

```text
immutable browser measurement
        > explicit human decision
        > unaccepted visual/reference proposal
        > model assumption
```

Human review may resolve perceptual/heuristic uncertainty, but it cannot override a contradictory high-confidence browser result.

## Fix-loop architecture

```text
accepted findings
      ↓
create_web_fix_plan
      ↓
AUTHORIZED EXTERNAL CHANGE
      ↓
fresh Playwright evidence
      ↓
record_web_fix_attempt
      ↓
automatic assessment
  resolved / unresolved / needs_review
      ↓
open_web_fix_review
      ↓
human decisions only on needs_review
      ↓
verified | needs_review | unresolved
```

## Authorization boundary

```text
Web Review can observe, plan and verify
Web Review cannot silently modify source
Web Review cannot silently deploy
Web Review cannot merge
Human Fix Review cannot override deterministic blockers
```

External GitHub/editor/deploy integrations keep their own authorization controls.

## Fix Review resource contract

`open_web_fix_review` is model-visible and read-only. It exposes the Fix Review MCP Apps resource and immutable before/after evidence.

`set_web_fix_item_decision` is app-visible/private and widget-accessible. The model cannot invoke it directly. The store additionally rejects any attempt to use it against an automatic `resolved` or `unresolved` item.

## Acceptance gates

All M1–M11 gates remain mandatory.

M12 additionally requires CI to prove:

1. the Fix Review resource is discoverable and renders before/after evidence;
2. `open_web_fix_review` is model-visible, read-only and closed-world;
3. `set_web_fix_item_decision` is app-only/private and closed-world;
4. automatic assessment is preserved separately from human decisions;
5. resolving all review-required items may move an otherwise clean attempt to `verified`;
6. a human `unresolved` decision blocks the attempt;
7. reset returns an item to `needs_review` without deleting audit history;
8. human review cannot override automatic `resolved` / `unresolved` results;
9. an automatic unresolved result dominates human resolution of other items;
10. decisions on an older attempt do not replace the plan status of a newer attempt;
11. all prior Chromium, MCP, recovery, visual/baseline, fix-plan and AppDeploy gates remain green.

## Next slice

After M12 the core human-gated QA loop is functionally complete. The next priority should be production hardening rather than adding more reasoning features: durable storage for reviews/evidence/decisions, isolated browser-worker execution, quotas/deadlines, authorization boundaries, artifact retention, and deployment/runtime observability. Autonomous production merge/deploy should remain out of scope until those controls exist.
