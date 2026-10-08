import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/health-process-recovery-20261007';
const observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const write = (name, data) => writeFileSync(`${prefix}-${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const log = read(`${prefix}-regression.txt`);
for (const [key, expected] of [['tests',32],['pass',32],['fail',0],['skipped',0]]) assert.equal(Number(log.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1]), expected);
const live = JSON.parse(read(`${prefix}-live.json`));
assert.equal(live.platform, 'win32');
assert.equal(live.actualIndependentProcesses, true);
assert.equal(live.processIds.length, 6);
assert.equal(new Set(live.processIds).size, 6);
assert.equal(live.generation.status, 'COMPLETED');
assert.equal(live.generation.forciblyTerminated, true);
assert.equal(live.restoration.status, 'verified');
assert.equal(live.restoration.missionStoreUnchanged, true);
for (const name of ['changedSource', 'changedReport', 'deletedReport']) assert.equal(live[name], 'changed-or-unavailable');
assert.notEqual(live.medicalRequest.status, 'COMPLETED');
assert.equal(live.medicalRequest.noReportProduced, true);
assert.equal(live.oracle.sampleMean,80); assert.equal(live.oracle.difference,-20); assert.equal(live.oracle.gapDays,2);
assert.match(read('artifacts/health-report-preview-20261005-final-browser.log'), /"passed": 2, "responseMocked": false/u);
write('source.json', { observedAt, files: ['tests/health-process-recovery.test.js', 'tests/fixtures/health-process-observation.mjs', 'tests/fixtures/health-report-process.mjs', 'scripts/observe-health-process-recovery-20261007.mjs', 'packages/core/src/mission/mission-health-report-result.js', 'packages/shared/src/health-record-summary.js'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), content: read(path) })) });
write('verification.json', { observedAt, passed:32, failed:0, skipped:0, testFiles:8,
    actualProcessObservation: { path:`${prefix}-live.json`, processes:6, platform:'win32', sameHost:true, syntheticRecords:true, externalModelsCalled:false },
    priorActualUi: { report:'artifacts/health-report-preview-20261005-report.md', log:'artifacts/health-report-preview-20261005-final-browser.log', passedViews:2, responseMocked:false, rerunThisTurn:false },
    physicalDeviceTested:false, clinicalValidation:false, windowsServiceOrReboot:false, actualCost:null, productLatencyPercentiles:null });
write('report.md', `# 健康 기록 보고서 실제 프로세스 복구와 인수 검토\n\n관측 ${observedAt}. V3-087 원래 요구는 “건강 추세·진료용 기록을 생성하고 의료 처치·진단 실행으로 혼동하지 않는다”다. 제공된 기록을 통계·출처·결측·비교 한계와 함께 문서로 정리하는 기능을 인수한다. 실제 워치/Health Connect 연결은V3-081/085, Windows 서비스/재부팅은047,장기 실사용은098의 별도 조건이다. 이 조건을 변경하거나 임상 판정을 통계로 대체하지 않는다.\n\n## 실제 실행과 독립 수치 대조\n\n격리 합성자료를 실제 Core→E→B→G의 자연어4노드 Mission으로 읽기/건강보고서/Markdown저장/재읽기 처리했다. 완료 후 생성 프로세스를 부모가 실제 강제 종료했고, 별도 PID의 새 프로세스가 영속 Mission에서 현재 원본·산출물·receipt를 다시 확인했다. 같은 프로세스 runtime 교체였던 이전 증거를 실제 OS 프로세스 종료/복원으로 확장했다. Mission 원장 바이트 불변·원본 불변·보고서 내용 동일을 확인했다. Windows 재부팅/제품 서비스 변경은 하지 않았다.\n\n계산기와 분리한 고정 오라클은 날짜별표본70/90→평균80,별도센서100분리,이틀뒤평균60/간격2일/차이-20,자료없는날2개다. 결측을0으로 채우거나 날짜별표본을 하루전체 측정으로 표현하지 않는다. 원본변경·산출물999변조·삭제 각각 별도 새프로세스에서 changed-or-unavailable/내용 생략. 진단/약 복용량 결정을 추가한 복합 요청은 ${live.medicalRequest.status}이고 새 보고서를 생성하지 않았다. 외부 모델/실제 건강·가족정보/계정/워치/처치 도구를 호출하지 않았다.\n\n실제6개PID 관측은 live.json. 관련8파일32/32,실패0·미실행0. 최초 실험 fixture import 경로가 상위 디렉터리를 가리켜 실패한 로그를 보존하고 경로를 수정했다. 기존 실제 격리 Core·원격B·Chromium 2뷰 보고서/변조시내용제거/무인증거부 증거도 검토했다. UI 코드를 이번에 바꾸지 않았으며 이전 브라우저 실행을 이번 신규 실행으로 합산하지 않는다.\n\n## 완료 범위와 한계\n\n지원한 제공자료는 심박수·수면시간·걸음 표본이고 출처/센서/보정/UTC날짜별 통계와 추세차이를 진료 시 참고할 기록으로 제공한다. 출처는 제공값으로 표시하며 센서 진위·임상 의미·진료품질·실기기 연결은 검증하지 않았다. 공유 계산기 재계산은 임상 독립 평가가 아니며 이번 별도 고정 수치 오라클도 임상 검증이 아니다. 건강 보고서 생성 기능을 의료진 대체·진단·처치 실행으로 확대하지 않는다. 범용 한국어 모든 문형·웨어러블 현장·장기 관찰은 별도 미완료다. 비용과 제품 p50/p95는 미측정.\n\n원래087의 파일 업무/비의료 경계를 실제 파이프라인·UI·현재내용 거부·독립 수치·프로세스복원 증거로 충족해 verified. 공식52→53/100. 원래100개 요구/전체 목표를 유지한다. 이번 변경은 격리 실행 및 반복 가능한 회귀 harness이며 제품/개인기억/권한을 변경하지 않았다. 복원은 추가 시험/harness만 제거하면 되며 기존 건강 검증기/자료 접근 위임을 완화하지 않는다.\n`);
const evidencePaths = ['report.md','verification.json','source.json','live.json','regression.txt','first.txt','recheck.txt'].map(name=>`${prefix}-${name}`);
write('attempt.json',{id:'health-process-recovery-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
    hypothesis:'동일인스턴스 교체를 넘어서 실제 생성 프로세스 종료 후 현재 원본·보고서·receipt를 재검증하면 건강통계 기록의 복구와 변경 결과 미노출을 확인할 수 있다.',
    lesson:'영속파일의 존재와 실행 복구는 다르다. 별도PID 복원과 공유계산기 밖의 고정 수치 오라클을 사용하고 임상 의미와 구분해야 한다.',
    limitations:'제공된 합성기록/지원3metric·고정문형/같은Windows호스트. 실제기기/임상/서비스재부팅/장기 관찰 미검증. 비용·제품지연 미측정.'});
const path='docs/universal-control-v3-acceptance.json', ledger=JSON.parse(read(path)), gates=ledger.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100); assert.equal(gates.filter(g=>g.status==='verified').length,52);
const gate=gates.find(g=>g.id==='V3-087');assert.equal(gate.status,'in_progress');
assert.equal(gate.requirement,'건강 추세·진료용 기록을 생성하고 의료 처치·진단 실행으로 혼동하지 않는다.');
gate.reviewHistory??=[];gate.reviewHistory.push({previousStatus:gate.status,previousReviewedAt:gate.reviewedAt,reviewedAt:observedAt,reason:'원래087의 비의료 기록생성 범위를 실제Core/E/B/G/기존실UI/독립수치 및 OS프로세스 종료복원으로 검토. 실기기085/서비스047/장기098은 별도 미완료.'});
gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 최신: 실제6PID·고정수치oracle·강제종료복원·변경/삭제 내용차단·진단복합요청 미완료·32통과·기존실UI2뷰검토로 원래087 비의료기록생성 인수. 지원3metric/고정문형; 실기기/임상/서비스재부팅/장기는 다른미완료 인수 범위.');
ledger.updatedAt=observedAt;writeFileSync(path,JSON.stringify(ledger,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제健康Mission6PID/생성프로세스강제종료→새프로세스복원/고정수치오라클/변조·삭제내용차단·진단요청미완료32통과,기존실UI검토. V3-087 verified·공식53/100. 제공기록3metric만; 워치/임상/Windows서비스/장기는 완료아님.\n`);
console.log(JSON.stringify({verified:53,acceptanceId:gate.id,observedAt}));
