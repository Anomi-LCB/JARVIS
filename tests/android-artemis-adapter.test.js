import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ArtemisClient } from '../apps/pc-agent/src/adapters/android-artemis/artemis-client.js';

const serial = 'emulator-5554';
const device = { serial, state: 'device', is_busy: false, is_emulator: true };

async function fixture(t, custom = () => undefined, options = {}) {
  const requests = [];
  const sessions = new Map();
  const state = { queue: [], active_tasks: [], status: 'idle' };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    const call = { method: request.method, path: request.url, body };
    requests.push(call);
    const special = await custom(call, { sessions, state, response, requests });
    if (special === 'handled') return;
    let result = special;
    let status = 200;
    if (result === undefined) {
      if (call.path === '/api/devices') result = { devices: [device] };
      else if (call.path === '/api/system/readiness') result = { overall_ready: true, active_device: { serial, is_locked: false }, probes: [{ id: 'adb', status: 'pass', is_blocker: true }] };
      else if (call.path === '/api/status') result = state;
      else if (call.path === '/api/run') {
        sessions.set(body.session_id, { session_id: body.session_id, device_serial: body.device_serial, status: 'completed' });
        result = { status: 'started', tasks: [{ session_id: body.session_id, device_serial: body.device_serial, status: 'pending' }], enqueued_count: 1 };
      } else if (call.path === '/api/stop') {
        sessions.set(body.session_id, { session_id: body.session_id, device_serial: serial, status: 'cancelled' });
        state.active_tasks = state.active_tasks.filter(task => task.session_id !== body.session_id);
        state.queue = state.queue.filter(task => task.session_id !== body.session_id);
        state.status = 'idle';
        result = { status: 'stopped', session_id: body.session_id };
      } else if (/^\/api\/sessions\/[^/]+\/steps$/.test(call.path)) {
        const id = call.path.split('/')[3];
        result = [{ session_id: id, step_id: 'step-1', step_number: 1, post_image_name: 'screen.png', operator_raw_thinking: 'private model reasoning', action_taken: { text: 'private data' }, generic_tools: [{ trace_id: 'trace-1', name: 'tap', status: 'success', payload: { api_key: 'private-key' } }] }];
      } else if (call.path.startsWith('/api/sessions/')) {
        result = sessions.get(call.path.split('/')[3]);
        if (!result) { status = 404; result = { detail: 'not found' }; }
      } else { status = 404; result = { detail: 'unknown route' }; }
    }
    if (response.destroyed) return;
    // These short-lived per-test HTTP servers share Node's global fetch pool
    // with the full suite. Closing each fixture connection avoids reusing a
    // just-closed socket when the OS rapidly recycles an ephemeral test port.
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = new ArtemisClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceSerial: serial, pollIntervalMs: 10, cancelTimeoutMs: 50, timeoutMs: 500, ...options });
  return { client, requests, sessions, state };
}

test('ARTEMIS unconfigured readiness is explicit and makes no request', async () => {
  const client = new ArtemisClient({ baseUrl: '', fetchImpl: () => { throw new Error('must not call'); } });
  assert.deepEqual(await client.readiness(), { provider: 'google-artemis', configured: false, connected: false, ready: false, deviceSerial: null, deviceCount: null, reason: 'not_configured', device: null, probes: [] });
});

test('ARTEMIS rejects remote cleartext, implicit remote access and credential-bearing URLs', () => {
  for (const baseUrl of ['http://example.com', 'https://example.com', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost?token=secret']) {
    assert.throws(() => new ArtemisClient({ baseUrl }), /ARTEMIS/);
  }
  assert.throws(() => new ArtemisClient({ baseUrl: 'http://example.com', allowRemote: true }), { code: 'B_ARTEMIS_REMOTE_DISABLED' });
  assert.equal(new ArtemisClient({ baseUrl: 'https://example.com', allowRemote: true }).configured, true);
});

test('ARTEMIS readiness verifies the requested device and minimizes diagnostic metadata', async t => {
  const { client } = await fixture(t);
  const ready = await client.readiness();
  assert.equal(ready.connected, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.device.serial, serial);
  assert.equal(ready.deviceCount, 1);
  const missing = await client.readiness({ deviceSerial: 'missing-device' });
  assert.equal(missing.ready, false);
  assert.equal(missing.reason, 'device_unavailable');
});

test('ARTEMIS readiness does not apply another selected device unlock result to the target', async t => {
  const { client } = await fixture(t, call => call.path === '/api/system/readiness' ? { overall_ready: true, probes: [], active_device: { serial: 'other', is_locked: false } } : undefined);
  assert.equal((await client.readiness()).reason, 'target_readiness_unverified');
});

test('ARTEMIS offline and malformed devices do not report connected success', async t => {
  const { client } = await fixture(t, call => call.path === '/api/devices' ? { devices: [{ ...device, state: 'unauthorized' }] } : undefined);
  assert.equal((await client.readiness()).ready, false);
  await assert.rejects(client.submitTask({ goal: '설정 화면 확인' }), { code: 'B_ARTEMIS_DEVICE_UNAVAILABLE' });
  const broken = new ArtemisClient({ baseUrl: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('credential-secret'); } });
  const readiness = await broken.readiness();
  assert.equal(readiness.connected, false);
  assert.equal(JSON.stringify(readiness).includes('credential-secret'), false);
});

test('ARTEMIS request uses the real run contract and keeps an admission distinct from completion', async t => {
  const { client, requests } = await fixture(t);
  const id = randomUUID();
  const result = await client.submitTask({ goal: '배터리 잔량 확인', sessionId: id, profile: 'pro', lockedAppPackage: 'com.android.settings', expectedOutput: '배터리 잔량', verificationLevel: 'final' });
  assert.equal(result.status, 'queued');
  assert.equal(result.verified, false);
  assert.deepEqual(requests.find(call => call.path === '/api/run').body, { goal: '배터리 잔량 확인', profile: 'pro', device_serial: serial, session_id: id, ingress: 'jarvis', locked_app_package: 'com.android.settings', expected_output: '배터리 잔량', verification_level: 'final' });
});

test('ARTEMIS accepted session retries are not resubmitted and changed commands conflict', async t => {
  const { client, requests } = await fixture(t);
  const input = { goal: '앱 화면 확인', sessionId: randomUUID() };
  await client.submitTask(input);
  await client.submitTask(input);
  assert.equal(requests.filter(call => call.path === '/api/run').length, 1);
  await assert.rejects(client.submitTask({ ...input, goal: '다른 명령' }), { code: 'B_ARTEMIS_SESSION_CONFLICT' });
});

test('ARTEMIS uncertain admission preserves the same session ID for safe reconciliation', async t => {
  let admissions = 0;
  const { client, requests } = await fixture(t, (call, { sessions, response }) => {
    if (call.path !== '/api/run' || admissions++ > 0) return undefined;
    sessions.set(call.body.session_id, { session_id: call.body.session_id, device_serial: serial, status: 'running' });
    response.destroy();
    return 'handled';
  });
  const input = { goal: '화면 확인', sessionId: randomUUID() };
  await assert.rejects(client.submitTask(input), error => error.admissionUnknown === true && error.sessionId === input.sessionId);
  await client.submitTask(input);
  assert.deepEqual(requests.filter(call => call.path === '/api/run').map(call => call.body.session_id), [input.sessionId]);
});

test('ARTEMIS never treats unrelated latest completed session or global idle as this task success', async t => {
  const { client, state } = await fixture(t);
  state.session_id = randomUUID();
  const result = await client.getTaskStatus(randomUUID());
  assert.equal(result.status, 'unknown');
  assert.equal(result.terminal, false);
});

test('ARTEMIS rejects an explicit device mismatch and wrong session evidence', async t => {
  const id = randomUUID();
  const { client, sessions } = await fixture(t, call => call.path.endsWith('/steps') ? [{ session_id: randomUUID(), step_id: 'foreign' }] : undefined);
  sessions.set(id, { session_id: id, device_serial: 'another-device', status: 'completed' });
  await assert.rejects(client.getTaskStatus(id), { code: 'B_ARTEMIS_DEVICE_MISMATCH' });
  sessions.set(id, { session_id: id, device_serial: serial, status: 'completed' });
  await assert.rejects(client.collectEvidence(id), { code: 'B_ARTEMIS_SESSION_MISMATCH' });
});

test('ARTEMIS evidence excludes raw commands, secrets and model reasoning; completion needs an independent verifier', async t => {
  const { client } = await fixture(t);
  const unverified = await client.runTask({ goal: '화면 확인' });
  assert.equal(unverified.status, 'completed');
  assert.equal(unverified.success, false);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.stepCount, 1);
  assert.equal(unverified.sourceDigest.length, 64);
  assert.equal(/private|reasoning|payload|action_taken/.test(JSON.stringify(unverified)), false);
  const verified = await client.runTask({ goal: '별도 결과 검증' }, { verifyResult: async evidence => ({ verified: evidence.stepCount === 1, evidenceId: 'G-test-evidence' }) });
  assert.equal(verified.success, true);
  assert.equal(verified.verification.evidenceId, 'G-test-evidence');
});

test('ARTEMIS stop acknowledgment is not cancellation confirmation while a worker remains active', async t => {
  const id = randomUUID();
  const { client, sessions, state, requests } = await fixture(t, call => call.path === '/api/stop' ? { status: 'stopped', session_id: id } : undefined);
  sessions.set(id, { session_id: id, device_serial: serial, status: 'cancelled' });
  state.active_tasks = [{ session_id: id, device_id: serial }];
  const result = await client.cancelTask(id, { timeoutMs: 30 });
  assert.equal(result.status, 'cancelling');
  assert.equal(result.cancellationConfirmed, false);
  assert.deepEqual(requests.find(call => call.path === '/api/stop').body, { session_id: id });
});

test('ARTEMIS task deadline cancels only its own submitted session', async t => {
  const { client, requests } = await fixture(t, (call, { sessions, state }) => {
    if (call.path !== '/api/run') return undefined;
    sessions.set(call.body.session_id, { session_id: call.body.session_id, device_serial: serial, status: 'running' });
    state.active_tasks = [{ session_id: call.body.session_id, device_id: serial }];
    return { status: 'started', tasks: [{ session_id: call.body.session_id, status: 'running' }] };
  });
  const id = randomUUID();
  await assert.rejects(client.runTask({ goal: '기다리는 작업', sessionId: id }, { timeoutMs: 50 }), error => error.code === 'B_ARTEMIS_TASK_TIMEOUT' && error.cancellation?.cancellationConfirmed === true);
  assert.deepEqual(requests.filter(call => call.path === '/api/stop').map(call => call.body), [{ session_id: id }]);
});

test('ARTEMIS per-device runs serialize until the previous run and verification finish', async t => {
  const { client, requests } = await fixture(t);
  let release;
  let verificationStarted;
  const started = new Promise(resolve => { verificationStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = client.runTask({ goal: '첫 작업' }, { verifyResult: async () => { verificationStarted(); await gate; return { verified: true, evidenceId: 'first' }; } });
  await started;
  const second = client.runTask({ goal: '두 번째 작업' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.filter(call => call.path === '/api/run').length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(requests.filter(call => call.path === '/api/run').length, 2);
});

test('ARTEMIS a queued caller can abort without submitting or stopping another task', async t => {
  const { client, requests } = await fixture(t);
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = client.runTask({ goal: '진행 작업' }, { verifyResult: async () => { started(); await gate; return { verified: true, evidenceId: 'first' }; } });
  await entered;
  const controller = new AbortController();
  const waiting = client.runTask({ goal: '대기 작업' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { code: 'B_ARTEMIS_ABORTED' });
  release();
  await first;
  assert.equal(requests.filter(call => call.path === '/api/run').length, 1);
  assert.equal(requests.filter(call => call.path === '/api/stop').length, 0);
});

test('ARTEMIS response byte limit, HTTP errors and malformed JSON fail explicitly', async t => {
  const { client } = await fixture(t, (call, { response }) => {
    if (call.path === '/api/devices') return { devices: [], padding: 'x'.repeat(400) };
  }, { maxResponseBytes: 128 });
  await assert.rejects(client.listDevices(), { code: 'B_ARTEMIS_RESPONSE_TOO_LARGE' });
  const invalid = new ArtemisClient({ baseUrl: 'http://localhost', fetchImpl: async () => new Response('{', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(invalid.listDevices(), { code: 'B_ARTEMIS_RESPONSE_INVALID' });
  const failing = new ArtemisClient({ baseUrl: 'http://localhost', fetchImpl: async () => new Response('secret provider error', { status: 500 }) });
  await assert.rejects(failing.listDevices(), error => error.code === 'B_ARTEMIS_HTTP_ERROR' && error.httpStatus === 500 && !error.message.includes('secret'));
});

test('ARTEMIS rejects invalid task boundaries before reaching the server', async t => {
  const { client, requests } = await fixture(t);
  for (const input of [
    { goal: '' }, { goal: 'ok', deviceSerial: '' }, { goal: 'ok', sessionId: '../active' },
    { goal: 'ok', profile: 'auto' }, { goal: 'ok', lockedAppPackage: '../../file.apk' },
    { goal: 'ok', verificationLevel: 'pretend' }
  ]) await assert.rejects(client.submitTask(input));
  assert.equal(requests.length, 0);
});

test('ARTEMIS server rejection never becomes an accepted task', async t => {
  const { client } = await fixture(t, call => call.path === '/api/run' ? { status: 'rejected', tasks: [], error: 'private device information' } : undefined);
  await assert.rejects(client.submitTask({ goal: '화면 보기' }), error => error.code === 'B_ARTEMIS_REJECTED' && error.admissionUnknown === false && !error.message.includes('private'));
});

test('ARTEMIS request timeout and cancellation deadline remain bounded when the server hangs', async t => {
  const { client } = await fixture(t, (call) => ['/api/devices', '/api/stop'].includes(call.path) ? 'handled' : undefined, { timeoutMs: 30 });
  await assert.rejects(client.listDevices(), { code: 'B_ARTEMIS_TIMEOUT' });
  const result = await client.cancelTask(randomUUID(), { timeoutMs: 20 });
  assert.equal(result.cancellationConfirmed, false);
  assert.equal(result.cancellationRequested, false);
});

test('ARTEMIS verification callback cannot hold a device queue beyond the task deadline', async t => {
  const { client } = await fixture(t);
  await assert.rejects(client.runTask({ goal: '검증 대기' }, { timeoutMs: 50, verifyResult: () => new Promise(() => {}) }), { code: 'B_ARTEMIS_TASK_TIMEOUT' });
  assert.equal((await client.runTask({ goal: '다음 작업' })).status, 'completed');
});

test('ARTEMIS concurrent duplicate IDs with different devices cannot bypass command conflict detection', async t => {
  const { client, requests } = await fixture(t, call => call.path === '/api/devices' ? { devices: [device, { ...device, serial: 'emulator-5556' }] } : undefined);
  const id = randomUUID();
  const [first, second] = await Promise.allSettled([
    client.submitTask({ goal: '첫 기기', sessionId: id }),
    client.submitTask({ goal: '다른 기기', sessionId: id, deviceSerial: 'emulator-5556' })
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.reason.code, 'B_ARTEMIS_SESSION_CONFLICT');
  assert.equal(requests.filter(call => call.path === '/api/run').length, 1);
});

test('ARTEMIS caller abort during execution requests targeted cancellation and reports interruption', async t => {
  let submitted;
  const entered = new Promise(resolve => { submitted = resolve; });
  const { client, requests } = await fixture(t, (call, { sessions }) => {
    if (call.path !== '/api/run') return undefined;
    sessions.set(call.body.session_id, { session_id: call.body.session_id, device_serial: serial, status: 'running' });
    submitted();
    return { status: 'started', tasks: [{ session_id: call.body.session_id, status: 'running' }] };
  }, { cancelTimeoutMs: 1_000 });
  const controller = new AbortController();
  const id = randomUUID();
  const promise = client.runTask({ goal: '작업 중단', sessionId: id }, { signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(promise, error => error.code === 'B_ARTEMIS_ABORTED' && error.cancellation?.cancellationConfirmed === true);
  assert.deepEqual(requests.filter(call => call.path === '/api/stop').map(call => call.body), [{ session_id: id }]);
});

test('ARTEMIS abort before run response reconciles possible provider admission by the same session ID', async t => {
  let markAccepted, releaseResponse;
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const { client, requests } = await fixture(t, async (call, { sessions }) => {
    if (call.path !== '/api/run') return undefined;
    sessions.set(call.body.session_id, { session_id: call.body.session_id,
      device_serial: call.body.device_serial, status: 'running' });
    markAccepted();
    await responseGate;
    return { status: 'started', tasks: [{ session_id: call.body.session_id, status: 'running' }] };
  });
  const controller = new AbortController();
  const id = randomUUID();
  try {
    const promise = client.runTask({ goal: '응답 손실 전후 접수 조정', sessionId: id }, { signal: controller.signal });
    await accepted;
    controller.abort();
    await assert.rejects(promise, error => error.code === 'B_ARTEMIS_ABORTED'
      && error.cancellation?.cancellationRequested === true
      && error.cancellation?.cancellationConfirmed === true);
    assert.deepEqual(requests.filter(call => call.path === '/api/stop').map(call => call.body),
      [{ session_id: id }]);
  } finally { releaseResponse(); }
});

test('ARTEMIS upstream credential probe secret fields and descriptions never leave normalized readiness', async t => {
  const secret = 'secret-must-not-leave-readiness';
  const { client } = await fixture(t, call => call.path === '/api/system/readiness' ? {
    overall_ready: false, active_device: { serial, is_locked: false }, probes: [{
      id: 'llm_api_key', category: 'auth', status: 'fail', is_blocker: true,
      summary: secret, description: secret, actions: [{ payload: secret }],
      metadata: { providers: [{ raw_key: secret, key: secret, current_active_key: secret }], api_keys_map: { google: secret } }
    }], current_active_key: secret
  } : undefined);
  const result = await client.readiness();
  assert.equal(result.connected, true);
  assert.equal(result.ready, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.probes, [{ id: 'llm_api_key', category: 'auth', status: 'fail', blocker: true }]);
});
