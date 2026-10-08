import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreflight, loadPublicScenarioRunHistory, writePreflightReport } from '../scripts/agent-platform-evaluation-preflight.mjs';

const evaluation = JSON.parse(readFileSync(new URL('../config/agent-platform-evaluation.json', import.meta.url), 'utf8'));
const bindings = JSON.parse(readFileSync(new URL('../config/agent-platform-evaluation-bindings.json', import.meta.url), 'utf8'));

test('classifies all 36 cases without changing execution status or treating readiness as a run', () => {
  const report = buildPreflight(evaluation, bindings, '2026-09-28T00:00:00.000Z');
  assert.equal(report.counts.total, 36);
  assert.equal(report.counts.executionStatusNotRun, 36);
  assert.equal(report.counts.scenarioAdaptersAvailable, 30);
  assert.equal(report.counts.scenarioExecutionEligible, 30);
  assert.equal(report.counts.executed, 0);
  assert.equal(report.executionStatusChanged, false);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.holdout.executedCount, 0);
  assert.equal(report.scenarios.find(item => item.id === 'G12').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'G12').declaredExecutionStatus, 'not-run');
  assert.equal(report.scenarios.find(item => item.id === 'S01').readiness, 'blocked');
  assert.equal(report.scenarios.find(item => item.id === 'S09').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'S09').scenarioExecutionEligible, true);
  const m05 = report.scenarios.find(item => item.id === 'M05');
  assert.equal(m05.readiness, 'requirements-ready');
  assert.equal(m05.requirements.find(item => item.id === 'proactivity-runtime').state, 'available-local');
  assert.equal(m05.requirements.find(item => item.id === 'proactivity-blocker-state-monitor').state, 'available-local');
  assert.equal(report.scenarios.find(item => item.id === 'G01').executed, false);
  assert.equal(report.scenarios.find(item => item.id === 'G01').currentExecutionStatus, 'not-run');
  assert.equal(report.scenarios.find(item => item.id === 'G01').adapterStatus, 'available');
  assert.equal(report.scenarios.find(item => item.id === 'G01').scenarioExecutionEligible, true);
  assert.equal(report.scenarios.find(item => item.id === 'M12').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'S05').readiness, 'requirements-ready');
  assert.equal(report.scenarios.filter(item => item.scenarioExecutionEligible).map(item => item.id).join(','), 'G01,G02,G03,G05,G06,G08,G09,G10,G11,G12,M01,M02,M03,M04,M05,M06,M07,M08,M09,M10,M11,M12,S03,S04,S05,S08,S09,S10,S11,S12');
  assert.equal(report.scenarios.find(item => item.id === 'S11').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'S11').scenarioExecutionEligible, true);
  assert.equal(report.scenarios.find(item => item.id === 'S12').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'S12').scenarioExecutionEligible, true);
  assert.equal(report.scenarios.find(item => item.id === 'M07').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'M07').scenarioExecutionEligible, true);
  assert.equal(report.scenarios.find(item => item.id === 'G11').readiness, 'requirements-ready');
  assert.equal(report.scenarios.find(item => item.id === 'G11').scenarioExecutionEligible, true);
});

test('ignores an in-flight scenario directory until its report is finalized', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-inflight-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = '20260929T000000Z-00000000-0000-4000-8000-000000000000';
  mkdirSync(join(root, 'artifacts', 'agent-platform-20260929', 'public-scenarios', `S04-local-${runId}`), { recursive: true });
  assert.deepEqual(loadPublicScenarioRunHistory(root), []);
});

test('each preflight write preserves immutable JSON and Markdown while refreshing the latest pointer', t => {
  const directory = mkdtempSync(join(process.cwd(), 'artifacts', 'agent-platform-20260929', '.preflight-writer-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const firstReport = buildPreflight(evaluation, bindings, '2026-09-29T08:00:00.000Z');
  const first = writePreflightReport(firstReport, join(directory, 'latest.json'));
  const firstBytes = readFileSync(first.immutable, 'utf8');
  const firstMarkdownBytes = readFileSync(first.immutableMarkdown, 'utf8');
  assert.equal(JSON.parse(firstBytes).observedAt, firstReport.observedAt);
  assert.equal(JSON.parse(readFileSync(first.latest, 'utf8')).artifactManifest.immutableJson,
    first.immutable.replace(`${process.cwd()}\\`, '').replaceAll('\\', '/'));
  assert.equal(readFileSync(first.immutableMarkdown, 'utf8').includes(firstReport.observedAt), true);

  const secondReport = buildPreflight(evaluation, bindings, '2026-09-29T08:01:00.000Z');
  const second = writePreflightReport(secondReport, join(directory, 'latest.json'));
  assert.notEqual(second.immutable, first.immutable);
  assert.equal(readFileSync(first.immutable, 'utf8'), firstBytes, 'later runs must not rewrite prior snapshots');
  assert.equal(readFileSync(first.immutableMarkdown, 'utf8'), firstMarkdownBytes, 'later runs must not rewrite prior summaries');
  assert.equal(JSON.parse(readFileSync(second.latest, 'utf8')).observedAt, secondReport.observedAt);
  assert.equal(JSON.parse(readFileSync(second.immutable, 'utf8')).artifactManifest.immutableJson,
    second.immutable.replace(`${process.cwd()}\\`, '').replaceAll('\\', '/'));
});

test('Markdown distinguishes the unchanged corpus declaration from latest scenario execution history', t => {
  const directory = mkdtempSync(join(process.cwd(), 'artifacts', 'agent-platform-20260929', '.preflight-status-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const history = [{ scenarioId: 'G01', runId: 'observed-run', observedAt: '2026-09-29T12:00:00.000Z',
    outcome: 'completed', repetitions: 3, oraclePasses: 3 }];
  const report = buildPreflight(evaluation, bindings, '2026-09-29T12:01:00.000Z', undefined, undefined, history);
  const written = writePreflightReport(report, join(directory, 'latest.json'));
  const markdown = readFileSync(written.immutableMarkdown, 'utf8');
  assert.match(markdown, /원본 공개 코퍼스 상태는 변경하지 않았다/u);
  assert.match(markdown, /원본 선언 상태 \| 최근 실행 상태 \| 최근 실행 관측시각/u);
  assert.match(markdown, /\| G01 \| grok \| requirements-ready \| available \| not-run \| completed \| 2026-09-29T12:00:00\.000Z \|/u);
});

test('projects latest scenario execution history without mutating the declared corpus status', () => {
  const history = [
    { scenarioId: 'G01', runId: 'older', observedAt: '2026-09-28T00:00:00.000Z', outcome: 'failed', repetitions: 3, oraclePasses: 0 },
    { scenarioId: 'G01', runId: 'newer', observedAt: '2026-09-29T00:00:00.000Z', outcome: 'completed', repetitions: 3, oraclePasses: 3 }
  ];
  const report = buildPreflight(evaluation, bindings, '2026-09-29T01:00:00.000Z', undefined, undefined, history);
  const g01 = report.scenarios.find(item => item.id === 'G01');
  assert.equal(g01.currentExecutionStatus, 'completed');
  assert.equal(g01.latestRun.runId, 'newer');
  assert.equal(g01.declaredExecutionStatus, evaluation.scenarios.find(item => item.id === 'G01').status);
  assert.equal(report.counts.executionStatusCompleted, 1);
  assert.equal(report.counts.executed, 1);
});

test('revalidates completed runs from bound evidence and rejects a forged completion report', () => {
  const history = loadPublicScenarioRunHistory();
  assert.equal(history.filter(item => item.scenarioId === 'G01').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G12').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G02').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G03').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G05').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'M01').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G06').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'M04').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'M03').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G08').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G09').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'G10').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'M02').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'S10').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'S05').at(-1)?.outcome, 'completed');
  assert.equal(history.filter(item => item.scenarioId === 'M10').at(-1)?.outcome, 'completed');
  const root = mkdtempSync(join(tmpdir(), 'jarvis-forged-preflight-'));
  try {
    const runId = '20260929T000000Z-00000000-0000-4000-8000-000000000000';
    const run = join(root, 'artifacts', 'agent-platform-20260929', 'public-scenarios', `G12-local-${runId}`);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'report.json'), JSON.stringify({ scenarioId: 'G12', mode: 'public-scenario-local-role-handoff-mission-adapter',
      outcome: 'completed', runId, observedAt: '2026-09-29T00:00:00.000Z', counts: { completed: 3, independentOracleRuns: 3 },
      measurements: Array.from({ length: 3 }, () => ({ scenarioId: 'G12', status: 'completed', oracle: { status: 'passed' } })) }));
    assert.throws(() => loadPublicScenarioRunHistory(root), /missing bound evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fails closed when a scenario requirement has no explicit evidence binding', () => {
  const altered = structuredClone(evaluation);
  altered.scenarios[0].requires = ['invented-capability'];
  assert.throws(() => buildPreflight(altered, bindings), /invalid or missing binding/);
});

test('does not classify a local requirement as ready when its claimed evidence file is missing', () => {
  const altered = structuredClone(bindings);
  altered.requirements['role-scoped-execution'].evidence = ['artifacts/does-not-exist.json'];
  assert.throws(() => buildPreflight(evaluation, altered), /ENOENT/);
});

test('rejects duplicate scenario identities and does not accept an incomplete public set', () => {
  const duplicate = structuredClone(evaluation);
  duplicate.scenarios[1].id = duplicate.scenarios[0].id;
  assert.throws(() => buildPreflight(duplicate, bindings), /duplicate scenario id/);
  assert.throws(() => buildPreflight({ ...evaluation, scenarios: evaluation.scenarios.slice(0, -1) }, bindings), /expected 36/);
});
