import assert from 'node:assert/strict';

const endpoint = 'https://human-review-mcp-test-u1t0ev.v2.appdeploy.ai/api/mcp';
const modernVersion = '2026-07-28';
const widgetUri = 'ui://widget/human-review/v4.html';

async function request(method, { name = '', params = {}, modern = true } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
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
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params: bodyParams }),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  console.log(`\n${method}: HTTP ${response.status}`);
  console.log('content-type:', response.headers.get('content-type'));
  console.log(text.slice(0, 2000));
  return { response, json, text };
}

const get = await fetch(endpoint, { method: 'GET', headers: { accept: 'application/json, text/event-stream' } });
console.log(`GET: HTTP ${get.status}; allow=${get.headers.get('allow')}`);
assert.equal(get.status, 405);

const discover = await request('server/discover');
assert.equal(discover.response.status, 200);
assert.ok(discover.json?.result?.supportedVersions?.includes(modernVersion));
assert.equal(discover.json?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.version, '0.4.0');

const tools = await request('tools/list');
assert.equal(tools.response.status, 200);
assert.equal(tools.json?.result?.tools?.length, 6);
assert.ok(tools.json.result.tools.every((tool) => tool.inputSchema && tool.outputSchema));

const resource = await request('resources/read', { name: widgetUri, params: { uri: widgetUri } });
assert.equal(resource.response.status, 200);
assert.equal(resource.json?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
assert.equal(resource.json?.result?.contents?.[0]?.uri, widgetUri);

const created = await request('tools/call', {
  name: 'create_review',
  params: { name: 'create_review', arguments: { title: 'External MCP probe', html: '<main><h1>Probe</h1></main>' } },
});
assert.equal(created.response.status, 200);
assert.ok(created.json?.result?.structuredContent?.review_id);

const legacy = await request('initialize', {
  modern: false,
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'github-legacy-probe', version: '1.0.0' } },
});
assert.equal(legacy.response.status, 200);
assert.equal(legacy.json?.result?.protocolVersion, '2025-11-25');

console.log('\nExternal AppDeploy MCP probe PASSED.');
