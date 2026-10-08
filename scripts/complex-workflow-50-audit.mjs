import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { coreTaskRuntimeEnvFromEnv } from './core-service-runtime.mjs';
import { cases } from './complex-workflow-50-cases.mjs';
import { applyComplexWorkflowCorrectionSet } from './complex-workflow-50-corrections.mjs';
import { verifyWorkflowActionProcess } from './complex-workflow-process-verifier.mjs';

const RUNNER_VERSION = 'jarvis-complex-workflow-50-audit-v2';
export const COMPLEX_WORKFLOW_50_AUDIT_VERSION = RUNNER_VERSION;
const EXPECTED_STOP_STATUSES = new Set(['WAITING_APPROVAL', 'BLOCKED', 'PAUSED']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_EMAIL_LEDGER_PATH = join(REPOSITORY_ROOT, 'artifacts', 'complex-workflow-50-audit', 'email-idempotency-v1.jsonl');
const SENSITIVE_ENV_KEYS = [
  'JARVIS_INTENT_CACHE_PATH',
  'JARVIS_PLAN_CACHE_PATH',
  'JARVIS_BACKUP_DIR',
  'JARVIS_BROWSER_DRIVER',
  'JARVIS_LLM_PLANNER',
  'JARVIS_LLM_CONTENT',
  'JARVIS_LLM_PLANNER_TIMEOUT_MS',
  'JARVIS_MISSION_TIMEOUT_MS',
  'JARVIS_MISSION_RETRY_TIMEOUT_MS',
  'JARVIS_MISSION_MAX_ACTIONS_PER_WAVE',
  'JARVIS_SMTP_USER',
  'JARVIS_SMTP_PASS',
  'JARVIS_SMTP_SERVICE'
];

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  validateCorpus(cases);
  const correctionApplication = applyComplexWorkflowCorrectionSet(cases, options.correctionSet);
  validateCorpus(correctionApplication.cases);
  const selectedCases = selectCases(correctionApplication.cases, options.caseIds);
  const selectedCorrectedCaseIds = selectedCases.filter((item) => item.correction).map((item) => item.id);
  if (correctionApplication.metadata && selectedCorrectedCaseIds.length === 0) {
    throw new Error(`Correction set ${options.correctionSet} does not apply to the selected --cases.`);
  }
  const correctionMetadata = correctionApplication.metadata
    ? { ...correctionApplication.metadata, appliedCaseIds: selectedCorrectedCaseIds }
    : null;
  const runRoot = resolve(options.root ?? join(
    'artifacts',
    'complex-workflow-50-audit',
    new Date().toISOString().replace(/[:.]/g, '-')
  ));

  await mkdir(runRoot, { recursive: true });
  if (!options.resume) {
    const collidingCaseIds = [];
    for (const testCase of selectedCases) {
      if (await pathExists(safeResolveInside(runRoot, testCase.id))) collidingCaseIds.push(testCase.id);
    }
    if (collidingCaseIds.length > 0) {
      throw new Error(`Audit case directories already exist (${collidingCaseIds.join(', ')}). Use --resume or choose a new --root.`);
    }
  }
  const corpusMetadata = await writeCorpus(runRoot, selectedCases, cases.length, options.resume, correctionMetadata);
  const accumulatedResults = [];

  console.log(`AUDIT_ROOT ${runRoot}`);
  console.log(`CORPUS_SHA256 ${corpusMetadata.corpusSha256}`);
  console.log(`SELECTED_CASES ${selectedCases.map((item) => item.id).join(',')}`);
  if (corpusMetadata.correctionSet) console.log(`CORRECTION_SET ${corpusMetadata.correctionSet.setId}`);

  for (const testCase of selectedCases) {
    const caseRoot = safeResolveInside(runRoot, testCase.id);
    const resultPath = join(caseRoot, 'result.json');
    const resumed = options.resume ? await readExistingResult(resultPath) : null;
    if (resumed) {
      accumulatedResults.push(resumed);
      console.log(`RESUME ${testCase.id} ${resumed.outcome ?? 'UNKNOWN'} ${resumed.missionStatus ?? ''}`);
      await writeSummary(runRoot, accumulatedResults, selectedCases, corpusMetadata, options);
      continue;
    }

    const priorCaseExists = await pathExists(caseRoot);
    if (priorCaseExists && options.resume) {
      if (isExternalEmailCase(testCase)) {
        const result = failedSetupResult(testCase, {
          code: 'AUDIT_INTERRUPTED_EMAIL_CASE',
          message: 'An interrupted external-send case has no complete result. Its delivery ledger was preserved and the case was not replayed, preventing an uncertain duplicate email.'
        });
        await atomicWriteJson(resultPath, result);
        accumulatedResults.push(result);
        console.log(`RESULT ${testCase.id} FAILED 0ms interrupted-email-not-replayed`);
        await writeSummary(runRoot, accumulatedResults, selectedCases, corpusMetadata, options);
        continue;
      }
      await rm(caseRoot, { recursive: true, force: true });
    }

    console.log(`START ${testCase.id} ${new Date().toISOString()} ${testCase.title}`);
    const result = await executeCase(testCase, caseRoot);
    accumulatedResults.push(result);
    await atomicWriteJson(resultPath, result);
    console.log(`RESULT ${testCase.id} ${result.outcome} ${result.missionStatus ?? ''} ${result.durationMs}ms ${result.stopReason ?? ''}`);
    await writeSummary(runRoot, accumulatedResults, selectedCases, corpusMetadata, options);
  }

  await writeSummary(runRoot, accumulatedResults, selectedCases, corpusMetadata, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function executeCase(testCase, caseRoot) {
  const workspace = join(caseRoot, 'workspace');
  const auditRoot = join(caseRoot, 'audit');
  const startedAt = new Date().toISOString();
  const timerStartedAt = performance.now();
  const originalEnv = captureEnvironment(SENSITIVE_ENV_KEYS);
  let runtime = null;
  let mission = null;
  let error = null;
  let inputManifest = {};
  let assertions = [];
  let artifacts = [];
  let tasks = [];
  let command = testCase.command;

  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(auditRoot, { recursive: true });
    inputManifest = await materializeInputs(workspace, testCase.inputs ?? {});

    const externalEmailAllowed = isExternalEmailCase(testCase);
    const scopedEnv = buildCaseEnvironment({ caseRoot, workspace, externalEmailAllowed });
    applyEnvironment(scopedEnv);
    command = scopedCommand(testCase, workspace, externalEmailAllowed);
    await atomicWriteText(join(caseRoot, 'command.txt'), command);

    runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot,
      emailLedgerPath: SHARED_EMAIL_LEDGER_PATH,
      cwd: () => workspace,
      env: scopedEnv,
      taskEnv: coreTaskRuntimeEnvFromEnv(scopedEnv),
      bridgeRealExecution: true,
      workerDaemonEnabled: false,
      workerDefaultTimeoutMs: 600_000,
      missionMaxActionsPerWave: 8
    });
    const owner = runtime.personalOwnerSession.activate({
      durationMinutes: 30,
      requestedBy: 'user-requested-50-complex-workflow-audit'
    });
    mission = runtime.missionRuntime.createMission({
      objective: command,
      successCriteria: successCriteriaFor(testCase),
      constraints: constraintsFor(testCase, workspace, externalEmailAllowed),
      budgets: {
        maxWaves: 7,
        maxActions: 20,
        maxPlannerCalls: 9,
        maxConsecutiveFailures: 3,
        maxActiveRuntimeMs: 600_000
      },
      authorization: {
        mode: 'trusted_session',
        grants: ['read_only', 'local_reversible', 'high_impact'],
        ownerSessionId: owner.session.sessionId
      }
    });
    mission = await runtime.missionRuntime.runMission(mission.missionId);
  } catch (caught) {
    error = normalizeError(caught);
  } finally {
    if (mission?.missionId && runtime?.missionRuntime) {
      try {
        mission = runtime.missionRuntime.getMission(mission.missionId);
      } catch (caught) {
        error ??= normalizeError(caught);
      }
    }
    if (runtime?.coreFacade?.tasks) {
      tasks = [...runtime.coreFacade.tasks.values()].map(compactTask);
    }
    try {
      assertions = await verifyCase(testCase, workspace, inputManifest, mission, tasks);
    } catch (caught) {
      assertions.push(assertion('independent verifier completed', false, {
        error: normalizeError(caught)
      }));
    }
    try {
      artifacts = await inventory(workspace);
    } catch (caught) {
      assertions.push(assertion('workspace inventory completed', false, {
        error: normalizeError(caught)
      }));
    }
    try {
      runtime?.workerDaemon?.stop?.();
    } catch {}
    restoreEnvironment(originalEnv);
  }

  const statusPass = expectedStatusPassed(testCase.expected?.status, mission?.status);
  const allAssertionsPass = assertions.length > 0 && assertions.every((item) => item.pass === true);
  const outcome = classifyOutcome({
    expectedStatus: testCase.expected?.status,
    missionStatus: mission?.status,
    statusPass,
    allAssertionsPass,
    assertions
  });

  return redactSecrets({
    resultVersion: RUNNER_VERSION,
    id: testCase.id,
    title: testCase.title,
    category: testCase.category,
    command: testCase.command,
    correction: testCase.correction ?? null,
    scopedCommand: command,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - timerStartedAt),
    expectedStatus: testCase.expected?.status ?? null,
    outcome,
    missionStatus: mission?.status ?? null,
    stopReason: mission?.stopReason ?? null,
    pendingGateCount: Array.isArray(mission?.pendingGates) ? mission.pendingGates.length : 0,
    assertions,
    artifacts,
    inputManifest,
    externalSendPolicy: {
      allowed: isExternalEmailCase(testCase),
      recipientMode: isExternalEmailCase(testCase) ? 'self' : null,
      arbitraryRecipientsAllowed: false,
      manualApprovalAttempted: false
    },
    plannerConfiguration: {
      provider: 'claude-cli',
      llmPlannerEnabled: true,
      maxWaves: 7,
      maxActions: 20,
      maxPlannerCalls: 9,
      maxActionsPerWave: 8,
      maxActiveRuntimeMs: 600_000
    },
    error,
    mission,
    tasks
  });
}

export async function verifyCase(testCase, workspace, inputManifest, mission, tasks, {
  referenceTime = new Date()
} = {}) {
  const checks = [];
  const expected = testCase.expected ?? {};
  const zipCache = new Map();

  checks.push(assertion(
    `mission status matches ${expected.status}`,
    expectedStatusPassed(expected.status, mission?.status),
    { expected: expected.status ?? null, actual: mission?.status ?? null }
  ));

  checks.push(...verifyWorkflowActionProcess({
    testCase,
    workspace,
    inputManifest,
    mission
  }));

  for (const rawSpec of expected.files ?? []) {
    const spec = normalizeFileSpec(rawSpec);
    const absolutePath = safeResolveInside(workspace, spec.path);
    const details = await stat(absolutePath).catch(() => null);
    const fileExists = details?.isFile() === true;
    if (spec.mustBeAbsent) {
      checks.push(assertion(`file remains absent: ${spec.path}`, !fileExists, {
        path: spec.path,
        size: details?.size ?? 0,
        type: spec.type
      }));
      continue;
    }
    checks.push(assertion(`file exists and is non-empty: ${spec.path}`, fileExists && details.size > 0, {
      path: spec.path,
      size: details?.size ?? 0,
      type: spec.type
    }));
    if (!fileExists) continue;

    const inspected = await inspectExpectedFile(absolutePath, spec, zipCache, {
      command: testCase.command
    });
    checks.push(...inspected.checks.map((item) => ({ ...item, file: spec.path })));
  }
  for (const missingPath of expected.missing ?? []) {
    const absolutePath = safeResolveInside(workspace, missingPath);
    checks.push(assertion(`path remains absent: ${missingPath}`, !(await pathExists(absolutePath)), {
      path: missingPath
    }));
  }

  checks.push(...await verifyPreservedInputs({ expected, inputManifest, workspace }));
  checks.push(...await verifyVisualCards({ testCase, mission, workspace }));

  if (expected.liveWeb) {
    checks.push(...await verifyLiveWeb(expected.liveWeb, mission, workspace, { referenceTime, tasks }));
  }

  if (expected.email) {
    checks.push(...await verifyEmail(testCase, expected.email, mission, tasks, workspace));
  } else {
    const executedEmailActions = missionActions(mission).filter((item) => (
      item.actualToolName === 'email.send' && item.status === 'succeeded'
    ));
    checks.push(assertion('no external email was executed', executedEmailActions.length === 0, {
      executedEmailActionCount: executedEmailActions.length
    }));
  }

  if (expected.status === 'EXPECTED_STOP') {
    const reportText = JSON.stringify({
      stopReason: mission?.stopReason,
      gates: mission?.gates,
      observations: mission?.observations,
      tasks: tasks.map((item) => ({ status: item.status, error: item.error, verification: item.verification }))
    });
    const missingNames = (expected.missing ?? []).map((item) => basename(item));
    const namesReported = missingNames.length === 0 || missingNames.some((name) => reportText.includes(name));

    checks.push(assertion('expected stop reports missing or required input without fabrication',
      namesReported && /없|누락|필요|제공|존재하지|찾을 수 없|missing|not exist|cannot find|required/iu.test(reportText), {
        missingNames,
        namesReported
      }));
    checks.push(...verifyExpectedStopReport(expected.stopReport, reportText));
  }

  return checks;
}

async function inspectExpectedFile(path, spec, zipCache, { command = '' } = {}) {
  const checks = [];
  const type = spec.type ?? inferType(path);
  let bytes = null;
  let searchableText = '';
  let zipInspection = null;

  if (['xlsx', 'docx', 'pptx', 'hwpx', 'zip'].includes(type)) {
    zipInspection = zipCache.get(path);
    if (!zipInspection) {
      zipInspection = inspectZip(path);
      zipCache.set(path, zipInspection);
    }
    checks.push(assertion(`valid ${type} ZIP container`, zipInspection.valid === true, {
      error: zipInspection.error ?? null,
      entryCount: zipInspection.entries?.length ?? 0
    }));
    searchableText = zipInspection.text ?? '';
    const entries = (zipInspection.entries ?? []).map(normalizeArchiveEntry);
    const formatParts = {
      xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
      docx: ['[Content_Types].xml', 'word/document.xml'],
      pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
      hwpx: ['mimetype', 'Contents/content.hpf', 'Contents/section0.xml']
    }[type];
    if (formatParts) {
      const missingFormatParts = formatParts.filter((entry) => !entries.includes(entry));
      checks.push(assertion(`${type} contains its required package parts`, missingFormatParts.length === 0, {
        requiredParts: formatParts,
        missingFormatParts
      }));
    }
    if (type === 'zip') {
      const unsafeEntries = entries.filter((entry) => entry.startsWith('/') || entry.split('/').includes('..'));
      checks.push(assertion('ZIP entry paths are relative and traversal-safe', unsafeEntries.length === 0, { unsafeEntries }));
    }
  } else {
    bytes = await readFile(path);
    searchableText = bytes.toString('utf8').replace(/^\uFEFF/, '');
  }

  for (const needle of spec.contains ?? []) {
    const contentMatch = evaluateExpectedContentMatch({
      searchableText,
      needle,
      type,
      zipInspection,
      command
    });
    checks.push(assertion(`contains: ${String(needle)}`, contentMatch.pass, {
      expectedText: String(needle),
      ...contentMatch.details
    }));
  }
  for (const needle of spec.absent ?? []) {
    checks.push(assertion(`absent: ${String(needle)}`, !containsText(searchableText, needle), {
      absentText: String(needle)
    }));
  }

  if (type === 'json') {
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(searchableText);
    } catch (caught) {
      parseError = caught.message;
    }
    checks.push(assertion('valid JSON parses successfully', parseError === null, {
      rootType: Array.isArray(parsed) ? 'array' : typeof parsed,
      error: parseError
    }));
    if (spec.rootType === 'array') checks.push(assertion('JSON root is an array', Array.isArray(parsed), { actualType: Array.isArray(parsed) ? 'array' : typeof parsed }));
    if (spec.rootType === 'object') checks.push(assertion('JSON root is an object', parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), { actualType: Array.isArray(parsed) ? 'array' : typeof parsed }));
    if (Number.isInteger(spec.length)) checks.push(assertion(`JSON root length is ${spec.length}`, Array.isArray(parsed) && parsed.length === spec.length, { actualLength: Array.isArray(parsed) ? parsed.length : null }));
  }

  if (type === 'csv') {
    const parsed = parseCsv(searchableText);
    const width = parsed.rows[0]?.length ?? 0;
    checks.push(assertion('CSV parses with a non-empty header and consistent columns',
      parsed.error === null && parsed.rows.length > 0 && width > 0 && parsed.rows.every((row) => row.length === width), {
        rowCount: parsed.rows.length,
        columnCount: width,
        error: parsed.error
      }));
    if (Number.isInteger(spec.rows)) checks.push(assertion(`CSV data row count is ${spec.rows}`, Math.max(0, parsed.rows.length - 1) === spec.rows, { actualDataRows: Math.max(0, parsed.rows.length - 1) }));
    if (Number.isInteger(spec.columns)) checks.push(assertion(`CSV column count is ${spec.columns}`, width === spec.columns, { actualColumns: width }));
  }

  if (type === 'html') {
    const externalReferences = [...searchableText.matchAll(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//giu)].map((match) => match[0]);
    checks.push(assertion('HTML is a complete standalone document',
      /<html\b/iu.test(searchableText) && /<body\b/iu.test(searchableText) && /<\/html>/iu.test(searchableText), {}));
    checks.push(assertion('HTML has no external resource references', externalReferences.length === 0, { externalReferences }));
  }

  if (type === 'xlsx') {
    const actualSheets = zipInspection?.sheets ?? [];
    const normalizedActualSheets = actualSheets.map((item) => String(item ?? '').normalize('NFC').trim());
    checks.push(assertion('workbook exposes a non-empty, unique sheet-name list',
      normalizedActualSheets.length > 0
      && normalizedActualSheets.every(Boolean)
      && new Set(normalizedActualSheets).size === normalizedActualSheets.length, {
        actualSheets
      }));

    const headerQuality = workbookHeaderQuality(zipInspection?.workbookTables);
    checks.push(assertion('workbook column headers are readable text', headerQuality.pass, {
      workbookTables: headerQuality.workbookTables,
      invalidHeaders: headerQuality.invalidHeaders
    }));

    if (Array.isArray(spec.sheets) && spec.sheets.length > 0) {
      const policy = workbookSheetValidationPolicy({
        command,
        workbookPath: spec.path ?? path,
        expectedSheets: spec.sheets
      });
      if (policy.enforceExact) {
        checks.push(assertion(`workbook sheet names match the user-requested names: ${spec.sheets.join(', ')}`,
          sameStringSet(actualSheets, spec.sheets), {
            expectedSheets: spec.sheets,
            actualSheets,
            creationStep: policy.creationStep,
            enforced: true,
            informational: false
          }));
      } else {
        if (policy.explicitSheets.length > 0) {
          checks.push(assertion('workbook contains every sheet name explicitly requested by the user',
            policy.explicitSheets.every((sheet) => normalizedActualSheets.includes(String(sheet).normalize('NFC'))), {
              explicitSheets: policy.explicitSheets,
              actualSheets,
              creationStep: policy.creationStep,
              enforced: true,
              informational: false
            }));
        }
        checks.push(assertion('declared workbook sheet labels not stated by the user are informational only', true, {
          expectedSheets: spec.sheets,
          explicitSheets: policy.explicitSheets,
          informationalSheets: policy.informationalSheets,
          actualSheets,
          creationStep: policy.creationStep,
          enforced: false,
          informational: true,
          reason: 'Sheet labels can affect pass/fail only when the workbook creation step explicitly names them.'
        }));
      }
      if (Number.isInteger(policy.requestedSheetCount)) {
        checks.push(assertion(`workbook sheet count matches the user-requested count: ${policy.requestedSheetCount}`,
          actualSheets.length === policy.requestedSheetCount, {
            expectedCount: policy.requestedSheetCount,
            actualCount: actualSheets.length,
            actualSheets,
            creationStep: policy.creationStep
          }));
      }
    }
  }

  if (type === 'pptx' && Number.isInteger(spec.slides)) {
    const actualSlides = (zipInspection?.entries ?? [])
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry)).length;
    checks.push(assertion(`slide count is ${spec.slides}`, actualSlides === spec.slides, {
      expectedSlides: spec.slides,
      actualSlides
    }));
  }

  if (type === 'png') {
    bytes ??= await readFile(path);
    const validSignature = bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    const width = validSignature ? bytes.readUInt32BE(16) : null;
    const height = validSignature ? bytes.readUInt32BE(20) : null;
    checks.push(assertion('valid PNG signature and IHDR', validSignature, { width, height }));
    if (Number.isInteger(spec.width)) {
      checks.push(assertion(`PNG width is ${spec.width}`, width === spec.width, {
        expectedWidth: spec.width,
        actualWidth: width
      }));
    }
    if (Number.isInteger(spec.height)) {
      checks.push(assertion(`PNG height is ${spec.height}`, height === spec.height, {
        expectedHeight: spec.height,
        actualHeight: height
      }));
    }
  }

  if (Array.isArray(spec.entries)) {
    const actualEntries = (zipInspection?.entries ?? []).map(normalizeArchiveEntry);
    const expectedEntries = spec.entries.map(normalizeArchiveEntry);
    const missingEntries = expectedEntries
      .filter((expectedEntry) => !actualEntries.includes(expectedEntry));
    const unexpectedEntries = actualEntries.filter((actualEntry) => !expectedEntries.includes(actualEntry));
    checks.push(assertion('ZIP entries exactly match the expected files',
      missingEntries.length === 0 && unexpectedEntries.length === 0 && actualEntries.length === expectedEntries.length, {
      expectedEntries,
      missingEntries,
      unexpectedEntries,
      actualEntries
    }));
  }

  return { checks };
}

export function workbookSheetValidationPolicy({ command = '', workbookPath = '', expectedSheets = [] } = {}) {
  const normalizedCommand = String(command ?? '').normalize('NFC');
  const workbookName = basename(String(workbookPath ?? '')).normalize('NFC');
  const steps = normalizedCommand
    .split(/(?=\b\d+\)\s*)/gu)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = steps.filter((step) => workbookName && step.toLocaleLowerCase().includes(workbookName.toLocaleLowerCase()));
  const creationStep = candidates.find((step) => /만들|작성|생성|기록|저장/iu.test(step)) ?? candidates[0] ?? '';
  const mentionsSheets = /시트/iu.test(creationStep);
  const explicitSheets = mentionsSheets
    ? expectedSheets.filter((sheet) => creationStep.includes(String(sheet).normalize('NFC')))
    : [];
  const informationalSheets = expectedSheets.filter((sheet) => !explicitSheets.includes(sheet));
  const countMatch = creationStep.match(/(?:정확히\s*)?(\d+|한|두|세|네)\s*(?:개\s*)?시트/iu);
  const countWords = { '한': 1, '두': 2, '세': 3, '네': 4 };
  const requestedSheetCount = countMatch
    ? (Number.isInteger(Number(countMatch[1])) ? Number(countMatch[1]) : countWords[countMatch[1]] ?? null)
    : null;
  return {
    creationStep,
    explicitSheets,
    informationalSheets,
    enforceExact: expectedSheets.length > 0 && explicitSheets.length === expectedSheets.length,
    requestedSheetCount: Number.isInteger(requestedSheetCount) ? requestedSheetCount : null
  };
}

export async function verifyPreservedInputs({ expected = {}, inputManifest = {}, workspace } = {}) {
  const requested = new Map();
  if (expected.unchangedInputs === true) {
    for (const path of Object.keys(inputManifest)) requested.set(path, { path, currentPath: path, source: 'unchangedInputs' });
  }
  for (const item of Array.isArray(expected.preservedInputs) ? expected.preservedInputs : []) {
    const path = typeof item === 'string' ? item : item?.path;
    const currentPath = typeof item === 'string' ? item : item?.currentPath ?? item?.path;
    if (path) requested.set(String(path), { path: String(path), currentPath: String(currentPath), source: 'preservedInputs' });
  }
  for (const rawSpec of expected.files ?? []) {
    const spec = normalizeFileSpec(rawSpec);
    if (!spec.mustBeAbsent && spec.preserveBytes !== false && Object.hasOwn(inputManifest, spec.path)) {
      requested.set(spec.path, { path: spec.path, currentPath: spec.path, source: 'expected.files-retained-input' });
    }
  }

  const checks = [];
  for (const request of requested.values()) {
    const before = inputManifest[request.path];
    const currentPath = safeResolveInside(workspace, request.currentPath);
    const bytes = await readFile(currentPath).catch(() => null);
    const afterSha256 = bytes ? sha256(bytes) : null;
    checks.push(assertion(`input bytes preserved: ${request.path}`, Boolean(before) && Boolean(bytes)
      && bytes.length === before.size
      && afterSha256 === before.sha256, {
        path: request.path,
        currentPath: request.currentPath,
        source: request.source,
        beforeSha256: before?.sha256 ?? null,
        afterSha256,
        beforeSize: before?.size ?? null,
        afterSize: bytes?.length ?? null
      }));
  }
  return checks;
}

export async function verifyVisualCards({ testCase = {}, mission, workspace } = {}) {
  const expectedPngPaths = (testCase.expected?.files ?? [])
    .map(normalizeFileSpec)
    .filter((spec) => spec.type === 'png' && !spec.mustBeAbsent)
    .map((spec) => normalizeArchiveEntry(spec.path));
  if (expectedPngPaths.length === 0) return [];

  const observations = (mission?.observations ?? []).filter((item) => (
    item.toolName === 'visual.createCards' && item.outcome === 'success'
  ));
  const actions = missionActions(mission).filter((item) => (
    item.actualToolName === 'visual.createCards' && item.status === 'succeeded'
  ));
  const cardRecords = [];
  for (const action of actions) {
    const observation = observations.find((item) => item.actionId === action.actionId
      && (!action.observationId || item.observationId === action.observationId));
    const outputDirectory = resolveCardLocation(action.arguments?.outputDirectory ?? workspace, workspace);
    for (const card of Array.isArray(action.arguments?.cards) ? action.arguments.cards : []) {
      const absolutePath = resolveCardLocation(card?.path ?? card?.fileName, outputDirectory);
      const relativePath = workspaceRelativePath(absolutePath, workspace);
      const artifact = (observation?.artifacts ?? []).find((item) => (
        normalizeArchiveEntry(item.relativePath ?? item.name).toLocaleLowerCase() === relativePath.toLocaleLowerCase()
      ));
      const bytes = await readFile(absolutePath).catch(() => null);
      const actualSha256 = bytes ? sha256(bytes) : null;
      const title = String(card?.title ?? '').trim();
      const body = Array.isArray(card?.body) ? card.body.join(' ') : String(card?.body ?? '').trim();
      const contentText = String(card?.contentText ?? '').trim();
      const semanticText = [title, body, contentText].filter(Boolean).join(' ');
      const commandTokens = cardCommandSemanticTokens(testCase.command, relativePath);
      const matchingSemanticTokens = commandTokens.filter((token) => normalizeSearchToken(semanticText).includes(token));
      cardRecords.push({
        actionId: action.actionId,
        observationId: observation?.observationId ?? null,
        relativePath,
        fileName: card?.fileName ?? null,
        titleChars: title.length,
        bodyChars: body.length,
        contentTextChars: contentText.length,
        meaningfulContent: contentText.length > 0 || (title.length > 0 && body.length > 0),
        commandTokens,
        matchingSemanticTokens,
        semanticTokensSatisfied: commandTokens.length === 0 || matchingSemanticTokens.length > 0,
        observationLinked: Boolean(observation),
        artifactLinked: Boolean(artifact),
        artifactSha256: artifact?.contentSha256 ?? null,
        actualSha256,
        hashMatched: Boolean(actualSha256) && artifact?.contentSha256 === actualSha256
      });
    }
  }

  const evidence = expectedPngPaths.map((expectedPath) => {
    const matches = cardRecords.filter((item) => item.relativePath.toLocaleLowerCase() === expectedPath.toLocaleLowerCase());
    return { expectedPath, matchCount: matches.length, matches };
  });
  const expectedKeys = new Set(expectedPngPaths.map((item) => item.toLocaleLowerCase()));
  const unexpectedCardPaths = cardRecords
    .map((item) => item.relativePath)
    .filter((item) => !expectedKeys.has(item.toLocaleLowerCase()));
  const pass = evidence.every((item) => item.matchCount === 1 && item.matches.every((match) => (
    match.meaningfulContent
    && match.semanticTokensSatisfied
    && match.observationLinked
    && match.artifactLinked
    && match.hashMatched
  ))) && unexpectedCardPaths.length === 0;

  return [assertion('every expected PNG is a meaningfully populated, observed visual.createCards output', pass, {
    expectedPngPaths,
    successfulVisualActionCount: actions.length,
    successfulVisualObservationCount: observations.length,
    unexpectedCardPaths,
    evidence
  })];
}

export function verifyExpectedStopReport(stopReport, reportText) {
  const requiredFields = Array.isArray(stopReport?.requiredFields)
    ? stopReport.requiredFields.map((item) => String(item).normalize('NFC').trim()).filter(Boolean)
    : [];
  if (requiredFields.length === 0) {
    return [assertion('expected-stop field-level reporting has no declared acceptance schema', true, {
      enforced: false,
      informational: true,
      reason: 'Declare expected.stopReport.requiredFields to require each reported field; no case id is hard-coded.'
    })];
  }
  const normalizedReport = String(reportText ?? '').normalize('NFC').toLocaleLowerCase();
  const reportedFields = requiredFields.filter((field) => {
    const normalizedField = field.toLocaleLowerCase();
    const exactTerm = normalizedField.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const boundary = /^[\x00-\x7f]+$/u.test(normalizedField)
      ? (/[.\/-]/u.test(normalizedField) ? '[A-Za-z0-9_.-]' : '[A-Za-z0-9_]')
      : '[\\p{L}\\p{N}_]';
    return new RegExp(`(?<!${boundary})${exactTerm}(?!${boundary})`, 'u').test(normalizedReport);
  });
  const missingFields = requiredFields.filter((field) => !reportedFields.includes(field));
  return [assertion('expected stop reports every declared required field', missingFields.length === 0, {
    requiredFields,
    reportedFields,
    missingFields,
    enforced: true,
    informational: false
  })];
}

function resolveCardLocation(value, base) {
  const text = String(value ?? '').trim();
  return isAbsolute(text) ? resolve(text) : resolve(base, text);
}

function workspaceRelativePath(path, workspace) {
  return normalizeArchiveEntry(relative(resolve(workspace), resolve(path)));
}

function normalizeSearchToken(value) {
  return String(value ?? '').normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
}

function cardCommandSemanticTokens(command, relativePath) {
  const commandSegments = String(command ?? '').split(/\s+(?=\d+\)\s)/u);
  const targetPath = normalizeArchiveEntry(relativePath).toLocaleLowerCase();
  const commandSegment = commandSegments.find((segment) => (
    extractPngPathMatches(segment).some((item) => item.path.toLocaleLowerCase() === targetPath)
  )) ?? String(command ?? '');
  const stemTokens = basename(relativePath, extname(relativePath))
    .split(/[^\p{L}\p{N}]+/gu)
    .map((item) => normalizeSearchToken(item).trim())
    .filter((item) => item.length >= 3 && !/^\d+$/u.test(item));
  const commandWithoutPathIdentifiers = commandSegment
    .replace(/[\p{L}\p{N}_./\\-]+\.(?:png|zip|md|txt|csv|json|html|xlsx|docx|pptx|hwpx?)\b/giu, ' ')
    .replace(/[\p{L}\p{N}_./\\-]+\s*폴더(?:의|에서|에는|를|을|로)?/giu, ' ');
  const normalizedCommand = normalizeSearchToken(commandWithoutPathIdentifiers);
  const positionalTokens = positionalCardSemanticTokens(commandSegment, targetPath);
  return [...new Set([
    ...stemTokens.filter((token) => normalizedCommand.includes(token)),
    ...positionalTokens
  ])];
}

function extractPngPathMatches(value) {
  return [...String(value ?? '').matchAll(/[\p{L}\p{N}_./\\-]+\.png\b/giu)].map((match) => ({
    path: normalizeArchiveEntry(match[0]),
    index: match.index ?? 0
  }));
}

function positionalCardSemanticTokens(commandSegment, targetPath) {
  const pngPaths = extractPngPathMatches(commandSegment);
  const targetIndex = pngPaths.findIndex((item) => item.path.toLocaleLowerCase() === targetPath);
  if (targetIndex < 0 || pngPaths.length < 2) return [];

  const semanticPrefix = String(commandSegment ?? '')
    .slice(0, pngPaths[0].index)
    .replace(/^\s*\d+\)\s*/u, '')
    .replace(/\s*(?:을|를)\s*$/u, '')
    .trim();
  const semanticLabels = semanticPrefix
    .split(/\s*(?:·|,|;)\s*|\s+(?:및|그리고|and)\s+/iu)
    .map((item) => item.trim())
    .filter(Boolean);
  if (semanticLabels.length !== pngPaths.length) return [];

  return normalizeSearchToken(semanticLabels[targetIndex])
    .split(/\s+/u)
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token));
}

export async function verifyLiveWeb(spec, mission, workspace, {
  referenceTime = new Date(),
  tasks = []
} = {}) {
  const validationTime = new Date(referenceTime);
  const referenceTimestampMs = Number.isFinite(validationTime.getTime())
    ? validationTime.getTime()
    : Date.now();
  const browserObservations = (mission?.observations ?? []).filter((item) => (
    item.toolName === 'browser.search' && item.outcome === 'success'
  ));
  const browserEvidence = browserObservations.map((item) => ({
    kind: 'browser',
    observationId: item.observationId,
    ...item.data?.webProvenance
  }));
  const validBrowserEvidence = browserEvidence.filter((item) => (
    item.live === true
    && typeof item.capturedAt === 'string'
    && item.capturedAt.length > 0
    && item.driver !== 'recorded-network-replay'
    && !/replay/iu.test(String(item.driver ?? ''))
    && Number(item.navigationStatus) >= 200
    && Number(item.navigationStatus) < 300
    && timestampIsRecent(item.capturedAt, 30, referenceTimestampMs)
  ));
  const newsObservations = (mission?.observations ?? []).filter((item) => (
    item.toolName === 'news.fetchHeadlines' && item.outcome === 'success'
  ));
  const taskNewsEvidence = collectNestedObjects(Array.isArray(tasks) ? tasks : [])
    .filter((item) => (
      item
      && typeof item === 'object'
      && /^https:\/\//iu.test(String(item.sourceUrl ?? ''))
      && typeof item.retrievedAt === 'string'
      && (item.sourceProvider || item.feedVersion)
    ))
    .map((item) => ({
      item,
      normalizedItems: normalizeNewsItemsEvidence(item.items)
    }))
    .filter((item) => item.normalizedItems.valid);
  const newsEvidence = newsObservations.map((observation) => {
    const rawNews = observation.data?.news && typeof observation.data.news === 'object'
      ? observation.data.news
      : {};
    const observationItems = normalizeNewsItemsEvidence(rawNews.items);
    const taskFallback = taskNewsEvidence.find(({ item }) => (
      String(item.sourceUrl ?? '') === String(rawNews.sourceUrl ?? '')
      && String(item.retrievedAt ?? '') === String(rawNews.retrievedAt ?? '')
      && String(item.category ?? '') === String(rawNews.category ?? '')
    ));
    const selectedItems = observationItems.valid
      ? observationItems
      : taskFallback?.normalizedItems ?? normalizeNewsItemsEvidence(null);
    return {
      kind: 'news',
      observationId: observation.observationId,
      ...rawNews,
      items: selectedItems.items,
      itemEvidence: {
        observation: {
          valid: observationItems.valid,
          inputType: observationItems.inputType,
          shape: observationItems.shape,
          reason: observationItems.reason
        },
        taskFallback: taskFallback
          ? {
              valid: true,
              inputType: taskFallback.normalizedItems.inputType,
              shape: taskFallback.normalizedItems.shape,
              reason: null
            }
          : null,
        selectedSource: observationItems.valid
          ? 'mission-observation'
          : taskFallback ? 'task-execution-adapter-evidence' : null,
        selectedValid: selectedItems.valid
      }
    };
  });
  const validNewsEvidence = newsEvidence.filter((item) => (
    item.live === true
    && item.replay !== true
    && item.fixture !== true
    && item.fetched === true
    && typeof item.retrievedAt === 'string'
    && item.retrievedAt.length > 0
    && Number(item.httpStatus) >= 200
    && Number(item.httpStatus) < 300
    && /^https:\/\//iu.test(String(item.sourceUrl ?? ''))
    && Array.isArray(item.items)
    && item.items.length === Number(item.itemCount)
    && item.items.length > 0
    && timestampIsRecent(item.retrievedAt, 30, referenceTimestampMs)
    && item.items.every((newsItem) => (
      String(newsItem?.title ?? '').trim().length > 0
      && /^https?:\/\//iu.test(String(newsItem?.url ?? ''))
      && String(newsItem?.publishedAt ?? '').trim().length > 0
      && String(newsItem?.source ?? '').trim().length > 0
    ))
  ));
  const urls = [...new Set([
    ...browserObservations
    .flatMap((item) => item.data?.searchResults ?? [])
    .map((item) => String(item.url ?? '').trim())
    .filter((url) => /^https?:\/\//iu.test(url)),
    ...newsEvidence.flatMap((item) => [
      item.sourceUrl,
      ...(item.items ?? []).flatMap((newsItem) => [newsItem.url, newsItem.sourceUrl])
    ]).map((item) => String(item ?? '').trim()).filter((url) => /^https?:\/\//iu.test(url))
  ])];
  const domains = [...new Set(urls.map(urlDomain).filter(Boolean))];
  const minUrls = Math.max(1, Number(spec.minUrls ?? 1));
  const minDomains = Math.max(1, Number(spec.minDomains ?? 1));
  const totalEvidenceCount = browserEvidence.length + newsEvidence.length;
  const validEvidenceCount = validBrowserEvidence.length + validNewsEvidence.length;
  const requiredDomains = Array.isArray(spec.requiredDomains) ? spec.requiredDomains.map((item) => String(item).toLowerCase()) : [];
  const missingRequiredDomains = requiredDomains.filter((required) => !domains.some((domain) => domain === required || domain.endsWith(`.${required}`)));
  const minDirectOfficialReads = Math.max(0, Number(spec.minDirectOfficialReads ?? 0));
  const minDirectOfficialContentChars = 120;
  const validBrowserObservationIds = new Set(validBrowserEvidence.map((item) => item.observationId));
  const directOfficialReadsByUrl = new Map();
  for (const action of missionActions(mission)) {
    if (action.status !== 'succeeded' || action.actualToolName !== 'browser.search') continue;
    const rawQuery = String(action.arguments?.query ?? '').trim();
    let queryUrl;
    try {
      queryUrl = new URL(rawQuery);
    } catch {
      continue;
    }
    if (queryUrl.protocol !== 'https:' || queryUrl.username || queryUrl.password || queryUrl.port) continue;
    const queryDomain = urlDomain(queryUrl.href);
    // The browser adapter only treats these exact trusted hosts as direct navigation.
    // Subdomains fall back to a search engine and therefore are not direct reads.
    if (!queryDomain || !requiredDomains.includes(queryDomain)) continue;
    const directReadResourceIdentity = normalizeDirectReadResourceIdentity(queryUrl.href);
    const citationIdentityUrl = normalizeCitationUrl(queryUrl.href);
    const linkedObservation = browserObservations.find((item) => (
      item.actionId === action.actionId
      && validBrowserObservationIds.has(item.observationId)
      && (!action.observationId || action.observationId === item.observationId)
    ));
    const matchedResult = (linkedObservation?.data?.searchResults ?? [])
      .find((item) => normalizeDirectReadResourceIdentity(item.url) === directReadResourceIdentity);
    const matchedResultUrl = String(matchedResult?.url ?? '').trim();
    const contentPreviewChars = String(matchedResult?.snippet ?? '').trim().length;
    if (!matchedResultUrl || !directReadResourceIdentity || !citationIdentityUrl || contentPreviewChars < minDirectOfficialContentChars) continue;
    directOfficialReadsByUrl.set(citationIdentityUrl, {
      actionId: action.actionId,
      observationId: linkedObservation.observationId,
      queryUrl: citationIdentityUrl,
      matchedResultUrl,
      comparableResourceUrl: directReadResourceIdentity,
      domain: queryDomain,
      contentPreviewChars
    });
  }
  const directOfficialReads = [...directOfficialReadsByUrl.values()];
  const directOfficialDomains = [...new Set(directOfficialReads.map((item) => item.domain))];
  const missingDirectOfficialDomains = requiredDomains.filter((required) => !directOfficialDomains.includes(required));
  const requiredToolObservationCount = spec.requiredTool === 'news.fetchHeadlines'
    ? validNewsEvidence.length
    : spec.requiredTool === 'browser.search' ? validBrowserEvidence.length : validEvidenceCount;
  const validNewsItems = validNewsEvidence.flatMap((item) => item.items ?? []);
  const todayKey = localDateKey(new Date(referenceTimestampMs));
  const currentDateNewsItems = validNewsItems.filter((item) => localDateKey(item.publishedAt) === todayKey);
  let artifactUrls = [];
  let artifactReadError = null;
  if (spec.artifactPath) {
    try {
      const artifactPath = safeResolveInside(workspace, spec.artifactPath);
      const artifactType = inferType(artifactPath);
      const artifactText = ['xlsx', 'docx', 'pptx', 'hwpx'].includes(artifactType)
        ? inspectZip(artifactPath).text
        : await readFile(artifactPath, 'utf8');
      artifactUrls = extractUrls(artifactText);
    } catch (caught) {
      artifactReadError = normalizeError(caught);
    }
  }
  const normalizedObservedUrls = new Set(urls.map(normalizeComparableUrl).filter(Boolean));
  const artifactObservedUrls = artifactUrls.filter((url) => normalizedObservedUrls.has(normalizeComparableUrl(url)));
  const minArtifactObservedUrls = Math.max(0, Number(spec.minArtifactObservedUrls ?? 0));
  const artifactObservedDomains = [...new Set(artifactObservedUrls.map(urlDomain).filter(Boolean))];
  const missingArtifactRequiredDomains = requiredDomains.filter((required) => !artifactObservedDomains.some(
    (domain) => domain === required || domain.endsWith(`.${required}`)
  ));
  const newsArticleUrls = [...new Set(validNewsItems.map((item) => normalizeComparableUrl(item.url)).filter(Boolean))];
  const normalizedArtifactUrls = new Set(artifactUrls.map(normalizeComparableUrl).filter(Boolean));
  const artifactNewsArticleUrls = newsArticleUrls.filter((url) => normalizedArtifactUrls.has(url));
  const minArtifactNewsArticleUrls = Math.max(0, Number(spec.minArtifactNewsArticleUrls ?? 0));
  const publisherDomains = [...new Set(validNewsItems.map((item) => urlDomain(item.sourceUrl)).filter(Boolean))];
  const minPublisherDomains = Math.max(0, Number(spec.minPublisherDomains ?? 0));

  return [
    assertion('web evidence is live, captured/fetched, non-replay, and HTTP 2xx',
      validEvidenceCount > 0 && validEvidenceCount === totalEvidenceCount, {
        observationCount: browserObservations.length,
        newsObservationCount: newsObservations.length,
        validEvidenceCount,
        browserEvidence,
        newsEvidence
      }),
    ...(newsObservations.length > 0 ? [assertion(
      'live news item evidence has a valid object or array shape',
      newsEvidence.every((item) => item.itemEvidence?.selectedValid === true),
      {
        newsItemEvidence: newsEvidence.map((item) => ({
          observationId: item.observationId,
          ...item.itemEvidence
        }))
      }
    )] : []),
    assertion(`live web evidence includes at least ${minUrls} unique URL(s)`, urls.length >= minUrls, {
      required: minUrls,
      actual: urls.length,
      urls
    }),
    assertion(`live web evidence spans at least ${minDomains} domain(s)`, domains.length >= minDomains, {
      required: minDomains,
      actual: domains.length,
      domains
    }),
    assertion(`live web evidence used required tool: ${spec.requiredTool ?? 'any'}`, requiredToolObservationCount > 0, {
      requiredTool: spec.requiredTool ?? null,
      requiredToolObservationCount
    }),
    assertion('live web evidence includes every required source domain', missingRequiredDomains.length === 0, {
      requiredDomains,
      missingRequiredDomains,
      domains
    }),
    ...(minDirectOfficialReads > 0 ? [assertion(
      `live web evidence includes at least ${minDirectOfficialReads} proven direct official-document read(s)`,
      directOfficialReads.length >= minDirectOfficialReads,
      {
        required: minDirectOfficialReads,
        actual: directOfficialReads.length,
        minimumContentPreviewChars: minDirectOfficialContentChars,
        directOfficialReads
      }
    ), assertion(
      'proven direct official-document reads cover every required source domain',
      missingDirectOfficialDomains.length === 0,
      {
        requiredDomains,
        missingDirectOfficialDomains,
        directOfficialDomains,
        directOfficialReads
      }
    )] : []),
    ...(requiredDomains.length > 0 && spec.artifactPath ? [assertion(
      'artifact cites a live-observed URL from every required source domain',
      missingArtifactRequiredDomains.length === 0,
      {
        artifactPath: spec.artifactPath,
        requiredDomains,
        missingArtifactRequiredDomains,
        artifactObservedDomains,
        artifactObservedUrls
      }
    )] : []),
    ...(Number(spec.minNewsItems ?? 0) > 0 ? [assertion(`live news evidence includes at least ${Number(spec.minNewsItems)} item(s)`,
      validNewsItems.length >= Number(spec.minNewsItems), { required: Number(spec.minNewsItems), actual: validNewsItems.length })] : []),
    ...(spec.publishedOnLocalDate === true ? [assertion(`news items include at least ${Number(spec.minNewsItems ?? 1)} published on ${todayKey}`,
      currentDateNewsItems.length >= Number(spec.minNewsItems ?? 1), {
        localDate: todayKey,
        matchingItemCount: currentDateNewsItems.length,
        publishedAt: validNewsItems.map((item) => item.publishedAt)
      })] : []),
    ...(minArtifactObservedUrls > 0 ? [assertion(`artifact cites at least ${minArtifactObservedUrls} URL(s) from live observations`,
      new Set(artifactObservedUrls.map(normalizeCitationUrl).filter(Boolean)).size >= minArtifactObservedUrls, {
        artifactPath: spec.artifactPath,
        artifactReadError,
        artifactUrls,
        artifactObservedUrls
      })] : []),
    ...(minArtifactNewsArticleUrls > 0 ? [assertion(
      `artifact cites at least ${minArtifactNewsArticleUrls} unique observed news article URL(s)`,
      artifactNewsArticleUrls.length >= minArtifactNewsArticleUrls,
      {
        artifactPath: spec.artifactPath,
        required: minArtifactNewsArticleUrls,
        observedNewsArticleUrls: newsArticleUrls,
        artifactNewsArticleUrls
      }
    )] : []),
    ...(minPublisherDomains > 0 ? [assertion(
      `live news evidence includes at least ${minPublisherDomains} publisher domain(s)`,
      publisherDomains.length >= minPublisherDomains,
      {
        required: minPublisherDomains,
        actual: publisherDomains.length,
        publisherDomains
      }
    )] : [])
  ];
}

async function verifyEmail(testCase, spec, mission, tasks, workspace) {
  const actions = missionActions(mission).filter((item) => (
    item.actualToolName === 'email.send' || item.expectedToolName === 'email.send'
  ));
  const completedActions = actions.filter((item) => item.status === 'succeeded');
  const observations = (mission?.observations ?? []).filter((item) => (
    item.toolName === 'email.send' && item.outcome === 'success'
  ));
  const emailEvidence = observations.map((item) => item.data?.email).filter(Boolean);
  const nestedTaskObjects = collectNestedObjects(tasks);
  const executionRecords = nestedTaskObjects.filter((item) => (
    typeof item.subject === 'string'
    && Number.isFinite(Number(item.attachmentCount))
    && (item.verification?.providerAccepted === true || item.evidence?.email?.providerAccepted === true)
  ));
  const actualSubjects = executionRecords.map((item) => item.subject);
  const plannedSubjects = actions.map((item) => item.arguments?.subject).filter((item) => typeof item === 'string');
  const subjectPool = actualSubjects.length > 0 ? actualSubjects : plannedSubjects;
  const subjectContains = String(spec.subjectContains ?? '');
  const expectedAttachmentCount = Number(spec.attachmentCount ?? 0);
  const expectedAttachmentPaths = (spec.attachmentPaths ?? []).map(normalizeArchiveEntry);
  const expectedIdempotencyKey = String(spec.idempotencyKey ?? '');
  const observedAttachmentCounts = emailEvidence.map((item) => Number(item.attachmentCount));
  const executedAttachmentCounts = executionRecords.map((item) => Number(item.attachmentCount));
  const attachmentCounts = [...observedAttachmentCounts, ...executedAttachmentCounts];
  const exactSelfActions = completedActions.filter((item) => {
    const args = item.arguments ?? {};
    const to = String(args.to ?? '').trim();
    const attachments = Array.isArray(args.attachments) ? args.attachments : [];
    const exactAttachments = attachments.every((attachment) => {
      const ref = attachment?.attachmentRef ?? attachment?.ref;
      const hash = String(attachment?.attachmentSha256 ?? attachment?.sha256 ?? attachment?.contentSha256 ?? '').trim();
      return Number.isInteger(Number(ref?.rootIndex))
        && String(ref?.relativePath ?? '').trim().length > 0
        && /^[a-f0-9]{64}$/iu.test(hash);
    });
    return item.authorizationMode === 'trusted-owner-self-email'
      && args.recipientMode === 'self'
      && (!to || /^self$/iu.test(to))
      && attachments.length === expectedAttachmentCount
      && exactAttachments;
  });
  const completedAction = completedActions.length === 1 ? completedActions[0] : null;
  const completedArgs = completedAction?.arguments ?? {};
  const completedAttachments = Array.isArray(completedArgs.attachments) ? completedArgs.attachments : [];
  const attachmentEvidence = [];
  for (const attachment of completedAttachments) {
    const ref = attachment?.attachmentRef ?? attachment?.ref;
    const relativePath = normalizeArchiveEntry(ref?.relativePath);
    const declaredSha256 = String(attachment?.attachmentSha256 ?? attachment?.sha256 ?? attachment?.contentSha256 ?? '').trim().toLowerCase();
    let actualSha256 = null;
    let error = null;
    try {
      if (Number(ref?.rootIndex) !== 0 || !relativePath) throw new Error('attachment-ref-must-use-workspace-root-0');
      actualSha256 = sha256(await readFile(safeResolveInside(workspace, relativePath)));
    } catch (caught) {
      error = normalizeError(caught);
    }
    attachmentEvidence.push({
      relativePath,
      rootIndex: ref?.rootIndex ?? null,
      declaredSha256,
      actualSha256,
      hashMatches: /^[a-f0-9]{64}$/u.test(declaredSha256) && declaredSha256 === actualSha256,
      error
    });
  }
  const actualAttachmentPaths = attachmentEvidence.map((item) => item.relativePath).filter(Boolean);
  const actualAttachmentHashes = attachmentEvidence.map((item) => item.actualSha256).filter(Boolean);
  const declaredAttachmentHashes = attachmentEvidence.map((item) => item.declaredSha256).filter(Boolean);
  const acceptedEvidence = emailEvidence.filter((item) => (
    item.providerAccepted === true
    && item.recipientMatched === true
    && item.passed === true
    && item.deduplicated !== true
  ));
  const acceptedExecutionRecords = executionRecords.filter((item) => {
    const verification = item.verification ?? item.evidence?.email ?? item.evidence?.executionEvidence?.adapterEvidence?.email;
    return verification?.providerAccepted === true
      && verification?.recipientMatched === true
      && verification?.passed === true
      && item.deduplicated !== true;
  });
  const attachmentHashEvidence = [
    ...acceptedEvidence.map((item) => ({
      source: 'mission-observation',
      normalized: normalizeEmailAttachmentHashEvidence(item.attachmentSha256s)
    })),
    ...acceptedExecutionRecords.map((item) => ({
      source: 'task-execution-result',
      normalized: normalizeEmailAttachmentHashEvidence(item.attachmentSha256s)
    }))
  ].map((item) => ({
    source: item.source,
    valid: item.normalized.valid,
    hashes: item.normalized.hashes,
    inputType: item.normalized.inputType,
    shape: item.normalized.shape,
    reason: item.normalized.reason
  }));
  const validAttachmentHashEvidence = attachmentHashEvidence.filter((item) => item.valid);
  const matchingAttachmentHashEvidence = validAttachmentHashEvidence.filter((item) => (
    sameStringMultiset(item.hashes, actualAttachmentHashes)
  ));
  const expectedIdempotencyKeySha256 = expectedIdempotencyKey ? sha256(expectedIdempotencyKey) : null;
  const matchingExecutionIdempotencyEvidence = acceptedExecutionRecords.filter((item) => (
    expectedIdempotencyKeySha256
    && String(item.idempotencyKeySha256 ?? '').toLowerCase() === expectedIdempotencyKeySha256
  ));
  const idempotencyKeyMatches = expectedIdempotencyKey.length > 0 && (
    completedArgs.idempotencyKey === expectedIdempotencyKey
    || matchingExecutionIdempotencyEvidence.length > 0
  );
  const observedIdempotencyKeySha256 = completedArgs.idempotencyKey === expectedIdempotencyKey
    ? sha256(completedArgs.idempotencyKey)
    : String(matchingExecutionIdempotencyEvidence[0]?.idempotencyKeySha256 ?? '').toLowerCase() || null;

  return [
    assertion('external send is explicitly enabled only for this self-Gmail case',
      testCase.allowExternalSend === true && Boolean(testCase.expected?.email), {
        allowExternalSend: testCase.allowExternalSend === true,
        recipientMode: 'self'
      }),
    assertion('SMTP provider accepted exactly the intended self recipient',
      acceptedEvidence.length === 1 && emailEvidence.length === 1, {
        evidenceCount: emailEvidence.length,
        nonDeduplicatedAcceptedCount: acceptedEvidence.length,
        providerAcceptedCount: emailEvidence.filter((item) => item.providerAccepted === true).length,
        recipientMatchedCount: emailEvidence.filter((item) => item.recipientMatched === true).length
      }),
    assertion('exactly one email action succeeded with no replay or duplicate attempt',
      actions.length === 1 && completedActions.length === 1 && observations.length === 1, {
        attemptedEmailActionCount: actions.length,
        completedEmailActionCount: completedActions.length,
        successfulEmailObservationCount: observations.length
      }),
    assertion(`email attachment count is ${expectedAttachmentCount}`,
      attachmentCounts.includes(expectedAttachmentCount), {
        expectedAttachmentCount,
        observedAttachmentCounts: attachmentCounts
      }),
    assertion(`email subject contains: ${subjectContains}`,
      subjectContains.length > 0 && subjectPool.some((subject) => subject.includes(subjectContains)), {
        expectedSubjectContains: subjectContains,
        subjects: subjectPool,
        evidenceSource: actualSubjects.length > 0 ? 'task-execution-result' : 'mission-action'
      }),
    assertion('email used the fixed corpus idempotency key',
      idempotencyKeyMatches, {
        expectedIdempotencyKeySha256,
        actualIdempotencyKeySha256: observedIdempotencyKeySha256,
        missionActionValueRedacted: completedArgs.idempotencyKey === '[redacted]',
        matchingExecutionEvidenceCount: matchingExecutionIdempotencyEvidence.length,
        evidenceSource: completedArgs.idempotencyKey === expectedIdempotencyKey
          ? 'mission-action'
          : matchingExecutionIdempotencyEvidence.length > 0 ? 'task-execution-result-sha256' : null
      }),
    assertion('email attachments are exactly the intended workspace paths',
      expectedAttachmentPaths.length === expectedAttachmentCount
      && attachmentEvidence.length === expectedAttachmentCount
      && sameStringSet(actualAttachmentPaths, expectedAttachmentPaths), {
        expectedAttachmentPaths,
        actualAttachmentPaths
      }),
    assertion('accepted email attachment hash evidence has a valid object or array shape',
      validAttachmentHashEvidence.length > 0, {
        attachmentHashEvidence
      }),
    assertion('every emailed attachment hash matches the current file bytes and accepted evidence',
      attachmentEvidence.length === expectedAttachmentCount
      && attachmentEvidence.every((item) => item.hashMatches)
      && acceptedEvidence.length === 1
      && matchingAttachmentHashEvidence.length > 0
      && sameStringSet(declaredAttachmentHashes, actualAttachmentHashes), {
        attachmentEvidence,
        attachmentHashEvidence,
        matchingAttachmentHashEvidenceSources: matchingAttachmentHashEvidence.map((item) => item.source)
      }),
    assertion('email used trusted self authorization and exact hash-bound attachments',
      completedActions.length === 1 && exactSelfActions.length === 1, {
        completedEmailActionCount: completedActions.length,
        exactSelfActionCount: exactSelfActions.length
      })
  ];
}

function classifyOutcome({ expectedStatus, missionStatus, statusPass, allAssertionsPass, assertions }) {
  if (statusPass && allAssertionsPass) {
    return expectedStatus === 'EXPECTED_STOP' ? 'EXPECTED_STOP' : 'SUCCESS';
  }
  if (missionStatus === 'COMPLETED' || assertions.some((item) => item.pass === true)) return 'PARTIAL';
  return 'FAILED';
}

export function classifyCaseVerification(testCase, mission, assertions = []) {
  const expectedStatus = testCase?.expected?.status;
  const missionStatus = mission?.status;
  const statusPass = expectedStatusPassed(expectedStatus, missionStatus);
  const allAssertionsPass = assertions.length > 0 && assertions.every((item) => item.pass === true);
  return classifyOutcome({
    expectedStatus,
    missionStatus,
    statusPass,
    allAssertionsPass,
    assertions
  });
}

function expectedStatusPassed(expected, actual) {
  if (expected === 'EXPECTED_STOP') return EXPECTED_STOP_STATUSES.has(actual);
  return expected === 'COMPLETED' && actual === 'COMPLETED';
}

function scopedCommand(testCase, workspace, externalEmailAllowed) {
  const boundary = [
    testCase.command,
    '',
    `[감사 실행 경계] 모든 로컬 파일 읽기·쓰기·검색·열기는 정확히 ${workspace} 내부에서만 수행한다.`,
    '기존 사용자 자료나 이 작업공간 밖의 파일은 읽거나 변경하지 않는다.',
    '목록 조회만으로 생성·변환·분석을 완료했다고 판단하지 말고 결과 파일의 실제 내용과 형식을 검증한다.'
  ];
  if (externalEmailAllowed) {
    boundary.push(
      '이 사례에 한해 사용자 자신의 Gmail로 정확히 한 번 전송할 수 있다.',
      '주소를 추측하거나 직접 기입하지 말고 email.send의 recipientMode="self", to=""를 사용한다.',
      `보낼 모든 첨부는 이 미션에서 생성·검증된 artifact의 rootIndex, relativePath, contentSha256에 정확히 결합하고 idempotencyKey="${testCase.expected.email.idempotencyKey}"를 그대로 사용한다.`,
      '다른 사람, 다른 주소, 다른 외부 서비스로의 전송은 금지한다.'
    );
  } else {
    boundary.push('외부 전송, 이메일 발송, 결제, 계정 변경, 앱·플러그인 설치는 금지한다.');
  }
  return boundary.join('\n');
}

function successCriteriaFor(testCase) {
  const expected = testCase.expected ?? {};
  const criteria = [testCase.command];
  for (const rawSpec of expected.files ?? []) {
    const spec = normalizeFileSpec(rawSpec);
    criteria.push(spec.mustBeAbsent
      ? `${spec.path} 파일은 필수 입력을 받기 전까지 생성되지 않는다.`
      : `${spec.path} 파일이 실제로 존재하고 요청 내용과 ${spec.type} 형식을 통과한다.`);
  }
  for (const missingPath of expected.missing ?? []) {
    criteria.push(`${missingPath} 경로가 실제로 없음을 확인하고 존재하는 것처럼 추정하지 않는다.`);
  }
  if (expected.liveWeb) criteria.push('실시간 비재생 웹 캡처와 출처 URL을 결과에 남긴다.');
  if (expected.email) criteria.push('정확한 첨부 해시에 결합된 결과를 사용자 자신의 Gmail로 보내고 SMTP 수락을 확인한다.');
  if (expected.status === 'EXPECTED_STOP') criteria.push('필수 입력이 없으면 추정하거나 결과를 날조하지 않고 필요한 입력을 정확히 보고한 뒤 멈춘다.');
  return criteria;
}

function constraintsFor(testCase, workspace, externalEmailAllowed) {
  return [
    `모든 로컬 파일 작업은 ${workspace} 내부`,
    '테스트 입력 이외의 사용자 자료 접근 금지',
    '산출물은 파일 형식과 내용 근거로 검증',
    externalEmailAllowed
      ? '외부 커밋은 exact hash-bound attachment를 사용한 recipientMode=self Gmail 1회만 허용'
      : '모든 외부 전송과 외부 커밋 금지'
  ];
}

function buildCaseEnvironment({ caseRoot, workspace, externalEmailAllowed }) {
  const env = {
    ...process.env,
    JARVIS_BROWSER_DRIVER: '1',
    JARVIS_LLM_PLANNER: '1',
    JARVIS_LLM_CONTENT: '1',
    JARVIS_LLM_PLANNER_TIMEOUT_MS: '90000',
    JARVIS_MISSION_TIMEOUT_MS: '180000',
    JARVIS_MISSION_RETRY_TIMEOUT_MS: '60000',
    JARVIS_MISSION_MAX_ACTIONS_PER_WAVE: '8',
    JARVIS_INTENT_CACHE_PATH: join(caseRoot, 'intent-cache.jsonl'),
    JARVIS_PLAN_CACHE_PATH: join(caseRoot, 'plan-cache.jsonl'),
    JARVIS_BACKUP_DIR: join(workspace, '.jarvis-backups')
  };
  if (!externalEmailAllowed) {
    delete env.JARVIS_SMTP_USER;
    delete env.JARVIS_SMTP_PASS;
    delete env.JARVIS_SMTP_SERVICE;
  }
  return env;
}

function applyEnvironment(env) {
  for (const key of SENSITIVE_ENV_KEYS) {
    if (Object.hasOwn(env, key)) process.env[key] = env[key];
    else delete process.env[key];
  }
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, Object.hasOwn(process.env, key)
    ? { present: true, value: process.env[key] }
    : { present: false, value: null }]));
}

function restoreEnvironment(snapshot) {
  for (const [key, record] of Object.entries(snapshot)) {
    if (record.present) process.env[key] = record.value;
    else delete process.env[key];
  }
}

async function materializeInputs(workspace, inputs) {
  const manifest = {};
  for (const [inputPath, inputValue] of Object.entries(inputs)) {
    const absolutePath = safeResolveInside(workspace, inputPath);
    const bytes = inputBytes(inputValue);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    manifest[inputPath.replaceAll('\\', '/')] = {
      size: bytes.length,
      sha256: sha256(bytes)
    };
  }
  return manifest;
}

function inputBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value && typeof value === 'object' && typeof value.base64 === 'string') {
    return Buffer.from(value.base64, 'base64');
  }
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

async function inventory(root, subdirectory = '') {
  const output = [];
  if (!(await pathExists(root))) return output;
  const entries = await readdir(join(root, subdirectory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = join(subdirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.jarvis-backups') output.push(...await inventory(root, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(root, relativePath));
    output.push({
      path: relativePath.replaceAll('\\', '/'),
      size: bytes.length,
      sha256: sha256(bytes)
    });
  }
  return output;
}

export async function inventoryWorkspace(root) {
  return inventory(root);
}

function inspectZip(file) {
  const script = String.raw`
import json, math, re, sys, zipfile, xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
payload = {'valid': False, 'entries': [], 'text': '', 'sheets': [], 'workbookTables': [], 'error': None}
try:
    with zipfile.ZipFile(path) as archive:
        payload['valid'] = archive.testzip() is None
        payload['entries'] = archive.namelist()
        if 'xl/workbook.xml' in payload['entries']:
            workbook_root = ET.fromstring(archive.read('xl/workbook.xml'))
            payload['sheets'] = [
                element.attrib.get('name')
                for element in workbook_root.iter()
                if element.tag.rsplit('}', 1)[-1] == 'sheet' and element.attrib.get('name')
            ]
        shared_strings = []
        if 'xl/sharedStrings.xml' in payload['entries']:
            shared_root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            for item in shared_root.iter():
                if item.tag.rsplit('}', 1)[-1] == 'si':
                    shared_strings.append(''.join(item.itertext()))
        chunks = []
        for name in payload['entries']:
            if not name.lower().endswith(('.xml', '.rels')):
                continue
            try:
                root = ET.fromstring(archive.read(name))
                chunks.extend(text for text in root.itertext() if text)
                for element in root.iter():
                    chunks.extend(str(value) for value in element.attrib.values())
                worksheet_match = re.fullmatch(r'xl/worksheets/sheet(\d+)\.xml', name, re.IGNORECASE)
                if worksheet_match:
                    sheet_index = int(worksheet_match.group(1)) - 1
                    sheet_name = payload['sheets'][sheet_index] if 0 <= sheet_index < len(payload['sheets']) else name
                    headers = []
                    numeric_cells = []
                    numeric_columns = {}
                    for cell in root.iter():
                        if cell.tag.rsplit('}', 1)[-1] != 'c':
                            continue
                        reference = cell.attrib.get('r', '')
                        reference_match = re.fullmatch(r'([A-Z]+)(\d+)', reference, re.IGNORECASE)
                        if not reference_match:
                            continue
                        column, row_number = reference_match.group(1).upper(), int(reference_match.group(2))
                        cell_type = cell.attrib.get('t', '')
                        value_element = next((child for child in cell if child.tag.rsplit('}', 1)[-1] == 'v'), None)
                        if cell_type == 'inlineStr':
                            value = ''.join(
                                text_element.text or ''
                                for text_element in cell.iter()
                                if text_element.tag.rsplit('}', 1)[-1] == 't'
                            )
                        elif cell_type == 's' and value_element is not None:
                            try:
                                value = shared_strings[int(value_element.text)]
                            except Exception:
                                value = ''
                        else:
                            value = value_element.text if value_element is not None else ''
                        if row_number == 1:
                            headers.append({'column': column, 'value': value})
                        if cell_type in ('', 'n') and value:
                            try:
                                numeric_value = float(value)
                                if math.isfinite(numeric_value):
                                    numeric_cells.append({
                                        'reference': reference,
                                        'column': column,
                                        'row': row_number,
                                        'rawValue': value,
                                        'value': numeric_value
                                    })
                                    if row_number > 1:
                                        numeric_columns.setdefault(column, []).append(numeric_value)
                            except Exception:
                                pass
                    payload['workbookTables'].append({
                        'entry': name,
                        'sheetName': sheet_name,
                        'headers': headers,
                        'numericCells': numeric_cells,
                        'numericColumns': [
                            {'column': column, 'values': values, 'sum': sum(values)}
                            for column, values in sorted(numeric_columns.items())
                        ]
                    })
            except Exception:
                pass
        payload['text'] = '\n'.join(chunks)
except Exception as error:
    payload['error'] = f'{type(error).__name__}: {error}'
print(json.dumps(payload, ensure_ascii=False))
`;
  const result = spawnSync('python', ['-c', script, file], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000
  });
  if (result.status !== 0) {
    return {
      valid: false,
      entries: [],
      sheets: [],
      text: '',
      error: String(result.stderr || result.error?.message || `python exited ${result.status}`).trim()
    };
  }
  try {
    return JSON.parse(String(result.stdout).trim().split(/\r?\n/u).at(-1) ?? '{}');
  } catch (caught) {
    return { valid: false, entries: [], sheets: [], text: '', error: caught.message };
  }
}

function collectNestedObjects(value, maxDepth = 12) {
  const output = [];
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (!item || typeof item !== 'object' || depth > maxDepth || seen.has(item)) return;
    seen.add(item);
    output.push(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return output;
}

function missionActions(mission) {
  return (mission?.waves ?? []).flatMap((wave) => wave.actions ?? []);
}

function compactTask(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    rawText: task.request?.rawText,
    intent: task.intent,
    plan: task.plan,
    route: task.route,
    policy: task.policy,
    approvalCard: task.approvalCard,
    execution: task.executionResult,
    executionVerification: task.executionVerification,
    verification: task.verification,
    error: task.error
  };
}

function normalizeFileSpec(value) {
  if (typeof value === 'string') return { path: value, type: inferType(value), contains: [], absent: [], mustBeAbsent: false };
  return {
    ...value,
    path: String(value?.path ?? ''),
    type: String(value?.type ?? inferType(value?.path)).toLowerCase(),
    contains: Array.isArray(value?.contains) ? value.contains : [],
    absent: Array.isArray(value?.absent) ? value.absent : [],
    mustBeAbsent: value?.absent === true
  };
}

function inferType(path) {
  return extname(String(path ?? '')).slice(1).toLowerCase() || 'text';
}

function containsText(haystack, needle) {
  const source = normalizeComparableText(haystack);
  const target = normalizeComparableText(needle);
  if (!target) return false;
  if (source.includes(target)) return true;
  return source.replace(/(?<=\d),(?=\d)/gu, '').includes(target.replace(/(?<=\d),(?=\d)/gu, ''));
}

const LABEL_COUNT_SUPPLEMENTS = ['식단', '수량', '인원', '건수', '개수'];
const LABEL_COUNT_UNITS = ['명', '개', '건', '회', '대', '권', '장', '곳', '팀'];

function matchCommandedLabelCountNotation(searchableText, needle, command) {
  const target = normalizeComparableText(needle).trim();
  const parsed = target.match(/^(?<label>[\p{L}][\p{L}\p{N} \t\u00a0]{0,39}?)\s+(?<count>\d{1,12})(?<unit>명|개|건|회|대|권|장|곳|팀)?$/u);
  if (!parsed?.groups || !containsText(command, `${parsed.groups.label.trim()} ${parsed.groups.count}${parsed.groups.unit ?? ''}`)) {
    return null;
  }

  const escapePattern = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const labelPattern = escapePattern(parsed.groups.label.trim()).replace(/[ \t\u00a0]+/gu, '[ \\t\\u00a0]+');
  const supplementPattern = LABEL_COUNT_SUPPLEMENTS.map(escapePattern).join('|');
  const unitPattern = parsed.groups.unit
    ? escapePattern(parsed.groups.unit)
    : `(?:${LABEL_COUNT_UNITS.map(escapePattern).join('|')})?`;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${labelPattern}(?<supplement>[ \\t\\u00a0]*(?:${supplementPattern}))?`
      + `[ \\t\\u00a0]*(?:[:：=·\\-–—][ \\t\\u00a0]*)?${escapePattern(parsed.groups.count)}`
      + `(?![\\d.,])[ \\t\\u00a0]*(?<unit>${unitPattern})(?![\\p{L}\\p{N}])`,
    'u'
  );
  const match = pattern.exec(normalizeComparableText(searchableText).replace(/(?<=\d),(?=\d)/gu, ''));
  if (!match) return null;
  return {
    matchMode: 'commanded-label-count-notation',
    matchedLabel: parsed.groups.label.trim(),
    matchedCount: parsed.groups.count,
    labelSupplement: match.groups?.supplement?.trim() || null,
    countUnit: match.groups?.unit || null
  };
}

export function evaluateExpectedContentMatch({ searchableText = '', needle, type, zipInspection, command = '' } = {}) {
  if (containsText(searchableText, needle)) {
    return { pass: true, details: { matchMode: 'literal-content' } };
  }
  if (type === 'hwpx') {
    const notationMatch = matchCommandedLabelCountNotation(searchableText, needle, command);
    if (notationMatch) return { pass: true, details: notationMatch };
  }
  if (type !== 'xlsx') {
    return { pass: false, details: { matchMode: 'missing' } };
  }

  const expectedCellLiteral = parseUnambiguousFiniteNumericLiteral(needle);
  const workbookTables = Array.isArray(zipInspection?.workbookTables) ? zipInspection.workbookTables : [];
  const numericCellMatches = expectedCellLiteral === null ? [] : workbookTables.flatMap((table) => (
    (Array.isArray(table?.numericCells) ? table.numericCells : [])
      .map((cell) => ({
        cell,
        canonicalValue: canonicalizeFiniteDecimal(cell?.rawValue, { allowExponent: true })
      }))
      .filter(({ cell, canonicalValue }) => (
        typeof cell?.value === 'number'
        && Number.isFinite(cell.value)
        && typeof cell?.rawValue === 'string'
        && canonicalValue !== null
        && canonicalValue === expectedCellLiteral.canonicalValue
      ))
      .map(({ cell }) => ({
        sheetName: table?.sheetName ?? null,
        reference: cell.reference ?? null,
        rawValue: cell.rawValue,
        value: cell.value
      }))
  ));
  if (numericCellMatches.length > 0) {
    return {
      pass: true,
      details: {
        matchMode: 'xlsx-numeric-cell-equivalent',
        expectedNumericValue: expectedCellLiteral.numericValue,
        expectedCanonicalValue: expectedCellLiteral.canonicalValue,
        numericCellMatches
      }
    };
  }

  const expectedNumber = parseStrictExpectedNumber(needle);
  if (expectedNumber === null || !commandRequestsAggregateValue(command, needle)) {
    return {
      pass: false,
      details: {
        matchMode: 'missing',
        derivedAggregateEligible: false
      }
    };
  }

  const tolerance = Math.max(1e-9, Math.abs(expectedNumber) * 1e-9);
  const matches = workbookTables.flatMap((table) => (
    (table.numericColumns ?? [])
      .filter((column) => (
        Array.isArray(column.values)
        && column.values.length >= 2
        && Math.abs(Number(column.sum) - expectedNumber) <= tolerance
      ))
      .map((column) => ({
        sheetName: table.sheetName,
        column: column.column,
        values: column.values,
        sum: column.sum
      }))
  ));
  return {
    pass: matches.length > 0,
    details: {
      matchMode: matches.length > 0 ? 'derived-workbook-column-sum' : 'missing',
      derivedAggregateEligible: true,
      expectedAggregate: expectedNumber,
      aggregateMatches: matches
    }
  };
}

export function workbookHeaderQuality(workbookTables = []) {
  const normalizedTables = Array.isArray(workbookTables) ? workbookTables : [];
  const invalidHeaders = normalizedTables.flatMap((table) => {
    const headers = Array.isArray(table?.headers) ? table.headers : [];
    if (headers.length === 0) {
      return [{ sheetName: table?.sheetName ?? null, column: null, value: null, reason: 'missing-header-row' }];
    }
    return headers
      .map((header) => ({
        sheetName: table?.sheetName ?? null,
        column: header?.column ?? null,
        value: String(header?.value ?? '').trim()
      }))
      .filter((header) => !header.value || /^\[object\s+Object\]$/iu.test(header.value))
      .map((header) => ({
        ...header,
        reason: header.value ? 'object-stringification-placeholder' : 'empty-header'
      }));
  });
  return {
    pass: normalizedTables.length > 0 && invalidHeaders.length === 0,
    workbookTables: normalizedTables,
    invalidHeaders
  };
}

function parseUnambiguousFiniteNumericLiteral(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized)) return null;
  const unsigned = normalized.replace(/^[+-]/u, '');
  const integerPart = unsigned.split('.', 1)[0];
  if (integerPart.length > 1 && integerPart.startsWith('0')) return null;
  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) return null;
  const canonicalValue = canonicalizeFiniteDecimal(normalized);
  return canonicalValue === null ? null : { numericValue, canonicalValue };
}

function canonicalizeFiniteDecimal(value, { allowExponent = false } = {}) {
  const source = String(value ?? '').trim();
  const pattern = allowExponent
    ? /^(?<sign>[+-]?)(?<integer>\d+)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$/u
    : /^(?<sign>[+-]?)(?<integer>\d+)(?:\.(?<fraction>\d+))?$/u;
  const match = source.match(pattern);
  if (!match?.groups) return null;
  const exponent = Number(match.groups.exponent ?? 0) - (match.groups.fraction?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  let digits = `${match.groups.integer}${match.groups.fraction ?? ''}`.replace(/^0+/u, '');
  if (!digits) return '0e0';
  let normalizedExponent = exponent;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    normalizedExponent += 1;
  }
  const sign = match.groups.sign === '-' ? '-' : '';
  return `${sign}${digits}e${normalizedExponent}`;
}

function parseStrictExpectedNumber(value) {
  return parseUnambiguousFiniteNumericLiteral(String(value ?? '').trim().replaceAll(',', ''))?.numericValue ?? null;
}

function commandRequestsAggregateValue(command, expectedValue) {
  const normalizedExpected = String(expectedValue ?? '').trim().replaceAll(',', '');
  const numberText = normalizedExpected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `(?:총(?:계|액)?|전체(?:\\s*합계)?|합계)[^\\d+.\\-]{0,16}(?<![\\d.])${numberText}(?![\\d.])`,
    'iu'
  ).test(String(command ?? '').replace(/(?<=\d),(?=\d)/gu, ''));
}

function parseCsv(value) {
  const text = String(value ?? '').replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) return { rows, error: 'unterminated-quoted-field' };
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ''));
    rows.push(row);
  }
  return { rows: rows.filter((item) => item.some((cell) => cell.length > 0)), error: null };
}

function normalizeComparableText(value) {
  return String(value ?? '').normalize('NFC').replace(/\r\n/g, '\n');
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const normalize = (items) => [...new Set(items.map((item) => String(item).normalize('NFC')))].sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function sameStringMultiset(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const normalize = (items) => items.map((item) => String(item).normalize('NFC')).sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

export function normalizeNewsItemsEvidence(value) {
  const inputType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const seen = new WeakSet();
  const invalid = (reason, shape = inputType) => ({
    valid: false,
    items: [],
    inputType,
    shape,
    reason
  });
  const visit = (candidate, depth = 0, shape = inputType) => {
    if (depth > 5) return invalid('collection-depth-exceeded', shape);
    if (Array.isArray(candidate)) {
      if (!candidate.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        return invalid('news-items-must-be-objects', shape);
      }
      return { valid: true, items: candidate, inputType, shape, reason: null };
    }
    if (!candidate || typeof candidate !== 'object') {
      return invalid('expected-object-or-array', shape);
    }
    if (seen.has(candidate)) return invalid('cyclic-object', shape);
    seen.add(candidate);
    for (const key of ['items', 'values', 'articles', 'newsItems']) {
      if (Object.hasOwn(candidate, key)) {
        return visit(candidate[key], depth + 1, `${shape}.${key}`);
      }
    }
    const keys = Object.keys(candidate);
    if (keys.length > 0 && keys.every((key) => /^\d+$/u.test(key))) {
      const ordered = keys.sort((left, right) => Number(left) - Number(right)).map((key) => candidate[key]);
      return visit(ordered, depth + 1, `${shape}.numeric-values`);
    }
    return invalid('unsupported-object-shape', shape);
  };
  return visit(value);
}

export function normalizeEmailAttachmentHashEvidence(value) {
  const inputType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const seen = new WeakSet();
  const invalid = (reason, shape = inputType) => ({
    valid: false,
    hashes: [],
    inputType,
    shape,
    reason
  });
  const normalizeHash = (item) => {
    const hash = String(item ?? '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(hash) ? hash : null;
  };
  const visit = (candidate, depth = 0, shape = inputType) => {
    if (depth > 5) return invalid('collection-depth-exceeded', shape);
    if (Array.isArray(candidate)) {
      const hashes = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const item = candidate[index];
        const directHash = typeof item === 'string' ? normalizeHash(item) : null;
        if (directHash) {
          hashes.push(directHash);
          continue;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const hashValue = item.attachmentSha256 ?? item.sha256 ?? item.contentSha256;
          const objectHash = normalizeHash(hashValue);
          if (objectHash) {
            hashes.push(objectHash);
            continue;
          }
        }
        return invalid(`invalid-hash-at-index-${index}`, shape);
      }
      return { valid: true, hashes, inputType, shape, reason: null };
    }
    if (!candidate || typeof candidate !== 'object') {
      return invalid('expected-object-or-array', shape);
    }
    if (seen.has(candidate)) return invalid('cyclic-object', shape);
    seen.add(candidate);
    for (const key of ['attachmentSha256s', 'sha256s', 'hashes', 'items', 'values']) {
      if (Object.hasOwn(candidate, key)) {
        return visit(candidate[key], depth + 1, `${shape}.${key}`);
      }
    }
    const singleHash = candidate.attachmentSha256 ?? candidate.sha256 ?? candidate.contentSha256;
    if (singleHash !== undefined) return visit([singleHash], depth + 1, `${shape}.single-hash`);
    const keys = Object.keys(candidate);
    if (keys.length > 0 && keys.every((key) => /^\d+$/u.test(key))) {
      const ordered = keys.sort((left, right) => Number(left) - Number(right)).map((key) => candidate[key]);
      return visit(ordered, depth + 1, `${shape}.numeric-values`);
    }
    return invalid('unsupported-object-shape', shape);
  };
  return visit(value);
}

function urlDomain(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim().replace(/[.,;:!?]+$/u, ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
    return url.href;
  } catch {
    return null;
  }
}

function normalizeDirectReadResourceIdentity(value) {
  try {
    const url = new URL(String(value ?? '').trim().replace(/[.,;:!?]+$/u, ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : '/';
    return `https://${url.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function normalizeCitationUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim().replace(/[.,;:!?]+$/u, ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
    return url.href;
  } catch {
    return null;
  }
}

function extractUrls(value) {
  return [...new Set((String(value ?? '').match(/https?:\/\/[^\s<>"'()\[\]]+/giu) ?? [])
    .map((item) => item.replace(/[.,;:!?]+$/u, ''))
    .filter((item) => normalizeComparableUrl(item)))];
}

function timestampIsRecent(value, maxAgeMinutes = 30, referenceTimestampMs = Date.now()) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = referenceTimestampMs - timestamp;
  return ageMs >= -5 * 60_000 && ageMs <= maxAgeMinutes * 60_000;
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value;
  return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')}`;
}

function normalizeArchiveEntry(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertion(check, pass, details = {}) {
  return { check, pass: pass === true, details };
}

function isExternalEmailCase(testCase) {
  return testCase.allowExternalSend === true && Boolean(testCase.expected?.email);
}

function validateCorpus(items) {
  if (!Array.isArray(items) || items.length !== 50) {
    throw new Error(`complex-workflow-50-cases.mjs must export exactly 50 cases; received ${items?.length ?? 'non-array'}`);
  }
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new Error('Every corpus case must be an object.');
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(String(item.id ?? ''))) throw new Error(`Unsafe or missing case id: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`Duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (!item.title || !item.category || !item.command) throw new Error(`Case ${item.id} is missing title, category, or command.`);
    if (!['COMPLETED', 'EXPECTED_STOP'].includes(item.expected?.status)) throw new Error(`Case ${item.id} has an unsupported expected.status.`);
    if (!Array.isArray(item.expected?.files)) throw new Error(`Case ${item.id} expected.files must be an array.`);
    for (const rawSpec of item.expected.files) {
      const spec = normalizeFileSpec(rawSpec);
      if (!spec.path) throw new Error(`Case ${item.id} has an output without a path.`);
      if (!['text', 'txt', 'md', 'csv', 'json', 'html', 'xlsx', 'docx', 'pptx', 'hwpx', 'png', 'zip'].includes(spec.type)) {
        throw new Error(`Case ${item.id} has unsupported file type ${spec.type}.`);
      }
    }
    if (item.allowExternalSend === true && !item.expected.email) {
      throw new Error(`Case ${item.id} enables external send without expected.email.`);
    }
    if (item.expected?.email) {
      const email = item.expected.email;
      if (item.allowExternalSend !== true) throw new Error(`Case ${item.id} expects email without allowExternalSend.`);
      if (!Array.isArray(email.attachmentPaths) || email.attachmentPaths.length !== Number(email.attachmentCount)) {
        throw new Error(`Case ${item.id} email attachmentPaths must exactly match attachmentCount.`);
      }
      if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(String(email.idempotencyKey ?? ''))) {
        throw new Error(`Case ${item.id} email idempotencyKey is missing or invalid.`);
      }
    }
  }
}

function selectCases(allCases, requestedIds) {
  if (requestedIds.length === 0) return [...allCases];
  const byId = new Map(allCases.map((item) => [item.id, item]));
  const unknown = requestedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown --cases id(s): ${unknown.join(', ')}`);
  return requestedIds.map((id) => byId.get(id));
}

function parseArguments(argv) {
  const valueFor = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value;
  };
  const casesValue = valueFor('--cases');
  return {
    caseIds: casesValue ? [...new Set(casesValue.split(',').map((item) => item.trim()).filter(Boolean))] : [],
    root: valueFor('--root'),
    correctionSet: valueFor('--correction-set'),
    resume: argv.includes('--resume')
  };
}

export function createComplexWorkflowCorpusFingerprint(selected) {
  const canonicalCases = selected.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    command: item.command,
    inputManifest: Object.fromEntries(Object.entries(item.inputs ?? {}).map(([path, value]) => {
      const bytes = inputBytes(value);
      return [path, { size: bytes.length, sha256: sha256(bytes) }];
    })),
    expected: item.expected,
    allowExternalSend: item.allowExternalSend === true,
    ...(item.correction ? { correction: item.correction } : {})
  }));
  const canonicalPayload = { runnerVersion: RUNNER_VERSION, cases: canonicalCases };
  const corpusSha256 = sha256(Buffer.from(stableStringify(canonicalPayload), 'utf8'));
  return { canonicalCases, corpusSha256 };
}

async function writeCorpus(root, selected, totalCaseCount, resume = false, correctionSet = null) {
  const { canonicalCases, corpusSha256 } = createComplexWorkflowCorpusFingerprint(selected);
  const corpusPath = join(root, 'corpus.json');
  const digestPath = join(root, 'corpus.sha256');
  if (resume && await pathExists(corpusPath)) {
    const existingBytes = await readFile(corpusPath);
    const existing = JSON.parse(existingBytes.toString('utf8'));
    if (existing?.corpusSha256 !== corpusSha256) {
      throw new Error('AUDIT_CORPUS_MISMATCH: the saved corpus does not match the requested cases; choose a new --root.');
    }
    if (stableStringify(existing?.correctionSet ?? null) !== stableStringify(correctionSet)) {
      throw new Error('AUDIT_CORRECTION_MISMATCH: the saved correction set does not match this run.');
    }
    const corpusFileSha256 = sha256(existingBytes);
    if (await pathExists(digestPath)) {
      const recordedDigest = String(await readFile(digestPath, 'utf8')).trim().split(/\s+/u)[0];
      if (recordedDigest && recordedDigest !== corpusFileSha256) {
        throw new Error('AUDIT_CORPUS_TAMPERED: corpus.json does not match corpus.sha256.');
      }
    }
    return { corpusSha256, corpusFileSha256, correctionSet };
  }
  const document = redactSecrets({
    corpusVersion: RUNNER_VERSION,
    generatedAt: new Date().toISOString(),
    totalCaseCount,
    selectedCaseCount: selected.length,
    corpusSha256,
    ...(correctionSet ? { correctionSet } : {}),
    cases: canonicalCases
  });
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const corpusFileSha256 = sha256(Buffer.from(serialized, 'utf8'));
  await atomicWriteText(corpusPath, serialized);
  await atomicWriteText(digestPath, `${corpusFileSha256}  corpus.json\n`);
  return { corpusSha256, corpusFileSha256, correctionSet };
}

async function writeSummary(root, results, selected, corpusMetadata, runOptions) {
  const counts = { SUCCESS: 0, EXPECTED_STOP: 0, PARTIAL: 0, FAILED: 0 };
  for (const result of results) {
    const key = Object.hasOwn(counts, result.outcome) ? result.outcome : 'FAILED';
    counts[key] += 1;
  }
  const summary = redactSecrets({
    summaryVersion: RUNNER_VERSION,
    updatedAt: new Date().toISOString(),
    runRoot: root,
    corpusSha256: corpusMetadata.corpusSha256,
    corpusFileSha256: corpusMetadata.corpusFileSha256,
    ...(corpusMetadata.correctionSet ? { correctionSet: corpusMetadata.correctionSet } : {}),
    selectedCaseCount: selected.length,
    completedResultCount: results.length,
    pendingCaseIds: selected.filter((item) => !results.some((result) => result.id === item.id)).map((item) => item.id),
    counts,
    allExpectedOutcomesPassed: results.length === selected.length
      && counts.PARTIAL === 0
      && counts.FAILED === 0,
    resumeMode: runOptions.resume,
    results: results.map((result) => ({
      id: result.id,
      title: result.title,
      category: result.category,
      outcome: result.outcome,
      missionStatus: result.missionStatus,
      durationMs: result.durationMs,
      failedAssertions: (result.assertions ?? []).filter((item) => item.pass !== true).map((item) => item.check),
      resultPath: `${result.id}/result.json`
    }))
  });
  await atomicWriteJson(join(root, 'summary.json'), summary);
}

async function readExistingResult(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed?.id && parsed?.outcome ? parsed : null;
  } catch {
    return null;
  }
}

function failedSetupResult(testCase, error) {
  return redactSecrets({
    resultVersion: RUNNER_VERSION,
    id: testCase.id,
    title: testCase.title,
    category: testCase.category,
    command: testCase.command,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    expectedStatus: testCase.expected?.status ?? null,
    outcome: 'FAILED',
    missionStatus: null,
    stopReason: error.code,
    assertions: [assertion('case setup completed', false, { error })],
    artifacts: [],
    inputManifest: {},
    externalSendPolicy: {
      allowed: isExternalEmailCase(testCase),
      recipientMode: isExternalEmailCase(testCase) ? 'self' : null,
      arbitraryRecipientsAllowed: false,
      manualApprovalAttempted: false
    },
    error
  });
}

function compactForStableJson(value) {
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(compactForStableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, compactForStableJson(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(compactForStableJson(value));
}

function redactSecrets(value, key = '', seen = new WeakMap()) {
  const sensitiveKey = /^(?:password|passwordHash|secret|apiKey|accessToken|rawToken|authorizationToken|signingSecret|smtpPass|credential|credentials|cookie|cookies|idempotencyKey|ownerSessionId)$/iu;
  if (sensitiveKey.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  if (Array.isArray(value)) {
    for (const item of value) output.push(redactSecrets(item, key, seen));
  } else {
    for (const [childKey, child] of Object.entries(value)) {
      output[childKey] = redactSecrets(child, childKey, seen);
    }
  }
  return output;
}

function redactString(value) {
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted-email]')
    .replace(/(?:bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|token|api_key|apikey|key|auth|signature)=)[^&#\s]+/giu, '$1[redacted]')
    .replace(/((?:password|pass|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]');
}

function normalizeError(error) {
  return redactSecrets({
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  });
}

function safeResolveInside(root, child) {
  const base = resolve(root);
  const candidate = isAbsolute(String(child ?? '')) ? resolve(String(child)) : resolve(base, String(child ?? ''));
  const rel = relative(base, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return candidate;
  throw new Error(`Path escapes isolated root: ${child}`);
}

async function pathExists(path) {
  return stat(path).then(() => true, () => false);
}

async function atomicWriteJson(path, value) {
  await atomicWriteText(path, `${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

async function atomicWriteText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
