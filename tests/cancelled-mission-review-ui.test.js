import test from 'node:test';
import assert from 'node:assert/strict';
import { createCancellationReviewPanel } from '../src/ui/cancelled-mission-review.js';
const mission = { missionId: '합성-취소', status: 'CANCELLED', goalContract: { revision: 1, objectiveSha256: 'a'.repeat(64) } };
const observation = () => ({ success: true, reviewVersion: 'a-cancelled-mission-review-v1', missionId: mission.missionId,
  status: 'CANCELLED', goalRevision: 1, objectiveSha256: 'a'.repeat(64), checkedAt: new Date().toISOString(),
  executionAuthority: false, effectsChanged: false, memoriesChanged: false,
  unresolvedCount: 1, items: [{ status: 'verified-executed', currentArtifactVerified: true },
    { status: 'unresolved', currentArtifactVerified: false, causeCode: 'A_MANDATE_EXECUTION_DENIED' },
    { status: 'not-started', currentArtifactVerified: false }, { status: 'not-dispatched', currentArtifactVerified: false }] });

test('cancelled review UI uses observation-only request, separates effects and keeps no resume action', async () => {
  const calls = []; const panel = createCancellationReviewPanel({ request: async (...args) => { calls.push(args); return observation(); } });
  assert.equal(panel.render({ ...mission, status: 'RUNNING' }), '');
  await panel.review(mission);
  assert.deepEqual(calls[0], ['/missions/' + encodeURIComponent(mission.missionId) + '/cancellation-review',
    { method: 'POST', timeoutMs: 180000, body: { expectedGoalRevision: 1, expectedObjectiveSha256: 'a'.repeat(64) } }]);
  const html = panel.render(mission);
  for (const label of ['실행 결과 확인됨', '실행 결과 미확인', '시작하지 않음', '실행기에 전달되지 않음', '자료 접근 권한']) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /data-mission-resume|data-mission-cancel|<script/u);
});

test('busy review deduplicates calls and observations stay bound to endpoint and goal revision', async () => {
  let release, calls = 0, endpoint = 'core-a';
  const panel = createCancellationReviewPanel({ endpoint: () => endpoint, request: () => { calls++; return new Promise(r => { release = r; }); } });
  const pending = panel.review(mission); await panel.review(mission); assert.equal(calls, 1);
  assert.match(panel.render(mission), /disabled.*결과 확인 중/u);
  release(observation()); await pending;
  assert.match(panel.render(mission), /실행 결과 확인됨/u);
  assert.doesNotMatch(panel.render({ ...mission, goalContract: { ...mission.goalContract, revision: 2 } }), /실행 결과 확인됨/u);
  endpoint = 'core-b'; assert.doesNotMatch(panel.render(mission), /실행 결과 확인됨/u);
});

test('malformed or authority-bearing responses cannot display verified result', async () => {
  for (const change of [ { executionAuthority: true }, { effectsChanged: true }, { missionId: 'other' },
    { items: [{ status: 'verified-executed', currentArtifactVerified: false }] }, { unresolvedCount: 0 } ]) {
    const panel = createCancellationReviewPanel({ request: async () => ({ ...observation(), ...change }) });
    await panel.review(mission); assert.match(panel.render(mission), /조회하지 못했습니다/u);
    assert.doesNotMatch(panel.render(mission), /실행 결과 확인됨/u);
  }
});

test('source conflicts and active-run errors provide recovery without rendering raw errors', async () => {
  for (const [code, expected] of [['A_MISSION_CANCELLATION_REVIEW_SOURCE_CHANGED', '새로고침'], ['A_MISSION_CANCELLATION_REVIEW_RUN_ACTIVE', '잠시 후']]) {
    const panel = createCancellationReviewPanel({ request: async () => { throw Object.assign(Error('<script>private</script>'), { payload: { error: { code } } }); } });
    await panel.review(mission); assert.ok(panel.render(mission).includes(expected)); assert.doesNotMatch(panel.render(mission), /private/u);
  }
});
