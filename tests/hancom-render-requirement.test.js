import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeMissionArguments } from '../packages/core/src/planning/mission-action-arguments.js';
import { TaskPlanner } from '../packages/core/src/planning/task-planner.js';
import { HwpCreateToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { verifyHancomRenderingCurrent } from '../apps/verification/src/hancom-render-verifier.js';

function plannedArguments(path, verifyRendering) {
  const prepared = { path, title: '원문 렌더 요구', blocks: [{ type: 'paragraph', text: '저장한 문서를 실제 출력으로 검증합니다.' }] };
  if (verifyRendering !== undefined) prepared.verifyRendering = verifyRendering;
  return new TaskPlanner({ workspaceRoot: tmpdir() }).createPlan({
    requestId: 'render-requirement-request', taskId: 'render-requirement-task',
    createdAt: '2026-10-07T00:00:00.000Z', command: { rawText: '한글 문서를 생성하고 실제 렌더 결과를 확인해.' }
  }, { actionType: 'CREATE_DOCUMENT', title: '문서 생성' }, {
    route: { skill: { skillId: 'hwp-test', toolName: 'hwp.create' } },
    preparedMissionArguments: prepared
  }).action.arguments;
}

for (const option of [true, false]) test(`Hancom rendering ${option} survives both Mission boundaries`, () => {
  const input = { path: 'document.hwpx', verifyRendering: option, capabilityToken: 'untrusted', rendererCommand: 'untrusted' };
  const once = sanitizeMissionArguments('hwp.create', input);
  assert.deepEqual(once, { path: input.path, verifyRendering: option });
  assert.deepEqual(sanitizeMissionArguments('hwp.create', once), once);
  assert.equal(plannedArguments(input.path, option).verifyRendering, option);
});

test('An absent Hancom rendering option remains absent', () => {
  assert.equal(Object.hasOwn(plannedArguments('document.hwp'), 'verifyRendering'), false);
});

for (const option of ['true', 1, null]) test(`Malformed rendering ${JSON.stringify(option)} cannot become a successful unrendered document`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-render-option-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = plannedArguments(join(root, '文서.hwpx'), option);
  const result = await new HwpCreateToolAdapter({ allowedRoots: [root] }).execute(args);
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.error, 'hwp-rendering-option-invalid');
  assert.deepEqual(await readdir(root), []);
});

for (const extension of ['hwp', 'hwpx']) test(`Planned ${extension} rendering reaches actual Hancom and independent G`, {
  skip: process.platform !== 'win32' || process.env.JARVIS_NATIVE_HWP_TEST !== '1', timeout: 120000
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-planned-hancom-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const args = plannedArguments(join(root, `문서.${extension}`), true);
  assert.equal(args.verifyRendering, true);
  const result = await new HwpCreateToolAdapter({ allowedRoots: [root] }).execute(args, { taskId: 'planned-render-test' });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.nativeRendering.actualRenderingExecuted, true);
  assert.ok(result.outputPaths.includes(result.nativeRendering.manifestPath));
  const proof = await verifyHancomRenderingCurrent({ executionResult: result, allowedRoots: [root] });
  assert.equal(proof.passed, true, JSON.stringify(proof));
});
