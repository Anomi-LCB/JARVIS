import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/laya-routing-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,data)=>writeFileSync(`${prefix}-${suffix}`,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString(),comparison=JSON.parse(read(`${prefix}-comparison.json`)),optimized=JSON.parse(read(`${prefix}-optimized-r2.json`));
assert.equal(comparison.rows.length,78);assert.equal(comparison.candidate.correct,45);assert.equal(comparison.baseline.correct,66);
assert.equal(comparison.adoption.passed,false);assert.equal(optimized.rows.filter(r=>r.correct).length,72);
assert.equal(optimized.corpusSha256,comparison.corpusSha256);
for(const [key,value] of [['tests',88],['pass',88],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final-r2.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-final-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const hashes=['packages/shared/src/command-lane.js','tests/command-lane-live-settings.test.js','tests/fixtures/laya-routing-holdout-20261007.json',
 'scripts/laya-local-probe-20261007.py','scripts/laya-routing-baseline-20261007.mjs','scripts/laya-routing-comparison-20261007.py'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}));
const checkpoint=JSON.parse(read('artifacts/laya-checkpoint-20261007.json'));
write('source.json',{observedAt,hashes,checkpointPostLoad:checkpoint.files.map(file=>{
 const path=file.path??file.localPath;
 const actualPath=path??`.runtime/laya-eval-20261007/model/${file.file??file.name}`;
 return {file,localPath:actualPath,currentSha256:createHash('sha256').update(readFileSync(actualPath)).digest('hex')};
})});
write('report.md',`# 한국어 빠른 선택기 실제 비교와 Core 분류 누락 수정\n\n관측 ${observedAt}. 공식 인수55/100 유지.\n\n## 실제 후보 실행\n\n공식 Laya 0.3.28과 multilingual 가중치 revision 1720e3e3357cfe1e281542e223f8273b0890ca34를 격리 venv에 설치했다. torch2.14.1+cpu/transformers5.19.0, CPU3threads, eager/compile false다. 가중치는 safetensors이며 원격 Python 코드/개인 자료/자격증명을 사용하지 않았다. 초기 다운로드 이후 HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE에서 실제 추론했다. 설치와 원문 체크포인트 해시, 실행 후 파일 해시, 전체 freeze를 보존했다. 패키지는 tokenizer config를 호환 형식으로 정규화할 수 있어 다운로드와 실행 후 해시를 구분한다. 원문 무결성은 성능·보안의 독립 보증이 아니다.\n\n공식 출처: [원본 구현](https://github.com/NandhaKishorM/laya), [한국어 포함 체크포인트](https://huggingface.co/convaiinnovations/laya-multilingual), [Jev 비교 조건](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Jev의 실 API는 인증/예산 준비 전이며 이번에 호출하지 않았다. 업체의 33ms 주장을 이 PC 측정값으로 사용하지 않았다.\n\n## 고정 비교와 탈락\n\n새 한국어 명령26건의 lane/외부 전송 금지 정답을 모델 실행 전에 고정했다. 기존24건과 문장을 복제하지 않았으며 별도 두 판정 질문은 정답을 전달하지 않았다. 각각3회 반복78추론했다. 작성자가 만든 합성 holdout이며 독립 전문가 의미평가26/260 인수는 아니다.\n\n| 경로 | lane 일치 | p50 분류 시간 | p95 분류 시간 | 판정 |\n|---|---:|---:|---:|---|\n| 수정 전 실제 JARVIS 분류기 |66/78|${comparison.baseline.p50Ms.toFixed(4)}ms|${comparison.baseline.p95Ms.toFixed(4)}ms|2종 보수적 오분류와2종 누락|\n| 실제 Laya CPU |45/78|${comparison.candidate.p50Ms.toFixed(2)}ms|${comparison.candidate.p95Ms.toFixed(2)}ms|채택 거절|\n| 수정 후 실제 JARVIS 분류기 |72/78|0.0150ms|0.0835ms|계정/설정 누락2종 수정|\n\nLaya의 명시적 외부 접근 금지 판정은69/78이다. 메일 읽기/발송, 구매, 워치/조명/앱 제어, shell, bulk file, 정정된 일정 등11종을 task로 잘못 내렸다. 사용량 truncated=false가 의미 보존을 뜻하지 않는다. 초기5건 프로브에서도 ‘오프라인으로 보고서 찾기’를 web으로 선택했다. 확률/모델 confidence는 권한/정확성 증거가 아니며 모델 출력은 실제 실행기로 보내지 않았다.\n\n로드는 비교에서 약${comparison.loadMs.toFixed(0)}ms였고 위 latency는 로드 이후 입력부터 답변까지다. 전체 Mission 도구 실행 시간은 미측정이다. 유료 API 호출0·요금0, 전기/하드웨어/총비용은 미측정이다. 초당 처리량이나 전체 업무 속도 향상으로 환산하지 않는다. 후보는 기존 결정형보다 느리고 요구 누락도 있어 승격 조건에 실패했다.\n\n## 제품 코드 수정과 실제 HTTP\n\n기존 분류기는 브랜드명이 없는 일반 캘린더 조회와 ‘앱 설정을 열어 알림을 끄기’를 빠른 task로 보냈다. 일정 조회/등록/변경/취소와 앱 설정 변경 표현을 Mission 감지에 추가했다. 등록할 초안·명시적인 등록 금지는 해당 추가 표현에서 제외하지만 실제 조회/후속 정정은 유지했다. 보수적 mission 판정인 운동 초안/번역된 취소 문장은 원문 의미 이해가 해결되지 않아 그대로 남겼다.\n\n첫14검사에서 등록할 초안이 잘못 승격된1건을 재현하고 수정했다. 첫 실패 로그와 최초 수정 비교69/78도 보존한다. 최종6파일88/88 fail0/skip0이다. 실제 Core HTTP /tasks에 두 누락 명령을 보내409/A_COMMAND_REQUIRES_MISSION와 /missions 안내, quick task 실행0을 확인했다. 이는 자연어 실제 일정/UI 작업의 완료 증거가 아니라 잘못된 빠른 실행 경로 진입 방지다. 기존24고정명령·13안전반례·실행 전략·계획 무결성/취소/usage 회귀도 통과했다. 최종 빌드/Core 계약 통과. 운영 프로세스/네이티브 설치본/계정 설정은 변경하지 않았다.\n\n## 인수 범위와 다음 실험\n\nV3-023은 진행 상태로 바꾸되 완료시키지 않는다. 실제 빠른 후보 비교를 시작했지만 전체 Mission 시간/비용·복합 요구의 전체 계약 보존과 실행 연결 비교는 남았다. V3-016도 일반 의미평가 완료가 아니다. 이 분류기 수정은 학습/권한 확대와 무관하다.\n\n후속은 현재 남은 코드 결함에 필요한 선택만 제한해 후보를 재설계하거나 결정형 경로를 개선하고, 고정 Core/E/B/G 업무의 전체 시간·효과·비용을 비교한다. 이번26건은 개발에 노출됐으므로 향후 독립 holdout으로 재사용하지 않는다. 후보를 다시 시험할 때 새로운 동결 사례를 사용한다. 원상 복원은 command-lane의 두 추가 탐지식과 새 회귀를 함께 검토하되 복원 시 캘린더/설정 quick-task 누락이 돌아오는 위험을 명시한다. 모델은 평가 전용으로 남기고 사용자 프로필·F/cognition 업무 기억에 합성 결과를 넣지 않았다.\n`);
const evidence=['report.md','source.json','comparison.json','baseline.json','optimized.json','optimized-r2.json','comparison.txt','focused.txt','final-r2.txt','final-build.txt','contract.txt'].map(s=>`${prefix}-${s}`);
evidence.push('artifacts/laya-checkpoint-20261007.json','artifacts/laya-local-20261007-probe.json','artifacts/laya-install-20261007-freeze.txt');
write('attempt.json',{id:'laya-routing-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'comparison',reportedOutcome:'failed',observedAt,evidencePaths:evidence,
 hypothesis:'공개 multilingual typed 선택기가 결정형 분류의 한국어 누락을 더 빠르고 정확하게 해결할 수 있다.',
 lesson:'실제78추론에서 lane45/78·금지69/78 및 p95약569ms로 기준선66/78·0.082ms보다 나빴다. 설치/확률/typed 형식은 의미 보존을 증명하지 않는다. 채택하지 않는다.',
 limitations:'합성26건·3반복, CPU/로컬 오프라인 추론 실제; 독립 전문가 의미평가/전체Mission 시간·총비용/Jev 실API/활성화 미검증.'});
write('repair-attempt.json',{id:'laya-routing-repair-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths:evidence,
 hypothesis:'현재 분류기의 일반 캘린더/앱 설정 누락은 권한을 바꾸지 않고 Mission 경로로 교정할 수 있다.',
 lesson:'최종88회귀와 실제CoreHTTP에서 quick task계획0/409를 확인했다. 동일고정명령72/78, 남은 보수적 오분류2종은 유지한다.',
 limitations:'HTTP진입경계/코드빌드이며 실제일정·앱제어 완료나 운영배포가 아니다. 전체100개중55완료 유지.'});
const path='docs/universal-control-v3-acceptance.json',document=JSON.parse(read(path)),gates=document.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,55);
for(const id of ['V3-016','V3-023']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');
 if(id==='V3-023')gate.status='in_progress';gate.evidence.push(...evidence);(gate.limitations??=[]).push('2026-10-07: 실제LayaCPU78추론/고정26 lane45/78·채택실패. 현재분류기66→72/78·CoreHTTP/88회귀. 전체Mission시간·총비용·독립의미/실API는미완료.');}
document.updatedAt=observedAt;writeFileSync(path,JSON.stringify(document,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제LayaCPU78추론·45/78로채택실패; 기존캘린더/설정분류누락수정66→72/78·실CoreHTTP/88회귀/build/contract. 공식55유지/V3-023진행. 다음 제한선택기 전체Core/E/B/G시간·비용 비교 또는 최신코드결함의 실행계약 완료.\n`);
console.log(JSON.stringify({observedAt,verified:55,comparison:'rejected',tests:88}));
