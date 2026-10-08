import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/mission-cancel-review-20261008', observedAt = new Date().toISOString();
const final = await readFile(prefix + '-regression.txt', 'utf8');
if (!final.includes('ℹ pass 101') || !final.includes('ℹ fail 0') || !final.includes('ℹ skipped 0') ||
    !(await readFile(prefix + '-hydration-baseline.txt', 'utf8')).includes('ℹ fail 2')) throw Error('Terminal evidence missing');
if (!(await readFile(prefix + '-build.txt', 'utf8')).includes('Built static JARVIS') ||
    !(await readFile(prefix + '-contract.txt', 'utf8')).includes('gatePassed: true')) throw Error('Build/contract missing');
const sources = ['packages/core/src/mission/cancelled-mission-review.js', 'packages/core/src/mission/mission-runtime.js',
  'packages/core/src/mission/mission-effect-coordinator.js', 'packages/core/src/mission/mission-action-recovery.js',
  'packages/core/src/orchestration/core-orchestration-worker.js', 'packages/core/src/main.mjs',
  'apps/verification/src/verification-runtime.js', 'tests/mission-cancel-publication-boundary.test.js'];
await writeFile(prefix + '-source.json', JSON.stringify({ observedAt, sources: await Promise.all(sources.map(async path => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex')
}))) }, null, 2), { flag: 'wx' });
await writeFile(prefix + '-report.md', `# 취소된 Mission 결과 조회와 재시작 상태 보존

관측 ${observedAt}. 이전 turn의 미제출 음성 정정과 제출된 Mission 취소 변경을 이어 실제 영속 복원·결과 조회를 구현했다. 원래 인수100을 줄이지 않고 V3-068/041의 부분 증거로 연결한다.

## 발견과 수정

재시작 기준선5개 중3통과/2실패. SQL failed/notDispatched=true로 확인된 취소 action의 skipped 상태가 새 Core hydrate에서 planned로 되살아났다. CANCELLED Mission에서 이 실제 영수증이 있는 action만 skipped와 recovery.required=false를 유지한다. in_flight·uncertain 또는 영수증 없는 작업을 미실행으로 바꾸지 않는다.

POST /missions/{missionId}/cancellation-review를 추가했다. ADMIN 인증과 expectedGoalRevision·expectedObjectiveSha256를 요구하며, 아직 활성 run인 Mission·취소되지 않은 Mission·추가 실행 옵션·오래된 원문은 거부한다. 전체40개 이하 action을 현재 원문과 대조하고, 기존 recoverMissionAction의 원래 요청/SQL intent/PC packet 영수증/현재 파일/G 검사 경로를 재사용한다. 실행 확인·명시적인 미전달·미시작·미확인을 나누고 operation/effect/기억 상태를 변경하지 않는다. 조회 도중 Mission 또는 원장이 바뀌면 확인 결과를 반환하지 않는다. 실제 파일 내용·원문 자료 경로를 응답에 복제하지 않는다.

첫 조회 검사4/5에서 영수증 이후 조회가 F 이벤트를1개 추가한 부작용을 발견했다. 원인은 G result가 일반 verification.completed 학습 신호를 자동 발행하는 동작이었다. 내부 observationOnly 옵션은 동일한 capability package·파일·G 검사를 수행하고 G 보고서/감사 기록도 보존하되 학습 신호만 생략한다. 기본값은 기존 학습 기록을 유지한다. 외부 실행/G HTTP 요청의 본문으로 이 옵션을 지정하지 않고 새 내부 조회 경로에서만 전달한다. 새 API 본문의 resume 같은 추가 옵션은400이다. 검사 강도나 effect 실행 권한을 완화하지 않았다.

## 검증

최종7개 파일101/101, fail0/skip0. 실제5개 취소 지점(prepared·가용성 await 종료·shadow·publication claim·파일 저장 후 영수증) 각각 새 Core를 생성하여 상태를 복원했다. prepared·가용성은 skipped/not-dispatched/불명0, 나머지는 불명 effect 보존이다. 실제 저장·영수증이 존재하는 마지막 사례는 현재 JSON의 total42를 다시 확인하고 G verification ID와 verified-executed를 반환한다. 출력 파일을99로 바꾸면 unresolved/currentArtifactVerified=false가 된다. 조회 중 source가 바뀌면409 대상 오류를 반환한다.

Mission 전체 snapshot·SQL effect JSON·F 이벤트 수의 조회 전후 동일성을 확인했다. runTask와 resumeWorkflowPublication에 실패 대역을 걸어 어떤 재실행·publication 재개도 발생하지 않는지 확인했다. 관측 mode의 부정 G 입력은 여전히 failed이며 F 추가0, 같은 기본 검증은 기존 학습 이벤트1을 기록한다. scoped executionMandateId는 현재 재조회 G 경로에 자료별 결과 읽기 fence가 없으므로 미확인으로 남기며 우회해서 읽지 않는다. 이는 범위가 좁은 조회 기능의 준비 조건이고 해당 인수 완료가 아니다.

실제 임시 Core HTTP 서버에서 무인증401, 추가 옵션400, 원문 revision 충돌409, 인증된 조회200을 확인했다. 기존 Mission 효과 원장·목표 정정·위임·파일 복구·G 워크플로/DAG 검사를 함께 실행했다. build와 additive Core contract gate 통과. 반복 focused5·focused-v2 5·공유101을 중복 합산하지 않는다. actual API는 임시 로컬 서버이며 설치된 제품 프로세스의 활성화/PC EXE/APK 배포 성공을 뜻하지 않는다.

## 제한과 다음 작업

공식 완료60/진행23/대기17 유지. 이번 결과는 현재 원래 완료율60%이며 사용자 목표90%를 달성한 상태가 아니다. 실제 마이크/Android·모든 외부 공급자/제출된 메일 취소·반환·원격 거래·권한별 결과 읽기·사용자 화면·상시 노드·장기 관측은 남아 있다. 기존 SQL effect는 조회만으로 succeeded/미실행으로 바꾸지 않는다. verified-executed는 관측 시각의 원래 로컬 결과 확인이며 전체 목표 완료·취소 rollback·영구 파일 무결함이 아니다.

실제 계정 외부 발송·구매0, 외부 모델 호출0, 개인정보·운영 F/cognition 수정0. 실제 비용은 미측정. 다음은 scoped 자료 읽기와 G 재검증 사이의 권한 경계를 보강하고, 취소 결과 조회를 밝은 사용자 화면과 실제 음성 인계에 연결하는 것이다.

복원은 새 review 모듈/route와 observationOnly 옵션을 함께 검토한다. hydration의 확인된 미실행 취소 상태 보존은 독립 수정이다. 기록이 바뀌어도 과거 영수증을 재전송·불명 효과를 자동 재실행·권한을 확장하지 않는다.
`, { flag: 'wx' });
const evidencePaths = ['-report.md', '-source.json', '-hydration-baseline.txt', '-focused.txt', '-focused-v2.txt',
  '-regression.txt', '-build.txt', '-contract.txt'].map(suffix => prefix + suffix);
const path = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const gates = acceptance.stages.flatMap(stage => stage.gates);
if (gates.length !== 100 || gates.filter(gate => gate.status === 'verified').length !== 60) throw Error('Original scope changed');
for (const id of ['V3-068', 'V3-041']) {
  const gate = gates.find(item => item.id === id);
  gate.evidence = [...new Set([...(gate.evidence ?? []), ...evidencePaths])];
  gate.limitations = [...(gate.limitations ?? []), '2026-10-08: 再시작 미실행 취소 hydrate2반례 수정, ADMIN 취소 효과 관측 API/원문 CAS/현재 파일·G/조회 F 기록0,101회귀/build/contract. scoped 결과읽기·실음성·모든 원격공급자/UI·운영활성화 미완료.'];
}
await writeFile(path, JSON.stringify(acceptance, null, 2) + '\n');
await writeFile(prefix + '-attempt.json', JSON.stringify({ id: 'mission-cancel-review-20261008',
  candidateId: 'm02-separate-process-mission-recovery-adapter', kind: 'contract-test', reportedOutcome: 'passed', observedAt,
  hypothesis: '취소 뒤 재시작 상태를 영속 미전달 영수증과 대조하고 기존 receipt/current-file/G 경로를 실행·학습 없는 관측으로 사용하면 취소와 실제 결과를 구분할 수 있다.',
  lesson: 'Cancelled 상태는 효과 부재나 rollback의 증명이 아니다. hydrate와 조회도 상태·학습 부작용을 검사해야 한다. G 관측은 검사를 그대로 유지하고 새 경험 학습만 분리한다.',
  limitations: '실제 격리 로컬 파일/SQL/새 Core/임시 HTTP, 최종101/101/build/contract. scoped G 결과읽기·실음성/실기기·모든 원격공급자/UI 미검증, 비용미측정, 운영활성화0, 공식verified60 유지.',
  evidencePaths }, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 再시작 hydrate 취소2반례·ADMIN cancellation-review 원문 CAS/현재 파일-G/재실행0/조회F0. 최종101/101/build/contract, 공식60/23/17 유지. scoped 결과 읽기·실음성·모든원격/UI·운영활성화 미완료. 다음 scoped 읽기/G 권한 경계 및 실제 사용자 취소 결과 조회 연결.\n`);
