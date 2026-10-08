import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/clarification-restored-answers-20261008',observedAt=new Date().toISOString();
const candidateId='agent-platform-observed-scenario-status';
if(!runResearchLedger(['status']).candidates.some(c=>c.id===candidateId))throw Error('KNOWN_CANDIDATE_REQUIRED');
const write=(path,value)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const baseline=await readFile(prefix+'-baseline.txt','utf8'),tests=await readFile(prefix+'-verified-tests.txt','utf8');
if(!baseline.includes('ℹ fail 4'))throw Error('BASELINE_REQUIRED');
for(const marker of ['ℹ pass 66','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!tests.includes(marker))throw Error('TEST_REQUIRED:'+marker);
for(const mode of ['restored-empty-answer','restored-number-answer','restored-whitespace-answer']){
 if(!tests.includes(JSON.stringify({mode,afterValidAnswer:'COMPLETED',reads:2,writes:1,preservedHistoricalAnswer:true})))throw Error('REAL_COMPLETION_REQUIRED:'+mode);
 if(!tests.includes(`"mode":"${mode}","status":"WAITING_APPROVAL","actualCoreEBG":true,"actualSQL":true,"reads":2,"writes":0`))throw Error('REAL_WAIT_REQUIRED:'+mode);
}
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS executive console'))throw Error('BUILD_REQUIRED');
if(!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
const sources=['packages/core/src/mission/clarification-context.js','packages/core/src/mission/mission-clarification.js','packages/core/src/mission/mission-runtime.js',
 'tests/clarification-context.test.js','tests/clarification-source-boundary.test.js'];
await write(prefix+'-source.json',await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
const acceptance='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/,'')),gates=a.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(s=>[s,gates.filter(g=>g.status===s).length]));
await write(prefix+'-report.md',`# 복구된 확인 답변의 유효성 수정\n\n관측 ${observedAt}. 공식 인수 ${counts.verified}/100, 진행 중 ${counts.in_progress}, 대기 ${counts.pending}.\n\n이전 작업은 의미 정답의 검토 경계를 보강했다. 이번에는 실제 Core의 질문 정보 재사용 경로를 수정했다. 원문 hash와 목표 버전이 일치해도, 저장된 승인 기록에 빈 답변·숫자 답변·공백 답변이 있으면 이를 현재 답변으로 재사용했다. 3개의 실제 Core/E/PC/G 및 SQLite 실행 모두 필요한 질문을 없애고 repeated-plan-stall-detected로 BLOCKED가 됐다. 단위 검사1개를 포함한 수정 전23검사 중4실패를 보존했다. 이는 실제 사용자의 기록이 손상되었다는 관측이 아니라 격리된 복구 반례의 제품 결함이다.\n\n이제 저장된 묶음 질문·답변도 실제 승인 시 사용하던 동일한 질문/답변 계약으로 검사한다. 질문 개수·중복·형식, 답변 개수·공백·문자형·개별500자·총2000자 한도를 지키지 않는 기록은 답변으로 사용하지 않는다. 옛 기록을 삭제하거나 정상 승인으로 고쳐 쓰지 않는다. 단일 자유 답변도 질문500자/답변2000자 및 빈 값 경계를 검사한다. 유효한 현재 답변과 원문에 명시된 사실의 재사용은 유지한다. 실행 권한은 늘리지 않았다.\n\n최종 **66개 고유 검사 통과, 실패0·건너뜀0·취소0**, build와 Core API 계약 검사 통과. 중간 재실행 검사 수는 합산하지 않는다. 3복구 반례 모두 독립 읽기2회·작성0회 상태로 질문1묶음 WAITING_APPROVAL 유지, 반복 실행도 같은 질문/읽기 횟수 유지. 유효한 답변 후 각각 실제 파일 생성1회·내용 재조회/G 검증으로 COMPLETED가 됐고, SQLite에 원래 잘못된 답변을 그대로 보존했다. 합성 자료·계정/LLM 미사용이며 개인 기억을 시험 자료에 복제하지 않았다.\n\n계획기는 이 반례에서 scripted다. 일반 자연어의 모든 질문 필요성이나 답변의 의미 정확성, 설치본 활성화, 실계정/실기기, 실제 사용자 개입률·p50/p95·비용을 입증하지 않는다. 비용은 미측정이다. 최신 PC 후보는 이번 소스 변경 이후 다시 빌드·설치 검증이 필요하다. 복원은 이전 증거 스냅샷의 해당 소스를 검토해 적용하고 동일 회귀를 다시 수행하는 방식이며, 정상 현재 답변을 제거하는 원장 변경은 하지 않는다.\n\nV3-020 부분 증거로 연결하고 공식 인수율을 올리지 않았다. 다음은 실제 모델의 질문 필요성·복합 요구 검증과 독립 의미 코퍼스 검토/실제 연결 조건 충족을 병행한다.\n`);
const evidencePaths=[prefix+'-report.md',prefix+'-baseline.txt',prefix+'-verified-tests.txt',prefix+'-source.json',prefix+'-build.txt',prefix+'-contract.txt'];
await write(prefix+'-attempt.json',{id:'clarification-restored-answers-20261008',candidateId,kind:'workflow-test',reportedOutcome:'passed',observedAt,
 hypothesis:'A restored approval is usable information only when its questions and answers satisfy the same bounded contract as a live approval.',
 lesson:'Three actual Core/SQL malformed answer flows stalled before the fix. Validate whole batches, preserve history, retain independent reads and a current pending question, then complete only after valid input.',
 limitations:'66 local regressions, scripted planning and actual Core/E/PC/G/SQL; no real model/general meaning/installed activation/real account acceptance. Product latency and cost unmeasured.',evidencePaths});
const gate=gates.find(g=>g.id==='V3-020');gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08 복구된 빈/숫자/공백 승인답변3실제stall 수정,독립읽기2/작성0/질문묶음 유지·유효답변후파일1/G완료·66회귀. 일반모델 질문필요성·독립의미·설치본·실사용개입률 미완료.'];
a.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(a,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 복구 승인답변3실제stall 수정/같은질문·독립읽기유지·유효답변후G완료,66고유검사/build/contract. 공식${counts.verified}/100 유지. 다음 실제모델 질문필요성/복합요구 및 독립의미검토·연결조건.\n`);
console.log(JSON.stringify({counts,record:runResearchLedger(['record',prefix+'-attempt.json'])}));
