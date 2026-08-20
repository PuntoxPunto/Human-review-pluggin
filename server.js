import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ReviewStore } from "./src/store.js";
import { WebReviewStore } from "./src/web-review/store.js";
import { EvidenceStore } from "./src/web-review/evidence-store.js";
import { BrowserRunner } from "./src/web-review/browser-runner.js";
import { registerWebReviewTools } from "./src/web-review/tools.js";

const TEMPLATE_URI = "ui://widget/human-review/v2.html";
const STORE_MODE = "memory-ephemeral";
const NOAUTH = [{ type: "noauth" }];
const SERVER_INSTRUCTIONS = [
  "When the user asks to visually review HTML, call create_review with the complete HTML, then open_review.",
  "When the user asks to review a public live or staging URL, call create_web_review and then capture_web_review. Use get_web_evidence when DOM/geometry details are needed.",
  "When Human Review sends a feedback batch, call get_review_feedback and treat user_edited_html as the source of truth.",
  "Preserve direct human edits exactly unless an explicit user comment asks to change them.",
  "Call apply_review, resolve any direct-edit conflict, then call open_review again.",
].join(" ");
const store = new ReviewStore();
const webReviewStore = new WebReviewStore();
const evidenceStore = new EvidenceStore();
const browserRunner = new BrowserRunner();
const widgetShell = readFileSync(new URL("./public/review-widget.html", import.meta.url), "utf8");
const widgetScript = readFileSync(new URL("./public/review-widget.js", import.meta.url), "utf8");
const widgetHtml = widgetShell.replace("/*__WIDGET_SCRIPT__*/", widgetScript.replaceAll("</script>", "<\\/script>"));

const editSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(["edited", "deleted", "moved", "resized"]),
  before: z.string(),
  after: z.string(),
  before_html: z.string().optional(),
  after_html: z.string().optional(),
});

const commentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["selection", "element"]),
  quote: z.string(),
  anchor: z.object({ prefix: z.string(), quote: z.string(), suffix: z.string() }).nullable().optional(),
  feedback: z.string().min(1),
});

const summaryOutput = {
  review_id: z.string(),
  title: z.string(),
  status: z.string(),
  source_version: z.number().int(),
  draft_version: z.number().int(),
  comments_count: z.number().int(),
  edits_count: z.number().int(),
};

function summary(review) {
  return {
    review_id: review.id,
    title: review.title,
    status: review.status,
    source_version: review.sourceVersion,
    draft_version: review.draftVersion,
    comments_count: review.comments.length,
    edits_count: review.edits.length,
  };
}

function reply(review, text, meta = undefined) {
  return {
    structuredContent: summary(review),
    content: text ? [{ type: "text", text }] : [],
    ...(meta ? { _meta: meta } : {}),
  };
}

function registerTools(server) {
  registerAppTool(server, "create_review", {
    title: "Create HTML review",
    description: "Use this when the user wants to visually review or edit a complete HTML document. Creates a review session; call open_review next to render it.",
    inputSchema: {
      title: z.string().min(1).max(160),
      html: z.string().min(1).max(2_000_000),
    },
    outputSchema: summaryOutput,
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Creating review…",
      "openai/toolInvocation/invoked": "Review created",
    },
  }, async ({ title, html }) => {
    const review = store.create({ title, html });
    return reply(review, `Created Human Review ${review.id}. Open it for visual editing.`);
  });

  registerAppTool(server, "open_review", {
    title: "Open visual HTML review",
    description: "Use this after create_review, or after apply_review, to render the Human Review visual editor for an existing review ID.",
    inputSchema: { review_id: z.string().min(1) },
    outputSchema: summaryOutput,
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { resourceUri: TEMPLATE_URI, visibility: ["model"] },
      "openai/outputTemplate": TEMPLATE_URI,
      "openai/toolInvocation/invoking": "Opening visual review…",
      "openai/toolInvocation/invoked": "Visual review ready",
    },
  }, async ({ review_id }) => {
    const review = store.get(review_id);
    return reply(review, `Opened ${review.title} for visual review.`, {
      review: {
        id: review.id,
        title: review.title,
        sourceVersion: review.sourceVersion,
        html: review.draftHtml,
        comments: review.comments,
        edits: review.edits,
      },
    });
  });

  registerAppTool(server, "save_review_draft", {
    title: "Save Human Review draft",
    description: "Internal widget action that autosaves direct edits and comments while the user reviews HTML.",
    inputSchema: {
      review_id: z.string().min(1),
      draft_html: z.string().min(1).max(2_000_000),
      edits: z.array(editSchema).max(500),
      comments: z.array(commentSchema).max(500),
    },
    outputSchema: summaryOutput,
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["app"] },
      "openai/widgetAccessible": true,
      "openai/visibility": "private",
    },
  }, async ({ review_id, draft_html, edits, comments }) => {
    const review = store.saveDraft(review_id, { draftHtml: draft_html, edits, comments });
    return reply(review, "Draft saved.");
  });

  registerAppTool(server, "submit_review", {
    title: "Submit Human Review feedback",
    description: "Internal widget action that freezes the current direct edits and comments into one feedback batch for ChatGPT to apply.",
    inputSchema: {
      review_id: z.string().min(1),
      draft_html: z.string().min(1).max(2_000_000),
      edits: z.array(editSchema).max(500),
      comments: z.array(commentSchema).max(500),
    },
    outputSchema: {
      review_id: z.string(),
      batch_id: z.string(),
      status: z.string(),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["app"] },
      "openai/widgetAccessible": true,
      "openai/visibility": "private",
    },
  }, async ({ review_id, draft_html, edits, comments }) => {
    const review = store.submit(review_id, { draftHtml: draft_html, edits, comments });
    return {
      structuredContent: { review_id: review.id, batch_id: review.pendingBatch.id, status: review.status },
      content: [{ type: "text", text: `Human Review feedback batch ${review.pendingBatch.id} is ready.` }],
    };
  });

  registerAppTool(server, "get_review_feedback", {
    title: "Read Human Review feedback",
    description: "Use this when Human Review submits a batch. Returns the user-edited HTML plus comments; treat user_edited_html as the new source of truth.",
    inputSchema: { review_id: z.string().min(1), batch_id: z.string().min(1) },
    outputSchema: {
      review_id: z.string(),
      batch_id: z.string(),
      base_source_version: z.number().int(),
      user_edited_html: z.string(),
      edits: z.array(editSchema),
      comments: z.array(commentSchema),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
    },
  }, async ({ review_id, batch_id }) => {
    const batch = store.feedback(review_id, batch_id);
    return {
      structuredContent: {
        review_id,
        batch_id: batch.id,
        base_source_version: batch.baseSourceVersion,
        user_edited_html: batch.userEditedHtml,
        edits: batch.edits,
        comments: batch.comments,
      },
      content: [{ type: "text", text: `Loaded feedback ${batch.id}. Apply comments on top of user_edited_html and preserve direct edits.` }],
    };
  });

  registerAppTool(server, "apply_review", {
    title: "Apply resolved Human Review",
    description: "Use this after resolving a Human Review feedback batch. Saves the new HTML and rejects accidental reversion of direct human text edits.",
    inputSchema: {
      review_id: z.string().min(1),
      batch_id: z.string().min(1),
      html: z.string().min(1).max(2_000_000),
      overridden_edit_ids: z.array(z.string()).default([]),
    },
    outputSchema: {
      ok: z.boolean(),
      review_id: z.string(),
      status: z.string(),
      source_version: z.number().int(),
      conflicts: z.array(z.string()),
    },
    securitySchemes: NOAUTH,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    _meta: {
      securitySchemes: NOAUTH,
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "Applying review…",
      "openai/toolInvocation/invoked": "Review applied",
    },
  }, async ({ review_id, batch_id, html, overridden_edit_ids }) => {
    const result = store.apply(review_id, { batchId: batch_id, html, overriddenEditIds: overridden_edit_ids });
    const review = result.review;
    return {
      structuredContent: {
        ok: result.ok,
        review_id: review.id,
        status: review.status,
        source_version: review.sourceVersion,
        conflicts: result.conflicts,
      },
      content: [{
        type: "text",
        text: result.ok
          ? `Applied feedback ${batch_id}. Call open_review to show version ${review.sourceVersion}.`
          : `Direct-edit conflict: ${result.conflicts.join(", ")}. Preserve those human edits or explicitly list them in overridden_edit_ids only when a user comment requested the rewrite.`,
      }],
    };
  });
}

function createMcpServer() {
  const server = new McpServer(
    { name: "human-review-chatgpt", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerAppResource(server, "human-review-widget", TEMPLATE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: TEMPLATE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml,
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
        "openai/widgetDescription": "Visual HTML editor for direct human edits, anchored comments, block movement, deletion, responsive preview, and submitting one feedback batch to ChatGPT.",
      },
    }],
  }));

  registerTools(server);
  registerWebReviewTools(server, {
    store: webReviewStore,
    evidenceStore,
    runner: browserRunner,
  });
  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createHttpServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    return res.end(JSON.stringify({
      ok: true,
      name: "human-review-chatgpt",
      version: "0.3.0",
      mcp: MCP_PATH,
      storage: STORE_MODE,
      web_review: {
        enabled: true,
        browser: "playwright-chromium",
        target_policy: "public-http-only",
      },
      warning: STORE_MODE === "memory-ephemeral" ? "Review sessions reset when the server process restarts." : undefined,
    }));
  }

  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Cache-Control", "no-store");
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Human Review MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
