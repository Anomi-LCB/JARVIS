import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/managed-mandate-20261008',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final-v2.txt','utf8');
if(!log.includes('ℹ pass 43')||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0'))throw Error('Final execution evidence missing');
const sources=['packages/core/src/mission/managed-agent-mission-tool-dispatcher.js','packages/core/src/mission/managed-parent-read-fence.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/mission-egress-authorization-policy.js','tests/managed-agent-mission-tool-dispatcher.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 관리형 에이전트의 부모 자료 위임 연결

관측 ${observedAt}. 실제 개인 파일/외부 모델 호출/유료 전송/운영 서비스·설치 EXE 활성화0. 합성 로컬 파일·격리 SQLite·합성 공급자 콜백을 사용했고 비용은 미측정이다.

## 재현과 구현

실제 Mission→E→B→G→관리형 세션 경로에서 부모의 정확한 파일 위임이 하위 읽기에 적용되지 않았고, 위임 철회 이후 저장된 성공 결과가 공급자 콜백으로 다시 제출됐다. baseline-v2의 두 실패를 보존한다. 최초 baseline은 테스트가 PersonalOperationsStore 생성 인자를 누락한 오류2이며 제품 결함 증거로 세지 않는다.

부모의 현재 자료 읽기 권한을 하위 작업 생성 전·읽기 후·서명 확인 후·저장 결과의 최종 재전송에서 검사한다. 서명 결정은 자료 참조와 부모 executionMandateId에 결속한다. 위임 ID 제거·교체를 권한 없는 우회로 취급하고 준비된 하위 작업은 목표·자료 경로·위임 결속이 같을 때만 재사용한다. 이전 형식의 결속 없는 하위 작업은 새 읽기로 자동 승격하지 않는다.

현재 코드의 managed-parent-read-fence는 실제 로컬 PC 실행의 기존 beforeExecute와 계획 노드 fence를 함께 연결한다. 비동기 shadow 준비 중 위임을 철회한 추가 반례에서 adapter.execute 호출0·외부 성공 결과0을 확인했다. 정상 허용 자료의 실제 읽기/성공 전송도 유지한다. 정확한 파일 권한 없이 전체 allowedRoots만 근거로 읽는 경로를 막는다. scoped 부모의 원격 실행기는 같은 최종 자료 fence를 증명하지 못하면 보류한다. 이는 부모의 예산을 자식에 새로 부여하거나 Mission 호출 횟수를 추가 정산하는 기능이 아니다.

## 검증과 남은 실패

최종 관리형 dispatcher·서명 정책·새 프로세스 복구·DPAPI 구성43/43, fail0/skip0. 실제 로컬 읽기·저장 SQLite 복구·서명/DPAPI 검증은 실행됐지만 실제 OpenAI 전송 성공은 아니다. build/Core contract gate 통과. SHA 파일 일치는 기록 무결성이지 독립 제품 품질 증명이 아니다.

첫 확대56검사는50통과/6실패였다. 새 재전송 검사1은 Windows 자료 참조를 정규화하지 않은 테스트 준비 오류였고 localMandateFileRef로 정규화한 뒤 정상 실제 전송과 철회 후 차단을 함께 통과했다. 추가 fence 검사 첫 시도는 존재하지 않는 adapters/prepare 접근의 테스트 오류였으며 실제 registry/shadow/execute로 바꿔 IO 직전 차단을 확인했다. 중간 실행 수를 최종43에 더하지 않는다.

그 밖의 기존 워크플로 검사5개는 미해결로 남겼다. mission-mandate-final-fence의4개는 stage 결과가 null이라는 기존 가정을 assert하며 staged=0에서 실패했고, workflow-mandate-data-scope alias-change1은 읽기/출력 없이 PAUSED/action-recovery-required가 됐지만 기존 WORKFLOW_SYMLINK_BLOCKED 문자열을 찾지 못했다. 이 실패를 무시하거나 해당 정답을 느슨하게 변경하지 않았다. 실제 stage 계약·권한 철회·별칭 경로 상태를 대조해 제품 또는 시험 계약의 문제인지 다음 작업에서 확정해야 한다. 확대 전체 성공으로 주장하지 않는다.

V3-031/032/080에 부분 증거를 연결하지만 원래100개 중 완료60은 유지한다. 모든 목적별 데이터 전송·실계정·클라우드 상시 노드·기기·30일 인수는 여전히 남아 있다. 복원 시 서명 범위와 하위 결속/최종 fence를 함께 검토하고, 철회된 위임의 저장 자료를 재발신하지 않는다. 다음 작업의 최우선은 위 워크플로5실패의 실제 원인 확인과 정확한 회귀 복구다.
`,{flag:'wx'});
const evidence=['-report.md','-source.json','-baseline.txt','-baseline-v2.txt','-first.txt','-fence.txt','-fence-v2.txt','-final-v2.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
const path='docs/universal-control-v3-acceptance.json',authority=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),gates=authority.stages.flatMap(s=>s.gates);
for(const id of ['V3-031','V3-032','V3-080']){
 const gate=gates.find(g=>g.id===id);if(!gate)throw Error('Original acceptance ID missing');
 gate.evidence=[...new Set([...(gate.evidence??[]),...evidence])];
 gate.limitations=[...(gate.limitations??[]),'2026-10-08: 관리형 하위 읽기와 저장 결과 재전송의 부모 자료 위임/서명 범위/최종 로컬 fence43검사. 실제 개인정보 전송/외부 API 활성화 아님. 별도 기존 workflow5실패 원인 미해결; 모든 목적별 전송 완료 아님.'];
}
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('Original scope changed');
await writeFile(path,JSON.stringify(authority,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'managed-mandate-20261008',candidateId:'m10-minimized-egress-provider-payload',kind:'contract-test',reportedOutcome:'passed',observedAt,hypothesis:'관리형 로컬 읽기·최종 발신·저장 결과 복구에 부모의 현재 자료 위임과 서명 결속을 연결하면 하위 작업의 권한 우회와 철회 후 재발신을 차단한다.',lesson:'파일 allowedRoots와 부모의 정확한 자료 위임은 별개다. 최초 결과의 검증뿐 아니라 IO 직전 및 저장 결과 재발신에서 현재 권한을 확인해야 한다.',limitations:'최종 관리형 경로43검사/합성 provider·자료; 실제API·개인정보전송·설치활성화0. 비용미측정. 확대 기존workflow5검사는 미해결, 전체회귀 통과 아님.',evidencePaths:evidence},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 부모 파일 위임 누락/철회 후 저장결과 재전송2재현·최종PC fence/서명 자료결속·관리형43/43/build/contract. 공식60/22/18 유지. 기존workflow5회귀실패(stage null가정4/alias원인표시1) 미해결; 다음 최우선으로 정확한 원인 재현/수정. 운영·실계정 활성화0.\n`);
