import test from 'node:test';
import assert from 'node:assert/strict';
import { describeReadFailure } from '../src/ui/recovery.js';

test('Read diagnostics distinguish denied, internal service, timeout and malformed responses', () => {
  for (const [error, code] of [[{ status: 403 }, 'ACCESS_DENIED'], [{ status: 502 }, 'SERVICE_UNAVAILABLE'],
    [{ name: 'AbortError' }, 'READ_TIMEOUT'], [{ code: 'INVALID_RESPONSE' }, 'INVALID_RESPONSE'],
    [new TypeError('Failed to fetch'), 'CONNECTION_UNCONFIRMED']]) {
    const failure = describeReadFailure(error);
    assert.equal(failure.code, code);
    assert.equal(failure.safeToRetry, true);
    assert.ok(failure.nextAction);
  }
});

test('Public diagnostics omit credentials, query strings, fragments and raw server messages', () => {
  const failure = describeReadFailure({ message: 'Bearer secret-token', status: 500 }, {
    endpoint: 'http://owner:password@127.0.0.1:41730/api/local/support-bundle?token=secret#private',
    now: '2026-09-02T00:00:00Z'
  });
  assert.equal(failure.endpoint, 'http://127.0.0.1:41730/api/local/support-bundle');
  assert.doesNotMatch(JSON.stringify(failure), /password|secret|private|Bearer/);
  assert.equal(failure.checkedAt, '2026-09-02T00:00:00Z');
});
