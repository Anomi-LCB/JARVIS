import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { naturalMission50Cases } from './natural-mission-50-cases.mjs';

const root = resolve('artifacts/natural-mission-50-audit');
const load = async path => JSON.parse((await readFile(join(root, path), 'utf8')).replace(/^\uFEFF/, ''));
const baseline = await load('baseline-frozen-v1/report.json');
const integration = await load('integration-v1/report.json');
const final = await load('final-clean-v3/report.json');
const reverify = await load('reverification-v3/reverification.json');
const live = await load('validation/live-qa.json');
const performance = await load('validation/compiler-performance.json');
const verifierTests = await load('verifier-validation-final.json');
const log = await readFile(join(root, 'validation/full-tests-final.log'), 'utf8');
const build = await readFile(join(root, 'validation/build.log'), 'utf8');
const number = field => Number(log.match(new RegExp(`(?:#|ℹ) ${field} (\\d+)`))?.[1]);
const testCounts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(field => [field, number(field)]));
assert.equal(testCounts.fail, 0); assert.ok(testCounts.pass > 927);
assert.equal(final.passed, 50); assert.equal(final.failed, 0);
assert.equal(reverify.status, 'PASSED'); assert.equal(live.status, 'PASSED');
assert.match(build, /Built static JARVIS executive console into dist/);
assert.equal(new Set(naturalMission50Cases.map(c => c.category)).size, 10);
const clauseCount = naturalMission50Cases.reduce((sum, c) => sum + c.requirementCount, 0);
assert.equal(clauseCount, 426);
const durations = final.cases.map(c => c.durationMs).sort((a, b) => a - b);
const median = (durations[24] + durations[25]) / 2;
const p95 = durations[Math.ceil(durations.length * .95) - 1];
const categories = {
  'sales-intelligence': '매출과 고객 분석', 'customer-quality': '고객 데이터 품질',
  reconciliation: '두 시점 데이터 대사', 'ranking-window': '순위와 누적 계산',
  'statistical-analysis': '통계와 교차 검증', 'graph-planning': '의존 관계와 최적화',
  'file-forensics': '파일 조사와 증거', 'document-privacy': '텍스트 처리와 개인정보 보호',
  'exact-finance': '정밀 계산과 단위 변환', 'sqlite-persistence': '데이터베이스 영속성'
};
const firstMaskFailures = new Set(['N06', 'N07', 'N10', 'N36', 'N39', 'N40']);
function beforeReason(id) {
  if (['N07', 'N10', 'N37'].includes(id)) return '긴 요청을 단일 텍스트 파일 작성으로 축소하고 같은 대상을 재작성해 target-exists 오류가 발생했다.';
  if (id === 'N38') return '입력 텍스트의 파일 경로를 유지하지 못해 read-target-not-file 오류가 발생했다.';
  if (['N31', 'N32', 'N34', 'N35'].includes(id)) return '파일 조사 계획과 실제 macro.save 실행 도구가 달라 라우팅 검증이 실패했다.';
  return '저장이라는 표현을 macro.save로 오인해 복합 데이터 작업을 수행하지 못했고 G 실행 검증이 실패했다.';
}
const cases = [];
for (const item of naturalMission50Cases) {
  const result = await load(`final-clean-v3/cases/${item.id}/result.json`);
  const mid = integration.cases.find(c => c.caseId === item.id);
  const outputFiles = item.outputs.map(path => ({ label: path, path: join(root, 'final-clean-v3/cases', item.id, path).replaceAll('\\', '/') }));
  let sample = '';
  const first = outputFiles.find(file => file.label.endsWith('.json'));
  if (first) {
    const value = JSON.parse(await readFile(first.path, 'utf8'));
    const excerpt = JSON.stringify(Array.isArray(value) ? value.slice(0, 2) : value);
    sample = (Array.isArray(value) ? `총 ${value.length}행 중 앞부분: ` : '') + excerpt.slice(0, 300) + (excerpt.length > 300 ? '…' : '');
  }
  const integrationReason = firstMaskFailures.has(item.id) ? '첫 통합 시험에서는 마스킹 대체 문자열이 계약과 달랐다. 기본값 통일 후 통과했다.'
    : item.id === 'N47' ? '첫 통합 시험에서는 SQLite의 고유 제약 없는 테이블에 키 갱신을 시도해 실패했다. 키 유효성 검증과 고유 인덱스 생성 후 통과했다.'
    : '첫 통합 시험부터 실행과 내용 검증을 통과했다.';
  cases.push({ id: item.id, title: item.title, category: categories[item.category] ?? item.category,
    clauseCount: item.requirementCount, command: item.command, before: '실패', after: '성공',
    integration: mid.productPass ? '성공' : '실패', durationMs: result.durationMs,
    reason: `${beforeReason(item.id)} ${integrationReason} 최종에는 전체 절 실행, G 검증, 입력 보존, 독립 정답 검증이 모두 통과했다.`,
    outputs: item.outputs, outputFiles, sample,
    evidencePath: join(root, `final-clean-v3/cases/${item.id}/result.json`).replaceAll('\\', '/'),
    commandSha256: result.commandSha256 });
}
const report = {
  title: 'JARVIS 복합 명령 50개 개선 결과 보고서', date: '2026년 9월 8일',
  overview: [
    '이번 작업에서는 기존 기본 실행 경로가 처리하지 못했던 복합 명령 50개를 선정하고, 동일한 명령과 입력으로 수정 전후를 비교했습니다. 최종 결과는 50개 성공, 0개 실패입니다. 총 426개 지시를 실제로 실행해 파일 100개를 만들었으며, 별도 검증기로 내용과 실행 증거를 다시 확인했습니다.',
    '처음에는 50개 모두 실패했습니다. 구조 개선 후 첫 통합 시험에서 43개가 성공했고, 남은 7개를 수정해 50개를 통과시켰습니다. 이후 실제 제어센터에서 추가로 발견한 완료 판정과 동일 명령 재실행 결함까지 고친 뒤, 최종 코드로 50개 전체를 다시 실행했습니다.',
    '이 성과는 한국어로 이름 붙인 데이터를 단계별로 처리하는 로컬 작업에 대한 것입니다. 인터넷 검색, 메일 전송, 다른 앱 제어를 섞은 50개 실사용 임무를 완료했다는 의미는 아닙니다. 어떤 입력과 범위에서 성공했는지, 무엇을 고쳤는지, 앞으로 무엇을 보강해야 하는지를 이 보고서에 구분해 기록했습니다.'
  ],
  metrics: [
    ['실제 복합 명령', '50개 / 10개 분야 / 지시 총 426개'],
    ['문장별 복잡성', '5~16개 지시 / 10개 문장은 12개 이상'],
    ['수정 전', `${baseline.passed}개 성공 / ${baseline.failed}개 실패`],
    ['첫 통합 시험', `${integration.passed}개 성공 / ${integration.failed}개 실패`],
    ['최종 코드 실행', '50개 성공 / 0개 실패'],
    ['독립 재검증', '실행 영수증 426개 / 결과 파일 100개 / G 검사 1300개 확인'],
    ['기존 기능 회귀', `${testCounts.pass}개 통과 / ${testCounts.fail}개 실패 / ${testCounts.skipped}개 건너뜀`],
    ['실제 제어센터', '8단계 명령 완료 / 자동 목표 분리 / 추가 확인 0회'],
    ['계획 생성 지연', `중앙값 ${performance.cold.medianMs.toFixed(3)}ms → 캐시 사용 ${performance.warm.medianMs.toFixed(3)}ms`]
  ],
  sections: [
    ['무엇을 실제로 실행했는가', [
      '10개 분야는 매출 분석, 고객 품질, 시점별 대사, 순위·누적, 통계, 의존 관계·최적화, 파일 조사, 텍스트·개인정보 보호, 정밀 계산·단위 변환, SQLite 저장입니다. 각 분야에 5개 명령을 배치했습니다. 최대 2000행 입력, 중첩 품목 전개, 할인 후 금액 계산, 팀별 동점 순위, 임계 경로, 자원 제한 일정, 예산 제한 선택, 파일 해시, 민감정보 마스킹과 저장 후 재조회 등을 조합했습니다.',
      '명령을 제품의 기본 MissionRuntime과 GoalExecutivePlanner에 하나씩 전달했습니다. 새 자연어 컴파일러가 입력 문장의 각 절을 작업 그래프로 바꾸고, Core 작업자와 실제 PC Agent 어댑터가 실행하며 G가 파일과 도구 증거를 검증했습니다. 미리 작성한 .workflow.json을 실행한 방식이나 사례 ID에 따라 답을 반환하는 방식은 사용하지 않았습니다.',
      '재현성을 위해 합성 입력과 명령, 독립 정답 계약을 첫 실행 전에 고정했습니다. 외부 LLM 계획기와 실시간 네트워크는 이 50개 시험에서 끈 상태였습니다. 그래서 수정 전 0/50은 이 기본 로컬 경로에서의 결과이며, 기존 시스템의 모든 다른 실행 모드가 항상 실패했다는 결론은 아닙니다.'
    ]],
    ['새로 추가한 내부 구조', [
      '각 데이터에 이름을 붙인 한국어 요청을 정형 실행 계획으로 바꾸는 컴파일러를 추가했습니다. 읽기, 계산, 정규화, 필터, 조인, 순위, 통계, 저장, 다시 읽기와 검증을 서로 연결합니다. 인식하지 못한 절이 있으면 조용히 빠뜨리고 성공으로 끝내지 않습니다. 명령 해시, 절과 실행 노드의 연결, 실제 실행된 계획 해시를 남깁니다.',
      '워크플로 연산을 31개에서 42개로 확장했습니다. 필드 추출, 계산 필드, 중첩 전개, 상위 제한, 합치기, 시점 대사, 순위·누적, 통계, 값 정규화, 문자열 치환, 민감정보 마스킹의 11개 연산을 추가했습니다. 계산은 임의 코드 실행 없이 처리하고, 데이터 크기와 행 수 상한을 적용합니다.',
      '원문에서 만든 계획을 파일 중간 저장 없이 검증한 뒤 PC Agent로 전달하도록 연결했습니다. 순수 계획은 명령과 작업공간을 구분해 전체 최대 128개까지 재사용하되 데이터나 파일 실행 결과는 캐시하지 않습니다. 여러 절을 가진 문장은 빠른 작업 입력창에서도 목표 실행으로 자동 분리됩니다.',
      '파일을 모두 계산하고 검증한 뒤 게시하는 기존 구조를 유지하면서, 같은 작업 안에서 방금 저장한 파일을 다시 읽을 때는 임시 결과를 참조하도록 보완했습니다. 입력 파일과 출력 파일의 역할, CSV 숫자 비교, 점이 포함된 필드 이름, SQLite 키 갱신도 일관되게 처리합니다.'
    ]]
  ],
  repairs: [
    { name: '복합 명령이 단일 도구로 축소되는 문제', problem: '기준 시험 50개가 모두 실패했고 46개에서 macro.save가 호출됐습니다. 3개는 파일 작성 반복, 1개는 파일 경로 유실이 발생했습니다. 화면용 명령 분류도 41개를 단일 작업으로 오인했습니다.', cause: '저장 등 일부 단어에 의존하는 기존 기본 계획이 전체 문장의 의존 관계를 보존하지 못했습니다.', solution: '새 컴파일러와 기본 계획기를 연결하고 다중 절 분류를 보완했습니다. 고정 50개 모두 workflow.execute로 실행됐고, 모든 절과 실제 G 증거를 확인했습니다.' },
    { name: '마스킹 대체 문자열의 불일치', problem: '첫 통합 시험 N06 N07 N10 N36 N39 N40에서 실행 자체는 끝났지만 독립 내용 검증은 실패했습니다.', cause: '컴파일러가 대체 문자열을 *로 덮어썼고 어댑터 기본 계약과 독립 기대값은 [REDACTED]였습니다. 지정한 대상 필드의 가림 자체는 수행됐으며 대체 문자열 계약 차이였습니다.', solution: '컴파일러의 임의 덮어쓰기를 제거해 어댑터 기본값을 따르게 했습니다. 원래 정답 계약을 유지한 채 이메일·전화번호와 후속 템플릿 처리까지 재검증했습니다. 명령이 지정하지 않은 필드까지 익명화하는 기능은 아니며, N39의 별도 메모 필드처럼 원래 합성 내용이 유지되는 항목도 있습니다.' },
    { name: 'SQLite 갱신 저장 실패', problem: 'N47에서 키 없이 생성한 테이블을 id 기준으로 갱신할 때 ON CONFLICT 오류가 발생했습니다.', cause: 'SQLite 갱신에 필요한 PRIMARY KEY 또는 UNIQUE 제약이 초기 테이블에 없었습니다.', solution: '기존·새 데이터의 키 누락, null, 중복을 먼저 검증하고 임시 DB에 고유 인덱스를 생성합니다. 키만 있는 행도 처리하며, 검증 실패 시 이미 게시된 DB를 보존하는 별도 5개 회귀 시험을 통과했습니다.' },
    { name: '값을 조용히 덮어쓰는 네 가지 경계 결함', problem: '조인 필드명 충돌, null 또는 누락 조인 키, 그룹 집계 별칭 충돌, 피벗 열 이름 충돌이 일부 데이터를 잘못 결합하거나 덮어쓸 수 있었습니다.', cause: '필드 이름과 키의 유효성을 확인하기 전에 결과 객체를 조립했습니다.', solution: '충돌과 누락을 명시적 오류로 처리하도록 보완했습니다. 정상 right_ 접두사와 기존 연산은 유지하고, 네 가지 최소 재현 및 기존 어댑터 시험을 통과했습니다.' },
    { name: '실제 화면의 완료 판정 오탐', problem: '8단계 파일 작업이 정확히 실행됐는데도 제어센터는 완료를 차단했습니다.', cause: '전체 원문을 성공 기준으로 쓰는 화면 경로에서 source.json을 생성해야 할 출력으로 읽었고 source라는 파일명 일부를 뉴스 출처 요구로 해석했습니다.', solution: '이름 붙인 JSON CSV 텍스트 읽기를 입력 역할로 인식하고, 출처 요구 판정에서 파일명 토큰을 제외했습니다. 실제 출처 요구나 미생성 출력은 계속 차단되는 4개 회귀 시험을 통과했고 실제 화면에서도 완료를 확인했습니다.' },
    { name: '같은 명령의 재실행 오탐', problem: '기존 결과와 바이트가 같은 파일을 재사용하자 G가 Undo 기록과 롤백이 없다는 이유로 실패했습니다.', cause: '변경 없는 게시 생략 결과에도 변경 작업과 같은 롤백 조건을 요구했습니다.', solution: '변경 전후 해시, 변경 항목, 출력 목록과 G가 다시 읽은 실제 파일이 모두 일치할 때만 무변경 완료로 인정합니다. 파일 수정 시각과 Undo 기록이 늘지 않으면서 새 미션이 완료됐습니다. 잘못된 증거 25종은 별도 5개 테스트에서 모두 차단됐습니다.' }
  ],
  verification: [
    `최종 전체 회귀는 ${testCounts.tests}개 중 ${testCounts.pass}개 통과, 실패 ${testCounts.fail}개, 건너뜀 ${testCounts.skipped}개입니다. 건너뛴 항목은 선택적인 실제 Google News RSS 호출 시험으로, 활성화 환경변수 JARVIS_NEWS_LIVE_SMOKE가 설정되지 않아 실행하지 않았습니다. 빌드도 완료했습니다.`,
    '독립 재검증기는 고정 명령·입력·정답 계약의 동일성, 결과 파일 해시와 내용, 실행 장부 연결, Mission Core PC G 기록, 계획 해시와 426개 노드 영수증을 확인했습니다. 검증기 15개 시험은 정상 계약·실행과 변조·삭제·위조·일정 계산 경계를 함께 확인합니다. 저장된 성공 표시만 믿지 않고 결과 내용을 바꾸고 해시를 다시 계산한 경우도 탐지했습니다.',
    '실제 제어센터 시험은 별도로 수행했습니다. 빠른 작업 입력창에 8개 지시를 넣고 실행하자 목표 실행으로 자동 전환했고, 기존 자동 승인 설정에 따라 세션을 준비했습니다. 마지막 화면은 완료 1/1 및 검증 완료였습니다. 결과 순서는 노트 36, 연필 35, 펜 32였고 합계 103, 중앙값 35를 확인했습니다. 추가 사용자 확인은 없었고 브라우저 경고·오류도 없었습니다.',
    `최종 50개 사례의 실행 및 증거 생성 시간은 중앙값 ${median}ms, P95 ${p95}ms, 범위 ${durations[0]}~${durations.at(-1)}ms였습니다. 이는 이 PC의 합성 로컬 입력·파일 I/O·실행·내용 검증을 포함한 측정이며, 외부 서비스나 일반 실사용 응답속도의 보장은 아닙니다.`,
    `계획 생성만 따로 250쌍 비교했습니다. 캐시 미사용 중앙값 ${performance.cold.medianMs.toFixed(3)}ms와 캐시 사용 ${performance.warm.medianMs.toFixed(3)}ms로 약 ${(performance.cold.medianMs / performance.warm.medianMs).toFixed(2)}배 차이였습니다. P95는 ${performance.cold.p95Ms.toFixed(3)}ms와 ${performance.warm.p95Ms.toFixed(3)}ms였습니다. 250쌍의 계획은 동일했으며 모델 호출은 0회였습니다. 이 수치를 전체 작업이 5배 빨라졌다는 뜻으로 사용하지 않습니다.`,
    '기존 생산용 Undo 로그 2개는 작업 전후 해시와 바이트 크기가 같았습니다. 50개 캠페인은 사례별 격리된 감사 폴더를 사용했습니다. 실제 서비스는 Core PC Agent Bridge 제어센터 모두 정상 신원과 연결 상태를 확인했습니다. 처음 시작할 때 남아 있던 다른 신원의 Bridge 프로세스는 대상 스크립트와 고아 상태를 확인한 뒤 정리했습니다.'
  ],
  recommendations: [
    { priority: 'P0', name: '대화에서 파일과 버전을 정확히 이어 받기', reason: '현재 WorkMemory는 최근 결과를 기억하지만 동일한 이름의 파일이나 여러 프로젝트가 섞이면 최신 항목을 잘못 선택할 수 있습니다. 사용자가 그 보고서만 고쳐줘라고 했을 때 올바른 대상을 잡는 것이 체감 정확도를 크게 높입니다.', next: '대화·프로젝트 범위, 산출물 ID·내용 해시·버전을 기억에 추가하고 명시적으로 언급한 파일을 우선합니다. 확실한 한 후보는 즉시 실행하고 다른 파일 두 개가 동률인 경우에만 질문합니다.', source: 'packages/core/src/conversation-memory.js의 WorkMemory 기록과 참조 해석' },
    { priority: 'P0', name: '중단 후 실제 실행 기록에 맞춰 재개하기', reason: '기존 임무 복구와 패킷 중복 방지는 있지만 실행 직후 상태 저장 전에 종료된 경우에는 실제 결과와 재개 계획을 맞추는 연결이 중요합니다.', next: '영속 operationId와 실행 영수증을 연결하고 파일 해시·패킷 원장을 대조한 뒤 남은 일만 재개합니다. 게시 직후·검증 직후 강제 종료 시험으로 중복과 누락을 측정합니다.', source: 'packages/core/src/mission/mission-runtime.js와 apps/pc-agent/src/pc-agent-runtime.js의 복구·패킷 원장' },
    { priority: 'P1', name: '자유로운 표현을 같은 검증된 계획으로 연결하기', reason: '이번 컴파일러는 빠르고 정확하지만 지원 문법 밖의 자유로운 설명을 모두 해석하지는 않습니다. 기존 LLM 계획 기능을 이 정형 실행 경로와 결합하면 실제 명령의 표현 범위를 넓힐 수 있습니다.', next: '지원 문법은 즉시 컴파일하고, 다른 표현은 기존 계획기가 형식 있는 후보 계획을 만들게 합니다. 모든 요구의 대응, 대상 파일, 도구 능력과 예산을 정적 검증한 후 동일한 실행·G 검증을 거치게 합니다. 수정에 쓰지 않은 사용자 표현으로 누락률과 질문 횟수를 평가합니다.', source: 'packages/core/src/mission/natural-workflow-compiler.js 및 기존 mission 계획기' },
    { priority: 'P1', name: '개인 선호가 결과에 실제 반영되도록 검색 개선하기', reason: '선호 범위·개정·철회 기능은 이미 있지만 계획 문맥 검색이 첫 단어에 민감합니다. 같은 뜻을 다른 어순으로 말해도 같은 말투와 형식이 적용되어야 합니다.', next: '작업 유형과 사용자·프로젝트 범위로 선호를 선택하고 이번 명령의 예외를 우선합니다. 적용한 선호 ID와 결과 설정을 기록해 실제 출력의 일관성과 재수정률을 측정합니다.', source: 'apps/growth-memory/src/growth-runtime.js planningPreferenceContext' },
    { priority: 'P1', name: '외부 작업 결과가 애매할 때 자동으로 조회하기', reason: '기존 메일 경로에는 수락 증거와 중복 방지가 있지만 서버가 처리한 뒤 응답만 끊긴 상황은 추가 조회가 필요합니다. 이를 해결하면 불필요한 재승인과 중복 전송을 함께 줄일 수 있습니다.', next: '이미 연결된 계정의 읽기 API로 요청 ID 또는 메시지 신원을 조회하고 수신자·첨부 해시를 대조합니다. 공급자 수락, 보낸 편지함 확인, 실제 전달을 구분합니다. 실제 계정 시험은 이번 로컬 결과와 별도로 측정합니다.', source: 'apps/pc-agent/src/pc-agent-runtime.js의 SMTP 실행 증거와 불명확 전송 처리' },
    { priority: 'P1', name: '이력이 늘어도 입력 응답이 느려지지 않게 만들기', reason: '현재 임무 상태는 전체 JSON을 동기 기록합니다. 이력이 쌓이면 저장이 입력 응답을 막을 가능성이 있으므로 먼저 실제 병목을 계측해야 합니다.', next: '계획·대기·입출력·검증·저장을 따로 측정하고 변경된 임무의 순서 보장 쓰기 큐와 주기적 스냅샷을 도입합니다. 이력 100 1000 10000건에서 P50 P95와 이벤트 루프 지연을 비교하며, 필수 실행 기록은 유지합니다.', source: 'packages/core/src/mission/mission-store.js 및 mission-runtime.js 상태 저장' },
    { priority: 'P1', name: '실패 기억을 재현 가능한 검증으로 바꾸기', reason: '기존 실패 분류와 학습 검증을 고정 재현 입력 및 수정 버전에 연결하면 비슷한 실수의 반복을 줄일 수 있습니다. 대화 설명만 저장하는 것으로는 해결 여부를 알 수 없습니다.', next: '원본 이벤트와 도구 계약에 근거한 안정 ID, 개인정보를 제거한 재현 입력, 독립 정답, 수정 버전을 연결합니다. 다른 표현의 미사용 입력에서도 통과해야 해결책으로 채택합니다.', source: 'apps/growth-memory/src/growth-runtime.js의 실패 기억과 계획 점검 항목' }
  ],
  limits: [
    '이번 50개는 요구한 3~20개 범위 안에서 문장당 5~16개 작업을 조합한 시험입니다. 실패했던 여러 기능을 조합했지만 모든 종류의 고난도 지식 업무나 외부 앱 작업을 대표하는 통계 표본은 아닙니다. 동일 자료의 반복 통과율로 모든 자연어 명령의 성공 확률을 계산할 수 없습니다.',
    '개선된 빠른 경로는 이름 붙인 데이터와 명시적인 동작을 지원하는 한국어 문법에 한정됩니다. 지원하지 않는 절은 차단하며, 자유로운 대화의 모든 모호함을 자동으로 해결했다고 주장하지 않습니다. 새 데이터 연산은 기본적으로 10000행과 16MiB 상한이 있고, 이 캠페인의 최대 입력은 2000행입니다.',
    '통계는 부동소수점 계산을 사용합니다. 별도의 정밀 원장 연산과 일반 평균·분산의 정확도 계약은 구분해야 합니다. 파일 저장과 SQLite 시험은 실제 로컬 작업이지만 외부 인증·권한·요금·네트워크·사이트 변경은 이번 성공률에 포함되지 않습니다.',
    '실제 화면 시험과 전체 회귀에서 이번 변경과 관련해 발견한 결함은 수정 후 재검증했습니다. 추천 7개는 후속 구현 과제이며 이번에 모두 추가한 기능이 아닙니다. 개인 비서다운 사용 경험은 대상 기억, 의도 반영, 일의 연속성, 정확한 결과와 간결한 대화로 발전시킬 수 있지만 자아나 의식을 구현·입증한 것은 아닙니다.'
  ],
  cases,
  evidence: [
    ['최종 50개 실행 요약', 'final-clean-v3/report.json'], ['최종 원문과 파일 및 실행 기록', 'final-clean-v3/cases'],
    ['수정 전 실패 원인 분석', 'baseline-analysis.json'], ['독립 재검증', 'reverification-v3/reverification.json'],
    ['검증기 회귀 결과', 'verifier-validation-final.json'], ['실제 화면 및 산출물 확인', 'validation/live-qa.json'],
    ['전체 회귀 로그', 'validation/full-tests-final.log'], ['빌드 로그', 'validation/build.log'],
    ['계획 캐시 성능 원자료', 'validation/compiler-performance.json']
  ].map(([label, path]) => ({ label, path: join(root, path).replaceAll('\\', '/') })),
  provenance: { corpusSha256: final.corpusSha256, fixtureSha256: final.fixtureSha256, oracleSha256: final.oracleSha256,
    campaignSha256: final.campaignSha256, implementationManifestSha256: final.implementationManifestSha256,
    ledgerHead: final.ledgerHead, testCounts, verifierTests }
};
const out = join(root, 'report'); await mkdir(out, { recursive: true });
await writeFile(join(out, 'integrated-report.json'), JSON.stringify(report, null, 2));
const md = [`# ${report.title}`, `작성일 ${report.date} · 작성 Codex · 수신 JARVIS 사용자`, ...report.overview,
  '## 검증 결과', '| 항목 | 확인된 결과 |\n|---|---|\n' + report.metrics.map(row => `| ${row.join(' | ')} |`).join('\n')];
for (const [heading, paragraphs] of report.sections) md.push(`## ${heading}`, ...paragraphs);
md.push('## 실패 원인과 실제 수정');
for (const repair of report.repairs) md.push(`### ${repair.name}`, repair.problem, `원인: ${repair.cause}`, `수정: ${repair.solution}`);
md.push('## 추가 검증과 성능', ...report.verification, '## 권장하는 다음 개선');
for (const item of report.recommendations) md.push(`### ${item.priority} ${item.name}`, item.reason, item.next, `근거: [프로젝트 코드](<${resolve(item.source.match(/^[\w/.-]+\.js/u)[0]).replaceAll('\\', '/')}>). ${item.source}`);
md.push('## 검증 범위와 남은 한계', ...report.limits, '## 50개 미션 결과 목록',
  '| ID | 명령 | 지시 수 | 수정 전 | 첫 통합 | 최종 |\n|---|---|---:|---|---|---|\n' + cases.map(c => `| ${c.id} | ${c.title} | ${c.clauseCount} | 실패 | ${c.integration} | 성공 |`).join('\n'),
  '## 실제 명령과 개별 증거');
for (const c of cases) md.push(`### ${c.id} ${c.title}`, `${c.category} · 지시 ${c.clauseCount}개 · 최종 성공 · ${(c.durationMs / 1000).toFixed(3)}초`, c.command,
  c.reason, c.sample, `결과: ${c.outputFiles.map(file => `[${file.label}](<${file.path}>)`).join(' · ')}`, `[개별 실행과 검증 기록](<${c.evidencePath}>)`);
md.push('## 증거 위치', ...report.evidence.map(e => `[${e.label}](<${e.path}>)`), '## 고정 식별자',
  `명령 집합 SHA-256: ${final.corpusSha256}`, `입력 계약 SHA-256: ${final.fixtureSha256}`, `정답 계약 SHA-256: ${final.oracleSha256}`,
  `최종 제품 소스 manifest SHA-256: ${final.implementationManifestSha256}`, `최종 증거 장부 head: ${final.ledgerHead}`);
await writeFile(join(out, 'JARVIS_복합명령50_개선결과보고서.md'), md.filter(Boolean).join('\n\n') + '\n');
console.log(JSON.stringify({ out, cases: cases.length, testCounts, medianMs: median, p95Ms: p95 }, null, 2));
