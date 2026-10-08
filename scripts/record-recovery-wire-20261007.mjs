import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/recovery-wire-20261007';
const observedAt = new Date().toISOString();
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const calibration = await readJson(prefix + '-calibration.json');
const negative = await readJson(prefix + '-negative.json');
const ledgerText = await readFile('artifacts/research-heartbeat-20261007-ledger-status.txt', 'utf8');
const ledger = JSON.parse(ledgerText.slice(ledgerText.indexOf('{')));
const review = ledger.candidates.map(c => ({ id: c.id, nextReason: c.nextReason,
  failedAttempts: c.attempts.filter(a => a.reportedOutcome === 'failed').map(a => a.id),
  changedEvidenceAttempts: c.attempts.filter(a => (a.evidence ?? []).some(e => ['changed', 'missing'].includes(e.integrity))).map(a => a.id) }));
const save = (suffix, body) => writeFile(prefix + suffix, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
await save('-review.json', { observedAt, watch: await readJson('.runtime/research-watch/latest.json'),
  candidatesReviewed: ledger.candidateCount, review,
  meaning: 'Existing changed/missing snapshots were identified, not repaired or validated; queue percentage is not reaudited by this lookup.',
  sources: [
    { url: 'https://developers.openai.com/api/docs/guides/agents-api/overview', checkedAt: observedAt, finding: 'Managed harness/session/recovery; application supplies tools. No evidence that latest raw HTML change is a new release.' },
    { url: 'https://developers.openai.com/api/docs/guides/agents/sdk', checkedAt: observedAt, finding: 'Application owns deployment, tools, state and approval. Preserve Core/E/G; no installation this turn.' },
    { url: 'https://developers.openai.com/api/docs/changelog', checkedAt: observedAt, finding: 'Oct6 Decisions beta is already a recorded JARVIS candidate; no duplicate candidate or API call. Vendor latency is not JARVIS timing.' },
    { url: 'https://nodejs.org/api/string_decoder.html', checkedAt: observedAt, finding: 'Multibyte UTF-8 may cross Buffer boundaries. Replacement decoder unsuitable for validating unaltered evidence.' }
  ] });
await save('-source.json', { observedAt, sources: await Promise.all([
  'packages/shared/src/recovery-comparison.js', 'tests/recovery-comparison-wire.test.js'
].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))) });
const arm = calibration.summary.candidate.all;
const report = `# 복구 비교 증거의 UTF-8 보존 — 2026-10-07

관측 ${observedAt}. research:watch→ledger sync→status 순서 실행. 감시6곳 중 raw 내용변화3/동일3/오류0; 후보52개. 원문 재검토에서 API·SDK 설명과 Oct6 Decisions beta를 확인했다. Decisions는 이미 후보에 있어 중복 구현하지 않는다. raw 해시변화 자체를 새 출시/채택 근거로 계산하지 않았다.

현재 부족한 기능에서 비교기 전송결함을 재현했다. 자식 stdout 청크마다 toString('utf8')을 호출해 한글·이모지 바이트가 분할되면 대체문자가 증거에 들어갔다. 잘못된 UTF-8도 대체문자로 바꾸어 정상JSON/완료로 받아들였다. 변경전4시험 중2실패/2통과 보존. 초기 malformed 테스트는 nonzero exit를 아직 자극하지 않았고 최종에 추가했다.

기존 64KiB stdout+stderr 총 원시바이트 한도를 그대로 적용하면서 stdout을 Buffer로 수집한다. close 후 하나의 TextDecoder fatal UTF-8 검사와 JSON 파싱을 수행한다. 잘못된/끝이 잘린/overlong UTF-8은 WORKER_FAILED로 남긴다. 과대출력은 OUTPUT_LIMIT와 기존 종료절차 유지. 바이트한도는 프로세스 전체 메모리 한도가 아니다. 최대 Buffer 복사/concat/문자열·객체 오버헤드가 있다.

최종35/35 실패0·skip0. 새4개(1바이트씩 한글/이모지/결합문자, invalid3종, 정확한64KiB+1초과/stdout+stderr, JSON/실패exit) 및 기존31개. 새 wire 시험은 주입한 EventEmitter/PassThrough 수신경계이며 실제 OS pipe 분할 확률 시험이 아니다. 별도로 기존 실제 자식 비교 실행과 timeout/환경/임시폴더 정리를 재실행했다. build 성공·core contract gatePassed true.

고정 독립 작성18사례×3회×두 팔=108 실제 자식 표본. baseline/current와 candidate/current 각54/54 통과. suiteSHA ${calibration.suite.sha256}; 소스불변 ${calibration.sourcesUnchangedDuringRun}. 같은 구현 교정이지 성능개선 비교가 아니다. candidate wall p50 ${arm.wallMs.p50.toFixed(2)}ms/p95 ${arm.wallMs.p95.toFixed(2)}ms, 측정54건. 외부모델 호출/비용0, PC연산 비용 미측정. 입력은 합성 task/영수증과 실제 임시파일; Core 전체·실계정·사용자 자연어 품질 미검증.

부정대조18사례×두 팔=36표본: 정상팔18/18, 의도적 거짓복구팔3통과/15실패(15 falseRecoveries)를 검출해 reject. 이것은 실제 제품 실패15건이 아니다. 실제 제품 재실행 시도0 검증 유지. 오류·timeout은 분모를 지우지 않는다. 별도 신규 비공개 의미 holdout 또는 실제 모델 비교로 확대하지 않는다.

장부의 과거 실패/변경·누락 snapshot 목록은 review.json에 따로 보존했다. 해당 파일 일치나 과거 결론을 이번에 검증/복구한 것으로 보고하지 않는다. 기존 무결성 문제는 별도 재검토가 필요하다. 공식 원장60 verified/20진행/20대기 유지; 이번 조회가 전체 인수를 다시 감사한 것은 아니다. 연구 후보·계획 문서로 진행률을 올리지 않았다.

사용자 계정·개인 매크로·F/cognition 업무 기억 변경0, 운영 서비스 재시작/설치EXE 적용0, 유료 호출/외부 발송0. 다음은 macro 원래명령/전체 저장소 commonSQL 효과·영수증·G 대사와 원래100개 인수를 이어 진행한다. 이 비교기 수정으로 전체 V3-040/041·실사용 평가를 완료하지 않는다. 복원은 본 수정의 Buffer/fatal decode 부분만 이전 구현으로 되돌릴 수 있으나 한글 손실 결함도 돌아온다. 기존 결과/장부/사용자 자료를 삭제하지 않는다.

공식 근거: [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [Changelog](https://developers.openai.com/api/docs/changelog), [Node UTF-8 경계](https://nodejs.org/api/string_decoder.html).
`;
await save('-report.md', report);
await save('-attempt.json', { id: 'recovery-wire-20261007', candidateId: 'inspect-ai', kind: 'comparison', reportedOutcome: 'passed', observedAt,
  hypothesis: '고정 복구 비교기에서 한글 증거의 원시바이트를 보존하고 잘못된 UTF-8을 거부하면 전송경계 때문에 결과가 조용히 변하는 결함을 제거할 수 있다.',
  lesson: '파이프 청크는 문자 경계가 아니다. 정상 JSON 구문만으로 원문 증거 보존을 보장할 수 없다. 제품 실패와 부정대조 실패를 구분해야 한다.',
  limitations: '35/35; calibration108/negative36 실제자식. 새 wire4는 주입경계. 같은구현 교정·실계정/외부LLM/신규holdout/설치활성화 미실행. 공식60유지·기존 changed snapshot 미복구·PC비용 미측정.',
  evidencePaths: ['-report.md','-source.json','-review.json','-baseline.txt','-tests.txt','-calibration.json','-negative.json','-build.txt','-contract.txt','-queue.txt'].map(s => prefix + s) });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 비교기 한글 byte경계/invalidUTF82결함·35/35·고정108교정/부정36검출·build/contract. 공식60·운영활성화0. 기존증거변경 별도재검토·다음 macro commonSQL/원래100인수.\n`);
