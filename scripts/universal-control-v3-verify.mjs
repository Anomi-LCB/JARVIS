import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A new execution produces new evidence; earlier runs are never overwritten.
// Passing this development suite does not certify external accounts or devices.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString();
const out = join(root, 'artifacts/universal-control-v3', `verification-${startedAt.replaceAll(':', '-')}-${process.pid}`);
mkdirSync(out, { recursive: false });
const selected = /^(?:mission-.+|natural-workflow.+|goal-contract|core-mission-sqlite-.+|core-growth-persistence|sqlite-mission-.+|personal-mission-.+|personal-mandate-budget|capability-.+|cognition-.+|cognitive-runtime|growth-.+|memory-provenance|conversation-memory|work-memory-identity|work-reference-.+|decision-trace-.+|workflow-data-integrity|workflow-evidence-verification|universal-control-extreme-audit|ui-mission-.+|pc-agent-queue-resilience|pc-agent-process-isolation|pc-agent-api-env-isolation|core-worker-timeout-resilience|runtime-trust-kernel)\.test\.js$/u;
const added = new Set(['remote-mission-effect.test.js', 'memory-recovery-scope.test.js',
  'ag-runtime.test.js', 'action-arguments-binding.test.js']);
const files = readdirSync(join(root, 'tests')).filter(name => selected.test(name) || added.has(name)).sort().map(name => `tests/${name}`);
const sourceFiles = ['apps', 'packages', 'src', 'scripts', 'tests'].flatMap(folder => readdirSync(join(root, folder), { recursive: true })
  .filter(file => /\.(?:js|mjs|ts|tsx|json|css|html)$/u.test(file) && !/(?:^|[\\/])(?:node_modules|build)(?:[\\/])/u.test(file))
  .map(file => `${folder}/${file.replaceAll('\\', '/')}`));
const sources = [...new Set([...sourceFiles, 'scripts/core-service-runtime.mjs', 'scripts/universal-control-extreme-audit.mjs',
  'scripts/universal-control-v3-verify.mjs', 'package.json', 'pnpm-lock.yaml', 'index.html', ...files])].sort();
const snapshot = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
const before = snapshot();
// Legacy tests once wrote synthetic backups outside their own temporary root.
// Include binary backups and newly created files, not only source-like JSON.
const protectedSnapshot = () => {
  const folder = join(root, 'apps/growth-memory/data');
  const files = existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? entry.path, entry.name)) : [];
  const undoJournal = join(root, 'apps/pc-agent/logs/undo-journal.jsonl');
  if (existsSync(undoJournal)) files.push(undoJournal);
  return Object.fromEntries(files.sort().map(path => [path.slice(root.length + 1).replaceAll('\\', '/'),
    createHash('sha256').update(readFileSync(path)).digest('hex')]));
};
const protectedBefore = protectedSnapshot();
const args = ['--test', '--test-reporter=tap', '--test-concurrency=4', ...files];
// Never inherit production credentials or execution switches into this suite.
// Cases needing provider behavior inject their own synthetic runner/configuration.
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^JARVIS_/iu.test(key) && !/(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SMTP_PASS|AUTH_TOKEN)$/iu.test(key)));
Object.assign(testEnv, { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0',
  JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' });
const result = spawnSync(process.execPath, args, { cwd: root, env: testEnv,
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const after = snapshot();
const protectedAfter = protectedSnapshot();
const stdout = result.stdout ?? '';
const count = name => Number([...stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)?.[1] ?? 0);
const record = {
  schemaVersion: 'jarvis-v3-development-verification-v1', startedAt, observedAt: new Date().toISOString(),
  nodeVersion: process.version, command: [process.execPath, ...args], testFiles: files.length,
  exitCode: result.status, error: result.error?.message ?? null,
  counts: Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, count(name)])),
  sourceChangedDuringRun: Object.keys(before).filter(file => before[file] !== after[file]), sourcesBefore: before, sourcesAfter: after,
  protectedLocalStateBefore: protectedBefore, protectedLocalStateAfter: protectedAfter,
  protectedLocalStateChanged: [...new Set([...Object.keys(protectedBefore), ...Object.keys(protectedAfter)])]
    .filter(file => protectedBefore[file] !== protectedAfter[file]),
  scope: 'Isolated development regression with synthetic account, worker and device fixtures; local files and child processes are real where the tests specify them.',
  externalModelCost: null, externalModelCostStatus: 'not-measured',
  environment: { productionCredentialsRemoved: true, inheritedJarvisConfigurationRemoved: true, externalModelDefaultsDisabled: true },
  liveAccountExecutions: 0, liveDeviceExecutions: 0, untouchedHoldoutCases: 0,
  evidenceMeaning: 'Hashes identify the tested source snapshot. They are not independent proof of semantic quality or product activation.'
};
writeFileSync(join(out, 'tests.tap'), `${stdout}\n${result.stderr ?? ''}`, { flag: 'wx' });
writeFileSync(join(out, 'verification.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
const passed = result.status === 0 && record.counts.tests > 0 && record.counts.fail === 0
  && record.counts.cancelled === 0 && record.sourceChangedDuringRun.length === 0 && record.protectedLocalStateChanged.length === 0;
console.log(JSON.stringify({ passed, out, counts: record.counts, sourceChangedDuringRun: record.sourceChangedDuringRun,
  protectedLocalStateChanged: record.protectedLocalStateChanged,
  error: record.error, startedAt, observedAt: record.observedAt }));
process.exitCode = passed ? 0 : 1;
