# Human Review for ChatGPT

A visual HTML review plugin for ChatGPT. The model creates HTML, the plugin opens it in an editable review UI, the user makes direct edits and anchored comments, and ChatGPT applies the feedback without reverting human changes.

## v0.1 scope

- MCP server with six tools: `create_review`, `open_review`, `save_review_draft`, `submit_review`, `get_review_feedback`, `apply_review`
- MCP Apps widget rendered inside ChatGPT
- Direct text editing in a sandboxed preview
- Selection and block comments
- Move up/down and delete block controls
- Desktop/mobile preview and fullscreen request
- Autosave and one-batch feedback submission
- Direct-edit conflict guard when ChatGPT applies feedback
- Companion `skills/human-review/SKILL.md`

State is in-memory in v0.1 and resets when the server restarts.

## Architecture

```text
ChatGPT
  -> create_review (model tool)
  -> open_review (render tool)
       -> Human Review widget
            -> save_review_draft (app-only tool)
            -> submit_review (app-only tool)
            -> follow-up message to ChatGPT
  -> get_review_feedback (model tool)
  -> apply_review (model tool)
  -> open_review
```

The widget follows the MCP Apps bridge first (`ui/initialize`, `tools/call`, `ui/notifications/tool-result`) and uses `window.openai` only for ChatGPT-specific fullscreen and follow-up-message helpers.

## Run locally

Requirements: Node 20+.

```bash
npm install
npm start
```

The MCP endpoint is:

```text
http://localhost:8787/mcp
```

Use MCP Inspector for local tool testing:

```bash
npx @modelcontextprotocol/inspector@latest
```

To test inside ChatGPT, expose port `8787` through an HTTPS tunnel and add the resulting `https://.../mcp` endpoint as a developer plugin.

## Security model (MVP)

The reviewed page is loaded into a nested iframe with `sandbox="allow-same-origin"` and **without** `allow-scripts`, `allow-forms`, `allow-popups`, or top-navigation permissions. The parent review widget owns editing event handlers. The server also strips active-content tags, inline event handlers, executable URLs, and selected network-loading tags before storing HTML.

This is an MVP security boundary, not a production security review. Before public distribution we should add adversarial HTML tests, stronger parsing/sanitization, durable per-user storage/auth, rate limits, and submission-specific CSP/domain hardening.

## Upstream attribution

The anchoring model and parts of the interaction design are adapted from Peter Yang's `petergyang/human-review`, released under the MIT License. See `THIRD_PARTY_NOTICES.md`.

## Current limitations

- Static HTML/CSS only; no live React/Next.js application editing yet
- In-memory review storage
- No pasted image asset pipeline yet
- Move controls are up/down buttons in v0.1 (drag handles can be ported next)
- Direct-edit conflict detection currently protects edited text, not every structural mutation
