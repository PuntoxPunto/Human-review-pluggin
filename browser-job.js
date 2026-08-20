import { BrowserRunner } from "./src/web-review/browser-runner.js";

const OPERATIONS = new Set(["capture", "runAction", "runScrollCheckpoints", "runScenario"]);
const MAX_INPUT_BYTES = Math.max(16_384, Math.min(1_048_576, Number(process.env.BROWSER_JOB_MAX_INPUT_BYTES || 524_288)));
const ALLOW_PRIVATE = process.env.BROWSER_JOB_ALLOW_PRIVATE === "true";
const TEST_DELAY_MS = Math.max(0, Math.min(30_000, Number(process.env.BROWSER_JOB_TEST_DELAY_MS || 0)));

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error("Browser job input exceeded limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function reply(body) {
  process.stdout.write(JSON.stringify(body));
}

try {
  const body = await readInput();
  const operation = String(body.operation || "");
  if (!OPERATIONS.has(operation)) throw new Error("Unsupported browser job operation.");
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) throw new Error("Browser job payload must be an object.");
  if (TEST_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, TEST_DELAY_MS));
  const runner = new BrowserRunner({ allowPrivateTargets: ALLOW_PRIVATE });
  const result = await runner[operation](body.payload);
  reply({ ok: true, result });
} catch (error) {
  reply({ ok: false, error: String(error?.message || error || "Browser job failed").slice(0, 4000) });
}
