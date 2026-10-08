import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/source-question-20261007';
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,data)=>writeFileSync(`${prefix}-${suffix}`,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const pilot=JSON.parse(read(`${prefix}-pilot/comparison.json`)),live=JSON.parse(read(`${prefix}-live/comparison.json`));
assert.equal(pilot.rows.length,10);assert.equal(live.rows.length,2);
assert.equal(pilot.falseFiles,0);assert.equal(live.falseSavedFiles,0);
for(const [key,value] of [['tests',60],['pass',60],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const observedAt=new Date().toISOString();
const files=['packages/core/src/mission/source-question-binding.js','packages/core/src/mission/local-source-summary.js',
 'packages/core/src/mission/literal-source-fields.js','tests/local-summary-question-binding.test.js','tests/local-summary-mission.test.js',
 'tests/local-summary-numeric-evidence.test.js','scripts/source-question-pilot-20261007.mjs','scripts/source-question-live-20261007.mjs'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)})),
 pilot,live,priorEvidence:['artifacts/gepa-local-20261007/H1-baseline/mission.json','artifacts/gepa-local-20261007/H3-baseline/mission.json','artifacts/gepa-local-20261007/H4-baseline/mission.json']});
const completed=live.rows.filter(r=>r.report.status==='COMPLETED').length,blocked=2-completed;
write('report.md',`# 原文 질문과 사실값 연결 검증 — 오답 파일 저장 전 차단\n\n관측 ${observedAt}. 공식 인수56/100 유지.\n\n## 문제와 수정\n\n실제 GEPA/Hermes 비교에서 견적920000을 실제 지출0 대신 저장하고, 임시 검증됨을 최종 미검증 대신 저장하고, 전체 등록58을 설문 응답21 대신 저장하는 오류가 나왔다. 기존 검사는 숫자가 해당 인용 안에 존재하는지 확인했지만 그 인용이 질문의 대상인지 확인하지 못했다. 최종 G가 전체 완료를 막았어도 오답 파일은 이미 생겼다.\n\n호스트 질문에서 제한된 명시적 대상(실제 지출/납부/입금/지급/결제, 최종 확인/검증, 계약·승인 상태, 설문 응답자, 최종 참가/참석 인원)을 연결하고, 인용 밖에 있는 단일 선언의 값과 각 답의 고유 근거를 대조한다. 충돌·조건·부정·업체 주장·따옴표 속 예시·단위 불일치·지원하지 않는 합산 질문은 추측해 통과시키지 않는다. 동일 문구가 앞의 인용 예시에도 있으면 실제 비인용 선언 위치를 사용한다. 모델이 두 번의 기존 제한 수정에서도 틀리면 A_SOURCE_SUMMARY_OUTPUT_REJECTED로 저장 동작 전에 차단한다. 권한·평가기·고정 정답·원본 문서는 바꾸지 않았다.\n\n## 증거\n\n수정 전 새25검사 중19실패/6통과를 보존했다. 첫 통합39검사에서 기존 오답 Mission이 이제 PAUSED+저장 대신 BLOCKED+파일없음으로 바뀐 기대1실패, 이후60검사에서 기존 숫자 검사의 구체 오류 목록과 견적을 지출로 인정하던 기대2실패를 보존했다. 오라클의 실제 지출0은 그대로 유지하면서 차단 기대를 강화했다. 최종9파일60/60, fail0/skip0. 빌드·Core 계약 통과.\n\n과거 실제 모델 출력3건을 그대로 재생한 Core/E/B/G Mission은 모두 BLOCKED, 쓰기 호출0, 결과 파일0이다. 재생은 새로운 모델 추론이 아니다. 고정7건의 합성 정답 양성 대조는 실제 파일 저장·재발견·재읽기·오라클 일치로7/7완료다. 모델 품질 점수로 사용하지 않는다.\n\n동일한 설치 Gemma3 4.3B Q4 모델을 별도 루프백 Ollama에서 CPU3threads/num_gpu0로 다시 실행한 H1/H3 두 Mission은 완료${completed}·차단${blocked}·오답 파일0이다. 각 원문/오라클은 기존 SHA e12d6a80623cffa582890ef5ed9121af5d2c8c2e0a540eb0915c2535912aa8c4를 그대로 사용했다. 이미 개발에 노출된 회귀 사례이며 새 독립 holdout이나 일반 자연어 정확도 증거가 아니다. 전체시간은 개별 mission.json에 저장했다. 실제 추론·수정 횟수·usage와 비용 미측정을 구분한다. 유료 API0/요금0, 전기·장비 총비용은 미측정이다.\n\n## 한계·인수·복원\n\n이 검사는 제한된 질문/명시적 원문 선언의 대응만 검증한다. 임의 자연어 해석, 실제 은행 결제, 문서 진실성, 일반 전문 의미 검증, UI/설치본 업데이트, 독립26/260 평가나 전체 파일 업무 완료는 아니다. 인식된 범주의 지원 밖 문장은 보수적으로 차단하고 인식하지 못한 범주는 기존 검사를 유지하므로 semanticAccuracyVerified=false를 유지한다. V3-059의 증거를 추가하지만 전체 완료 승격은 하지 않는다. 개인 프로필과 F/cognition 실제 업무 기억을 변경하지 않았다.\n\n복원은 source-question-binding 모듈과 local-source-summary 연결, enum의 ‘다’ 종결 지원 및 관련 회귀 기대를 함께 검토한다. 복원하면 과거 견적/임시 결과/전체 인원 오답 파일이 다시 저장될 수 있다. 다음 작업은 지원 밖 요구의 명시적 준비 상태와 더 넓은 독립 의미 검증, 실제 문서 업무를 이어 연결하는 것이다.\n`);
const evidence=['report.md','source.json','before.txt','first.txt','regression.txt','final.txt','build.txt','contract.txt','pilot/comparison.json','live/comparison.json','pilot.txt','live.txt','ollama-stderr.txt','cleanup.json'].map(s=>`${prefix}-${s}`);
// Source and execution snapshots substantiate behavior; their hashes alone do not verify conclusions.
write('attempt.json',{id:'source-question-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths:evidence,
 hypothesis:'원문 질문의 대상과 선언을 대조하면 문서 안의 다른 견적/초기 결과/전체 인원을 답으로 저장하는 기존 오류를 저장 전에 차단할 수 있다.',
 lesson:`과거 실제 오답3건 재생 모두 쓰기 전 차단·합성양성7/7, 실제Gemma 두 Mission 완료${completed}/차단${blocked}/오답파일0. 60회귀·빌드·계약 통과.`,
 limitations:'명시적 선언과 제한된 질문 계약만 검증. 개발 노출된 회귀·모델 두 실행이며 일반 의미/실계정/설치본·전문가평가·총비용 미검증. 공식56 유지.'});
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse(read(path)),gates=doc.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,56);
const gate=gates.find(g=>g.id==='V3-059');assert.notEqual(gate.status,'verified');
gate.evidence.push(...evidence);(gate.limitations??=[]).push('2026-10-07: 질문-명시적 선언 대응/60회귀·실제과거오답3재생 쓰기 전 차단·합성양성7·실Gemma2회귀. 일반 원문 의미와 문서 형식·실사용 범위는 미완료.');
doc.updatedAt=observedAt;writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 질문과 원문 선언 연결로 견적/임시 결과/전체 인원 오답 저장 전 차단. 과거실제오답3재생·합성양성7·실Gemma2,60회귀/build/contract. 공식56 유지. 다음 지원 밖 문장 준비 상태·실제 문서 업무 및 독립 의미 검증.\n`);
console.log(JSON.stringify({observedAt,verified:56,tests:60,liveCompleted:completed,liveBlocked:blocked}));
