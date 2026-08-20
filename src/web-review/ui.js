import { readFileSync } from "node:fs";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

export const WEB_REVIEW_TEMPLATE_URI = "ui://widget/web-review/v4.html";
export const FIX_REVIEW_TEMPLATE_URI = "ui://widget/fix-review/v1.html";

const webShell = readFileSync(new URL("../../public/web-review-widget.html", import.meta.url), "utf8");
const webScript = readFileSync(new URL("../../public/web-review-widget.js", import.meta.url), "utf8");
const webHtml = webShell.replace("/*__WEB_REVIEW_WIDGET_SCRIPT__*/", webScript.replaceAll("</script>", "<\\/script>"));

const fixShell = readFileSync(new URL("../../public/fix-review-widget.html", import.meta.url), "utf8");
const fixScript = readFileSync(new URL("../../public/fix-review-widget.js", import.meta.url), "utf8");
const fixHtml = fixShell.replace("/*__FIX_REVIEW_WIDGET_SCRIPT__*/", fixScript.replaceAll("</script>", "<\\/script>"));

export function registerWebReviewResource(server) {
  registerAppResource(server, "web-review-widget", WEB_REVIEW_TEMPLATE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: WEB_REVIEW_TEMPLATE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: webHtml,
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Interactive Web Review cockpit showing immutable Playwright evidence with deterministic, visual-critic, and baseline-reference provenance, overlays, human accept/reject decisions, comments, and a handoff back to ChatGPT.",
      },
    }],
  }));

  registerAppResource(server, "fix-review-widget", FIX_REVIEW_TEMPLATE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: FIX_REVIEW_TEMPLATE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: fixHtml,
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Human Fix Review cockpit comparing immutable before/after Playwright screenshots. It permits decisions only for items the automatic verifier marked needs_review; deterministic resolved/unresolved results remain locked.",
      },
    }],
  }));
}
