import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/conditional-read-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',115],['pass',115],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-baseline.txt`),/ℹ fail 4(?:\r?\n|$)/);
assert.match(read(`${prefix}-continue-baseline.txt`),/ℹ fail 1(?:\r?\n|$)/);
assert.match(read(`${prefix}-current-revision-before.txt`),/text-read-receipt-unbound/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const events=read(`${prefix}-final.txt`).split(/\r?\n/u).filter(line=>line.startsWith('{"prefix"')||line.startsWith('{"explicitCorrection"')).map(line=>JSON.parse(line));
assert.equal(events.length,6);
for(const e of events.filter(e=>!e.explicitCorrection)){assert.equal(e.reads.source,0);assert.equal(e.actualCoreEBG,true);assert.equal(e.actualSQL,true);}
assert.equal(events.find(e=>e.mixed).reads.seed,1);
assert.equal(events.find(e=>e.explicitCorrection).status,'COMPLETED');assert.equal(events.find(e=>e.explicitCorrection).reads,1);
const sourcePaths=['packages/core/src/mission/goal-contract.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/mission/read-only-text-proof.js','tests/clarification-conditional-read.test.js','docs/conditional-goal-boundary.md'];
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
write('verification.json',{observedAt,baseline:{tests:4,failed:4,actualConditionalReadFailures:3},normalContinueBaseline:{failed:1,conditionalReads:2},
  correctedRevisionBaseline:{failed:1,reason:'text-read-receipt-unbound'},final:{tests:115,passed:115,failed:0,skipped:0,events},buildPassed:true,contractPassed:true,
  formalVerified:59,providerCalls:0,paidModelCalls:0,actualCost:null,productActivated:false});
write('report.md',`# 조건부 읽기의 선행 실행과 목표 정정 완료 실패 수정

관측 ${observedAt}. 공식 인수59/100 유지. V3-020/021의 부분 구현 증거이며 독립 의미평가·전체 실사용 완료가 아니다.

## 재현한 실패

질문 대기 경로의 기존4검사가 모두 실패했다. 단위검사는 조건이 recognized로 잘못 분류됨을 확인했고, 실제 Core/E/B/G 세 사례에서 “승인하면”, “승인 후”, “내용이 정확하면”으로 제한한 임시 파일을 승인 전에1회씩 읽었다. 별도 일반 continue 경로도 조건을 무시해2회 읽었다. 오류·중간 수정 결과를 각각 보존했다.

## 최종 동작

원문의 조건 표시를 위치와 함께 unresolvedConditions로 보존한다. 원문을 다시 해석해 조건부 요구 연결을 확인하므로 모델의 독립 읽기 표시나 continue 결정은 조건 충족 증거가 되지 않는다. 조건과 무관한 별도 읽기는 요구 ID·실제 대상 경로를 대조해 진행한다. 인용 파일명 속 조건 단어와5분 이내의 기한을 조건부로 오인하지 않는 대조군을 검사했다. 조건이 충족됐다는 임의 모델 응답은 실행을 허용하지 않는다.

실제 Core/E/B/G·SQLite 최종5조건: 질문 대기3건의 조건부 읽기0; 조건부+무조건 요청1건에서 보호 파일0·독립 seed 파일1; 일반 continue1건의 조건부 읽기0. 질문2개는 gate1개이며 다시 실행해도 읽기와 질문 묶음이 늘지 않는다. 전체 요청은 조건이 미해결이므로 WAITING_APPROVAL/PAUSED이고 완료가 아니다.

사용자가 지금 읽도록 조건을 제거한 같은 Mission의 revision2에서는 실제 읽기1회·현재 원문 독립 대조로 COMPLETED를 확인했다. 처음에는 과거 버전의 보류 action까지 현재 읽기 영수증으로 검사해 text-read-receipt-unbound가 발생했다. 현재 버전만 완료 증거로 검증하도록 수정하고, 과거·미래·누락 버전만 있는 변조 대조군은 완료하지 않음을 확인했다. 과거 목표와 실패는 삭제하지 않는다. 최초 정정 fixture의 완료 기준 미지정 오류와 부적절한 typed artifact 기준은 fixture 준비 오류로 보존하며 제품 결함에 합산하지 않는다.

## 검증과 한계

최종10파일 회귀115/115, fail0·skip0. build와Core 계약 gate 통과. 기존 도착 이벤트에 따른 메일 보류 시험에서 독립 읽기·작성까지 잘못 막던 중간 수정1실패를 확인해 행동별 무조건 원문·대상 대조로 바로잡았다. 전체 미래 조건을 해석하거나 조건의 참/거짓을 판단했다는 의미는 아니다. 실제 계정·외부 발송·장기 관측·설치본 활성화·운영 서비스 재시작은 수행하지 않았다. 임시 합성 파일의 실제 실행이며 유료 모델 호출0, 비용은 미측정 null이다.

다음은 조건별 실제 관측 오라클과 질문 필요성·의미 완결성을 연결하는 것이다. 원래 V3-020 전체 인수와 V3-024의 새26/260 평가를 모의 결과로 대체하지 않는다. 복원 시 goal-contract 조건 표시, Mission dispatch fence, 읽기 완료의 revision 검사를 함께 리뷰하고 원래 선행 읽기 반례를 유지한다. F/cognition 실제 업무 기억은 수정하지 않았다.
`);
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-baseline.txt`,`${prefix}-baseline-runner.json`,`${prefix}-continue-baseline.txt`,`${prefix}-continue-baseline-runner.json`,
 `${prefix}-scope.txt`,`${prefix}-revision.txt`,`${prefix}-revision2.txt`,`${prefix}-current-revision-before.txt`,`${prefix}-current-revision-before-runner.json`,`${prefix}-final.txt`,`${prefix}-final-runner.json`,`${prefix}-build.txt`,`${prefix}-contract.txt`];
write('attempt.json',{id:'conditional-read-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원문 조건·행동별 요구·대상을 재대조하면 모델의 독립 읽기 표시가 조건을 삭제할 수 없으며 같은 Mission의 명시 정정 후 실제 완료까지 이어진다.',
 lesson:'read_only는 조건과 무관함의 증거가 아니다. 미해결 조건을 보존하고 독립 작업은 해당 절/실제 대상으로 한정한다. 정정 후 G는 과거 영수증을 현재 결과로 쓰거나 과거 실패로 새 결과를 막지 않아야 한다.',
 limitations:'최종115회귀·실제Core/E/B/G·임시파일/SQL. 범용 조건진위/독립의미/실계정/설치·운영·장기 미검증. V3-020/021 부분, 공식59%. 비용 미측정.'});
for(const id of ['V3-020','V3-021']){const gate=gates.find(g=>g.id===id);assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 조건부 원문 선행읽기3+continue1 실패 수정·독립읽기 유지/질문2개1묶음·명시정정revision2 실제읽기1/G완료·115회귀/build/contract. 조건진위/범용의미/실계정·설치·장기 전체인수 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 조건부 선행읽기3+continue1 수정·독립읽기/질문묶음 유지·정정 뒤 G 과거revision 혼합 실패 수정/실제완료·115회귀/build/contract. 공식59% 유지. 다음 조건 관측 오라클·질문 필요성/전체 의미와 신규26/260.\n`);
console.log(JSON.stringify({observedAt,verified:59,tests:115,conditionalReads:0,correctedMissionCompleted:true}));
