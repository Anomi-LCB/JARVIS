import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadRecoverySuite, runRecoveryComparison } from '../packages/shared/src/recovery-comparison.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function projectedPath(path) {
  let cursor = resolve(path); const suffix = [];
  while (true) {
    try { return resolve(realpathSync(cursor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor)); cursor = dirname(cursor);
    }
  }
}
export function assertComparisonOutputPath(output, { suitePath, sourcePaths, root = ROOT }) {
  const target = resolve(output), actual = projectedPath(target);
  const inside = (base, path) => { const rel = relative(base, path); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
  const allowed = ['artifacts', 'dist/verification'].some(dir => {
    const base = resolve(root, dir); return inside(base, target) && inside(projectedPath(base), actual);
  });
  const key = path => process.platform === 'win32' ? projectedPath(path).toLowerCase() : projectedPath(path);
  if (!allowed || [suitePath, ...sourcePaths].some(path => key(path) === key(target))) throw new Error('A_COMPARISON_OUTPUT_CONFLICT');
}
export function checkComparisonSourceStability({ before, readSources, expectedSuiteSha256, readSuiteSha256 }) {
  try {
    const stable = JSON.stringify(before) === JSON.stringify(readSources()) && expectedSuiteSha256 === readSuiteSha256();
    return { stable, reason: stable ? null : 'SOURCE_OR_SUITE_CHANGED_DURING_RUN' };
  } catch { return { stable: false, reason: 'SOURCE_OR_SUITE_UNREADABLE_AFTER_RUN' }; }
}
export async function runRecoveryComparisonCli(args = []) {
  const options = { candidate: 'current', baseline: 'current', repetitions: 3, timeoutMs: 5000, concurrency: 1,
    suite: 'tests/fixtures/recovery-comparison-v1.json', output: 'artifacts/recovery-comparison/latest.json' };
  const fields = { '--candidate': 'candidate', '--baseline': 'baseline', '--repetitions': 'repetitions', '--timeout-ms': 'timeoutMs', '--concurrency': 'concurrency', '--suite': 'suite', '--output': 'output' };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const field = fields[args[index]];
    if (!field || seen.has(field) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('A_COMPARISON_INVALID_ARGUMENTS');
    seen.add(field); options[field] = ['repetitions', 'timeoutMs', 'concurrency'].includes(field) ? Number(args[index + 1]) : args[index + 1];
  }
  const loaded = loadRecoverySuite(resolve(ROOT, options.suite));
  const sources = ['packages/core/src/mission/mission-action-recovery.js',
    'packages/shared/src/recovery-comparison.js', 'scripts/lib/recovery-comparison-adapter.mjs',
    'scripts/lib/recovery-comparison-worker.mjs', 'apps/verification/src/verification-runtime.js',
    'packages/shared/src/types.js'];
  const output = resolve(ROOT, options.output);
  assertComparisonOutputPath(output, { suitePath: resolve(ROOT, options.suite), sourcePaths: sources.map(path => resolve(ROOT, path)) });
  const sourceHashes = () => sources.map(path => ({ path,
    sha256: createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex') }));
  const before = sourceHashes();
  const report = await runRecoveryComparison({ ...options, suite: loaded.suite, suiteSha256: loaded.sha256 });
  report.sourceFiles = before;
  report.environment = { node: process.version, platform: process.platform, arch: process.arch };
  const stability = checkComparisonSourceStability({ before, readSources: sourceHashes,
    expectedSuiteSha256: loaded.sha256, readSuiteSha256: () => loadRecoverySuite(resolve(ROOT, options.suite)).sha256 });
  report.sourcesUnchangedDuringRun = stability.stable;
  if (!report.sourcesUnchangedDuringRun) {
    report.comparison.decision = 'inconclusive';
    report.comparison.reasonCodes.push(stability.reason);
  }
  const temporary = `${output}.${randomUUID()}.tmp`;
  mkdirSync(dirname(output), { recursive: true });
  try { writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', flush: true }); renameSync(temporary, output); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return { output, decision: report.comparison.decision, suite: report.suite,
    baseline: report.summary.baseline.all, candidate: report.summary.candidate.all,
    regressionCaseIds: report.comparison.regressionCaseIds, productionActivation: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runRecoveryComparisonCli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
