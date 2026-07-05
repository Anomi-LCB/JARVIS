import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalNetworkGuard } from '../apps/bridge/src/network-guard.js';

test('CGNAT/Tailscale range is blocked by default', () => {
  const guard = new LocalNetworkGuard();
  const result = guard.evaluate({ hostHeader: '100.101.102.103:17777', remoteAddress: '100.101.102.103' });
  assert.equal(result.allowed, false);
  assert.equal(result.blockedBy.reason, 'cgnat-disabled');
});

test('allowCgnat admits Tailscale clients but still blocks public IPs', () => {
  const guard = new LocalNetworkGuard({ allowCgnat: true });
  const tailscale = guard.evaluate({ hostHeader: '100.101.102.103:17777', remoteAddress: '100.101.102.103' });
  assert.equal(tailscale.allowed, true);
  assert.ok(tailscale.checks.some((check) => check.reason === 'cgnat-tailscale-100.64/10'));

  const publicIp = guard.evaluate({ hostHeader: '8.8.8.8:17777', remoteAddress: '8.8.8.8' });
  assert.equal(publicIp.allowed, false);

  // 100.x라도 CGNAT 대역(64~127) 밖이면 공인 IP다.
  const nonCgnat = guard.evaluate({ hostHeader: '100.1.2.3:17777', remoteAddress: '100.1.2.3' });
  assert.equal(nonCgnat.allowed, false);
  assert.equal(nonCgnat.blockedBy.reason, 'public-ipv4');

  const lan = guard.evaluate({ hostHeader: '192.168.0.18:17777', remoteAddress: '192.168.0.44' });
  assert.equal(lan.allowed, true);
});
