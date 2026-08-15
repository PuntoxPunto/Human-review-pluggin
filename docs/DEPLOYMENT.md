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

This repository is a plain Node HTTP server. A compatible host must expose the MCP route as a real HTTPS backend endpoint and must allow POST requests to that route.

The remote MCP URL is normally:

```text
https://<deployment-host>/mcp
```

Verify `https://<deployment-host>/health` first. The response should report `ok: true`.

### AppDeploy development host

The current AppDeploy test adapter is deployed as `human-review-mcp-test-u1t0ev`.

Do **not** use the frontend URL as the ChatGPT MCP connection:

```text
https://human-review-mcp-test-u1t0ev.v2.appdeploy.ai/api/mcp
```

That hostname is served through AppDeploy's frontend CDN. An external GitHub Actions probe confirmed that GET returns the frontend HTML and POST is rejected by the CDN before the MCP backend runs.

For the development ChatGPT connection, use AppDeploy's backend gateway instead:

```text
https://api-v2.appdeploy.ai/app/human-review-mcp-test-u1t0ev/api/mcp
```

The external probe validates modern `server/discover`, `tools/list`, `resources/read`, and legacy `initialize` against that gateway.

The AppDeploy test adapter uses durable AppDeploy database storage and currently imposes a temporary 16 KB HTML limit so one review fits comfortably inside the test database record budget. The main Node implementation in this repository is not subject to that AppDeploy-specific limit.

### Current Node MVP storage warning

The Node server in this repository currently stores review sessions in process memory (`memory-ephemeral`). This is appropriate for local and first-bridge validation only. A server restart or request routed to another instance can lose a review session. Before production use, replace this with durable shared storage.

## Connect to ChatGPT

1. Deploy the server to a public HTTPS endpoint that supports MCP Streamable HTTP.
2. Verify the endpoint with MCP Inspector or an external transport probe.
3. In ChatGPT, enable Developer Mode under **Settings → Security and login**.
4. Open **ChatGPT Plugins**, select `+`, and create a development connection using the full MCP endpoint URL.
5. For the AppDeploy development connection, use `https://api-v2.appdeploy.ai/app/human-review-mcp-test-u1t0ev/api/mcp` with no authentication.
6. Review the tools and metadata ChatGPT discovers from the server.
7. After descriptor or widget changes, open the development connection and select **Refresh**.
8. Start a **new conversation**, add Human Review from the tools menu, and run the acceptance test below.

## First end-to-end acceptance test

For the AppDeploy bridge test, keep the generated static HTML below 12 KB to stay safely under the adapter's temporary 16 KB limit.

Suggested prompt:

> Create a single-file static HTML landing page for Punto Cafe with a hero, three benefits, one featured product section, and a CTA. Keep the complete HTML under 12 KB, with inline CSS and no JavaScript. After generating it, create a Human Review session and open it in the visual editor.

The test is successful when all of the following happen in one review session:

1. ChatGPT calls `create_review` and then `open_review`.
2. The Human Review widget renders the HTML inside the chat.
3. A direct text edit is autosaved through `save_review_draft`.
4. A contextual comment is added and `submit_review` returns a batch id.
5. The widget sends a follow-up message to ChatGPT.
6. ChatGPT calls `get_review_feedback` and applies the comment on top of the user-edited HTML.
7. `apply_review` accepts the result without reverting the direct edit.
8. ChatGPT calls `open_review` again and the updated HTML renders.

## Production hardening after the bridge test

- Durable cross-instance review storage in the main Node server.
- Authentication/authorization for private review sessions.
- A production host whose public domain natively supports MCP POST/streaming (do not rely on the AppDeploy frontend CDN gateway arrangement).
- Rate limits and abuse protection.
- More complete HTML sanitization and asset proxying.
- Drag handles and image resize parity with upstream Human Review.
- Review expiry/cleanup policy.
