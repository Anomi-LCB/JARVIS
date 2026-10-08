import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {runResearchLedger} from './research-ledger.mjs';
const dir='artifacts/local-model-clarification-20261008',prefix=dir+'-completion',observedAt=new Date().toISOString(),candidateId='local-ollama-mission-provider';
if(!runResearchLedger(['status']).candidates.some(c=>c.id===candidateId))throw Error('KNOWN_CANDIDATE_REQUIRED');
const write=(path,value)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const r=JSON.parse(await readFile(dir+'/result.json','utf8')),s=r.summary;
const failures=await Promise.all([0,1].map(async i=>JSON.parse(await readFile(`${dir}/failure-${i}.json`,'utf8'))));
if(s.status!=='BLOCKED'||s.outcome!=='failed'||s.calls.length||!s.sourcePreserved||!s.protectedPreserved
 ||s.actualModelCalls!==2||failures.some(f=>f.code!=='A_LOCAL_MODEL_TRANSPORT_ERROR'||f.diagnostics.providerCalls!==2))throw Error('FINAL_FAILURE_EVIDENCE_REQUIRED');
await write(prefix+'-report.md',`# 실제 로컬 모델 계획 실험 종료: 실패\n\n관측 ${observedAt}. 소유 실행 handle60030은 exit0으로 종료됐다. 프로세스의 정상 종료는 업무 성공이 아니며 실제 Mission 결과는 **BLOCKED/failed**다.\n\n합성 요청은 “'source.txt'를 읽어; 'protected.txt'는 삭제하지 마”였다. gemma3:latest 4.3B Q4_K_M 실제 로컬 모델과 현재 GoalExecutivePlanner/Core를 연결했다. 결정형 계획 우회를 제외한 격리 비교 구성으로, 제품 기본 설정 전체가 이 방식으로 실행된다는 뜻은 아니다. 모델 digest와 구성은 contract.json, 실제 프롬프트는 request-0/1.json에 있다.\n\n첫 응답은 ${Math.round(failures[0].receipt.latencyMs)}ms, 두 번째는 ${Math.round(failures[1].receipt.latencyMs)}ms 뒤 전송 실패. 전체 ${Math.round(s.elapsedMs)}ms. 두 계획 시도에 목록확인/생성 HTTP 호출 각각2회가 관측됐고 최초 준비도 목록조회1회는 이 집계 밖이다. 토큰과 실제 비용은 미측정이며 0이 아니다. 303초 간격은 특정 클라이언트 제한의 조사 근거지만, 세부 cause 코드를 원래 기록하지 않아 headers timeout/서버 처리/소켓 문제 중 정확한 원인은 아직 확정할 수 없다.\n\n첫 실패 후 기존 안전 대체 경로는 요청 전체를 단일 작업 경로로 넘겼지만 정책/목표 경계에서 차단됐다. 실제 도구 호출0·파일읽기0·쓰기/삭제0. 원본과 보호 파일 내용은 실제 재조회로 보존됨을 확인했다. G 완료 검증은 수행되지 않았다. result.json의 actualCoreEBG:true는 연결된 런타임 구성 표식이며 E/B/G 종단 완료의 증거가 아니다. 질문0은 질문 필요성 검사 통과가 아니라 모델 계획 미생성 상태다.\n\n프로세스는 수정 전 모델 계층을 이미 import한 상태였으므로 실패 receipt의 누락은 그대로 남는다. 실험 중 수정한 호출/토큰 기록은 새 프로세스에 적용되며 별도91회귀 증거로 검증했다. 당시 로드된 소스는 sources-before-meter-fix.json을 기준으로 삼고 종료 후 현재 파일 hashes인 sources.json을 소급 로드된 코드로 해석하지 않는다. 예산 옵션 오타는 다음 실행용만 수정했으며 이번 실제 Mission budgets는 result.json의 원래 값 그대로 보존한다.\n\n개인 자료·실계정·cloud 모델·유료 호출을 사용하지 않았다. 격리 Core와 임시 자료는 정상 종료/정리됐고 사용자가 운영하는 기존 Ollama 프로세스는 종료하거나 언로드하지 않았다.\n\n공식 **60/100 유지**. 이 사례를 완료율·의미정확도·실사용속도 상승으로 세지 않는다. 다음: 비밀정보 없는 전송 cause 계측 → 실제 요청/서버 상태 대조 → 제한을 유지한 전송 방식 비교 → 같은 원문/금지/파일 오라클로 재실행. 필요시 모델·하드웨어 또는 승인된 외부 후보를 비교하며 원문·도구·검증 기준을 줄여서 통과시키지 않는다.\n`);
const evidencePaths=[prefix+'-report.md',dir+'/contract.json',dir+'/result.json',dir+'/failure-0.json',dir+'/failure-1.json',
 dir+'/plan-0.json',dir+'/plan-1.json',dir+'/sources-before-meter-fix.json'];
await write(prefix+'-attempt.json',{id:'local-model-clarification-failure-20261008',candidateId,kind:'workflow-test',reportedOutcome:'failed',observedAt,
 hypothesis:'The installed local model can preserve an explicit read target and deletion prohibition through the real Mission planning and execution path.',
 lesson:'Two actual generation responses failed at roughly303s; Mission BLOCKED, tool calls0, both files preserved. Process exit0 is not task success; no semantics score was produced.',
 limitations:'One known synthetic case, forced model route, old pre-fix receipt module cached; exact transport cause unmeasured. No G completion, no live account or independent meaning acceptance.',evidencePaths});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
for(const id of ['V3-020','V3-022']){const gate=a.stages.flatMap(s=>s.gates).find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
 gate.limitations=[...(gate.limitations??[]),'2026-10-08 로컬 실모델2회 각303초응답실패,606초BLOCKED·도구0/파일보존/G완료없음. handle60030 exit0종료. 질문0은 필요성통과아님. 전송원인·모델실사용검증 남음.'];}
a.updatedAt=observedAt;await writeFile(path,JSON.stringify(a,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실로컬모델2응답각303초 실패/총606초BLOCKED·도구0/파일보존,handle60030 exit0종료(더 이상 대기하지 말 것). 공식60/100 유지. 다음 비밀없는전송cause계측·원인대조·동일원문오라클재실행.\n`);
console.log(JSON.stringify(runResearchLedger(['record',prefix+'-attempt.json'])));
