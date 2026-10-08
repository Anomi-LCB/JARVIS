import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommandRoutingComparison, parseCommandRoutingComparisonArgs } from '../scripts/command-routing-comparison.mjs';

test('routing acceptance retains blocked planner probes even when all routing cases pass', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'jarvis-routing-gate-'));
  try {
    mkdirSync(resolve(root, 'tests/fixtures'), { recursive: true });
    copyFileSync(new URL('./fixtures/command-routing-cases.json', import.meta.url), resolve(root, 'tests/fixtures/command-routing-cases.json'));
    const report = runCommandRoutingComparison({ workspaceRoot: root, outputPath: 'artifacts/report.json' });
    assert.equal(report.correct, 24);
    assert.equal(report.acceptance.routingPassed, true);
    assert.equal(report.acceptance.plannerPassed, false);
    assert.equal(report.acceptance.passed, false);
    assert.deepEqual(report.acceptance.failedPlannerIds, ['natural-korean-read-summarize-save']);
    assert.equal(report.plannerReadiness[1].actual, 'blocked');
    assert.equal(report.plannerReadiness[1].expected, 'compiled');
    assert.equal(report.acceptance.productionActivation, false);
    assert.deepEqual(JSON.parse(readFileSync(resolve(root, 'artifacts/report.json'), 'utf8')).acceptance, report.acceptance);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI check fails on a real blocked compiler probe while preserving its report', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'jarvis-routing-cli-'));
  try {
    const destination = resolve(root, 'report.json');
    const run = spawnSync(process.execPath, ['scripts/command-routing-comparison.mjs', '--check', '--output', destination], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000
    });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(readFileSync(destination, 'utf8'));
    assert.equal(report.acceptance.passed, false);
    assert.equal(report.correct, report.cases);
    assert.equal(report.modelCalls, 0);
    assert.equal(report.externalCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate arguments permit either order and reject duplicate or incomplete options', () => {
  assert.deepEqual(parseCommandRoutingComparisonArgs(['--output', 'artifacts/r.json', '--check']), { check: true, outputPath: 'artifacts/r.json' });
  assert.deepEqual(parseCommandRoutingComparisonArgs([]), { check: false, outputPath: undefined });
  for (const args of [['--check', '--check'], ['--output'], ['--output', '--check'], ['--output', 'a', '--output', 'b'], ['--unknown']]) {
    assert.throws(() => parseCommandRoutingComparisonArgs(args), /Usage:/);
  }
});
