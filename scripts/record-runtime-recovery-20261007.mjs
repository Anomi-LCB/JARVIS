import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const prefix='artifacts/runtime-recovery-20261007',read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,v)=>writeFileSync(`${prefix}-${name}`,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx',flush:true});
const status=json(`${prefix}-status.json`),result=json(`${prefix}-selfcheck.json`),pid=Number(read(`${prefix}-supervisor-pid.txt`).trim());
assert.equal(status.status,'ready');assert.ok(status.services.every(s=>s.healthy&&s.identityVerified&&s.statusCode===200));
assert.equal(result.status,'COMPLETED');assert.equal(result.originalSourcePreserved,true);assert.equal(result.humanApprovalObserved,false);
const observedAt=new Date().toISOString();
write('verification.json',{observedAt,supervisorPid:pid,services:status.services.map(s=>({id:s.id,healthy:s.healthy,identityVerified:s.identityVerified,statusCode:s.statusCode})),
 selfcheck:result,externalModelCalls:0,totalCost:null,installedExeUpdated:false,shutdownCause:'unconfirmed',
 restorationMode:'existing-source-runtime-connections-only',coreAutoWorker:false,googleSync:false,personalImport:false,
 commonSqliteEffectProductionActivation:false,windowsScmInstalledServiceStarted:false});
write('report.md',`# 운영 소스 런타임 복원 및 실제 파일 읽기

관측 ${observedAt}. 앞선 native-pdf-field 관측에서 Core4071·PC17776·UI41730이 응답하지 않았고 기존 supervisor30672 및 Core/PC PID가 없었다. 보존한 startup 로그에는 정상 기동 이후 종료 원인을 설명하는 기록이 없어 종료 원인은 미확정이다. 프로세스가 왜 죽었는지를 추정해 결론내리지 않는다.

기존 product-runtime 잠금 및 DPAPI 인증 경로를 재사용해 hidden supervisor${pid}를 connections-only로 시작했다. dead PID 잠금은 기존 start-time/lock ID 검사로 회수한다. 현재 세 서비스 모두200·인증 신원 일치·ready/operational이다. 기존 사용자 DB·Mission·F/cognition·모바일 브리지와 설치된 Windows 서비스는 삭제하거나 초기화하지 않았다.

Core 자동 worker·Google 지속동기화·개인자료 수집은0이다. 기존 PC queue drain은 시작한다. 모든 자동 기능을 껐다는 뜻이 아니며 기존 Core 저장 업무를 자동 재개하지 않은 상태에서 이번 진단 Mission만 명시 실행했다. 연결된 실제 계정·외부 발송·유료 모델 호출은 사용하지 않았다.

실제 밝은 제어센터의 인증 proxy→Core→PC→G로 합성70바이트 파일을 읽었다. 조건 질문1건/첫 dispatch0, 운영자 시험 답변 후 같은 Mission revision2 COMPLETED·원본해시 유지·재조회 완료를 확인했다. 운영자가 테스트 답변을 넣은 것이며 사용자 실제 승인 관측으로 계산하지 않는다. longTermMemory=false다. 진단 Mission/source는 증거를 위해 보존한다.

이번에는 기존 소스 서비스를 실제 복원했으며 설치 EXE 업데이트/Windows SCM/다른PC/부팅 복구/클라우드 상시 노드 인수를 달성하지 않았다. 앞선 local workbook SQL effect 코드는 격리 검증 증거이며 현재 서비스 전체 SQLeffect 활성화로 바꿔 보고하지 않는다. 원래100개 인수율은60%를 유지한다.

다음은 V3-020 등 미완료 인수항목의 현재 증거를 감사해 로컬에서 충족 가능한 부분을 마무리하고, exportPdf SQL 공통 효과 연결을 계속하는 것이다. supervisor 재종료 시에는 같은 PID의 생존/HTTP 신원/원래 로그를 먼저 확인하고 중복 시작하지 않는다. 영구 상시 운영은 별도 클라우드 설치·예산·권한 조건과 장기 관측이 필요하다.

복원 취소는 현재 supervisor 소유 서비스만 정상 종료하는 방식으로 수행하며 저장 원장·기억·진단 증거를 삭제하지 않는다. 총 비용은 미측정(null), 외부 모델 호출0이다.
`);
const evidencePaths=['report.md','verification.json','status.json','start.stdout.log','start.stderr.log','supervisor-pid.txt',
 'selfcheck.json','mission-created.json','mission-waiting.json','mission-after-answer.json','mission-reloaded.json'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'runtime-recovery-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'runtime-connection',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제중단된 소스runtime은 기존 잠금/DPAPI 신원과 사용자 원장을 보존한 채 복원하고 인증proxy 종단 읽기로 확인할 수 있다.',
 lesson:'기동 로그가 정상이어도 현재 실행을 입증하지 않는다. dead PID와 current health를 별도 확인하고 복원 후 실제 Mission까지 검증해야 한다.',
 limitations:'소스3서비스 복원/실제읽기1·운영자시험답변/원본보존. 종료원인미확정·installed/SCM/cloud/boot/장기관측 미완료·SQLeffect운영활성화미주장·공식60/비용null.'});
const path='docs/universal-control-v3-acceptance.json',acceptance=json(path),gate=acceptance.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-099');
assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07 기존소스3서비스 dead-PID 잠금회수·신원/HTTP/실제proxy Core PC G읽기복원. 종료원인미확정·설치EXE/SCM/다른PC/부팅/장기 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: supervisor${pid} 소스Core/PC/UI 복원·3신원200·실제파일읽기/원본보존/같은Mission정정·공식60. 종료원인미확정·SQLeffect운영활성화/설치SCM/클라우드미완료. 다음 미완료인수(독립읽기등)증거감사/실증 및exportPdf effect.\n`);
console.log(JSON.stringify({observedAt,supervisorPid:pid,operational:status.operational,missionStatus:result.status,attempt:`${prefix}-attempt.json`}));
