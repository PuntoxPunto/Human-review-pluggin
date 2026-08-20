import { BrowserRunner } from "./browser-runner.js";

const OPERATIONS = new Set(["capture", "runAction", "runScrollCheckpoints", "runScenario"]);
const DEFAULT_REMOTE_TIMEOUT_MS = 75_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function normalizeBaseUrl(value, { allowInsecure = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Remote browser runner URL must not contain credentials.");
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("Remote browser runner requires HTTPS unless insecure transport is explicitly enabled for tests/dev.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export class RemoteBrowserRunner {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, requestTimeoutMs = DEFAULT_REMOTE_TIMEOUT_MS, allowInsecure = false } = {}) {
    if (!baseUrl) throw new Error("Remote browser runner requires baseUrl.");
    if (!token || String(token).length < 16) throw new Error("Remote browser runner requires a token of at least 16 characters.");
    if (typeof fetchImpl !== "function") throw new Error("Remote browser runner requires fetch support.");
    this.baseUrl = normalizeBaseUrl(baseUrl, { allowInsecure });
    this.token = String(token);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Math.max(5_000, Math.min(180_000, Number(requestTimeoutMs) || DEFAULT_REMOTE_TIMEOUT_MS));
  }

  async #call(operation, payload) {
    if (!OPERATIONS.has(operation)) throw new Error(`Unsupported remote browser operation: ${operation}.`);
    const endpoint = new URL(`${this.baseUrl.pathname}/v1/browser/run`, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Remote browser runner request timed out.")), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "authorization": `Bearer ${this.token}`,
        },
        body: JSON.stringify({ operation, payload }),
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Remote browser runner response exceeded the maximum allowed size.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Remote browser runner response exceeded the maximum allowed size.");
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Remote browser runner returned invalid JSON (HTTP ${response.status}).`);
      }
      if (!response.ok || body.ok === false) {
        const message = String(body.error || `HTTP ${response.status}`).slice(0, 2000);
        throw new Error(`Remote browser runner failed: ${message}`);
      }
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Remote browser runner request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  capture(payload) { return this.#call("capture", payload); }
  runAction(payload) { return this.#call("runAction", payload); }
  runScrollCheckpoints(payload) { return this.#call("runScrollCheckpoints", payload); }
  runScenario(payload) { return this.#call("runScenario", payload); }
}

export function createBrowserRunnerFromEnv(env = process.env) {
  const mode = String(env.WEB_REVIEW_BROWSER_MODE || (env.WEB_REVIEW_BROWSER_RUNNER_URL ? "remote" : "local")).toLowerCase();
  if (mode === "local") return { mode, runner: new BrowserRunner() };
  if (mode !== "remote") throw new Error("WEB_REVIEW_BROWSER_MODE must be local or remote.");
  const runner = new RemoteBrowserRunner({
    baseUrl: env.WEB_REVIEW_BROWSER_RUNNER_URL,
    token: env.WEB_REVIEW_BROWSER_RUNNER_TOKEN,
    requestTimeoutMs: env.WEB_REVIEW_BROWSER_REQUEST_TIMEOUT_MS,
    allowInsecure: env.WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE === "true",
  });
  return { mode, runner };
}
