import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('Windows IPC transport benchmark measures byte-identical cross-process echoes without product activation', {
  skip: process.platform !== 'win32'
}, () => {
  const output = execFileSync(process.execPath, ['scripts/windows-ipc-transport-benchmark.mjs'], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true, maxBuffer: 1_000_000
  });
  const result = JSON.parse(output);
  assert.equal(result.measurementType, 'cross-process same-host transport microbenchmark; not Core workflow latency');
  assert.equal(result.payloadBytes, 26);
  assert.equal(result.pipe.messageEchoMatches, true);
  assert.equal(result.pipe.processIdsDistinct, true);
  assert.equal(result.pipe.localClientConnected, true);
  assert.equal(result.pipe.measuredIterations, 90);
  assert.equal(result.pipe.remoteClientAttempted, false);
  assert.equal(result.pipe.serviceIdentityAccessTested, false);
  assert.equal(result.loopbackHttp.echoMatches, true);
  assert.equal(result.loopbackHttp.processIdsDistinct, true);
  assert.equal(result.loopbackHttp.measuredIterations, 90);
  for (const latency of [result.pipe.roundTripP50Ms, result.pipe.roundTripP95Ms,
    result.loopbackHttp.roundTripP50Ms, result.loopbackHttp.roundTripP95Ms]) {
    assert.equal(Number.isFinite(latency), true);
    assert.equal(latency >= 0, true);
  }
});
