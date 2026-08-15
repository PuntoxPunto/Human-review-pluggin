import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);
const RESOURCE_URI = "ui://widget/human-review/v2.html";

function startServer() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP server did not start in time.")), 10_000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Human Review MCP server listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`MCP server exited before ready (code ${code}).`));
    });
  });

  return { child, ready };
}

test("MCP review loop and ChatGPT discovery work end to end", { timeout: 30_000 }, async (t) => {
  const { child, ready } = startServer();
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  await ready;

  const client = new Client({ name: "human-review-integration-test", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(MCP_URL);
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
  });

  assert.equal(client.getServerVersion()?.version, "0.2.0");
  assert.match(client.getInstructions() ?? "", /create_review/);
  assert.match(client.getInstructions() ?? "", /user_edited_html/);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "apply_review",
      "create_review",
      "get_review_feedback",
      "open_review",
      "save_review_draft",
      "submit_review",
    ],
  );

  const openTool = listed.tools.find((tool) => tool.name === "open_review");
  const saveTool = listed.tools.find((tool) => tool.name === "save_review_draft");
  const submitTool = listed.tools.find((tool) => tool.name === "submit_review");
  assert.equal(openTool?._meta?.ui?.resourceUri, RESOURCE_URI);
  assert.equal(openTool?._meta?.["openai/outputTemplate"], RESOURCE_URI);
  assert.deepEqual(saveTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(submitTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(saveTool?._meta?.["openai/visibility"], "private");
  assert.equal(submitTool?._meta?.["openai/visibility"], "private");

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === RESOURCE_URI));
  const resource = await client.readResource({ uri: RESOURCE_URI });
  assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0]?.text ?? "", /Human Review/);

  const created = await client.callTool({
    name: "create_review",
    arguments: { title: "Integration landing", html: "<main><h1>Start free trial</h1></main>" },
  });
  const reviewId = created.structuredContent.review_id;
  assert.match(reviewId, /^rev_/);

  const opened = await client.callTool({ name: "open_review", arguments: { review_id: reviewId } });
  assert.equal(opened.structuredContent.status, "editing");

  const directEdit = {
    id: "edit_heading",
    kind: "edited",
    before: "Start free trial",
    after: "Probar gratis",
  };
  const comment = {
    id: "comment_heading",
    kind: "element",
    quote: "Probar gratis",
    anchor: null,
    feedback: "Add a short supporting sentence below this CTA.",
  };

  await client.callTool({
    name: "save_review_draft",
    arguments: {
      review_id: reviewId,
      draft_html: "<main><h1>Probar gratis</h1></main>",
      edits: [directEdit],
      comments: [comment],
    },
  });

  const submitted = await client.callTool({
    name: "submit_review",
    arguments: {
      review_id: reviewId,
      draft_html: "<main><h1>Probar gratis</h1></main>",
      edits: [directEdit],
      comments: [comment],
    },
  });
  const batchId = submitted.structuredContent.batch_id;
  assert.match(batchId, /^batch_/);

  const feedback = await client.callTool({
    name: "get_review_feedback",
    arguments: { review_id: reviewId, batch_id: batchId },
  });
  assert.match(feedback.structuredContent.user_edited_html, /Probar gratis/);
  assert.equal(feedback.structuredContent.comments[0].feedback, comment.feedback);

  const conflict = await client.callTool({
    name: "apply_review",
    arguments: {
      review_id: reviewId,
      batch_id: batchId,
      html: "<main><h1>Start free trial</h1><p>Fast setup.</p></main>",
      overridden_edit_ids: [],
    },
  });
  assert.equal(conflict.structuredContent.ok, false);
  assert.deepEqual(conflict.structuredContent.conflicts, [directEdit.id]);

  const applied = await client.callTool({
    name: "apply_review",
    arguments: {
      review_id: reviewId,
      batch_id: batchId,
      html: "<main><h1>Probar gratis</h1><p>Empieza en minutos, sin configuración compleja.</p></main>",
      overridden_edit_ids: [],
    },
  });
  assert.equal(applied.structuredContent.ok, true);
  assert.equal(applied.structuredContent.source_version, 2);
});
