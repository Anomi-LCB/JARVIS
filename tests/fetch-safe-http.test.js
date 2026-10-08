import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import {
  checkLoopbackHttpBoundary,
  isLoopbackHostname,
  isFetchSafePort,
  listenOnFetchSafePort,
  readJsonBody,
  routeParams,
  safeHandle,
  sendJson
} from '../packages/shared/src/http.js';

function boundaryRequest({
  host = '127.0.0.1:41730',
  origin,
  fetchSite,
  remoteAddress = '127.0.0.1'
} = {}) {
  return {
    headers: {
      ...(host === null ? {} : { host }),
      ...(origin === undefined ? {} : { origin }),
      ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite })
    },
    socket: { remoteAddress }
  };
}

function rawJsonRequest({ port, headers = {} }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolveRequest({ statusCode: response.statusCode, body: body ? JSON.parse(body) : null });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

test('fetch-safe HTTP listener rejects ports blocked by Fetch before binding', async () => {
  assert.equal(isFetchSafePort(4190), false);
  assert.equal(isFetchSafePort(6679), false);
  assert.equal(isFetchSafePort(4191), true);

  const server = createServer((_request, response) => response.end('ok'));
  await assert.rejects(
    listenOnFetchSafePort(server, { port: 4190 }),
    { name: 'RangeError', message: 'fetch_safe_port_blocked' }
  );
  assert.equal(server.listening, false);
});

test('fetch-safe HTTP listener returns a Fetch-compatible ephemeral port', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  const address = await listenOnFetchSafePort(server);
  try {
    assert.equal(isFetchSafePort(address.port), true);
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
});

test('shared JSON HTTP boundary rejects malformed and oversized bodies without leaking internals', async () => {
  const server = createServer((request, response) => safeHandle(response, async () => {
    if (request.url === '/internal-error') {
      throw new Error('C:\\private\\operator-secret.txt');
    }
    const body = await readJsonBody(request, { maximumBytes: 32 });
    sendJson(response, 200, { success: true, body });
  }));
  const address = await listenOnFetchSafePort(server);
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const malformed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":'
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(64) })
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'REQUEST_BODY_TOO_LARGE');

    const internal = await fetch(`${endpoint}/internal-error`);
    const internalPayload = await internal.json();
    assert.equal(internal.status, 500);
    assert.equal(internalPayload.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(internalPayload).includes('operator-secret'), false);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
});

test('shared HTTP helpers fail closed for malformed route encoding and normalize bearer output headers', async () => {
  assert.equal(routeParams('/tasks/:taskId', '/tasks/%E0%A4%A'), null);

  const server = createServer((_request, response) => sendJson(response, 200, { value: '한글' }));
  const address = await listenOnFetchSafePort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /charset=utf-8/i);
    assert.deepEqual(await response.json(), { value: '한글' });
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
});

test('loopback HTTP boundary accepts canonical local requests and rejects rebinding and cross-site variants', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.255.255.254'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHostname('128.0.0.1'), false);

  assert.equal(checkLoopbackHttpBoundary(boundaryRequest()).allowed, true);
  assert.equal(checkLoopbackHttpBoundary(boundaryRequest({
    host: '[::1]:41730',
    origin: 'http://[::1]:41730',
    fetchSite: 'same-origin',
    remoteAddress: '::1'
  })).allowed, true);
  assert.equal(checkLoopbackHttpBoundary(boundaryRequest({
    host: 'localhost:41730',
    origin: 'http://localhost:41730',
    remoteAddress: '::ffff:127.0.0.1'
  })).allowed, true);

  const denied = [
    boundaryRequest({ remoteAddress: null }),
    boundaryRequest({ remoteAddress: '192.168.1.20' }),
    boundaryRequest({ host: null }),
    boundaryRequest({ host: 'evil.example' }),
    boundaryRequest({ host: 'evil.example@127.0.0.1' }),
    boundaryRequest({ origin: 'https://evil.example' }),
    boundaryRequest({ origin: 'http://localhost:41730' }),
    boundaryRequest({ origin: 'https://127.0.0.1:41730' }),
    boundaryRequest({ origin: 'http://127.0.0.1:41730/forged' }),
    boundaryRequest({ origin: 'not-an-origin' }),
    boundaryRequest({ fetchSite: 'cross-site' })
  ].map((request) => checkLoopbackHttpBoundary(request));

  assert.equal(denied.every((result) => result.allowed === false), true);
  assert.equal(denied.every((result) => result.statusCode === 403), true);
  assert.equal(denied.every((result) => result.error.code === 'LOCAL_HTTP_BOUNDARY_DENIED'), true);
});

test('loopback HTTP boundary blocks forged browser headers on a live listener', async () => {
  const server = createServer((request, response) => {
    const boundary = checkLoopbackHttpBoundary(request);
    sendJson(response, boundary.allowed ? 200 : boundary.statusCode, boundary);
  });
  const address = await listenOnFetchSafePort(server);
  try {
    const allowed = await rawJsonRequest({
      port: address.port,
      headers: { host: `127.0.0.1:${address.port}` }
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.allowed, true);

    const forgedHost = await rawJsonRequest({
      port: address.port,
      headers: { host: 'attacker.example' }
    });
    assert.equal(forgedHost.statusCode, 403);
    assert.equal(forgedHost.body.reason, 'HOST_NOT_LOOPBACK');

    const crossSite = await rawJsonRequest({
      port: address.port,
      headers: {
        host: `127.0.0.1:${address.port}`,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site'
      }
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(crossSite.body.reason, 'CROSS_SITE_BROWSER_REQUEST');
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
});
