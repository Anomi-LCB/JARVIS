import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createConfiguredGoogleBroker } from '../packages/core/src/personal-operations/configured-google-broker.js';
import { setFixturePrivateAcl } from './fixtures/windows-private-acl.mjs';
import { fileURLToPath } from 'node:url';

test('actual DPAPI broker survives a separate-process restart and suppresses removed credentials without sending tokens to Core', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-dpapi-broker-'));
  const children = [], controllers = [], packets = [], outputs = [];
  t.after(async () => {
    for (const controller of controllers) await controller.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve)); child.disconnect(); await stopped;
    }
    for (const name of readdirSync(root)) unlinkSync(join(root, name)); rmdirSync(root);
  });
  setFixturePrivateAcl(root);
  const pemPath = name => fileURLToPath(new URL(`./fixtures/google-broker-tls/${name}.pem`, import.meta.url));
  for (const name of ['server-key', 'core-key']) {
    writeFileSync(join(root, `${name}.pem`), readFileSync(pemPath(name))); setFixturePrivateAcl(join(root, `${name}.pem`));
  }
  function message(child, expected, action) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('SYNTHETIC_BROKER_TIMEOUT')), 30000);
      const received = value => { if (value.type === expected) finish(null, value); };
      const exited = () => finish(new Error('SYNTHETIC_BROKER_EXITED'));
      function finish(error, value) { clearTimeout(timeout); child.off('message', received); child.off('exit', exited); error ? reject(error) : resolve(value); }
      child.on('message', received); child.once('exit', exited); if (action) child.send({ action });
    });
  }
  async function start(initialize = false) {
    const child = fork(new URL('./fixtures/windows-dpapi-broker.mjs', import.meta.url), [root, ...(initialize ? ['--initialize'] : [])], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(child); child.on('message', value => packets.push(value));
    child.stdout.on('data', bytes => outputs.push(bytes.toString())); child.stderr.on('data', bytes => outputs.push(bytes.toString()));
    const ready = await message(child, 'ready'); assert.notEqual(ready.pid, process.pid);
    const row = ready.metadata[0];
    writeFileSync(join(root, 'metadata.json'), JSON.stringify({ schemaVersion: 1, connectionId: row.connectionId, revision: row.updatedAt }));
    const configured = createConfiguredGoogleBroker({ env: {
      JARVIS_CORE_GOOGLE_BROKER_URL: `https://127.0.0.1:${ready.address.port}/v1/google/read`,
      JARVIS_CORE_GOOGLE_BROKER_TLS_KEY: join(root, 'core-key.pem'), JARVIS_CORE_GOOGLE_BROKER_TLS_CERT: pemPath('core'),
      JARVIS_CORE_GOOGLE_BROKER_TLS_CA: pemPath('ca'), JARVIS_CORE_GOOGLE_BROKER_METADATA: join(root, 'metadata.json')
    }, authorizePage: () => {} });
    controllers.push(configured.controller); return { child, ready, ...configured };
  }
  const first = await start(true);
  const vaultPath = join(root, 'vault.json');
  const hash = () => createHash('sha256').update(readFileSync(vaultPath)).digest('hex');
  const initialHash = hash();
  assert.equal(await first.client.account(), 'synthetic@example.test');
  assert.equal(first.client.withCredentials, undefined);
  assert.equal((await message(first.child, 'stats', 'stats')).providerCalls, 2);
  await first.controller.close();
  const stopped = new Promise(resolve => first.child.once('exit', resolve)); first.child.disconnect(); await stopped;
  const second = await start();
  assert.equal(hash(), initialHash);
  assert.equal(await second.client.account(), 'synthetic@example.test');
  assert.equal(hash(), initialHash);
  const removed = await message(second.child, 'removed', 'remove'); assert.equal(removed.removed, true); assert.equal(removed.remoteGrantRevoked, false);
  const calls = (await message(second.child, 'stats', 'stats')).providerCalls;
  await assert.rejects(() => second.client.account(), { message: 'A_GOOGLE_BROKER_CONNECTION_REQUIRED' });
  assert.equal((await message(second.child, 'stats', 'stats')).providerCalls, calls);
  assert.doesNotMatch(JSON.stringify({ packets, outputs, envelope: readFileSync(vaultPath, 'utf8') }), /dpapi-synthetic-(?:client|secret|refresh|access)/u);
  await second.controller.close();
  const secondStopped = new Promise(resolve => second.child.once('exit', resolve)); second.child.disconnect(); await secondStopped;
  async function probe(expected) {
    const child = fork(new URL('./fixtures/windows-dpapi-broker.mjs', import.meta.url), [root, '--probe'], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(child); child.on('message', value => packets.push(value));
    child.stdout.on('data', bytes => outputs.push(bytes.toString())); child.stderr.on('data', bytes => outputs.push(bytes.toString()));
    const exited = new Promise(resolve => child.once('exit', resolve));
    const result = await message(child, expected); const code = await exited; return { result, code };
  }
  const removedProbe = await probe('probe'); assert.equal(removedProbe.result.connectionCount, 0); assert.equal(removedProbe.code, 0);
  const envelope = JSON.parse(readFileSync(vaultPath, 'utf8'));
  envelope.encrypted = 'corrupt-synthetic-dpapi-record'; writeFileSync(vaultPath, JSON.stringify(envelope));
  const corruptProbe = await probe('startup-failed'); assert.equal(corruptProbe.result.code, 'A_INTEGRATION_VAULT_UNREADABLE'); assert.equal(corruptProbe.code, 1);
  assert.doesNotMatch(JSON.stringify({ packets, outputs }), /dpapi-synthetic-(?:client|secret|refresh|access)/u);
  console.log(JSON.stringify({ windowsDpapiBrokerEvidence: { actualWindowsDpapi: true, separateProcess: true, mtlsCoreFacade: true,
    restartPreservedCiphertext: true, removedConnectionDeniedBeforeProvider: true, removedStateSurvivedRestart: true, corruptVaultRejected: true, observedMessagesLogsAndVaultWithoutPlaintextTokens: true,
    scope: 'same-Windows-user-and-machine', SYSTEMServiceNotTested: true, realGoogleNotCalled: true } }));
});
