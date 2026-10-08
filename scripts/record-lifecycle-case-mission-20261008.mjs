import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-mission-20261008',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-regression.txt','utf8');if(!log.includes('ℹ pass 98')||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0'))throw Error('Final regression required');
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS')||!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('Build/contract required');
const sources=['packages/core/src/personal-operations/lifecycle-case-read.js','packages/core/src/mission/lifecycle-case-result.js','packages/core/src/mission/mission-runtime.js','packages/core/src/main.mjs','apps/runtime-compose/src/lifecycle-case-capability-package.js','apps/runtime-compose/src/create-runtime.js','tests/lifecycle-case-mission.test.js','docs/lifecycle-cases.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 선택한 생활 업무의 전체 Mission·현재 결과 API

관측 ${observedAt}. 직전 Core/E/B/G case.readLocalRecord 패키지를 전체 Mission의 생성·원문/선택 결속·계획·criterion·완료·현재 결과 조회에 연결했다. 로컬 기록 조회의 종단 경로이며 실제 배송·환불·민원 처리 기능은 아니다.

선택 계약은 caseId/expectedStoreId/expectedRevision3필드이며 idempotency 요청 해시에 포함된다. “선택한 생활 업무의 로컬 기록과 마감을 조회해.” 같은 제한된 전체 문장을 받아 원문+선택 계약 해시를 저장한다. 문법 밖 추가 취소/발송/완료 주장 지시는 부분 실행하지 않고 생성 거절한다. constraints/다른 성공 기준/알 수 없는 verificationSpec/goal 정정으로 계약이 깨지면 계획을 보류한다. selectedSource와 혼합하지 않는다. 조건을 몰래 버리고 일부만 수행하지 않는다. 자유로운 모든 자연어의 해석이나 단일 PC 밖 서비스 성공률로 확대하지 않는다.

계획은 읽기1동작이며 기존 Mission→E→B→G를 거친다. 완료 오라클은 actual/expected tool, 실제 dispatch/task 인수, task 상태·독립G critical 검사, action·observation/evidence ID, goal/authorization revision과 읽은 영수증hash를 묶는다. 현재 Core 원장을 다시 읽고 권한을 전후 확인한다. 다른 행동/중복 행동은 결과를 무효로 만든다. goal completion coverage는 이 전체 계약으로 계산하며 semanticAccuracyVerified는 false다. 조회 완료와 공급자 완료·사람의 실제 열람을 구분한다.

ADMIN GET /missions/:missionId/verified-lifecycle-case를 추가했다. 실제 HTTP create201→run COMPLETED→현재 결과 verified/no-store를 검사했다. 미인증401, 원장 변경 후 unverified/내용 미포함도 확인했다. 완료 뒤 원장·권한·원문이 바뀌거나 영수증이 위조/외부 행동이 삽입되면 조회를 거절한다. 과거 Mission 이력을 현재 상태의 완료 증거로 재사용하지 않는다. B 읽는 중 실제 cancelMission 호출은 CANCELLED를 유지하고 결과를 공개하지 않았다. 원장 revision/외부 효과 변경0이다.

최종 공유9파일98/98 실패0·생략0. 신규10검사: 전체 한국어 bounded Mission·동일키 재생, 완료후 변경·철회·취소상태·위조영수증·외부행동·목표변경, 실행중 실제취소, 미지원추가지시/다른성공기준, 실제HTTP생성/실행/조회/변경후비공개. 기존 capability/reload/page/lifecycle/source-result/source-capability/개인업무/workspace와 함께 검증했다. build/Core contract gate 통과. 새 UI는 변경하지 않아 브라우저 QA를 이번 성과로 추가하지 않는다.

첫 HTTP 시험은 별개 ownerSessionManager를 fixture 서버에 생성해 활성 소유자 세션409를 받았다. 동일 runtime manager를 서버 옵션으로 연결하여 해결했으며 권한 검사나 승인을 완화하지 않았다. http-first.txt에 실패를 남겼다. 개인정보·실계정·운영F/cognition은 테스트에 쓰지 않고 임시 ops/growth DB만 사용했다. 유료 모델·외부 공급자 호출0, 실사용 비용/p50/p95는 미측정이다.

남은 조건: 선택 대상/권한과 최종 결과 화면 연결, 운영 runtime에 host-reviewed 접근 활성화, 재시작 후 영수증 복구·새 소유자 세션의 역사적 결과 재조회, 자유로운 자연어 요구 전체 해석, 실제 공급자 상태·취소·접수/환불대사·계정 파일럿. 이 제한형 API를 설치 EXE 업데이트나 외부 공급자 능력으로 주장하지 않는다. 현재 소유자 세션 만료/사라진 task 영수증은 보류하며 추측 복원하지 않는다.

공식 인수60/23/17 유지. V3-077 전체 공급자/생활 범위를 이 로컬 종단 조회로 승격하지 않는다. 복원은 Mission 선택·계획·오라클·결과 API를 함께 제거하는 좁은 변경이며 기존 개인 업무/요청키/영수증은 삭제하지 않는다. 다음은 밝은 사용자 화면에서 선택 업무의 요청·검증된 현재 결과를 연결하고 재시작·새 세션 경계를 실제로 증명하는 것이다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-http-first.txt','-http-final.txt','-regression.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Acceptance changed');
for(const id of ['V3-029','V3-041','V3-077']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 선택case bounded한국어 전체Mission/current-result API·실HTTP/실취소/원장변경미공개,98회귀/build/contract. 자유자연어/UI·실공급자·재시작역사영수증/새세션·운영설치본 미완료,인수60%유지.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-mission-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'원문·선택 원장·버전에 결속된 로컬 기록 읽기를 전체Mission criterion과 현재 결과 API에 연결하면 과거 완료를 변경된 자료/권한의 증거로 재사용하지 않는다.',lesson:'G 통과만으로 Mission 완료를 인정하지 않고 실제 dispatch/task/observation/목표/권한과 현재 Core 원장까지 다시 비교한다. HTTP와 Mission은 같은 owner session manager를 공유해야 한다.',limitations:'제한한국어 문법/선택인수·실제테스트CoreE/B/GHTTP98회귀. 자유자연어/UI·실공급자·재시작/새세션·운영설치본 미완료. 비용/p50p95미측정,공식60%유지.'},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: selected-case bounded한국어전체Mission/current-result API·실HTTP/실취소/원장변경미공개,98회귀/build/contract. 공식60/23/17 유지. 다음 밝은 선택업무Mission결과UI와 재시작/새세션 경계. 자유자연어/실공급자 완료로 확대하지 않음.\n`);
