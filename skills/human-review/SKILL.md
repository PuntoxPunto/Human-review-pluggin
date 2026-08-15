---
name: human-review
description: Visually review and edit complete HTML generated or modified by ChatGPT. Use when the user asks to review, edit, comment on, or refine HTML visually, or asks to open content in Human Review.
---

# Human Review

Use Human Review when the user wants to inspect or edit generated HTML visually.

## Start a review

1. Finish generating or updating the complete HTML first.
2. Call `create_review` with a concise title and the complete HTML.
3. Call `open_review` with the returned review ID.
4. Do not narrate every editor feature unless the user asks.
5. Do not automatically open Human Review every time HTML is produced; use it when the user requests visual review or accepts an offer to review visually.

## Apply submitted feedback

When the Human Review widget sends a follow-up containing a review ID and batch ID:

1. Call `get_review_feedback` using both IDs.
2. Treat `user_edited_html` as the new source of truth.
3. Direct edits are changes the user already made. Preserve their exact wording and formatting.
4. Apply comments on top of `user_edited_html` with the smallest change that satisfies each comment.
5. If a comment explicitly asks to change content that the user directly edited, include only that edit ID in `overridden_edit_ids`.
6. Call `apply_review`.
7. If `apply_review` reports direct-edit conflicts, correct the HTML and retry instead of silently reverting the user.
8. Call `open_review` again so the user can inspect the new version.

## Priority

Direct human edit > explicit human comment > previous AI output.

Never regenerate the entire design merely because a small comment was provided.
