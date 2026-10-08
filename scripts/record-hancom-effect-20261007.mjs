import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const prefix='artifacts/hancom-effect-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final.txt','utf8');
if(!final.includes('pass 44')||!final.includes('fail 0')||!final.includes('skipped 0'))throw Error('final-native-not-complete');
const independent=await readFile(prefix+'-independent-final.txt','utf8');
if(!independent.includes('pass 41')||!independent.includes('fail 0'))throw Error('independent-not-complete');
const shared=await readFile(prefix+'-shared-fixed.txt','utf8'),hwpx=await readFile(prefix+'-hwpx-boundaries.txt','utf8');
if(!shared.includes('pass 31')||!shared.includes('fail 0')||!shared.includes('skipped 7')||!hwpx.includes('pass 8')||!hwpx.includes('fail 0'))throw Error('regression-not-complete');
const sources=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/hwpx/artifact-contract.js',
  'packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
  'packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js',
  'tests/mission-hancom-effect-process.test.js','tests/fixtures/hancom-effect-process-child.mjs','tests/hancom-artifact-contract.test.js','tests/hwpx-authority-boundary.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify(await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))),null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# HWP/HWPX 전체 출력 계약과 영속 효과·복구 연결

관측: ${observedAt}. 공식100개 기준을 유지하며 인수60/100이다.

## 실제 구현

HwpCreateToolAdapter.preparePublication이 원래 제목·본문·표와 verifyRendering을 고정한다. 렌더가 없는 요청은 원본1개, 있는 요청은 원본·manifest·PDF·최대50페이지 PNG·structure.hwpx 총54개 경로를 예약한다. 예약은 존재 증거가 아니며 실제 pageCount 1..50에 해당하는 순서와 경로만 완료 산출물이다.

Core SQL artifactPlan에 원 문서/경로/옵션/해시를 보존하고 실행 직전 private assertArtifactPlan으로 다시 대조한다. B는 생성 전에 전체 경로를 claim하고 현재 권한·취소·위임 검사를 유지한다. 원래 packet 영수증을 즉시 저장하며, B의 원래 result/fingerprint/실제 경로/예약 자원 결속이 맞을 때만 claim을 해제한다. 복구는 원 문서와 complete manifest, 실제 source/render bytes를 G로 다시 확인한다. G의 Hancom/HWPX 검증에 기존 recoveryReadRoots 계약을 연결했다.

이 연결을 갖춘 뒤 로컬 Core authority allowlist에 hwp.create를 추가했다. 외향 원격 HWP 실행을 활성화하지 않았으며 운영 서비스/설치 EXE는 재시작하지 않았다.

## 실행과 반례

- 최종 소스 고정 후44/44·실패0·skip0. 실제 HWP와 HWPX 각각 prepared/b-receipt/receipt-persisted/partial/원본변조/렌더manifest변조/authority의7경계, 총14개 Mission 시험이다. 별도 Core/B 프로세스를 실제 SIGKILL한 뒤 새 프로세스가 동일 SQL Effect/operationId/멱등키/영수증을 대사했다. 완료 경로는 작성1회·원 영수증 유지·B claim0. 부분 생성/변조는 PAUSED/uncertain으로 남고 새 작성·허위 완료는 없었다. authority 양성은 실제 단일Core 권위 아래 native/G/SQL까지 완료했다.
- 실제 native HWP 생성·소유 Hancom 취소/Job/직접경로 uncertain, 준비된 TaskPlanner의 HWP/HWPX actual render+G, 실제 MCP HWPX 본문/표/셀 현재 재조회 회귀도 포함했다. 이들은 외부 LLM 자연어 해석 시험이 아니다.
- 공통 회귀31통과·다른 Office native7skip. 최종44와 중복된 artifact5개를 제외하고, HWPX 경계8/8을 더하면 고유78통과·skip7이다. skip7은 Word/PowerPoint native 환경 플래그가 없는 검사이며 HWP 최종44에는 skip이 없다. 전체 저장소 모든 검사의 점수가 아니다.
- HWPX late revocation/경합 시험은 guard 호출 횟수5에 의존하던 조건을 제거하고 실제 owned staged document를 관측한 뒤 철회/경합하도록 고쳤다. 실제 Python/MCP 취소도 포함한다.
- 독립41/41·실패0·skip0. 실제 Core fence/복구 함수/B 임시SQL claim·영수증 대사를 검사하되 native 생성·G 의미 판정은 합성 stub이며 루트 native 증거와 분리한다.
- 공유 회귀에서 허용 루트 밖 HWP 요청이 기존 outside-allowed-roots 대신 signed scope 오류로 분류되는1건을 발견했다. 출력 물리 경로·signed 범위를 claim보다 먼저 검사하도록 수정했다. 잘못된 문서도 생성 전 structured blocked로 반환한다. 오라클은 완화하지 않았다. 공유 최초 실패·첫 native42개 로그를 보존하고 최종 소스에서 재실행했다. 초기 native flag 문자열 오류로5skip된 baseline도 미실행 기록이며 성공으로 계산하지 않는다.
- build/Core 계약 게이트 exit0. connections-only runtime 상태는 runtime.json. 테스트는 합성 사용자 자료·임시 SQL/기억/undo 경로이며 기존 F/cognition 실제 업무 기억은 보존했다. 외부계정 변경·유료API 호출0, 총비용 미측정. 검사 시간은 최종 로그에 있으며 제품 p50/p95 주장이 아니다.

## 남은 범위

V3-040/041의 이 로컬 문서 실행 증거를 추가하되 전체 등록 쓰기·외부 발송/거래 공급자 대사 인수로 확대하지 않는다. bare HWP의 해시/서명만으로 현재 의미를 검증했다고 주장하지 않는다. 요청된 native 렌더 경로는 실제 G로 본문/표/페이지를 확인했다. 시각적 디자인 품질이나 모든 앱/계정/기기 성공도 미입증이다. OS 외부 경쟁 전체의 원자성, staging cleanup retry 소진의 영속 처리, 운영 EXE 업데이트, 클라우드 및 실제 계정 연결은 별도 작업이다.

다음은 이미지 제작·문서 편집 등 남은 등록 쓰기의 전체 output manifest/원문 SQL 결속/영수증/복구를 연결하고 V3-040 범위를 감사한다. 이 보고서와 고정 해시/녹색 검사는 독립 의미 평가나 제품 전체 활성화 자체가 아니다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'hancom-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
  hypothesis:'원 문서와 bounded output 계약을 SQL→private fence→B claims→원 영수증→G 복구에 연결하면 한컴 복합 산출물의 중단 후 중복 생성과 허위 완료를 막을 수 있다.',
  lesson:'예약 경로와 실제 pageCount 출력 증거는 다르다. 공유 경로의 사전오류 분류와 guard-call-count 기반 테스트도 함께 검토해야 한다.',
  limitations:'최종44 native/g 포함·고유78+7otherOffice skip·독립41 synthetic. 운영EXE/원격HWP/모든쓰기/실계정/시각품질/OS원자성/cleanup소진 미완료. 공식60/100, 비용미측정.',
  evidencePaths:['-report.md','-source.json','-final.txt','-shared.txt','-shared-fixed.txt','-recovery-first.txt','-first-native.txt','-hwpx-boundaries.txt','-independent.md','-independent.test.mjs','-independent-final.txt','-build-final.txt','-contract-final.txt','-runtime.json','-baseline.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
const acceptancePath='docs/universal-control-v3-acceptance.json';
const acceptance=JSON.parse(await readFile(acceptancePath,'utf8'));
for(const gate of acceptance.stages.flatMap(stage=>stage.gates).filter(gate=>['V3-040','V3-041','V3-065'].includes(gate.id))){
  gate.evidence??=[];if(!gate.evidence.includes(prefix+'-report.md'))gate.evidence.push(prefix+'-report.md');
}
acceptance.updatedAt=observedAt;
await writeFile(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: HWP/HWPX 원문+최대50페이지/54예약 SQL 계약·privatefence/Bclaim/영속receipt/G recovery·실제14Mission SIGKILL/authority·최종44/44·고유78+otherOffice7skip·독립41/build/contract. 공식60·운영EXE활성화0. 다음 visual.createCards/document.edit 등 남은전체쓰기와 원래 나머지인수.\n`);
