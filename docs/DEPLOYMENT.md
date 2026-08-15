# Deployment and ChatGPT connection

## Local validation

```bash
npm install
npm run check
npm test
npm start
```

The server listens on `PORT` (default `8787`) and exposes:

- `GET /health` — health and storage-mode metadata.
- `POST|GET|DELETE /mcp` — MCP Streamable HTTP endpoint.

For local MCP inspection, point the MCP Inspector at `http://localhost:8787/mcp`.

## Hosted preview

This repository is a plain Node HTTP server. On Vercel, import the GitHub repository and use the default Node runtime. The server calls `listen(process.env.PORT)`, which Vercel captures for backend-framework deployments.

The remote MCP URL is:

```text
https://<deployment-host>/mcp
```

Verify `https://<deployment-host>/health` first. The response should report `ok: true`.

### Current MVP storage warning

Review sessions are currently stored in process memory (`memory-ephemeral`). This is appropriate for local and first-bridge validation only. A server restart or request routed to another instance can lose a review session. Before production use, replace this with durable shared storage.

## Connect to ChatGPT

1. Deploy the server to a public HTTPS URL.
2. Verify `/health`.
3. In ChatGPT, enable Developer Mode under the app/plugin advanced settings available to your account.
4. Create a development app/plugin pointing to `https://<deployment-host>/mcp`.
5. Refresh/reload the app after changes to tool descriptors or widget metadata.
6. Ask ChatGPT to create a simple HTML document and open it in Human Review.

## First end-to-end acceptance test

The test is successful when all of the following happen in one review session:

1. ChatGPT calls `create_review` and then `open_review`.
2. The Human Review widget renders the HTML.
3. A direct text edit is autosaved through `save_review_draft`.
4. A comment is added and `submit_review` returns a batch id.
5. The widget sends a follow-up message to ChatGPT.
6. ChatGPT calls `get_review_feedback` and applies the comment on top of the user-edited HTML.
7. `apply_review` accepts the result without reverting the direct edit.
8. ChatGPT calls `open_review` again and the updated HTML renders.

## Production hardening after the bridge test

- Durable cross-instance review storage.
- Authentication/authorization for private review sessions.
- Rate limits and abuse protection.
- More complete HTML sanitization and asset proxying.
- Drag handles and image resize parity with upstream Human Review.
- Review expiry/cleanup policy.
