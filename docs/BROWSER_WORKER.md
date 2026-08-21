# Web Review Browser Worker

M13 separates Chromium execution from the ChatGPT MCP process. M15 adds bounded observability/quotas. M16 adds a hard execution boundary: every accepted browser job runs in its own child process/process group so an overlong Playwright/Chromium tree can be killed independently of the HTTP worker. M17 adds readiness and graceful draining for safe deploys/restarts.

## Runtime split

```text
ChatGPT
  ↓
Human/Web Review MCP
  ↓ HTTPS + Bearer token + x-request-id
Browser Worker (HTTP / auth / quota / metrics / lifecycle)
  ↓ child process per accepted job
Browser Job
  ↓
Playwright / Chromium process tree
  ↓
public staging URL
```

The worker exposes only:

- `GET /health` — public liveness/capacity/lifecycle summary;
- `GET /ready` — readiness probe; `200` while accepting jobs and `503` while draining;
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

`npm run start:mcp-local` bypasses the loader and keeps local Chromium behavior for development/debugging.

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
BROWSER_WORKER_HARD_JOB_TIMEOUT_MS=60000
BROWSER_WORKER_DRAIN_GRACE_MS=75000
BROWSER_WORKER_MAX_JOB_OUTPUT_BYTES=25165824
```

`MAX_OPERATION_TIMEOUT_MS` bounds Playwright's normal cooperative timeout. `HARD_JOB_TIMEOUT_MS` is independent and kills the entire browser job process group if the operation fails to return. Production should normally keep the hard deadline somewhat above the internal Playwright timeout.

`DRAIN_GRACE_MS` controls how long an accepted in-flight job may finish after `SIGTERM`/`SIGINT`. If it expires, the worker kills all remaining browser job process groups, returns failures to those requests, and closes the HTTP server. The default is the hard-job timeout plus 15 seconds (bounded by the configured maximum).

The output cap protects the worker from an unexpectedly large child response, including unusually large screenshot/evidence payloads.

The current worker uses one configured bearer token, so the requests-per-minute quota applies to that authenticated principal. A future multi-principal auth layer can preserve the same contract with independent buckets.

`BROWSER_WORKER_ALLOW_PRIVATE=true` is test-only. Production defaults to public HTTP(S) targets and retains DNS/IP SSRF checks for every browser subrequest.

## Readiness and draining

Normal state:

```text
GET /health -> 200, state=ready
GET /ready  -> 200, ready=true
POST /v1/browser/run -> accepts jobs subject to auth/quota/concurrency
```

After `SIGTERM` or `SIGINT`:

```text
state -> draining
GET /health -> 200 (liveness remains available)
GET /ready  -> 503
new browser jobs -> 503 + Retry-After
existing browser jobs -> allowed to finish during grace period
```

If all active jobs finish before the grace period, the worker closes cleanly. If the grace period expires, all remaining browser-job process groups are killed and the server stops accepting connections. Draining rejections do not consume the request-rate quota.

For Kubernetes-like schedulers use `/health` as liveness and `/ready` as readiness. For Coolify/Docker-style deployment, route readiness checks to `/ready` and ensure the platform's stop timeout is greater than `BROWSER_WORKER_DRAIN_GRACE_MS`. `Dockerfile.browser-worker` declares `STOPSIGNAL SIGTERM`.

## Per-job process isolation

The HTTP worker no longer launches Chromium directly. For every accepted job it spawns `browser-job.js` as a dedicated child process.

On Linux/production the child is placed in its own process group. If the hard deadline, output limit, or forced drain is reached, Web Review sends `SIGKILL` to that group, terminating the Node job process and Chromium descendants together. On platforms without POSIX process groups, the child process itself is killed.

The browser child receives a strict environment allowlist needed for Node/Playwright, locale, certificates, temp/cache paths and optional proxy configuration. Worker/MCP credentials such as `BROWSER_WORKER_TOKEN`, `WEB_REVIEW_BROWSER_RUNNER_TOKEN`, OpenAI API keys, and unrelated deployment secrets are not forwarded.

`browser-job.js` accepts one JSON request over stdin and returns one JSON result over stdout. It does not expose an HTTP listener or a separate public API.

## Request IDs and logs

The worker accepts a bounded safe `x-request-id` or generates `browserreq_*`. Structured logs contain only operational fields such as request ID, fixed operation name, outcome, duration and active job count.

Lifecycle logs include `worker_draining`, `worker_drain_forced`, and `worker_stopped`; they contain only lifecycle reason/counters and never page content.

Logs intentionally do **not** include target URLs, DOM text, screenshot content, bearer tokens, fill values, comments or page data.

## Metrics

`GET /metrics` requires bearer authentication and returns Prometheus-compatible counters/gauges for:

- jobs started / succeeded / failed;
- hard job timeouts;
- drains started / forced drains;
- rejected auth / rate / concurrency / draining requests;
- readiness (`web_review_browser_ready`);
- active jobs;
- cumulative job duration;
- operation counts by fixed operation name.

Metrics contain no URLs, selectors, page text or user content.

```text
curl -H "Authorization: Bearer $BROWSER_WORKER_TOKEN" \
  https://browser-worker.example.com/metrics
```

## Docker

```text
docker build -f Dockerfile.browser-worker -t web-review-browser-worker .

docker run --rm \
  -e BROWSER_WORKER_TOKEN='<secret>' \
  -e BROWSER_WORKER_MAX_CONCURRENCY=2 \
  -e BROWSER_WORKER_MAX_REQUESTS_PER_MINUTE=60 \
  -e BROWSER_WORKER_HARD_JOB_TIMEOUT_MS=60000 \
  -e BROWSER_WORKER_DRAIN_GRACE_MS=75000 \
  -p 8890:8890 \
  web-review-browser-worker
```

The image uses the matching Playwright Chromium runtime and runs as non-root `pwuser`. The worker, job child and Playwright browser therefore remain inside the same container security boundary while jobs receive independent process-group lifetimes.

## Security boundary

The worker intentionally keeps:

- bearer-token authentication;
- HTTPS for MCP→worker in production;
- fixed operation allowlist;
- bounded request body and child output;
- cooperative Playwright timeout plus process-group hard deadline;
- graceful drain with forced reclamation of remaining browser process groups;
- requests-per-minute and concurrency 429 gates;
- public-target SSRF policy and unsafe-subrequest blocking;
- authenticated metrics;
- a minimal browser-child environment without worker/API secrets;
- no browser credentials/cookies supplied by MCP;
- no arbitrary `evaluate()` or script execution endpoint.

## Remaining production hardening

The worker now supports hard browser-job reclamation and deployment-safe draining. Remaining work includes evidence/artifact retention and garbage collection, schema migrations/versioning for durable state, multi-principal auth/quotas, and a distributed storage/object-store adapter for horizontal deployment.
