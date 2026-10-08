import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-capability-20261008',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final.txt','utf8');if(!log.includes('ℹ pass 87')||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0'))throw Error('Final regression required');
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS')||!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('Build and contract required');
const sources=['apps/runtime-compose/src/lifecycle-case-capability-package.js','apps/runtime-compose/src/create-runtime.js','packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js','tests/lifecycle-case-capability.test.js','docs/lifecycle-cases.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 로컬 생활 업무 기록의 Core/E/B/G 읽기 경로

관측 ${observedAt}. 배송·반품·행정 화면/로컬 API 이후 자연어 실행 연결에 필요한 읽기 능력 패키지를 기존 registry와 trusted Mission-action 경로에 연결했다. 새 실행 원장이나 별도 권한 엔진을 만들지 않았다.

case.readLocalRecord는 호스트가 lifecycleCaseAccess를 제공할 때만 등록된다. DB/URL/자격증명을 모델 인수로 받지 않는다. caseId·expectedStoreId·expectedRevision과 한국어 rawText를 기존 인수 스키마로 보존한다. availability binding을 E에서 확인하고 B에서 필수 access fence와 선택 권한을 실행 전후 다시 검사한다. Core 원장 projection에는 로컬 업무·마감·관측·취소 의사·인계 준비만 담고 providerVerified/completionVerified/executionAuthority를 false로 유지한다. 외부 공급자 조회나 취소는 없다.

G는 trusted 활성 task의 실제 action/tool/인수와 B 영수증의 요청·hash를 결속하고 현재 Core 원장을 독립 재조회한다. 현재/최종 task와 권한을 다시 확인한다. G 패키지 verifier ID·fingerprint·digest 검사와 현재 원장 검사 모두 통과해야 읽기 결과 완료가 된다. 읽기 완료는 공급자 처리 완료를 의미하지 않는다. 자유로운 자연어 의미 분석의 품질 점수로 G 내부 점수를 해석하지 않는다.

첫 검사9개 중3개가 실패했다. 기존 G는 workflow/source/MCP만 package verifier를 호출하여 새 도구의 원장 변경·저장소 변경·검증기 누락을 검사하지 않았다. 새 tool에 G 호출과 critical 실행 검사를 연결해 해결했다. 실패 로그는 first.txt에 보존했다. Core authority fence 도구 집합과 executor 선택도 확장했다. 원격 PC 실행기가 설정되어도 이 호스트 설치 Core 읽기만 Core executor를 사용하며 원격 PC 호출을 하지 않는다. 다른 PC 작업의 executor는 그대로 유지한다.

최종 공유8파일87/87 실패0·생략0. 신규13검사: ready, remote-executor, binding 누락, 읽기 전/후/독립 오라클 중 권한 철회, availability 철회, 다른 업무 선택, 원장 revision 변경, store 변경, 공급자 완료 위조, oracle 누락, 기본 비활성. 실제 Core task→E→B packet→G 검사를 수행했고 정상은 lifecycle_case_current_core_verified를 확인했다. 개인 DB와 growth 기억은 각 테스트의 임시 디렉터리에 격리했다. 기존 선택 inbox·생활 기록·새로고침·개인 업무·reminder·workspace 회귀와 build/Core contract gate도 통과했다.

여기서 readSnapshot은 호스트가 설치한 Core 읽기 함수이고 readCurrentSnapshot은 별도의 Core 소유 동기 오라클이다. 이번 실행은 실제 테스트용 Core/E/B/G 경로와 합성 계정이며 운영 Core나 설치 EXE 활성화, 실제 공급자 성공의 증거가 아니다. 준비된 caseId/store/revision 인수로 생성한 작업을 시험했으며 **자유로운 자연어의 대상 추출·요구 전체 해석·전체 Mission 최종 결과 화면은 아직 미구현**이다. UI 변경은 없으며 이전 밝은 화면을 유지한다.

공급자/유료 모델 호출0. 실제 API 계정·기기·F/cognition 업무 기록은 변경하지 않았다. 테스트 시간은 final.txt에 보존하며 실사용p50/p95·CPU비용은 미측정이다. 공식 인수60/23/17을 유지하고 V3-029/041/077을 이 좁은 증거로 완료 처리하지 않는다. 다음은 선택된 생활 업무의 요구 계약·read-only Mission 계획·검증된 결과 표시와 실제 제공자 준비 조건이다. 복원은 신규 패키지 등록·resolver/executor·G 도구 검사를 함께 제거하되 기존 DB 업무/영수증은 보존하는 범위다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-second.txt','-regression.txt','-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Acceptance changed');
for(const id of ['V3-029','V3-041','V3-077']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: local case-read host能力패키지/trusted preparedArguments CoreE/B/G/원격executor분리87회귀/build/contract. 첫G검증누락3반례 수정. 자유자연어/전체Mission결과/실공급자/운영설치본 미완료,공식60%유지.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-capability-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'생활 업무의 선택된 로컬 기록을 기존 capability registry/E/B/G로 읽고 원장과 권한을 독립 재확인할 수 있다.',lesson:'패키지 등록만으로 G verifier가 자동 호출되지 않았다. tool별 critical 검사·Core authority fence·원격 executor 분리를 함께 연결해야 한다.',limitations:'준비된caseId/store/revision 인수의 실제 테스트CoreE/B/G와 합성 자료87회귀. 자유자연어/전체Mission/실공급자/설치EXE 미완료. 비용/p50p95미측정,공식60%유지.'},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 선택생활업무read capability/trusted CoreE/B/G/remoteexecutor분리,첫G미호출3반례수정,87회귀/build/contract. 공식60/23/17 유지. 다음 selected case 요구계약·read-only Mission·현재 결과 표시,실공급자 준비도. 자유자연어 해석 완료로 주장하지 않음.\n`);
