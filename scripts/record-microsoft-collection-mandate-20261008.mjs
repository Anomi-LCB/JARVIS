import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/microsoft-collection-mandate-20261008',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final.txt','utf8');
if(!log.includes('ℹ pass 72')||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0')||!log.includes('ℹ cancelled 0'))throw Error('PASS_REQUIRED');
if(!(await readFile(prefix+'-before.txt','utf8')).includes('2 !== 1'))throw Error('REPRO_REQUIRED');
for(const [suffix,marker] of [['-build.txt','Built static JARVIS'],['-contract.txt','gatePassed: true']])if(!(await readFile(prefix+suffix,'utf8')).includes(marker))throw Error('BUILD_REQUIRED');
const paths=['packages/core/src/personal-operations/microsoft-collection-request.js','packages/core/src/personal-operations/local-mandate-observation.js','packages/core/src/personal-operations/mission-budget-gate.js','apps/runtime-compose/src/microsoft-collection-capability-package.js','apps/runtime-compose/src/microsoft-collection-access.js','tests/microsoft-collection-capability.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# Microsoft 직접 수집의 자료 위임과 현재 실행 경계',observedAt,'공식 '+JSON.stringify(counts)+'/100 유지.',
'## 구현',
'Microsoft metadata 수집의 공급자·연결 ID·선택 Teams chat를 고정한 microsoft-metadata:<sha256> 자료 참조를 추가했다. 다른 연결, 다른 공급자, 다른 chat는 별개의 자료 범위다. 같은 선택 자료의 다음 페이지 cursor는 범위가 같다. 이는 본문·첨부·발송·권한 변경 권한이 아니다. cursor의 공식 Graph 경로·쿼리 제한은 기존 reader가 계속 검사한다.',
'normalizer를 Core 계약으로 이동하고 기존 앱 export를 유지했다. 일반 JSON 데이터 속성만 캡처하며 getter·비열거 속성·symbol·사용자 주장 dataRefs·알 수 없는 인수를 거절한다. 모델이 권한 자료 ID를 선언하게 하지 않고 실제 실행 인수에서만 자료 참조를 계산한다.',
'MissionBudgetGate의 beforeAction/SQL quota와 withMissionMandateFence를 그대로 사용한다. 같은 current scope 검사를 읽기 결과 확인에도 지원한다. prepared action task의 실제 Core/E/B/G 실행은 quota reservation이 있는 scoped Mission context에서 검사했다. 아직 자유 자연어 전체 Mission 요구 계약이나 영속 effect 구현을 마친 것은 아니다.',
'## 실제 실패와 수정',
'새 범위 반례 중 토큰 응답 직후 위임을 철회하면 두 공급자 모두 Graph 요청이 추가로 발생했다. before19검사 중17통과/2실패, 실제2호출≠기대1호출을 보존했다. 이전 private provider policy에는 연결 권한만 남고 B의 현재 위임 fence가 없었다.',
'이제 providerPolicy가 수집 중 every reader authorization boundary에서 현재 B/위임 fence도 검사한다. SQL commit proof와 commit callback까지 이 경계를 유지한다. SQL commit이 검증된 뒤만 committedPhase로 전환하며, G 단계에는 consumed B packet을 실행 권한으로 재사용하지 않고 현재 trusted task/connection policy와 기존 G mandate fence를 적용한다. committedPhase는 host closure에만 있으며 모델/로그/JSON에서 조작할 수 없다. provider scope·금액·예산 제한을 늘리지 않았다.',
'## 검증',
'최종72개 고유 검사, 실패/skip/cancel0. 신규 수집 시험19개: 두 공급자마다 정상·OAuth 연결 철회·B SQL 변조·연결 미준비·G 직전 SQL 변조·범위 안 quota·다른 연결 범위·명시 deny·토큰 뒤 위임 철회, 그리고 자료 신원/비정상 JSON1개. 정상 quota 각각 token+Graph2호출/실SQL1행/G passed. 다른 연결/deny는 호출0. 토큰 뒤 위임 철회는 token1호출/Graph0/SQL0. 실제 reader/SQLite/Core/E/B/G이며 OAuth/Graph 응답은 합성이다. 기존 Microsoft refresh 및 selected-source mandate 반례와 함께 회귀했다. 이전19/65/58/45검사를72에 더하지 않는다. build/Core contract gate 통과.',
'## 남은 구현과 준비',
'위임·자료 범위 부분이 연결됐지만 전체 자연어 원문→계획→operation/effect ID→B 영속 영수증→현재 최종 결과 및 새PID 복구는 미완료다. 현재 수집 private proof cache는 영속 복구 증거가 아니다. 다음은 이 실행 효과와 별도 bounded Mission 계약을 연결하고 uncertain 시 공급자 재호출 없이 SQL/영수증을 대사하는 것이다.',
'실계정 OAuth/연결 probe/본문/첨부/발송/장기 실사용/설치 UI는 여전히 미확인. F/cognition·사용자 자료·운영 자격증명은 변경하지 않았다. 외부 유료 호출0, 실제 비용·제품p50/p95 미측정. 인수 V3-032/033/040/073에 부분 증거만 연결하고60%를 유지한다. 복원은 새 수집 도구 활성화를 중지하고 코드 경계를 함께 검토하며 저장된 사용자 자료를 자동 삭제하지 않는다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-before.txt','-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'microsoft-collection-mandate-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'실제 Microsoft 대상 자료 신원과 현재 SQL 위임을 공급자 요청·commit·G 경계에 연결하면 토큰 이후 철회와 다른 연결의 접근을 막을 수 있다.',lesson:'연결 OAuth 상태가 유효해도 현재 작업 위임은 별도로 철회될 수 있다. 실행 B fence를 조회 중에는 유지하고 G 때 consumed packet을 재사용하지 않는 시점을 구분해야 한다.',limitations:'prepared task+scopedMissioncontext/실CoreEBGSQL/Graph합성72검사. 전체자연어Mission/effect영속/새PID/실계정/probe/제품활성화 미완료. 비용·제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-032','V3-033','V3-040','V3-073']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: Microsoft 수집 실제 인수 기반 자료quota·다른연결/deny/토큰뒤위임철회 차단,72회귀. 전체Mission/effect/새PID/실계정은 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: Microsoft scope/quota·공급자 호출 전후 위임 fence/토큰직후철회 결함수정·72검사/build/contract. 공식'+counts.verified+'/100 유지. 다음 bounded Mission와 operation/effect/B영속영수증/재시작 대사.\n');
console.log(JSON.stringify({counts,passed:72}));
