# Web Review Browser Worker

M13 separates Chromium execution from the ChatGPT MCP process. The MCP can remain on a lightweight app runtime while Playwright runs in an isolated worker/container.

## Runtime split

```text
ChatGPT
  ↓
Human/Web Review MCP
  ↓ HTTPS + Bearer token
Browser Worker
  ↓
Playwright / Chromium
  ↓
public staging URL
```

The worker exposes only:

- `GET /health`
- `POST /v1/browser/run`

Allowed operations are fixed to `capture`, `runAction`, `runScrollCheckpoints`, and `runScenario`. No arbitrary JavaScript/evaluate endpoint is exposed.

## MCP configuration

Production entrypoint is `npm start` (`server-entry.js`).

Set:

```text
WEB_REVIEW_BROWSER_MODE=remote
WEB_REVIEW_BROWSER_RUNNER_URL=https://browser-worker.example.com
WEB_REVIEW_BROWSER_RUNNER_TOKEN=<strong shared secret, >=16 chars>
WEB_REVIEW_BROWSER_REQUEST_TIMEOUT_MS=75000
```

`WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE=true` exists only for local tests/dev. Production remote transport requires HTTPS.

`npm run start:mcp-local` bypasses the loader and keeps the original local Chromium behavior for development/debugging.

## Worker configuration

Required:

```text
BROWSER_WORKER_TOKEN=<same strong secret>
```

Optional:

```text
PORT=8890
BROWSER_WORKER_MAX_CONCURRENCY=2
BROWSER_WORKER_MAX_BODY_BYTES=524288
BROWSER_WORKER_MAX_OPERATION_TIMEOUT_MS=45000
```

`BROWSER_WORKER_ALLOW_PRIVATE=true` is test-only. Production defaults to public HTTP(S) targets and retains the existing DNS/IP SSRF checks for every browser subrequest.

## Docker

Build:

```text
docker build -f Dockerfile.browser-worker -t web-review-browser-worker .
```

Run behind an HTTPS reverse proxy:

```text
docker run --rm \
  -e BROWSER_WORKER_TOKEN='<secret>' \
  -e BROWSER_WORKER_MAX_CONCURRENCY=2 \
  -p 8890:8890 \
  web-review-browser-worker
```

The image uses the matching Playwright Chromium runtime and runs as the non-root `pwuser`.

## Security boundary

The worker is not a general browser automation API. It intentionally keeps:

- bearer-token authentication;
- fixed operation allowlist;
- bounded request body;
- bounded operation timeout forwarded to Playwright;
- bounded concurrency with HTTP 429 when saturated;
- public-target SSRF policy and blocked unsafe subrequests;
- no browser credentials/cookies supplied by the MCP;
- no arbitrary `evaluate()` or script execution tool exposed over HTTP.

The token should be stored as a deployment secret and never placed in source, MCP structured content, screenshots, or review evidence.

## Current M13 limitation

M13 creates the isolation boundary but does not yet provide a durable queue or hard process-level kill for a Chromium job that outlives its internal Playwright timeout. The next hardening layer should add worker/job observability, request IDs, durable persistence for review state/artifacts, rate quotas per principal, and process/container-level execution deadlines.
