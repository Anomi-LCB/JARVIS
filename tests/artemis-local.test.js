import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  artemisPaths, validateOwnedArtemisServer, inspectArtemisStartup,
  prepareArtemisLaunch, recordArtemisLaunchPid, validateArtemisLaunchInstance
} from '../scripts/artemis-local.mjs';

const config = { checkout: '.local/artemis', runtimeDirectory: '.runtime/artemis', host: '127.0.0.1', port: 41731 };
test('ARTEMIS process management confines paths and bind address to the local workspace', () => {
  for (const override of [{ checkout: '..' }, { runtimeDirectory: '../other' }, { checkout: '.' }, { host: '0.0.0.0' }, { port: 0 }]) {
    assert.throws(() => artemisPaths(resolve('workspace-fixture'), { ...config, ...override }));
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-artemis-startup-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('jarvis-artemis-startup-'));
    rmSync(root, { recursive: true, force: true });
  });
  return artemisPaths(root, config);
}

function serverInfo(paths, pid, token = 'fixture-lifecycle-token-not-a-secret') {
  return { pid, cwd: paths.checkout, sys_executable: paths.python, host: config.host, port: config.port, lifecycle_token: token };
}

test('pre-spawn intent is fully published before a PID exists, with a fresh private lifecycle token', (t) => {
  const paths = fixture(t);
  const intent = prepareArtemisLaunch({ paths, config });
  assert.deepEqual(JSON.parse(readFileSync(paths.startupIntent, 'utf8')), intent);
  assert.equal(intent.forkPid, null);
  assert.match(intent.lifecycleToken, /^[a-f0-9]{64}$/);
  const state = inspectArtemisStartup({ paths, config, isAlive: () => false });
  assert.equal(state.reason, 'child-pid-not-recorded');
  assert.equal(JSON.stringify(state).includes(intent.lifecycleToken), false);
});

test('parent death before PID publication remains unconfirmed and never creates a replacement intent', (t) => {
  const paths = fixture(t);
  const intent = prepareArtemisLaunch({ paths, config });
  assert.throws(() => prepareArtemisLaunch({ paths, config, isAlive: () => false }), {
    code: 'ARTEMIS_STARTUP_UNCONFIRMED'
  });
  assert.equal(JSON.parse(readFileSync(paths.startupIntent, 'utf8')).id, intent.id);
});

test('timeout or parent death cannot discard a still-live detached launch PID', (t) => {
  const paths = fixture(t);
  const prepared = prepareArtemisLaunch({ paths, config });
  const intent = recordArtemisLaunchPid({ paths, intent: prepared, childPid: 82101 });
  const isAlive = (pid) => pid === intent.forkPid;
  assert.deepEqual(inspectArtemisStartup({ paths, config, isAlive }), {
    state: 'process-alive', reason: 'launched-process-alive', pid: 82101, blocksSpawn: true
  });
  assert.throws(() => prepareArtemisLaunch({ paths, config, isAlive }), (error) => {
    assert.equal(error.code, 'ARTEMIS_STARTUP_UNCONFIRMED');
    assert.equal(error.message.includes(intent.lifecycleToken), false);
    assert.equal(JSON.stringify(error.startup).includes(intent.lifecycleToken), false);
    return true;
  });
  assert.equal(JSON.parse(readFileSync(paths.startupIntent, 'utf8')).forkPid, 82101);
});

test('a confirmed exited launch can be reclaimed with a new intent and lifecycle token', (t) => {
  const paths = fixture(t);
  const previous = recordArtemisLaunchPid({ paths, intent: prepareArtemisLaunch({ paths, config }), childPid: 82102 });
  assert.equal(inspectArtemisStartup({ paths, config, isAlive: () => false }).state, 'exited');
  const next = prepareArtemisLaunch({ paths, config, isAlive: () => false });
  assert.notEqual(next.id, previous.id);
  assert.notEqual(next.lifecycleToken, previous.lifecycleToken);
  assert.equal(next.forkPid, null);
});

test('a preparing upstream server prevents replacement even after the Windows launcher exited', (t) => {
  const paths = fixture(t);
  const intent = recordArtemisLaunchPid({ paths, intent: prepareArtemisLaunch({ paths, config }), childPid: 82103 });
  writeFileSync(paths.serverInfo, JSON.stringify(serverInfo(paths, 82104, intent.lifecycleToken)));
  const isAlive = (pid) => pid === 82104;
  assert.equal(inspectArtemisStartup({ paths, config, isAlive }).reason, 'managed-process-alive');
  assert.throws(() => prepareArtemisLaunch({ paths, config, isAlive }), { code: 'ARTEMIS_STARTUP_UNCONFIRMED' });
});

test('legacy preparing server metadata blocks duplicate creation without a startup intent', (t) => {
  const paths = fixture(t);
  // The previous launcher version can leave upstream metadata without a JARVIS intent.
  const prepared = prepareArtemisLaunch({ paths, config });
  writeFileSync(paths.serverInfo, JSON.stringify(serverInfo(paths, 82105)));
  rmSync(paths.startupIntent);
  const state = inspectArtemisStartup({ paths, config, isAlive: (pid) => pid === 82105 });
  assert.equal(state.blocksSpawn, true);
  assert.equal(state.pid, 82105);
  assert.throws(() => prepareArtemisLaunch({ paths, config, isAlive: () => true }), { code: 'ARTEMIS_STARTUP_UNCONFIRMED' });
  assert.ok(prepared.id);
});

test('fresh launch token proves the actual Windows Python instance even when its PID differs from the wrapper', (t) => {
  const paths = fixture(t);
  const intent = recordArtemisLaunchPid({ paths, intent: prepareArtemisLaunch({ paths, config }), childPid: 82106 });
  const info = serverInfo(paths, 82107, intent.lifecycleToken);
  assert.equal(validateArtemisLaunchInstance({ paths, config, intent, info, livePid: 82107 }), true);
  assert.equal(validateArtemisLaunchInstance({ paths, config, intent, info, livePid: 82106 }), false);
  assert.equal(validateArtemisLaunchInstance({ paths, config, intent, info: { ...info, lifecycle_token: 'different-instance-token' }, livePid: 82107 }), false);
});

test('malformed preparation evidence is preserved as unconfirmed rather than overwritten', (t) => {
  const paths = fixture(t);
  prepareArtemisLaunch({ paths, config });
  writeFileSync(paths.startupIntent, '{interrupted');
  assert.equal(inspectArtemisStartup({ paths, config }).reason, 'invalid-startup-record');
  assert.throws(() => prepareArtemisLaunch({ paths, config }), { code: 'ARTEMIS_STARTUP_UNCONFIRMED' });
  assert.equal(readFileSync(paths.startupIntent, 'utf8'), '{interrupted');
});

test('PID publication cannot replace another launch intent', (t) => {
  const paths = fixture(t);
  const intent = prepareArtemisLaunch({ paths, config });
  assert.throws(() => recordArtemisLaunchPid({ paths, intent: { ...intent, id: 'other-launch' }, childPid: 82108 }), /STARTUP_RECORD_CHANGED/);
  assert.equal(JSON.parse(readFileSync(paths.startupIntent, 'utf8')).id, intent.id);
});
test('ARTEMIS shutdown ownership requires the exact checkout, interpreter, port and lifecycle token', () => {
  const paths = artemisPaths(resolve('workspace-fixture'), config);
  const info = { pid: 1234, cwd: paths.checkout, sys_executable: paths.python, host: config.host, port: config.port, lifecycle_token: 'fixture-lifecycle-token-not-a-secret' };
  assert.equal(validateOwnedArtemisServer(info, paths, config, info.pid), true);
  assert.equal(validateOwnedArtemisServer(info, paths, config, info.pid + 1), false);
  assert.equal(validateOwnedArtemisServer(info, paths, config), false);
  for (const override of [{ pid: -1 }, { cwd: resolve('other') }, { sys_executable: 'python' }, { host: '0.0.0.0' }, { port: 8000 }, { lifecycle_token: '' }]) {
    assert.equal(validateOwnedArtemisServer({ ...info, ...override }, paths, config, info.pid), false);
  }
});
