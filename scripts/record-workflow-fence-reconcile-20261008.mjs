import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/workflow-fence-reconcile-20261008',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-v3.txt','utf8'),recovery=await readFile(prefix+'-recovery.txt','utf8');
if(!final.includes('ℹ pass 60')||!final.includes('ℹ fail 0')||!final.includes('ℹ skipped 0')||!recovery.includes('ℹ fail 0')||!recovery.includes('ℹ skipped 0'))throw Error('Terminal final evidence missing');
const recoveryCount=Number(recovery.match(/ℹ pass (\d+)/u)?.[1]);if(!recoveryCount)throw Error('Recovery pass count missing');
const paths=['packages/core/src/mission/mission-runtime.js','packages/core/src/personal-operations/mission-budget-gate.js','tests/mission-mandate-final-fence.test.js','tests/workflow-mandate-data-scope.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 워크플로 최종 위임 검사와 복구 원인 표시

관측 ${observedAt}. 직전 관리형 자료 위임 작업에서 남긴 워크플로5실패를 이어 재현·조사했다. 외부 모델/개인정보 전송/실계정 거래/운영 서비스·설치 EXE 활성화0, 비용 미측정. 합성 로컬 파일·격리 SQLite·실제 프로세스 복구를 사용했다.

## 원인과 변경

기존4검사는 효과 준비 stage가 null이라는 과거 계약을 assert하여 현재의 영속 효과 준비 훅을 오류로 만들었다. 기존 오라클을 무조건 완화하지 않고 beforeExecute 함수 존재·정상 산출물 내용·예산1회 사용·권한 철회 후 출력 부재를 확인하도록 현재 계약에 맞췄다. legacy-publication 사례는 최종 보안 훅을 사후에 삭제하는 방식 때문에 실제 철회 주입이 실행되지 않았다. 준비 단계의 훅만 없게 만들고, Core가 별도 위임 검사를 조합한 경로에서 publicationRevocations=1과 출력 없음·실제 실패 코드를 확인하도록 수정했다. 이전의 철회 후 출력 성공 기대를 안전한 결과로 바꾼 것이며, 운영 권한을 완화한 것은 아니다.

별칭1은 실제 PC 실행에서 WORKFLOW_SYMLINK_BLOCKED로 읽기와 출력이 차단됐다. 그러나 효과 상태가 uncertain으로 전환되며 원래 실행 실패 대신 일반 대사 오류만 남아 사용자 화면과 Mission 결과에서 원인이 사라졌다. Mission은 실행 결과 blockedReason의 객체·문자열 두 형식을 확인해 원래 코드를 구하고, 불확실 효과로 전환할 때 causeCode를 보존한다. 복구 보류와 실행 보류 상태의 lastError에도 현재 복구 이유를 투영한다. blockedReason을 누락하면 성공적인 신뢰 검사 경고 A_TRUST_EXECUTION_ALLOWED가 실패 코드로 선택되던 경우도 같은 추출 수정으로 막는다.

publication 철회에서는 MissionBudgetGate가 메시지만 가진 Error를 던져 워크플로 어댑터가 WORKFLOW_EXECUTION_FAILED로 일반화했다. A_MANDATE_EXECUTION_DENIED 코드도 함께 부여해 어댑터→worker→Mission 복구까지 정확한 원인을 유지한다. 불확실 상태·원래 effect/영수증·조회 전용 복구는 그대로 유지하고 확인되지 않은 작업을 성공 또는 미실행으로 재분류하지 않는다.

## 검증

최종 워크플로·범위·관리형 읽기·서명·새PID 복구·DPAPI 구성60/60, fail0/skip0. 앞선5실패 모두 포함한다. 별도 Mission 동작 복구·효과 원장 회귀${recoveryCount}/${recoveryCount}, fail0/skip0. 실제 테스트 프로세스 종료·재열기·중복B 방지와 기억 후속 처리도 검사했다. 이 별도48개 실행은 마지막 MissionBudgetGate Error.code 보강 전에 시작했으므로 그 최종 변경의 검증으로 대체하지 않는다. 마지막 권한 코드 보강은 최종60개에 포함된다. build/Core contract gate 통과. 서로 다른 시험 범위를 보고하며 중간17/60회 반복을 중복 합산하지 않는다.

중간 stage 계약 교정 뒤14/17, 원인 추출 객체 보강 뒤15/17, 문자열 처리 뒤16/17의 실행도 보존한다. final-v2의59/60 실패는 legacy 주입 경로에서 불확실 effect가 아닌 명시적 failed observation으로 기록되는 것을 lastError.causeCode로 검사한 시험 오류였다. 해당 경로는 실제 observation.error.code를 확인하고, 나머지 uncertain 경로는 정확한 lastError.causeCode와 불확실 상태를 동시에 검사한다. 마지막60개가 전체 제품 기능의 보증은 아니다.

## 인수와 후속

원래100개 중 완료60/진행22/대기18은 유지한다. V3-032/041에 이 계약·복구 증거를 추가하며 모든 공급자의 실제 대사나 모든 위임 범위 완료로 승격하지 않는다. 직전 보고서의 workflow5 미해결 기록은 당시 관측으로 보존하고 이 새 보고서를 해결 근거로 연결한다. 실제 계정 연결·클라우드 상시 노드·실기기·30일 관측과 남은 목적별 자료 전송 인수는 남아 있다.

복원은 errorFromRun의 blockedReason 추출·uncertain causeCode·lastError 투영·권한 Error.code를 함께 검토한다. 복원 때문에 불명 효과를 다시 실행하거나 예산을 풀지 않는다. 다음 작업은 남은 원래100 인수의 실행 가능한 영역과 실제 연결 준비 조건을 대조하여 진행한다.
`,{flag:'wx'});
const evidence=['-report.md','-source.json','-first.txt','-second.txt','-third.txt','-shadow.txt','-publication.txt','-target-final.txt','-final-v2.txt','-final-v3.txt','-recovery.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',authority=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),gates=authority.stages.flatMap(s=>s.gates);
for(const id of ['V3-032','V3-041']){
 const gate=gates.find(g=>g.id===id);if(!gate)throw Error('Original ID missing');
 gate.evidence=[...new Set([...(gate.evidence??[]),...evidence])];
 gate.limitations=[...(gate.limitations??[]),`2026-10-08: workflow5실패 원인 해결·불명 effect 원래 blockedReason/causeCode/권한코드 보존·60검사 및 별도 복구${recoveryCount}검사. 실제 공급자 계정/전 대사 완료 아님.`];
}
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Original scope changed');
await writeFile(path,JSON.stringify(authority,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'workflow-fence-reconcile-20261008',candidateId:'m02-separate-process-mission-recovery-adapter',kind:'contract-test',reportedOutcome:'passed',observedAt,hypothesis:'기존 보안 오라클을 유지하며 효과 준비 계약과 실제 철회 주입을 대조하고 원래 blockedReason을 불명 복구 상태에 보존하면 정상 처리·차단·복구 이유를 함께 확인할 수 있다.',lesson:'안전 차단과 불명 효과 보존은 통과 여부뿐 아니라 원래 원인의 표시가 필요하다. 최종 보안 훅을 제거한 모의 경로는 실제 주입 여부를 확인하지 않으면 반례가 아니다.',limitations:`최종60+별도복구${recoveryCount}검사 로컬 합성 자료/실제PID·SQLite. 외부API·운영활성화0, 비용미측정. 공식60 유지. 모든 공급자 실계정 대사 미완료.`,evidencePaths:evidence},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 직전workflow5실패 해결(stage 현재계약/실제legacy철회1·blockedReason객체문자열·uncertain causeCode/lastError·위임Error.code). 최종60/60+별도복구${recoveryCount}/${recoveryCount}/build/contract. 공식60/22/18·운영활성화0. 다음 원래100의 실행가능 영역/실계정·상시·기기 조건 대조.\n`);
