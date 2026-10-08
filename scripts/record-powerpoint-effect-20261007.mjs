import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/powerpoint-effect-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p)),sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`),review=json(`${prefix}-independent.json`);
assert.equal(runner.status,'passed');
const count=key=>Number(log.match(new RegExp(`ℹ ${key} (\\d+)(?:\\r?\\n|$)`))?.[1]);
assert.equal(count('fail'),0);assert.equal(count('skipped'),0);assert.equal(count('tests'),count('pass'));assert.ok(count('pass')>=50);
assert.equal(review.execution.passed,18);assert.equal(review.execution.failed,0);assert.equal(review.execution.skipped,0);
for(const file of review.sourceHashes)assert.equal(sha(file.path),file.sha256,`reviewed source changed: ${file.path}`);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
assert.equal(json(`${prefix}-pdf-current-runner.json`).status,'passed');
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
const sources=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/powerpoint/native-authoring.js','apps/pc-agent/src/adapters/powerpoint/native-create.ps1','packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js','packages/core/src/planning/mission-action-arguments.js','packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js','apps/verification/src/artifact-layout-verifier.js','tests/fixtures/powerpoint-effect-process-child.mjs','tests/mission-powerpoint-effect-process.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:sha(path),content:read(path)}))});
write('verification.json',{observedAt,tests:count('tests'),passed:count('pass'),failed:0,skipped:0,durationMs:runner.durationMs,actualNativePowerPointProcessCases:8,independentReview:review,externalModelCalls:0,totalCost:null,productionActivated:false,originalAcceptanceVerified:60,
 preservedFailureDiagnostics:['pdf-native-diagnostic.txt','pdf-diagnostic.txt','pdf-final.txt','independent-write-race.txt'].map(name=>({path:`${prefix}-${name}`,sha256:sha(`${prefix}-${name}`),content:read(`${prefix}-${name}`)}))});
write('report.md',`# PowerPoint의 원래 슬라이드·전체 산출물·영속 효과·중단 복구

관측 ${observedAt}. 최종 ${count('pass')}/${count('tests')}·실패0·skip0, 빌드와 Core 계약 통과. 별도 독립18/18은 native authoring/G 레이아웃 응답을 합성한 반증이며 최종 회귀 수에 더하지 않는다. 공식 인수60/100 유지.

## 구현한 동작

PPTX/PDF 요청의 명시 확장자와 outputFormat을 보존하고 충돌은 차단한다. 원래 제목·본문·발표자 메모와 모든 슬라이드 PNG, native-report, 최종 파일 및 PDF의 원본 PPTX 위치를 준비 계약으로 고정한다. 보조 폴더는 요청/출력경로 해시로 정하며 기존 파일·폴더는 덮어쓰지 않는다.

로컬 단일 powerpoint.create를 기존 SQL effect에 연결했다. Core는 원래 요청·전체 manifest·operation/effect ID를 보존하고 B의 private guard는 같은 계약을 검사한다. 모든 파일의 기존 물리 claim·현재 Core/E 권위·취소를 native 저작과 발행 경계까지 전달한다. B 완료영수증을 즉시 영속화하고 같은 영수증으로 claim을 해제한다. 실패 후 소유 부분 산출물을 삭제해0개로 보이지 않게 하며 uncertain과 실제 경로를 남긴다.

복구는 SQL 원래 슬라이드/manifest와 receipt를 대조하고 모든 현재 바이트 해시를 다시 읽은 뒤 G의 PPTX본문/메모/좌표/native bounds/실제 PNG ink 검사를 수행한다. PDF는 현재 PDF를 별도 scratch로 읽어 필수 제목·본문과 페이지 수·글자 경계를 검사한다. 발표자 메모를 PDF에 보인다고 요구하지 않으며 메모는 원래 PPTX에서 검사한다. G 복구 범위 전달은 읽기 전용이며 새 실행token이나 권한을 발급하지 않는다. 카드 이미지의 권한 범위는 유지했다.

## 실제 실행과 반례

처음 실제 native2건은 권한 철회/이미 취소된 요청을 무시하고 생성해0통과2실패였다. 새 경계에서 이를 차단한다. 실제 PowerPoint 작성과 OS SIGKILL을 prepared·B receipt·SQL receipt·최종발행 후 undo/receipt 이전4경계에 적용했다. 정상 복구는 같은 ID/key/receipt와 완료 adapter 반환1회, 최종 claim0이다. 부분 생성 및 PPTX/PNG 변경은 PAUSED/uncertain·재실행0이다. 호출 시작 횟수를 모든 경계에서1회라고 주장하지 않는다. 실제 권위 활성 PPTX/PDF 양성과 소유 native 실행 관측 뒤 취소도 확인했다.

PDF 양성은 기존 ExportAsFixedFormat2인자 COM 바인딩 오류로 실패했다. Microsoft 공식 SaveAs·ppSaveAsPDF32 경로로 교체한 뒤 실제 출력에 성공했다. 근거: [SaveAs](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.presentation.saveas), [PDF 형식32](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.ppsaveasfiletype). PDF와 PPTX를 함께 저장하더라도 PDF를 바꾸면 intact PPTX proof만으로 통과할 수 없게 실제 음성 시험을 수행했다.

독립 검토는 요청 JSON 쓰기 직후 live grants를 철회하면 native 진입1회가 가능한 틈을 발견했다. 쓰기 완료 뒤 native 호출 직전 재검사를 추가해 같은 반례 native0으로 바뀌었다. 첫 범위 시험에는 필수 slides 입력을 빠뜨려 먼저 slides-required가 나왔으므로 유효 입력으로 수정했다. G PDF 연결의 초기 verifyOnly 모드는 기존 page PNG가 필요해 실패했으며 격리 scratch에서 현재 PDF를 실제 raster하는 모드로 수정했다. 초기 실패와 원인·재검증 증거를 보존했다. 이전 Word source snapshot은 PowerPoint 변경 전 구현도 보존한다.

최종 회귀에는 기존 Word SQL/native/현재 rendering, PowerPoint 저장 문구·메모·overflow/변조, 카드 PNG/current layout, 표좌표 및 Core권위·능력준비도 경계가 포함된다. ${runner.durationMs}ms는 시험시간이며 제품 p50/p95가 아니다. 외부LLM/발송/거래0, 로컬 비용 미측정. 실제 사용자 원장·F/cognition을 초기화하지 않았다.

## 운영·남은 인수·복원

Core4071/PC17776/UI41730 connections-only 현재 ready다. 운영 재시작/설치 EXE로 새 PowerPoint effect를 활성화하지 않았다. MobileBridge 신원불일치·실계정·모바일·상시클라우드·장기운영이 해결됐다는 뜻은 아니다.

원격 PowerPoint, 모든 Office 템플릿/복잡한 개체, 픽셀 문구 OCR, 의미·디자인 품질, 악의적 OS 경로교체/네트워크파일시스템은 미검증이다. 전체 쓰기 계약 V3-040은 아직 진행중이다. 다음은 남은 HWP/HWPX·이미지·문서편집 실행과 원래 다른 미완료 인수다. 복원은 source snapshot의 PowerPoint manifest/SQL지원/privateguard/receipt/recovery/G PDF/native SaveAs 변경만 좁게 비교하며 실제 문서·영수증·기억을 삭제하지 않는다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','build.txt','contract.txt','independent.md','independent.json','independent-final.txt','independent.test.mjs','baseline.txt','focused.txt','pdf-current.txt','pdf-current-runner.json','runtime-scoped.json'].map(name=>`${prefix}-${name}`);
write('attempt.json',{id:'powerpoint-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'원래 슬라이드와 전체 산출물을 SQL/privateguard/Bclaims/영속receipt/독립G에 연결하면 중단 복구에서 요청을 바꾸거나 중복 생성하지 않고 부분/변조 출력을 보류할 수 있다.',lesson:'원본PPTX의 내용검증은 PDF의 내용검증을 대체하지 못한다. 요청쓰기를 await한 뒤에도 실제native진입직전 현재권한을 재검사해야 한다.',limitations:'actualPowerPointSIGKILL4경계/PPTX+PDF양성/소유native취소+합성독립18. 전체쓰기/원격/운영활성화/실계정/장기운영미완료. 공식60/100·비용미측정.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('PowerPoint 원래slides/전체PNG+native-report+target+PDFsource 계약·localSQL/Bclaim/영속receipt/현재G PDF·actualnativeSIGKILL4경계 및취소. 다른전체쓰기/원격/운영활성화는미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: PowerPoint전체manifest/원래slides·SQL/privateguard/Bclaim/영속receipt/현재G PDF내용·actualSIGKILL4경계/소유native취소·독립18·build/contract. 공식60/100·운영활성화0. 다음 HWP/HWPX·이미지·문서편집 및 원래나머지인수.\n`);
console.log(JSON.stringify({observedAt,tests:count('tests'),passed:count('pass'),verified:60,attempt:`${prefix}-attempt.json`}));
