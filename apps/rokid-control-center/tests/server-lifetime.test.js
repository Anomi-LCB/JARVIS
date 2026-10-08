import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRokidControlServer } from '../src/server.mjs';
import { listenOnFetchSafePort } from '../../../packages/shared/src/http.js';

test('요청이 유휴 타이머를 갱신하고 요청이 끊기면 서버를 종료한다', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rokid-server-lifetime-'));
  const server = await createRokidControlServer({
    dataRoot,
    adbPath: process.execPath,
    idleExitMs: 600
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const address = await listenOnFetchSafePort(server);
  const closed = once(server, 'close');

  await delay(150);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200);
  await delay(250);
  assert.equal(server.listening, true, 'heartbeat 이후에는 서버가 열려 있어야 한다');

  await Promise.race([
    closed,
    delay(1_500).then(() => { throw new Error('유휴 서버가 종료되지 않았다'); })
  ]);
  assert.equal(server.listening, false);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
