import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/comparison-bounds-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-v2.txt','utf8'),broad=await readFile('artifacts/forward-move-20261007-regression.txt','utf8');
if(!final.includes('ℹ pass 47')||!final.includes('ℹ fail 0')||!final.includes('ℹ skipped 0')||!broad.includes('ℹ pass 208')||!broad.includes('ℹ fail 0'))throw Error('Terminal execution evidence missing');
const paths=['packages/core/src/capabilities/comparative-capability-evaluator.js','packages/core/src/capabilities/persistent-evaluation-budget.js','apps/runtime-compose/src/create-runtime.js','tests/comparative-capability-evaluator.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 정확성·지연·비용을 함께 적용하는 개선 후보 비교

관측 ${observedAt}. 실제 비교기와 Core 구성·SQLite 영속 계약을 확장했다. 운영 서비스·설치 EXE의 신규 코드 활성화0, 외부 전송·유료 모델/호스팅 호출0. 실제 CPU/전력/개발 총비용은 미측정이며 0원이라고 주장하지 않는다.

## 구현과 검증

기존 비교기는 품질 증가와 사례별 회귀만 승격 후보 판단에 적용했다. maxP95Ms와 maxObservedCostMinor를 명시적으로 설정하면 반복 격리 평가의 후보 p95·총 관측 KRW 비용을 추가 검사한다. 품질이 좋아도 제한 초과는 failed, 비용 한도를 설정했는데 비용이 미측정이면 candidate-cost-unmeasured로 보류한다. 기준을 설정하지 않은 기존 비교의 의미와 저장 계약은 유지한다. 제품 자체 응답 속도나 배포된 에이전트 사용료 제한으로 혼동하지 않는다.

제한은 구성 시 검증·복제·고정하며 후보 input의 동명 속성이나 원래 객체 수정으로 바뀌지 않는다. Core의 capabilityPackageComparisonBounds 옵션에 연결했고 보호된 improvementPolicy에도 포함한다. 한도는 비교 영수증의 신원 해시에 결속하므로 복원에서 한도를 늘리거나 제거해 과거 결과를 현재 승인으로 사용할 수 없다. 양성 한도 내 품질 증가와 음성 지연/비용초과·미측정비용·잘못된 한도·후보 override·SQL 복원 대조를 함께 검사했다.

최종 비교·복원·영속 예산47/47, fail0/skip0. 실제 pinned Docker 정상 비교와 의도적인 0ms 음성 한도 비교도 포함한다. 0ms 사례는 품질 증가/회귀0여도 실제 p95>0이면 승격 후보가 되지 않는 반증이며 실제 제품 속도 목표를 뜻하지 않는다. 미측정 비용은 null로 유지한다. 개인 실제 자료는 사용하지 않고 원래 고정 오라클·권한·소진 예산·새PID 복구를 보존한다. 서명 없는 실사용 승격이나 실제 모델 학습을 수행하지 않았다.

변경 전 새6검사 모두 실패: 제한 미적용3, 신규 정상결과 설명필드 미지원1, 잘못된 구성 거부 미지원1, 제한을 넓혀도 같은 과거 영수증을 재사용1. 따라서 서로 독립된 제품 결함6개라고 세지 않는다. 첫 확대37개 중36통과/1실패는 복원이 이미 보류되지만 기대 원인 코드와 달랐던 경우다. 저장 신원 해시에 제한을 추가하고 동일 제한 복원/확대 제한 거부를 확인했다. 실제 수정 뒤47개는 추가 Docker/Core 양성·음성 및 영속 예산 회귀를 포함하며 중간검사를 중복 합산하지 않는다.

최종 build/Core contract gate 통과. 직전 작업의 살아 있던 session24850은 terminal exit0,208/208 성공,약831940ms로 종료했다. 이208개는 실행 도중 소스가 보강된 앞선 파일 이동 회귀이며 이번 새 비교기 전체 검증이나 마지막 파일 이동 소스의24검사를 대체하지 않는다. handle14746/53995도 terminal이며 새 회귀를 중복 시작하지 않는다.

## 연구와 인수 판단

research-radar 방식으로 공식 원본을 재확인했다. [Agent Lightning v1.0.1](https://github.com/microsoft/agent-lightning/releases/tag/v1.0.1)의 [pinned 개발 스킬](https://github.com/microsoft/agent-lightning/blob/8435586d147b4cf7bff33e687d7317149e79cbb8/skills/agent-lightning/SKILL.md)은 정확성 외에 지연·비용·회귀를 같은 계약에서 관측하는 개발 판단을 다룬다. 이번에는 그 평가 판단의 일부를 기존 비교기에 적용했다. Agent Lightning 패키지/훈련 서버/GPU RL·전체 cost_budget 계약·GEPA 대조·blind holdout을 실행한 것은 아니다. local pyproject는 v1.0.1/Python>=3.12를 기록하지만 이번 web raw 조회는 cache miss였으며 성공 조회로 보고하지 않는다.

[AlphaEvolve 공식 API](https://docs.cloud.google.com/gemini/enterprise/docs/alphaevolve/reference-guide/api-reference?hl=en)를 재조회했다. 실제 프로젝트 인증·예산·제한된 코드 자료·평가 worker·lock token 대사가 필요하다. 공개 API가 없는 것으로 처리하지 않지만 이번 실호출/코드 전송0이다. DreamerV3 등의 세계모델 학습·정책 활용도 실행하지 않았다. 따라서 V3-096은 Agent Lightning 개발 판단의 부분 실험을 기록한 진행 중으로만 바꾸며 전체 완료로 승격하지 않는다. V3-093은 기존 완료 상태의 보호 증거를 추가한다.

공식 인수60%는 유지하고 pending1을 in_progress로 이동한다. 총100개·각 요구는 보존한다. 문서·SHA·테스트 개수를 인수 완료율로 환산하지 않는다. 세 기술의 전체 대조/반증 실험·실계정·클라우드·실기기·30일 조건은 남는다.

## 복원과 다음 작업

복원은 비교기의 추가 한도 선택·Core 옵션·SQL 신원 결속을 함께 검토한다. 새 한도가 있는 영수증을 구계약으로 덧씌우거나 예산을 늘리지 않는다. 기존 무한도 영수증 계약과 owner review를 유지하며 이미 활성화한 후보는 없다. 다음은 V3-096의 실제 독립 실험 조건 확보, V3-080의 금융/개인 자료 전송·거래 활성화 범위와 기록, 그리고 계정·상시 배포·기기의 미충족 인수다.
`,{flag:'wx'});
const ledgerPath='docs/universal-control-v3-acceptance.json',ledger=JSON.parse((await readFile(ledgerPath,'utf8')).replace(/^\uFEFF/,''));
const gates=ledger.stages.flatMap(stage=>stage.gates),evidence=['-report.md','-source.json','-baseline.txt','-final.txt','-final-v2.txt','-docker-core.txt','-build-v2.txt','-contract-v2.txt'].map(s=>prefix+s);
for(const id of ['V3-093','V3-096']){
 const gate=gates.find(g=>g.id===id);if(!gate)throw Error('Original acceptance ID missing');
 gate.evidence=[...new Set([...(gate.evidence??[]),...evidence])];
 gate.limitations=[...(gate.limitations??[]),id==='V3-093'?'2026-10-08: 한도 구성 고정/Core 보호계약/SQLite identity/실제Docker 음성·47회귀. 한도는 반복 격리 평가 지연·KRW 비용이며 배포된 에이전트의 전 비용/시간 보장이 아님.':'2026-10-08: Agent Lightning 개발 판단의 품질·시간·비용 일부를 실제 비교기에 연결·대조/반증47검사. 전체 SDK/훈련/cost_budget·GEPA holdout·AlphaEvolve 인증 실험·세계모델 미실행. 전체096 완료 아님.'];
 if(id==='V3-096'&&gate.status==='pending')gate.status='in_progress';
}
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Original acceptance authority changed unexpectedly');
await writeFile(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'comparison-bounds-20261007',candidateId:'agent-lightning',kind:'comparison',reportedOutcome:'passed',observedAt,
hypothesis:'실행 계약과 고정 정답을 유지한 비교에 명시적 관측 지연/비용 한도와 복원 신원 결속을 적용하면 정확성만 좋아진 과도한 자원 후보 또는 미측정 후보를 자동 통과시키지 않는다.',
lesson:'품질 상승과 운영 한도 충족은 별도 관측이다. 미측정 비용은 0으로 대체하지 않고, 구성 변경 후 과거 판단을 재사용하지 않는다.',
limitations:'실제Docker/SQL/새PID와 합성 후보47검사. 원본 Agent Lightning 훈련/전체cost_budget·GEPA/AlphaEvolve·세계모델 실행 미완료. 실제 제품 지연/개발총비용 미측정. 공식60/운영활성화0.',evidencePaths:[...evidence,prefix+'-queue.txt']},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 비교 지연/비용 한도·unknown 보류·Core 보호계약·SQL identity 결속·47/47/build/contract. 앞선 session24850 terminal208/208. 공식60/21진행/19대기,096 부분 실험만 진행상태. 모든 handle 종료. 다음096 독립실험·080 목적/거래활성화·실계정/상시/기기 인수.\n`);
