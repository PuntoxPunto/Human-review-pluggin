import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);
const HUMAN_RESOURCE_URI = "ui://widget/human-review/v2.html";
const WEB_RESOURCE_URI = "ui://widget/web-review/v4.html";

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

  const client = new Client({ name: "human-review-integration-test", version: "0.7.0" });
  const transport = new StreamableHTTPClientTransport(MCP_URL);
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
  });

  assert.equal(client.getServerVersion()?.version, "0.7.0");
  assert.match(client.getInstructions() ?? "", /create_review/);
  assert.match(client.getInstructions() ?? "", /create_web_review/);
  assert.match(client.getInstructions() ?? "", /open_web_review/);
  assert.match(client.getInstructions() ?? "", /candidate_overlap/);
  assert.match(client.getInstructions() ?? "", /get_web_findings/);
  assert.match(client.getInstructions() ?? "", /accepted findings/);
  assert.match(client.getInstructions() ?? "", /run_web_action/);
  assert.match(client.getInstructions() ?? "", /match exactly one element/);
  assert.match(client.getInstructions() ?? "", /before and after evidence/);
  assert.match(client.getInstructions() ?? "", /run_web_scroll_checkpoints/);
  assert.match(client.getInstructions() ?? "", /center_offset_px/);
  assert.match(client.getInstructions() ?? "", /user_edited_html/);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "analyze_web_geometry",
      "apply_review",
      "capture_web_review",
      "compare_web_evidence",
      "create_review",
      "create_web_fix_plan",
      "create_web_review",
      "get_review_feedback",
      "get_web_action_run",
      "get_web_evidence",
      "get_web_findings",
      "get_web_fix_plan",
      "get_web_locator_recipes",
      "get_web_locator_recovery_context",
      "get_web_reference_comparison",
      "get_web_scenario_run",
      "get_web_scroll_run",
      "get_web_visual_critic_context",
      "open_review",
      "open_web_review",
      "record_web_fix_attempt",
      "run_web_action",
      "run_web_scenario",
      "run_web_scroll_checkpoints",
      "save_review_draft",
      "set_web_finding_decision",
      "submit_review",
      "submit_web_reference_findings",
      "submit_web_visual_findings",
      "verify_web_locator_recovery",
    ],
  );

  const openTool = listed.tools.find((tool) => tool.name === "open_review");
  const webOpenTool = listed.tools.find((tool) => tool.name === "open_web_review");
  const saveTool = listed.tools.find((tool) => tool.name === "save_review_draft");
  const submitTool = listed.tools.find((tool) => tool.name === "submit_review");
  const captureTool = listed.tools.find((tool) => tool.name === "capture_web_review");
  const decisionTool = listed.tools.find((tool) => tool.name === "set_web_finding_decision");
  const findingsTool = listed.tools.find((tool) => tool.name === "get_web_findings");
  const actionTool = listed.tools.find((tool) => tool.name === "run_web_action");
  const actionRunTool = listed.tools.find((tool) => tool.name === "get_web_action_run");
  const scrollTool = listed.tools.find((tool) => tool.name === "run_web_scroll_checkpoints");
  const scrollRunTool = listed.tools.find((tool) => tool.name === "get_web_scroll_run");
  const scenarioTool = listed.tools.find((tool) => tool.name === "run_web_scenario");
  const scenarioRunTool = listed.tools.find((tool) => tool.name === "get_web_scenario_run");
  const recoveryContextTool = listed.tools.find((tool) => tool.name === "get_web_locator_recovery_context");
  const recoveryVerifyTool = listed.tools.find((tool) => tool.name === "verify_web_locator_recovery");
  const recoveryRecipesTool = listed.tools.find((tool) => tool.name === "get_web_locator_recipes");
  const visualContextTool = listed.tools.find((tool) => tool.name === "get_web_visual_critic_context");
  const visualSubmitTool = listed.tools.find((tool) => tool.name === "submit_web_visual_findings");
  const compareTool = listed.tools.find((tool) => tool.name === "compare_web_evidence");
  const referenceGetTool = listed.tools.find((tool) => tool.name === "get_web_reference_comparison");
  const referenceSubmitTool = listed.tools.find((tool) => tool.name === "submit_web_reference_findings");
  const fixCreateTool = listed.tools.find((tool) => tool.name === "create_web_fix_plan");
  const fixGetTool = listed.tools.find((tool) => tool.name === "get_web_fix_plan");
  const fixAttemptTool = listed.tools.find((tool) => tool.name === "record_web_fix_attempt");
  assert.equal(openTool?._meta?.ui?.resourceUri, HUMAN_RESOURCE_URI);
  assert.equal(openTool?._meta?.["openai/outputTemplate"], HUMAN_RESOURCE_URI);
  assert.equal(webOpenTool?._meta?.ui?.resourceUri, WEB_RESOURCE_URI);
  assert.equal(webOpenTool?._meta?.["openai/outputTemplate"], WEB_RESOURCE_URI);
  assert.deepEqual(saveTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(submitTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(decisionTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(saveTool?._meta?.["openai/visibility"], "private");
  assert.equal(submitTool?._meta?.["openai/visibility"], "private");
  assert.equal(decisionTool?._meta?.["openai/visibility"], "private");
  for (const tool of [findingsTool, actionTool, actionRunTool, scrollTool, scrollRunTool, scenarioTool, scenarioRunTool, recoveryContextTool, recoveryVerifyTool, recoveryRecipesTool, visualContextTool, visualSubmitTool, compareTool, referenceGetTool, referenceSubmitTool, fixCreateTool, fixGetTool, fixAttemptTool]) {
    assert.deepEqual(tool?._meta?.ui?.visibility, ["model"]);
  }
  assert.equal(captureTool?.annotations?.openWorldHint, true);
  assert.equal(captureTool?.annotations?.readOnlyHint, false);
  assert.equal(actionTool?.annotations?.openWorldHint, true);
  assert.equal(actionTool?.annotations?.readOnlyHint, false);
  assert.equal(scrollTool?.annotations?.openWorldHint, true);
  assert.equal(scrollTool?.annotations?.readOnlyHint, false);
  assert.equal(scrollRunTool?.annotations?.readOnlyHint, true);
  assert.equal(scenarioTool?.annotations?.openWorldHint, true);
  assert.equal(scenarioTool?.annotations?.readOnlyHint, false);
  assert.equal(scenarioRunTool?.annotations?.readOnlyHint, true);
  assert.equal(recoveryContextTool?.annotations?.readOnlyHint, true);
  assert.equal(recoveryContextTool?.annotations?.openWorldHint, false);
  assert.equal(recoveryVerifyTool?.annotations?.readOnlyHint, false);
  assert.equal(recoveryVerifyTool?.annotations?.openWorldHint, true);
  assert.equal(recoveryRecipesTool?.annotations?.readOnlyHint, true);
  assert.equal(visualContextTool?.annotations?.readOnlyHint, true);
  assert.equal(visualContextTool?.annotations?.openWorldHint, false);
  assert.equal(visualSubmitTool?.annotations?.readOnlyHint, false);
  assert.equal(visualSubmitTool?.annotations?.openWorldHint, false);
  assert.equal(visualSubmitTool?.annotations?.idempotentHint, true);
  assert.equal(compareTool?.annotations?.readOnlyHint, false);
  assert.equal(compareTool?.annotations?.openWorldHint, false);
  assert.equal(referenceGetTool?.annotations?.readOnlyHint, true);
  assert.equal(referenceGetTool?.annotations?.openWorldHint, false);
  assert.equal(referenceSubmitTool?.annotations?.readOnlyHint, false);
  assert.equal(referenceSubmitTool?.annotations?.openWorldHint, false);
  assert.equal(referenceSubmitTool?.annotations?.idempotentHint, true);
  assert.equal(fixCreateTool?.annotations?.readOnlyHint, false);
  assert.equal(fixCreateTool?.annotations?.openWorldHint, false);
  assert.equal(fixCreateTool?.annotations?.idempotentHint, false);
  assert.equal(fixGetTool?.annotations?.readOnlyHint, true);
  assert.equal(fixGetTool?.annotations?.openWorldHint, false);
  assert.equal(fixAttemptTool?.annotations?.readOnlyHint, false);
  assert.equal(fixAttemptTool?.annotations?.openWorldHint, false);
  assert.equal(fixAttemptTool?.annotations?.idempotentHint, false);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === HUMAN_RESOURCE_URI));
  assert.ok(resources.resources.some((resource) => resource.uri === WEB_RESOURCE_URI));

  const humanResource = await client.readResource({ uri: HUMAN_RESOURCE_URI });
  assert.equal(humanResource.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(humanResource.contents[0]?.text ?? "", /Human Review/);

  const webResource = await client.readResource({ uri: WEB_RESOURCE_URI });
  assert.equal(webResource.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(webResource.contents[0]?.text ?? "", /Web Review/);
  assert.match(webResource.contents[0]?.text ?? "", /Findings/);
  assert.match(webResource.contents[0]?.text ?? "", /Send decisions/);
  assert.match(webResource.contents[0]?.text ?? "", /set_web_finding_decision/);
  assert.match(webResource.contents[0]?.text ?? "", /visual critic/i);
  assert.match(webResource.contents[0]?.text ?? "", /baseline critic/i);
  assert.match(webResource.contents[0]?.text ?? "", /deterministic/i);

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