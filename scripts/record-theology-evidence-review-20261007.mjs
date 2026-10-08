import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/theology-evidence-review-20261007', observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''), hash = value => createHash('sha256').update(value).digest('hex');
const log = read(`${prefix}-recheck.txt`), count = field => Number(log.match(new RegExp(`(?:ℹ |# )${field} (\\d+)`))?.[1]);
assert.ok(count('tests') >= 37); assert.equal(count('pass'), count('tests')); assert.equal(count('fail'), 0); assert.equal(count('skipped'), 0);
assert.match(log, /actual Core API authenticates/u); assert.match(log, /valid quote cannot convert/u);
assert.match(read(`${prefix}-build.txt`), /Built static JARVIS/u); assert.match(read(`${prefix}-contract-final.txt`), /gatePassed: true/u);
const files = ['packages/core/src/mission/theology-research-review.js', 'packages/core/src/main.mjs', 'tests/theology-research-review.test.js', 'docs/theology-research-review.md'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, files: files.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-verification.json`, JSON.stringify({ observedAt, files: 5, tests: count('tests'), passed: count('pass'), failed: 0, skipped: 0,
  durationMs: Number(log.match(/duration_ms ([\d.]+)/u)[1]), realCoreHttp: true, syntheticResearch: true,
  semanticAccuracyVerified: false, expertEvaluation: false, sourceAuthenticityVerified: false,
  missionExecution: false, filePublication: false, externalCalls: 0, measuredCost: null, latencyPercentiles: null, verified: 51 }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# 신학 연구 분류·본문·인용 검토 구현\n\n관측 ${observedAt}. 공식 **51/100 유지**, V3-063은 구현/실행 증거가 생겨 pending→in_progress로 변경한다. 원래 요구와100개 분모를 유지한다.\n\n기존 원장에는 신학 연구 항목의 구현 증거가 없었다. 새 모듈과 실제 ADMIN Core API /research/theology/review를 연결했다. 제출한 사실 주장·학계 견해·추론·적용을 네 그룹으로 분리하고 문헌 저자/위치와 성경 본문 참조/번역본을 보존한다. 인용 문자열·ID, 전제 존재, 학계 견해 귀속, 적용의 본문 근거, 순환 전제를 검사한다. 전제의 잘못된 근거는 파생 주장에 unresolved로 전달한다. 한국어 Markdown과 항목별 JSON/원문hash/미해결 사유/다음 조치를 반환한다.\n\n출처는 사용자 제출 자료로 표시한다. 문자열이 일치해도 허위 명제가 사실로 승격되지 않고 truth/interpretation/consensusVerified=false와 completionEligible=false를 유지한다. sourceAuthenticity와 semanticEntailment는 not-evaluated다. 문헌 속 명령·HTML은 escaped data이며 실행 권한0이다.\n\n최종5파일 **${count('pass')}/${count('tests')} 통과**, 실패0/미실행0. 실제 Core HTTP 인증/형식오류/네분류/보고서, 누락·잘못된인용·근거없는전제·순환·귀속·과도한크기·자료지시/HTML·OpenAPI 전체입력/실재인증scheme을 검사했다. 기존 출처 연결·whole request 및 HTTP경계/관리자 인증 회귀 포함. build·Core contract gate 통과. 초기 final 로그는3개 존재 파일37건만 실행됐고 존재하지 않은 추가2파일은 증거로 세지 않았다. 최종 recheck는 실제5파일을 명시했다.\n\n## 남은 인수\n\n실제 본문/주석/원어/사본·경쟁해석의 의미·진위와 독립 전문가 평가는 남아 있다. API는 검토 결과만 반환하며 자연어 Mission/E/B/G 파일저장·사용자 화면·사용자 기억 반영을 완료하지 않았다. 이번4범주 합성 자료를 실제 설교 성공이나 전문가 평가로 표현하지 않는다. 실제 비용·제품p50/p95 미측정. 운영서비스/설치본·F/cognition·계정 변경 없음. 복원은 새 모듈/API/OpenAPI/시험/증거연결만 검토하며 사용자 자료는 보존한다. 최소70% 목표 활성.\n`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-focused.txt`, `${prefix}-recheck.txt`, `${prefix}-build.txt`, `${prefix}-contract-final.txt`];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'theology-evidence-review-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '신학 자료를 분류·인용·본문·전제 계약으로 보존하면 문자 근거가 있는 주장과 의미/진위가 검증된 주장을 혼동하지 않는 검토 경로를 만들 수 있다.',
  lesson: '출처와 인용 일치는 학계 다수설·본문 해석·주장 진위를 입증하지 않는다. 전제의 근거 누락은 파생 적용까지 전달하고 사람 검토 필요를 유지해야 한다.',
  limitations: `실제Core HTTP/합성연구 ${count('pass')}/${count('tests')}, build/contract. 의미·진위·전문가·Mission/G·화면 미완료. 063진행중·공식51유지.` }, null, 2), { flag: 'wx' });
const path = 'docs/universal-control-v3-acceptance.json', acceptance = JSON.parse(read(path)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 51);
const gate = gates.find(gate => gate.id === 'V3-063'); assert.equal(gate.status, 'pending');
gate.reviewHistory ??= []; gate.reviewHistory.push({ status: gate.status, evidence: [...gate.evidence], limitations: [...gate.limitations], reviewedAt: gate.reviewedAt ?? null, supersededAt: observedAt });
gate.status = 'in_progress'; gate.reviewedAt = observedAt; gate.evidence.push(...evidencePaths.slice(0, 3));
gate.limitations.push(`2026-10-07 네분류/인용·본문·전제 검토와 실제Core API·한국어보고서 ${count('pass')}/${count('tests')}/build/contract. 제출자료 연결검사이며 의미·진위·전문가/실본문·Mission/G/UI 인수 미완료.`);
acceptance.updatedAt = observedAt; writeFileSync(path, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 신학근거검토 API/한국어보고서·${count('pass')}통과·build/contract. 063pending→진행중·공식51유지. 실본문/전문가/Mission/UI 남음.\n`);
console.log(JSON.stringify({ verified: 51, tests: count('tests'), evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
