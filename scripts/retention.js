import { runArtifactRetention } from "../src/web-review/retention.js";

const apply = process.argv.includes("--apply") || process.env.WEB_REVIEW_RETENTION_APPLY === "true";
const stateDir = String(process.env.WEB_REVIEW_STATE_DIR || "").trim();
if (!stateDir) {
  console.error("WEB_REVIEW_STATE_DIR is required so retention operates on the configured durable single-writer state.");
  process.exitCode = 2;
} else {
  const retentionDays = Number(process.env.WEB_REVIEW_SCREENSHOT_RETENTION_DAYS || 30);
  const keepLatestPerReview = Number(process.env.WEB_REVIEW_SCREENSHOT_KEEP_LATEST || 5);
  const report = runArtifactRetention({
    retentionDays,
    keepLatestPerReview,
    dryRun: !apply,
  });
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    state_dir: stateDir,
    ...report,
  }, null, 2));
}
