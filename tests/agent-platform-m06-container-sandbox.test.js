import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runContainerExecution } from '../packages/core/src/runtime/container-execution-environment.js';
import { writeFileSync } from 'node:fs';

test('M06 executes a hostile filesystem/network probe with an allowlisted mount boundary', () => {
  const hostWorkspaceProbe = resolve('package.json');
  const code = `
    import fs from 'node:fs';
    import net from 'node:net';
    const attempt = path => { try { fs.readFileSync(path); return 'read'; } catch (error) { return error.code || 'denied'; } };
    const hostPathResult = attempt(${JSON.stringify(hostWorkspaceProbe)});
    const secretEnvNames = Object.keys(process.env).filter(key => /(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key));
    let networkResult = 'blocked';
    try { const socket = net.createConnection({ host: '1.1.1.1', port: 443, timeout: 1000 });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.once('timeout', () => reject(new Error('timeout'))); });
      networkResult = 'connected'; socket.destroy();
    } catch { networkResult = 'blocked'; }
    console.log('JARVIS_RESULT:' + JSON.stringify({
      uid: process.getuid(), hostPathResult, secretEnvNames,
      input: fs.readFileSync('/task/public.txt', 'utf8'), networkResult,
      rootWriteResult: (() => { try { fs.writeFileSync('/blocked.txt', 'x'); return 'writable'; } catch (error) { return error.code || 'denied'; } })()
    }));
  `;
  const result = runContainerExecution({ code, inputs: { 'public.txt': 'public fixture only\n' }, timeoutMs: 10_000 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.enforcementVerified, true, JSON.stringify(result.restrictions));
  const resultLine = result.stdout.trim().split(/\r?\n/u).find(line => line.startsWith('JARVIS_RESULT:'));
  assert.ok(resultLine, JSON.stringify({ stdout: result.stdout, restrictions: result.restrictions }));
  const decoded = JSON.parse(resultLine.slice('JARVIS_RESULT:'.length));
  const evidence = {
    schemaVersion: 2, scenarioId: 'M06', fixtureId: 'm06-docker-offline-allowlisted-filesystem-v2',
    image: 'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
    restrictions: result.restrictions, mounts: result.mounts,
    probe: { uid: decoded.uid, hostPathResult: decoded.hostPathResult, secretEnvNames: decoded.secretEnvNames,
      input: decoded.input, networkResult: decoded.networkResult, rootWriteResult: decoded.rootWriteResult },
    output: { channel: 'bounded-container-stdout', resultSha256: createHash('sha256').update(result.stdout).digest('hex'), byteLength: Buffer.byteLength(result.stdout) },
    durationMs: result.durationMs, actualContainerExecution: result.actualContainerExecution,
    networkRequests: result.networkRequests, externalWrites: result.externalWrites,
    dockerSecurityOptions: ['builtin-seccomp'], daemonRootless: false
  };
  assert.equal(decoded.uid, 65534);
  assert.notEqual(decoded.hostPathResult, 'read');
  assert.deepEqual(decoded.secretEnvNames, []);
  assert.equal(decoded.input, 'public fixture only\n');
  assert.equal(decoded.networkResult, 'blocked');
  assert.notEqual(decoded.rootWriteResult, 'writable');
  assert.equal(result.mounts.length, 1);
  assert.equal(result.mounts[0].destination, '/task');
  assert.equal(result.mounts[0].readOnly, true);
  assert.match(result.restrictions.scratchTmpfs, /size=32m/u);
  const evidencePath = process.env.JARVIS_M06_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('M06 rejects unpinned images and unsafe input names before starting a container', () => {
  assert.throws(() => runContainerExecution({ code: 'process.exit(0)', image: 'node:latest' }), /unapproved sandbox image digest/u);
  assert.throws(() => runContainerExecution({ code: 'process.exit(0)', inputs: { '../secret': 'x' } }), /unsafe input name/u);
});
