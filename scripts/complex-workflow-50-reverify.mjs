import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  COMPLEX_WORKFLOW_50_AUDIT_VERSION,
  classifyCaseVerification,
  createComplexWorkflowCorpusFingerprint,
  verifyCase
} from './complex-workflow-50-audit.mjs';
import { cases } from './complex-workflow-50-cases.mjs';
import { applyComplexWorkflowCorrectionSet } from './complex-workflow-50-corrections.mjs';

export const REVERIFICATION_VALIDATOR_VERSION = 'jarvis-complex-workflow-50-reverify-v1';

const CASE_RESULT_NAME = 'result-reverified.json';
const SUMMARY_NAME = 'reverification-summary.json';

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/complex-workflow-50-reverify.mjs --root <run-root> --cases <id,id,...> [--correction-set <id>]');
    return null;
  }
  const summary = await reverifyRun(options);
  console.log(`REVERIFICATION_ROOT ${summary.sourceRun.root}`);
  console.log(`REVERIFIED_CASES ${summary.selectedCaseIds.join(',')}`);
  for (const item of summary.results) {
    console.log(`REVERIFIED ${item.id} ${item.originalOutcome ?? 'UNKNOWN'} -> ${item.outcome}`);
  }
  console.log(`REVERIFICATION_SUMMARY ${join(summary.sourceRun.root, summary.outputFiles.summaryPath)}`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function reverifyRun({ root, caseIds, correctionSet = null, now = () => new Date() } = {}) {
  if (!root) throw codedError('REVERIFY_ROOT_REQUIRED', '--root is required.');
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw codedError('REVERIFY_CASES_REQUIRED', '--cases must name at least one case.');
  }

  const startedAt = now().toISOString();
  const timerStartedAt = performance.now();
  const runRoot = resolve(root);
  const rootBoundary = await inspectDirectoryBoundary(runRoot, null, 'run root');
  const corpusEvidence = await verifySavedCorpus(runRoot);
  const currentById = new Map(cases.map((item) => [item.id, item]));
  const savedCaseIds = corpusEvidence.document.cases.map((item) => String(item.id));
  const savedCaseIdSet = new Set(savedCaseIds);
  const currentRootCases = savedCaseIds.map((id) => {
    const current = currentById.get(id);
    if (!current) throw codedError('REVERIFY_CURRENT_CASE_MISSING', `Saved corpus case ${id} is absent from the current corpus.`);
    return current;
  });
  const baseFingerprint = createComplexWorkflowCorpusFingerprint(currentRootCases);
  const savedCorrection = corpusEvidence.document.correctionSet ?? null;
  let sourceCases = currentRootCases;
  let sourceFingerprint = baseFingerprint;
  let sourceCorrectionApplied = false;
  let correctionApplication;

  if (savedCorrection !== null) {
    if (!savedCorrection || typeof savedCorrection !== 'object' || Array.isArray(savedCorrection)
        || typeof savedCorrection.setId !== 'string' || !savedCorrection.setId.trim()) {
      throw codedError('REVERIFY_CORRECTION_METADATA_INVALID', 'Saved corpus correctionSet metadata is invalid.');
    }
    if (correctionSet && correctionSet !== savedCorrection.setId) {
      throw codedError(
        'REVERIFY_CORRECTION_SET_MISMATCH',
        `Requested correction set ${correctionSet} does not match saved source correction ${savedCorrection.setId}.`
      );
    }
    try {
      correctionApplication = applyComplexWorkflowCorrectionSet(currentRootCases, savedCorrection.setId);
    } catch (error) {
      throw codedError(
        'REVERIFY_SOURCE_CORRECTION_INVALID',
        `Saved correction ${savedCorrection.setId} cannot be reproduced from the current base corpus: ${error.code ?? error.message}`
      );
    }
    if (!sameStableValue(savedCorrection, correctionApplication.metadata)) {
      throw codedError(
        'REVERIFY_CORRECTION_METADATA_MISMATCH',
        'Saved corpus correctionSet metadata does not match the current correction definition.'
      );
    }
    sourceCases = correctionApplication.cases;
    sourceFingerprint = createComplexWorkflowCorpusFingerprint(sourceCases);
    sourceCorrectionApplied = true;
  } else {
    correctionApplication = null;
  }

  if (sourceFingerprint.corpusSha256 !== corpusEvidence.document.corpusSha256) {
    throw codedError(
      'REVERIFY_CORPUS_MISMATCH',
      'The saved corpus hash does not match the current corpus definitions for this source run.'
    );
  }
  if (corpusEvidence.document.corpusVersion !== COMPLEX_WORKFLOW_50_AUDIT_VERSION) {
    throw codedError(
      'REVERIFY_CORPUS_VERSION_MISMATCH',
      `Saved corpus version ${corpusEvidence.document.corpusVersion ?? 'missing'} does not match ${COMPLEX_WORKFLOW_50_AUDIT_VERSION}.`
    );
  }
  if (corpusEvidence.document.selectedCaseCount !== savedCaseIds.length) {
    throw codedError('REVERIFY_CORPUS_COUNT_MISMATCH', 'Saved corpus selectedCaseCount does not match its case list.');
  }

  const savedById = new Map(corpusEvidence.document.cases.map((item) => [String(item.id), item]));
  const sourceById = new Map(sourceCases.map((item) => [item.id, item]));
  for (const [index, sourceCase] of sourceCases.entries()) {
    const savedCase = corpusEvidence.document.cases[index];
    const canonicalCase = sourceFingerprint.canonicalCases[index];
    if (savedCase.command !== sourceCase.command) {
      throw codedError('REVERIFY_COMMAND_MISMATCH', `Case ${sourceCase.id} command differs from the saved source corpus.`);
    }
    if (!sameStableValue(savedCase.inputManifest ?? {}, canonicalCase.inputManifest ?? {})) {
      throw codedError('REVERIFY_INPUT_MANIFEST_MISMATCH', `Case ${sourceCase.id} input manifest differs from the current corpus.`);
    }
    if (!sameStableValue(savedCase, canonicalCase)) {
      throw codedError('REVERIFY_CASE_DEFINITION_MISMATCH', `Case ${sourceCase.id} definition differs from the current corpus.`);
    }
  }

  if (!sourceCorrectionApplied) {
    correctionApplication = applyComplexWorkflowCorrectionSet(currentRootCases, correctionSet);
  }

  // A base source receives a requested correction after its identity is proven.
  // A source already carrying authenticated correction metadata was reproduced
  // from the base corpus above and must not be corrected a second time.
  const verificationById = new Map(correctionApplication.cases.map((item) => [item.id, item]));
  const correctionSuffix = correctionApplication.metadata ? `-${correctionApplication.metadata.setId}` : '';
  const caseResultName = correctionApplication.metadata
    ? `result-reverified${correctionSuffix}.json`
    : CASE_RESULT_NAME;
  const summaryName = correctionApplication.metadata
    ? `reverification-summary${correctionSuffix}.json`
    : SUMMARY_NAME;

  const uniqueCaseIds = [...new Set(caseIds.map((item) => String(item).trim()).filter(Boolean))];
  if (uniqueCaseIds.length !== caseIds.length) {
    throw codedError('REVERIFY_DUPLICATE_CASE', '--cases must not contain duplicate or empty case ids.');
  }
  for (const id of uniqueCaseIds) {
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(id)) throw codedError('REVERIFY_UNSAFE_CASE_ID', `Unsafe case id: ${id}`);
    if (!savedCaseIdSet.has(id)) throw codedError('REVERIFY_CASE_NOT_IN_SOURCE_RUN', `Case ${id} is not part of the saved source run.`);
  }
  const effectiveCorrectionSet = correctionApplication.metadata?.setId ?? null;
  const selectedCorrectionCaseIds = uniqueCaseIds.filter((id) => verificationById.get(id)?.correction?.setId === effectiveCorrectionSet);
  if (correctionApplication.metadata && selectedCorrectionCaseIds.length === 0) {
    throw codedError(
      'REVERIFY_CORRECTION_NOT_SELECTED',
      `Correction set ${effectiveCorrectionSet} does not apply to any selected case.`
    );
  }

  // Complete every trust and boundary check before producing any output file.
  const prepared = [];
  for (const id of uniqueCaseIds) {
    const baseTestCase = sourceById.get(id);
    const testCase = verificationById.get(id);
    const savedCase = savedById.get(id);
    const caseRoot = resolveInside(runRoot, id);
    const caseBoundary = await inspectDirectoryBoundary(caseRoot, rootBoundary.realPath, `case ${id} root`);
    const workspace = resolveInside(caseRoot, 'workspace');
    const workspaceBoundary = await inspectDirectoryBoundary(workspace, caseBoundary.realPath, `case ${id} workspace`);
    validateCasePaths(testCase, workspace);

    const resultPath = resolveInside(caseRoot, 'result.json');
    const resultFile = await readRegularFile(resultPath, caseBoundary.realPath, `case ${id} result.json`);
    const originalResult = parseJson(resultFile.bytes, `case ${id} result.json`);
    validateSourceResult({ id, testCase: baseTestCase, savedCase, originalResult });
    const artifactsBefore = await secureWorkspaceInventory(workspace, workspaceBoundary.realPath);

    prepared.push({
      id,
      testCase,
      savedCase,
      caseRoot,
      workspace,
      workspaceBoundary,
      resultPath,
      originalResult,
      originalResultSha256: sha256(resultFile.bytes),
      artifactsBefore
    });
  }

  const reverifiedAt = now().toISOString();
  const reverifiedResults = [];
  for (const source of prepared) {
    const mission = source.originalResult.mission ?? null;
    const tasks = Array.isArray(source.originalResult.tasks) ? source.originalResult.tasks : [];
    const inputManifest = source.originalResult.inputManifest ?? {};
    let assertions;
    try {
      assertions = await verifyCase(
        source.testCase,
        source.workspace,
        inputManifest,
        mission,
        tasks,
        { referenceTime: source.originalResult.finishedAt ?? source.originalResult.startedAt ?? reverifiedAt }
      );
    } catch (error) {
      assertions = [createAssertion('independent reverification completed', false, {
        error: normalizeError(error)
      }, 'REVERIFY_VALIDATOR_ERROR')];
    }

    const artifacts = await secureWorkspaceInventory(source.workspace, source.workspaceBoundary.realPath);
    const workspaceStable = sameStableValue(source.artifactsBefore, artifacts);
    const sourceMissionStatus = mission?.status ?? null;
    assertions.unshift(
      createAssertion('source result command and corpus identity were hash-verified', true, {
        caseId: source.id,
        corpusSha256: corpusEvidence.document.corpusSha256,
        originalResultSha256: source.originalResultSha256
      }, 'REVERIFY_SOURCE_IDENTITY'),
      createAssertion('workspace resolves inside the source case boundary without symbolic links', true, {
        workspace: source.workspace,
        realWorkspace: source.workspaceBoundary.realPath
      }, 'REVERIFY_WORKSPACE_BOUNDARY'),
      createAssertion('source mission status agrees with the result summary',
        sourceMissionStatus === (source.originalResult.missionStatus ?? null), {
          missionStatus: sourceMissionStatus,
          summarizedMissionStatus: source.originalResult.missionStatus ?? null
        }, 'REVERIFY_SOURCE_STATUS_CONSISTENCY')
    );
    assertions.push(createAssertion('workspace artifacts stayed byte-identical during reverification', workspaceStable, {
      beforeArtifactCount: source.artifactsBefore.length,
      afterArtifactCount: artifacts.length
    }, 'REVERIFY_WORKSPACE_IMMUTABLE'));

    const outcome = classifyCaseVerification(source.testCase, mission, assertions);
    reverifiedResults.push({
      resultVersion: REVERIFICATION_VALIDATOR_VERSION,
      validatorVersion: REVERIFICATION_VALIDATOR_VERSION,
      assertionEngineVersion: COMPLEX_WORKFLOW_50_AUDIT_VERSION,
      reverifiedAt,
      sourceRun: {
        root: runRoot,
        corpusPath: 'corpus.json',
        corpusSha256: corpusEvidence.document.corpusSha256,
        corpusFileSha256: corpusEvidence.fileSha256,
        resultPath: `${source.id}/result.json`,
        workspacePath: `${source.id}/workspace`
      },
      specificationCorrection: correctionApplication.metadata
        ? {
            ...correctionApplication.metadata,
            sourceCorpusSha256: corpusEvidence.document.corpusSha256,
            baseCorpusSha256: baseFingerprint.corpusSha256,
            sourceAlreadyCorrected: sourceCorrectionApplied,
            selectedAppliedCaseIds: selectedCorrectionCaseIds
          }
        : null,
      originalResultSha256: source.originalResultSha256,
      id: source.id,
      title: source.testCase.title,
      category: source.testCase.category,
      command: source.testCase.command,
      expectedStatus: source.testCase.expected?.status ?? null,
      originalOutcome: source.originalResult.outcome ?? null,
      outcome,
      outcomeChanged: outcome !== source.originalResult.outcome,
      missionStatus: sourceMissionStatus,
      stopReason: mission?.stopReason ?? source.originalResult.stopReason ?? null,
      assertions,
      artifacts,
      inputManifest,
      evidenceSource: {
        missionPresent: Boolean(mission && typeof mission === 'object'),
        taskCount: tasks.length,
        reusedOriginalAssertions: false,
        missionExecuted: false,
        externalCallsMade: false,
        emailActionsExecuted: false
      }
    });
  }

  // Re-read immutable source evidence after all validators finish. Any concurrent
  // mutation aborts the run before result-reverified.json is written.
  await assertSourceEvidenceUnchanged({ runRoot, corpusEvidence, prepared });

  const counts = { SUCCESS: 0, EXPECTED_STOP: 0, PARTIAL: 0, FAILED: 0 };
  for (const result of reverifiedResults) {
    const key = Object.hasOwn(counts, result.outcome) ? result.outcome : 'FAILED';
    counts[key] += 1;
  }
  const summary = {
    summaryVersion: REVERIFICATION_VALIDATOR_VERSION,
    validatorVersion: REVERIFICATION_VALIDATOR_VERSION,
    assertionEngineVersion: COMPLEX_WORKFLOW_50_AUDIT_VERSION,
    startedAt,
    reverifiedAt,
    durationMs: Math.round(performance.now() - timerStartedAt),
    sourceRun: {
      root: runRoot,
      corpusPath: 'corpus.json',
      corpusSha256: corpusEvidence.document.corpusSha256,
      corpusFileSha256: corpusEvidence.fileSha256
    },
    specificationCorrection: correctionApplication.metadata
      ? {
          ...correctionApplication.metadata,
          sourceCorpusSha256: corpusEvidence.document.corpusSha256,
          baseCorpusSha256: baseFingerprint.corpusSha256,
          sourceAlreadyCorrected: sourceCorrectionApplied,
          selectedAppliedCaseIds: selectedCorrectionCaseIds
        }
      : null,
    selectedCaseIds: uniqueCaseIds,
    counts,
    allExpectedOutcomesPassed: counts.PARTIAL === 0 && counts.FAILED === 0,
    executionPolicy: {
      sourceResultsReadOnly: true,
      missionExecuted: false,
      externalCallsMade: false,
      emailActionsExecuted: false
    },
    outputFiles: {
      summaryPath: summaryName,
      caseResultName
    },
    results: reverifiedResults.map((result) => ({
      id: result.id,
      title: result.title,
      originalOutcome: result.originalOutcome,
      outcome: result.outcome,
      outcomeChanged: result.outcomeChanged,
      missionStatus: result.missionStatus,
      originalResultSha256: result.originalResultSha256,
      failedAssertions: result.assertions.filter((item) => item.pass !== true).map((item) => item.check),
      resultPath: `${result.id}/${caseResultName}`
    }))
  };

  for (const result of reverifiedResults) {
    await atomicWriteJson(resolveInside(runRoot, result.id, caseResultName), result);
  }
  await atomicWriteJson(resolveInside(runRoot, summaryName), summary);

  // Prove that output writes beside the evidence did not touch the evidence files.
  await assertSourceEvidenceUnchanged({ runRoot, corpusEvidence, prepared });
  return summary;
}

function parseArguments(argv) {
  const options = { root: null, caseIds: [], correctionSet: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument !== '--root' && argument !== '--cases' && argument !== '--correction-set') {
      throw codedError('REVERIFY_UNKNOWN_ARGUMENT', `Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw codedError('REVERIFY_ARGUMENT_VALUE_REQUIRED', `${argument} requires a value.`);
    index += 1;
    if (argument === '--root') {
      if (options.root !== null) throw codedError('REVERIFY_DUPLICATE_ARGUMENT', '--root may be supplied only once.');
      options.root = value;
    } else if (argument === '--cases') {
      if (options.caseIds.length > 0) throw codedError('REVERIFY_DUPLICATE_ARGUMENT', '--cases may be supplied only once.');
      options.caseIds = value.split(',').map((item) => item.trim());
    } else {
      if (options.correctionSet !== null) throw codedError('REVERIFY_DUPLICATE_ARGUMENT', '--correction-set may be supplied only once.');
      options.correctionSet = value;
    }
  }
  return options;
}

async function verifySavedCorpus(runRoot) {
  const rootRealPath = await realpath(runRoot);
  const corpusPath = resolveInside(runRoot, 'corpus.json');
  const digestPath = resolveInside(runRoot, 'corpus.sha256');
  const [corpusFile, digestFile] = await Promise.all([
    readRegularFile(corpusPath, rootRealPath, 'corpus.json'),
    readRegularFile(digestPath, rootRealPath, 'corpus.sha256')
  ]);
  const fileSha256 = sha256(corpusFile.bytes);
  const digestText = digestFile.bytes.toString('utf8').trim();
  const digestMatch = digestText.match(/^([a-f0-9]{64})\s+corpus\.json$/iu);
  if (!digestMatch || digestMatch[1].toLowerCase() !== fileSha256) {
    throw codedError('REVERIFY_CORPUS_FILE_TAMPERED', 'corpus.json does not match corpus.sha256.');
  }
  const document = parseJson(corpusFile.bytes, 'corpus.json');
  if (!Array.isArray(document?.cases) || document.cases.length === 0) {
    throw codedError('REVERIFY_CORPUS_INVALID', 'corpus.json must contain a non-empty cases array.');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(document.corpusSha256 ?? ''))) {
    throw codedError('REVERIFY_CORPUS_INVALID', 'corpus.json is missing a valid corpusSha256.');
  }
  const ids = document.cases.map((item) => String(item?.id ?? ''));
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Za-z0-9_-]{1,40}$/u.test(id))) {
    throw codedError('REVERIFY_CORPUS_INVALID', 'corpus.json contains duplicate or unsafe case ids.');
  }
  return { corpusPath, digestPath, fileSha256, document };
}

function validateSourceResult({ id, testCase, savedCase, originalResult }) {
  if (!originalResult || typeof originalResult !== 'object' || Array.isArray(originalResult)) {
    throw codedError('REVERIFY_RESULT_INVALID', `Case ${id} result.json must contain an object.`);
  }
  if (String(originalResult.id ?? '') !== id) {
    throw codedError('REVERIFY_RESULT_ID_MISMATCH', `Case ${id} result.json identifies case ${originalResult.id ?? 'missing'}.`);
  }
  if (originalResult.command !== testCase.command || originalResult.command !== savedCase.command) {
    throw codedError('REVERIFY_RESULT_COMMAND_MISMATCH', `Case ${id} result command does not match the saved and current corpus.`);
  }
  if (savedCase.correction && !sameStableValue(originalResult.correction ?? null, savedCase.correction)) {
    throw codedError('REVERIFY_RESULT_CORRECTION_MISMATCH', `Case ${id} result correction does not match the saved corpus.`);
  }
  if (!originalResult.inputManifest || typeof originalResult.inputManifest !== 'object' || Array.isArray(originalResult.inputManifest)) {
    throw codedError('REVERIFY_RESULT_INPUT_MANIFEST_INVALID', `Case ${id} result inputManifest is missing or invalid.`);
  }
  if (!sameStableValue(originalResult.inputManifest, savedCase.inputManifest ?? {})) {
    throw codedError('REVERIFY_RESULT_INPUT_MANIFEST_MISMATCH', `Case ${id} result inputManifest does not match the source corpus.`);
  }
  if (originalResult.tasks !== undefined && !Array.isArray(originalResult.tasks)) {
    throw codedError('REVERIFY_RESULT_TASKS_INVALID', `Case ${id} result tasks must be an array when present.`);
  }
  if (originalResult.mission !== undefined && originalResult.mission !== null
      && (typeof originalResult.mission !== 'object' || Array.isArray(originalResult.mission))) {
    throw codedError('REVERIFY_RESULT_MISSION_INVALID', `Case ${id} result mission must be an object or null.`);
  }
}

function validateCasePaths(testCase, workspace) {
  const paths = [
    ...Object.keys(testCase.inputs ?? {}),
    ...(testCase.expected?.files ?? []).map((item) => typeof item === 'string' ? item : item?.path),
    ...(testCase.expected?.missing ?? []),
    testCase.expected?.liveWeb?.artifactPath,
    ...(testCase.expected?.email?.attachmentPaths ?? [])
  ].filter(Boolean);
  for (const path of paths) resolveInside(workspace, path);
}

async function assertSourceEvidenceUnchanged({ runRoot, corpusEvidence, prepared }) {
  const currentCorpusBytes = await readFile(corpusEvidence.corpusPath);
  if (sha256(currentCorpusBytes) !== corpusEvidence.fileSha256) {
    throw codedError('REVERIFY_SOURCE_CHANGED', 'corpus.json changed during reverification.');
  }
  const digestBytes = await readFile(corpusEvidence.digestPath);
  if (!digestBytes.toString('utf8').includes(corpusEvidence.fileSha256)) {
    throw codedError('REVERIFY_SOURCE_CHANGED', 'corpus.sha256 changed during reverification.');
  }
  for (const source of prepared) {
    const currentResultBytes = await readFile(source.resultPath);
    if (sha256(currentResultBytes) !== source.originalResultSha256) {
      throw codedError('REVERIFY_SOURCE_CHANGED', `Case ${source.id} result.json changed during reverification.`);
    }
    const realResultPath = await realpath(source.resultPath);
    ensureInside(await realpath(resolveInside(runRoot, source.id)), realResultPath, `case ${source.id} result.json`);
  }
}

async function inspectDirectoryBoundary(path, parentRealPath, label) {
  const metadata = await lstat(path).catch((error) => {
    throw codedError('REVERIFY_DIRECTORY_MISSING', `${label} is unavailable: ${error.message}`);
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedError('REVERIFY_UNSAFE_DIRECTORY', `${label} must be a real directory, not a symbolic link or special file.`);
  }
  const realPath = await realpath(path);
  if (parentRealPath) ensureInside(parentRealPath, realPath, label);
  return { path, realPath };
}

async function readRegularFile(path, parentRealPath, label) {
  const metadata = await lstat(path).catch((error) => {
    throw codedError('REVERIFY_FILE_MISSING', `${label} is unavailable: ${error.message}`);
  });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw codedError('REVERIFY_UNSAFE_FILE', `${label} must be a regular file, not a symbolic link or special file.`);
  }
  const realPath = await realpath(path);
  ensureInside(parentRealPath, realPath, label);
  return { bytes: await readFile(path), realPath };
}

async function secureWorkspaceInventory(workspace, workspaceRealPath) {
  const artifacts = [];
  const walk = async (directory, relativeDirectory = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      const absolutePath = resolveInside(workspace, relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw codedError('REVERIFY_WORKSPACE_SYMLINK', `Workspace contains a symbolic link: ${relativePath}`);
      }
      const actualPath = await realpath(absolutePath);
      ensureInside(workspaceRealPath, actualPath, `workspace entry ${relativePath}`);
      if (metadata.isDirectory()) {
        if (entry.name !== '.jarvis-backups') await walk(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw codedError('REVERIFY_WORKSPACE_SPECIAL_FILE', `Workspace contains a non-regular file: ${relativePath}`);
      }
      const bytes = await readFile(absolutePath);
      artifacts.push({
        path: relativePath.replaceAll('\\', '/'),
        size: bytes.length,
        sha256: sha256(bytes)
      });
    }
  };
  await walk(workspace);
  return artifacts;
}

function resolveInside(root, ...children) {
  const base = resolve(root);
  const child = join(...children.map((item) => String(item ?? '')));
  const candidate = isAbsolute(child) ? resolve(child) : resolve(base, child);
  ensureInside(base, candidate, child);
  return candidate;
}

function ensureInside(base, candidate, label) {
  const relationship = relative(resolve(base), resolve(candidate));
  if (relationship === '' || (!relationship.startsWith('..') && !isAbsolute(relationship))) return;
  throw codedError('REVERIFY_PATH_ESCAPE', `${label} escapes its allowed boundary.`);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw codedError('REVERIFY_JSON_INVALID', `${label} is not valid JSON: ${error.message}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameStableValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function createAssertion(check, pass, details, code) {
  return { code, check, pass: pass === true, details };
}

function normalizeError(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
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
