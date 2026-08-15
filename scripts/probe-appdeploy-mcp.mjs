import assert from 'node:assert/strict';

const publicEndpoint = 'https://human-review-mcp-test-u1t0ev.v2.appdeploy.ai/api/mcp';
const apiEndpoint = 'https://api-v2.appdeploy.ai/app/human-review-mcp-test-u1t0ev/api/mcp';
const modernVersion = '2026-07-28';
const widgetUri = 'ui://widget/human-review/v4.html';

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
  console.log(`\n${endpoint}\n${method}: HTTP ${response.status}; type=${response.headers.get('content-type')}`);
  console.log(text.slice(0, 2500));
  return { response, json, text };
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
  assert.equal(apiDiscover.json?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.version, '0.4.0');
  const tools = await rawPost(apiEndpoint, 'tools/list');
  assert.equal(tools.response.status, 200);
  assert.equal(tools.json?.result?.tools?.length, 6);
  const resource = await rawPost(apiEndpoint, 'resources/read', { name: widgetUri, params: { uri: widgetUri } });
  assert.equal(resource.response.status, 200);
  assert.equal(resource.json?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
  const legacy = await rawPost(apiEndpoint, 'initialize', { modern: false, params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'github-legacy-probe', version: '1.0.0' } } });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.json?.result?.protocolVersion, '2025-11-25');
  console.log('\nDIRECT APPDEPLOY API GATEWAY MCP PROBE PASSED.');
} else {
  console.error(`\nDIRECT APPDEPLOY API GATEWAY IS NOT PUBLICLY USABLE: HTTP ${apiDiscover.response.status}`);
  process.exitCode = 2;
}
