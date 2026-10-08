import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const startedAt = new Date();
const reportPath = resolve(process.env.JARVIS_TEST_RUN_REPORT ?? 'dist/test-run-report.json');
const requestedTestArgs = process.argv.slice(2);
const requestedTestFiles = requestedTestArgs.filter(argument => argument.endsWith('.test.js'));
const hasExplicitConcurrency = requestedTestArgs.some(argument =>
  argument === '--test-concurrency' || argument.startsWith('--test-concurrency='));
// These tests start several local services, databases, and file workers. Node's
// default (availableParallelism - 1) can saturate this machine and make bounded
// service/G checks flaky. Keep a modest default while preserving caller override.
const testFiles = requestedTestFiles.length ? requestedTestFiles : await discoverSourceTests(process.cwd());
const forwardedArgs = requestedTestArgs.filter(argument => !argument.endsWith('.test.js'));
// Node options must precede the first positional test file. Options placed
// afterwards become test-process argv and silently fail to constrain execution.
const args = ['--test', ...(hasExplicitConcurrency ? [] : ['--test-concurrency=2']), ...forwardedArgs, ...testFiles];
const runtimeAuditRoot = await mkdtemp(join(tmpdir(), 'jarvis-test-runtime-'));
const env = {
  ...process.env,
  JARVIS_LLM_INTENT: '0',
  JARVIS_LLM_PLANNER: '0',
  JARVIS_LLM_CONTENT: '0',
  JARVIS_ANTHROPIC_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  JARVIS_OPENAI_API_KEY: '',
  OPENAI_API_KEY: '',
  JARVIS_MISSION_PROVIDER: 'legacy',
  JARVIS_XAI_API_KEY: '',
  JARVIS_META_API_KEY: '',
  JARVIS_GEMINI_API_KEY: '',
  JARVIS_EXTERNAL_DEVICE_PROBES: '0',
  JARVIS_TEST_MODE: '1',
  JARVIS_TEST_TRUST_SECRET: randomBytes(32).toString('base64url'),
  JARVIS_TEST_AUDIT_ROOT: runtimeAuditRoot
};
// A runner launched from a test must start a fresh test coordinator rather than
// inherit the parent's internal worker mode (which can silently run zero tests).
delete env.NODE_TEST_CONTEXT;

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: true
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

const result = await new Promise((resolveResult) => {
  child.once('error', (error) => resolveResult({ exitCode: 1, signal: null, error: error.message }));
  child.once('exit', (exitCode, signal) => resolveResult({ exitCode: exitCode ?? 1, signal, error: null }));
});
await rm(runtimeAuditRoot, { recursive: true, force: true }).catch(() => {});

const finishedAt = new Date();
const report = {
  reportVersion: 'jarvis-deterministic-test-run-v1',
  generatedAt: finishedAt.toISOString(),
  status: result.exitCode === 0 ? 'passed' : 'failed',
  command: [process.execPath, ...args].join(' '),
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  exitCode: result.exitCode,
  signal: result.signal,
  error: result.error,
  isolation: {
    externalLlmDisabled: true,
    apiCredentialsRemovedFromChildEnvironment: true,
    externalDeviceProbesDisabled: true,
    runtimeJournalsIsolated: true,
    runtimeJournalsRemovedAfterRun: true
  }
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.exitCode = result.exitCode;

async function discoverSourceTests(root) {
  const testRoots = ['apps', 'packages', 'scripts', 'src', 'tests'];
  const excluded = new Set(['.git', 'dist', 'node_modules', 'artifacts']);
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await visit(join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        files.push(join(directory, entry.name));
      }
    }
  }
  for (const name of testRoots) await visit(join(root, name));
  if (!files.length) throw new Error('No source test files were found.');
  return files.sort((left, right) => left.localeCompare(right));
}
