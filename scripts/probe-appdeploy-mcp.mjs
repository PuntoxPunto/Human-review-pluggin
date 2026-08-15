import assert from 'node:assert/strict';

const publicEndpoint = 'https://human-review-mcp-test-u1t0ev.v2.appdeploy.ai/api/mcp';
const apiEndpoint = 'https://api-v2.appdeploy.ai/app/human-review-mcp-test-u1t0ev/api/mcp';
const modernVersion = '2026-07-28';
const widgetUri = 'ui://widget/human-review/v5.html';

async function rawPost(endpoint, method, { name = '', params = {}, modern = true } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const bodyParams = { ...params };
  if (modern) {
    headers['mcp-protocol-version'] = modernVersion;
    headers['mcp-method'] = method;
    if (name) headers['mcp-name'] = name;
    bodyParams._meta = {
      ...(bodyParams._meta || {}),
      'io.modelcontextprotocol/protocolVersion': modernVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'github-external-probe', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params: bodyParams }),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  console.log(`\n${endpoint}\n${method}${name ? `:${name}` : ''}: HTTP ${response.status}; type=${response.headers.get('content-type')}`);
  console.log(text.slice(0, 2500));
  return { response, json, text };
}

async function callTool(name, args) {
  const result = await rawPost(apiEndpoint, 'tools/call', { name, params: { name, arguments: args } });
  assert.equal(result.response.status, 200, `${name} returned HTTP ${result.response.status}`);
  assert.ok(!result.json?.error, `${name} returned JSON-RPC error: ${JSON.stringify(result.json?.error)}`);
  assert.ok(!result.json?.result?.isError, `${name} returned tool error: ${JSON.stringify(result.json?.result?.content)}`);
  return result.json.result;
}

const publicGet = await fetch(publicEndpoint, { method: 'GET', headers: { accept: 'application/json, text/event-stream' } });
const publicGetText = await publicGet.text();
console.log(`PUBLIC GET: HTTP ${publicGet.status}; type=${publicGet.headers.get('content-type')}`);
console.log(publicGetText.slice(0, 500));

const publicPost = await rawPost(publicEndpoint, 'server/discover');
console.log(`PUBLIC POST BLOCKED=${publicPost.response.status === 403}`);

const apiDiscover = await rawPost(apiEndpoint, 'server/discover');
if (apiDiscover.response.status === 200) {
  assert.ok(apiDiscover.json?.result?.supportedVersions?.includes(modernVersion));
  assert.equal(apiDiscover.json?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.version, '0.5.0');

  const tools = await rawPost(apiEndpoint, 'tools/list');
  assert.equal(tools.response.status, 200);
  assert.equal(tools.json?.result?.tools?.length, 6);

  const resource = await rawPost(apiEndpoint, 'resources/read', { name: widgetUri, params: { uri: widgetUri } });
  assert.equal(resource.response.status, 200);
  assert.equal(resource.json?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');

  const initialHtml = '<!doctype html><html><body><main><h1>Avellana</h1><p>Una pausa simple.</p><a href="#">Escribinos</a></main></body></html>';
  const editedHtml = '<!doctype html><html><body><main><h1>Pistachos</h1><p>Una pausa simple.</p><a href="#">Escribinos!</a></main></body></html>';
  const appliedHtml = '<!doctype html><html><body><main><h1>Pistachos</h1><p>Una pausa premium, hecha con café de especialidad.</p><a href="#">Escribinos!</a></main></body></html>';

  const created = await callTool('create_review', { title: 'Modern external loop', html: initialHtml });
  const reviewId = created.structuredContent.review_id;
  assert.ok(reviewId);

  const opened = await callTool('open_review', { review_id: reviewId });
  assert.equal(opened.structuredContent.review_id, reviewId);
  assert.ok(opened._meta?.review?.html?.includes('Avellana'));

  const edits = [
    { id: 'edit_title', kind: 'edited', before: 'Avellana', after: 'Pistachos' },
    { id: 'edit_cta', kind: 'edited', before: 'Escribinos', after: 'Escribinos!' },
  ];
  const comments = [
    { id: 'comment_copy', kind: 'selection', quote: 'Una pausa simple.', feedback: 'Hacé este texto más premium y específico.' },
  ];

  const submitted = await callTool('submit_review', { review_id: reviewId, draft_html: editedHtml, edits, comments });
  const batchId = submitted.structuredContent.batch_id;
  assert.ok(batchId);

  const feedback = await callTool('get_review_feedback', { review_id: reviewId, batch_id: batchId });
  assert.equal(feedback.structuredContent.user_edited_html.includes('Pistachos'), true);
  assert.equal(feedback.structuredContent.user_edited_html.includes('Escribinos!'), true);

  const applied = await callTool('apply_review', { review_id: reviewId, batch_id: batchId, html: appliedHtml, overridden_edit_ids: [] });
  assert.equal(applied.structuredContent.ok, true);
  assert.deepEqual(applied.structuredContent.conflicts, []);

  const reopened = await callTool('open_review', { review_id: reviewId });
  assert.equal(reopened.structuredContent.source_version, 2);
  assert.ok(reopened._meta?.review?.html?.includes('Pistachos'));
  assert.ok(reopened._meta?.review?.html?.includes('Escribinos!'));
  assert.ok(reopened._meta?.review?.html?.includes('premium'));

  const legacy = await rawPost(apiEndpoint, 'initialize', { modern: false, params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'github-legacy-probe', version: '1.0.0' } } });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.json?.result?.protocolVersion, '2025-11-25');
  console.log('\nDIRECT APPDEPLOY API GATEWAY FULL MODERN MCP LOOP PASSED.');
} else {
  console.error(`\nDIRECT APPDEPLOY API GATEWAY IS NOT PUBLICLY USABLE: HTTP ${apiDiscover.response.status}`);
  process.exitCode = 2;
}
