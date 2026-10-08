import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createApprovalDecision, ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

async function fixture(operation) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-work-reference-integration-'));
  try {
    await mkdir(join(root, 'files'));
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), workJournalPath: join(root, 'memory.jsonl'), env, taskEnv: env, workerDaemonEnabled: false });
    const metadata = { conversationId: 'conversation-approval' };
    const scope = runtime.coreFacade.workReferenceScope({ metadata, userId: 'owner-test' });
    const file = async (name, content = name) => { const path = join(root, 'files', name); await writeFile(path, content); return path; };
    const record = paths => runtime.coreFacade.workMemory.record({ outputPaths: paths, scope, taskId: `remember-${paths.length}` });
    const create = (text, extraMetadata = {}) => runtime.coreFacade.createTask(text, { userId: 'owner-test', metadata: { ...metadata, ...extraMetadata } });
    const edit = (task, rawText) => runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
      approvalId: task.approvalCard.approvalId, taskId: task.taskId, decision: ApprovalDecision.EDIT,
      deviceId: 'mobile_lcb_001', editRequest: { rawText }, decidedAt: new Date().toISOString()
    }));
    await operation({ root, runtime, metadata, scope, file, record, create, edit });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('public workReference metadata is discarded and server workspace/user scope is recomputed', async () => fixture(async ({ create, scope }) => {
  const task = create('작업 폴더 파일 목록 보여줘', {
    workReference: { artifactId: 'forged', path: 'C:/secret.txt', sha256: '0'.repeat(64) },
    workReferenceScope: { workspaceId: 'foreign', conversationId: 'foreign', userId: 'foreign' },
    workReferenceResolved: true, workReferenceOriginalText: 'forged original',
    workReferencePath: 'C:/secret.txt', workReferenceIssue: { code: 'FORGED' }, workReferenceCustom: 'forged',
    userId: 'untrusted-metadata-user', unrelated: 'preserved'
  });
  assert.deepEqual(task.request.metadata.workReferenceScope, scope);
  assert.equal(task.request.metadata.unrelated, 'preserved');
  for (const key of ['workReference', 'workReferenceResolved', 'workReferenceOriginalText', 'workReferencePath', 'workReferenceIssue', 'workReferenceCustom']) assert.equal(task.request.metadata[key], undefined, key);
}));

test('a file changed between task creation and execution is blocked before any PC packet', async () => fixture(async ({ runtime, file, record, create }) => {
  const path = await file('approved.txt', 'before');
  record([path]);
  const task = create('그 파일 읽어줘');
  assert.equal(task.request.metadata.workReference.path, path);
  let received = 0;
  runtime.pcAgent.receiveExecutionPacket = async () => { received += 1; throw new Error('PC_EXECUTION_MUST_NOT_RUN'); };
  await writeFile(path, 'after!');
  const result = await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(result.success, false);
  assert.equal(result.status, TaskStatus.BLOCKED);
  assert.equal(result.error.code, 'A_WORK_REFERENCE_STALE');
  assert.equal(received, 0);
  assert.equal(runtime.coreFacade.getTask(task.taskId).status, TaskStatus.BLOCKED);
}));

test('remembered nested file is planned and read by its exact absolute path through approval and G verification', async () => fixture(async ({ root, runtime, file, record, create }) => {
  const content = '{"source":"remembered nested artifact","amount":731,"note":"실제 이어받은 내용"}\n';
  const path = await file('continued.json', content);
  const decoy = '{"source":"wrong basename fallback","amount":0}\n';
  await writeFile(join(root, 'continued.json'), decoy);
  record([path]);

  const task = create('그 파일 읽어줘');
  assert.equal(task.plan.action.toolName, 'filesystem.readText');
  assert.equal(resolve(task.plan.action.arguments.path), resolve(path));
  assert.notEqual(resolve(task.plan.action.arguments.path), resolve(join(root, 'continued.json')));
  assert.equal(task.request.command.rawText, `${JSON.stringify(path.replaceAll('\\', '/'))} 읽어줘`);
  assert.equal(task.request.metadata.workReference.path, path);

  const approved = runtime.coreFacade.submitApprovalDecision(createApprovalDecision({
    approvalId: task.approvalCard.approvalId, taskId: task.taskId, decision: ApprovalDecision.APPROVE,
    deviceId: 'mobile_lcb_001', decidedAt: new Date().toISOString()
  }));
  assert.equal(approved.success, true);
  assert.equal(approved.status, TaskStatus.APPROVED);
  const run = await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(run.success, true, JSON.stringify(run.error ?? run.executionVerification));
  assert.equal(run.status, TaskStatus.COMPLETED);
  assert.equal(run.planVerification.status, 'passed');
  assert.equal(run.policyVerification.status, 'passed');
  assert.equal(run.executionVerification.status, 'passed');
  const result = run.execution.executionResult;
  const expectedSha256 = createHash('sha256').update(content).digest('hex');
  assert.equal(result.executedBy.toolName, 'filesystem.readText');
  assert.equal(result.stdoutPreview, content);
  assert.equal(result.contentSha256, expectedSha256);
  assert.equal(result.evidence.contentSha256, expectedSha256);
  assert.equal(result.evidence.pathHash, createHash('sha256').update(resolve(path)).digest('hex'));
  assert.equal(result.evidence.bytes, Buffer.byteLength(content));
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.changedItems, []);
  assert.notEqual(result.contentSha256, createHash('sha256').update(decoy).digest('hex'));
}));

test('a remembered read target changed to a same-name decoy is blocked before any PC packet', async () => fixture(async ({ root, runtime, file, record, create }) => {
  const path = await file('continued.json', '{"source":"remembered"}');
  const decoy = join(root, 'continued.json');
  await writeFile(decoy, '{"source":"decoy"}');
  record([path]);
  const task = create('그 파일 읽어줘');
  task.plan.action.arguments.path = decoy;
  let received = 0;
  runtime.pcAgent.receiveExecutionPacket = async () => { received += 1; throw Error('PC_EXECUTION_MUST_NOT_RUN'); };
  const run = await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(run.success, false);
  assert.equal(run.status, TaskStatus.BLOCKED);
  assert.equal(run.error.code, 'A_WORK_REFERENCE_TARGET_MISMATCH');
  assert.equal(received, 0);
  assert.equal(task.policy.blockedCode, 'A_WORK_REFERENCE_TARGET_MISMATCH');
}));

test('explicit read paths retain spaces and nesting independently of artifact memory', async () => fixture(async ({ root, create }) => {
  const directory = join(root, 'source folder');
  await mkdir(directory);
  const path = join(directory, 'note version.2.json');
  await writeFile(path, '{"explicit":true}');
  for (const command of [`"${path}" 파일을 읽어줘`, `'source folder/note version.2.json' 내용을 읽어줘`]) {
    const task = create(command);
    assert.equal(task.plan.action.toolName, 'filesystem.readText');
    assert.equal(resolve(task.plan.action.arguments.path), resolve(path));
    assert.equal(task.request.metadata.workReference, undefined);
  }
}));

test('an explicit outside-root read is denied instead of silently reading an in-root namesake', async () => fixture(async ({ root, runtime, create }) => {
  const outside = await mkdtemp(join(tmpdir(), 'jarvis-read-outside-'));
  try {
    const path = join(outside, 'outside.txt');
    await writeFile(path, 'outside source');
    await writeFile(join(root, 'outside.txt'), 'in-root decoy');
    const task = create(`"${path}" 파일을 읽어줘`);
    assert.equal(resolve(task.plan.action.arguments.path), resolve(path));
    const run = await runtime.orchestrationWorker.runTask(task.taskId);
    assert.equal(run.success, false);
    assert.notEqual(run.status, TaskStatus.COMPLETED);
    assert.equal(run.execution?.executionResult?.stdoutPreview, undefined);
    assert.equal(task.policy.decision === 'block' || run.execution?.status === TaskStatus.BLOCKED, true);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('approval editing resolves the new deictic command instead of retaining an earlier artifact binding', async () => fixture(async ({ file, record, create, edit }) => {
  const first = await file('before-edit.txt', 'old');
  const second = await file('after-edit.txt', 'new');
  record([first]);
  const task = create('그 파일 열어줘');
  const oldBinding = task.request.metadata.workReference;
  record([second]);
  const result = edit(task, '그 파일 요약해줘');
  assert.equal(result.success, true);
  assert.equal(task.request.metadata.workReference.path, second);
  assert.notEqual(task.request.metadata.workReference.artifactId, oldBinding.artifactId);
  assert.equal(task.request.metadata.workReferenceOriginalText, '그 파일 요약해줘');
  assert.ok(task.request.command.rawText.includes('after-edit.txt'));
  assert.equal(task.request.command.rawText.includes('before-edit.txt'), false);
}));

test('an approval edit with an explicit different path removes stale memory metadata', async () => fixture(async ({ file, record, create, edit }) => {
  record([await file('remembered.txt')]);
  const explicit = await file('explicit.txt');
  const task = create('그 파일 열어줘');
  assert.ok(task.request.metadata.workReference);
  const command = `"${explicit}" 파일을 읽어줘`;
  const result = edit(task, command);
  assert.equal(result.success, true);
  assert.equal(task.request.command.rawText, command);
  assert.equal(task.request.metadata.workReference, undefined);
  assert.equal(task.request.metadata.workReferenceOriginalText, undefined);
  assert.equal(task.request.metadata.workReferenceResolved, undefined);
}));

test('an ambiguous approval edit creates a blocked policy instead of reusing the prior single target', async () => fixture(async ({ file, record, create, edit }) => {
  const first = await file('one.txt');
  const second = await file('two.txt');
  record([first]);
  const task = create('그 파일 열어줘');
  record([first, second]);
  const result = edit(task, '그 파일 요약해줘');
  assert.equal(result.status, TaskStatus.BLOCKED);
  assert.equal(task.request.metadata.workReference, undefined);
  assert.equal(task.request.metadata.workReferenceIssue.status, 'ambiguous');
  assert.equal(task.policy.blockedCode, 'A_WORK_REFERENCE_AMBIGUOUS');
}));
