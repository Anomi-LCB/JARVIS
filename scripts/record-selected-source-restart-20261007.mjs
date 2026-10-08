import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/selected-source-restart-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(s,v)=>writeFileSync(`${prefix}-${s}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
for(const [suffix,count] of [['final.txt',155],['additional-final.txt',15]]){
 const log=read(`${prefix}-${suffix}`);for(const [k,v] of [['tests',count],['pass',count],['fail',0],['skipped',0]])assert.match(log,new RegExp(`ℹ ${k} ${v}(?:\\r?\\n|$)`));
}
for(const suffix of ['runner.json','additional-final-runner.json'])assert.equal(JSON.parse(read(`${prefix}-${suffix}`)).status,'passed');
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const browser=JSON.parse(read(`${prefix}-browser/result.json`));assert.equal(browser.cases.length,2);assert.ok(browser.cases.every(c=>c.revokedContentHidden&&c.pageErrors.length===0));
const paths=['packages/core/src/mission/selected-source-task-receipts.js','apps/runtime-compose/src/selected-source-service-access.js',
 'packages/core/src/mission/mission-runtime.js','packages/core/src/mission/selected-source-result.js','packages/core/src/main.mjs',
 'packages/core/contracts/core-openapi.json','src/ui/connections/selected-sources.js','tests/selected-source-restart.test.js',
 'tests/fixtures/selected-source-restart-child.mjs','tests/selected-source-result.test.js','tests/selected-sources-ui.test.js'];
// OpenAPI lives at the checked-in contract path discovered by the gate.
const sourcePaths=paths.filter(p=>p!=='packages/core/contracts/core-openapi.json');
write('source.json',{observedAt,files:sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,uniqueTests:157,testExecutions:170,repeatedTests:13,failed:0,skipped:0,unsafeControlCases:1,
 restartCases:9,newChildProcesses:18,protectedKeyProvider:'windows-dpapi-current-user',actualCoreHTTP:true,actualSQLite:true,
 recoveredResultRequiresCurrentReadSession:true,originalExecutionAuthorizationUnchanged:true,newBExecutionsDuringRecovery:0,
 browserCases:2,externalProviderCalls:0,productionActivation:false,installedProgramUpdated:false,formalVerified:59,
 actualCost:null,productLatency:null});
write('report.md',`# 선택 저장 자료의 새 프로세스 복원과 현재 읽기 권한

관측 ${observedAt}. 공식 인수 59/100 유지. 이번 범위는 실제 Core 구성·HTTP·SQLite·Windows 보호 키를 사용하는 격리 실행이다.

## 실제 동작

선택 자료 Mission의 실제 B 실행과 G 검증이 끝나면 Core가 목적별 서명 영수증을 저장한다. 원문·계정 문자열·토큰을 복제하지 않고 원래 요구, 실행 권한, 자료 위임, action/task/dispatch, 관측 및 G 검증 ID와 결과 해시를 결속한다. 일반 Mission 완료 문자열이나 서명 없는 worker snapshot을 G 증거로 승격하지 않는다.

다른 PID의 Core는 보호된 지속 키로 과거 영수증을 확인하고 현재 SQL 자료를 다시 읽어 대조한다. 과거 G는 인증된 역사적 검증이고 새 G 실행이라고 부르지 않는다. 만료된 기존 owner 실행 권한을 되살리지 않는다. 명시적으로 활성화된 현재 read_only owner를 결과 조회 POST에 전달해야 하며 원래 Mission 권한·실행 횟수는 바뀌지 않는다. 자료 위임·준비도·Core 권위 검사도 그대로 적용한다. UI도 이미 활성화된 owner를 사용하며 임의로 세션을 활성화하지 않는다.

보호 키는 기존 Windows DPAPI current-user 경로를 재사용한다. DPAPI는 일반적으로 동일 사용자·컴퓨터에 결속되므로 이 증거를 다른 PC나 Linux 이식 성공으로 확대하지 않는다. [Microsoft 원문](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata). 영수증 JSON 자체는 서명된 메타데이터이며 암호화된 자료 저장소를 새로 구현한 것이 아니다.

## 검증과 반례

9개 독립 새 PID 사례에서 생성 프로세스 종료 뒤 다른 프로세스를 시작했다(18 child processes, Windows DPAPI 실제 사용). 양성1개는 현재 read_only 세션으로 결과1건을 대조했다. 자료 정정, 서명 변조, 영수증 누락, 원래 실행 권한 변조, 자료 위임 철회, read_only 부재, 준비도 철회, 관측 증거 변조8개는 결과를 숨겼다. 모든 복원에서 새 B 요청0, 실행 횟수1 유지, 원래 권한 변경0을 확인했다. 보호 키가 없으면 복원을 허용하지 않는다.

추가 HTTP 검사는 알 수 없는 session, 미인증 POST, 잘못된 타입·추가 grants 필드를 차단하고 허용된 읽기는 실제 결과를 반환했다. source 목표에 외부 도구 action을 끼워 넣으면 실패한다. 공유155개와 추가15개가 통과했다(고유157개·반복13개·총170회, 실패0·건너뜀0). 기존 위험 보호 제거 대조군1개는 허위 완료 재현이며 실제 업무 성공으로 계산하지 않는다. build와 OpenAPI baseline gate 통과.

실제 Chrome 1440/390 폭에서 Core HTTP/SQLite/Mission을 통해 합성자료51건의50+1페이지와 철회 후 숨김을 확인했다. 공급자 호출0·화면 오류0. UI의 새 POST 권한 전달은 단위 검사와 실제 브라우저에서 함께 확인했다. 레이아웃은 바꾸지 않았다.

초기 실패도 보존했다. 첫 시도는 archive hook 위치가 잘못돼 table이 생성되지 않았고 실제 성공 action 위치로 수정했다. 다음 시도는 복원 task의 원래 실행 risk 추정이 현재 읽기 검사를 막아, 완료 결과 조회에 한해 명시적인 read_only 검사를 사용하도록 수정했다. 과거 실행 권한은 유지했다. 추가 검사의 최초 assertion은 정규화 전 권한 객체를 비교한 시험 오류였으며 API 전후 정규화된 실제 권한의 동일성을 비교하도록 고쳤다.

## 한계와 다음 작업

완료된 저장 메타데이터 조회만 복원한다. 실제 Outlook/Teams OAuth·본문·첨부·증분 동기화, 실행 도중 재시작 자동 재개, 전체 브라우저 reload 뒤 Mission 자동 선택, Linux/다른 PC 키 이전, 설치 EXE 및 운영 활성화는 미실증이다. 운영 비용·제품 p95·실계정 성공률은 미측정이다. 이 부분 증거로 V3-031/073 전체를 verified로 바꾸지 않는다.

다음은 완료 Mission의 저장 자료 이력을 독립 화면에서 찾아 현재 읽기 허용으로 재대조하는 경로와 실제 공급자 동기화 조건이다. 되돌릴 때 이번 영수증 archive/recovery 및 POST 조회 분기를 검토해 제거할 수 있고, 개인 원장·F/cognition·원래 Mission은 삭제하지 않는다. 유효하지 않은 영수증은 무조건 차단되며 과거 기록을 재서명해 신뢰시키지 않는다. 파일 해시 일치는 기록 보존 검사이고 실험 결론의 독립 검증이 아니다.
`);
const evidencePaths=['report.md','verification.json','source.json','final.txt','runner.json','additional-final.txt','additional-final-runner.json',
 'build.txt','contract.txt','browser/result.json','first.txt','second.txt','debug2.txt','additional.txt','ledger-review.json'].map(s=>`${prefix}-${s}`);
// Browser directory uses a slash, unlike the immutable flat artifacts.
evidencePaths[9]=`${prefix}-browser/result.json`;
write('attempt.json',{id:'selected-source-restart-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'보호된 지속 키로 실제 task/G 영수증을 결속하고 새 owner 읽기 권한·현재 자료를 재대조하면 새 PID에서 원래 실행 권한을 복원하지 않고 완료 결과를 제공할 수 있다.',
 lesson:'Mission 완료 상태와 unsigned snapshot은 복원 G 증거가 아니다. 역사적 서명 proof·현재 SQL·현재 read_only 권한을 모두 확인해야 하고 완료 결과 조회와 과거 실행 권한을 분리해야 한다.',
 limitations:'Windows DPAPI 실제18프로세스/9사례·고유157검사·2브라우저폭. 합성 저장 metadata만. 공급자OAuth/본문/첨부·inflight자동재개·Linux/다른PC·설치본·운영활성화·제품지연/비용 미실증. 인수59%.'});
const path='docs/universal-control-v3-acceptance.json',data=JSON.parse(read(path)),gates=data.stages.flatMap(s=>s.gates);assert.equal(gates.filter(g=>g.status==='verified').length,59);
for(const id of ['V3-031','V3-073']){const g=gates.find(g=>g.id===id);assert.notEqual(g.status,'verified');g.evidence.push(...evidencePaths.slice(0,10));g.limitations.push('2026-10-07: 완료 source/G 서명영수증→Windows DPAPI 새PID 현재자료/현재read_only대사.9사례18프로세스·고유157검사·2브라우저폭. 실공급자/본문/첨부·inflight·Linux/다른PC·설치운영 미실증.');}
data.updatedAt=observedAt;writeFileSync(path,JSON.stringify(data,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 완료source/G 보호서명영수증·현재read_only·새PID9사례18프로세스/고유157검사·2브라우저/build/contract.59% 유지. 다음 독립화면의 저장Mission 이력→현재읽기 재대조와 실제 공급자 동기화.\n`);
console.log(JSON.stringify({observedAt,uniqueTests:157,verified:59}));
