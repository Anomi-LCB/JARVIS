import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { naturalMission50Cases } from './natural-mission-50-cases.mjs';
import { clearNaturalWorkflowCompileCache, compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';

const target = resolve(process.argv[2] ?? 'artifacts/natural-mission-50-audit/validation/compiler-performance.json');
const cold = [], warm = [];
for (let index = 0; index < 250; index += 1) {
  const command = naturalMission50Cases[index % naturalMission50Cases.length].command;
  const options = { workspaceRoot: resolve('workspace') };
  clearNaturalWorkflowCompileCache();
  const started = performance.now();
  const initial = compileNaturalWorkflowObjective(command, options);
  cold.push(performance.now() - started);
  const repeatedAt = performance.now();
  const repeated = compileNaturalWorkflowObjective(command, options);
  warm.push(performance.now() - repeatedAt);
  if (initial.status !== 'compiled' || !repeated.cacheHit || JSON.stringify(initial.spec) !== JSON.stringify(repeated.spec)) throw new Error('Compiler cache changed the execution plan.');
}
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length };
};
const report = { capturedAt: new Date().toISOString(), runtime: process.version, cold: distribution(cold), warm: distribution(warm), modelCalls: 0, equivalentPlanPairs: cold.length, scope: 'Plan compilation only. File IO, Mission execution and external services are excluded.', sampleSha256: createHash('sha256').update(JSON.stringify({ cold, warm })).digest('hex') };
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ ...report, coldSamplesMs: cold, warmSamplesMs: warm }, null, 2));
console.log(JSON.stringify(report, null, 2));
