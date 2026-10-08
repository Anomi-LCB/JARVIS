import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ResearchLedger } from '../packages/shared/src/research-ledger.js';

const now = '2026-09-14T00:00:00.000Z';
function catalog(overrides = {}) {
  return { version: 1, candidates: [{
    id: 'retry-recovery', title: '재시작 후 복구', priority: 1,
    problem: '응답이 유실되면 동일 작업이 두 번 실행될 수 있다.',
    sources: [{ url: 'https://github.com/google/artemis', checkedAt: '2026-09-14', revision: 'fixture-v1' }],
    nextExperiment: '응답 유실을 주입하고 작업 중복 여부를 확인한다.', ...overrides
  }] };
}

function attempt(overrides = {}) {
  return {
    id: 'retry-first', candidateId: 'retry-recovery', kind: 'contract-test', reportedOutcome: 'failed',
    hypothesis: '같은 작업 ID로 다시 요청하면 중복 실행되지 않는다.',
    lesson: '재시작 시 요청 ID 복구가 필요하다.', limitations: '격리된 로컬 계약 검사이며 실제 기기 업무는 실행하지 않았다.',
    evidencePaths: ['artifacts/result.json'], relatedIds: ['g-report-retry-first'], ...overrides
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-research-ledger-'));
  const workspaceRoot = join(directory, 'workspace');
  const storePath = join(workspaceRoot, '.runtime', 'research', 'research.sqlite');
  const stores = new Set();
  mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'artifacts', 'result.json'), JSON.stringify({ status: 'failed', duplicateExecutions: 1 }));
  t.after(() => {
    for (const store of stores) store.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('jarvis-research-ledger-'));
    assert.equal(target, directory);
    rmSync(target, { recursive: true, force: true });
  });
  return {
    directory, workspaceRoot, storePath,
    open() {
      const store = new ResearchLedger({ workspaceRoot, storePath, clock: () => now });
      stores.add(store);
      return store;
    }
  };
}

test('research ledger restores the candidate, failed attempt, lesson and evidence after reopening SQLite', t => {
  const f = fixture(t);
  const first = f.open();
  first.syncCandidates(catalog());
  first.recordAttempt(attempt());
  first.close();

  const restored = f.open().snapshot();
  assert.equal(restored.candidateCount, 1);
  const candidate = restored.candidates[0];
  assert.equal(candidate.problem, catalog().candidates[0].problem);
  assert.equal(candidate.nextReason, 'revise-hypothesis');
  assert.equal(candidate.attemptCount, 1);
  assert.equal(candidate.attempts[0].lesson, attempt().lesson);
  assert.equal(candidate.attempts[0].reportedOutcome, 'failed');
  assert.equal(candidate.attempts[0].evidence[0].integrity, 'intact');
  assert.match(candidate.attempts[0].evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(candidate.attempts[0].relatedIds, ['g-report-retry-first']);
  assert.equal(restored.boundaries.productionActivation, false);
});

test('identical attempts are idempotent across restarts and conflicting reuse cannot replace the original', t => {
  const f = fixture(t);
  let store = f.open();
  store.syncCandidates(catalog());
  assert.equal(store.recordAttempt(attempt()).recorded, true);
  store.close();
  store = f.open();
  assert.deepEqual(store.recordAttempt(attempt()), { recorded: false, duplicate: true, id: 'retry-first' });
  assert.throws(() => store.recordAttempt(attempt({ lesson: '검사 없이 성공으로 바꾼다.', reportedOutcome: 'passed' })), {
    code: 'RESEARCH_ATTEMPT_ID_CONFLICT'
  });
  const current = store.snapshot().candidates[0];
  assert.equal(current.attemptCount, 1);
  assert.equal(current.attempts[0].lesson, attempt().lesson);
  assert.equal(current.attempts[0].reportedOutcome, 'failed');
});

test('a revised candidate preserves historical attempts and requires evaluation of the new definition', t => {
  const f = fixture(t);
  const store = f.open();
  const oldRevision = store.syncCandidates(catalog())[0].revision;
  store.recordAttempt(attempt());
  const changed = store.syncCandidates(catalog({ nextExperiment: '영속 요청 ID를 추가한 뒤 중복 실행과 결과 유실을 다시 검사한다.' }));
  assert.notEqual(changed[0].revision, oldRevision);
  store.close();
  const current = f.open().snapshot().candidates[0];
  assert.equal(current.attemptCount, 1);
  assert.equal(current.attempts[0].candidateRevision, oldRevision);
  assert.equal(current.attempts[0].currentDefinition, false);
  assert.equal(current.attempts[0].lesson, attempt().lesson);
  assert.equal(current.nextReason, 'definition-changed');
});

test('archived evidence remains traceable when the source file changes or is deleted', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  store.recordAttempt(attempt({ reportedOutcome: 'passed' }));
  const evidence = join(f.workspaceRoot, 'artifacts', 'result.json');
  writeFileSync(evidence, JSON.stringify({ status: 'failed', tampered: true }));
  let state = store.snapshot().candidates[0];
  assert.equal(state.nextReason, 'independent-evaluation-needed');
  assert.equal(state.attempts[0].evidence[0].integrity, 'intact');
  assert.equal(state.attempts[0].evidence[0].sourceIntegrity, 'changed');
  assert.equal(state.attempts[0].evidence[0].snapshotIntegrity, 'intact');
  assert.equal(state.attempts[0].reportedOutcome, 'passed');
  assert.throws(() => store.recordAttempt(attempt({ reportedOutcome: 'passed' })), { code: 'RESEARCH_ATTEMPT_ID_CONFLICT' });
  unlinkSync(evidence);
  store.close();
  state = f.open().snapshot().candidates[0];
  assert.equal(state.nextReason, 'independent-evaluation-needed');
  assert.equal(state.attempts[0].evidence[0].integrity, 'intact');
  assert.equal(state.attempts[0].evidence[0].sourceIntegrity, 'missing');
  assert.equal(state.attempts[0].evidence[0].snapshotIntegrity, 'intact');
  assert.equal(state.attemptCount, 1);
});

test('evidence snapshots are byte-identical, bounded, and reusable without overwriting', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  const first = store.recordAttempt(attempt());
  const record = store.snapshot().candidates[0].attempts[0].evidence[0];
  assert.equal(first.recorded, true);
  assert.match(record.snapshotPath, /^artifacts\/research-evidence-snapshots\/retry-first\//u);
  assert.equal(record.sha256, record.snapshotSha256);
  assert.equal(record.byteLength, record.snapshotByteLength);
  assert.equal(record.snapshotIntegrity, 'intact');
  const stored = readFileSync(resolve(f.workspaceRoot, record.snapshotPath));
  assert.deepEqual(stored, readFileSync(join(f.workspaceRoot, 'artifacts', 'result.json')));
  assert.deepEqual(store.recordAttempt(attempt()), { recorded: false, duplicate: true, id: 'retry-first' });
});

test('evidence snapshots reject an attempt whose combined evidence exceeds the per-attempt limit', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  const payload = 'x'.repeat(2 * 1024 * 1024 + 1);
  writeFileSync(join(f.workspaceRoot, 'artifacts', 'large-a.txt'), payload);
  writeFileSync(join(f.workspaceRoot, 'artifacts', 'large-b.txt'), payload);
  assert.throws(() => store.recordAttempt(attempt({ evidencePaths: ['artifacts/large-a.txt', 'artifacts/large-b.txt'] })), {
    code: 'RESEARCH_EVIDENCE_TOTAL_TOO_LARGE'
  });
  assert.equal(store.snapshot().candidates[0].attemptCount, 0);
  assert.equal(readdirSync(join(f.workspaceRoot, 'artifacts')).includes('research-evidence-snapshots'), false);
});

test('legacy evidence records remain idempotent without rewriting their JSON or archiving on retry', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  store.recordAttempt(attempt());
  const row = store.db.prepare('SELECT record_json FROM research_attempts WHERE attempt_id=?').get('retry-first');
  const legacy = JSON.parse(row.record_json);
  const archivePath = legacy.evidence[0].snapshotPath;
  legacy.evidence = legacy.evidence.map(({ path, resolvedPath, sha256, byteLength }) => ({ path, resolvedPath, sha256, byteLength }));
  const json = JSON.stringify(legacy);
  store.db.prepare('UPDATE research_attempts SET record_json=? WHERE attempt_id=?').run(json, 'retry-first');
  unlinkSync(resolve(f.workspaceRoot, archivePath));
  assert.deepEqual(store.recordAttempt(attempt()), { recorded: false, duplicate: true, id: 'retry-first' });
  assert.equal(store.db.prepare('SELECT record_json FROM research_attempts WHERE attempt_id=?').get('retry-first').record_json, json);
  assert.deepEqual(readdirSync(dirname(resolve(f.workspaceRoot, archivePath))), []);
  assert.equal(store.snapshot().candidates[0].attempts[0].evidence[0].snapshotIntegrity, 'not-archived');
});

test('snapshot corruption or deletion invalidates preserved evidence even if the source remains intact', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  store.recordAttempt(attempt());
  const path = resolve(f.workspaceRoot, store.snapshot().candidates[0].attempts[0].evidence[0].snapshotPath);
  writeFileSync(path, 'corrupt archive');
  let state = store.snapshot().candidates[0];
  assert.equal(state.attempts[0].evidence[0].sourceIntegrity, 'intact');
  assert.equal(state.attempts[0].evidence[0].integrity, 'changed');
  assert.equal(state.nextReason, 'evidence-needs-recheck');
  unlinkSync(path);
  state = store.snapshot().candidates[0];
  assert.equal(state.attempts[0].evidence[0].integrity, 'missing');
  assert.equal(state.nextReason, 'evidence-needs-recheck');
});

test('invalid or conflicting attempt input creates no unreferenced evidence snapshot', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  assert.throws(() => store.recordAttempt(attempt({ lesson: '' })), { code: 'RESEARCH_INVALID_TEXT' });
  assert.equal(readdirSync(join(f.workspaceRoot, 'artifacts')).includes('research-evidence-snapshots'), false);
  store.recordAttempt(attempt());
  const dir = join(f.workspaceRoot, 'artifacts', 'research-evidence-snapshots', 'retry-first');
  const before = readdirSync(dir);
  writeFileSync(join(f.workspaceRoot, 'artifacts', 'result.json'), 'changed source');
  assert.throws(() => store.recordAttempt(attempt()), { code: 'RESEARCH_ATTEMPT_ID_CONFLICT' });
  assert.deepEqual(readdirSync(dir), before);
});

test('evidence cannot escape through parent paths, disallowed directories or a directory symlink', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  const outside = join(f.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'result.json'), 'outside-only');
  mkdirSync(join(f.workspaceRoot, '.runtime'), { recursive: true });
  writeFileSync(join(f.workspaceRoot, '.runtime', 'private.json'), 'not-research-evidence');
  const link = join(f.workspaceRoot, 'artifacts', 'outside-link');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../outside/result.json', join(outside, 'result.json'), '.runtime/private.json', 'artifacts/outside-link/result.json']) {
    assert.throws(() => store.recordAttempt(attempt({ evidencePaths: [path] })), { code: 'RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT' });
  }
  assert.equal(store.snapshot().candidates[0].attemptCount, 0);
});

test('research evidence snapshots reject a symlinked archive directory before writing outside the workspace', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  const outside = join(f.directory, 'snapshot-outside');
  mkdirSync(outside);
  const archiveRoot = join(f.workspaceRoot, 'artifacts', 'research-evidence-snapshots');
  mkdirSync(archiveRoot);
  symlinkSync(outside, join(archiveRoot, 'retry-first'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.recordAttempt(attempt()), { code: 'RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT' });
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(store.snapshot().candidates[0].attemptCount, 0);
});

test('blocked readiness and a reported pass remain separate from independently verified workflow success', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  store.recordAttempt(attempt({ id: 'credentials-missing', kind: 'runtime-connection', reportedOutcome: 'blocked', evidencePaths: [],
    lesson: '격리 구성에 모델 자격 증명이 없어 실제 기기 작업은 미실행이다.' }));
  assert.equal(store.snapshot().candidates[0].nextReason, 'conditions-missing');
  assert.throws(() => store.recordAttempt(attempt({ id: 'empty-success', reportedOutcome: 'passed', evidencePaths: [] })), {
    code: 'RESEARCH_INVALID_ATTEMPT'
  });
  store.recordAttempt(attempt({ id: 'declared-pass', kind: 'workflow-test', reportedOutcome: 'passed' }));
  const state = store.snapshot();
  assert.equal(state.candidates[0].nextReason, 'independent-evaluation-needed');
  assert.equal(state.candidates[0].attempts[1].reportedOutcome, 'blocked');
  assert.equal(state.boundaries.reportedOutcomesIndependentlyVerified, false);
  assert.equal(state.boundaries.evidenceChecks, 'file-integrity-only');
  assert.equal(state.boundaries.productionActivation, false);
});

test('watch observations deduplicate and source changes never become candidate experiment success', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  const report = { version: 1, observedAt: now, sources: [{
    id: 'official-artemis', url: 'https://github.com/google/artemis', status: 'new_source', contentHash: 'a'.repeat(64)
  }] };
  assert.equal(store.importWatch(report).recorded, true);
  assert.equal(store.importWatch(report).duplicate, true);
  const changed = { ...report, observedAt: '2026-09-14T00:01:00.000Z', sources: [{ ...report.sources[0], status: 'changed', contentHash: 'b'.repeat(64) }] };
  assert.equal(store.importWatch(changed).recorded, true);
  store.close();
  const reopened = f.open();
  assert.equal(reopened.importWatch(changed).duplicate, true);
  const state = reopened.snapshot();
  assert.equal(state.latestWatch.sources[0].status, 'changed');
  assert.equal(state.candidates[0].attemptCount, 0);
  assert.equal(state.candidates[0].nextReason, 'experiment-needed');
  assert.equal(state.boundaries.reportedOutcomesIndependentlyVerified, false);
});

test('bounded history retains the most recent attempt and reports the complete attempt count after restart', t => {
  const f = fixture(t);
  const store = f.open();
  store.syncCandidates(catalog());
  for (let index = 0; index < 24; index++) store.recordAttempt(attempt({ id: `retry-${index}`, lesson: `재시도 ${index}의 복구 교훈을 보존한다.` }));
  store.close();
  const candidate = f.open().snapshot().candidates[0];
  assert.equal(candidate.attemptCount, 24);
  assert.equal(candidate.historyTruncated, true);
  assert.equal(candidate.attempts.length, 20);
  assert.equal(candidate.attempts[0].id, 'retry-23');
  assert.equal(candidate.attempts.at(-1).id, 'retry-4');
});

test('CLI sync, record and status share durable state across separate Node processes in a temporary workspace', t => {
  const f = fixture(t);
  mkdirSync(join(f.workspaceRoot, 'config'));
  writeFileSync(join(f.workspaceRoot, 'config', 'research-candidates.json'), JSON.stringify(catalog()));
  writeFileSync(join(f.workspaceRoot, 'attempt.json'), JSON.stringify(attempt()));
  const cliUrl = new URL('../scripts/research-ledger.mjs', import.meta.url).href;
  function run(argv) {
    const code = `import { runResearchLedger } from ${JSON.stringify(cliUrl)}; console.log(JSON.stringify(runResearchLedger(${JSON.stringify(argv)}, { workspaceRoot: ${JSON.stringify(f.workspaceRoot)} })));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: f.workspaceRoot, encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.equal(run(['sync']).candidates[0].changed, true);
  assert.equal(run(['record', 'attempt.json']).recorded, true);
  assert.equal(run(['record', 'attempt.json']).duplicate, true);
  const result = run(['status']);
  assert.equal(result.candidates[0].attemptCount, 1);
  assert.equal(result.candidates[0].attempts[0].lesson, attempt().lesson);
  assert.equal(result.candidates[0].attempts[0].evidence[0].integrity, 'intact');
  assert.equal(result.candidates[0].nextReason, 'revise-hypothesis');
});
