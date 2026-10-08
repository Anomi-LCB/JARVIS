import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/archive-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`),review=json(`${prefix}-independent.json`);
assert.equal(runner.status,'passed');
for(const [key,count]of [['tests',82],['pass',82],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
assert.match(read(`${prefix}-independent-final.txt`),/ℹ fail 0/);
assert.equal(review.execution.pass,16);assert.equal(review.execution.fail,0);assert.equal(review.execution.skip,0);
for(const file of review.readPaths)assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'),file.sha256,`reviewed source changed: ${file.path}`);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
const sources=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'packages/core/src/mission/xlsx-cell-evidence.js','packages/core/src/orchestration/core-orchestration-worker.js',
 'apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/archive/create_zip.py','apps/verification/src/verification-runtime.js',
 'tests/fixtures/archive-effect-process-child.mjs','tests/mission-archive-effect-process.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:82,passed:82,failed:0,skipped:0,durationMs:runner.durationMs,independentReview:review,
  actualPythonZip:true,processKillBoundaries:['prepared','b-receipt','receipt-persisted','partial'],externalModelCalls:0,totalCost:null,
  productionScopedStatus:json(`${prefix}-runtime-scoped.json`).status,productionFullStatus:json(`${prefix}-runtime-status.json`).status,
  productionEffectActivated:false,originalAcceptanceVerified:60});
write('report.md',`# ZIP의 원래 실행 원장·현재 내용 검증·중단 후 복구 연결

관측 ${observedAt}. 최종82/82·0실패·0skip 및 build/Core 계약 통과. 원래100개 인수 완료60개 유지. Word·PowerPoint·HWP·이미지·메일 등 전체 쓰기 도구 연결이 아직 완료되지 않아 V3-040은 진행중이다.

## 실제 연결

기존 archive.createZip을 로컬 SQLite/trusted Mission 효과에 연결했다. 원래 operationId 기반 effectId·요청 해시·B 중복키·영속 완료 영수증을 유지한다. Core는 실제 출력경로와 원본 경로/entry 이름/해시를 artifactPlan에 보존한다. B의 비직렬화 private guard가 실행 전 같은 normalize 결과를 대조하고 원본과 ZIP 출력 모두의 기존 물리 파일 claim을 확보한다. mkdir·staging·Python·최종 발행 직전에 현재 Core/E/claim을 검사하며 취소 신호를 전달한다.

B 원래 packet의 완료 영수증은 즉시 기록하고 같은 영수증으로 source/output claim을 해제한다. Core 복구는 SQL 계약·원래 packet·영수증을 대조하고 현재 원본 해시와 ZIP 내부 entry 내용을 독립 JavaScript ZIP 파서로 재확인한다. Python worker의 성공 응답이나 CRC만으로 완료하지 않는다. G도 현재 ZIP·원본을 재조회해 원래 입력 계약/출력 hash에 맞는지 검사한다. 공유 bounded ZIP 파서는 기존 OOXML 검증기를 재사용하며 추출·네트워크·코드 실행은 하지 않는다. 초기 통합에서 collector가 shadow archiveInputs를 생략해 G가 정상 출력을 보류하던 문제를 수정했고, 안전조건을 약화시키지 않았다.

## 실제 실행 증거

격리된 합성 입력으로 실제 Python ZIP 생성과 실제 OS SIGKILL을 prepared·B receipt·SQL receipt·최종 ZIP 발행 후 영수증 이전4경계에 적용했다. 정상 복구는 같은effect/operation/key/receipt를 유지하고 완료 adapter 반환1회·최종 claim0을 확인했다. 호출 시작이 모든 경계에서1회라는 뜻은 아니다. 영수증 없는 ZIP과 변경된 ZIP/원본은 PAUSED/uncertain으로 남고 중복 생성하지 않았다. Core authority 활성 조건에서도 실제 완료했다.

최종82에는 기존 ZIP·PNG/OCR·합성 SMTP·Excel/PDF SQL 복구·실제 Excel COM 출력·XLSX 내용 fingerprint·Core authority/능력 준비도 회귀가 포함된다. 독립 검토 수치는82에 더하지 않으며 별도 independent 문서/JSON에 남겼다. 모든 자연어 의미나 모든 계정/기기에서 성공한다는 증거가 아니다.

## 운영 및 남은 범위

기존 supervisor41748/Core29988/PC30096은 실제 생존 중이며 Core4071·PC17776·UI41730 connections-only 상태는 ready다. 전체 runtime 검사에서는 기존 Mobile Bridge가 HTTP200이지만 executionAuthorityMode·deviceTokenKeyId·growthReviewAuthorizationKeyId 신원 불일치로 degraded다. 다른 소유 프로세스나 인증정보를 바꾸지 않았으며 이 상태를 정상 모바일 연결로 계산하지 않는다. 이번 effect 변경은 운영 서비스 재시작이나 설치 EXE로 활성화하지 않았다.

실계정/외부 발송/유료 모델 호출0, 전체 로컬비용은 미측정이다. ${runner.durationMs}ms는 테스트 실행시간이고 제품 p50/p95가 아니다. 임시 자료·격리 SQLite와 명시 시험 시계를 사용했다. 악의적인 부모 디렉터리 교체/다른 프로세스의 staging 변조/네트워크 파일시스템·입력 영구불변·사용자 전체 자연어 요구 품질·장기 운영·다른 PC는 미검증이다. 실제 사용자 원장과 F/cognition을 초기화하지 않았다.

다음은 남은 등록 문서 작성 도구의 전체 출력 manifest를 원래 artifactPlan에 묶고 미완료 계정·모바일·상시노드 인수도 원래 범위로 진행하는 것이다. 복원 시 이번 archive 지원/collector/G ZIP 검사/private hook 및 관련 source snapshot을 비교해 좁게 복원하며 기존 SQL/B 영수증과 사용자 기억을 삭제하지 않는다. uncertain ZIP을 새 operation으로 바꿔 덮어쓰지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','build.txt','contract.txt',
 'process.txt','process-runner.json','independent.md','independent.json','independent-final.txt','independent.test.mjs','runtime-scoped.json','runtime-status.json'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'archive-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원본·ZIP entry 계약을 원래 SQL효과/private guard/B claim/독립 현재 내용 검증에 묶으면 재시작 후 허위 완료나 중복 압축 없이 원래 영수증을 복구할 수 있다.',
 lesson:'출력 hash만으로 최초 입력 내용을 증명하지 못한다. 입력 계약과 실제 압축 내부 내용을 별도로 비교하고 성공 receipt 없는 출력은 불명 상태로 보존해야 한다.',
 limitations:'82/82+별도독립반증/build/contract·actualPython SIGKILL4경계. 다른쓰기/운영활성화/OShostile경합/실계정/장기 운영 미완료. 공식60·fullruntime bridge identity mismatch·비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('archive SQL effect/원본·출력 artifactPlan·private guard·B claim·독립G ZIPmember·actualPython SIGKILL4경계·82/82. 전체등록쓰기/원격/운영활성화/hostile filesystem은 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: ZIP SQL effect/source+output/hash/privateguard/Bclaim/G현재ZIP내용·actualPython SIGKILL4경계/82회귀·독립반증·build/contract. 공식60·운영effect활성화0·connections-only ready/full bridge identity mismatch보존. 다음 문서 등 남은 전체쓰기 manifest/원래나머지인수.\n`);
console.log(JSON.stringify({observedAt,tests:82,verified:60,attempt:`${prefix}-attempt.json`}));
