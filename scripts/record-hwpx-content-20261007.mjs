import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex');
const prefix='artifacts/hwpx-content-20261007',observedAt=new Date().toISOString();
for(const [path,pass,skip] of [[`${prefix}-final-tests.txt`,14,3],[`${prefix}-shared.txt`,19,1]]){
 const log=read(path);assert.match(log,new RegExp(`pass ${pass}\\b`));assert.match(log,/fail 0\b/);assert.match(log,new RegExp(`skipped ${skip}\\b`));
}
assert.match(read(`${prefix}-final-build.txt`),/Built static/);
const pilot=JSON.parse(read(`${prefix}/pilot.json`));assert.equal(pilot.result.status,'success');assert.equal(pilot.result.evidence.hwpx.tableCount,2);
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(acceptancePath));
const gates=acceptance.stages.flatMap(s=>s.gates),requirementsHash=()=>hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
assert.equal(gates.length,100);const originalRequirementsSha256=requirementsHash();
const verified=gates.filter(g=>g.status==='verified').length;
const files=['apps/pc-agent/src/adapters/hwpx/hwpx-mcp-create.py','apps/pc-agent/src/adapters/hwpx/hwpx-content-verifier.py','apps/pc-agent/src/pc-agent-runtime.js','apps/verification/src/hwpx-content-verifier.js','apps/verification/src/verification-runtime.js','tests/hwpx-current-content.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,verified,originalRequirementsSha256,regression:{tests:37,passed:33,failed:0,skipped:4},
 actualPilot:{path:pilot.result.outputPaths[0],sha256:pilot.result.sha256,tableCount:2,coreVersion:'6.3.0',durationMs:pilot.durationMs},
 healthObservation:{serverVersion:'7.0.3',pythonHwpxVersion:'6.3.0',toolSurface:'ok',nativeRendering:{available:false,degraded:true,reason:'NOT_CONFIGURED'},source:'actual mcp_server_health and render_health calls this turn'},
 externalModelCalls:0,cost:'미측정',rendering:'unverified',preservedUserProcesses:[33340,34724]},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# HWPX 내용 보존과 현재 파일 구조 검증\n\n공식 인수율 **${verified}/100 유지**. V3-061은 대기에서 진행 중으로 변경했으며 완료로 올리지 않았다. 원래 100개 요구는 유지했다.\n\n## 수정한 실제 결함\n\n공통 문서 정규화는 표 머리글을 columns로 반환하지만 HWPX 생성기는 headers를 읽어 머리글을 빼고 만들었다. bullets는 text가 없는 블록이어서 빈 문단으로 저장되고 기존 후조건도 그 누락을 찾지 못했다. 이제 columns와 rows를 함께 표에 쓰며, 글머리표 항목마다 문단을 생성한다. 데이터 행이 없는 표도 머리글을 보존한다. 미지원 블록은 조용히 생략하지 않는다.\n\n독립 읽기 오라클은 ZIP 필수 항목·중복 항목·CRC·확장 크기와 OWPML 본문, 표 개수·행·열·각 셀의 정확한 값·표 순서를 검사한다. 단순히 전체 텍스트 안에 값이 존재하는 것으로 표 구조 성공을 선언하지 않는다. B 생성 후 검사와 G 현재 파일 재검사에 연결했다. G는 허용된 실제 경로·파일 크기·현재 해시를 검사하고 독립 임시 스냅샷을 읽은 뒤 원본이 바뀌지 않았는지 다시 확인한다. 생성기 성공 주장만으로 G 통과하지 않는다.\n\n## 실행 증거\n\n실제 설치된 정책 허용 MCP 7.0.3/core6.3.0을 호출해 한국어 HWPX를 생성했다. 제목·문단·글머리표·3열2행 자료 표와 머리글만 있는 표를 보존했고 독립 구조 검사가 통과했다. pilot.json과 실제 내용보존.hwpx를 보존한다. 회귀 시험에서는 별도의 실제 MCP 생성→G 재조회→내용 변경·셀 순서 변경·누락 요구·허용 경로 부재·파일 변조·덮어쓰기 차단을 확인했다. 격리 시험 문서의 셀 값을 실제로 교환한 후 생성자 해시를 갱신해도 G가 실패했다. XML 변조는 이 부정 대조 문서에만 수행했고 실제 작성은 MCP로 했다.\n\n고유 회귀 **37개 중33통과·실패0·제외4**, 빌드 성공. Word 소유 프로세스 종료 검사3개와 실제 Excel 새 출력 검사1개는 실행 설정에 따라 제외됐으며 통과 수에 포함하지 않았다. PDF 실제 파서 및 기존 네이티브 PDF 재조회, PPT 내용 검증 등 공유 검사는 함께 실행했다. 외부 모델 호출0·비용 미측정. 앱 설치본·운영 서비스·계정 권한은 변경하지 않았다. 사용자의 Hwp PID33340과 Word PID34724는 같은 시작 시각으로 살아 있으며 종료하지 않았다.\n\n## 렌더링의 남은 조건\n\n실제 render_health는 available=false/degraded=true/NOT_CONFIGURED였다. 가짜 미리보기를 실제 한컴 렌더링으로 바꾸지 않았다. 생성 결과의 rendering.status=unverified와 한국어 안내에 실제 화면 출력 미확인을 표시한다. V3-061 완료에는 HWP와 HWPX의 실제 한컴 PDF·페이지 PNG, 입력 해시·작업 영수증·렌더러 버전의 검증 및 Word/PPT/PDF 형식별 원래 인수 조건 대조가 더 필요하다. 현재 본문 오라클은 자유로운 의미·디자인 품질 평가나 제목 수준 스타일 검증이 아니며, 모든 문서 읽기 기능을 추가한 것도 아니다.\n\n## 다음 작업과 복원\n\n한컴 렌더링 worker의 기존 구현과 소유 프로세스 보호를 조사해 준비 가능한 로컬 경로를 연결한다. 다른 형식은 기존 증거를 재사용하여 부족한 현재 파일 검증만 추가한다. 이번 변경만 검토해 복원하며 사용자 문서·기억·다른 소스 수정은 보존한다. SHA는 무결성 자료이며 독립 행동 검증이나 제품 활성화가 아니다.\n`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}/pilot.json`,`${prefix}/내용보존.hwpx`,`${prefix}-final-tests.txt`,`${prefix}-shared.txt`,`${prefix}-final-build.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'hwpx-content-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'정규화된 머리글·글머리표를 MCP 작성에 전달하고 현재 파일에서 셀 좌표를 다시 검사하면 내용 누락과 거짓 구조 성공을 차단할 수 있다.',
 lesson:'작성 계약과 생성기가 다른 속성명을 쓰면 생성 성공과 파일 존재만으로 누락을 알 수 없다. 본문 존재·표 좌표·실제 렌더링은 별개의 증거다.',limitations:'33회귀 통과/4제외/build; 한컴 렌더링 큐 NOT_CONFIGURED, V3-061 진행 중,전체46/100. 실제 자유문서 디자인·모든 앱·계정 성공 아님.비용미측정.'},null,2),{flag:'wx'});
const gate=gates.find(g=>g.id==='V3-061');assert.equal(gate.status,'pending');gate.status='in_progress';gate.evidence.push(...evidencePaths.slice(0,2));gate.limitations.push('2026-10-07 HWPX 머리글·bullets 누락 수정,실제 MCP 생성·G 현재파일 셀좌표 대조.33통과/4제외/build. 실제 한컴 렌더링 큐 NOT_CONFIGURED; HWP/형식별 렌더링 전체 인수 미완료.');
assert.equal(requirementsHash(),originalRequirementsSha256);acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: V3-061 진행 중. HWPX 머리글·bullets·머리글만 표 보존 수정/실제MCP 생성/G현재파일 셀좌표·부정대조·33통과4제외/build. 전체${verified}/100. 다음 한컴 native render worker 연결과 HWP/Word/PPT/PDF 현재 구조·렌더링 증거 보완.\n`);
console.log(JSON.stringify({verified,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
