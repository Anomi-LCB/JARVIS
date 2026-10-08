import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTREME_WORKFLOW_CORPUS_SHA256,
  EXTREME_WORKFLOW_CORPUS_VERSION,
  EXTREME_WORKFLOW_ISOLATION,
  EXTREME_WORKFLOW_SEED,
  EXTREME_WORKFLOW_VIRTUAL_CLOCK,
  createExtremeWorkflowCorpusFingerprint,
  extremeCases
} from './extreme-workflow-50-cases.mjs';
import { runExtremeWorkflowCase } from './extreme-workflow-scenario-engine.mjs';

export const EXTREME_WORKFLOW_AUDIT_VERSION = 'jarvis-extreme-workflow-50-audit-v1';
const SCRIPT_PATH = fileURLToPath(import.meta.url);

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.worker) return await runWorker(options);
  const selected = selectCases(options.caseIds);
  const runRoot = resolve(options.root ?? join('artifacts', 'extreme-workflow-50-audit', new Date().toISOString().replace(/[:.]/g, '-')));
  if (await pathExists(runRoot) && !options.resume) {
    const contents = await import('node:fs/promises').then(({ readdir }) => readdir(runRoot));
    if (contents.length > 0) throw new Error(`Audit root already contains files: ${runRoot}. Use --resume or a new --root.`);
  }
  await mkdir(runRoot, { recursive: true });
  const fingerprint = createExtremeWorkflowCorpusFingerprint(selected);
  const campaign = {
    auditVersion: EXTREME_WORKFLOW_AUDIT_VERSION,
    corpusVersion: EXTREME_WORKFLOW_CORPUS_VERSION,
    fullCorpusSha256: EXTREME_WORKFLOW_CORPUS_SHA256,
    selectedCorpusSha256: fingerprint.corpusSha256,
    seed: EXTREME_WORKFLOW_SEED,
    virtualClock: EXTREME_WORKFLOW_VIRTUAL_CLOCK,
    isolation: EXTREME_WORKFLOW_ISOLATION,
    cycles: options.cycles,
    selectedCaseIds: selected.map((item) => item.id),
    totalExecutions: selected.length * options.cycles,
    generatedAt: new Date().toISOString()
  };
  await atomicJson(join(runRoot, 'campaign.json'), campaign);
  await atomicJson(join(runRoot, 'corpus.json'), fingerprint.canonicalPayload);
  await writeFile(join(runRoot, 'commands.md'), renderCommands(selected), 'utf8');

  console.log(`EXTREME_AUDIT_ROOT ${runRoot}`);
  console.log(`CORPUS_SHA256 ${fingerprint.corpusSha256}`);
  console.log(`EXECUTIONS ${campaign.totalExecutions}`);

  const results = [];
  let previousHash = 'GENESIS';
  const ledgerPath = join(runRoot, 'sequence-ledger.jsonl');
  if (!options.resume) await rm(ledgerPath, { force: true });
  if (options.resume && await pathExists(ledgerPath)) {
    const lines = (await readFile(ledgerPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    if (lines.length) previousHash = JSON.parse(lines.at(-1)).hash;
  }

  let sequence = 0;
  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    const cycleRoot = join(runRoot, `cycle-${String(cycle).padStart(2, '0')}`);
    await mkdir(cycleRoot, { recursive: true });
    for (const testCase of selected) {
      sequence += 1;
      const caseRoot = join(cycleRoot, testCase.id);
      const resultPath = join(caseRoot, 'result.json');
      let result = options.resume ? await readResult(resultPath) : null;
      if (result) {
        console.log(`RESUME ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${result.outcome}`);
      } else {
        if (await pathExists(caseRoot)) await rm(caseRoot, { recursive: true, force: true });
        await mkdir(caseRoot, { recursive: true });
        console.log(`START ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${testCase.title}`);
        result = await executeChild({ testCase, cycle, caseRoot });
        console.log(`RESULT ${sequence}/${campaign.totalExecutions} cycle=${cycle} ${testCase.id} ${result.outcome} ${result.wallElapsedMs ?? 0}ms`);
      }
      results.push(result);
      const resultSha256 = sha256(await readFile(resultPath));
      const unsignedLedger = {
        sequence,
        cycle,
        caseId: testCase.id,
        outcome: result.outcome,
        terminalState: result.terminalState,
        resultSha256,
        semanticDigest: result.semanticDigest,
        previousHash
      };
      const record = { ...unsignedLedger, hash: sha256Json(unsignedLedger) };
      if (!options.resume || !(await ledgerContains(ledgerPath, sequence))) await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
      previousHash = record.hash;
      await writeSummary(runRoot, campaign, results);
      if (options.compact && cycle > options.keepWorkspacesThroughCycle) {
        await rm(join(caseRoot, 'workspace'), { recursive: true, force: true });
      }
    }
  }
  const summary = await writeSummary(runRoot, campaign, results);
  console.log(`FINAL ${summary.behavioralPass}/${summary.totalExecutions} PASS ${summary.failed} FAILED`);
  console.log(`CONFIDENCE_99_LOWER_BOUND ${summary.statistics.oneSided99PercentSuccessRateLowerBound}`);
  if (summary.failed > 0) process.exitCode = 1;
}

async function runWorker(options) {
  const testCase = extremeCases.find((item) => item.id === options.workerCaseId);
  if (!testCase) throw new Error(`Unknown worker case: ${options.workerCaseId}`);
  const caseRoot = resolve(options.workerRoot);
  await mkdir(caseRoot, { recursive: true });
  await writeFile(join(caseRoot, 'command.txt'), `${testCase.command}\n`, 'utf8');
  const result = await runExtremeWorkflowCase(testCase, {
    caseRoot,
    cycle: options.workerCycle,
    virtualClockStart: EXTREME_WORKFLOW_VIRTUAL_CLOCK.start
  });
  await atomicJson(join(caseRoot, 'result.json'), result);
  console.log(JSON.stringify({ caseId: testCase.id, outcome: result.outcome, resultPath: join(caseRoot, 'result.json') }));
  if (!result.behavioralPass) process.exitCode = 1;
}

async function executeChild({ testCase, cycle, caseRoot }) {
  const args = [SCRIPT_PATH, '--worker', '--case', testCase.id, '--cycle', String(cycle), '--root', caseRoot];
  const childResult = await new Promise((resolveChild) => {
    const child = spawn(process.execPath, args, {
      cwd: dirname(SCRIPT_PATH),
      env: sanitizedEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), Math.max(60_000, Number(testCase.budgets?.maxWallElapsedMs ?? 45_000) + 15_000));
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveChild({ code, signal, stdout, stderr });
    });
  });
  const resultPath = join(caseRoot, 'result.json');
  const result = await readResult(resultPath);
  if (result) return result;
  const failed = {
    resultVersion: EXTREME_WORKFLOW_AUDIT_VERSION,
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    cycle,
    command: testCase.command,
    outcome: 'FAILED',
    behavioralPass: false,
    terminalState: null,
    stopCode: 'CHILD_PROCESS_FAILED',
    wallElapsedMs: null,
    semanticDigest: sha256Json({ caseId: testCase.id, childResult }),
    engineError: {
      code: childResult.code,
      signal: childResult.signal,
      stdout: childResult.stdout.slice(-4000),
      stderr: childResult.stderr.slice(-4000)
    }
  };
  await atomicJson(resultPath, failed);
  return failed;
}

async function writeSummary(runRoot, campaign, results) {
  const passed = results.filter((item) => item.behavioralPass === true);
  const failed = results.filter((item) => item.behavioralPass !== true);
  const terminalStates = countBy(results, (item) => item.terminalState ?? 'UNKNOWN');
  const outcomes = countBy(results, (item) => item.outcome ?? 'UNKNOWN');
  const perCaseDigests = new Map();
  for (const result of results) {
    if (!perCaseDigests.has(result.caseId)) perCaseDigests.set(result.caseId, new Set());
    perCaseDigests.get(result.caseId).add(result.semanticDigest);
  }
  const digestMismatches = [...perCaseDigests.entries()]
    .filter(([, digests]) => digests.size > 1)
    .map(([caseId, digests]) => ({ caseId, digests: [...digests] }));
  const n = results.length;
  const lowerBound = failed.length === 0 && n > 0 ? Math.pow(0.01, 1 / n) : null;
  const traceSupplements = results.reduce((totals, item) => {
    const supplements = item.details?.scriptedTraceSupplements ?? {};
    totals.callKinds += Object.keys(supplements.calls ?? {}).length;
    totals.callUnits += Object.values(supplements.calls ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
    totals.faults += (supplements.faults ?? []).length;
    totals.events += (supplements.events ?? []).length;
    return totals;
  }, { callKinds: 0, callUnits: 0, faults: 0, events: 0 });
  const summary = {
    summaryVersion: 'jarvis-extreme-workflow-50-summary-v1',
    auditVersion: EXTREME_WORKFLOW_AUDIT_VERSION,
    campaign,
    updatedAt: new Date().toISOString(),
    totalExecutions: n,
    behavioralPass: passed.length,
    failed: failed.length,
    outcomes,
    terminalStates,
    realExternalAttempts: results.reduce((sum, item) => sum + Number(item.egress?.realAttempts ?? 0), 0),
    realExternalCommits: results.reduce((sum, item) => sum + Number(item.egress?.realCommits ?? 0), 0),
    faultCount: results.reduce((sum, item) => sum + Number(item.faultEvidence?.length ?? 0), 0),
    scriptedTraceSupplements: traceSupplements,
    faultConsumptionFailures: results.flatMap((item) => (item.faultEvidence ?? []).filter((fault) => fault.consumed !== 1).map((fault) => ({ caseId: item.caseId, faultId: fault.faultId, consumed: fault.consumed }))),
    semanticDigestMismatches: digestMismatches,
    failedCases: failed.map((item) => ({ cycle: item.cycle, caseId: item.caseId, terminalState: item.terminalState, stopCode: item.stopCode, failedAssertions: (item.assertions ?? []).filter((assertion) => !assertion.pass).map((assertion) => assertion.name), engineError: item.engineError })),
    statistics: {
      model: 'nominal one-sided exact binomial lower confidence bound for zero observed failures',
      confidence: 0.99,
      sampleSize: n,
      observedFailures: failed.length,
      oneSided99PercentSuccessRateLowerBound: lowerBound === null ? null : Number(lowerBound.toFixed(6)),
      appliesTo: 'this fixed deterministic corpus and declared fault distribution only',
      independenceAssumption: 'treats each fresh-process isolated execution as a Bernoulli trial; deterministic repetition does not establish independence across every future environment'
    }
  };
  summary.summarySha256 = sha256Json({ ...summary, summarySha256: undefined, updatedAt: undefined });
  await atomicJson(join(runRoot, 'summary.json'), summary);
  await writeFile(join(runRoot, 'summary.md'), renderSummary(summary), 'utf8');
  return summary;
}

function renderSummary(summary) {
  return `# JARVIS 극한 복합 명령 감사 중간 요약\n\n- 실행: ${summary.totalExecutions}\n- 기대 동작 통과: ${summary.behavioralPass}\n- 실패: ${summary.failed}\n- 실제 외부 호출: ${summary.realExternalAttempts}\n- 실제 외부 commit: ${summary.realExternalCommits}\n- 주입 장애: ${summary.faultCount}\n- scripted trace 보충: call ${summary.scriptedTraceSupplements.callUnits}, event ${summary.scriptedTraceSupplements.events}, fault ${summary.scriptedTraceSupplements.faults}\n- terminal: ${JSON.stringify(summary.terminalStates)}\n- outcome: ${JSON.stringify(summary.outcomes)}\n- 명목 99% 단측 성공률 하한: ${summary.statistics.oneSided99PercentSuccessRateLowerBound ?? '계산 불가'}\n\n이 하한은 새 프로세스의 각 실행을 Bernoulli 시행으로 간주했을 때의 값이며, 고정된 결정론적 코퍼스와 선언된 장애 분포에만 적용됩니다.\n`;
}

function renderCommands(cases) {
  return `# JARVIS 극한 복합 명령 50건\n\n${cases.map((item) => `## ${item.id} — ${item.title}\n\n${item.command}\n\n- 범주: ${item.category}\n- 기대: ${item.expected.terminalState}${item.expected.stopCode ? ` / ${item.expected.stopCode}` : ''}`).join('\n\n')}\n`;
}

function parseArguments(argv) {
  const options = { cycles: 1, caseIds: null, root: null, resume: false, compact: false, keepWorkspacesThroughCycle: 1, worker: false, workerCaseId: null, workerCycle: 1, workerRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--worker') options.worker = true;
    else if (arg === '--root') options.root = argv[++index];
    else if (arg === '--cases') options.caseIds = argv[++index].split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--case') options.workerCaseId = argv[++index];
    else if (arg === '--cycle') options.workerCycle = Number(argv[++index]);
    else if (arg === '--cycles') options.cycles = Number(argv[++index]);
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--compact') options.compact = true;
    else if (arg === '--keep-workspaces-through-cycle') options.keepWorkspacesThroughCycle = Number(argv[++index]);
  }
  if (options.worker) options.workerRoot = options.root;
  if (!Number.isInteger(options.cycles) || options.cycles < 1 || options.cycles > 100) throw new Error('--cycles must be an integer from 1 to 100.');
  return options;
}

function selectCases(caseIds) {
  if (!caseIds?.length) return extremeCases;
  const requested = new Set(caseIds);
  const selected = extremeCases.filter((item) => requested.has(item.id));
  const missing = [...requested].filter((id) => !selected.some((item) => item.id === id));
  if (missing.length) throw new Error(`Unknown cases: ${missing.join(', ')}`);
  return selected;
}

function sanitizedEnvironment() {
  const allowed = ['ALLUSERSPROFILE', 'APPDATA', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'windir'];
  return Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

async function ledgerContains(path, sequence) {
  if (!(await pathExists(path))) return false;
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
  return lines.some((line) => JSON.parse(line).sequence === sequence);
}

async function readResult(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await import('node:fs/promises').then(({ rename }) => rename(temp, path));
}

async function pathExists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256Json(value) { return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) await main();
