import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const bridgeClientModulePath = resolve(process.argv[3] ?? 'apps/mobile/src/api/BridgeClient.js');
const { BridgeClient } = await import(pathToFileURL(bridgeClientModulePath).href);

const DEFAULT_OUTPUT = resolve(
  'artifacts',
  'extreme-workflow-50-audit',
  '2026-09-04-baseline-product-gaps',
  'bridge-client-baseline.json'
);

async function main() {
  const outputPath = resolve(process.argv[2] ?? DEFAULT_OUTPUT);
  const probes = [];

  probes.push(await probeRateLimitRetry());
  probes.push(await probeConcurrentRefreshSingleFlight());
  probes.push(await probeUnsafeRetryGuard());
  probes.push(await probePublicRequestTokenIsolation());
  probes.push(await probeSeparatedAuthAndTransportBudgets());
  probes.push(await probeAbortableBackoff());
  probes.push(await probeEmptySuccessBody());

  const report = {
    reportVersion: 'jarvis-extreme-bridge-baseline-v1',
    executionMode: 'deterministic-in-memory-fetch',
    realExternalCalls: 0,
    generatedAt: new Date().toISOString(),
    bridgeClientModulePath,
    passed: probes.filter((item) => item.passed).length,
    failed: probes.filter((item) => !item.passed).length,
    probes
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, passed: report.passed, failed: report.failed }));
  process.exitCode = report.failed > 0 ? 1 : 0;
}

async function probeRateLimitRetry() {
  let calls = 0;
  const delays = [];
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    retries: 1,
    retryDelayMs: 7,
    sleepFn: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ success: false, error: { code: 'D_RATE_LIMITED', message: 'slow down' } }), {
          status: 429,
          headers: { 'retry-after': '2' }
        });
      }
      return new Response(JSON.stringify({ status: 'connected' }), { status: 200 });
    }
  });
  const result = await client.getHealth();
  return probe('BRIDGE_429_RETRY_AFTER', result?.status === 'connected' && calls === 2 && delays[0] === 2000, {
    calls,
    delays,
    resultCode: result?.error?.code ?? null,
    expected: 'safe GET retries once after exactly 2000 virtual milliseconds'
  });
}

async function probeConcurrentRefreshSingleFlight() {
  let token = 'expired-token';
  let refreshCalls = 0;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    tokenProvider: () => token,
    tokenRefresher: async () => {
      refreshCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { deviceToken: 'fresh-token' };
    },
    onTokenRefresh: async (nextToken) => { token = nextToken; },
    fetchImpl: async (_url, options) => options.headers.authorization === 'Bearer expired-token'
      ? new Response(JSON.stringify({ success: false, error: { code: 'D_AUTH_INVALID_TOKEN', message: 'expired' } }), { status: 401 })
      : new Response(JSON.stringify({ status: 'connected' }), { status: 200 })
  });
  const results = await Promise.all([client.heartbeat(), client.getDevices()]);
  return probe('BRIDGE_AUTH_REFRESH_SINGLE_FLIGHT', refreshCalls === 1 && results.every((item) => item?.success !== false), {
    refreshCalls,
    statuses: results.map((item) => item?.status ?? item?.error?.code ?? 'ok'),
    expected: 'two simultaneous 401 responses share one token refresh'
  });
}

async function probeUnsafeRetryGuard() {
  let calls = 0;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    retries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('ack lost after possible commit');
      return new Response(JSON.stringify({ success: true, committed: true }), { status: 200 });
    }
  });
  const result = await client.request('/unsafe', {
    method: 'POST',
    body: { mutation: 'create' },
    retryUnsafe: true
  });
  return probe('BRIDGE_UNSAFE_RETRY_REQUIRES_IDEMPOTENCY_KEY', calls === 0 && result?.error?.code === 'C_BRIDGE_IDEMPOTENCY_KEY_REQUIRED', {
    calls,
    resultCode: result?.error?.code ?? null,
    success: result?.success ?? null,
    expected: 'unsafe retry is rejected before transport when no idempotency key exists'
  });
}

async function probePublicRequestTokenIsolation() {
  let tokenCalls = 0;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    tokenProvider: () => {
      tokenCalls += 1;
      throw new Error('secure storage unavailable');
    },
    fetchImpl: async () => new Response(JSON.stringify({ openapi: '3.1.0' }), { status: 200 })
  });
  let result;
  let thrown = null;
  try {
    result = await client.request('/openapi.json', { auth: false });
  } catch (error) {
    thrown = error?.message ?? String(error);
  }
  return probe('BRIDGE_PUBLIC_REQUEST_SKIPS_TOKEN_PROVIDER', tokenCalls === 0 && result?.openapi === '3.1.0' && thrown === null, {
    tokenCalls,
    thrown,
    result: result ?? null,
    expected: 'auth:false never touches secure token storage'
  });
}

async function probeSeparatedAuthAndTransportBudgets() {
  let token = 'expired-token';
  let calls = 0;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    retries: 1,
    retryDelayMs: 0,
    tokenProvider: () => token,
    tokenRefresher: async () => ({ deviceToken: 'fresh-token' }),
    onTokenRefresh: async (nextToken) => { token = nextToken; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ success: false, error: { code: 'D_AUTH_INVALID_TOKEN' } }), { status: 401 });
      if (calls === 2) return new Response(JSON.stringify({ success: false, error: { code: 'D_TEMPORARY' } }), { status: 503 });
      return new Response(JSON.stringify({ status: 'connected' }), { status: 200 });
    }
  });
  const result = await client.getDevices();
  return probe('BRIDGE_AUTH_AND_TRANSPORT_RETRY_BUDGETS', calls === 3 && result?.status === 'connected', {
    calls,
    resultCode: result?.error?.code ?? null,
    expected: 'one auth refresh does not consume the one transient transport retry'
  });
}

async function probeAbortableBackoff() {
  let calls = 0;
  const controller = new AbortController();
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    retries: 1,
    retryDelayMs: 150,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('temporary network loss');
    }
  });
  const started = performance.now();
  const pending = client.request('/health', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled during retry delay')), 5);
  const result = await pending;
  const elapsedMs = Math.round(performance.now() - started);
  return probe('BRIDGE_ABORTABLE_BACKOFF', calls === 1 && elapsedMs < 100 && result?.error?.code === 'C_BRIDGE_REQUEST_CANCELLED', {
    calls,
    elapsedMs,
    resultCode: result?.error?.code ?? null,
    expected: 'abort interrupts retry delay and prevents another transport attempt'
  });
}

async function probeEmptySuccessBody() {
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.invalid',
    fetchImpl: async () => new Response(null, { status: 204 })
  });
  const result = await client.request('/no-content', { auth: false });
  return probe('BRIDGE_204_EMPTY_BODY', result?.success !== false && result?.client?.retryAttempts === 0, {
    result,
    expected: '204 empty success returns an empty payload with client metadata'
  });
}

function probe(id, passed, detail) {
  return { id, passed, detail };
}

await main();
