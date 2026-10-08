import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runRecoverySample } from '../packages/shared/src/recovery-comparison.js';

async function wire(chunks, stderr = [], exitCode = 0) {
  return runRecoverySample({ scenario: 'completed-core', arm: 'current', timeoutMs: 2000,
    spawnImpl: () => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { queueMicrotask(() => child.emit('close', 1)); return true; } });
      queueMicrotask(() => {
        for (const chunk of chunks) child.stdout.write(chunk);
        for (const chunk of stderr) child.stderr.write(chunk);
        child.stdout.end(); child.stderr.end(); child.emit('close', exitCode);
      });
      return child;
    } });
}

test('comparison child wire preserves every Korean/emoji UTF-8 byte boundary', async () => {
  const note = '서울·날씨 → 저장·복구 🧠 e\u0301';
  const payload = Buffer.from(JSON.stringify({ ok: true, sample: { note } }));
  const result = await wire([...payload].map(byte => Buffer.from([byte])));
  assert.equal(result.state, 'completed');
  assert.equal(result.note, note);
});

test('comparison rejects invalid UTF-8 instead of accepting altered evidence text', async () => {
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xe3, 0x81]), Buffer.from([0xc0, 0xaf])]) {
    const result = await wire([Buffer.from('{"ok":true,"sample":{"note":"'), invalid, Buffer.from('"}}')]);
    assert.equal(result.state, 'error');
    assert.equal(result.errorCode, 'A_COMPARISON_WORKER_FAILED');
    assert.equal(result.note, undefined);
  }
});

test('wire budget counts original bytes at exactly 64KiB including stderr', async () => {
  const payload = Buffer.from('{"ok":true,"sample":{"note":"정확"}}');
  const result = await wire([payload], [Buffer.alloc(64 * 1024 - payload.length, 120)]);
  assert.equal(result.state, 'completed');
  assert.equal(result.note, '정확');
  const excess = await wire([payload], [Buffer.alloc(64 * 1024 - payload.length + 1, 120)]);
  assert.equal(excess.state, 'error');
  assert.equal(excess.errorCode, 'A_COMPARISON_OUTPUT_LIMIT');
});

test('wire never promotes malformed JSON or a nonzero child exit', async () => {
  const malformed = await wire([Buffer.from('{"ok":true')]);
  assert.equal(malformed.errorCode, 'A_COMPARISON_WORKER_FAILED');
  const failedExit = await wire([Buffer.from('{"ok":true,"sample":{"note":"정상"}}')], [], 1);
  assert.equal(failedExit.errorCode, 'A_COMPARISON_WORKER_FAILED');
});
