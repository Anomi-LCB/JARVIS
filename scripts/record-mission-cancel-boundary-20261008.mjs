import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/mission-cancel-boundary-20261008', observedAt = new Date().toISOString();
const final = await readFile(prefix + '-final-v2.txt', 'utf8');
const baseline = await readFile(prefix + '-expanded-baseline.txt', 'utf8');
if (!final.includes('ℹ pass 76') || !final.includes('ℹ fail 0') || !final.includes('ℹ skipped 0') || !baseline.includes('ℹ fail 4')) throw Error('Terminal comparison evidence missing');
if (!(await readFile(prefix + '-build.txt', 'utf8')).includes('Built static JARVIS') ||
    !(await readFile(prefix + '-contract.txt', 'utf8')).includes('gatePassed: true')) throw Error('Build/contract evidence missing');
const sources = ['packages/core/src/mission/mission-runtime.js', 'tests/mission-cancel-publication-boundary.test.js',
  'tests/mission-runtime.test.js', 'tests/mission-goal-revision.test.js'];
await writeFile(prefix + '-source.json', JSON.stringify({ observedAt, sources: await Promise.all(sources.map(async path => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex')
}))) }, null, 2), { flag: 'wx' });
await writeFile(prefix + '-report.md', `# 提출된 Mission의 취소와 파일 publication 경합

관측 ${observedAt}. 직전 음성 미제출 턴 수정 이후, 이미 Core에 제출된 Mission의 취소를 실제 로컬 워크플로·SQLite 효과 원장·PC packet journal로 검사했다. 개인 기억은 사용하지 않고 격리된 합성 자료를 사용했다.

## 반례와 수정

초기4개 중3통과/1실패. 효과를 prepared로 기록한 직후 취소하면 취소 API가 skipped로 만든 action을 늦게 돌아온 stage가 planned로 되돌렸다. 파일은 생성되지 않았고 SQL의 notDispatched 영수증은 존재했으므로 실행 방지 자체는 작동했다. 문제는 실제 취소한 미실행 action 상태가 잘못 표시되는 것이었다. worker handoff 전 중단 및 늦은 가용성 검사 부정 경로에서 CANCELLED Mission은 skipped를 유지하도록 수정했다. 아직 전달되지 않은 효과의 기존 failUndispatchedEffect 처리를 보존한다.

확장 기준선4개 모두 실패. shadow 후, publication claim 후, 실제 파일 저장·영수증 기록 후 취소는 원장에 uncertain과 action.recovery를 보존했으나 Mission.lastError에서 대사 필요가 사라졌다. 취소는 새로운 작업 중단이지 이미 전달된 효과의 부재 증명이 아니므로 lastError에 원래 recovery 오류를 보존한다. CANCELLED 상태와 사용자 취소 이유는 유지하며 PAUSED로 되돌리거나 확인되지 않은 외부효과를 재시도하지 않는다.

## 실행과 검증

최종5개 파일76/76, fail0/skip0. 새5개의 phase는 prepared 직후, staging 이후 가용성 조회 종료, adapter shadow 후, publication claim 후, 실제 file publication과 PC 영수증 기록 후다. 앞 두 경우 B adapter dispatch0·파일 부재·SQL notDispatched=true·skipped를 확인했다. shadow/pub claim은 파일 부재와 uncertain을 함께 확인했고, 마지막은 JSON 파일을 실제로 다시 읽어 total42를 확인했다. 모든 경우 취소 주입1회, CANCELLED 유지, 이후 runMission 호출의 adapter 재실행0을 검사했다. in_flight/uncertain 효과를 근거 없이 미실행으로 바꾸지 않는다.

첫 공유 회귀는71/75였다. 2개는 SQL을 사용한 목표 정정 fixture가 remoteOperationStore 연결을 닫지 않아 Windows 임시 DB 삭제가 EBUSY로 실패한 종료 문제였다. fixture 종료 시 해당 연결을 닫도록 수정했다. 나머지2개 승인 gate 시험은 “승인 후”라는 현재 미검증 자연어 조건으로 별도 requirement-coverage guard를 작동시키고도 WAITING_APPROVAL을 기대한 과거 fixture였다. 해당 테스트는 자연어 조건 지원이 아니라 권한 gate와 취소를 검증하므로, 구체적인 원래 산출물 요청·READ_ONLY grant를 사용한다. 원래 파일 미생성/승인 전 차단/승인 후 생성/취소 후 차단 검사는 유지했다. gate 정상 완료는 text.equals 오라클을 추가해 실제 승인 완료 내용과 비교한다. 자연어 “승인 후” 조건 처리나 보안 경계를 느슨하게 하지 않는다. 중간74/75의 criterion-verifier-unavailable도 이 명시적 오라클로 해결했으며 최종76회에 모든 앞선 실패가 포함된다.

build/Core contract gate 통과. build는 제품 서비스 재시작이나 설치 EXE 업데이트가 아니다. 실제 계정·메일·거래·물리 기기 실행0, 외부 LLM 호출0, 비용미측정. 반복 실행 횟수를 합산한 성능 수치·100% 범용 취소 성공률로 표현하지 않는다.

## 인수와 후속

V3-068/041에 부분 증거를 연결한다. 원래100의 완료60/진행23/대기17은 유지한다. 실제 마이크 인식, 원격 공급자의 외부 쓰기 취소, 취소 후 원격 영수증 대사와 실제 사용자 화면은 별도 검증 대상이다. 이미 저장된 파일의 취소는 rollback 요청과 다르다. cancelled 상태를 유지한 채 결과 조회·대사할 수 있는 경로와 실제 음성 취소 연결이 다음 작업이다.

복원 시 늦은 stage/handoff 중단 action 상태와 uncertain lastError 투영을 함께 검토하며 effect 원장 상태·lease·영수증·재실행 차단은 보존한다. 기존 F/cognition 실제 기억·개인 프로필·운영 권한·예산은 변경하지 않았다.
`, { flag: 'wx' });
const evidencePaths = ['-report.md', '-source.json', '-baseline.txt', '-expanded-baseline.txt', '-regression.txt',
  '-final.txt', '-availability.txt', '-final-v2.txt', '-build.txt', '-contract.txt'].map(suffix => prefix + suffix);
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const gates = acceptance.stages.flatMap(stage => stage.gates);
if (gates.length !== 100 || gates.filter(gate => gate.status === 'verified').length !== 60) throw Error('Original acceptance scope changed');
for (const id of ['V3-068', 'V3-041']) {
  const gate = gates.find(item => item.id === id);
  gate.evidence = [...new Set([...(gate.evidence ?? []), ...evidencePaths])];
  gate.limitations = [...(gate.limitations ?? []), '2026-10-08: 실제 로컬 workflow/SQL 취소5지점·76회귀, 늦은 staging의 skipped 보존·취소된 uncertain lastError 보존. 실제 음성/원격 공급자 쓰기 취소·취소 후 원격 대사/UI는 미검증.'];
}
await writeFile(path, JSON.stringify(acceptance, null, 2) + '\n');
await writeFile(prefix + '-attempt.json', JSON.stringify({ id: 'mission-cancel-boundary-20261008',
  candidateId: 'korean-audio-correction-turn-readiness', kind: 'contract-test', reportedOutcome: 'passed', observedAt,
  hypothesis: '이미 제출된 Mission 취소를 실제 publication 경계에서 검증하면 미실행 skipped 상태와 이미 전달된 uncertain 대사 상태를 정확히 보존할 수 있다.',
  lesson: 'cancel은 rollback 증거가 아니다. await 이후 미실행 상태를 planned로 되살리지 않고, 이미 전달된 작업의 대사 오류를 취소 결과에도 보존해야 한다.',
  limitations: '격리된 합성 로컬 파일/실제 SQL·PC packet journal, 최종76/76/build/contract. 실제 음성·실기기·원격 공급자 취소/대사 미검증, 비용미측정, 운영활성화0, 공식verified60 유지.',
  evidencePaths }, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 제출된 Mission 취소5지점·미실행 skipped 복구/uncertain lastError 투영. 기준선4실패→최종76/76/build/contract, 기존fixture 조건2/Windows DB 종료2 교정 포함. 공식60/23/17 유지, 운영활성화0. 다음 cancelled 유지 상태에서 결과 조회·대사 및 실제 음성 취소 연결.\n`);
