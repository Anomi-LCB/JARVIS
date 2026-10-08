import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/cancelled-read-scope-20261008';
const observedAt = new Date().toISOString();
const final = await readFile(prefix + '-final.txt', 'utf8');
if (!final.includes('ℹ pass 94') || !final.includes('ℹ fail 0') || !final.includes('ℹ skipped 0')) throw Error('Final regression evidence missing');
if (!(await readFile(prefix + '-regression.txt', 'utf8')).includes('ℹ fail 24')) throw Error('Failed intermediate evidence missing');
if (!(await readFile(prefix + '-build.txt', 'utf8')).includes('Built static JARVIS') ||
    !(await readFile(prefix + '-contract.txt', 'utf8')).includes('gatePassed: true')) throw Error('Build/contract missing');
const sources = [ 'packages/core/src/mission/mission-action-recovery.js', 'packages/core/src/mission/mission-runtime.js',
  'packages/core/src/mission/cancelled-mission-review.js', 'packages/core/src/orchestration/core-orchestration-worker.js',
  'packages/shared/src/scoped-recovery-verification.js', 'apps/verification/src/verification-runtime.js',
  'tests/cancelled-mission-read-scope.test.js', 'tests/mission-cancel-publication-boundary.test.js' ];
await writeFile(prefix + '-source.json', JSON.stringify({ observedAt, sources: await Promise.all(sources.map(async path => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex')
}))) }, null, 2), { flag: 'wx' });
await writeFile(prefix + '-report.md', `# 취소된 작업의 위임 범위별 결과 조회

관측 ${observedAt}. 이전 cancellation-review의 scoped 결과 조회 미지원 경계를 로컬 파일과 워크플로에 한정하여 보강했다. 공식 100개 인수항목은 그대로 유지한다.

## 구현과 실패 수정

취소된 Mission에 executionMandateId가 있으면 무조건 조회를 막던 동작 대신, 원래 위임의 현재 상태와 실제 자료 범위를 조회 시점마다 검사한다. runtime의 기존 beforeResultRead 경로를 복구 함수와 G에 연결한다. 실제 물리 경로를 고정하고 원래 경로·고정 경로·매 파일 청크 읽기 전후·최종 파일 상태 검사 후에 확인한다. G의 capability package 검증 전후와 실행 결과 검사 전후, 출력 파일 stat 전후에도 확인한다. 조회 중 Mission 원문 또는 위임 ID가 바뀌면 현재 결과를 확인된 것으로 반환하지 않는다.

허용 경로는 filesystem.createTextFile·filesystem.readText·workflow.execute의 검토된 로컬 복구뿐이다. XLSX·PDF 특수 읽기와 원격 실행/MCP는 아직 동일한 접근 경계가 검토되지 않아 차단한다. 검증기의 성공 주장을 그대로 완료로 취급하거나 기존 파일·해시·영수증·G 검사를 생략하지 않는다. 이 내부 guard는 공개 요청 본문에서 지정하는 옵션이 아니다.

기준선 7개 중 ready 1개 실패/나머지 6개 차단 확인. 처음 연결 후 공유 회귀 93개 중 24개가 실패했다. 정상 새 작업은 operation이 준비됐어도 dispatch가 없는데, 형식 지원 검사에서 잘못 복구 차단으로 분류한 것이 원인이다. 기존 identity/root 검사를 유지한 채 미전달 판정을 형식 검사보다 먼저 수행하도록 수정했다. 실패 로그를 보존하고, 테스트 기대 결과를 정상 동작에 맞춰 바꾸는 방식으로 해결하지 않았다.

## 실제 검증

최종 8개 파일 94/94, 실패0·생략0. 별도 focused-v2 10/10은 이 합계에 다시 더하지 않는다. 실제 임시 SQL 위임·Mission·PC JSON 워크플로·packet 영수증과 G를 사용했다. 원본 JSON을 읽고 결과 JSON을 실제 저장한 직후 Mission을 취소했다. ready에서 현재 결과의 total42를 확인하고 verified-executed를 반환했다. 철회·만료·자료 범위 제외·권한 검사기 부재·읽기 도중 철회·위임 ID 제거·G 진입 직전 철회·G package 검증 직후 철회를 각각 주입했다. 모두 현재 결과를 확인된 것으로 반환하지 않는다. 지원하지 않는 5개 형식/도구 조합은 파일·package verifier 호출 전에 거부한다.

모든 실제 scoped 조회에서 Mission은 CANCELLED를 유지하며 새 quota 사용과 F 이벤트 추가는0이다. 권한이 없는 경우 읽기를 허용하거나 재실행·파일 publication 재개·외부 발송을 수행하지 않는다. 기존 복구·효과 원장·취소 경계·정상 위임 실행·결과 미리보기·G 워크플로를 함께 검사했다. 공유 중간 수정93/93과 최종94/94는 동일 검사군이므로 합산하지 않는다.

build 및 additive Core contract gate 통과. 빌드는 정적 dist 생성이며 운영 서비스 재시작이나 설치된 PC 프로그램 업데이트·APK 배포 증거가 아니다. 실계정/기기 시험이나 외부 모델 사용은 없고 실제 비용은 미측정이다. 테스트 실행 시간은 각 원본 로그에 있으며 사용자 업무의 p50/p95 지연과 의미 품질 평가는 미측정이다. 이 결과를 독립 의미 평가·범용 앱 제어 성공률로 확대하지 않는다.

## 진행과 다음 작업

공식 완료60·진행23·대기17(60%) 유지. V3-031/032/041/068의 부분 증거이며 전체 자료 범위·전 공급자 복구·실제 음성/기기·사용자 UI까지 완료된 것은 아니다. 목표90%에는 아직 도달하지 않았다. 다음은 취소 결과 조회를 사용자 화면에서 실행 여부/미확인/다음 조치로 구분해 연결하고, 검토되지 않은 문서·원격 읽기는 개별 검증 계약으로 확장한다. 상시 클라우드·계정 인증·물리 기기·장기 관측은 해당 실제 준비 조건이 필요하다.

복원 시 내부 guard 전달·지원 형식 목록·G 경계를 함께 검토한다. 권한 검사만 제거하거나 취소된 효과를 자동 재실행하는 복원은 하지 않는다. F/cognition 운영 개인 자료는 수정하지 않았다.
`, { flag: 'wx' });
const evidencePaths = ['-report.md', '-source.json', '-baseline.txt', '-focused.txt', '-focused-v2.txt', '-regression.txt',
  '-regression-fixed.txt', '-final.txt', '-build.txt', '-contract.txt'].map(suffix => prefix + suffix);
const path = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const gates = acceptance.stages.flatMap(stage => stage.gates);
if (gates.length !== 100 || gates.filter(gate => gate.status === 'verified').length !== 60) throw Error('Original acceptance changed');
for (const id of ['V3-031', 'V3-032', 'V3-041', 'V3-068']) {
  const gate = gates.find(item => item.id === id);
  gate.evidence = [...new Set([...(gate.evidence ?? []), ...evidencePaths])];
  gate.limitations = [...(gate.limitations ?? []), '2026-10-08: 위임별 취소 결과 조회/물리 파일 청크·G 전후 읽기 권한 재확인, 철회·만료·범위·ID변경 차단. 초기 회귀24실패 수정 후94/94. 문서/원격 확대·실음성/UI·운영 활성화 미완료.'];
}
await writeFile(path, JSON.stringify(acceptance, null, 2) + '\n');
await writeFile(prefix + '-attempt.json', JSON.stringify({ id: 'cancelled-read-scope-20261008',
  candidateId: 'm02-separate-process-mission-recovery-adapter', kind: 'contract-test', reportedOutcome: 'passed', observedAt,
  hypothesis: '취소 효과의 기존 파일/영수증/G 재검증에 위임 범위와 읽기 전후 권한 검사를 연결하면 현재 허용된 자료만 재실행 없이 확인할 수 있다.',
  lesson: '읽기에도 권한 수명주기가 필요하다. 복구 형식 검사는 미전달 판정 이후에 적용해야 정상 새 실행을 막지 않으며, 검증 중 철회는 최종 성공 반환 전에 재확인해야 한다.',
  limitations: '임시 로컬 SQL/PC JSON/G 실제 실행, 최종94/94/build/contract. 특수 문서·원격·실계정·실음성/기기·UI·운영 활성화 미완료, 비용/업무p50p95미측정. 공식60/23/17 유지.',
  evidencePaths }, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 취소 결과 scoped 읽기·물리 파일 청크·G 경계 권한/철회 재확인. 정상 새 실행 차단24반례 수정 후94/94/build/contract. 공식60/23/17 유지. 다음 사용자 취소 결과 화면 연결 및 검토되지 않은 문서·원격 읽기 경계.\n`);
