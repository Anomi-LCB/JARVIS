import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/cancelled-review-ui-20261008', observedAt = new Date().toISOString();
const regression = await readFile(prefix + '-regression.txt', 'utf8');
if (!regression.includes('ℹ pass 59') || !regression.includes('ℹ fail 0') || !regression.includes('ℹ skipped 0')) throw Error('Terminal regression required');
const browser = JSON.parse(await readFile(prefix + '-browser/report.json', 'utf8'));
if (browser.length !== 3 || browser.some(item => !item.realCorePcG || !item.verifiedThenChanged || item.reexecutionRequests !== 0 || item.pageErrors.length || item.horizontalOverflow)) throw Error('Browser evidence required');
if (!(await readFile(prefix + '-build.txt', 'utf8')).includes('Built static JARVIS') ||
    !(await readFile(prefix + '-contract.txt', 'utf8')).includes('gatePassed: true')) throw Error('Build/contract required');
const sources = ['src/ui/cancelled-mission-review.js', 'src/ui/app.js', 'src/ui/workspace/app.js', 'src/ui/styles.css',
  'tests/cancelled-mission-review-ui.test.js', 'tests/ui-mission-selection.test.js',
  'tests/fixtures/cancelled-review-browser.mjs', 'scripts/cancelled-review-browser-qa.py'];
await writeFile(prefix + '-source.json', JSON.stringify({ observedAt, sources: await Promise.all(sources.map(async path => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex')
}))) }, null, 2), { flag: 'wx' });
await writeFile(prefix + '-report.md', `# 중단한 작업의 실제 결과 조회 화면

관측 ${observedAt}. 기존 ADMIN cancellation-review API와 자료 범위별 읽기/G 검사 경로를 일반 작업 공간과 고급 목표 화면에 연결했다. 조회 자체가 실행 권한이 되지 않으며 Mission이나 Effect 상태를 바꾸지 않는다.

## 사용자 기능

일반 사용자는 작업에서 취소된 목표를 열고 '실행 결과 확인'을 누른다. 실행 결과 확인됨·실행 결과 미확인·시작하지 않음·실행기에 전달되지 않음을 구분한다. 취소 전에 일부 결과가 만들어질 수 있음과, 조회가 재실행/원상 복구가 아님을 표시한다. 미확인 자료 권한은 연결·위임 확인을, 미지원 도구는 해당 앱의 직접 확인을 안내한다. 나머지 불명 결과에는 처리 기록 확인과 중복 재실행 위험을 설명한다.

서버 응답의 Mission ID·원문 해시·목표 revision·관측 버전·CANCELLED 상태·영향/기억 변경 없음·항목 상태·확인값·미확인 개수를 검사한다. 잘못된 응답은 확인된 결과로 표시하지 않는다. 표시는 탭 내부의 endpoint/목표/원문 revision별로 분리하고 재조회 중 이전 성공을 숨긴다. 중복 클릭은 하나의 요청만 수행한다. 오류는 원문 코드/경로/자료를 노출하지 않고 현재 앱 client의 payload 오류 계약으로 다음 조치를 보여준다. 이전 기록에 원문 조회 기준이 없으면 버튼을 비활성화한다.

기존 밝은 화면과 상태·버튼 구성 요소를 유지했다. 고급 화면에도 기존 밝은 자료 패널의 의미 색상을 재사용했으며 반짝이는 별표는 추가하지 않았다. Paperclip의 상태 표현과 가까운 오류 안내 원칙을 적용했다. 한국어 인터페이스이며 이 새 패널의 영어 번역은 아직 완료하지 않았다.

## 검증과 발견

최종 공유 6개 파일59/59, 실패0·생략0. focused19/19는 중복 합산하지 않는다. HTTP request 본문에 expectedGoalRevision·expectedObjectiveSha256만 전달하며 resume/reconcile 명령을 넣지 않는다. 실행 권한을 주장하는 응답·다른 목표·틀린 확인값·미확인 개수, source conflict와 active-run 오류를 검사했다. 기존 작업 공간과 목표 목록·취소·위임별 결과 조회의 회귀를 함께 실행했다.

실제 Chrome headless 브라우저에서 일반 데스크톱1440px·모바일390px·고급 화면1440px 총3개 화면을 검증했다. 격리 임시 SQL/Core/PC 워크플로/G를 사용해 JSON 결과를 실제 생성하고 영수증 직후 Mission을 취소했다. 각 화면에서 실제 ADMIN proxy API 조회200/verified-executed를 확인하고, 결과 파일을99로 바꾼 뒤 두 번째 조회에서 unresolved와 화면의 미확인 안내로 바뀌는 것을 확인했다. 화면마다 조회2회, 재실행 요청0, pageerror0, 가로 넘침0. 모바일 스크린샷에서도 읽을 수 있는 폭과 다음 조치를 확인했다.

초기 브라우저 시도는 Python의 하이픈 파일명 import 오류와 시험 fixture의 기억 저장소 미설정으로 실패했다. 고급 화면만 연결한 상태에서는 기본 entry가 사용하는 일반 작업 공간에 패널이 없어 양쪽에 연결했다. fixture reset이 실제 pretty JSON 바이트를 짧은 JSON으로 바꿔 ARTIFACT_CHANGED가 발생한 시도도 보존했다. 실제 생성된 원본 바이트를 보관해 reset하도록 고쳤으며 검증기를 완화하지 않았다. 실패 로그들은 시행착오이며 제품 성공으로 집계하지 않는다.

빌드와 additive Core 계약 통과. 이는 정적 dist 생성과 격리 브라우저 기능 증거이며 설치된 Windows 프로그램/운영 서비스 활성화·정상 상시 서비스·실제 음성/Android/외부 계정 성공을 뜻하지 않는다. 브라우저의 실서비스 연결/알림 경고는 격리 fixture의 미제공 서비스이며 새 UI의 실행 가능성을 증명하는 것으로 쓰지 않는다. 준비된 사용자 계정이나 운영 F/cognition은 사용하지 않았고 생성한 임시 프로세스는 종료했다. 사용자 업무의 p50/p95·사용자 만족·모델 비용은 미측정이다.

## 진행과 다음 작업

공식 완료60·진행23·대기17 유지. V3-041/068의 부분 증거이며 90% 목표는 아직 미달이다. 다음은 실제 음성·로그인 인계/정정/취소 및 앱별 결과 확인 범위를 확장하고 남은 인수 조건과 대조한다. UI 존재만으로 물리 기기·실계정·장기 관측 인수를 올리지 않는다. 복원은 새 패널 모듈과 양쪽 render/click 연결을 함께 제거하는 좁은 변경이며 서버의 기존 조회/권한 경계를 완화하지 않는다.
`, { flag: 'wx' });
const evidencePaths = ['-report.md', '-source.json', '-focused.txt', '-regression.txt', '-browser-final.txt',
  '-browser/report.json', '-browser/desktop-verified.png', '-browser/mobile-changed.png', '-browser/advanced-changed.png',
  '-browser-v3.txt', '-browser-v5.txt', '-build.txt', '-contract.txt'].map(s => prefix + s);
const path = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const gates = acceptance.stages.flatMap(s => s.gates);
if (gates.length !== 100 || gates.filter(g => g.status === 'verified').length !== 60) throw Error('Acceptance scope changed');
for (const id of ['V3-041', 'V3-068']) {
  const gate = gates.find(g => g.id === id);
  gate.evidence = [...new Set([...(gate.evidence ?? []), ...evidencePaths])];
  gate.limitations = [...(gate.limitations ?? []), '2026-10-08: 취소 결과 조회 UI 일반/모바일/고급3화면 실제 로컬 Core/PC/G verified→파일 변경 unresolved 검증, 재실행0. 공유59/59/build/contract. 실음성·원격/실계정·운영 활성화·영어 패널 미완료.'];
}
await writeFile(path, JSON.stringify(acceptance, null, 2) + '\n');
await writeFile(prefix + '-attempt.json', JSON.stringify({ id: 'cancelled-review-ui-20261008',
  candidateId: 'm02-separate-process-mission-recovery-adapter', kind: 'workflow-test', reportedOutcome: 'passed', observedAt,
  hypothesis: '취소 효과의 읽기 전용 조회를 일반 작업 화면에 원문 CAS와 상태별 다음 조치로 연결하면 실행 결과와 취소를 혼동하지 않고 기존 기록을 확인할 수 있다.',
  lesson: '실제 기본 entry와 고급 entry를 모두 검사해야 한다. 동일한 JSON 값도 실제 생성 파일의 바이트가 바뀌면 현재 artifact 확인으로 승격하면 안 된다. client의 실제 오류 payload 계약을 사용한다.',
  limitations: '격리 실제 Core/PC JSON/G 및 Chrome3화면,59회귀. 실음성/실계정·운영 활성화·영어 새패널·장기 관측 미완료, 비용/업무p50p95미측정. 공식60/23/17 유지.', evidencePaths }, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 취소 실제 결과 조회 UI 일반/모바일/고급3화면 실제 Core-PC-G/파일 변경 반례/재실행0. 공유59/59/build/contract. 공식60/23/17 유지. 다음 실제 음성 인계·취소와 앱별 결과 확인 범위, 잔여 인수 조건 대조.\n`);
