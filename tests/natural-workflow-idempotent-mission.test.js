import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

test('new missions execute the same eight clauses through G without rewriting equal files, leaving unsupported whole-goal proof pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-idempotent-natural-mission-'));
  try {
    await mkdir(join(root, 'live'));
    await writeFile(join(root, 'live/source.json'), JSON.stringify([
      { item: '표지', quantity: 4, price: 3 }, { item: '본문', quantity: 2, price: 11 }, { item: '삽화', quantity: 3, price: 2 }
    ]));
    const objective = [
      "'live/source.json' JSON을 '자료'로 읽고",
      "'자료'에 'amount' = 'quantity' * 'price'를 계산해 '계산'으로 만들고",
      "'계산'을 'amount' 내림차순으로 정렬해 '순위'로 만들고",
      "'순위'를 'live/ranked.json' JSON으로 저장하고",
      "'live/ranked.json' JSON을 '재조회'로 읽고",
      "'재조회'의 'amount' 통계를 계산해 '통계'로 만들고",
      "'통계'를 'live/stats.json' JSON으로 저장하고",
      "'재조회'의 행 수가 3인지 검증해"
    ].join('; ');
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
    assert.ok(runtime.missionPlanner instanceof GoalExecutivePlanner);
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'natural-idempotent-mission-test', durationMinutes: 5 });
    const request = {
      objective,
      successCriteria: [`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`],
      authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] }
    };
    const run = async () => {
      const created = runtime.missionRuntime.createMission(request);
      const result = await runtime.missionRuntime.runMission(created.missionId);
      const observation = result.observations.find((entry) => entry.toolName === 'workflow.execute');
      assert.equal(result.status, 'PAUSED', JSON.stringify({ stopReason: result.stopReason, observations: result.observations }));
      assert.equal(result.stopReason, 'verification-incomplete');
      assert.equal(observation.outcome, 'success');
      assert.equal(observation.verification.status, 'passed');
      assert.deepEqual(observation.verification.failedCheckIds, []);
      assert.equal(observation.data.workflow.nodeCount, 8);
      return { result, observation };
    };
    const files = ['live/ranked.json', 'live/stats.json'];
    const state = async () => Promise.all(files.map(async (file) => ({
      path: file,
      sha256: createHash('sha256').update(await readFile(join(root, file))).digest('hex'),
      mtimeMs: (await stat(join(root, file))).mtimeMs
    })));
    const first = await run();
    const before = await state();
    const journalBefore = await readFile(join(root, 'audit/undo-journal.jsonl'), 'utf8');
    const second = await run();
    const after = await state();
    assert.notEqual(first.result.missionId, second.result.missionId);
    assert.notEqual(first.observation.actionId, second.observation.actionId);
    assert.notEqual(first.observation.taskId, second.observation.taskId);
    assert.notEqual(first.observation.verification.verificationId, second.observation.verification.verificationId);
    assert.equal(first.observation.data.workflow.specSha256, second.observation.data.workflow.specSha256);
    assert.deepEqual(after, before);
    assert.equal(await readFile(join(root, 'audit/undo-journal.jsonl'), 'utf8'), journalBefore);
    assert.deepEqual(JSON.parse(await readFile(join(root, files[0]), 'utf8')).map((row) => row.amount), [22, 12, 6]);
    assert.equal(JSON.parse(await readFile(join(root, files[1]), 'utf8')).sum, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});
