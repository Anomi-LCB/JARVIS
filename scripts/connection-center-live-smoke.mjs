import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

// Exercises the running authenticated UI/Core boundary without reading user documents or keys.
const base = 'http://127.0.0.1:41730';
const request = async (path, options = {}) => {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', ...options.headers } });
  const payload = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${payload.error?.code ?? ''}`);
  return payload;
};
const methods = [];
const fixture = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body); methods.push(rpc.method);
  res.setHeader('content-type', 'application/json');
  const result = rpc.method === 'tools/call'
    ? { content: [{ type:'text', text:String(rpc.params.arguments.value * 2) }] }
    : { tools: [{ name:'connection_fixture_status', description:'Local deterministic calculation test', inputSchema:{ type:'object', properties:{value:{type:'integer'}}, required:['value'], additionalProperties:false } }] };
  res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
const address = await listenOnFetchSafePort(fixture);
let connectionId;
try {
  const capabilities = await request('/api/local/capabilities');
  assert.equal(capabilities.credentialsExposed, false);
  assert.equal(capabilities.coreAdminProxyConfigured, true);
  const readiness = await request('/api/core/integrations');
  const created = await request('/api/core/integrations/mcp', { method: 'POST', body: JSON.stringify({
    label: 'Temporary connection smoke fixture', endpoint: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: '2026-07-28'
  }) });
  connectionId = created.id;
  const checked = await request(`/api/core/integrations/mcp/${connectionId}/probe`, { method: 'POST' });
  assert.equal(checked.status, 'tools-listed');
  assert.equal(checked.executionAuthorized, false);
  assert.equal(checked.tools[0].name, 'connection_fixture_status');
  assert.deepEqual(methods, ['tools/list']);
  await request(`/api/core/integrations/mcp/${connectionId}/permissions`, { method:'POST', body:JSON.stringify({tools:['connection_fixture_status']}) });
  const trust = await request('/api/core/security/trust');
  const callOptions = { method:'POST', body:JSON.stringify({tool:'connection_fixture_status',arguments:{value:21},expectedText:'42',requestId:crypto.randomUUID().replaceAll('-','')}) };
  let called;
  if (trust.mode === 'trusted') {
    called = await request(`/api/core/integrations/mcp/${connectionId}/call`,callOptions);
    assert.equal(called.status,'expectation-matched'); assert.equal(called.result.content[0].text,'42'); assert.equal(called.businessOutcomeVerified,false);
    assert.equal(methods.filter(method=>method==='tools/call').length,1);
  } else {
    const response=await fetch(`${base}/api/core/integrations/mcp/${connectionId}/call`,{...callOptions,headers:{'content-type':'application/json'}});
    assert.equal(response.status,409); assert.equal((await response.json()).error.code,'A_MCP_POLICY_DENIED');
    assert.equal(methods.filter(method=>method==='tools/call').length,0);
  }
  if (process.argv.includes('--keep-ui')) {
    console.log('Temporary MCP UI fixture active. Send a newline to clean up.');
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
  const removed = await request(`/api/core/integrations/mcp/${connectionId}`, { method: 'DELETE' });
  assert.equal(removed.removed, true); connectionId = null;
  const evidence = { observedAt: new Date().toISOString(), status: 'passed',
    realUiAndCore: true, mcpServer: 'isolated HTTP fixture', externalAccountsTested: false,
    credentialsExposed: false, registrationProbeRemoval: 'passed', toolsCalled: 0,
    providerConnectionCount: readiness.connections?.length ?? null };
  evidence.status=called ? 'passed' : 'execution-blocked'; evidence.policyEnforced=true; evidence.trustMode=trust.mode; evidence.reasonCodes=trust.reasonCodes;
  evidence.toolsCalled=methods.filter(method=>method==='tools/call').length; evidence.calculationExpected='42'; evidence.calculationObserved=called?.result.content[0].text ?? null;
  await writeFile('artifacts/mcp-execution-20261001-live.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));

} finally {
  if (connectionId) await request(`/api/core/integrations/mcp/${connectionId}`, { method: 'DELETE' });
  await new Promise(resolve => fixture.close(resolve));
}
