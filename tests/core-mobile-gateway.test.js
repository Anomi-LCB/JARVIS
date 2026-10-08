import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCoreBridgeGateway, mobileGatewayPath } from '../apps/bridge/src/core-gateway.js';
import { createConfiguredCoreServiceRuntime, coreServiceRuntimeOptionsFromEnv } from '../scripts/core-service-runtime.mjs';
import { BridgeClient } from '../apps/mobile/src/api/BridgeClient.js';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeGatewayConnections?.(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
async function raw(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: new URL(url).port, path, headers }, response => {
      let text = ''; response.on('data', data => text += data); response.on('end', () => resolve({ status: response.statusCode, text }));
    }); request.on('error', reject);
  });
}

test('gateway pins the canonical namespace and accepts only a configured local Core origin', () => {
  for (const path of ['/../health', '/%2e%2e/health', '/a/../../owner-session']) assert.equal(mobileGatewayPath(path).startsWith('/mobile/'), true);
  assert.equal(mobileGatewayPath('/tasks?x=%2f'), '/mobile/tasks?x=%2f');
  for (const path of ['//example.com/tasks', 'http://example.com/', '/x\\..\\health', '/health#x']) assert.throws(() => mobileGatewayPath(path));
  for (const coreUrl of ['https://127.0.0.1', 'http://example.com', 'http://user:pass@localhost', 'http://localhost/base', 'http://localhost/?x=1']) assert.throws(() => createCoreBridgeGateway({ coreUrl }));
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { JARVIS_CORE_MOBILE_GATEWAY_ENABLED: 'yes' } }));
  assert.throws(() => coreServiceRuntimeOptionsFromEnv({ env: { JARVIS_CORE_MOBILE_GATEWAY_ENABLED: '1' } }));
});

test('gateway preserves bodies and device credentials, blocks public hosts, never escapes namespace or retries writes', async t => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    let body = ''; request.on('data', data => body += data); request.on('end', () => {
      seen.push({ url: request.url, headers: request.headers, body });
      if (request.url === '/mobile/lost') return request.socket.destroy();
      response.end(JSON.stringify(seen.at(-1)));
    });
  });
  const coreUrl = await listen(upstream), gateway = createCoreBridgeGateway({ coreUrl }), url = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  const sent = await fetch(`${url}/tasks`, { method: 'POST', headers: { authorization: 'Bearer device-token', 'content-type': 'application/json' }, body: '{"rawText":"안녕"}' });
  const body = await sent.json(); assert.equal(body.url, '/mobile/tasks'); assert.equal(body.headers.authorization, 'Bearer device-token'); assert.equal(body.body, '{"rawText":"안녕"}');
  assert.equal((await raw(url, '/tasks', { host: 'attacker.example' })).status, 403);
  assert.equal((await raw(url, '/tasks', { 'x-forwarded-for': '8.8.8.8' })).status, 403);
  for (const path of ['/../health', '/%2e%2e/owner-session', '/%2f../health']) {
    await raw(url, path); assert.ok(seen.at(-1).url.startsWith('/mobile/'));
  }
  const lost = await fetch(`${url}/lost`, { method: 'POST', body: 'effect' }); assert.equal(lost.status, 503);
  assert.equal(seen.filter(item => item.url === '/mobile/lost').length, 1);
  await close(upstream); assert.equal((await fetch(`${url}/health`)).status, 503);
});

test('HTTP mobile client uses the configured Core task store, persisted pairing and approval policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-core-mobile-'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_CORE_ROOT: root, JARVIS_TEST_AUDIT_ROOT: join(root, 'audit'), JARVIS_CORE_PORT: '0',
    JARVIS_CORE_MOBILE_GATEWAY_ENABLED: '1', JARVIS_DEVICE_TOKEN_SECRET: 'isolated-gateway-secret-32-characters',
    JARVIS_BRIDGE_STATE_DIR: join(root, 'paired'), JARVIS_CORE_WORKER_DAEMON_ENABLED: '0', JARVIS_CORE_WORKER_DAEMON_AUTOSTART: '0',
    JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  let runtime, gateway;
  t.after(async () => { if (gateway) await close(gateway); if (runtime) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  runtime = await createConfiguredCoreServiceRuntime({ env });
  const coreUrl = await listen(runtime.server); gateway = createCoreBridgeGateway({ coreUrl }); const url = await listen(gateway);
  assert.equal(runtime.bridgeRuntime.coreFacade, runtime.coreFacade);
  assert.equal(runtime.bridgeRuntime.orchestrationWorker, runtime.orchestrationWorker);
  const pairing = await (await fetch(`${url}/pairing/start`, { method: 'POST' })).json();
  const paired = await (await fetch(`${url}/pairing/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'gateway-test-device', deviceName: '격리 테스트', pairingCode: pairing.pairingCode }) })).json();
  assert.ok(paired.deviceToken, JSON.stringify(paired));
  const token = paired.deviceToken;
  const client = new BridgeClient({ bridgeUrl: url, tokenProvider: () => token, retries: 0 });
  const created = await client.createTask({ rawText: '테스트 보고서를 만들어줘', requestId: 'gateway-request-1' });
  assert.ok(created.taskId, JSON.stringify(created));
  assert.ok(runtime.coreFacade.tasks.get(created.taskId));
  const repeated = await client.createTask({ rawText: '테스트 보고서를 만들어줘', requestId: 'gateway-request-1' });
  assert.equal(repeated.error?.code, 'D_REQUEST_REPLAY_BLOCKED');
  assert.equal(runtime.coreFacade.tasks.size, 1);
  const stream = await fetch(`${url}/events/stream`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const initial = await reader.read(); assert.match(Buffer.from(initial.value).toString(), /stream.opened/);
  await reader.cancel();
  const approval = (await client.getApprovals()).items.find(item => item.taskId === created.taskId);
  assert.ok(approval);
  const decision = await client.request(`/approvals/${encodeURIComponent(approval.approvalId)}/decision`, { method: 'POST', body: { decision: 'approve' } });
  assert.ok(decision.handoffId, JSON.stringify(decision));
  assert.equal(runtime.bridgeRuntime.handoffs.has(decision.handoffId), true);
  assert.equal(runtime.bridgeRuntime.handoffs.get(decision.handoffId).taskId, created.taskId);
  let workerCalls = 0;
  const runTask = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
  runtime.orchestrationWorker.runTask = (...args) => { workerCalls++; return runTask(...args); };
  const confirmation = await client.request(`/execution-handoffs/${encodeURIComponent(decision.handoffId)}/confirm`, { method: 'POST' });
  assert.equal(confirmation.status, 'COMPLETED', JSON.stringify(confirmation));
  assert.equal(workerCalls, 1);
  const result = await client.request(`/results/${encodeURIComponent(created.taskId)}`);
  const outputPaths = result.executionResult?.outputPaths ?? [];
  assert.ok(outputPaths.length > 0, JSON.stringify(result));
  for (const path of outputPaths) assert.ok((await readFile(path)).length > 0);
  const secondConfirm = await client.request(`/execution-handoffs/${encodeURIComponent(decision.handoffId)}/confirm`, { method: 'POST' });
  assert.ok(secondConfirm.status || secondConfirm.error);
  assert.equal(workerCalls, 1);
  console.log(JSON.stringify({ coreMobileGatewayObservation: { observedAt: new Date().toISOString(),
    sharedCoreFacade: true, sharedWorker: true, workerCalls, handoffStatus: confirmation.status ?? null,
    handoffError: confirmation.error?.code ?? null, actualNonemptyArtifacts: outputPaths.length, syntheticDevice: true, realExternalCalls: 0 } }));
  const health = await (await fetch(`${url}/health`)).json(); assert.equal(health.executionAuthorityMode, 'core-api');
  await close(gateway); await runtime.close();
  runtime = await createConfiguredCoreServiceRuntime({ env });
  const restoredUrl = await listen(runtime.server); gateway = createCoreBridgeGateway({ coreUrl: restoredUrl }); const edgeUrl = await listen(gateway);
  const restored = await fetch(`${edgeUrl}/tasks`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(restored.status, 200); assert.notEqual((await restored.json()).success, false);
  const denied = await fetch(`${edgeUrl}/tasks`, { headers: { authorization: 'Bearer wrong-token' } });
  const deniedBody = await denied.json(); assert.equal(deniedBody.success, false);
});

test('gateway tunnels WebSocket frames and closes upgraded sockets without a second execution authority', { timeout: 5000 }, async t => {
  const upstream = http.createServer();
  const peers = new Set();
  upstream.on('upgrade', (request, socket, head) => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    assert.equal(request.url, '/mobile/events');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head); socket.on('data', data => socket.write(data));
  });
  const coreUrl = await listen(upstream), gateway = createCoreBridgeGateway({ coreUrl }), url = await listen(gateway);
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
  socket.on('error', () => {});
  t.after(async () => { socket.destroy(); for (const peer of peers) peer.destroy(); await close(gateway); await close(upstream); });
  await once(socket, 'connect'); socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [header] = await once(socket, 'data'); assert.match(header.toString(), /101 Switching/);
  socket.write(Buffer.from([0x89, 0x00])); const [frame] = await once(socket, 'data'); assert.deepEqual(frame, Buffer.from([0x89, 0x00]));
  const ended = once(socket, 'close'); gateway.closeGatewayConnections(); await ended;
});

test('actual Bridge CLI is a stateless Core gateway and missing Core URL never creates a local engine', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-bridge-cli-'));
  const entry = fileURLToPath(new URL('../apps/bridge/src/main.mjs', import.meta.url));
  const blocked = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, JARVIS_CORE_API_URL: '', JARVIS_BRIDGE_STANDALONE_DEVELOPMENT: '0' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; blocked.stderr.on('data', data => error += data);
  const [exit] = await once(blocked, 'exit'); assert.notEqual(exit, 0); assert.match(error, /D_GATEWAY_CORE_URL_REQUIRED/);
  assert.deepEqual(await readdir(root), []);
  const upstream = http.createServer((request, response) => response.end(JSON.stringify({ path: request.url })));
  const coreUrl = await listen(upstream);
  const reservation = http.createServer(); await listen(reservation); const port = reservation.address().port; await close(reservation);
  const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, PORT: String(port), JARVIS_CORE_API_URL: coreUrl }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } await close(upstream); await rm(root, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).path, '/mobile/health');
  assert.deepEqual(await readdir(root), []);
});
