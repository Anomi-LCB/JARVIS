import { extname, isAbsolute, relative, resolve } from 'node:path';

const DEDICATED_OUTPUT_TOOLS = Object.freeze({
  text: 'filesystem.createTextFile',
  txt: 'filesystem.createTextFile',
  md: 'filesystem.createTextFile',
  csv: 'filesystem.createTextFile',
  json: 'filesystem.createTextFile',
  html: 'filesystem.createTextFile',
  xlsx: 'excel.createWorkbook',
  docx: 'word.create',
  pptx: 'powerpoint.create',
  hwpx: 'hwp.create',
  png: 'visual.createCards',
  zip: 'archive.createZip'
});

const TEXT_OUTPUT_TYPES = new Set(['text', 'txt', 'md', 'csv', 'json', 'html']);
const SEARCH_TOOLS = new Set(['filesystem.searchFiles', 'filesystem.listFiles']);
const FORBIDDEN_SUCCESS_TOOLS = new Set(['shell.execute', 'macro.save', 'capability.describe']);

export function verifyWorkflowActionProcess({ testCase, workspace, inputManifest = {}, mission } = {}) {
  const checks = [];
  const orderedActions = orderedMissionActions(mission);
  const observationById = new Map((mission?.observations ?? [])
    .filter((item) => item?.observationId)
    .map((item) => [item.observationId, item]));
  const successfulActions = orderedActions.filter((item) => isProvenSuccess(item, observationById));
  const statusSucceededActions = orderedActions.filter((item) => item.status === 'succeeded');
  const declaredInputPaths = [...new Set([
    ...Object.keys(testCase?.inputs ?? {}),
    ...Object.keys(inputManifest)
  ])];
  const inputRecords = uniquePathRecords(declaredInputPaths, workspace);
  const inputPaths = inputRecords.map((record) => record.path);
  const inputPathSet = new Set(inputPaths);
  const inputReadContract = deriveInputReadContract({
    command: testCase?.command,
    inputRecords
  });
  const requiredInputPaths = inputReadContract.requiredRecords.map((record) => record.path);

  if (inputPaths.length === 0 && testCase?.expected?.liveWeb) {
    checks.push(processAssertion(
      'PROCESS_INPUT_READS',
      'input read requirement is exempt for an inputless live case',
      true,
      {
        declaredInputCount: 0,
        expectedInputCount: 0,
        exemptReason: 'inputless-live-case'
      }
    ));
  } else if (requiredInputPaths.length === 0) {
    checks.push(processAssertion(
      'PROCESS_INPUT_READS',
      'no materialized input is explicitly selected for reading by this command',
      true,
      {
        declaredInputCount: inputPaths.length,
        expectedInputCount: 0,
        excludedInputPaths: inputRecords.map((record) => relativeDisplayPath(record.path, workspace)),
        selectionReasons: {},
        exemptReason: inputPaths.length === 0
          ? 'no-materialized-inputs'
          : 'command-does-not-request-these-inputs-be-read'
      }
    ));
  } else {
    const inputReadProofs = requiredInputPaths.map((path) => proveInputRead({
      inputPath: path,
      successfulActions,
      workspace
    }));
    const missingInputReads = requiredInputPaths.filter((path, index) => !inputReadProofs[index]);
    const movedInputReads = inputReadProofs
      .filter((proof) => proof?.moves?.length > 0)
      .map((proof) => ({
        inputPath: relativeDisplayPath(proof.inputPath, workspace),
        readPath: relativeDisplayPath(proof.readPath, workspace),
        readSequence: proof.readSequence,
        moves: proof.moves.map((move) => ({
          from: relativeDisplayPath(move.from, workspace),
          to: relativeDisplayPath(move.to, workspace),
          sequence: move.sequence
        }))
      }));
    checks.push(processAssertion(
      'PROCESS_INPUT_READS',
      'every input selected for reading by the command was successfully read with filesystem.readText, directly or after a proven exact move',
      missingInputReads.length === 0,
      {
        declaredInputCount: inputPaths.length,
        expectedInputCount: requiredInputPaths.length,
        successfulInputReadCount: requiredInputPaths.length - missingInputReads.length,
        missingInputReads: missingInputReads.map((path) => relativeDisplayPath(path, workspace)),
        excludedInputPaths: inputRecords
          .filter((record) => !inputReadContract.requiredPathSet.has(record.path))
          .map((record) => relativeDisplayPath(record.path, workspace)),
        selectionReasons: Object.fromEntries(inputReadContract.requiredRecords.map((record) => [
          relativeDisplayPath(record.path, workspace),
          inputReadContract.reasonsByPath.get(record.path) ?? []
        ])),
        movedInputReads
      }
    ));
  }

  const searchActions = successfulActions.filter((item) => SEARCH_TOOLS.has(item.actualToolName));
  checks.push(processAssertion(
    'PROCESS_SEARCH_OR_LIST',
    'at least one filesystem search or list action succeeded',
    searchActions.length >= 1,
    {
      successfulSearchOrListCount: searchActions.length,
      tools: searchActions.map((item) => item.actualToolName)
    }
  ));

  const moveTargets = new Set(successfulActions
    .filter((item) => item.actualToolName === 'filesystem.moveFiles')
    .flatMap((item) => actionOutputPaths(item, workspace)));
  const expectedFiles = (testCase?.expected?.files ?? [])
    .map(normalizeFileSpec)
    .filter((spec) => !spec.mustBeAbsent);
  const generatedTextPaths = [];

  for (const spec of expectedFiles) {
    const expectedPath = canonicalPath(spec.path, workspace);
    if (inputPathSet.has(expectedPath)) {
      checks.push(processAssertion(
        'PROCESS_EXISTING_INPUT_PROVENANCE',
        `pre-existing input is not misclassified as generated output: ${spec.path}`,
        true,
        { path: spec.path, provenance: 'materialized-input' }
      ));
      continue;
    }
    if (moveTargets.has(expectedPath)) {
      checks.push(processAssertion(
        'PROCESS_MOVE_OUTPUT_PROVENANCE',
        `moved output has a successful filesystem.moveFiles action: ${spec.path}`,
        true,
        { path: spec.path, provenance: 'filesystem.moveFiles' }
      ));
      continue;
    }

    const requiredTool = DEDICATED_OUTPUT_TOOLS[spec.type];
    const matchingActions = successfulActions.filter((item) => (
      item.actualToolName === requiredTool
      && actionOutputPaths(item, workspace).includes(expectedPath)
    ));
    checks.push(processAssertion(
      'PROCESS_DEDICATED_OUTPUT_TOOL',
      `dedicated ${requiredTool ?? 'unknown'} tool produced ${spec.path}`,
      Boolean(requiredTool) && matchingActions.length >= 1,
      {
        path: spec.path,
        type: spec.type,
        requiredTool: requiredTool ?? null,
        matchingSuccessfulActionCount: matchingActions.length
      }
    ));
    if (TEXT_OUTPUT_TYPES.has(spec.type)) generatedTextPaths.push(expectedPath);
  }

  if (testCase?.expected?.status === 'COMPLETED') {
    const expectedProducedPaths = new Set(expectedFiles
      .map((spec) => canonicalPath(spec.path, workspace))
      .filter((path) => path && !inputPathSet.has(path)));
    const outputActions = successfulActions.filter((item) => (
      (Object.values(DEDICATED_OUTPUT_TOOLS).includes(item.actualToolName)
        || item.actualToolName === 'filesystem.moveFiles')
      && actionOutputPaths(item, workspace).some((path) => expectedProducedPaths.has(path))
    ));
    const rediscoveryPairs = [];
    for (const outputAction of outputActions) {
      for (const searchAction of searchActions) {
        if (searchAction.sequence > outputAction.sequence) {
          rediscoveryPairs.push({
            outputSequence: outputAction.sequence,
            outputToolName: outputAction.actualToolName,
            searchSequence: searchAction.sequence,
            searchToolName: searchAction.actualToolName
          });
        }
      }
    }
    checks.push(processAssertion(
      'PROCESS_OUTPUT_REDISCOVERY_ORDER',
      'a filesystem search or list succeeded after at least one generated or moved output action',
      outputActions.length > 0 && rediscoveryPairs.length > 0,
      {
        outputActionCount: outputActions.length,
        searchActionCount: searchActions.length,
        rediscoveryPairs
      }
    ));
  } else {
    checks.push(processAssertion(
      'PROCESS_OUTPUT_REDISCOVERY_ORDER',
      'output rediscovery ordering is not required for an expected-stop case',
      true,
      { required: false }
    ));
  }

  const generatedTextRereadContract = deriveGeneratedTextRereadContract({
    command: testCase?.command,
    generatedTextPaths,
    workspace
  });
  if (generatedTextRereadContract.requiredPaths.length > 0) {
    const qualifyingPairs = [];
    const missingRereadPaths = [];
    for (const createdPath of generatedTextRereadContract.requiredPaths) {
      const createActions = successfulActions.filter((item) => (
        item.actualToolName === 'filesystem.createTextFile'
        && actionOutputPaths(item, workspace).includes(createdPath)
      ));
      const readActions = successfulActions.filter((item) => (
        item.actualToolName === 'filesystem.readText'
        && canonicalPath(item.arguments?.path, workspace) === createdPath
      ));
      for (const createAction of createActions) {
        for (const readAction of readActions) {
          if (readAction.sequence > createAction.sequence) {
            qualifyingPairs.push({
              path: relativeDisplayPath(createdPath, workspace),
              createSequence: createAction.sequence,
              readSequence: readAction.sequence
            });
          }
        }
      }
      if (!qualifyingPairs.some((pair) => canonicalPath(pair.path, workspace) === createdPath)) {
        missingRereadPaths.push(createdPath);
      }
    }
    checks.push(processAssertion(
      'PROCESS_CREATED_TEXT_REREAD',
      'every generated text artifact selected for rereading was successfully read after its create action',
      missingRereadPaths.length === 0,
      {
        required: true,
        generatedTextPaths: generatedTextPaths.map((path) => relativeDisplayPath(path, workspace)),
        requiredRereadPaths: generatedTextRereadContract.requiredPaths
          .map((path) => relativeDisplayPath(path, workspace)),
        missingRereadPaths: missingRereadPaths.map((path) => relativeDisplayPath(path, workspace)),
        rereadClauses: generatedTextRereadContract.rereadClauses,
        qualifyingPairs
      }
    ));
  } else {
    const hasRereadClause = generatedTextRereadContract.rereadClauses.length > 0;
    checks.push(processAssertion(
      'PROCESS_CREATED_TEXT_REREAD',
      hasRereadClause
        ? 'the command rereads existing or moved inputs, so generated-text reread ordering is not required'
        : 'generated-text reread ordering is not required by this command',
      true,
      {
        required: false,
        generatedTextPaths: generatedTextPaths.map((path) => relativeDisplayPath(path, workspace)),
        rereadClauses: generatedTextRereadContract.rereadClauses,
        exemptReason: hasRereadClause
          ? 'reread-targets-do-not-include-generated-text'
          : 'command-does-not-request-reread'
      }
    ));
  }

  const forbiddenSuccesses = statusSucceededActions.filter((item) => FORBIDDEN_SUCCESS_TOOLS.has(item.actualToolName));
  checks.push(processAssertion(
    'PROCESS_NO_FAKE_COMPLETION_TOOLS',
    'no shell.execute, macro.save, or capability.describe action succeeded',
    forbiddenSuccesses.length === 0,
    {
      forbiddenSuccessCount: forbiddenSuccesses.length,
      actions: forbiddenSuccesses.map(actionDetail)
    }
  ));

  const routeDifferences = orderedActions.filter((item) => (
    item.expectedToolName
    && item.actualToolName
    && item.expectedToolName !== item.actualToolName
  ));
  const allowedRouteAdaptations = routeDifferences.filter((item) => item.routeAdaptation?.allowed === true);
  const routeMismatches = routeDifferences.filter((item) => item.routeAdaptation?.allowed !== true);
  checks.push(processAssertion(
    'PROCESS_ALLOWED_ROUTE_ADAPTATIONS',
    'runtime-approved equivalent route adaptations are retained as passing evidence',
    true,
    {
      allowedAdaptationCount: allowedRouteAdaptations.length,
      reasons: [...new Set(allowedRouteAdaptations.map((item) => item.routeAdaptation?.reason).filter(Boolean))],
      actions: allowedRouteAdaptations.map((item) => ({
        ...actionDetail(item),
        adaptationPolicy: item.routeAdaptation?.policy ?? null,
        adaptationReason: item.routeAdaptation?.reason ?? null,
        privilegeChange: item.routeAdaptation?.privilegeChange ?? null
      }))
    }
  ));
  checks.push(processAssertion(
    'PROCESS_NO_ROUTE_MISMATCH',
    'every expected/actual route difference is explicitly allowed by MissionRuntime',
    routeMismatches.length === 0,
    {
      routeDifferenceCount: routeDifferences.length,
      allowedAdaptationCount: allowedRouteAdaptations.length,
      incompatibleMismatchCount: routeMismatches.length,
      actions: routeMismatches.map(actionDetail)
    }
  ));

  return checks;
}

function uniquePathRecords(paths, workspace) {
  const recordsByPath = new Map();
  for (const declaredPath of paths) {
    const path = canonicalPath(declaredPath, workspace);
    if (!path || recordsByPath.has(path)) continue;
    const displayPath = relativeDisplayPath(path, workspace);
    const normalizedDisplayPath = normalizeCommandPath(displayPath);
    const baseName = normalizedDisplayPath.split('/').at(-1) ?? normalizedDisplayPath;
    recordsByPath.set(path, {
      path,
      displayPath,
      normalizedDisplayPath,
      baseName,
      extension: extname(baseName).slice(1).toLowerCase()
    });
  }
  return [...recordsByPath.values()];
}

function deriveInputReadContract({ command, inputRecords }) {
  const clauses = commandClauses(command);
  const reasonsByPath = new Map();
  const selectors = findInputSelectors(command);
  const selectorRecords = new Set();

  const select = (record, reason) => {
    const reasons = reasonsByPath.get(record.path) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    reasonsByPath.set(record.path, reasons);
  };

  for (const selector of selectors) {
    for (const record of inputRecords) {
      if (!matchesInputSelector(record, selector)) continue;
      selectorRecords.add(record);
      select(record, selector.reason);
    }
  }

  for (const clause of clauses) {
    if (!/읽/iu.test(clause)) continue;

    const readTargets = readTargetSegments(clause);
    const explicitlyNamed = inputRecords.filter((record) => readTargets.some((target) => (
      commandReferencesRecord(target, record, inputRecords)
    )));
    for (const record of explicitlyNamed) {
      select(record, 'explicit-path-in-read-clause');
    }

    const readsWholeGroup = /(?:모두|각각|전부|함께)\s*(?:다시\s*)?(?:열(?:어서|어)?\s*)?읽/iu.test(clause);
    if (readsWholeGroup) {
      const refersToSelectedGroup = /(?:선택(?:된|한)?|찾은|이동된|해당)\s*파일/iu.test(clause);
      const group = refersToSelectedGroup && selectorRecords.size > 0
        ? [...selectorRecords]
        : inputRecords;
      for (const record of group) select(record, 'explicit-all-or-each-read-group');
    }

    const requestedCount = readGroupCount(clause);
    if (requestedCount !== null) {
      if (selectorRecords.size === requestedCount) {
        for (const record of selectorRecords) select(record, `selected-read-group-count:${requestedCount}`);
      } else if (inputRecords.length === requestedCount) {
        for (const record of inputRecords) select(record, `complete-read-group-count:${requestedCount}`);
      }
    } else if (
      inputRecords.length === 1
      && explicitlyNamed.length === 0
      && /(?:파일|원본|문서)(?:을|를)?[^.!?]{0,24}읽/iu.test(clause)
    ) {
      select(inputRecords[0], 'unambiguous-single-input-read');
    }
  }

  const requiredRecords = inputRecords.filter((record) => reasonsByPath.has(record.path));
  return {
    requiredRecords,
    requiredPathSet: new Set(requiredRecords.map((record) => record.path)),
    reasonsByPath
  };
}

function findInputSelectors(command) {
  const selectors = [];
  for (const clause of commandClauses(command)) {
    if (!/파일만/iu.test(clause)) continue;
    const startsWithMatch = clause.match(
      /이름(?:이|은)?\s+([\p{L}\p{N}._-]+?)(?:으로|로)\s*시작/iu
    );
    const containsMatch = clause.match(
      /이름(?:이|은)?\s+([\p{L}\p{N}._-]+?)(?:을|를)\s*포함|이름(?:에)?\s+([\p{L}\p{N}._-]+?)(?:이|가)?\s*포함/iu
    );
    const operation = startsWithMatch ? 'starts-with' : containsMatch ? 'contains' : null;
    const value = startsWithMatch?.[1] ?? containsMatch?.[1] ?? containsMatch?.[2];
    if (!operation || !value) continue;

    const explicitExtension = clause.match(/확장자(?:가|는|은)?\s*\.?([a-z0-9]+)/iu)?.[1];
    const adjacentExtension = clause.match(
      /(?:시작|포함)(?:하는|하고|하며|되는|되고|되며|된)\s+\.?([a-z0-9]+)\s*파일만/iu
    )?.[1];
    const extension = explicitExtension ?? adjacentExtension;
    if (!extension) continue;

    selectors.push({
      operation,
      value: String(value).toLowerCase(),
      extension: String(extension).toLowerCase(),
      reason: `filename-${operation}:${String(value).toLowerCase()};extension:${String(extension).toLowerCase()}`
    });
  }
  return selectors;
}

function matchesInputSelector(record, selector) {
  if (record.extension !== selector.extension) return false;
  const stem = record.baseName.slice(0, -(record.extension.length + 1));
  if (selector.operation === 'starts-with') return stem.startsWith(selector.value);
  return stem.includes(selector.value);
}

function readGroupCount(clause) {
  const match = String(clause).match(
    /(\d+|한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(?:개(?:의)?\s*)?(?:파일|보고서|원본|txt(?:\s*파일)?|csv(?:\s*파일)?|json(?:\s*파일)?)[^.!?]{0,32}?(?:다시\s*)?(?:열(?:어서|어)?\s*)?읽/iu
  );
  if (!match) return null;
  if (/^\d+$/u.test(match[1])) return Number(match[1]);
  return ({
    한: 1,
    하나: 1,
    두: 2,
    둘: 2,
    세: 3,
    셋: 3,
    네: 4,
    넷: 4,
    다섯: 5,
    여섯: 6,
    일곱: 7,
    여덟: 8,
    아홉: 9,
    열: 10
  })[match[1]] ?? null;
}

function deriveGeneratedTextRereadContract({ command, generatedTextPaths, workspace }) {
  const generatedRecords = uniquePathRecords(generatedTextPaths, workspace);
  const clauses = commandClauses(command);
  const rereadClauses = [];
  const requiredPathSet = new Set();

  for (const [clauseIndex, clause] of clauses.entries()) {
    if (!hasRereadInstruction(clause)) continue;
    rereadClauses.push(clause);
    const targetSegment = rereadTargetSegment(clause);

    for (const record of generatedRecords) {
      if (commandReferencesRecord(targetSegment, record, generatedRecords)) {
        requiredPathSet.add(record.path);
      }
    }

    const requestedTypes = textTypesReferencedByReread(targetSegment);
    for (const record of generatedRecords) {
      if (requestedTypes.has(record.extension)) requiredPathSet.add(record.path);
    }

    if (/(?:찾은|검색한)\s*파일/iu.test(targetSegment)) {
      for (let previousIndex = clauseIndex - 1; previousIndex >= 0; previousIndex -= 1) {
        const previousClause = clauses[previousIndex];
        if (!/(?:검색|찾|나열)/iu.test(previousClause)) continue;
        const referenced = generatedRecords.filter((record) => commandReferencesRecord(
          previousClause,
          record,
          generatedRecords
        ));
        for (const record of referenced) requiredPathSet.add(record.path);
        if (referenced.length > 0) break;
      }
    }
  }

  return {
    requiredPaths: generatedRecords
      .filter((record) => requiredPathSet.has(record.path))
      .map((record) => record.path),
    rereadClauses
  };
}

function commandClauses(command) {
  return String(command ?? '')
    .split(/(?:^|\s)\d+\)\s*/u)
    .flatMap((step) => step.split(/[.!?](?:\s+|$)/u))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function commandReferencesRecord(text, record, records) {
  const normalizedText = normalizeCommandPath(text);
  if (normalizedText.includes(record.normalizedDisplayPath)) return true;
  const sameBaseNameCount = records.filter((candidate) => candidate.baseName === record.baseName).length;
  return sameBaseNameCount === 1 && normalizedText.includes(record.baseName);
}

function normalizeCommandPath(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

function hasRereadInstruction(clause) {
  return /다시\s*(?:열(?:어서|어)?\s*)?읽/iu.test(String(clause));
}

function readTargetSegments(clause) {
  const text = String(clause);
  const segments = [];
  for (const readMatch of text.matchAll(/읽/giu)) {
    segments.push(readTargetPrefix(text.slice(0, readMatch.index ?? 0)));
  }
  return segments;
}

function rereadTargetSegment(clause) {
  const text = String(clause);
  const rereadMatch = /다시\s*(?:열(?:어서|어)?\s*)?읽/iu.exec(text);
  if (!rereadMatch) return text;
  return readTargetPrefix(text.slice(0, rereadMatch.index));
}

function readTargetPrefix(prefix) {
  const boundaries = /(?:만들고|생성하고|작성하고|저장하고|이동하고|검색하고|찾고|나열하고|확인하고|읽고|만든\s*뒤|생성한\s*뒤|작성한\s*뒤|저장한\s*뒤|이동한\s*뒤|확인한\s*뒤|검색한\s*뒤|찾은\s*뒤|그리고|,)/giu;
  let boundaryEnd = 0;
  for (const match of prefix.matchAll(boundaries)) {
    boundaryEnd = (match.index ?? 0) + match[0].length;
  }
  return prefix.slice(boundaryEnd).trim();
}

function textTypesReferencedByReread(targetSegment) {
  const text = String(targetSegment);
  const types = new Set();
  if (/(?:markdown|마크다운)/iu.test(text)) types.add('md');
  if (/(?:^|[^a-z])csv(?:[^a-z]|$)/iu.test(text)) types.add('csv');
  if (/(?:^|[^a-z])json(?:[^a-z]|$)/iu.test(text)) types.add('json');
  if (/(?:^|[^a-z])html(?:[^a-z]|$)/iu.test(text)) types.add('html');
  if (/(?:^|[^a-z])txt(?:[^a-z]|$)|텍스트\s*파일/iu.test(text)) types.add('txt');
  return types;
}

function orderedMissionActions(mission) {
  return (mission?.waves ?? [])
    .flatMap((wave, wavePosition) => (wave.actions ?? []).map((action, actionPosition) => ({
      ...action,
      waveSequence: Number.isFinite(Number(wave.waveIndex)) ? Number(wave.waveIndex) : wavePosition + 1,
      actionSequence: Number.isFinite(Number(action.order)) ? Number(action.order) : actionPosition + 1
    })))
    .sort((left, right) => left.waveSequence - right.waveSequence || left.actionSequence - right.actionSequence)
    .map((action, sequence) => ({ ...action, sequence }));
}

function isProvenSuccess(action, observationById) {
  if (action.status !== 'succeeded' || !action.observationId) return false;
  const observation = observationById.get(action.observationId);
  return observation?.outcome === 'success'
    && observation.toolName === action.actualToolName;
}

function proveInputRead({ inputPath, successfulActions, workspace }) {
  const reachablePaths = new Map([[inputPath, []]]);
  for (const action of successfulActions) {
    if (action.actualToolName === 'filesystem.readText') {
      const readPath = canonicalPath(action.arguments?.path, workspace);
      if (readPath && reachablePaths.has(readPath)) {
        return {
          inputPath,
          readPath,
          readSequence: action.sequence,
          moves: reachablePaths.get(readPath)
        };
      }
      continue;
    }
    if (action.actualToolName !== 'filesystem.moveFiles') continue;
    const args = action.arguments ?? {};
    const moves = Array.isArray(args.moves)
      ? args.moves
      : args.from && args.to ? [{ from: args.from, to: args.to }] : [];
    for (const move of moves) {
      const from = canonicalPath(move?.from, workspace);
      const to = canonicalPath(move?.to, workspace);
      if (!from || !to || !reachablePaths.has(from)) continue;
      const history = reachablePaths.get(from);
      reachablePaths.delete(from);
      reachablePaths.set(to, [...history, { from, to, sequence: action.sequence }]);
    }
  }
  return null;
}

function actionOutputPaths(action, workspace) {
  const args = action.arguments ?? {};
  const candidates = [];
  if (action.actualToolName === 'excel.createWorkbook') candidates.push(args.outputPath);
  if (['filesystem.createTextFile', 'word.create', 'powerpoint.create', 'hwp.create', 'archive.createZip'].includes(action.actualToolName)) {
    candidates.push(args.path);
  }
  if (action.actualToolName === 'visual.createCards') {
    const outputDirectory = args.outputDirectory ?? workspace;
    for (const card of args.cards ?? []) {
      candidates.push(resolvePath(card?.fileName ?? card?.path, outputDirectory));
    }
  }
  if (action.actualToolName === 'filesystem.moveFiles') {
    const moves = Array.isArray(args.moves) ? args.moves : args.from && args.to ? [{ from: args.from, to: args.to }] : [];
    candidates.push(...moves.map((move) => move?.to));
  }
  return [...new Set(candidates.map((path) => canonicalPath(path, workspace)).filter(Boolean))];
}

function resolvePath(path, root) {
  if (!path) return null;
  return isAbsolute(String(path)) ? String(path) : resolve(root, String(path));
}

function canonicalPath(path, workspace) {
  if (!path) return null;
  const absolute = isAbsolute(String(path)) ? resolve(String(path)) : resolve(workspace, String(path));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function relativeDisplayPath(path, workspace) {
  const resolvedWorkspace = resolve(workspace);
  const canonicalWorkspace = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace;
  const relativePath = relative(canonicalWorkspace, path);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
    ? relativePath.replaceAll('\\', '/')
    : path;
}

function normalizeFileSpec(value) {
  if (typeof value === 'string') {
    return { path: value, type: inferType(value), mustBeAbsent: false };
  }
  return {
    path: String(value?.path ?? ''),
    type: String(value?.type ?? inferType(value?.path)).toLowerCase(),
    mustBeAbsent: value?.absent === true
  };
}

function inferType(path) {
  return extname(String(path ?? '')).slice(1).toLowerCase() || 'text';
}

function actionDetail(action) {
  return {
    sequence: action.sequence,
    actionId: action.actionId ?? null,
    expectedToolName: action.expectedToolName ?? null,
    actualToolName: action.actualToolName ?? null,
    status: action.status ?? null
  };
}

function processAssertion(code, check, pass, details = {}) {
  return { code, check, pass: pass === true, details };
}
