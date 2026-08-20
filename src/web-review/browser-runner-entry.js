import { BrowserRunner as LocalBrowserRunner } from "./browser-runner.js";
import { RemoteBrowserRunner } from "./remote-browser-runner.js";

function remoteOptions(env) {
  return {
    baseUrl: env.WEB_REVIEW_BROWSER_RUNNER_URL,
    token: env.WEB_REVIEW_BROWSER_RUNNER_TOKEN,
    requestTimeoutMs: env.WEB_REVIEW_BROWSER_REQUEST_TIMEOUT_MS,
    allowInsecure: env.WEB_REVIEW_BROWSER_ALLOW_INSECURE_REMOTE === "true",
  };
}

export class BrowserRunner {
  constructor(options = {}) {
    if (Object.keys(options).length) return new LocalBrowserRunner(options);
    const mode = String(process.env.WEB_REVIEW_BROWSER_MODE || (process.env.WEB_REVIEW_BROWSER_RUNNER_URL ? "remote" : "local")).toLowerCase();
    if (mode === "local") return new LocalBrowserRunner();
    if (mode === "remote") return new RemoteBrowserRunner(remoteOptions(process.env));
    throw new Error("WEB_REVIEW_BROWSER_MODE must be local or remote.");
  }
}
