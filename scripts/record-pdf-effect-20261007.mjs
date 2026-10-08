import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/pdf-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,v)=>writeFileSync(`${prefix}-${name}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`),review=json(`${prefix}-independent.json`);
assert.equal(runner.status,'passed');for(const [key,count]of [['tests',54],['pass',54],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(log,/nativeExcel":true,"sqlEffect":"mission_effect:mission_op_/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
const sources=['packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'apps/pc-agent/src/pc-agent-runtime.js','tests/fixtures/pdf-effect-process-child.mjs','tests/mission-pdf-effect-process.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,tests:54,passed:54,failed:0,skipped:0,durationMs:runner.durationMs,
 nativeSqlEffectObserved:true,nativeSourcePreserved:true,syntheticProcessKillBoundaries:['prepared','b-receipt','receipt-persisted','partial'],
 syntheticFailureCases:['pdf-changed','source-changed'],independentReview:review,
 externalModelCalls:0,totalLocalCost:null,productionRuntime:json(`${prefix}-runtime-status.json`).status,productionEffectActivated:false,originalAcceptanceVerified:60});
write('report.md',`# 기존 Excel→PDF 공통 SQL 효과·영수증·재시작 복구

관측 ${observedAt}. 최종54/54·0실패·0skip 및 build/Core 계약 통과. 원래100개 인수 완료60개 유지. 다른 쓰기 도구 전체가 아직 같은 계약으로 연결되지 않아 V3-040을 진행중으로 둔다.

## 구현한 범위

로컬 SQLite/trusted 실행의 excel.exportPdf에 원래 operationId 기반 effectId·요청 해시·동일 B key·영속 완료 receipt를 연결했다. Core가 원본 XLSX의 bounded snapshot에서 sourceSha256을 기록하고 원본/목적지 둘을 artifactPlan에 결속한다. B는 실제 원본 재조회/active content 사전 검사 이후 private 계약을 대조하고 두 경로의 기존 물리 파일 claim을 얻는다. mkdir/native 실행/출력 직전 현재 E/Core/claim fence를 검사한다.

완료 receipt는 즉시 저장한다. 재시작 대사는 원래 packet/task/fingerprint를 유지하고 PDF 출력1개와 원본 XLSX claim 모두를 검사해 완료된 claim을 해제한다. Core 복구는 SQL이 가진 원본/출력 경로와 receipt를 대조하고 실제 원본 hash를 다시 읽는다. 원본 또는 PDF가 변하면 G/F 성공 이전에 보류한다. serialized JSON은 private assertArtifactPlan 메서드를 만들 수 없다. 예전 exportPdf 단순 성공 응답을 원래 SQL 계약의 대체로 세지 않는다.

## 실제 실행 증거

실제 OS SIGKILL은 synthetic renderer를 사용하는 prepared·Breceipt·SQLreceipt·PDF파일 저장후receipt이전4경계다. 정상 재개는 동일effect/operation/key/receipt를 유지하며 완료adapter반환1건·Bclaim0이다. 시작된 adapter호출이 전부1이라는 뜻이 아니다. 파일은 있지만 성공 영수증이 없거나 PDF/원본이 변경된 경우는 PAUSED/uncertain이며 중복 출력하지 않는다.

별도로 실제 Microsoft Excel COM16.0/build4266이 원본을 보존해 PDF를 출력한 SQLite Mission을 관측했다. 실제 Core/E/B/G/F와 효과 원장까지 완료됐고 새 런타임에서 같은 영수증을 재조회·원본 hash 대사·claim0·추가 adapter반환0을 확인했다. native 출력 중 강제 종료4경계 실증이라고 확대하지 않는다. 기존 XLSX생성·actual PDF·Coreauthority·capabilityavailability 회귀도 최종54에 포함된다.

독립 검토는 snapshot 뒤 원본변경·다른source/output receipt·원본과receipt hash 동시변조·중복output·privateguard제거·원본/PDF claim2개·완료claim정리를 별도 검사했다. 다른 작업과의 동일 원본 동시경합 전체를 이번 시험으로 입증하지 않는다. 초기 독립 실패 중 직접 연 SQLite handle 미종료로 생긴 teardown EBUSY는 제품 결함과 분리하고 test handle close로 정정했다. 독립 수치를54에 합산하지 않는다.

실제native renderer가 사용되지 않는 fixture는 테스트에서 native형 receipt를 합성하므로 PDF 원문 동등성/COM실행 자체 증거로 계산하지 않는다. 네이티브 실행 증거는 별도 native 관측만 사용한다. PDF 시각 품질은 visualQualityVerified=false다. 전체 ${runner.durationMs}ms는 검증 실행시간이며 제품p50/p95가 아니다. 외부모델0, 전체로컬비용 미측정(null), 시험개입0이며 개인계정/외부발송은 없음.

## 미완료와 다음 작업

운영 서비스는 ready다. 이번 검증은 임시자료/격리SQLite/프로세스/일부명시시계 조건이며 운영 소스서비스·설치EXE에 이번 effect 변경을 재시작해 활성화하지 않았다. 원격PDF·다른PC·서비스계정·가격예산·모든Office/PDF내용·장기실사용은 별도다. 현재 등록 word.create·hwp.create·powerpoint.create·document.edit·visual.createCards·archive.createZip·email.send 등 전체 효과 연결이 남아 있다.

다음은 등록 로컬 문서 작성 경로의 실제 공통effect 누락을 연결하고, 미완료 자연어·실계정·기기 인수를 원래 범위로 진행하는 것이다. 등록도구 범위를 Excel로 줄여100% 선언하지 않는다.

복원은 exportPdf supported/artifactPlan/private hook/immediate receipt·source 복구 결속 부분을 이전 source와 비교해 제거하되 SQL/B 영수증과 실제 사용자F/cognition을 삭제하지 않는다. uncertain 출력은 공급자대사 없이 덮어쓰거나 새 operation으로 바꾸지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','build.txt','contract.txt',
 'process.txt','process-runner.json','native.txt','native-runner.json','independent.json','independent-final.txt',
 'independent-claims.txt','independent.test.mjs'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'pdf-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원본 XLSX와 PDF 경로/해시를 SQL효과 및B물리claim에 결속하면 원본 변경과 영수증없는출력은 중복생성 없이 보류하고 원래 완료 영수증을 복구한다.',
 lesson:'읽기원본도 외부출력 계약 및자원claim의 일부다. 성공PDF만의claim으로는 다른작업 원본쓰기와원래source receipt를 대사할 수 없다.',
 limitations:'54/54·실제native SQL1양성/재조회·syntheticSIGKILL4경계·운영ready이나이번effect활성화0. 다른등록쓰기/원격/시각품질/전체100인수 미완료·공식60/비용null.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 exportPdf SQLcommon effect·source/output/hash/privateguard·양쪽Bclaim·syntheticSIGKILL4경계·actualExcelSQL재조회·54/54/build/contract·독립반증. 다른등록쓰기/원격/운영활성화 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 기존XLSX PDF common SQL effect/source/hash/출력/양쪽claim·SIGKILL4synthetic/actualExcelSQL완료재조회·54/54·독립검토·build/contract. 운영ready/이번effect활성화0·공식60. 다음 문서등 남은등록쓰기 효과계약/원래나머지인수.\n`);
console.log(JSON.stringify({observedAt,tests:54,verified:60,attempt:`${prefix}-attempt.json`}));
