import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/format-current-render-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),sha=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const audit=JSON.parse(read(`${prefix}-audit.json`));assert.equal(audit.allCurrentPassed,true);assert.equal(audit.rows.length,5);
for(const r of audit.rows)assert.equal(r.proof.passed,true);
const log=read(`${prefix}-final-packaged.txt`);for(const regex of [/tests 56\b/,/pass 55\b/,/fail 0\b/,/skipped 1\b/])assert.match(log,regex);assert.match(read(`${prefix}-final-build.txt`),/Built static/);
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-061');assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
const requirementHash=sha(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));assert.equal(gates.filter(g=>g.status==='verified').length,46);
const word=JSON.parse(read('artifacts/word-table-mission-live-20261007-zhQkrj/result.json'));
const verification={observedAt,acceptanceId:'V3-061',before:46,after:47,originalRequirementsSha256:requirementHash,audit,regression:{tests:56,passed:55,failed:0,skipped:1,durationMs:23991.6584},build:'passed',wordMissionEvidence:'artifacts/word-table-mission-live-20261007-zhQkrj/result.json',wordMissionRecorded:true,externalModelCalls:0,cost:'미측정',preservedUserProcesses:[33340,34724],visualQualityVerified:false};
assert.ok(word);writeFileSync(`${prefix}-verification.json`,JSON.stringify(verification,null,2),{flag:'wx'});
const files=['apps/pc-agent/src/adapters/hwpx/native-pdf-renderer.js','apps/pc-agent/src/adapters/hwpx/native-pdf.ps1','apps/pc-agent/src/adapters/hwpx/hwpx-content-verifier.py','apps/pc-agent/src/pc-agent-runtime.js','apps/verification/src/hancom-render-verifier.js','apps/verification/src/office-document-render-verifier.js','apps/verification/src/verification-runtime.js','apps/pc-agent/src/install/pc-agent-runtime-payload.js','tests/office-current-rendering.test.js','tests/hancom-current-rendering.test.js','tests/pc-agent-standalone-package.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:sha(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`, `# 형식별 저장 구조·실제 출력 현재 검증

공식 인수 **46→47/100**. 원래 V3-061 “Word·HWP/HWPX·PPT·PDF의 구조와 렌더링을 형식별 검증기로 확인한다.”를 완료 검토했다. 기존100개 ID·요구·분모를 유지한다. 실제 현재 생성된 구조화 문서의 형식별 검사 범위이며 모든 문서·디자인·자연어의 무결함을 뜻하지 않는다.

## 실제 출력과 독립 검사

HWP/HWPX는 설치 한컴12.0.0.535에서 원본을 다시 열고 검사용 HWPX 및 PDF로 내보냈다. COM 종료 뒤 원본 해시를 확인하고 읽기 전용 OWPML 검증기로 내보낸 표의 머리글·행·열별 셀 값과 요청 문단을 대조했다. G는 현재 원본·구조 파일·PDF·PNG를 다시 읽어, 요청 내용·텍스트 경계·실제 PDF 재래스터화 픽셀을 검사한다. 레거시 v1 영수증의 표 구조는 검증됐다고 표시하지 않는다. v2만 현재 행·열 대조를 통과한다. 실제 제품 HWPX 작성→네이티브 출력→현재 G 두 검사도 통과했다. 추가 출력 파일은 별도 undo 기록과 출력 목록에 포함한다.

Word는 실제 DOCX와 PDF 출력 두 건을 만들었다. G에 word.create 전용 구조·렌더 검사 office_current_structure_and_rendering_verified를 추가했다. 저장된 OOXML 표와 요청 셀 좌표를 비교하고, Word COM의 저장 후 다시 읽기 전용 재열기·출력 보고와 현재 PDF의 실제 문자·페이지 경계를 대조한다. PDF 생성은 word.create의 outputFormat=pdf 경로이며 pdf.create 도구가 새로 등록된 것이 아니다. 현재 Core/E/B/G Word Mission도 COMPLETED, 틀린 요청과 출력 변조의 음성 대조는 실패를 반환했다. 변조 시험의 기본 파일은 훼손된 시험 입력으로 보존하고 정상 원본 복사본은 따로 둔다.

PPT는 새 서명된 로컬 실행 패킷으로 실제 2슬라이드 PPTX와 네이티브 PNG를 생성했다. 현재 typed OOXML 내용·레이아웃 및 렌더 계약 검사와 실제 G 재조회가 통과했다. 이번 PPT 패킷을 새 자연어 Core Mission으로 과장하지 않는다. 기존 V3-064 Mission 증거와 함께 검토했다.

형식5개를 종합 감사 스크립트에서 현재 파일로 재검증했고 모두 passed다. 시각적 취향·모든 글꼴·임의 병합표·악성 문서의 매크로/OLE 안전성·설교 의미 품질은 이 검사로 입증하지 않는다.

## 실패와 수정

초기 좁은 검사11개 중2개는 Python 예외 추적이 잘려 실패 원인이 정확한 코드로 반환되지 않는 결함이었다. Python CLI를 구조화된 실패 JSON으로 바꾸고 G에서 알려진 원인 코드만 추출하도록 고쳤다. 이후11/11을 확인했고 초기 실패 로그도 보존했다. HWPX 셀 두 개를 바꾸고 새 해시를 넣은 반례는, 모든 단어가 PDF에 남아 있어도 hwpx-table-postcondition-failed로 거절된다. PDF를 다른 실제 문서로 교체하고 해시를 갱신한 반례도 요청 내용 불일치로 거절한다.

첫 PPT 시험 도구는 존재하지 않는 패킷 verification 속성을 검사해 종료1을 냈다. 실제 실행 상태 COMPLETED와 현재 proof passed는 이미 관측됐다. 시험 도구를 실제 ExecutionResultVerifier로 고치고 같은 현재 출력에서 G를 별도로 호출해 passed를 확인했다. 처음 로그를 숨기거나 제품 실패/성공의 분모를 임의 변경하지 않는다.

패키지에서 새 Python·한컴 native helper와 MCP policy가 빠진 것을 발견해 고정 allowlist에 추가했다. 추출된 패키지의 실제 G가 현재 DOCX/PDF를 다시 읽는 검사를 통과했다. Python·fitz·Pillow·MCP는 호스트 준비 조건이며 번들 내장이나 다른 PC 설치 완료가 아니다. 설치본·운영 서비스는 이번에 교체하지 않았다.

## 검증과 범위

최종 실제 존재하는11개 시험 파일에서 **56건:55통과·실패0·제외1**, 23,991.6584ms. 제외는 opt-in Excel 네이티브 생성 검사다. 빌드 성공. 현재 생성5형식 재조회, Word 실제 Mission, Hancom 제품 어댑터 및 PPT 실제 패킷은 별도 관측이며 회귀 수에 더하지 않는다. 사용자 Hwp33340·Word34724 시작시각과 생존을 확인했고 종료하지 않았다. 외부 모델 호출0, 전체 비용미측정. SHA는 무결성 근거이며 독립 행동 검증 자체가 아니다.

## 복원과 다음 작업

이번 변경 파일만 이전 스냅샷과 대조해 되돌릴 수 있다. 사용자 문서·기억·다른 개발 작업은 보존한다. 생성 출력은 독립 시험 폴더 및 undo journal에 있다. MCP render queue는 여전히 NOT_CONFIGURED이며 별도 로컬 한컴 출력 경로를 큐 활성화로 표현하지 않는다.

V3-061 범위는 이 PC의 생성된 HWP/HWPX·DOCX·PPTX·텍스트층 PDF에서 저장 구조와 실제 출력 계약을 검사하는 기능이다. 임의 문서 호환성, 일반 디자인 품질, 설치/업데이트/다른 PC, 실계정, 30일 관측은 남은 인수 조건이다. 다음은 V3-046 등 현재 실패 후 기억 저장·재개 경계를 읽고, 독립적으로 종료 가능한 미완료 조건을 구현한다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-audit.json`,`${prefix}-final-packaged.txt`,`${prefix}-final-build.txt`,`${prefix}-focused.txt`,`${prefix}-focused-fixed.txt`,`${prefix}-ppt.txt`,`${prefix}-ppt-g.txt`,'artifacts/office-current-render-20261007/docx-pilot.json','artifacts/office-current-render-20261007/pdf-pilot.json','artifacts/hancom-product-render-20261007-structure/pilot.json','artifacts/word-table-mission-live-20261007-zhQkrj/result.json','artifacts/format-current-ppt-20261007-Yp0xQU/current-g.json'];
assert.ok(evidencePaths.length<=16);const evidenceBytes=evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0);assert.ok(evidenceBytes<4*1024*1024);
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'format-current-render-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'型式별 저장 구조를 독립 대조하고 실제 출력 파일을 현재 재조회하면 렌더 보고의 자기 선언과 해시 갱신 변조를 구별할 수 있다.',lesson:'한컴 HWP는 실제 앱의 검사용 HWPX 변환을 통해 셀 좌표까지 대조하며 Word 출력은 저장 구조와 현재 PDF 요청 내용 양쪽을 결속해야 한다. 패키지의 Python/native helper 누락도 계약 검사로 발견했다.',limitations:'47/100. 생성된 구조화 문서/Windows COM 범위. 55통과1제외/build/현재5형식. 임의문서·의미/디자인·외부 계정·다른PC 설치·MCP큐 활성화·30일 관측 아님. 비용미측정.'},null,2),{flag:'wx'});
gate.reviewHistory??=[];gate.reviewHistory.push({supersededAt:observedAt,status:gate.status,evidence:[...gate.evidence],limitations:[...gate.limitations],reason:'현재 HWP/HWPX 행열 구조와 Word/PDF/PPT 실제 현재 출력 전체 감사로 이전 미완료 조건을 충족.'});
gate.status='verified';gate.evidence.push(...evidencePaths.slice(0,4));gate.limitations=['현재 Windows PC의 생성된 구조화 HWP/HWPX·DOCX·PPTX·텍스트층 PDF에서 저장 구조/실제 출력 계약 검증. 임의 악성/복잡 문서, 모든 병합표/글꼴/템플릿, 의미·디자인 품질, 다른 PC 설치 및 장기 관측은 이 인수 범위 밖이며 별도 미검증.','MCP render queue 미구성. 로컬 한컴 COM 경로는 큐 활성화가 아니다. 호스트 Python/fitz/Pillow/MCP 필요.'];gate.verifiedAt=observedAt;
assert.equal(sha(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),requirementHash);assert.equal(gates.filter(g=>g.status==='verified').length,47);a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: V3-061 현재5형식 구조·실제출력 감사 통과/55회귀통과1제외/build. 원래100개 요구 유지, 공식47/100. 다음 V3-046 기억 저장 실패 뒤 효과 재실행 없이 재개 및 실패 경계 감사.\n`);
console.log(JSON.stringify({verified:47,evidenceBytes,evidenceFiles:evidencePaths.length}));
