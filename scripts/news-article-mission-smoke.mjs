import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

const articleUrl = process.argv[2];
if (!articleUrl) {
  console.error('Usage: node scripts/news-article-mission-smoke.mjs https://publisher.example/article');
  process.exitCode = 2;
} else {
  const runStarted = Date.now();
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'jarvis-news-mission-smoke-'));
  let calls = 0;
  let observedArticle = null;
  const missionPlanner = {
    async planNextWave(context) {
      calls += 1;
      const requirementIds = context.mission.goalContract?.requirements?.map(item => item.requirementId) ?? [];
      if (calls === 1) return {
        decision: 'continue', summary: '직접 제공된 게시자 기사 URL을 안전하게 읽습니다.',
        actions: [{ id: 'read_article', title: '게시자 기사 본문 읽기',
          command: `게시자 기사 본문 읽기: ${articleUrl}`, expectedToolName: 'news.fetchArticle',
          arguments: { url: articleUrl }, dependencies: [], requirementIds,
          successSignal: '실제 본문 텍스트와 출처 URL이 포함된 article evidence' }], criteriaAssessment: []
      };
      observedArticle = context.observations.find(observation => (
        observation.toolName === 'news.fetchArticle' && observation.outcome === 'success'
      ))?.data?.article ?? null;
      return {
        decision: 'complete', summary: '읽기 증거를 G 검증에 제출합니다.', actions: [],
        criteriaAssessment: [{ criterionId: 'criterion_article_read', status: 'satisfied',
          evidenceActionIds: context.observations.filter(item => item.toolName === 'news.fetchArticle' && item.outcome === 'success')
            .map(item => item.actionId), reason: '실제 공개 HTTPS 본문 추출 증거가 관찰됐습니다.' }]
      };
    }
  };

  let runtime;
  try {
    runtime = createAgRuntime({ allowedRoots: [isolatedRoot], auditRoot: isolatedRoot,
      cwd: () => isolatedRoot, env: { JARVIS_TEST_MODE: '1' }, missionPlanner, workerDaemonEnabled: false });
    const created = runtime.missionRuntime.createMission({
      objective: `직접 제공된 게시자 기사 본문을 읽고 실제 본문 추출 여부를 검증한다: ${articleUrl}`,
      successCriteria: [{ criterionId: 'criterion_article_read',
        statement: '직접 제공된 게시자 HTTPS 기사 본문이 실제로 추출되어 검증된다.' }]
    });
    assert.ok(created.missionId, JSON.stringify(created));
    const mission = await runtime.missionRuntime.runMission(created.missionId);
    observedArticle = mission.observations.find(item => item.toolName === 'news.fetchArticle'
      && item.outcome === 'success')?.data?.article ?? observedArticle;
    assert.equal(mission.status, 'COMPLETED', JSON.stringify({ status: mission.status, stopReason: mission.stopReason,
      completion: mission.completion, verificationSummary: mission.verificationSummary,
      observations: mission.observations.map(item => ({ toolName: item.toolName, outcome: item.outcome,
        summary: item.summary, error: item.error, verification: item.verification })) }));
    assert.equal(mission.completion?.status, 'verified');
    assert.equal(observedArticle?.live, true);
    assert.equal(observedArticle?.textIsUntrustedSourceMaterial, true, JSON.stringify({ observedArticleKeys: Object.keys(observedArticle ?? {}), missionArticle: mission.observations.find(item => item.toolName === 'news.fetchArticle')?.data?.article }));
    assert.equal(observedArticle?.finalUrl, articleUrl.replace(/#.*$/u, ''));
    assert.ok(observedArticle?.textCharacters > 160);
    assert.match(observedArticle?.textSha256 ?? '', /^[a-f0-9]{64}$/u);
    const observation = mission.observations.find(item => item.toolName === 'news.fetchArticle' && item.outcome === 'success');
    assert.equal(observation?.trustBoundary, 'WEB_CONTENT');
    assert.equal(observation?.untrusted, true);

    const evidence = {
      status: 'passed', observedAt: new Date().toISOString(), durationMs: Date.now() - runStarted,
      missionStatus: mission.status, completionStatus: mission.completion.status,
      plannerCalls: calls, actionCount: mission.metrics?.successfulActions ?? 0,
      toolName: 'news.fetchArticle', live: observedArticle.live,
      finalHost: new URL(observedArticle.finalUrl).hostname, httpStatus: observedArticle.httpStatus,
      textCharacters: observedArticle.textCharacters, textSha256: observedArticle.textSha256,
      missionObservationTrustBoundary: observation.trustBoundary, missionObservationUntrusted: observation.untrusted,
      articleBodyPersistedToEvidence: false, temporaryRuntimeIsolated: true,
      externalModelCalls: 0, paidApiCalls: 0, externalMessages: 0
    };
    const artifactDirectory = join(fileURLToPath(new URL('../artifacts/', import.meta.url)),
      `news-article-mission-smoke-20260928-${randomBytes(3).toString('hex')}`);
    mkdirSync(artifactDirectory, { recursive: false });
    const evidencePath = join(artifactDirectory, 'evidence.json');
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
  } finally {
    runtime?.workerDaemon?.stop({ reason: 'article-mission-smoke-finished' });
    runtime?.coreFacade?.cognition?.close();
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}
