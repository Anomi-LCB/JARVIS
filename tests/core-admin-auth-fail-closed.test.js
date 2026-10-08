import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CoreAdminAuthProvider,
  CoreAdminScope
} from '../packages/core/src/security/core-admin-auth.js';

test('Core admin auth fails closed for missing, empty, or malformed token scopes', async (t) => {
  const invalidScopeRecords = [
    { label: 'missing', record: {} },
    { label: 'empty array', record: { scopes: [] } },
    { label: 'null', record: { scopes: null } },
    { label: 'blank string', record: { scopes: '' } },
    { label: 'scalar string', record: { scopes: CoreAdminScope.READ_DIAGNOSTICS } },
    { label: 'object', record: { scopes: { scope: CoreAdminScope.READ_DIAGNOSTICS } } }
  ];

  for (const { label, record } of invalidScopeRecords) {
    await t.test(label, () => {
      const token = `invalid-scope-${label}`;
      const provider = new CoreAdminAuthProvider({
        tokens: [{ token, tokenId: `token-${label}`, ...record }]
      });

      const decision = provider.verifyBearer(token, {
        requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON,
        route: '/worker/daemon/tick',
        method: 'POST'
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'scope-denied');
      assert.equal(decision.error.code, 'A_ADMIN_SCOPE_DENIED');
      assert.deepEqual(provider.status().tokenRecords[0].scopes, []);
    });
  }
});

test('Core admin auth preserves explicit narrow, admin, and wildcard scopes', () => {
  const provider = new CoreAdminAuthProvider({
    tokens: [
      { token: 'reader', scopes: [CoreAdminScope.READ_DIAGNOSTICS] },
      { token: 'admin-scope', scopes: [CoreAdminScope.ADMIN] },
      { token: 'wildcard', scopes: ['*'] }
    ]
  });

  assert.equal(provider.verifyBearer('reader', {
    requiredScope: CoreAdminScope.READ_DIAGNOSTICS
  }).allowed, true);
  assert.equal(provider.verifyBearer('reader', {
    requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON
  }).allowed, false);
  assert.equal(provider.verifyBearer('admin-scope', {
    requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON
  }).allowed, true);
  assert.equal(provider.verifyBearer('wildcard', {
    requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON
  }).allowed, true);
});
