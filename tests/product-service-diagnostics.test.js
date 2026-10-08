import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { probeProductServices } from '../scripts/product-runtime.mjs';

test('actual health responses distinguish missing services, HTTP errors and credential identity mismatch without leaking payload', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/unhealthy') { res.writeHead(503); res.end('unavailable'); return; }
    if (req.url === '/invalid') { res.end('not json'); return; }
    if (req.url === '/slow') return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ module: 'D_BRIDGE', deviceTokenKeyId: 'synthetic-other-key',
      sensitiveValue: 'never-copy-this-payload',
      trust: { mode: 'lockdown', activeIncident: { raw: 'never-copy-this-incident' } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const closed = createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const missing = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(resolve => closed.close(resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const definition = (id, url) => ({ id, label: id, endpoint: url, healthUrl: url,
    healthIdentity: { module: 'D_BRIDGE', deviceTokenKeyId: 'synthetic-current-key' } });
  const report = await probeProductServices({ timeoutMs: 500, definitions: [
    definition('missing', missing), definition('unhealthy', base + '/unhealthy'),
    definition('mismatch', base + '/mismatch'), definition('invalid', base + '/invalid'),
    definition('slow', base + '/slow')
  ] });
  const byId = Object.fromEntries(report.services.map(service => [service.id, service]));
  assert.equal(report.operational, false); assert.equal(report.mutatingExecutionAllowed, false);
  assert.equal(byId.missing.reachable, false); assert.equal(byId.missing.failureReason, 'network-error');
  assert.equal(byId.unhealthy.reachable, true); assert.equal(byId.unhealthy.statusCode, 503);
  assert.equal(byId.unhealthy.failureReason, 'http-error');
  assert.equal(byId.mismatch.reachable, true); assert.equal(byId.mismatch.statusCode, 200);
  assert.equal(byId.mismatch.failureReason, 'identity-mismatch');
  assert.deepEqual(byId.mismatch.mismatchedIdentityFields, ['deviceTokenKeyId']);
  assert.equal(byId.mismatch.trust, null);
  assert.equal(byId.mismatch.nextAction, 'verify-existing-process-owner-and-original-credentials');
  assert.equal(byId.invalid.failureReason, 'identity-response-unreadable');
  assert.equal(byId.slow.failureReason, 'probe-timeout');
  assert.equal(JSON.stringify(report).includes('never-copy-this'), false);
  assert.equal(JSON.stringify(report).includes('synthetic-other-key'), false);
  assert.equal(JSON.stringify(report).includes('synthetic-current-key'), false);
});
