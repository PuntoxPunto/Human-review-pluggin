import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const JOB_PATH = fileURLToPath(new URL("../../browser-job.js", import.meta.url));
const DEFAULT_HARD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "LD_LIBRARY_PATH", "NODE_PATH", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "NODE_ENV",
  "BROWSER_JOB_TEST_DELAY_MS", "BROWSER_JOB_MAX_INPUT_BYTES",
];

export function createBrowserJobEnvironment({ allowPrivate = false, baseEnv = process.env } = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (baseEnv[key] !== undefined) env[key] = String(baseEnv[key]);
  }
  env.BROWSER_JOB_ALLOW_PRIVATE = allowPrivate ? "true" : "false";
  return env;
}

export function runBrowserJobProcess({ operation, payload, allowPrivate = false, hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  const boundedTimeout = Math.max(1_000, Math.min(180_000, Number(hardTimeoutMs) || DEFAULT_HARD_TIMEOUT_MS));
  const boundedOutput = Math.max(1_048_576, Math.min(64 * 1024 * 1024, Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JOB_PATH], {
      env: createBrowserJobEnvironment({ allowPrivate }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, boundedTimeout);

    child.stdout.on("data", (chunk) => {
      if (outputExceeded) return;
      if (stdout.length + chunk.length > boundedOutput) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr = Buffer.concat([stderr, chunk]).subarray(0, 8192);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      finishReject(Object.assign(new Error(`Browser job process failed to start: ${error.message}`), { statusCode: 502, code: "BROWSER_JOB_SPAWN_ERROR" }));
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (settled) return;
      if (timedOut) {
        return finishReject(Object.assign(new Error(`Browser job exceeded hard timeout of ${boundedTimeout}ms.`), { statusCode: 504, code: "BROWSER_JOB_HARD_TIMEOUT" }));
      }
      if (outputExceeded) {
        return finishReject(Object.assign(new Error("Browser job output exceeded the maximum allowed size."), { statusCode: 502, code: "BROWSER_JOB_OUTPUT_LIMIT" }));
      }
      let body;
      try {
        body = JSON.parse(stdout.toString("utf8") || "{}");
      } catch {
        const detail = stderr.toString("utf8").trim();
        return finishReject(Object.assign(new Error(`Browser job returned invalid JSON${detail ? `: ${detail}` : "."}`), { statusCode: 502, code: "BROWSER_JOB_INVALID_OUTPUT" }));
      }
      if (!body.ok) {
        return finishReject(Object.assign(new Error(String(body.error || "Browser job failed").slice(0, 4000)), { statusCode: 502, code: "BROWSER_JOB_FAILED" }));
      }
      settled = true;
      resolve(body.result);
    });

    try {
      child.stdin.end(JSON.stringify({ operation, payload }));
    } catch (error) {
      clearTimeout(timer);
      child.kill("SIGKILL");
      finishReject(Object.assign(new Error(`Could not send browser job payload: ${error.message}`), { statusCode: 500, code: "BROWSER_JOB_INPUT_ERROR" }));
    }
  });
}
