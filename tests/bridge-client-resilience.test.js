import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeClient } from '../apps/mobile/src/api/BridgeClient.js';

// Pre-fix static failure paths covered below:
// - BridgeClient.request(): only status >= 500 retries and fixed global delay().
// - BridgeClient.request(): tokenProvider is called before the auth flag is considered.
// - BridgeClient.request(): retryUnsafe is accepted without an Idempotency-Key.
// - BridgeClient.refreshAuthToken(): concurrent 401 responses start independent refreshes.
// - BridgeClient stream URL helpers put device tokens in query strings.
// - Async stream token providers are serialized as "[object Promise]".

test('BridgeClient.request retries GET 429, 408, and 425 while honoring capped retry hints', async () => {
  const sleeps = [];
  const requests = [];
  const nowMs = Date.parse('2026-09-04T00:00:00.000Z');
  const responses = [
    new Response(JSON.stringify({ success: false }), {
      status: 429,
      headers: { 'x-ratelimit-retry-after-ms': '2500' }
    }),
    new Response(JSON.stringify({ success: false }), {
      status: 408,
      headers: { 'retry-after': new Date(nowMs + 5000).toUTCString() }
    }),
    new Response(JSON.stringify({ success: false }), { status: 425 }),
    new Response(JSON.stringify({ success: true, value: 'ready' }), { status: 200 })
  ];
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 3,
    retryDelayMs: 25,
    maxRetryDelayMs: 1000,
    nowFn: () => nowMs,
    sleepFn: async (ms) => sleeps.push(ms),
    fetchImpl: async (_url, options) => {
      requests.push(options);
      return responses.shift();
    }
  });

  const result = await client.getHealth();

  assert.equal(result.success, true);
  assert.equal(result.value, 'ready');
  assert.equal(requests.length, 4);
  assert.deepEqual(sleeps, [1000, 1000, 75]);
  assert.equal(result.client.retryAttempts, 3);
});

test('BridgeClient constructor nowFn controls failure duration deterministically', async () => {
  let nowMs = 1000;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 0,
    nowFn: () => nowMs,
    fetchImpl: async () => {
      nowMs = 1275;
      throw new Error('offline');
    }
  });

  const result = await client.getHealth();

  assert.equal(result.error.code, 'C_BRIDGE_NETWORK_ERROR');
  assert.equal(result.client.durationMs, 275);
});

test('BridgeClient coalesces concurrent 401 token refreshes into one flight', async () => {
  let activeToken = 'expired-token';
  let expiredRequests = 0;
  let releaseExpiredRequests;
  const bothExpiredRequestsStarted = new Promise((resolve) => {
    releaseExpiredRequests = resolve;
  });
  let releaseRefresh;
  const refreshMayFinish = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshStarted;
  const refreshHasStarted = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  let refreshCalls = 0;
  const authHeaders = [];
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    tokenProvider: () => activeToken,
    tokenRefresher: async () => {
      refreshCalls += 1;
      refreshStarted();
      await refreshMayFinish;
      activeToken = 'fresh-token';
      return { deviceToken: activeToken };
    },
    fetchImpl: async (_url, options) => {
      const authorization = options.headers.authorization;
      authHeaders.push(authorization);
      if (authorization === 'Bearer expired-token') {
        expiredRequests += 1;
        if (expiredRequests === 2) releaseExpiredRequests();
        await bothExpiredRequestsStarted;
        return new Response(JSON.stringify({
          success: false,
          error: { code: 'D_AUTH_INVALID_TOKEN', message: 'expired' }
        }), { status: 401 });
      }
      return new Response(JSON.stringify({ success: true, status: 'connected' }), { status: 200 });
    }
  });

  const first = client.getDevices();
  const second = client.getApprovals();
  await refreshHasStarted;
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  releaseRefresh();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.equal(refreshCalls, 1);
  assert.equal(authHeaders.filter((value) => value === 'Bearer expired-token').length, 2);
  assert.equal(authHeaders.filter((value) => value === 'Bearer fresh-token').length, 2);
});

test('BridgeClient permits unsafe retries only with one stable valid Idempotency-Key', async () => {
  let defaultPostCalls = 0;
  const defaultPostClient = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
    fetchImpl: async () => {
      defaultPostCalls += 1;
      throw new Error('connection reset');
    }
  });

  const defaultPost = await defaultPostClient.request('/tasks', {
    method: 'POST',
    body: { command: 'one attempt' }
  });
  assert.equal(defaultPost.error.code, 'C_BRIDGE_NETWORK_ERROR');
  assert.equal(defaultPostCalls, 1);

  let callsWithoutKey = 0;
  let tokenCallsWithoutKey = 0;
  const clientWithoutKey = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    tokenProvider: () => {
      tokenCallsWithoutKey += 1;
      return 'device-token';
    },
    retries: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
    fetchImpl: async () => {
      callsWithoutKey += 1;
      throw new Error('transport must not run');
    }
  });

  const withoutKey = await clientWithoutKey.request('/tasks', {
    method: 'POST',
    body: { command: 'unsafe' },
    retryUnsafe: true
  });
  assert.equal(withoutKey.success, false);
  assert.equal(withoutKey.error.code, 'C_BRIDGE_IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(withoutKey.friendlyError.retryable, false);
  assert.equal(tokenCallsWithoutKey, 0);
  assert.equal(callsWithoutKey, 0);

  let callsWithInvalidKey = 0;
  const clientWithInvalidKey = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
    fetchImpl: async () => {
      callsWithInvalidKey += 1;
      throw new Error('connection reset');
    }
  });
  const invalidKey = await clientWithInvalidKey.request('/tasks', {
    method: 'POST',
    body: { command: 'unsafe' },
    retryUnsafe: true,
    headers: { 'Idempotency-Key': 'bad\r\nkey' }
  });
  assert.equal(invalidKey.error.code, 'C_BRIDGE_IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(callsWithInvalidKey, 0);

  const seenKeys = [];
  let callsWithKey = 0;
  const clientWithKey = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
    fetchImpl: async (_url, options) => {
      callsWithKey += 1;
      const header = Object.entries(options.headers)
        .find(([name]) => name.toLowerCase() === 'idempotency-key');
      seenKeys.push(header?.[1] ?? null);
      if (callsWithKey < 3) {
        return new Response(JSON.stringify({ success: false }), { status: 503 });
      }
      return new Response(JSON.stringify({ success: true, taskId: 'task-1' }), { status: 200 });
    }
  });

  const withKey = await clientWithKey.request('/tasks', {
    method: 'POST',
    body: { command: 'idempotent' },
    retryUnsafe: true,
    headers: { 'Idempotency-Key': 'job-123' }
  });

  assert.equal(withKey.success, true);
  assert.equal(callsWithKey, 3);
  assert.deepEqual(seenKeys, ['job-123', 'job-123', 'job-123']);
});

test('BridgeClient skips tokenProvider whenever auth is false', async () => {
  let tokenProviderCalls = 0;
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    tokenProvider: () => {
      tokenProviderCalls += 1;
      throw new Error('tokenProvider must not run');
    },
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
  });

  const result = await client.getHealth();

  assert.equal(result.status, 'ok');
  assert.equal(tokenProviderCalls, 0);
});

test('BridgeClient aborts during retry backoff without issuing another fetch', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  let sleepStarted;
  const backoffStarted = new Promise((resolve) => {
    sleepStarted = resolve;
  });
  const client = new BridgeClient({
    bridgeUrl: 'http://bridge.local',
    retries: 1,
    retryDelayMs: 100,
    sleepFn: async () => {
      sleepStarted();
      await new Promise(() => {});
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ success: false }), { status: 503 });
    }
  });

  const pending = client.request('/health', { auth: false, signal: controller.signal });
  await Promise.race([
    backoffStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('retry backoff did not start')), 250))
  ]);
  controller.abort(new Error('user cancelled during backoff'));
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not cancel backoff')), 250))
  ]);

  assert.equal(result.error.code, 'C_BRIDGE_REQUEST_CANCELLED');
  assert.equal(fetchCalls, 1);
});

test('BridgeClient stream URLs never expose device tokens or Promise placeholders', () => {
  const token = 'device.header-only.secret';
  const client = new BridgeClient({
    bridgeUrl: 'https://bridge.local',
    tokenProvider: () => token
  });
  const eventStreamUrl = client.eventStreamUrl({ sinceEventId: 'evt-1', eventType: 'task.created' });
  const webSocketUrl = client.eventWebSocketUrl({ sinceEventId: 'evt-1', eventType: 'task.created' });

  for (const url of [eventStreamUrl, webSocketUrl]) {
    assert.equal(url.includes(token), false);
    assert.equal(new URL(url).searchParams.has('token'), false);
    assert.equal(new URL(url).searchParams.get('sinceEventId'), 'evt-1');
    assert.equal(new URL(url).searchParams.get('eventType'), 'task.created');
  }

  const asyncClient = new BridgeClient({
    bridgeUrl: 'https://bridge.local',
    tokenProvider: async () => token
  });
  assert.equal(asyncClient.eventStreamUrl().includes('%5Bobject+Promise%5D'), false);
  assert.equal(asyncClient.eventWebSocketUrl().includes('%5Bobject+Promise%5D'), false);
});

test('BridgeClient resolves async tokens into header-safe stream connection options', async () => {
  const token = 'device.async.secret';
  const client = new BridgeClient({
    bridgeUrl: 'https://bridge.local',
    tokenProvider: async () => token
  });

  const eventStream = await client.eventStreamConnection({ eventType: 'task.created' });
  const webSocket = await client.eventWebSocketConnection({ sinceEventId: 'evt-2' });

  assert.equal(eventStream.url, 'https://bridge.local/events/stream?eventType=task.created');
  assert.equal(webSocket.url, 'wss://bridge.local/events/ws?sinceEventId=evt-2');
  assert.deepEqual(eventStream.headers, { authorization: `Bearer ${token}` });
  assert.deepEqual(webSocket.headers, { authorization: `Bearer ${token}` });
  assert.equal(eventStream.credentialsInUrl, false);
  assert.equal(webSocket.credentialsInUrl, false);
});
