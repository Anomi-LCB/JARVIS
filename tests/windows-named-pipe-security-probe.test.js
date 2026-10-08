import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('Windows named-pipe probe verifies explicit DACL, unauthorized SID denial, message integrity and size bounds', {
  skip: process.platform !== 'win32'
}, () => {
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/windows-named-pipe-security-probe.ps1'
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(output);
  assert.equal(result.clientProcessIdObserved, true);
  assert.equal(result.clientProcessIdDistinct, true);
  assert.equal(result.logonSidInActualDacl, true);
  assert.equal(result.serviceSidInActualDacl, true);
  assert.equal(result.logonSidCanCreatePipeInstance, false);
  assert.equal(result.serviceSidCanCreatePipeInstance, true);
  assert.equal(result.everyoneInActualDacl, false);
  assert.equal(result.anonymousInActualDacl, false);
  assert.equal(result.remoteClientRejectFlagRequested, true);
  assert.equal(result.localClientConnected, true);
  assert.equal(result.messageEchoMatches, true);
  assert.equal(result.iterations, 100);
  assert.equal(result.measuredIterations, 90);
  assert.equal(Number.isFinite(result.roundTripP50Ms), true);
  assert.equal(Number.isFinite(result.roundTripP95Ms), true);
  assert.equal(result.oversizedMessageRejected, true);
  assert.equal(result.clientWithoutAllowedSidDenied, true);
  assert.equal(result.serviceIdentityAccessTested, false);
  assert.equal(result.remoteClientAttempted, false);
  assert.equal(result.sameUserMalwareIsolated, false);
  assert.doesNotMatch(output, /S-1-5-5-\d+-\d+/u, 'session-specific logon SID stays out of the test output');
});
