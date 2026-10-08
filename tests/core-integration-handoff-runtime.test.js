import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('configured Core service accepts a hash-backed handoff-only token and denies admin diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-handoff-runtime-'));
  const brokerToken = 'jrv_handoff_broker_runtime_test';
  const hash = createHash('sha256').update(brokerToken).digest('hex');
  const runtime = await createConfiguredCoreServiceRuntime({ env: {
    JARVIS_TEST_MODE: '1',
    JARVIS_CORE_ROOT: root,
    JARVIS_CORE_AUDIT_ROOT: resolve(root, 'audit'),
    JARVIS_CORE_ALLOWED_ROOTS: resolve(root, 'workspace'),
    JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256: hash,
    JARVIS_PERSONAL_IMPORT_ENABLED: '0',
    JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: 'false'
  } });
  t.after(async () => {
    await runtime.close();
  });
  const address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const scopedHeaders = { authorization: `Bearer ${brokerToken}`, 'content-type': 'application/json' };

  const issue = await fetch(`${base}/integrations/handoffs`, {
    method: 'POST', headers: scopedHeaders,
    body: JSON.stringify({ connectorId: 'not-registered', authMethod: 'oauth2', scopes: [] })
  });
  assert.equal(issue.status, 409, 'request reached registry validation, proving the dedicated token was accepted');
  assert.deepEqual(await issue.json(), { error: { code: 'A_INTEGRATION_CONNECTOR_UNAVAILABLE' } });

  const diagnostics = await fetch(`${base}/admin/diagnostics`, { headers: { authorization: `Bearer ${brokerToken}` } });
  assert.equal(diagnostics.status, 403, 'handoff broker scope must not imply Core administrator scope');
});
