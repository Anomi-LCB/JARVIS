import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(SCRIPT_PATH));
const FOCUSED_TEST_FILES = Object.freeze([
  'tests/apex-workflow-50-cases.test.js',
  'tests/apex-workflow-scenario-engine.test.js',
  'tests/apex-workflow-50-audit.test.js',
  'tests/apex-workflow-reverify.test.js',
  'tests/apex-workflow-50-report.test.js',
  'tests/apex-product-resilience.test.js',
  'tests/worker-queue-store-regression.test.js',
  'tests/worker-performance.test.js',
  'tests/command-lane-routing.test.js',
  'tests/fetch-safe-http.test.js',
  'tests/local-http-boundary-integration.test.js',
  'tests/voice-command-e2e.test.js',
  'tests/voice-shell-e2e.test.js',
  'tests/visual-archive-email.test.js'
]);

export async function createApexFinalVerification(argv = []) {
  const options = parseArguments(argv);
  const evidenceRoot = resolve(PROJECT_ROOT, options.evidenceRoot);
  const productProbePath = resolve(PROJECT_ROOT, options.productProbe);
  const outputPath = resolve(PROJECT_ROOT, options.output);
  const generatedAt = new Date().toISOString();

  const focusedLogPath = join(evidenceRoot, 'focused-tests.tap');
  const focusedExitPath = join(evidenceRoot, 'focused-tests.exitcode');
  const fullLogPath = join(evidenceRoot, 'full-repository-tests.tap');
  const fullExitPath = join(evidenceRoot, 'full-repository-tests.exitcode');
  const fullRunReportPath = join(evidenceRoot, 'full-test-run-report.json');
  const buildLogPath = join(evidenceRoot, 'build.log');
  const buildExitPath = join(evidenceRoot, 'build.exitcode');
  const productExitPath = join(evidenceRoot, 'product-probe.exitcode');
  const productLogPath = join(evidenceRoot, 'product-probe.log');

  const [focusedText, focusedExit, fullText, fullExit, fullRunReport, buildText, buildExit, productProbe, productExit] = await Promise.all([
    readFile(focusedLogPath, 'utf8'),
    readExitCode(focusedExitPath),
    readFile(fullLogPath, 'utf8'),
    readExitCode(fullExitPath),
    readJson(fullRunReportPath),
    readFile(buildLogPath, 'utf8'),
    readExitCode(buildExitPath),
    readJson(productProbePath),
    readExitCode(productExitPath)
  ]);

  const focusedSummary = parseNodeTestSummary(focusedText, focusedLogPath);
  const fullSummary = parseNodeTestSummary(fullText, fullLogPath);
  validateNodeTestResult('focused regression tests', focusedExit, focusedSummary);
  validateNodeTestResult('full repository tests', fullExit, fullSummary);
  if (fullRunReport.status !== 'passed' || fullRunReport.exitCode !== 0 || fullExit !== 0) {
    throw new Error('Full test run receipt does not record a successful exit.');
  }
  validateProductProbe(productProbe, productProbePath, productExit);
  if (buildExit !== 0 || !buildText.includes('Built static JARVIS executive console into dist/.')) {
    throw new Error('Production build evidence does not contain the successful build receipt.');
  }

  const gateDefinitions = [
    {
      id: 'focused-regression-tests',
      command: `node --test ${FOCUSED_TEST_FILES.join(' ')}`,
      exitCode: focusedExit,
      summary: focusedSummary,
      rawEvidence: [focusedLogPath, focusedExitPath]
    },
    {
      id: 'product-resilience-probe-v2',
      command: `node scripts/apex-product-resilience-probe.mjs --output ${displayPath(productProbePath)}`,
      exitCode: productExit,
      summary: { total: productProbe.total, pass: productProbe.passed, fail: productProbe.failed },
      rawEvidence: [productProbePath, productLogPath, productExitPath]
    },
    {
      id: 'full-repository-tests',
      command: 'npm test',
      exitCode: fullExit,
      summary: fullSummary,
      rawEvidence: [fullLogPath, fullExitPath, fullRunReportPath]
    },
    {
      id: 'production-build',
      command: 'npm run build',
      exitCode: buildExit,
      summary: { outputs: 1, warnings: countBuildWarnings(buildText), artifact: 'dist/' },
      rawEvidence: [buildLogPath, buildExitPath]
    }
  ];

  const receiptRoot = join(evidenceRoot, 'gate-receipts');
  await mkdir(receiptRoot, { recursive: true });
  const gates = [];
  for (const definition of gateDefinitions) {
    const rawEvidence = [];
    for (const path of definition.rawEvidence) {
      const bytes = await readFile(path);
      rawEvidence.push({
        path: displayPath(path),
        sizeBytes: bytes.length,
        sha256: sha256(bytes)
      });
    }
    const status = definition.exitCode === 0 ? 'passed' : 'failed';
    const receipt = {
      receiptVersion: 'jarvis-apex-gate-receipt-v1',
      generatedAt,
      id: definition.id,
      command: definition.command,
      status,
      exitCode: definition.exitCode,
      summary: definition.summary,
      rawEvidence
    };
    receipt.receiptSha256 = sha256Json({ ...receipt, generatedAt: undefined, receiptSha256: undefined });
    const receiptPath = join(receiptRoot, `${definition.id}.json`);
    await atomicJson(receiptPath, receipt);
    const receiptBytes = await readFile(receiptPath);
    gates.push({
      id: definition.id,
      command: definition.command,
      status,
      exitCode: definition.exitCode,
      summary: definition.summary,
      evidencePath: displayPath(receiptPath),
      evidenceSha256: sha256(receiptBytes)
    });
  }

  const report = {
    verificationVersion: 'jarvis-apex-final-verification-v1',
    generatedAt,
    status: gates.every((gate) => gate.status === 'passed') ? 'passed' : 'failed',
    total: gates.length,
    passed: gates.filter((gate) => gate.status === 'passed').length,
    failed: gates.filter((gate) => gate.status === 'failed').length,
    gates
  };
  report.reportSha256 = sha256Json({ ...report, generatedAt: undefined, reportSha256: undefined });
  await atomicJson(outputPath, report);
  return { outputPath, report };
}

function parseArguments(argv) {
  const defaults = {
    evidenceRoot: 'artifacts/apex-workflow-50-audit/final-verification-evidence-2026-09-04',
    productProbe: 'artifacts/apex-workflow-50-audit/2026-09-04-product-retest-final/product-probe.json',
    output: 'artifacts/apex-workflow-50-audit/final-verification-2026-09-04.json'
  };
  const options = { ...defaults };
  const flags = { '--evidence-root': 'evidenceRoot', '--product-probe': 'productProbe', '--output': 'output' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argv[index]}.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function parseNodeTestSummary(text, path) {
  const values = {};
  for (const line of stripAnsi(text).split(/\r?\n/u)) {
    const match = /^(?:#|ℹ)?\s*(tests|pass|fail|skipped)\s+(\d+)\s*$/u.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  if (!['tests', 'pass', 'fail', 'skipped'].every((key) => Number.isInteger(values[key]))) {
    throw new Error(`Node test summary is incomplete: ${path}`);
  }
  if (values.pass + values.fail + values.skipped !== values.tests) {
    throw new Error(`Node test summary totals are inconsistent: ${path}`);
  }
  return values;
}

function validateNodeTestResult(label, exitCode, summary) {
  if (exitCode !== 0 || summary.fail !== 0 || summary.pass + summary.skipped !== summary.tests) {
    throw new Error(`${label} did not pass.`);
  }
}

function validateProductProbe(report, path, exitCode) {
  if (!Array.isArray(report.probes) || report.probes.length !== 10
    || report.total !== 10 || report.passed !== 10 || report.failed !== 0
    || report.probes.some((probe) => probe.passed !== true) || exitCode !== 0) {
    throw new Error(`Product resilience probe is incomplete or failed: ${path}`);
  }
}

function countBuildWarnings(text) {
  return stripAnsi(text).split(/\r?\n/u).filter((line) => /\bwarning\b/iu.test(line)).length;
}

async function readExitCode(path) {
  const value = Number((await readFile(path, 'utf8')).trim());
  if (!Number.isInteger(value)) throw new Error(`Invalid exit code receipt: ${path}`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(temporaryPath, path);
}

function displayPath(path) {
  const value = relative(PROJECT_ROOT, resolve(path)).replaceAll('\\', '/');
  if (value === '..' || value.startsWith('../')) throw new Error(`Evidence path escapes the project root: ${path}`);
  return value;
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  const generated = await createApexFinalVerification(process.argv.slice(2));
  console.log(JSON.stringify({
    outputPath: generated.outputPath,
    status: generated.report.status,
    passed: generated.report.passed,
    failed: generated.report.failed,
    reportSha256: generated.report.reportSha256
  }));
  if (generated.report.status !== 'passed') process.exitCode = 1;
}
