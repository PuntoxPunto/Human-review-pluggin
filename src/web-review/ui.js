import { readFileSync } from "node:fs";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

export const WEB_REVIEW_TEMPLATE_URI = "ui://widget/web-review/v1.html";

const shell = readFileSync(new URL("../../public/web-review-widget.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../../public/web-review-widget.js", import.meta.url), "utf8");
const html = shell.replace("/*__WEB_REVIEW_WIDGET_SCRIPT__*/", script.replaceAll("</script>", "<\\/script>"));

export function registerWebReviewResource(server) {
  registerAppResource(server, "web-review-widget", WEB_REVIEW_TEMPLATE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: WEB_REVIEW_TEMPLATE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: html,
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Read-only Web Review cockpit showing a Playwright screenshot with deterministic geometry findings overlaid and an issue rail.",
      },
    }],
  }));
}
