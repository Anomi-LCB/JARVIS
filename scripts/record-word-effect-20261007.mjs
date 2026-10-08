import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/word-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`),review=json(`${prefix}-independent.json`);
assert.equal(runner.status,'passed');
const count=key=>Number(log.match(new RegExp(`ℹ ${key} (\\d+)(?:\\r?\\n|$)`))?.[1]);
assert.equal(count('fail'),0);assert.equal(count('skipped'),0);assert.equal(count('tests'),count('pass'));assert.ok(count('pass')>=50);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
assert.equal(review.independentExecution.fail,0);assert.equal(review.independentExecution.skip,0);assert.ok(review.independentExecution.pass>=9);
for(const file of review.readPaths)assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'),file.sha256,`reviewed source changed: ${file.path}`);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
const sources=['apps/pc-agent/src/pc-agent-runtime.js','packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js','packages/core/src/planning/mission-action-arguments.js','packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js','tests/fixtures/word-effect-process-child.mjs','tests/mission-word-effect-process.test.js','tests/word-publication-manifest.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:count('tests'),passed:count('pass'),failed:0,skipped:0,nativeExcelIncluded:true,durationMs:runner.durationMs,actualNativeWordProcessCases:8,independentReview:review,externalModelCalls:0,totalCost:null,productionActivated:false,originalAcceptanceVerified:60});
write('report.md',`# Word의 완전한 산출물 계약·영속 효과·중단 후 복구 연결

관측 ${observedAt}. 최종 ${count('tests')}건 중 ${count('pass')}통과·실패0·skip0. 실제 Excel COM 양성도 최종회귀에 명시 활성하여 포함했다. 별도 독립 검토 ${review.independentExecution.pass}건은 합성 native/table/render 응답을 사용하며 회귀 수에 더하지 않는다. 빌드/Core 계약 통과. 원래 인수60/100 유지.

## 구현

Word의 명시적 출력경로·정규화된 문서·문서와 보조 PDF/DOCX 및 native-report3파일을 실행 전에 하나의 준비 계약으로 고정한다. 보조 폴더는 출력경로/문서 해시로 결정하며 이미 있으면 덮어쓰지 않는다. 실행시 같은 계약을 private guard에서 재확인하고 모든 파일의 기존 물리 claim을 확보한다. Core/E 현재권위·취소·claim 검사는 native/staging/발행 경계까지 유지한다.

word.create를 로컬 공통 SQL effect에 연결하고 원래 operation/effect ID·요청 해시·packet 중복키로 영속 B 완료영수증을 즉시 기록한다. 같은 영수증으로 파일 claim을 해제한다. 복구는 SQL 원래 문서/manifest와 receipt를 대조하고 모든 파일을 다시 읽어 해시를 확인하며 G의 현재 OOXML/표/PDF 내용 검사까지 통과해야 완료한다. 복구 G에는 이미 원래 roots/해시/현재물리경로 검사를 통과한 읽기 범위만 전달한다. 새 실행token/권한을 발급하지 않으며 HWP/PPT 검증 범위를 바꾸지 않는다.

## 실제 실행과 실패 수정

격리 SQLite와 합성 문서로 실제 Word COM 작성 후 실제 OS SIGKILL을 prepared·B receipt·SQL receipt·최종발행 후 undo/receipt 이전4경계에 적용했다. 정상은 같은 operation/key/영수증을 유지하고 완료 adapter 반환1회·최종claim0을 확인한다. 부분발행과 문서/PDF 미리보기 변경은 PAUSED/uncertain·재실행0이다. 별도 실제 Core권위 활성 DOCX/PDF 출력도 SQLmanifest의 형식과 최종path를 검사했다. 이 결과는 모든 자연어 요구나 모든 앱의 검증이 아니다.

최초11건은9통과2실패였다. 정상receipt복구시 G가 읽기범위를 받지 못하던 문제를 수정했다. 독립 PDF 반례에서는 기존 경로resolver가 .pdf를 .docx로 바꾸고 planner sanitizer가 outputFormat을 삭제했다. Word에 한정해 명시적 확장자를 보존하고 해당 필드를 전달하며 모순된 형식을 차단했다. 형식·전체manifest·기존보조폴더보존·범위이탈 반례를 추가했다. 변경도중 실행된 초기 회귀 로그와 잘못된 블록에 형식충돌 검사를 삽입해 발생한2실패도 보존한다. 삽입 위치를 Word.preparePublication으로 수정하고 HWP 기존 publication 회귀를 함께 재검증했다. 최종적으로 최종 증거는 소스동결 뒤 새 조정기로 다시 실행한 결과다.

ZIP/PDF SQL복구·기존 실제 native부모/host종료와 취소·현재 Office rendering·표좌표·Core authority/능력 준비도 회귀를 포함한다. PDF SQL복구 일부는 합성 renderer이며 실제 native Excel 포함1건과 구분한다. 테스트시간 ${runner.durationMs}ms는 제품p50/p95가 아니다. 비용미측정·외부LLM/발송/거래0.

## 운영·한계·다음 작업

Core4071/PC17776/UI41730의 connections-only 상태는 현재 ready다. 설치 EXE/운영 프로세스 재시작으로 이번 새효과를 활성화하지 않았으며 기존MobileBridge 신원불일치를 해결했다고 주장하지 않는다. 사용자 원장·F/cognition을 초기화하지 않았다.

Word는 로컬 단일행동 효과에 연결됐다. 원격Word·악의적OS경로교체/네트워크파일시스템·모든쓰기·모바일/계정/상시클라우드/장기실사용은 남았다. V3-040은 전체 쓰기 계약 인수이므로 부분 증거만 추가한다. 다음은 남은 PowerPoint/HWP/이미지 문서작업과 원래 나머지 인수를 이어 검증하는 것이다. 복원은 source snapshot의 Word지원/완전manifest/privateguard/회수검사/읽기범위전달만 좁게 비교하고 영수증·실제문서·사용자 기억을 삭제하지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','build.txt','contract.txt','independent.md','independent.json','independent-final.txt','independent.test.mjs','focused.txt','initial-regression.txt','format-conflict-failure.txt','runtime-scoped.json'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'word-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'원래 문서와 전체3산출물 계약을 SQL효과/privateguard/Bclaim/G에 연결하면 프로세스중단 뒤 완료증거를 대사하고 부분/변조출력을 재생성하지 않을 수 있다.',lesson:'요청한 파일확장자와 outputFormat을 경로resolver/sanitizer가 바꾸면 정상native실행도 사용자요구를 위반한다. 전체산출물과 형식은 실행전 계약에 고정해야 한다.',limitations:'실제WordSIGKILL4경계/양성DOCX+PDF, 별도합성독립검토. 전체쓰기/원격Word/운영활성화/실계정/장기관측미완료; 공식60/100·비용미측정.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('Word 완전한3파일 계약/로컬SQLeffect/privateguard/Bclaim/현재G/actualWordSIGKILL4경계+PDF형식반례 수정. 원격·다른전체쓰기·운영활성화는 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: Word3산출물/원래문서 SQL계약·privateguard/Bclaim/영속receipt/G현재내용·actualWordSIGKILL4경계+DOCX/PDF양성·PDF필드소실수정·독립반증/build/contract. 공식60/100·운영활성화0. 다음 남은문서/이미지쓰기와 원래나머지인수.\n`);
console.log(JSON.stringify({observedAt,tests:count('tests'),passed:count('pass'),skipped:0,verified:60,attempt:`${prefix}-attempt.json`}));
