import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);

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

test("MCP review loop works end to end", { timeout: 30_000 }, async (t) => {
  const { child, ready } = startServer();
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  await ready;

  const client = new Client({ name: "human-review-integration-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(MCP_URL);
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
  });

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
