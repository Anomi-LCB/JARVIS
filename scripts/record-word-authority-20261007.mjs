import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/word-authority-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-serial-runner.json`),log=read(`${prefix}-final-serial.txt`),review=json(`${prefix}-independent.json`);
assert.equal(runner.status,'passed');
for(const [key,count]of [['tests',52],['pass',52],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
assert.equal(review.tests.latestPass,7);assert.equal(review.tests.latestFail,0);assert.equal(review.tests.skip,0);
for(const file of review.sourceHashes)assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'),file.sha256,`reviewed source changed: ${file.path}`);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
const sources=['apps/pc-agent/src/pc-agent-runtime.js','packages/core/src/orchestration/core-orchestration-worker.js','scripts/run-tests.mjs','tests/test-runner-arguments.test.js','tests/word-authority-boundary.test.js','tests/word-native-process-guard.test.js','tests/fixtures/word-native-parent.mjs','tests/pc-document-safety.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:52,passed:52,failed:0,skipped:0,durationMs:runner.durationMs,actualNativeWordBoundaryTests:4,actualNativeProcessGuardTests:3,independentSyntheticTests:7,independentReview:review,externalModelCalls:0,totalCost:null,productionActivated:false,originalAcceptanceVerified:60});
write('report.md',`# Word 권한·취소·부분 산출물 보존 및 시험 실행기 수정

관측 ${observedAt}. 최종 회귀52/52·실패0·skip0, 빌드와 Core 계약 통과. 별도 독립 반증7/7은 합성 native/table 응답을 사용하며52에 더하지 않는다. 공식 인수60/100 유지.

## 수정한 실제 결함

최초 실제 Word COM 시험3건에서 권한 철회와 이미 취소된 요청을 무시하고 문서를 생성하는 결함을 재현했다(0통과/3실패). Word adapter가 실행 context를 받고 B에서 같은 AbortSignal을 전달하도록 연결했다. Core의 현재 권위 fence를 Word에도 적용하고 staging·native 호출·최종 발행·검증·undo 기록 전에 재확인한다. 생성 도중 취소는 기존 소유 native 프로세스 정리 경로로 전달한다.

발행 뒤 검증/undo 기록 실패가 예외로 빠지거나 실제 생성된 파일을0개로 표시하던 독립 반증2건도 수정했다. 실패 시 소유한 산출물 경로와 uncertain 상태를 보존하며 성공으로 표시하지 않는다. 기존 사용자 document.docx.err 파일을 삭제하던 코드를 제거했다.

## 실제 실행과 독립 검사

실제 Word4건은 초기 철회·초기 취소·정상 작성과 재열기 및 이웃 err 파일 보존·소유 native 실행 중 취소를 검사했다. 기존 실제 native guard3건은 부모 강제 종료·native host 종료·취소에서 기존 다른 Word 프로세스를 보존하는 경로를 검사한다. 독립7건은 발행 전/부분 발행 뒤 철회, 최종 table/undo 실패와 실제 SQLite 권위 철회 및 B의 동일 signal 전달을 검사했다. 독립 검토의 native timeout 원인 미확인 메모 이후 아래 실행기 원인을 별도로 확인했으며 독립 검토 자체를 실제 COM 검증으로 확대하지 않는다.

## 실패 이력과 시험 실행기

초기 병렬 실행의 Word 소유권 대기 실패를 보존했다. 실행기가 Node 옵션을 시험 파일 뒤에 배치해 --test-concurrency=1이 실제 조정기에 적용되지 않았다. 임시 실제 시험2개의 begin/end 관측으로 옵션 앞/뒤의 병렬·직렬 차이를 확인한 뒤 옵션을 파일 앞에 배치했다. 중첩 실행에서 상속된 NODE_TEST_CONTEXT 때문에 선택 시험0건을 실행하는 결함도 수정했다. 새 행동 검사는 실제 별도 조정기의 직렬 순서와 이름 필터를 검사하며 제외 시험이 실행되면 실패한다. 오래된 HWP static assertion은 현재 사용하지 않는 덮어쓰기 코드만 요구하므로 제거했고 실제 no-overwrite publication 검사는 유지했다.

baseline·focused·final·serial-initial·guard-diagnostic·runner-before/after 및 독립 prepatch 로그를 삭제하지 않았다. 최종52/52는 옵션이 실제 적용된 직렬 실행이다. ${runner.durationMs}ms는 시험 소요시간이며 제품 p50/p95가 아니다. 로컬 비용 미측정, 외부 호출·발송·거래0.

## 남은 범위와 복원

Word의 공통 SQL effect/완전한 artifact manifest·공유 물리 claim·영속 receipt·재시작 복구는 이번에 구현했다고 주장하지 않는다. 다른 앱·실계정·상시 클라우드·설치 EXE·30일 실사용 및 악의적 파일시스템 경합도 미검증이다. 운영 서비스 재시작/설치본 활성화 없이 소스와 격리 시험만 변경했다. 사용자 원장과 F/cognition은 초기화하지 않았다.

다음 작업은 Word의 모든 산출물 계약을 기존 효과 원장에 연결하고 중단 후 독립 대사를 검사하는 것이다. 복원은 source snapshot과 비교해 Word context/fence·uncertain 처리·시험 실행기 변경만 좁게 검토하며 실제 사용자 문서·영수증·기억을 삭제하지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','final-serial.txt','final-serial-runner.json','build.txt','contract.txt','independent.md','independent.json','independent-final.txt','baseline.txt','serial-initial.txt','runner-before.txt','runner-after.txt','independent-prepatch.txt'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'word-authority-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'현재 권위와 취소를 native Word 발행 경계까지 전달하고 생성 후 실패의 실제 파일을 보존하면 철회 무시와 허위 산출물0 표시를 막을 수 있다.',lesson:'native 시험 동시성은 명령의 의도 아닌 실제 coordinator 옵션 적용으로 확인해야 한다. 파일이 생성된 뒤 검증 실패는 불명 산출물 증거를 보존해야 한다.',limitations:'실제Word/프로세스검사 포함52/52 및 별도합성독립7. WordSQL effect/manifest/재시작·운영활성화·실계정·장기관측 미완료. 공식60/100·비용미측정.'});
for(const id of ['V3-041','V3-065']){const gate=gates.find(g=>g.id===id);assert.notEqual(gate.status,'verified');gate.evidence.push(...evidencePaths);gate.limitations.push('Word 권위/취소/부분산출물 반증 및 실제 native 포함52/52; 공통 SQL effect/manifest/재시작·전체 앱·운영 활성화는 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: Word 현재권위/취소·부분발행 uncertain/이웃err보존, 실제native 포함52/52·독립합성7/7·시험실행기옵션/중첩context 수정·build/contract. 공식60/100·운영활성화0. 다음 Word 완전한 출력manifest/SQL effect/중단복구 및 원래 나머지 인수.\n`);
console.log(JSON.stringify({observedAt,tests:52,verified:60,attempt:`${prefix}-attempt.json`}));
