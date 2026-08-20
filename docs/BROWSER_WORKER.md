# Web Review Browser Worker

M13 separates Chromium execution from the ChatGPT MCP process. M15 adds bounded operational observability and request quotas without expanding the browser API.

## Runtime split

```text
ChatGPT
  ↓
Human/Web Review MCP
  ↓ HTTPS + Bearer token + x-request-id
Browser Worker
  ↓
Playwright / Chromium
  ↓
public staging URL
```

The worker exposes only:

- `GET /health` — public liveness/capacity summary;
- `GET /metrics` — bearer-authenticated Prometheus text metrics;
- `POST /v1/browser/run` — bearer-authenticated bounded browser operations.

Allowed browser operations remain fixed to `capture`, `runAction`, `runScrollCheckpoints`, and `runScenario`. No arbitrary JavaScript/evaluate endpoint is exposed.

## MCP configuration

Production entrypoint is `npm start` (`server-entry.js`).

```text
WEB_REVIEW_BROWSER_MODE=remote
WEB_REVIEW_BROWSER_RUNNER_URL=https://browser-worker.example.com
WEB_REVIEW_BROWSER_RUNNER_TOKEN=<strong shared secret, >=16 chars>
WEB_REVIEW_BROWSER_REQUEST_TIMEOUT_MS=75000
```

`WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE=true` exists only for local tests/dev. Production remote transport requires HTTPS.

The remote client creates an `x-request-id` for every worker call. The worker echoes it in the response; worker failures/timeouts include that ID in the MCP-side error so an operator can correlate one review action with worker logs.

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
BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE=60
BROWSER_WORKER_MAX_BODY_BYTES=524288
BROWSER_WORKER_MAX_OPERATION_TIMEOUT_MS=45000
```

The current worker uses one configured bearer token, so the requests-per-minute quota applies to that authenticated principal. A future multi-principal auth layer can maintain the same contract while tracking independent buckets.

`BROWSER_WORKER_ALLOW_PRIVATE=true` is test-only. Production defaults to public HTTP(S) targets and retains DNS/IP SSRF checks for every browser subrequest.

## Request IDs and logs

The worker accepts an incoming `x-request-id` containing only bounded safe characters or generates `browserreq_*` itself. Structured logs are JSON records with fields such as:

```text
{
  "timestamp": "...",
  "service": "web-review-browser-worker",
  "event": "job_started|job_finished|request_rejected",
  "request_id": "browserreq_...",
  "operation": "capture",
  "duration_ms": 1234
}
```

Logs intentionally do **not** include target URLs, DOM text, screenshot content, bearer tokens, fill values, comments, or page data.

## Metrics

`GET /metrics` requires the same bearer token as browser execution. It returns Prometheus-compatible counters/gauges for:

- jobs started / succeeded / failed;
- rejected auth / rate / concurrency requests;
- active jobs;
- cumulative job duration;
- operation counts by the fixed operation name.

Metrics contain no URLs, selectors, page text or user content.

Example:

```text
curl -H "Authorization: Bearer $BROWSER_WORKER_TOKEN" \
  https://browser-worker.example.com/metrics
```

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
  -e BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE=60 \
  -p 8890:8890 \
  web-review-browser-worker
```

The image uses the matching Playwright Chromium runtime and runs as the non-root `pwuser`.

## Security boundary

The worker is not a general browser automation API. It intentionally keeps:

- bearer-token authentication;
- HTTPS required for the MCP→worker link in production;
- fixed operation allowlist;
- bounded request body;
- bounded operation timeout forwarded to Playwright;
- requests-per-minute quota with HTTP 429;
- bounded concurrency with HTTP 429 when saturated;
- public-target SSRF policy and blocked unsafe subrequests;
- authenticated metrics;
- no browser credentials/cookies supplied by the MCP;
- no arbitrary `evaluate()` or script execution endpoint.

The token should be stored as a deployment secret and never placed in source, MCP structured content, screenshots, review evidence, logs or metrics.

## Remaining production hardening

The isolation/observability boundary still does not provide a durable queue or a process-level hard kill for a Chromium job that outlives all internal Playwright timeouts. Remaining work includes process/container execution deadlines, richer readiness checks, artifact retention/garbage collection, schema migrations and a distributed storage adapter for horizontally scaled deployments.
