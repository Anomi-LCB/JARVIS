import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { verifyLegacyFileAbsenceEvidence, verifyLegacyFilePathEvidence } from '../packages/core/src/mission/criteria-evidence.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-legacy-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['archive', 'other']) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, 'report.txt'), `${dir} evidence`);
  }
  const artifact = (path = join(root, 'archive/report.txt')) => ({ name: basename(path),
    rootIndex: 0, relativePath: relative(root, path).replaceAll('\\', '/'), pathHash: hash(resolve(path)),
    outsideAllowedRoots: false, contentSha256: hash('irrelevant-to-existence-proof') });
  const action = { actionId: 'a', actualToolName: 'filesystem.createTextFile', status: 'succeeded',
    arguments: { path: join(root, 'archive/report.txt') } };
  const observation = { actionId: 'a', toolName: action.actualToolName, outcome: 'success',
    verification: { status: 'passed' }, artifacts: [artifact()] };
  const context = { mission: { waves: [{ actions: [action] }] }, observations: [observation], allowedRoots: [root], evidenceActionIds: ['a'] };
  const check = (statement, changes = {}) => verifyLegacyFilePathEvidence({ statement, ...context, ...changes });
  return { root, artifact, action, observation, context, check };
}

test('same basename from another directory cannot prove an explicit relative or absolute location even when both files exist', async t => {
  const f = await setup(t), target = join(f.root, 'other/report.txt');
  f.action.arguments.path = target;
  f.observation.artifacts = [f.artifact(target)];
  for (const path of ['archive/report.txt', join(f.root, 'archive/report.txt')]) {
    const result = f.check(`${path} 파일이 존재한다.`);
    assert.equal(result.required, true);
    assert.equal(result.passed, false);
    const missionResult = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
      { ...f.context.mission, observations: f.context.observations }, { statement: `${path} 파일이 존재한다.` }, ['a']);
    assert.equal(missionResult.status, 'unverified');
    assert.equal(missionResult.checks.find(check => check.checkId === 'named_artifacts_match').passed, true);
    assert.equal(missionResult.checks.find(check => check.checkId === 'legacy_exact_path_evidence').passed, false);
  }
});

test('exact relative and absolute G paths support real existence and creation without weakening the plain filename contract', async t => {
  const f = await setup(t);
  for (const path of ['archive/report.txt', join(f.root, 'archive/report.txt')]) {
    assert.equal(f.check(`${path} 파일이 존재한다.`).passed, true);
    assert.equal(f.check(`${path} 파일을 생성한다.`, { role: 'creation' }).passed, true);
    const result = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
      { ...f.context.mission, observations: f.context.observations }, { statement: `${path} 파일이 존재한다.` }, ['a']);
    assert.equal(result.status, 'passed', path);
  }
  const nameOnly = f.check('report.txt 파일을 생성한다.', { role: 'creation' });
  assert.equal(nameOnly.required, false);
  assert.equal(nameOnly.passed, true);
});

test('G failure, absent path bindings, mismatched checkpoints and deleted files remain unverified', async t => {
  const f = await setup(t);
  for (const transform of [
    c => { c.observations[0].verification.status = 'failed'; },
    c => { delete c.observations[0].artifacts[0].pathHash; },
    c => { c.observations[0].artifacts[0].pathHash = '0'.repeat(64); },
    c => { c.observations[0].artifacts[0].rootIndex = 9; },
    c => { c.mission.waves[0].actions[0].actualToolName = 'filesystem.readText'; },
    c => { c.mission.waves[0].actions[0].arguments.path = join(f.root, 'other/report.txt'); }
  ]) {
    const context = structuredClone(f.context);
    transform(context);
    assert.equal(verifyLegacyFilePathEvidence({ statement: 'archive/report.txt 파일을 생성한다.', role: 'creation', ...context }).passed, false);
  }
  await rm(join(f.root, 'archive/report.txt'));
  assert.equal(f.check('archive/report.txt 파일이 존재한다.').passed, false);
});

test('read, search and listing need their own exact G-bound file or directory', async t => {
  const f = await setup(t);
  f.action.actualToolName = f.observation.toolName = 'filesystem.readText';
  f.observation.artifacts = [];
  f.observation.data = { fileEvidence: f.artifact() };
  assert.equal(f.check('archive/report.txt 파일을 읽는다.', { role: 'read' }).passed, true);
  assert.equal(f.check('other/report.txt 파일을 읽는다.', { role: 'read' }).passed, false);
  f.action.actualToolName = f.observation.toolName = 'filesystem.searchFiles';
  f.observation.data = { matches: [{ name: 'report.txt', artifact: f.artifact() }] };
  assert.equal(f.check('archive/report.txt 파일이 존재한다.').passed, true);
  assert.equal(f.check('other/report.txt 파일이 존재한다.').passed, false);
  f.action.actualToolName = f.observation.toolName = 'filesystem.listFiles';
  f.action.arguments = { directory: join(f.root, 'archive') };
  f.observation.data = { items: [{ name: 'report.txt', type: 'file' }] };
  assert.equal(f.check('archive/report.txt 파일이 존재한다.').passed, true);
  assert.equal(f.check('other/report.txt 파일이 존재한다.').passed, false);
});

test('a physically escaping junction or traversal does not become proof despite a matching textual G path', async t => {
  const f = await setup(t), outside = await setup(t);
  await symlink(outside.root, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const path = join(f.root, 'linked/archive/report.txt');
  f.action.arguments.path = path;
  f.observation.artifacts = [f.artifact(path)];
  assert.equal(f.check('linked/archive/report.txt 파일이 존재한다.').passed, false);
  assert.equal(f.check(`${relative(f.root, join(outside.root, 'archive/report.txt'))} 파일이 존재한다.`).passed, false);
});

test('unnamed creation needs a real writer and an existing G-bound output; read artifacts and claimed hashes cannot suffice', async t => {
  const f = await setup(t);
  assert.equal(f.check('파일을 생성한다.', { unnamedCreation: true }).passed, true);
  f.action.actualToolName = f.observation.toolName = 'filesystem.readText';
  assert.equal(f.check('파일을 생성한다.', { unnamedCreation: true }).passed, false);
  const result = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
    { ...f.context.mission, observations: f.context.observations }, { statement: '파일을 생성한다.' }, ['a']);
  assert.equal(result.status, 'unverified');
  f.action.actualToolName = f.observation.toolName = 'filesystem.createTextFile';
  await rm(join(f.root, 'archive/report.txt'));
  assert.equal(f.check('파일을 생성한다.', { unnamedCreation: true }).passed, false);
});

test('absence proof uses the actual dispatch directory and a current bounded filesystem observation', async t => {
  const f = await setup(t), statement = 'archive/report.txt 파일이 존재하지 않는다.';
  await rm(join(f.root, 'archive/report.txt'));
  f.action.actualToolName = f.observation.toolName = 'filesystem.listFiles';
  f.action.arguments = { directory: join(f.root, 'archive'), maxItems: 100 };
  f.observation.artifacts = [];
  f.observation.data = { items: [] };
  const evaluate = () => MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
    { ...f.context.mission, observations: f.context.observations }, { statement }, ['a']);
  assert.equal(evaluate().status, 'passed', 'exact G listing and a genuinely missing file remain supported');
  for (const path of ['archive/report.txt', join(f.root, 'archive/report.txt')]) {
    assert.equal(verifyLegacyFileAbsenceEvidence({ statement: `${path} 파일이 존재하지 않는다.`, ...f.context }).passed, true);
    const missionResult = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
      { ...f.context.mission, observations: f.context.observations }, { statement: `${path} 파일이 존재하지 않는다.` }, ['a']);
    assert.equal(missionResult.status, 'passed', `full relative/absolute absence reference must survive: ${path}`);
  }
  f.action.operation = { dispatch: { toolName: 'filesystem.listFiles', arguments: { directory: join(f.root, 'other') } } };
  const mismatch = evaluate();
  assert.equal(mismatch.checks.find(check => check.checkId === 'named_artifact_absence_verified').passed, true,
    'reproduce the legacy planned-argument proof that ignored the actual checkpoint');
  assert.equal(mismatch.status, 'unverified');
  assert.equal(mismatch.checks.find(check => check.checkId === 'legacy_exact_path_evidence').passed, false);
  delete f.action.operation;
  await writeFile(join(f.root, 'archive/report.txt'), 'created after the empty listing');
  assert.equal(evaluate().status, 'unverified', 'an old absence observation cannot prove current absence');
  t.diagnostic(JSON.stringify({ experiment: 'legacy-absence-dispatch-counterexample', statement,
    plannedDirectory: 'archive', actualDispatchDirectory: 'other', legacySubcheckPassed: true,
    verificationStatus: mismatch.status, observedAt: new Date().toISOString(), externalCalls: 0 }));
});

test('absence proof rejects missing workspaces, escaped junctions, filtered searches and incomplete listings', async t => {
  const f = await setup(t), outside = await setup(t);
  await rm(join(f.root, 'archive/report.txt'));
  const context = () => structuredClone(f.context);
  const check = c => verifyLegacyFileAbsenceEvidence({ statement: 'archive/report.txt 파일이 존재하지 않는다.', ...c });
  f.action.actualToolName = f.observation.toolName = 'filesystem.listFiles';
  f.action.arguments = { directory: join(f.root, 'archive'), maxItems: 1 };
  f.observation.artifacts = [];
  f.observation.data = { items: [{ name: 'another.txt', type: 'file' }] };
  assert.equal(check(context()).passed, false, 'listing was truncated at its limit');
  f.action.actualToolName = f.observation.toolName = 'filesystem.searchFiles';
  f.action.arguments = { query: 'report.txt', scope: 'workspace', directory: f.root };
  f.observation.data = { matches: [] };
  assert.equal(check(context()).passed, true);
  for (const change of [
    c => { c.mission.waves[0].actions[0].arguments.contentQuery = 'unrelated phrase'; },
    c => { c.mission.waves[0].actions[0].arguments.modifiedWithinDays = 1; },
    c => { c.mission.waves[0].actions[0].arguments.directory = join(f.root, 'other'); },
    c => { c.observations[0].verification.failedCheckIds = ['inconsistent-G']; },
    c => { c.allowedRoots = [join(f.root, 'not-a-workspace')]; }
  ]) { const c = context(); change(c); assert.equal(check(c).passed, false); }
  await symlink(outside.root, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.action.arguments.directory = f.root;
  assert.equal(verifyLegacyFileAbsenceEvidence({ statement: 'linked/archive/missing.txt 파일이 존재하지 않는다.', ...f.context }).passed, false);
  if (process.platform === 'win32') {
    const statement = '\\\\synthetic-server\\synthetic-share\\report.txt 파일이 존재하지 않는다.';
    const result = MissionRuntime.prototype.verifyCriterionEvidence.call({ allowedRoots: [f.root], resultReadGuard: MissionRuntime.prototype.resultReadGuard },
      { ...f.context.mission, observations: f.context.observations }, { statement }, ['a']);
    assert.notEqual(result.status, 'passed', 'UNC outside the permitted root stays unverified without a network request');
    assert.equal(result.checks.find(check => check.checkId === 'named_artifact_absence_verified').expected[0],
      '/synthetic-server/synthetic-share/report.txt', 'legacy reference parsing must retain the server and share');
  }
});

test('actual Mission lists the exact directory and completes a currently true file-absence criterion', async t => {
  const f = await setup(t), statement = 'archive/report.txt 파일이 존재하지 않는다.';
  await rm(join(f.root, 'archive/report.txt'));
  const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [f.root], auditRoot: join(f.root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false,
    missionPlanner: { planNextWave: async context => {
      const observation = context.observations.find(item => item.outcome === 'success');
      return observation ? { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(criterion => ({
        criterionId: criterion.criterionId, status: 'satisfied', evidenceActionIds: [observation.actionId] })) }
        : { decision: 'continue', actions: [{ id: 'list', command: 'archive 폴더의 파일 목록을 확인해줘',
          expectedToolName: 'filesystem.listFiles', arguments: { directory: join(f.root, 'archive'), maxItems: 100 }, dependencies: [] }] };
    } } });
  const created = runtime.missionRuntime.createMission({ objective: statement, successCriteria: [statement] });
  const result = await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.lastCompletionAssessment));
  assert.equal(result.metrics.executedActions, 1);
  assert.equal(result.verificationStatus, 'passed');
  await assert.rejects(readFile(join(f.root, 'archive/report.txt')), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ experiment: 'legacy-absence-actual-listing-positive', statement,
    status: result.status, executedActions: result.metrics.executedActions, observedAt: new Date().toISOString(), externalCalls: 0 }));
});

test('actual Mission writes the counterexample file once, keeps explicit-path proof pending, and completes exact or name-only positives', async t => {
  const reports = [];
  for (const [caseId, statement, targetDirectory, expectedStatus] of [
    ['wrong-relative', 'archive/report.txt 파일이 생성된다.', 'other', 'PAUSED'],
    ['right-relative', 'archive/report.txt 파일이 생성된다.', 'archive', 'COMPLETED'],
    ['plain-name', 'report.txt 파일이 생성된다.', 'other', 'COMPLETED'],
    ['unnamed-creation', '파일을 생성한다.', 'archive', 'COMPLETED']
  ]) {
    const f = await setup(t), outputPath = join(f.root, targetDirectory, 'report.txt');
    await rm(outputPath);
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const planner = { planNextWave: async context => {
      const observation = context.observations.find(item => item.outcome === 'success');
      return observation ? { decision: 'complete', actions: [], criteriaAssessment: context.mission.successCriteria.map(criterion => ({
        criterionId: criterion.criterionId, status: 'satisfied', evidenceActionIds: [observation.actionId] })) }
        : { decision: 'continue', actions: [{ id: 'write', command: 'report.txt 파일을 만들어줘',
          expectedToolName: 'filesystem.createTextFile', arguments: { path: outputPath, content: caseId }, dependencies: [] }] };
    } };
    const runtime = createAgRuntime({ allowedRoots: [f.root], auditRoot: join(f.root, 'audit'), env, taskEnv: env,
      missionPlanner: planner, workerDaemonEnabled: false });
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'legacy-path-proof', durationMinutes: 5 });
    const created = runtime.missionRuntime.createMission({ objective: statement, successCriteria: [statement],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    const result = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(result.status, expectedStatus, JSON.stringify(result.lastCompletionAssessment));
    assert.equal(result.metrics.executedActions, 1);
    assert.equal(await readFile(outputPath, 'utf8'), caseId);
    if (caseId === 'wrong-relative') {
      assert.equal(result.stopReason, 'verification-incomplete');
      assert.equal(await readFile(join(f.root, 'archive/report.txt'), 'utf8'), 'archive evidence');
    }
    reports.push({ caseId, command: statement, actualArtifact: relative(f.root, outputPath), status: result.status,
      stopReason: result.stopReason, executedActions: result.metrics.executedActions, verificationStatus: result.verificationStatus,
      observedAt: new Date().toISOString(), actualContentSha256: hash(await readFile(outputPath)) });
  }
  for (const report of reports) t.diagnostic(JSON.stringify({ experiment: 'legacy-exact-path-counterexample', ...report, externalCalls: 0 }));
});
