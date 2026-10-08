import test from 'node:test';
import assert from 'node:assert/strict';
import { currentOwnerSession, prepareOwnerCommand } from '../src/ui/owner-command-session.js';

const now = Date.parse('2026-09-02T10:00:00Z');
const active = { success: true, active: true, session: { sessionId: 'current', expiresAt: new Date(now + 60000).toISOString() } };
function options(status, overrides = {}) {
  const calls = [];
  return { calls, enabled: true, locked: false, now: () => now,
    readStatus: async () => { calls.push('status'); return status; },
    activate: async () => { calls.push('activate'); return active; }, ...overrides };
}

test('Active authorization is reused; expiry is checked against absolute time', async () => {
  const args = options(active);
  assert.equal((await prepareOwnerCommand(args)).session.sessionId, 'current');
  assert.deepEqual(args.calls, ['status']);
  assert.equal(currentOwnerSession({ ...active, session: { ...active.session, remainingMs: 60000, expiresAt: new Date(now - 1).toISOString() } }, now), null);
});

test('Expired authorization is reissued only on explicit command preparation', async () => {
  const args = options({ active: false, recentAudit: [{ eventType: 'owner_session.expired' }] });
  assert.equal((await prepareOwnerCommand(args)).session.sessionId, 'current');
  assert.deepEqual(args.calls, ['status', 'activate']);
});

test('User revocation suspends automatic approval instead of reversing the decision', async () => {
  const args = options({ active: false, recentAudit: [{ eventType: 'owner_session.revoked' }] });
  const result = await prepareOwnerCommand(args);
  assert.equal(result.suspended, true);
  assert.equal(result.session, null);
  assert.deepEqual(args.calls, ['status']);
});

test('Disabled and locked modes never request authorization', async () => {
  for (const override of [{ enabled: false }, { locked: true }]) {
    const args = options(active, override);
    assert.equal((await prepareOwnerCommand(args)).session, null);
    assert.deepEqual(args.calls, []);
  }
});

test('Unavailable status or denied activation cannot become an approved command', async () => {
  const bad = options(null);
  await assert.rejects(prepareOwnerCommand(bad));
  assert.deepEqual(bad.calls, ['status']);
  await assert.rejects(prepareOwnerCommand(options({ active: false }, { activate: async () => ({ success: false }) })));
  await assert.rejects(prepareOwnerCommand(options(active, { readStatus: async () => { throw new Error('denied'); } })));
});
