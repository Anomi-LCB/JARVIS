import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/source-fast-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,data)=>writeFileSync(`${prefix}-${suffix}`,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString(),pilot=JSON.parse(read(`${prefix}-pilot/comparison.json`)),authority=JSON.parse(read(`${prefix}-authority/comparison.json`));
assert.equal(pilot.rows.length,15);assert.equal(pilot.paired.length,2);assert.equal(authority.rows.length,2);
assert.ok(pilot.rows.every(r=>r.report.status==='COMPLETED'&&r.report.outputMatchesIndependentOracle&&r.report.model.providerCalls===0));
assert.ok(authority.rows.every(r=>r.status==='WAITING_APPROVAL'&&r.output===null&&r.model.providerCalls===0));
for(const [key,value] of [['tests',112],['pass',112],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/mission/source-question-binding.js','packages/core/src/mission/local-source-summary.js','apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js',
 'scripts/local-summary-mission-pilot.mjs','scripts/source-fast-comparison-20261007.mjs','scripts/source-fast-authority-20261007.mjs','tests/source-declaration-fast-path.test.js',
 'artifacts/agent-lightning-20261007-SKILL.md'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)})),pilot,authority});
const times=pilot.rows.map(r=>r.report.totalMs).sort((a,b)=>a-b),p50=times[Math.ceil(times.length*.5)-1],p95=times[Math.ceil(times.length*.95)-1];
write('report.md',`# 명시적 원문 선택 경로의 실제 업무 비교\n\n관측 ${observedAt}.\n\n## 결과\n\n모든 질문이 검토된 대상과 단일 원문 선언에 대응할 때만 모델 대신 결정형 읽기를 선택했다. 입력/출력 인터페이스와 Core/E/B/G, 원문 오라클·권한을 유지했다. PC workflow의 text.extractFields에서 활성화하며 일반 질문은 기존 경로다. 설치본/운영서비스 배포는 수행하지 않았다.\n\n고정5사례를3회 반복한 실제 파일 발견→읽기→선택·요약→저장→재발견→재읽기 Mission15/15 완료, 허위 완료0, 모델 호출0. 전체시간 p50 ${p50.toFixed(2)}ms /p95 ${p95.toFixed(2)}ms. 입력 표시속도나 전체 서비스 p95 목표로 환산하지 않는다. 정답은 후보에 전달하지 않고 최종 G 오라클에만 전달했다.\n\n같은 CPU3thread Gemma 경로의 직전 실제 H1/H3 결과와 같은 사례를 대조했다. H1 모델 경로62.48초/차단/HTTP4회에서 결정형3회0.407·0.454·0.441초/완료/호출0. H3 모델 경로25.36초/완료/HTTP4회에서 결정형3회0.403·0.400·0.437초/완료/호출0. HTTP4회는 tags+generate 두 번이며 모델 추론4회가 아니다. H1에 초기 로드가 포함되어 순수 알고리즘 속도비로 해석하지 않는다. 모델 기준선각1회·후보각3회, 이미 개발 노출된 고정 자료이므로 일반 품질·확률적 우열·전문가 holdout 증거가 아니다.\n\n실제 read-only 위임2사례는 같은 정답을 생성했어도 쓰기 전 WAITING_APPROVAL, 파일0·모델0을 확인했다. 선택기는 권한을 주지 않는다. 허용된 실행에서는 기존 위임 내 질문·승인0이다. 미승인 쓰기는 승인 필요 상태로 남으며 검증 성공으로 계산하지 않는다.\n\n비용: 양쪽 유료 API 호출0/청구0, 후보 모델 호출0·usage없음. 전기/장비/개발 총비용은 미측정이며0으로 쓰지 않았다. 초기 설치 비용과 매 업무 비용을 분리했다. 범위 내 필수 출력 키/형식/값/원문 근거는 동일 고정 오라클로 보존했고 금지/실행권한은 원래 정책에서 확인한다.\n\n## 결함과 검사\n\n첫112검사 중5실패는 이전 질문 가드가 명시적 필드 계약의 정상 자연어 표현까지 재해석해 막은4건과 시험 어댑터 상태 초기화1건이었다. 명시적 필드 계약은 검토된 label/kind/unit·정정/주장 출처를 기존 파서로 검증하고, 자동 질문 연결과 별도로 대조하도록 수정했다. 정답·실행 계약을 바꾸지 않았다. 최종112/112 fail0/skip0, 실제 기본 자연어 다중 필드 Mission 포함. 빌드·Core 계약 통과.\n\n## 연구 경로와 조건\n\n[Agent Lightning 공식 스킬](https://github.com/microsoft/agent-lightning/blob/8435586d147b4cf7bff33e687d7317149e79cbb8/skills/agent-lightning/SKILL.md)의 입력/도구/선택·수정·불변 평가 원칙을 참고했다. pinned 파일과 SHA를 보존했다. 개발 cost_budget.json은 준비되지 않아 공식 비용 장부 통합 완료로 계산하지 않는다. 스킬을 참고한 이번 로컬 비교와 GPU RL Trainer 설치·학습은 다르다. [공식 RL 구현](https://github.com/microsoft/agent-lightning)은 CUDA/verl 훈련 스택을 안내한다. 현재 CPU 평가로 정책 가중치 학습을 주장하지 않는다.\n\n[AlphaEvolve 공식 실습](https://codelabs.developers.google.com/alphaevolve-on-google-cloud-1)은 결제 프로젝트/ADC/Enterprise app과 실제 후보 생성 API가 필요하다. 이 단계는 준비 전이며 API를 호출하지 않았다. 고정 평가기·격리된 후보 실행·예산·잘못된 후보 반증을 별도 실험으로 준비해야 한다. [Genie3 공식 세계모델](https://deepmind.google/models/genie/)은 생성 세계와 실제 현실/문자·상호작용의 제한을 구분한다. 이번 파일 선언 파서는 영상 세계모델 실험이 아니다. 장면·행동·예측 상태와 실제 관측의 대조, 장기 불일치 반증, 사용 가능한 API/기기가 준비되어야 한다. 따라서 V3-096을 완료하지 않는다.\n\n## 인수 감사\n\nV3-023 원래 요구는 ‘Jev 등 빠른 선택기가 요구 보존·전체 시간·비용을 개선하는지 비교하고 권한 판정과 분리한다’이다. 기존 실제Laya78추론 실패 비교에 더해 이번 결정형 선택의 동일 요구·전체Mission시간·호출·비용 미측정과 실제 권한 분리를 비교했으므로 **비교 수행**을 완료한다. Jev 실 API 성공/모든 요구의 자동 해석/일반 자율성/전체 비용 개선의 인수가 아니다. V3-059는 일반 파일·문서 의미/범위가 남아 진행 유지. 원래100개 항목은 바꾸지 않으며 공식57/100이 된다.\n\n복원은 PC workflow의 preferSourceDeclarations 선택만 우선 끌 수 있다. 질문 가드/명시적 계약 구분은 유지해야 정상 작업을 막거나 오답 저장을 되돌리지 않는다. 사용자 프로필·F/cognition 실제 업무 기억은 보존했다.\n`);
const evidence=['report.md','source.json','first.txt','regression.txt','final.txt','build.txt','contract.txt','pilot/comparison.json','authority/comparison.json','pilot.txt','authority.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'source-fast-20261007',candidateId:'agent-lightning',kind:'comparison',reportedOutcome:'passed',observedAt,evidencePaths:evidence,
 hypothesis:'검토된 명시적 원문 요구는 추측 모델 대신 결정형 도구로 선택하면 필수 요구를 보존하며 전체 Mission 시간을 줄이고 모델 호출을 피할 수 있다.',
 lesson:'실제15Mission15완료/모델0·동일H1/H3 실제모델 기준선과 대조·미위임2쓰기0. 112회귀/build/contract. 개발용 스킬 원칙 참고이며 GPU RL/AlphaEvolve/영상 세계모델 수행은 아님.',
 limitations:'개발에 노출된5명시적 사례·모델기준선2회·후보15회·초기로드 차이. 총비용 미측정/Jev미호출/일반 의미와 공식cost_budget 통합 미완료. 선택 비교 인수만 완료.'});
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse(read(path)),gates=doc.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,56);
const gate=gates.find(g=>g.id==='V3-023');assert.equal(gate.requirement,'Jev 등 빠른 선택기가 요구 보존·전체 시간·비용을 개선하는지 비교하고 권한 판정과 분리한다.');
assert.equal(gate.status,'in_progress');gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidence);
const limits=['2026-10-07: 기존Laya78실추론 실패+결정형선택 동일H1/H3 실제Core/E/B/G시간/요구/호출/비용대조·권한독립2·112회귀. 비교 수행 완료이며 Jev실API/일반정확도/총비용·GPU학습·제품설치본은 미검증.'];
gate.limitations.push(...limits);(gate.reviewHistory??=[]).push({status:'verified',reviewedAt:observedAt,evidence,limitations:limits});
const fileGate=gates.find(g=>g.id==='V3-059');fileGate.evidence.push(...evidence);
doc.updatedAt=observedAt;writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 결정형 원문 선택 실제15/15·모델0·전체시간/요구/비용대조·읽기위임2쓰기0·112회귀/build/contract. V3-023 비교 인수 verified→공식57. V3-059 일반 문서/의미·V3-096 별도기술실험은 남음.\n`);
console.log(JSON.stringify({observedAt,verified:57,tests:112,p50Ms:p50,p95Ms:p95}));
