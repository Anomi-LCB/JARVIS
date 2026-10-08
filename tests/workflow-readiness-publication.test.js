import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

for (const boundary of ['none', 'claim', 'first-publish', 'second-publish', 'final-path']) {
  test(`actual Mission workflow rechecks connection at publication: ${boundary}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-readiness-'));
    let now = Date.now();
    const binding = { capabilityId: 'workflow.execute', providerId: 'isolated-workflow-provider',
      accountRef: 'synthetic-workflow-account', deviceRef: null, scopes: ['synthetic.write'] };
    const env = { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env,
      workerDaemonEnabled: false, clock: () => new Date(now),
      capabilityBindingResolver: ({ toolName }) => toolName === 'workflow.execute'
        ? { required: true, binding, permissionRevision: 'workflow-1' } : { required: false } });
    t.after(async () => { runtime.coreFacade.cognition?.close(); await rm(root, { recursive: true, force: true }); });
    const observe = accountStatus => runtime.capabilityPackageRegistry.recordAvailability({ ...binding,
      codeVersion: runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,
      permissionRevision: 'workflow-1', observedAt: new Date(++now).toISOString(), accountStatus,
      observedAccountRef: binding.accountRef, deviceStatus: 'not-required', grantedScopes: binding.scopes,
      verificationLevel: 'live-probe', evidenceRef: 'isolated-workflow-publication' });
    observe('connected');
    await writeFile(join(root, 'input.json'), '[{"total":7}]');
    let claims = 0, publishing = 0, published = 0;
    runtime.pcAgent.remoteOperationBoundary = async name => {
      if (name === 'workflow-publication-claimed') { claims++; if (boundary === 'claim') observe('revoked'); }
    };
    const adapter = runtime.pcAgent.registry.get('workflow.execute');
    const safePath = adapter.assertSafePath.bind(adapter);
    let finalPathRevoked = false;
    adapter.assertSafePath = async (path, options) => {
      const value = await safePath(path, options);
      if (boundary === 'final-path' && publishing === 1 && path === join(root, 'one.json') && !finalPathRevoked) {
        finalPathRevoked = true; observe('revoked');
      }
      return value;
    };
    const record = adapter.recordPublicationBoundary.bind(adapter);
    adapter.recordPublicationBoundary = async (state, entry) => {
      await record(state, entry);
      if (entry.phase === 'published') published++;
      if (entry.phase === 'publishing') {
        publishing++;
        if ((boundary === 'first-publish' && publishing === 1)
          || (boundary === 'second-publish' && publishing === 2)) observe('revoked');
      }
    };
    const mission = runtime.missionRuntime.createMission({
      objective: "'input.json' JSON을 '자료'로 읽고; '자료'를 'one.json' JSON으로 저장하고; '자료'를 'two.json' JSON으로 저장해",
      authorization: { grants: ['read_only', 'local_reversible'] },
      successCriteria: [{ statement: '합계 7 저장', verificationSpec: {
        version: 1, kind: 'json.value', path: 'one.json', pointer: '/0/total', equals: 7 } }] });
    const result = await runtime.missionRuntime.runMission(mission.missionId);
    assert.equal(claims, 1);
    assert.equal(await readFile(join(root, 'input.json'), 'utf8'), '[{"total":7}]');
    if (boundary === 'none') {
      assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
      assert.equal(published, 2);
      for (const name of ['one.json', 'two.json'])
        assert.deepEqual(JSON.parse(await readFile(join(root, name), 'utf8')), [{ total: 7 }]);
    } else {
      assert.notEqual(result.status, 'COMPLETED');
      assert.match(JSON.stringify(result), /A_WORKER_CAPABILITY_REVOKED/);
      assert.equal(published, boundary === 'second-publish' ? 1 : 0);
      for (const name of ['one.json', 'two.json']) await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' });
    }
  });
}

test('overwrite final path await cannot replace existing bytes after fence revocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-overwrite-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'result.txt'); await writeFile(target, 'original bytes');
  const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  let publishing = false, revoked = false, published = 0;
  const record = adapter.recordPublicationBoundary.bind(adapter);
  adapter.recordPublicationBoundary = async (state, entry) => {
    await record(state, entry);
    if (entry.phase === 'publishing') publishing = true;
    if (entry.phase === 'published') published++;
  };
  const safe = adapter.assertSafePath.bind(adapter);
  adapter.assertSafePath = async (path, options) => {
    const value = await safe(path, options);
    if (publishing && path === target) revoked = true;
    return value;
  };
  const result = await adapter.execute({ allowOverwrite: true, spec: {
    schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'overwrite-fence',
    nodes: [{ id: 'write', op: 'write.text', args: { path: 'result.txt', text: 'replacement bytes' } }] } },
  { taskId: 'overwrite-fence-task', packetId: 'overwrite-fence-packet' }, {
    beforePublication: async () => () => {
      if (revoked) throw Object.assign(new Error('synthetic fence revoked'), { code: 'TEST_FENCE_REVOKED' });
    }
  });
  assert.equal(result.error.code, 'TEST_FENCE_REVOKED'); assert.equal(published, 0);
  assert.equal(await readFile(target, 'utf8'), 'original bytes');
});

test('resume source-check await cannot publish after fence revocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-resume-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { spec: { schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'resume-fence',
    nodes: [{ id: 'write', op: 'write.text', args: { path: 'result.txt', text: 'resumed bytes' } }] } };
  const packet = { taskId: 'resume-fence-task', packetId: 'resume-fence-packet' };
  const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  const record = adapter.recordPublicationBoundary.bind(adapter);
  adapter.recordPublicationBoundary = async (state, entry) => {
    await record(state, entry);
    if (entry.phase === 'publishing') throw new Error('synthetic interruption before first publication');
  };
  const interrupted = await adapter.execute(args, packet);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.evidence.workflow.recoveryStageRetained, true);
  const stage = (await readdir(root)).find(name => name.startsWith('.jarvis-workflow-stage-'));
  const intent = JSON.parse((await readFile(join(root, stage, 'publication-journal.jsonl'), 'utf8')).split('\n')[0]);
  delete intent.recordedAt; // Journal timestamp is observation metadata, not the bound publication intent.
  assert.ok(intent.recoveryRecipe);
  const fresh = new LocalWorkflowToolAdapter({ allowedRoots: [root] });
  const sources = fresh.assertSourceSnapshotsCurrent.bind(fresh);
  let sourceChecks = 0, revoked = false;
  fresh.assertSourceSnapshotsCurrent = async state => {
    await sources(state);
    if (++sourceChecks === 2) revoked = true;
  };
  const resumed = await fresh.execute(args, packet, { resumeIntent: intent,
    beforePublication: async () => () => {
      if (revoked) throw Object.assign(new Error('synthetic fence revoked'), { code: 'TEST_FENCE_REVOKED' });
    } });
  assert.equal(sourceChecks, 2, JSON.stringify(resumed)); assert.equal(resumed.error.code, 'TEST_FENCE_REVOKED');
  await assert.rejects(readFile(join(root, 'result.txt')), { code: 'ENOENT' });
});
