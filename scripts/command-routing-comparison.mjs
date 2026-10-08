import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CASES = 'tests/fixtures/command-routing-cases.json';

export function runCommandRoutingComparison({ workspaceRoot = ROOT, outputPath = 'artifacts/command-routing-comparison/latest.json' } = {}) {
  const cases = JSON.parse(readFileSync(resolve(workspaceRoot, CASES), 'utf8'));
  const started = performance.now();
  const results = cases.map(({ id, text, expected, risk }) => {
    const routeStarted = performance.now();
    const actual = classifyCommandLane(text);
    return { id, expected, actual: actual.lane, risk, passed: expected === actual.lane,
      latencyMs: Number((performance.now() - routeStarted).toFixed(3)), reasonCodes: actual.reasonCodes };
  });
  const plannerReadiness = [
    {
      id: 'explicit-separated-local-pipeline',
      objective: "'input.json' JSON을 '원본'으로 읽고; '원본'에서 'active'가 true인 행만 '결과'로 걸러내고; '결과'를 'output.json' JSON으로 저장해",
      expected: 'compiled'
    },
    {
      id: 'natural-korean-read-summarize-save',
      objective: "'input.json' JSON을 '원본'으로 읽고 핵심만 요약해 'output.txt' 텍스트로 저장해",
      expected: 'compiled'
    }
  ].map(({ id, objective, expected }) => {
    const readiness = compileNaturalWorkflowObjective(objective, { workspaceRoot: resolve(workspaceRoot, '.runtime/routing-comparison/workspace') });
    return { id, expected, actual: readiness.status, passed: readiness.status === expected,
      code: readiness.code ?? null, clauseCount: readiness.clauseCount ?? null, modelCalls: 0 };
  });
  const highRisk = results.filter((item) => item.risk !== 'low');
  const routingPassed = results.every(item => item.passed);
  const plannerPassed = plannerReadiness.every(item => item.passed);
  const summary = {
    version: 'jarvis-command-routing-comparison-v1',
    observedAt: new Date().toISOString(),
    casesPath: CASES,
    cases: results.length,
    correct: results.filter((item) => item.passed).length,
    falseTask: results.filter((item) => item.risk !== 'low' && item.expected === 'mission' && item.actual === 'task').map((item) => item.id),
    falseMission: results.filter((item) => item.expected === 'task' && item.actual === 'mission').map((item) => item.id),
    highRiskCases: highRisk.length,
    highRiskCorrect: highRisk.filter((item) => item.passed).length,
    acceptance: {
      passed: routingPassed && plannerPassed,
      routingPassed,
      plannerPassed,
      failedRoutingIds: results.filter(item => !item.passed).map(item => item.id),
      failedPlannerIds: plannerReadiness.filter(item => !item.passed).map(item => item.id),
      scope: 'fixed-routing-and-local-compiler-only',
      productionActivation: false
    },
    plannerReadiness,
    modelCalls: 0,
    externalCalls: 0,
    totalLatencyMs: Number((performance.now() - started).toFixed(3)),
    medianCaseLatencyMs: median(results.map((item) => item.latencyMs)),
    results
  };
  const destination = resolve(workspaceRoot, outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { ...summary, outputPath };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : Number(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(3));
}

export function parseCommandRoutingComparisonArgs(args = []) {
  let check = false;
  let outputPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check' && !check) { check = true; continue; }
    if (args[index] === '--output' && outputPath === undefined && args[index + 1] && !args[index + 1].startsWith('-')) {
      outputPath = args[++index]; continue;
    }
    throw new Error('Usage: node scripts/command-routing-comparison.mjs [--check] [--output artifacts/path.json]');
  }
  return { check, outputPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { check, outputPath } = parseCommandRoutingComparisonArgs(process.argv.slice(2));
    const report = runCommandRoutingComparison({ ...(outputPath ? { outputPath } : {}) });
    console.log(JSON.stringify(report, null, 2));
    if (check && !report.acceptance.passed) process.exitCode = 1;
  }
  catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
