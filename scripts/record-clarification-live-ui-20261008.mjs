import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/clarification-live-ui-20261008',observedAt=new Date().toISOString();
const readJson=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/u,''));
const baseline=await readJson(prefix+'-baseline/result.json'),positive=await readJson(prefix+'-verified/result.json'),revision=await readJson(prefix+'-final-browser/result.json'),cancel=await readJson(prefix+'-cancel/result.json');
if(baseline.views.length!==2||baseline.views.some(v=>!v.lost))throw Error('BASELINE_LOSS_REQUIRED');
for(const result of [positive,revision])if(result.views.length!==2||result.views.some(v=>v.status!=='COMPLETED'||v.reads!==1||v.writes!==1||v.answerRequests!==1||v.missingAnswerRequests!==0||v.pageErrors.length||v.horizontalOverflowPx))throw Error('UI_COMPLETION_REQUIRED');
if(revision.views.some(v=>!v.revisionDraftCleared)||cancel.views.some(v=>v.status!=='CANCELLED'||v.writes!==0||v.answerRequests!==0||v.rejectRequests!==1||!v.reloadNoExecution))throw Error('UI_REVISION_CANCEL_REQUIRED');
const log=await readFile(prefix+'-final-verified-tests.txt','utf8');for(const marker of ['ℹ pass 77','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!log.includes(marker))throw Error('TEST_REQUIRED:'+marker);
if(!(await readFile(prefix+'-verified-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
const paths=['src/ui/workspace/app.js','src/ui/workspace/clarification-drafts.js','src/ui/mission-goal-editor.js','tests/clarification-drafts.test.js','tests/ui-mission-goal-editor.test.js','tests/pc-ui-payload.test.js','tests/fixtures/clarification-live-browser.mjs','scripts/clarification-live-browser-qa.py','scripts/record-clarification-live-ui-20261008.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2)+'\n',{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=await readJson(acceptance),gates=doc.stages.flatMap(s=>s.gates),counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
 '# 실제 화면의 묶음 질문·정정·취소 실행',
 `관측 ${observedAt}. 공식 ${counts.verified}/100 유지. 이번에는 원래 V3-020의 UI 부분을 실제 Core/E/PC/G와 SQLite에 연결했다.`,
 '## 발견한 문제와 구현',
 '직전 불변 PC 후보의 검증된 UI payload와 현재 실제 Core를 연결해 PC1440·모바일390 화면에서 새로고침 후 입력 중인 답변 두 개가 모두 빈 값이 되는 것을 재현했다. 수정 UI는 페이지 메모리에만 초안을 보관하며 Mission·원문·gate·revision·원문hash·질문순서가 바뀌면 지운다. 응답은 localStorage/sessionStorage·로그·API에 자동 보관하거나 제출하지 않는다. 같은 화면 상태 확인에서 입력과 focus를 유지하고 입력 완료 후 명시적인 제출만 수행한다.',
 '정정 시험에서 실제 Core가 goal-revision-criteria-review로 남고 기본 UI에는 효과 없는 재개 버튼만 있던 부족도 확인했다. 현재 완료 기준을 보여주고 이번 수정에도 그대로 적용할지 선택하도록 연결했다. 사용자가 확인하면 원래 verificationSpec을 포함한 객체 전체를 보존해 기존 CAS/idempotency 경로로 보낸다. 확인하지 않은 상태는 재개 버튼 대신 완료 기준 확인과 수정 화면으로 이동하는 버튼을 제공한다. 검증 기준을 제거하거나 문자열로 낮추지 않으며 권한을 추가하지 않는다.',
 '## 종단 실행 증거',
 '합성 파일과 scripted 계획기를 사용했지만 HTTP/API 응답이나 UI 렌더러를 가로채지 않았다. 격리 production-mode 구성 Core·DPAPI 보호키·SQLite·실제 파일·E 정책·PC 실행·G 내용 검증을 사용했다. 기본 승인2화면, 정정2화면, 거절2화면을 관측했다. 각 정상 완료는 독립 읽기1회·쓰기1회·질문2개 한 묶음·답변POST1회다. 미입력 답변은 POST0. 화면 상태 확인은 추가 읽기/쓰기/답변0이다. 화면 reload 후에도 추가 실행0이며 실제 내용은 검증 보고/항목 전체/관측3건과 일치했다.',
 '정정2화면은 먼저 기준 미확인 상태로 revision2·PAUSED·쓰기0·재개버튼없음을 확인하고, 기준 확인으로 revision3를 저장했다. 기존 verifier 객체가 동일하며 새 gate의 초안은 빈 값이다. 새 답변을 한 번 제출한 뒤 COMPLETED로 완료했다. 거절2화면은 CANCELLED·읽기1·쓰기0·파일없음·답변전송0·거절POST1, reload 후 실행0을 확인했다. 콘솔 오류와 정상/정정 화면 가로 넘침은0이다. screenshots를 직접 살펴 밝은 화면·입력·결과 상태를 확인했다.',
 '관련8파일 고유77검사 통과·실패0·skip0·cancel0, build 및 Core 계약 통과. 집중·중간 로그의 같은 검사는 합산하지 않는다. Python 실제 UI6흐름과 baseline2관측은 Node 검사 수와 별도다. 제품 p50/p95·실제 비용은 미측정이다. 이전 고정96실행 비교 결과를 이번 UI 성능 향상으로 계산하지 않는다.',
 '## 실패 기록과 한계',
 '첫 시험 fixture는 planner context에 공개되지 않은 gates를 읽어 준비에 실패했고, 큰 stderr를 pipe로 둬 준비 출력이 막혔다. 실제 runtime의 Mission gate를 읽고 stderr를 파일로 보존하도록 바로잡았다. 이후 정정 첫 실행은 실제 criteria-review 상태에서 대기해 시간초과했다. failure-state.json과 screenshot·로그를 보존한 뒤 위 UI 복구 경로를 구현했다. 성공한 기준 확인 및 거절은 새 artifact 경로로 기록했다.',
 'Core 재시작/Windows 재부팅·설치된 PC 프로그램·실계정·실모델 의미 판단·일반 질문 필요성·사용자 개입의 장기 감소는 이번 시험에 포함되지 않는다. browser reload는 Core PID 재시작이 아니다. 기존 후보를 덮어쓰거나 운영 서비스를 재시작하지 않았다. 실제 사용자 F/cognition·자격증명은 변경하지 않았고 외부 발송·유료 호출0이다. 신규 module의 PC UI payload 포함을 검사했지만 새 설치 EXE는 이번에 만들지 않았다.',
 '## 다음 인수와 복원',
 '다음은 이 실제 화면의 질문 처리와 Core 재시작을 연결하는 운영 복구, 일반 질문 필요성의 독립 의미 평가다. V3-020 전체 인수를 통과했다고 표시하지 않는다. 복원 시 app.js·draft 모듈·goal-editor를 함께 이전 버전으로 검토하고 새로고침 답변 손실 및 기준 확인 복구 반례를 유지한다. Paperclip의 입력 유지와 상황에 맞는 다음 행동 표시 원칙을 참고해 불필요한 재입력과 효과 없는 재개를 줄였다.'
].join('\n\n')+'\n',{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-final-verified-tests.txt','-verified-build.txt','-verified-contract.txt','-baseline/result.json','-verified/result.json','-final-browser/result.json','-cancel/result.json','-revision-debug/desktop-failure-state.json','-revision-debug.txt','-final-browser.txt','-cancel.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'clarification-live-ui-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제 UI/Core/SQL의 묶음 질문·정정·취소를 연결하면 답변 초안 손실과 완료 기준 확인이 빠진 재개 경로를 수정하면서 독립 읽기·G 검증·기존 권한을 유지할 수 있다.',
 lesson:'모의 gate 응답 검사는 실제 Core의 criteria-review 상태나 verifier 보존을 확인하지 않는다. 현재 request에 묶인 초안만 유지하고 명시 확인된 기존 검증 계약을 보존해야 한다.',
 limitations:'77관련Node검사/실제UI6흐름/불변후보baseline2화면. scripted 계획·합성 파일·실계정/설치본/별도PID재시작/일반 의미/장기관측 미완료. 공식60/100 유지·비용/제품지연 미측정.'},null,2)+'\n',{flag:'wx'});
const gate=gates.find(g=>g.id==='V3-020');gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 실제UI/Core/E/PC/G/SQL 묶음질문·정정·거절6화면/77검사. 답변refresh손실과 criteria-review UI dead-end 수정. verifier 객체/권한 보존,설치본/별도PID/일반 의미/장기개입률 미완료.');
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제UI 묶음질문·정정·거절6화면/77검사,답변손실·기준확인UI복구 수정. 공식 ${counts.verified}/100 유지. 다음 실제Core 재시작 UI복구와 독립 의미 인수.\n`);
console.log(JSON.stringify({counts,tests:77,browserFlows:6,baselineViews:2,installed:false}));
