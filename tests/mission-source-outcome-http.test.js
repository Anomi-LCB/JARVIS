import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';

const objective = [
  "'live/source.json' JSON을 '원본'으로 읽고", "'원본'에 '금액' = '수량' * '가격'를 계산해 '계산'으로 만들고",
  "'계산'을 '금액' 내림차순으로 정렬해 '순위'로 만들고", "'순위'를 'live/ranked.json' JSON으로 저장하고",
  "'live/ranked.json' JSON을 '재조회'로 읽고", "'재조회'의 '금액' 통계를 계산해 '통계'로 만들고",
  "'통계'를 'live/stats.json' JSON으로 저장하고", "'재조회'의 행 수가 3인지 검증해"
].join('; ');

test('exact UI request payload completes through authenticated Core HTTP create and run routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-source-outcome-http-'));
  let runtime, server;
  try {
    await mkdir(join(root, 'live'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'live/source.json'), JSON.stringify([
      { 이름: '연필', 수량: 2, 가격: 3 }, { 이름: '종이', 수량: 4, 가격: 5 }, { 이름: '펜', 수량: 1, 가격: 10 }
    ]));
    const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
    runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, workerDaemonEnabled: false });
    const owner = runtime.personalOwnerSession.activate({ requestedBy: 'source-outcome-http-test', durationMinutes: 5 });
    server = createCoreServer(runtime.coreFacade, { adminToken: 'source-outcome-http-admin', missionRuntime: runtime.missionRuntime,
      ownerSessionManager: runtime.personalOwnerSession });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'content-type': 'application/json', authorization: 'Bearer source-outcome-http-admin' };
    const create = await fetch(`${base}/missions`, { method: 'POST', headers, body: JSON.stringify({
      objective,
      executionMandateId: null,
      successCriteria: [`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,
        '요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.'],
      constraints: ['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.',
        '최신 정보가 필요하면 출처와 조회 시점을 실행 증거에 남긴다.', '외부 전송과 되돌릴 수 없는 작업은 행동별 승인을 받는다.'],
      budgets: { maxWaves: 12, maxActions: 40, maxActiveRuntimeMs: 1_200_000 },
      authorization: { mode: 'trusted_session', grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT], ownerSessionId: owner.session.sessionId },
      metadata: { submittedBy: 'jarvis-control-center', conversationId: 'synthetic-source-outcome', automaticallyRouted: false,
        commandRouting: classifyCommandLane(objective) }
    }) });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.ok(created.missionId);
    const run = await fetch(`${base}/missions/${encodeURIComponent(created.missionId)}/run`, {
      method: 'POST', headers, body: JSON.stringify({ maxWaves: 12 })
    });
    assert.equal(run.status, 200);
    const result = await run.json();
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
    assert.equal(result.verificationSummary.verifiedCount, 2);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'live/ranked.json'), 'utf8')).map(row => row.금액), [20, 10, 6]);
    assert.equal(JSON.parse(await readFile(join(root, 'live/stats.json'), 'utf8')).sum, 36);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    runtime?.workerDaemon?.stop({ reason: 'test-finished' });
    runtime?.coreFacade?.cognition?.close();
    await runtime?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
