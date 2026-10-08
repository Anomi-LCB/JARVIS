import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS,
  DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN,
  createHostedControlCorsHeaders,
  isLoopbackHttpUrl,
  isTrustedHostedControlOrigin,
  normalizeHostedOriginList,
  normalizeWebOrigin,
  resolveControlCenterNetwork
} from '../packages/shared/src/control-center-hosting.js';

const hostedOrigin = DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS[0];

test('hosted control origin normalization rejects lookalikes and unsafe URLs', () => {
  assert.equal(normalizeWebOrigin(hostedOrigin), hostedOrigin);
  assert.equal(normalizeWebOrigin(`${hostedOrigin}/path`), null);
  assert.equal(normalizeWebOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeWebOrigin(`https://user:secret@${new URL(hostedOrigin).host}`), null);
  assert.equal(isTrustedHostedControlOrigin(hostedOrigin), true);
  assert.equal(isTrustedHostedControlOrigin(`${hostedOrigin}.attacker.example`), false);
  assert.deepEqual(
    normalizeHostedOriginList([hostedOrigin, `${hostedOrigin}, ${hostedOrigin}`]),
    [hostedOrigin]
  );
});

test('hosted control network routes through the managed loopback proxy only on the trusted site', () => {
  const hosted = resolveControlCenterNetwork({
    locationRef: { origin: hostedOrigin },
    settingReader: () => null
  });
  assert.equal(hosted.mode, 'hosted-local-bridge');
  assert.equal(hosted.localControlOrigin, DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN);
  assert.equal(hosted.coreBaseUrl, `${DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN}/api/core`);
  assert.equal(hosted.pcBaseUrl, `${DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN}/api/pc`);
  assert.equal(hosted.bridgeBaseUrl, `${DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN}/api/bridge`);

  const local = resolveControlCenterNetwork({
    locationRef: { origin: 'http://127.0.0.1:41730' },
    settingReader: () => null
  });
  assert.equal(local.mode, 'local');
  assert.equal(local.coreBaseUrl, '/api/core');
  assert.equal(local.localApiBaseUrl, '');
});

test('loopback request detection is strict enough for browser target-address-space hints', () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:41730/api/core/health'), true);
  assert.equal(isLoopbackHttpUrl('http://127.255.0.1:41730/api/core/health'), true);
  assert.equal(isLoopbackHttpUrl('http://localhost:41730/api/core/health'), true);
  assert.equal(isLoopbackHttpUrl('http://[::1]:41730/api/core/health'), true);
  assert.equal(isLoopbackHttpUrl('https://127.0.0.1:41730/api/core/health'), false);
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1.attacker.example/api'), false);
  assert.equal(isLoopbackHttpUrl('http://192.168.0.10/api'), false);
});

test('hosted control ignores stored non-loopback proxy origins', () => {
  for (const value of ['https://attacker.example', 'http://192.168.0.10:41730', 'http://127.0.0.1.attacker.example']) {
    const network = resolveControlCenterNetwork({ locationRef: { origin: hostedOrigin }, settingReader: () => value });
    assert.equal(network.localControlOrigin, DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN);
  }
  const local = resolveControlCenterNetwork({
    locationRef: { origin: hostedOrigin }, settingReader: () => 'http://localhost:41731'
  });
  assert.equal(local.coreBaseUrl, 'http://localhost:41731/api/core');
});

test('hosted control CORS headers are emitted only for the exact owner site origin', () => {
  const allowed = createHostedControlCorsHeaders(hostedOrigin);
  assert.equal(allowed['access-control-allow-origin'], hostedOrigin);
  assert.equal(allowed['access-control-allow-private-network'], 'true');
  assert.equal(allowed['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(createHostedControlCorsHeaders('https://attacker.example'), null);
});
