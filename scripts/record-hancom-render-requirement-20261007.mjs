import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/hancom-render-requirement-20261007';
const observedAt = new Date().toISOString();
const run = promisify(execFile);
const { stdout } = await run(process.execPath, ['scripts/research-ledger.mjs', 'status'], { maxBuffer: 32 * 1024 * 1024 });
const status = JSON.parse(stdout);
const candidates = status.candidates ?? [];
const candidate = candidates.find(item => item.id === 'agent-platform-observed-scenario-status');
await writeFile(prefix + '-research.json', JSON.stringify({ observedAt, candidate: candidate ? {
  id: candidate.id, revision: candidate.revision, nextReason: candidate.nextReason,
  attempts: (candidate.attempts ?? []).slice(0, 3).map(attempt => ({ id: attempt.id, reportedOutcome: attempt.reportedOutcome,
    evidence: attempt.evidence.map(item => ({ path: item.path, integrity: item.integrity, sourceIntegrity: item.sourceIntegrity })) }))
} : null, boundaries: status.boundaries }, null, 2), { flag: 'wx' });
const files = ['packages/core/src/planning/mission-action-arguments.js', 'tests/hancom-render-requirement.test.js'];
await writeFile(prefix + '-source.json', JSON.stringify(await Promise.all(files.map(async path => ({ path,
  sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))), null, 2), { flag: 'wx' });
const final = await readFile(prefix + '-final.txt', 'utf8');
if (!final.includes('pass 47') || !final.includes('fail 0') || !final.includes('skipped 0')) throw Error('final-test-summary-mismatch');
await readFile(prefix + '-independent.md', 'utf8');
await writeFile(prefix + '-report.md', `# 한글 문서 렌더 요구 보존 수정

관측: ${observedAt}. 공식 인수 60/100 유지.

## 재현과 수정

hwp.create의 실행기는 verifyRendering을 이미 지원하지만 Mission 인수 allowlist가 이 필드를 누락했다. MissionPlanner→CoreFacade→TaskPlanner의 sanitizer 재호출에서 실제 출력 검증 요청이 사라졌으며, 잘못된 문자열·숫자·null 값도 사라져 정상 문서 제작으로 바뀌었다. 수정 전 8개 검사 중 5개 실패·1개 통과·2개 native 미실행을 보존했다. malformed 3개는 실제 MCP HWPX 파일 제작 성공을 관측했고 임시 산출물은 제거했다.

allowlist에 verifyRendering만 추가해 true/false를 그대로 유지한다. 값은 임의로 boolean 변환하지 않으며 잘못된 값은 기존 adapter의 생성 전 blocked 검사로 전달한다. rendererCommand·capabilityToken 같은 실행/권한 필드는 계속 제외한다. 외부 효과 권한이나 Core authority allowlist를 넓히지 않았다.

## 실행 증거

최종 신규 8개와 기존 Mission 문서/인수 회귀 합계 47/47, 실패·skip 0. 검사 전체 28.1초이며 제품 p50/p95가 아니다. TaskPlanner에서 준비된 인수를 실제 adapter에 전달한 HWP와 HWPX 각각 1건은 새 Hancom COM 렌더로 PDF·페이지·구조를 생성하고 독립 G가 현재 파일을 재조회했다. 원문 자연어 모델 해석이나 전체 Mission SQL 경로의 검사는 아니다. malformed 3개는 파일 0개로 사전차단했다. 독립 반증 21/21은 실제 MissionPlanner→CoreFacade→TaskPlanner와 adapter 분기를 검사하고 생성 메서드를 spy로 대체했다. native/G 증거와 구분해 independent.md/.test.mjs/.log에 보존했다. build/Core 계약 게이트 exit 0.

## 조사와 한계

감시 6곳 모두 unchanged, 새 출처·baseline reset·오류 0. 후보 정의 sync 변경 없음. 관련 후보 최신 장부 증거 상태는 research.json에 기록했다. 공식 [MCP 도구 규격](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)의 inputSchema 및 입력/결과 검증 책임을 검토했다. 새 모델이나 프로토콜을 도입해도 로컬 인수 소실은 해결되지 않으므로 기존 경계를 최소 수정했다. 이 원문 검토는 새 출시나 성능 우위 증거가 아니다.

운영 서비스/설치 EXE 재시작·활성화 0, 실제 계정 변경·유료 API 호출 0, 총비용 미측정. 기존 F/cognition 업무 기억을 사용하거나 수정하지 않았다. tests는 임시 경로와 memory-only UndoJournal을 사용했다. connections-only 상태는 runtime.json 참조. 아직 HWP/HWPX 전체 manifest·원래 문서 SQL artifactPlan·B claim·영속 receipt·재시작 G 복구는 미연결이며 Core authority의 hwp.create 안전차단을 유지한다. 다음 작업은 이 전체 계약을 연결한 뒤 allowlist 승격을 검토하는 것이다.
`, { flag: 'wx' });
await writeFile(prefix + '-attempt.json', JSON.stringify({ id: 'hancom-render-requirement-20261007',
  candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt,
  hypothesis: 'Mission 경계가 verifyRendering을 보존하면 실제 렌더 요청 소실과 malformed 인수의 정상 실행 전환을 막을 수 있다.',
  lesson: 'adapter가 인수를 검증해도 upstream allowlist가 먼저 삭제하면 검증을 우회하고 요청 결과가 달라진다.',
  limitations: '47/47·실제 HWP/HWPX TaskPlanner→adapter→native G 각1. 외부 LLM 해석/SQL effect/restart/운영EXE 미실행, 비용 미측정, 공식60/100.',
  evidencePaths: ['-report.md','-source.json','-baseline.txt','-final.txt','-build.txt','-contract.txt','-runtime.json','-research.json','-independent.md','-independent.test.mjs','-independent.log'].map(suffix => prefix + suffix)
}, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: hwp.create verifyRendering 인수소실/잘못된값 정상제작 전환 수정·baseline5실패 보존·실제planned HWP/HWPX native G2 포함47/47/독립감사/build/contract. 공식60·운영활성화0. 다음 전체manifest/SQL/Bclaim/receipt/G재시작 복구.\n`);
