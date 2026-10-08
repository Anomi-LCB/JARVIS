import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/native-pdf-field-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,v)=>writeFileSync(`${prefix}-${name}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`),log=read(`${prefix}-final.txt`);assert.equal(runner.status,'passed');
for(const [key,count]of [['tests',36],['pass',36],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(log,/actualRenderingExecuted":true/);assert.match(log,/nativeExistingExportMission.*COMPLETED/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const independent=json('artifacts/pdf-authority-20261007-independent.json'),observedAt=new Date().toISOString();
const sources=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/excel/native-pdf-renderer.js',
 'apps/pc-agent/src/adapters/excel/native-pdf.ps1','apps/pc-agent/src/adapters/excel/native-process-guard.cs',
 'tests/xlsx-export-pdf.test.js','tests/workbook-native-pdf.test.js'];
write('source.json',{observedAt,files:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,60);
write('verification.json',{observedAt,tests:36,passed:36,failed:0,skipped:0,durationMs:runner.durationMs,
 actualNativeExcelRuns:['generated-workbook-pdf-adapter','existing-workbook-pdf-adapter','existing-workbook-Core-E-B-G-Mission'],
 nativeVersion:'16.0',nativeBuild:'4266',sourcePreserved:true,gReread:true,visualQualityVerified:false,
 externalModelCalls:0,totalLocalCost:null,productionActivated:false,independentReview:independent,
 healthObservation:{observedAt,core4071:'not-listening',pc17776:'not-listening',ui41730:'not-listening',priorPidsPresent:false},
 acceptanceVerified:60});
write('report.md',`# 실제 Excel PDF 현장 검증 및 실행 권한 경계 보강

관측 ${observedAt}. 최종36/36 통과·0실패·0skip. 외부 모델0, 격리 합성자료/임시 경로, 실제 Microsoft Excel COM16.0 build4266. 앞선 workbook-effect 보고의 native 미실행을 이번 새 시도로 보완했으며 과거 보고서를 바꾸지 않는다.

## 실제 성공

신규 XLSX+차트→PDF가 실제 제품 adapter와 native 프로세스에서 생성됐다. 기존 XLSX→PDF만 출력하는 adapter도 실제 성공했고 원본 바이트와 수정 시각을 보존했다. Core→E→PC→G Mission 역시 기존 XLSX의 PDF 출력으로 COMPLETED였다. G가 파일을 다시 읽고 변조된 PDF는 거절했다. 생성 XLSX/PDF의 undo2건과 기존 XLSX 출력의 PDF-only undo1건을 확인했다. 실행 이후 Excel 프로세스가 없음을 확인했다. 사용자 원본·개인 계정·외부 발송은 사용하지 않았다.

## 수정과 독립 반증

exportPdf는 기존 최종 beforePdfPublish에서 Core/E를 검사했지만 adapter 내부 shadow→source preflight→mkdir/native 진입 동안 private current-authority 검사를 수행하지 않았다. B가 assertAccess를 전달하고 adapter가 shadow후, 경로 await앞뒤, mkdir전후 및 source 재조회 후 PDF 게시전에 재확인하도록 보강했다.

독립 검사에서 실제 SQL Core authority release 및 capability availability 철회를 두 번째 adapter shadow 경계에 넣었다. 최신 소스는 renderer 진입0·출력디렉터리 생성0이다. assertAccess 공급만 제거한 통제 baseline에서는 두 경우 모두 renderer 진입과 mkdir이 발생했다. baseline은 역사적 원본 실행과 다르며 해당 구분을 유지한다. 독립4비교는36에 합산하지 않는다.

추가 root 회귀의 첫 기대값은 failed였으나 실제 정책 차단의 상태는 blocked였다. 파일/디렉터리 미생성과 정확한 원인코드를 확인하고 기대를 기존 정책 계약에 맞춰 정정했다. 이 assertion 실패를 제품 실행 성공으로 바꾸기 위해 코드를 완화하지 않았다. 초기 로그와 최종 로그를 함께 보존했다. build/Core 계약도 통과했다.

## 현재 한계와 다음 진행

실제 native 성공은 이 PC/설치 Excel/고정 자료/고정 planner의 증거다. 일반 XLSX 전체, 수식 재계산, 모든 Office UI, PDF 시각적 완성도나 설치본 활성화의 증거는 아니다. PDF 경로 자체의 SQL common effect 연결·종료후 provider receipt 복구는 아직 남았다. V3-040 전체 승격은 보류한다. 실행36건 총 ${runner.durationMs}ms이며 제품 p50/p95를 대신하지 않는다. 비용은 미측정(null), 시험 사용자 개입0이며 일반 사용 개입률을 의미하지 않는다.

운영 상태를 새로 확인했을 때4071/17776/41730 listening socket과 이전 service PID가 없었다. 이번 native 시험은 격리 런타임에서 수행했으며 운영서비스나 설치된 프로그램을 재시작하지 않았다. 서비스 중단 원인·복원은 별도 후속 조사 대상이다.

공식 인수율은60%다. V3-065의 구조화 Office API 실제 실행 부분을 증거로 연결하고 DOM/UIA/화면 보조와 앱 변화 대응은 미완료로 남긴다. 다음 순서는 운영 런타임의 중단 원인/복원 경로를 확인하고, 미결속 exportPdf 공통effect 및 아직 진행하지 않은 인수항목을 이어 구현하는 것이다. 전체 자연어 성공률 또는90% 달성을 선언하지 않는다.

복원은 exportPdf assertAccess 전달/검사 추가만 제거하되 원본·SQL 영수증·사용자 기억은 보존한다. 권한 철회 후 mkdir/native 진입이 재발할 수 있으므로 회귀 및 controlled baseline을 함께 사용한다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','final-runner.json','build.txt','contract.txt',
 'authority-extra.txt'].map(n=>`${prefix}-${n}`).concat(['artifacts/pdf-authority-20261007-independent.json','artifacts/pdf-authority-20261007-independent.md',
 'artifacts/pdf-authority-20261007-independent-comparison.txt','artifacts/pdf-authority-20261007-independent.test.mjs']);
write('attempt.json',{id:'native-pdf-field-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제 Excel PDF 생산과 원본 보존/G재조회가 이PC에서 가능하며 shadow이후 private authority 재확인이 native 준비의 철회후 부작용을 차단한다.',
 lesson:'환경flag 미설정으로 skip한 검사는 설치가능성 확인 후 실제 실행해야 한다. 최종 publication에서만 권한을 확인하면 이전 mkdir/native 진입을 막지 못한다.',
 limitations:'실제native3양성/36회귀 및독립철회2+통제baseline2. 고정자료/시각품질미확인/SQLexporteffect미연결/운영서비스not-listening/설치활성화0/공식60/비용null.'});
for(const id of ['V3-029','V3-040','V3-065']){const gate=gates.find(g=>g.id===id);assert.ok(gate);gate.evidence.push(...evidencePaths);
 if(gate.status==='pending')gate.status='in_progress';
 gate.limitations.push('2026-10-07 실제ExcelCOM 신규/기존PDF3양성·36/36·원본보존/G재조회·shadow후authority/availability철회 차단 독립검증. exportPdf SQLeffect/DOM/UIA/시각품질/전체앱/운영활성화 미완료.');}
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제Excel PDF3양성/native skip0·36회귀/build/contract·export shadow후private fence 보강/독립철회4비교. 공식60 유지·V3-065진행중. 운영4071/17776/41730과이전PID 없음 새관측. 다음 운영중단원인/복원·exportPdf effect결속·미진행 인수항목.\n`);
console.log(JSON.stringify({observedAt,tests:36,verified:60,attempt:`${prefix}-attempt.json`}));
