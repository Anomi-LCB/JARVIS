import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const REPORT_VERSION = 'jarvis-complex-workflow-50-report-v2';
const PASSING_OUTCOMES = new Set(['SUCCESS', 'EXPECTED_STOP']);
const RECOGNIZED_OUTCOMES = new Set(['SUCCESS', 'EXPECTED_STOP', 'PARTIAL', 'FAILED']);
const FAILED_ACTION_STATUSES = new Set(['failed', 'blocked', 'rejected', 'cancelled', 'canceled', 'timed_out']);

const CAUSE_CATALOG = {
  RESULT_RECORD_MISSING_OR_INVALID: {
    label: '결과 기록 누락 또는 손상',
    severity: 'critical',
    description: '사례의 result.json을 읽을 수 없어서 실행 사실과 검증 결과를 재구성할 수 없습니다.',
    solution: '해당 사례의 격리 작업공간과 감사 로그를 보존한 채 다시 실행하고 원자적 결과 기록을 확인합니다.'
  },
  RUNNER_OR_RUNTIME_EXCEPTION: {
    label: '실행기 또는 런타임 예외',
    severity: 'critical',
    description: '미션 실행 또는 독립 검증 단계에서 처리되지 않은 예외가 기록되었습니다.',
    solution: '오류 코드와 메시지가 가리키는 어댑터·입력 계약을 수정한 뒤 해당 사례만 격리 재시험합니다.'
  },
  ROUTE_MISMATCH: {
    label: '계획 도구와 실제 라우팅 불일치',
    severity: 'high',
    description: '미션 계획이 요구한 도구와 실제 선택된 도구가 달라 의도한 작업이 수행되지 않았습니다.',
    solution: '의도 파서의 파일명·동사 슬롯과 도구 계약을 좁히고, 예상 도구 일치 검사를 실행 전에 적용합니다.'
  },
  ACTION_EXECUTION_FAILURE: {
    label: '개별 액션 실행 실패',
    severity: 'high',
    description: '미션을 구성하는 하나 이상의 실제 액션 또는 작업이 실패·차단되었습니다.',
    solution: '실패 액션의 입력, 도구 오류, 선행 의존성을 바로잡고 이미 성공한 비가역 액션은 재실행하지 않습니다.'
  },
  COMPLETION_EVIDENCE_GAP: {
    label: '완료 판정 증거 부족',
    severity: 'high',
    description: '파일이 만들어졌더라도 성공 기준과 연결된 관찰·해시·이름 증거가 부족해 완료 판정이 거부되었습니다.',
    solution: '생성·검색·재읽기 관찰의 artifact 경로와 SHA-256을 성공 기준에 연결하고 정규화된 파일명 비교를 사용합니다.'
  },
  MISSION_PLANNER_STALL: {
    label: '미션 계획 반복 정체',
    severity: 'high',
    description: '새로운 검증 증거 없이 유사 계획이 반복되어 정체 감지기가 미션을 중단했습니다.',
    solution: '완료된 액션과 충족된 기준을 다음 계획 입력에 고정하고, 남은 기준만 생성하는 결정적 복구 경로를 적용합니다.'
  },
  TIME_OR_BUDGET_LIMIT: {
    label: '시간 또는 실행 예산 소진',
    severity: 'high',
    description: '미션 시간, 파동, 액션 또는 계획 호출 한도를 소진했습니다.',
    solution: '사례를 체크포인트에서 재개하고 중복 액션을 제거한 뒤 필요한 범위에서만 예산을 조정합니다.'
  },
  APPROVAL_OR_POLICY_GATE: {
    label: '승인 또는 정책 게이트 정지',
    severity: 'medium',
    description: '정책상 자동 실행 범위를 벗어난 작업이 승인·정책 게이트에서 정지했습니다.',
    solution: '자기 메일처럼 사전 허용된 정확한 범위만 신뢰 세션과 해시 결합으로 자동화하고, 임의 수신자·파괴 작업은 계속 차단합니다.'
  },
  ARTIFACT_ACCEPTANCE_MISMATCH: {
    label: '산출물 독립 검증 불일치',
    severity: 'high',
    description: '산출물의 존재, 내용, 형식, 시트·슬라이드 수, PNG 크기 또는 ZIP 항목 검증이 실패했습니다.',
    solution: '생성기의 구조화 인수와 수용 기준을 일치시키고 실제 바이트·컨테이너를 다시 검사합니다.'
  },
  INPUT_IMMUTABILITY_VIOLATION: {
    label: '입력 원본 무결성 위반',
    severity: 'critical',
    description: '읽기 전용이어야 하는 입력 파일의 크기 또는 SHA-256이 달라졌습니다.',
    solution: '입력과 출력 루트를 분리하고 생성 도구의 출력 경로 충돌 검사를 강화한 뒤 원본을 복구합니다.'
  },
  LIVE_WEB_EVIDENCE_GAP: {
    label: '실시간 웹 근거 검증 실패',
    severity: 'high',
    description: '비재생 HTTP 2xx 관찰, URL 수 또는 출처 도메인 수가 사전 기준을 충족하지 못했습니다.',
    solution: '실제 RSS·브라우저 응답의 시각, 상태 코드, URL, 출처를 보존하고 재생·fixture 결과를 성공 근거에서 제외합니다.'
  },
  EMAIL_DELIVERY_OR_INTEGRITY_GAP: {
    label: '자기 메일 전송 또는 첨부 무결성 검증 실패',
    severity: 'critical',
    description: 'SMTP 수락, 자기 수신자 일치, 제목, 첨부 개수 또는 첨부 해시 결합 중 하나 이상이 확인되지 않았습니다.',
    solution: '내 메일 1인 수신, 정확한 첨부 참조·SHA-256, 영속 멱등키를 확인합니다. 수락 여부가 불확실한 발송은 중복 재시도하지 않습니다.'
  },
  EXPECTED_STOP_EXPLANATION_GAP: {
    label: '안전 정지 설명 부족',
    severity: 'medium',
    description: '필수 입력이 없는 상황에서 멈췄지만 누락된 입력을 충분히 특정하지 못했습니다.',
    solution: '추측이나 파일 생성을 하지 않은 상태에서 필요한 파일명·필드를 구조화된 stopReason으로 반환합니다.'
  },
  MISSION_OBSERVATION_FAILURE: {
    label: '미션 관찰 실패',
    severity: 'high',
    description: '도구 실행 또는 검증 관찰이 실패로 기록되었습니다.',
    solution: '관찰 오류 코드의 원인을 수정하고 동일 성공 기준에 새 검증 증거가 연결되는지 재시험합니다.'
  },
  ACCEPTANCE_ASSERTION_FAILURE: {
    label: '기타 수용 기준 실패',
    severity: 'medium',
    description: '사전 고정한 독립 수용 기준 중 분류되지 않은 검사가 실패했습니다.',
    solution: '실패 검사와 원시 증거를 비교해 제품 결함과 검증기 결함을 분리한 뒤 해당 범위만 수정합니다.'
  },
  MISSION_STOP_REASON: {
    label: '미션 비정상 정지',
    severity: 'high',
    description: '완료 또는 의도된 안전 정지가 아닌 사유로 미션이 멈췄습니다.',
    solution: 'stopReason과 마지막 실패 관찰을 기준으로 복구 분기를 추가하고 사례를 재시험합니다.'
  },
  UNCLASSIFIED_FAILURE: {
    label: '추가 분석이 필요한 실패',
    severity: 'high',
    description: '실패 결과는 확인됐지만 현재 기록만으로 직접 원인을 특정할 수 없습니다.',
    solution: '미션 파동, 작업 실행, 검증 로그의 상관 ID를 보존해 누락된 오류 증거부터 보강합니다.'
  }
};

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/complex-workflow-50-report.mjs --root <initial-run-root> [--retest-root <retest-run-root>]...');
  process.exit(0);
}
if (!options.root) throw new Error('--root is required.');

const initialRun = await loadRun(options.root, 'initial', 0);
const retestRuns = [];
for (const [index, root] of options.retestRoots.entries()) {
  retestRuns.push(await loadRun(root, `retest-${index + 1}`, index + 1));
}

const retestLinks = buildRetestLinks(initialRun, retestRuns);
const closureAssessment = buildClosureAssessment(initialRun, retestLinks);
const executionTotals = buildExecutionTotals(initialRun);
const rootCauseClusters = buildRootCauseClusters(initialRun, retestLinks);
const securityAndEmail = buildSecurityAndEmail(initialRun, retestRuns);
const diagnosis = redactDeep({
  schemaVersion: REPORT_VERSION,
  generatedAt: new Date().toISOString(),
  interpretation: {
    primaryRunIsImmutableBaseline: true,
    retestsAreSeparateEvidence: true,
    readOnlyReverificationIsNotExecution: true,
    correctedVerificationIsAnExplicitSpecificationOverlay: true,
    smtpAcceptanceMeans: 'SMTP transport provider accepted the intended self recipient.',
    smtpAcceptanceDoesNotMean: ['inbox placement', 'message opened', 'content read'],
    assertionTruthSource: 'result.json assertions; legacy [redacted] booleans are UNKNOWN rather than guessed'
  },
  initialRun: publicRun(initialRun),
  retestRuns: retestRuns.map(publicRun),
  retestLinks,
  closureAssessment,
  executionTotals,
  rootCauseClusters,
  securityAndEmail,
  redaction: {
    applied: true,
    emailAddresses: 'replaced with [redacted-email]',
    rawSecretsAndTokens: 'removed or replaced with [redacted]',
    rawMailBodiesAndRecipientAddressesIncluded: false
  }
});

const report = renderReport(diagnosis);
await atomicWrite(join(initialRun.root, 'diagnosis.json'), `${JSON.stringify(diagnosis, null, 2)}\n`);
await atomicWrite(join(initialRun.root, 'report.md'), report);

console.log(`REPORT ${join(initialRun.root, 'report.md')}`);
console.log(`DIAGNOSIS ${join(initialRun.root, 'diagnosis.json')}`);

function parseArguments(argv) {
  const result = { root: null, retestRoots: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--root' || token === '--retest-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value.`);
      if (token === '--root') {
        if (result.root) throw new Error('--root may be supplied only once.');
        result.root = value;
      } else {
        result.retestRoots.push(value);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('--root=')) {
      if (result.root) throw new Error('--root may be supplied only once.');
      result.root = token.slice('--root='.length);
      continue;
    }
    if (token.startsWith('--retest-root=')) {
      result.retestRoots.push(token.slice('--retest-root='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  result.retestRoots = [...new Set(result.retestRoots.map((item) => resolve(item)))];
  if (result.root) {
    result.root = resolve(result.root);
    result.retestRoots = result.retestRoots.filter((item) => item !== result.root);
  }
  return result;
}

async function loadRun(rawRoot, label, index) {
  const root = resolve(rawRoot);
  const corpusPath = join(root, 'corpus.json');
  const summaryPath = join(root, 'summary.json');
  const [corpusText, summaryText] = await Promise.all([
    readFile(corpusPath, 'utf8'),
    readFile(summaryPath, 'utf8')
  ]);
  const corpus = parseJsonDocument(corpusText, corpusPath);
  const summary = parseJsonDocument(summaryText, summaryPath);
  const corpusCases = Array.isArray(corpus?.cases) ? corpus.cases : [];
  const summaryResults = Array.isArray(summary?.results) ? summary.results : [];
  const summaryById = new Map(summaryResults.map((item) => [String(item?.id ?? ''), item]));
  const pendingIds = new Set((summary?.pendingCaseIds ?? []).map(String));
  const descriptors = [];
  const seenIds = new Set();

  for (const [caseIndex, item] of corpusCases.entries()) {
    const id = String(item?.id ?? '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    descriptors.push({ id, corpusCase: item, summaryItem: summaryById.get(id) ?? null, caseIndex });
  }
  for (const item of summaryResults) {
    const id = String(item?.id ?? '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    descriptors.push({ id, corpusCase: null, summaryItem: item, caseIndex: descriptors.length });
  }

  const verificationEvidence = await loadVerificationEvidence(root, descriptors.map((item) => item.id));

  const cases = [];
  for (const descriptor of descriptors) {
    const requestedResultPath = descriptor.summaryItem?.resultPath ?? `${descriptor.id}/result.json`;
    let resultPath;
    let result = null;
    let loadError = null;
    try {
      resultPath = safeResolveInside(root, requestedResultPath);
      result = parseJsonDocument(await readFile(resultPath, 'utf8'), resultPath);
    } catch (error) {
      loadError = normalizeError(error);
      resultPath ??= join(root, descriptor.id, 'result.json');
    }
    cases.push(buildCaseRecord({
      ...descriptor,
      result,
      resultPath,
      loadError,
      pending: pendingIds.has(descriptor.id),
      runRoot: root,
      verifications: verificationEvidence.byCaseId.get(descriptor.id) ?? []
    }));
  }

  const counts = countOutcomes(cases);
  const sequentiality = analyzeSequentiality(cases, corpusCases, summaryResults);
  const actualCorpusFileSha256 = sha256(Buffer.from(corpusText, 'utf8'));
  const summaryCounts = summary?.counts ?? {};
  const consistency = {
    corpusDocumentHashMatchesSummary: Boolean(corpus?.corpusSha256)
      && corpus.corpusSha256 === summary?.corpusSha256,
    corpusFileHashMatchesSummary: Boolean(summary?.corpusFileSha256)
      && actualCorpusFileSha256 === summary.corpusFileSha256,
    selectedCaseCountMatches: Number(summary?.selectedCaseCount) === corpusCases.length,
    completedResultCountMatches: Number(summary?.completedResultCount) === cases.filter((item) => item.loaded).length,
    outcomeCountsMatch: ['SUCCESS', 'EXPECTED_STOP', 'PARTIAL', 'FAILED'].every((outcome) => (
      Number(summaryCounts?.[outcome] ?? 0) === Number(counts[outcome] ?? 0)
    )),
    legacyAssertionBooleanRedactionCaseIds: cases
      .filter((item) => item.assertions.legacyBooleanRedaction)
      .map((item) => item.id),
    missingOrInvalidResultCaseIds: cases.filter((item) => !item.loaded && !item.pending).map((item) => item.id),
    pendingCaseIds: cases.filter((item) => item.pending && !item.loaded).map((item) => item.id)
  };
  consistency.allChecksPassed = Object.entries(consistency)
    .filter(([key]) => !key.endsWith('CaseIds') && key !== 'pendingCaseIds')
    .every(([, value]) => value === true)
    && consistency.legacyAssertionBooleanRedactionCaseIds.length === 0
    && consistency.missingOrInvalidResultCaseIds.length === 0;

  return {
    label,
    index,
    root,
    corpusPath,
    summaryPath,
    corpus,
    summary,
    cases,
    counts,
    sequentiality,
    consistency,
    actualCorpusFileSha256,
    correctionSet: compactCorrection(corpus?.correctionSet ?? summary?.correctionSet),
    verificationSummaries: verificationEvidence.summaries
  };
}

async function loadVerificationEvidence(root, caseIds) {
  const summaries = [];
  for (const name of await matchingFileNames(root, /^reverification-summary(?:-.+)?\.json$/u)) {
    const path = join(root, name);
    const document = parseJsonDocument(await readFile(path, 'utf8'), path);
    summaries.push({
      resultPath: relative(root, path).replaceAll('\\', '/'),
      reverifiedAt: validIso(document?.reverifiedAt),
      selectedCaseIds: (document?.selectedCaseIds ?? []).map(String),
      counts: document?.counts ?? null,
      allExpectedOutcomesPassed: document?.allExpectedOutcomesPassed === true,
      readOnly: isReadOnlyVerification(document?.executionPolicy),
      executionPolicy: compactValue(document?.executionPolicy, 0),
      correctionSet: compactCorrection(document?.specificationCorrection)
    });
  }
  summaries.sort(compareVerificationTime);

  const byCaseId = new Map();
  for (const id of caseIds) {
    const caseRoot = safeResolveInside(root, id);
    const records = [];
    for (const name of await matchingFileNames(caseRoot, /^result-reverified(?:-.+)?\.json$/u)) {
      const path = join(caseRoot, name);
      const document = parseJsonDocument(await readFile(path, 'utf8'), path);
      const rawOutcome = String(document?.outcome ?? '').toUpperCase();
      records.push({
        resultPath: relative(root, path).replaceAll('\\', '/'),
        reverifiedAt: validIso(document?.reverifiedAt),
        originalOutcome: recognizedOutcome(document?.originalOutcome),
        outcome: RECOGNIZED_OUTCOMES.has(rawOutcome) ? rawOutcome : 'FAILED',
        outcomeChanged: document?.outcomeChanged === true,
        validatorVersion: cleanText(document?.validatorVersion ?? null, 200),
        assertionEngineVersion: cleanText(document?.assertionEngineVersion ?? null, 200),
        readOnly: isReadOnlyVerification(document?.evidenceSource),
        executionPolicy: compactValue(document?.evidenceSource, 0),
        correctionSet: compactCorrection(document?.specificationCorrection)
      });
    }
    records.sort(compareVerificationTime);
    byCaseId.set(id, records);
  }
  return { summaries, byCaseId };
}

async function matchingFileNames(root, pattern) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((item) => item.isFile() && pattern.test(item.name))
      .map((item) => item.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function compareVerificationTime(left, right) {
  return (Date.parse(left?.reverifiedAt ?? '') || 0) - (Date.parse(right?.reverifiedAt ?? '') || 0)
    || String(left?.resultPath ?? '').localeCompare(String(right?.resultPath ?? ''));
}

function isReadOnlyVerification(policy) {
  return policy?.missionExecuted === false
    && policy?.externalCallsMade === false
    && policy?.emailActionsExecuted === false;
}

function compactCorrection(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    setId: cleanText(value.setId ?? null, 200),
    description: cleanText(value.description ?? null, 1000),
    appliedCaseIds: (value.appliedCaseIds ?? value.selectedAppliedCaseIds ?? []).map(String),
    definitionSha256: validSha256(value.definitionSha256) ? String(value.definitionSha256).toLowerCase() : null,
    sourceAlreadyCorrected: value.sourceAlreadyCorrected === true
  };
}

function recognizedOutcome(value) {
  const outcome = String(value ?? '').toUpperCase();
  return RECOGNIZED_OUTCOMES.has(outcome) ? outcome : null;
}

function buildCaseRecord({ id, corpusCase, summaryItem, result, resultPath, loadError, pending, runRoot, verifications }) {
  const loaded = Boolean(result && typeof result === 'object');
  const rawOutcome = String(result?.outcome ?? '').toUpperCase();
  const outcome = loaded
    ? (RECOGNIZED_OUTCOMES.has(rawOutcome) ? rawOutcome : 'FAILED')
    : (pending ? 'NOT_RUN' : 'FAILED');
  const assertions = summarizeAssertions(result?.assertions);
  const actions = summarizeActions(result?.mission, result?.tasks);
  const artifacts = summarizeArtifacts(result?.artifacts, corpusCase?.inputManifest);
  const latestVerification = verifications.at(-1) ?? null;
  const latestCorrectedVerification = verifications.filter((item) => item.correctionSet).at(-1) ?? null;
  const record = {
    id,
    displayId: displayCaseId(id),
    title: cleanText(corpusCase?.title ?? result?.title ?? summaryItem?.title ?? id, 300),
    category: cleanText(corpusCase?.category ?? result?.category ?? summaryItem?.category ?? 'unknown', 120),
    command: cleanText(corpusCase?.command ?? result?.command ?? '', 20_000),
    expectedStatus: cleanText(corpusCase?.expected?.status ?? result?.expectedStatus ?? null, 80),
    outcome,
    missionStatus: cleanText(result?.missionStatus ?? result?.mission?.status ?? summaryItem?.missionStatus ?? null, 80),
    stopReason: cleanText(result?.stopReason ?? result?.mission?.stopReason ?? null, 1000),
    startedAt: validIso(result?.startedAt),
    finishedAt: validIso(result?.finishedAt),
    durationMs: finiteNumber(result?.durationMs ?? summaryItem?.durationMs),
    loaded,
    pending: pending && !loaded,
    resultPath: relative(runRoot, resultPath).replaceAll('\\', '/'),
    loadError,
    assertions,
    artifacts,
    actions,
    rootCauses: [],
    diagnosticWarnings: [],
    controlledStop: null,
    email: summarizeCaseEmail(corpusCase, result, actions),
    correction: compactCorrection(corpusCase?.correction ?? result?.correction),
    verifications,
    latestVerification,
    latestCorrectedVerification,
    effectiveVerification: latestCorrectedVerification ?? latestVerification
  };
  const diagnosis = diagnoseCase(record, result);
  record.rootCauses = diagnosis.rootCauses;
  record.diagnosticWarnings = diagnosis.warnings;
  record.controlledStop = diagnosis.controlledStop;
  return record;
}

function summarizeAssertions(rawAssertions) {
  const items = (Array.isArray(rawAssertions) ? rawAssertions : []).map((item, index) => {
    const rawPass = item?.pass;
    const state = rawPass === true ? 'PASS' : rawPass === false ? 'FAIL' : 'UNKNOWN';
    return {
      index: index + 1,
      check: cleanText(item?.check ?? `assertion-${index + 1}`, 1000),
      state,
      details: compactValue(item?.details, 0)
    };
  });
  return {
    total: items.length,
    passed: items.filter((item) => item.state === 'PASS').length,
    failed: items.filter((item) => item.state === 'FAIL').length,
    unknown: items.filter((item) => item.state === 'UNKNOWN').length,
    legacyBooleanRedaction: items.some((item) => item.state === 'UNKNOWN')
      && (rawAssertions ?? []).some((item) => item?.pass === '[redacted]'),
    failedItems: items.filter((item) => item.state === 'FAIL'),
    unknownItems: items.filter((item) => item.state === 'UNKNOWN')
  };
}

function summarizeActions(mission, tasks) {
  const actions = [];
  for (const [waveIndex, wave] of (mission?.waves ?? []).entries()) {
    for (const [actionIndex, action] of (wave?.actions ?? []).entries()) {
      const expectedToolName = cleanText(action?.expectedToolName ?? null, 160);
      const actualToolName = cleanText(action?.actualToolName ?? null, 160);
      actions.push({
        wave: Number(wave?.waveIndex ?? waveIndex + 1),
        order: Number(action?.order ?? actionIndex + 1),
        actionId: cleanText(action?.actionId ?? null, 300),
        command: cleanText(action?.command ?? action?.title ?? '', 1500),
        status: cleanText(action?.status ?? 'unknown', 80),
        expectedToolName,
        actualToolName,
        authorizationMode: cleanText(action?.authorizationMode ?? null, 120),
        routeMismatch: Boolean(expectedToolName && actualToolName && expectedToolName !== actualToolName),
        error: normalizeError(action?.error),
        attempts: finiteNumber(action?.attempts),
        emailShape: isEmailAction(action) ? summarizeEmailArguments(action?.arguments) : null
      });
    }
  }
  const taskFailures = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && task.status && String(task.status).toUpperCase() !== 'COMPLETED')
    .map((task) => ({
      taskId: cleanText(task.taskId, 300),
      status: cleanText(task.status, 80),
      error: normalizeError(task.error ?? task.execution?.error ?? task.execution?.result?.error),
      toolName: cleanText(task.execution?.toolName ?? task.execution?.result?.toolName ?? null, 160)
    }));
  return {
    total: actions.length,
    succeeded: actions.filter((item) => String(item.status).toLowerCase() === 'succeeded').length,
    failed: actions.filter((item) => FAILED_ACTION_STATUSES.has(String(item.status).toLowerCase())).length,
    routeMismatchCount: actions.filter((item) => item.routeMismatch).length,
    items: actions,
    taskFailures
  };
}

function summarizeArtifacts(rawArtifacts, inputManifest) {
  const inputPaths = new Set(Object.keys(inputManifest ?? {}).map(normalizeRelativePath));
  return (Array.isArray(rawArtifacts) ? rawArtifacts : []).map((artifact) => {
    const path = normalizeRelativePath(artifact?.path);
    return {
      path,
      role: inputPaths.has(path) ? 'input' : 'output',
      size: finiteNumber(artifact?.size),
      sha256: validSha256(artifact?.sha256) ? String(artifact.sha256).toLowerCase() : null
    };
  });
}

function summarizeCaseEmail(corpusCase, result, actionsSummary) {
  const expected = Boolean(corpusCase?.expected?.email);
  const explicitlyAllowed = corpusCase?.allowExternalSend === true && expected;
  const emailActions = actionsSummary.items.filter((item) => (
    item.expectedToolName === 'email.send' || item.actualToolName === 'email.send'
  ));
  const successfulEmailActions = emailActions.filter((item) => String(item.status).toLowerCase() === 'succeeded');
  const observations = (result?.mission?.observations ?? [])
    .filter((item) => item?.toolName === 'email.send')
    .map((item) => ({
      outcome: cleanText(item?.outcome ?? null, 80),
      passed: item?.data?.email?.passed === true,
      providerAccepted: item?.data?.email?.providerAccepted === true,
      recipientMatched: item?.data?.email?.recipientMatched === true,
      acceptedRecipientCount: finiteNumber(item?.data?.email?.acceptedRecipientCount),
      rejectedRecipientCount: finiteNumber(item?.data?.email?.rejectedRecipientCount),
      attachmentCount: finiteNumber(item?.data?.email?.attachmentCount),
      attachmentSha256s: (Array.isArray(item?.data?.email?.attachmentSha256s)
        ? item.data.email.attachmentSha256s
        : []).filter(validSha256).map(String),
      providerMessageIdSha256: validSha256(item?.data?.email?.providerMessageIdSha256)
        ? String(item.data.email.providerMessageIdSha256)
        : null,
      deduplicated: item?.data?.email?.deduplicated === true
    }));
  return {
    expected,
    explicitlyAllowed,
    expectedSubjectMarker: cleanText(corpusCase?.expected?.email?.subjectContains ?? null, 300),
    expectedAttachmentCount: finiteNumber(corpusCase?.expected?.email?.attachmentCount),
    actionCount: emailActions.length,
    succeededActionCount: successfulEmailActions.length,
    trustedSelfAuthorizationCount: successfulEmailActions.filter((item) => item.authorizationMode === 'trusted-owner-self-email').length,
    exactHashBoundActionCount: successfulEmailActions.filter((item) => item.emailShape?.exactHashBound === true).length,
    recipientModeViolationCount: successfulEmailActions.filter((item) => item.emailShape?.recipientModeSelf === false).length,
    recipientModeUnknownCount: successfulEmailActions.filter((item) => item.emailShape?.recipientModeKnown !== true).length,
    observations,
    providerAccepted: observations.some((item) => item.providerAccepted),
    recipientMatched: observations.some((item) => item.recipientMatched),
    providerVerificationPassed: observations.some((item) => item.passed),
    deduplicated: observations.some((item) => item.deduplicated),
    attachmentCounts: [...new Set(observations.map((item) => item.attachmentCount).filter(Number.isFinite))],
    inboxPlacementProven: false,
    readReceiptProven: false
  };
}

function summarizeEmailArguments(args) {
  if (!args || typeof args !== 'object') {
    return { recipientModeKnown: false, recipientModeSelf: false, attachmentCount: null, exactHashBound: false };
  }
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const recipientMode = String(args.recipientMode ?? '').toLowerCase();
  const to = String(args.to ?? '').trim().toLowerCase();
  const exactHashBound = attachments.length > 0 && attachments.every((attachment) => {
    const ref = attachment?.attachmentRef ?? attachment?.ref;
    const hash = attachment?.attachmentSha256 ?? attachment?.contentSha256 ?? attachment?.sha256;
    return Number.isInteger(Number(ref?.rootIndex))
      && String(ref?.relativePath ?? '').trim().length > 0
      && validSha256(hash);
  });
  return {
    recipientModeKnown: true,
    recipientModeSelf: recipientMode === 'self' && (!to || to === 'self'),
    attachmentCount: attachments.length,
    exactHashBound
  };
}

function diagnoseCase(record, result) {
  const rootCauses = [];
  const warnings = [];
  const add = (id, evidence, source = 'result') => {
    if (!CAUSE_CATALOG[id]) return;
    const normalizedEvidence = cleanText(evidence, 2000);
    const existing = rootCauses.find((item) => item.id === id);
    if (existing) {
      if (normalizedEvidence && !existing.evidence.includes(normalizedEvidence)) existing.evidence.push(normalizedEvidence);
      return;
    }
    rootCauses.push({ id, ...CAUSE_CATALOG[id], sources: [source], evidence: normalizedEvidence ? [normalizedEvidence] : [] });
  };

  if (!record.loaded && !record.pending) {
    add('RESULT_RECORD_MISSING_OR_INVALID', errorText(record.loadError), 'result-loader');
  }
  if (result?.error) add('RUNNER_OR_RUNTIME_EXCEPTION', errorText(result.error), 'result.error');

  for (const action of record.actions.items) {
    if (action.routeMismatch) {
      add('ROUTE_MISMATCH', `wave ${action.wave} action ${action.order}: ${action.expectedToolName} -> ${action.actualToolName}; ${action.command}`, 'mission.action');
    }
    if (FAILED_ACTION_STATUSES.has(String(action.status).toLowerCase())) {
      add('ACTION_EXECUTION_FAILURE', `wave ${action.wave} action ${action.order} (${action.status}): ${action.command}${action.error ? `; ${errorText(action.error)}` : ''}`, 'mission.action');
    }
  }
  for (const task of record.actions.taskFailures) {
    add('ACTION_EXECUTION_FAILURE', `task ${task.taskId ?? 'unknown'} (${task.status}): ${errorText(task.error) || task.toolName || '오류 상세 없음'}`, 'task');
  }

  for (const observation of (result?.mission?.observations ?? []).filter((item) => item?.outcome === 'failed')) {
    const text = `${errorText(observation?.error)} ${cleanText(observation?.summary, 1000)}`.trim();
    if (/A_MISSION_COMPLETION_EVIDENCE_INSUFFICIENT|completion.*evidence|criterion_/iu.test(text)) {
      add('COMPLETION_EVIDENCE_GAP', text, 'mission.observation');
    } else if (/timeout|timed out|deadline|budget|max(?:imum)? (?:wave|action|planner)|시간.*초과|예산/iu.test(text)) {
      add('TIME_OR_BUDGET_LIMIT', text, 'mission.observation');
    } else if (/approval|policy|gate|승인|정책/iu.test(text)) {
      add('APPROVAL_OR_POLICY_GATE', text, 'mission.observation');
    } else {
      add('MISSION_OBSERVATION_FAILURE', text, 'mission.observation');
    }
  }

  const stopReason = String(record.stopReason ?? '');
  if (/repeated-plan-stall|plan.*stall/iu.test(stopReason)) {
    add('MISSION_PLANNER_STALL', stopReason, 'mission.stopReason');
  } else if (/repeated-failure-stall/iu.test(stopReason)) {
    add('ACTION_EXECUTION_FAILURE', stopReason, 'mission.stopReason');
  } else if (/timeout|timed.out|deadline|budget|max.*(?:wave|action|planner)|시간.*초과|예산/iu.test(stopReason)) {
    add('TIME_OR_BUDGET_LIMIT', stopReason, 'mission.stopReason');
  } else if (/approval|policy|gate|승인|정책/iu.test(stopReason)) {
    add('APPROVAL_OR_POLICY_GATE', stopReason, 'mission.stopReason');
  } else if (stopReason && !PASSING_OUTCOMES.has(record.outcome)) {
    add('MISSION_STOP_REASON', stopReason, 'mission.stopReason');
  }

  for (const failed of record.assertions.failedItems) {
    const check = String(failed.check ?? '');
    if (/input bytes unchanged/iu.test(check)) {
      add('INPUT_IMMUTABILITY_VIOLATION', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    } else if (/web evidence|live web|unique URL|domain/iu.test(check)) {
      add('LIVE_WEB_EVIDENCE_GAP', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    } else if (/email|SMTP|external send|recipient|attachment.*hash/iu.test(check)) {
      add('EMAIL_DELIVERY_OR_INTEGRITY_GAP', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    } else if (/expected stop reports/iu.test(check)) {
      add('EXPECTED_STOP_EXPLANATION_GAP', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    } else if (/file exists|valid .*container|contains:|absent:|workbook|sheet|slide count|PNG|ZIP|path remains absent/iu.test(check)) {
      add('ARTIFACT_ACCEPTANCE_MISMATCH', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    } else if (!/mission status matches/iu.test(check)) {
      add('ACCEPTANCE_ASSERTION_FAILURE', `${check}: ${compactDetailsText(failed.details)}`, 'assertion');
    }
  }

  if (record.assertions.legacyBooleanRedaction) {
    warnings.push({
      id: 'LEGACY_ASSERTION_BOOLEAN_REDACTED',
      message: '구버전 결과에서 assertions[].pass가 [redacted]로 저장되어 개별 검사 통과·실패 수를 추정하지 않았습니다.'
    });
  }
  if (record.email.providerAccepted && !PASSING_OUTCOMES.has(record.outcome)) {
    warnings.push({
      id: 'EMAIL_ACCEPTED_DESPITE_NONPASSING_MISSION',
      message: 'SMTP 제공자 수락은 확인됐지만 전체 미션은 성공으로 판정되지 않았습니다. 동일 발송을 다시 보내면 안 됩니다.'
    });
  }
  if (record.email.succeededActionCount > 1) {
    warnings.push({ id: 'MULTIPLE_SUCCESSFUL_EMAIL_ACTIONS', message: `성공한 email.send 액션이 ${record.email.succeededActionCount}개입니다.` });
  }
  if (record.outcome === 'EXPECTED_STOP') {
    return {
      rootCauses: [],
      warnings,
      controlledStop: {
        expected: true,
        missionStatus: record.missionStatus,
        stopReason: record.stopReason,
        meaning: '필수 입력 또는 허용 범위가 충족되지 않아 결과를 날조하지 않고 정지한 성공 사례'
      }
    };
  }
  if (!PASSING_OUTCOMES.has(record.outcome) && rootCauses.length === 0) {
    add('UNCLASSIFIED_FAILURE', `outcome=${record.outcome}, missionStatus=${record.missionStatus ?? 'null'}`, 'classification');
  }
  return { rootCauses, warnings, controlledStop: null };
}

function buildRootCauseClusters(initialRun, retestLinks) {
  const clusterMap = new Map();
  const linkById = new Map(retestLinks.map((item) => [item.id, item]));
  for (const item of initialRun.cases.filter((entry) => !PASSING_OUTCOMES.has(entry.outcome) && entry.outcome !== 'NOT_RUN')) {
    for (const cause of item.rootCauses) {
      const cluster = clusterMap.get(cause.id) ?? {
        id: cause.id,
        label: cause.label,
        severity: cause.severity,
        description: cause.description,
        solution: cause.solution,
        caseIds: [],
        evidence: []
      };
      if (!cluster.caseIds.includes(item.id)) cluster.caseIds.push(item.id);
      for (const evidence of cause.evidence) {
        cluster.evidence.push({ caseId: item.id, displayId: item.displayId, detail: evidence });
      }
      clusterMap.set(cause.id, cluster);
    }
  }
  return [...clusterMap.values()].map((cluster) => {
    const states = cluster.caseIds.map((id) => linkById.get(id)?.change ?? 'NOT_RETESTED');
    const resolvedCount = states.filter((item) => item === 'RESOLVED').length;
    const stillFailingCount = states.filter((item) => item === 'STILL_FAILING').length;
    const notRetestedCount = states.filter((item) => item === 'NOT_RETESTED').length;
    return {
      ...cluster,
      caseIds: sortCaseIds(cluster.caseIds),
      retestDisposition: {
        status: stillFailingCount > 0 ? 'UNRESOLVED'
          : resolvedCount === cluster.caseIds.length ? 'RESOLVED'
            : resolvedCount > 0 ? 'PARTIALLY_RESOLVED'
              : 'NOT_RETESTED',
        resolvedCount,
        stillFailingCount,
        notRetestedCount
      }
    };
  }).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
}

function buildRetestLinks(initialRun, retestRuns) {
  const initialById = new Map(initialRun.cases.map((item) => [item.id, item]));
  const retestMaps = retestRuns.map((run) => new Map(run.cases.map((item) => [item.id, item])));
  const ids = new Set(initialRun.cases
    .filter((item) => !PASSING_OUTCOMES.has(item.outcome)
      || item.latestCorrectedVerification
      || retestMaps.some((map) => map.has(item.id)))
    .map((item) => item.id));
  for (const map of retestMaps) for (const id of map.keys()) ids.add(id);

  return sortCaseIds([...ids]).map((id) => {
    const initial = initialById.get(id) ?? null;
    const retestSteps = retestRuns.map((run, runIndex) => {
      const item = retestMaps[runIndex].get(id);
      return item ? publicRetestStep(run, item) : null;
    }).filter(Boolean);
    const latest = retestSteps.at(-1) ?? null;
    const initialStep = initial ? publicRetestStep(initialRun, initial) : null;
    const initialPassing = initial ? PASSING_OUTCOMES.has(initial.outcome) : false;
    const latestPassing = latest ? PASSING_OUTCOMES.has(latest.outcome) : false;
    let change = 'NOT_RETESTED';
    if (latest) {
      if (!initialPassing && latestPassing) change = 'RESOLVED';
      else if (!initialPassing && !latestPassing) change = 'STILL_FAILING';
      else if (initialPassing && !latestPassing) change = 'REGRESSION';
      else change = 'STABLE_PASS';
    }
    const verificationSource = latest ?? initialStep;
    const effectiveVerification = verificationSource?.effectiveVerification ?? null;
    const effectiveOutcome = effectiveVerification?.outcome ?? verificationSource?.outcome ?? null;
    const sourcePassing = verificationSource ? PASSING_OUTCOMES.has(verificationSource.outcome) : false;
    const effectivePassing = effectiveOutcome ? PASSING_OUTCOMES.has(effectiveOutcome) : false;
    let readOnlyVerificationChange = 'NOT_REVERIFIED';
    if (effectiveVerification) {
      if (!sourcePassing && effectivePassing) readOnlyVerificationChange = 'RESOLVED_BY_READ_ONLY_REVERIFY';
      else if (sourcePassing && !effectivePassing) readOnlyVerificationChange = 'REGRESSION_IN_READ_ONLY_REVERIFY';
      else readOnlyVerificationChange = 'UNCHANGED_BY_READ_ONLY_REVERIFY';
    }
    return {
      id,
      displayId: displayCaseId(id),
      title: initial?.title ?? retestSteps[0]?.title ?? id,
      initial: initialStep,
      retests: retestSteps,
      latest: latest ? {
        runLabel: latest.runLabel,
        outcome: latest.outcome,
        missionStatus: latest.missionStatus,
        latestVerification: latest.latestVerification,
        latestCorrectedVerification: latest.latestCorrectedVerification,
        effectiveVerification: latest.effectiveVerification
      } : null,
      change,
      actualExecutionChange: change,
      readOnlyVerificationChange,
      verificationSourceRunLabel: verificationSource?.runLabel ?? null,
      latestVerification: verificationSource?.latestVerification ?? null,
      latestCorrectedVerification: verificationSource?.latestCorrectedVerification ?? null,
      effectiveVerification,
      initialCauseIds: initial?.rootCauses.map((item) => item.id) ?? [],
      latestCauseIds: latest?.rootCauseIds ?? []
    };
  });
}

function buildClosureAssessment(initialRun, retestLinks) {
  const linkById = new Map(retestLinks.map((item) => [item.id, item]));
  const counts = { SUCCESS: 0, EXPECTED_STOP: 0, HISTORICAL_PARTIAL: 0, FAILED: 0 };
  const evidenceBasisCounts = {
    IMMUTABLE_BASELINE: 0,
    ACTUAL_RERUN: 0,
    READ_ONLY_REVERIFICATION: 0,
    HISTORICAL_NONPASSING_EXECUTION: 0
  };
  const cases = initialRun.cases.map((item) => {
    const link = linkById.get(item.id) ?? null;
    const latestActualOutcome = link?.latest?.outcome ?? item.outcome;
    const effectiveOutcome = link?.effectiveVerification?.outcome ?? latestActualOutcome;
    let finalOutcome = 'FAILED';
    if (effectiveOutcome === 'SUCCESS') finalOutcome = 'SUCCESS';
    else if (effectiveOutcome === 'EXPECTED_STOP') finalOutcome = 'EXPECTED_STOP';
    else if (effectiveOutcome === 'PARTIAL') finalOutcome = 'HISTORICAL_PARTIAL';

    let evidenceBasis = 'IMMUTABLE_BASELINE';
    if (finalOutcome === 'HISTORICAL_PARTIAL' || finalOutcome === 'FAILED') {
      evidenceBasis = 'HISTORICAL_NONPASSING_EXECUTION';
    } else if (link?.effectiveVerification && !PASSING_OUTCOMES.has(latestActualOutcome) && PASSING_OUTCOMES.has(effectiveOutcome)) {
      evidenceBasis = 'READ_ONLY_REVERIFICATION';
    } else if (link?.latest && PASSING_OUTCOMES.has(latestActualOutcome)) {
      evidenceBasis = 'ACTUAL_RERUN';
    } else if (link?.effectiveVerification) {
      evidenceBasis = 'READ_ONLY_REVERIFICATION';
    }

    counts[finalOutcome] += 1;
    evidenceBasisCounts[evidenceBasis] += 1;
    return {
      id: item.id,
      displayId: item.displayId,
      title: item.title,
      baselineOutcome: item.outcome,
      latestActualOutcome,
      effectiveOutcome,
      finalOutcome,
      evidenceBasis,
      actualRerunCount: link?.retests?.length ?? 0,
      readOnlyVerificationUsed: evidenceBasis === 'READ_ONLY_REVERIFICATION'
    };
  });

  return {
    interpretation: '종합 판정은 최초 실행을 변경하지 않고, 별도 실제 재시험과 저장된 산출물의 읽기 전용 재검증을 연결한 종료 상태다.',
    counts,
    evidenceBasisCounts,
    goalSatisfiedCount: counts.SUCCESS + counts.EXPECTED_STOP,
    totalCaseCount: cases.length,
    historicalPartialCaseIds: cases.filter((item) => item.finalOutcome === 'HISTORICAL_PARTIAL').map((item) => item.id),
    failedCaseIds: cases.filter((item) => item.finalOutcome === 'FAILED').map((item) => item.id),
    cases
  };
}

function publicRetestStep(run, item) {
  return {
    runLabel: run.label,
    runRoot: run.root,
    evidenceKind: run.label === 'initial' ? 'INITIAL_EXECUTION' : 'ACTUAL_RERUN',
    id: item.id,
    title: item.title,
    outcome: item.outcome,
    missionStatus: item.missionStatus,
    durationMs: item.durationMs,
    resultPath: item.resultPath,
    rootCauseIds: item.rootCauses.map((cause) => cause.id),
    correctionSet: run.correctionSet ?? item.correction,
    verifications: item.verifications,
    latestVerification: item.latestVerification,
    latestCorrectedVerification: item.latestCorrectedVerification,
    effectiveVerification: item.effectiveVerification
  };
}

function buildSecurityAndEmail(initialRun, retestRuns) {
  const runs = [initialRun, ...retestRuns];
  const cases = runs.flatMap((run) => run.cases.map((item) => ({ runLabel: run.label, ...item.email, id: item.id, displayId: item.displayId, outcome: item.outcome })));
  const withEmailEvidence = cases.filter((item) => item.expected || item.actionCount > 0 || item.observations.length > 0);
  const unauthorizedSuccessful = cases.filter((item) => !item.explicitlyAllowed && item.succeededActionCount > 0);
  const recipientModeViolations = cases.filter((item) => item.recipientModeViolationCount > 0);
  const duplicateSuccessful = cases.filter((item) => item.succeededActionCount > 1);
  return {
    policy: {
      permittedExternalDestination: 'authenticated owner self Gmail only for corpus cases explicitly marked allowExternalSend',
      arbitraryRecipientsPermitted: false,
      exactAttachmentReferenceAndSha256Required: true,
      durableIdempotencyRequired: true
    },
    initialAuthorizedEmailCaseIds: initialRun.cases.filter((item) => item.email.explicitlyAllowed).map((item) => item.id),
    records: withEmailEvidence.map((item) => ({
      runLabel: item.runLabel,
      id: item.id,
      displayId: item.displayId,
      outcome: item.outcome,
      expected: item.expected,
      explicitlyAllowed: item.explicitlyAllowed,
      actionCount: item.actionCount,
      succeededActionCount: item.succeededActionCount,
      trustedSelfAuthorizationCount: item.trustedSelfAuthorizationCount,
      exactHashBoundActionCount: item.exactHashBoundActionCount,
      expectedAttachmentCount: item.expectedAttachmentCount,
      observedAttachmentCounts: item.attachmentCounts,
      providerAccepted: item.providerAccepted,
      recipientMatched: item.recipientMatched,
      providerVerificationPassed: item.providerVerificationPassed,
      providerMessageIdHashPresent: item.observations.some((entry) => validSha256(entry.providerMessageIdSha256)),
      deduplicated: item.deduplicated,
      inboxPlacementProven: false,
      readReceiptProven: false
    })),
    violations: {
      unauthorizedSuccessfulSendCaseIds: unauthorizedSuccessful.map((item) => `${item.runLabel}:${item.id}`),
      recipientModeViolationCaseIds: recipientModeViolations.map((item) => `${item.runLabel}:${item.id}`),
      multipleSuccessfulSendCaseIds: duplicateSuccessful.map((item) => `${item.runLabel}:${item.id}`)
    },
    evidenceBoundary: {
      smtpProviderAcceptanceIsTransportEvidence: true,
      inboxPlacementIsProven: false,
      messageOpenOrReadIsProven: false,
      explanation: 'SMTP provider acceptance proves that the provider accepted the envelope recipient. It does not prove inbox placement, message opening, or reading.'
    }
  };
}

function analyzeSequentiality(cases, corpusCases, summaryResults) {
  const loaded = cases.filter((item) => item.loaded);
  const corpusOrder = corpusCases.map((item) => String(item.id));
  const summaryOrder = summaryResults.map((item) => String(item.id));
  const resultOrder = loaded.map((item) => item.id);
  const expectedCompletedOrder = corpusOrder.filter((id) => resultOrder.includes(id));
  const boundaries = [];
  for (let index = 1; index < loaded.length; index += 1) {
    const previous = loaded[index - 1];
    const current = loaded[index];
    const previousFinishedMs = Date.parse(previous.finishedAt ?? '');
    const currentStartedMs = Date.parse(current.startedAt ?? '');
    const comparable = Number.isFinite(previousFinishedMs) && Number.isFinite(currentStartedMs);
    boundaries.push({
      previousCaseId: previous.id,
      nextCaseId: current.id,
      previousFinishedAt: previous.finishedAt,
      nextStartedAt: current.startedAt,
      comparable,
      overlapMs: comparable ? Math.max(0, previousFinishedMs - currentStartedMs) : null,
      ordered: comparable ? currentStartedMs >= previousFinishedMs : null
    });
  }
  const timestampComplete = loaded.every((item) => item.startedAt && item.finishedAt);
  const intervalValid = loaded.every((item) => {
    const start = Date.parse(item.startedAt ?? '');
    const finish = Date.parse(item.finishedAt ?? '');
    return Number.isFinite(start) && Number.isFinite(finish) && finish >= start;
  });
  const overlaps = boundaries.filter((item) => item.overlapMs > 0);
  const orderMatchesCorpus = arraysEqual(resultOrder, expectedCompletedOrder);
  const orderMatchesSummary = arraysEqual(resultOrder, summaryOrder.filter((id) => resultOrder.includes(id)));
  let verdict = 'INSUFFICIENT_SAMPLE';
  if (loaded.length > 1) {
    verdict = overlaps.length > 0 ? 'CONTRADICTED'
      : timestampComplete && intervalValid && orderMatchesCorpus && orderMatchesSummary ? 'SUPPORTED'
        : 'PARTIAL';
  }
  const starts = loaded.map((item) => Date.parse(item.startedAt ?? '')).filter(Number.isFinite);
  const finishes = loaded.map((item) => Date.parse(item.finishedAt ?? '')).filter(Number.isFinite);
  const totalDurationMs = loaded.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  return {
    verdict,
    loadedResultCount: loaded.length,
    orderMatchesCorpus,
    orderMatchesSummary,
    timestampComplete,
    intervalValid,
    overlapCount: overlaps.length,
    overlaps,
    boundaries,
    corpusOrderSha256: sha256(Buffer.from(corpusOrder.join('\n'), 'utf8')),
    resultOrderSha256: sha256(Buffer.from(resultOrder.join('\n'), 'utf8')),
    totalRecordedDurationMs: totalDurationMs,
    wallClockSpanMs: starts.length && finishes.length ? Math.max(...finishes) - Math.min(...starts) : null,
    evidenceStatement: verdict === 'SUPPORTED'
      ? '저장된 결과 순서가 고정 코퍼스 및 summary 순서와 같고, 모든 인접 사례의 실행 시간 구간이 겹치지 않습니다.'
      : verdict === 'CONTRADICTED'
        ? '하나 이상의 실행 시간 구간이 겹쳐 순차 실행 주장과 충돌합니다.'
        : verdict === 'PARTIAL'
          ? '일부 순서 또는 타임스탬프 증거가 없어 순차 실행을 완전히 입증할 수 없습니다.'
          : '결과가 한 개 이하라 다중 사례 순차성을 판단할 수 없습니다.'
  };
}

function publicRun(run) {
  return {
    label: run.label,
    root: run.root,
    summaryVersion: cleanText(run.summary?.summaryVersion ?? null, 200),
    updatedAt: validIso(run.summary?.updatedAt),
    corpusSha256: validSha256(run.summary?.corpusSha256) ? run.summary.corpusSha256 : cleanText(run.summary?.corpusSha256 ?? null, 200),
    corpusFileSha256: validSha256(run.summary?.corpusFileSha256) ? run.summary.corpusFileSha256 : cleanText(run.summary?.corpusFileSha256 ?? null, 200),
    selectedCaseCount: finiteNumber(run.summary?.selectedCaseCount),
    completedResultCount: finiteNumber(run.summary?.completedResultCount),
    pendingCaseIds: (run.summary?.pendingCaseIds ?? []).map(String),
    counts: run.counts,
    reportedCounts: run.summary?.counts ?? null,
    allExpectedOutcomesPassed: run.summary?.allExpectedOutcomesPassed === true,
    evidenceKind: run.label === 'initial' ? 'IMMUTABLE_BASELINE_EXECUTION' : 'ACTUAL_RERUN',
    correctionSet: run.correctionSet,
    verificationSummaries: run.verificationSummaries,
    corpusIntegrity: {
      actualCorpusFileSha256: run.actualCorpusFileSha256,
      documentMatchesSummary: run.consistency.corpusDocumentHashMatchesSummary,
      fileMatchesSummary: run.consistency.corpusFileHashMatchesSummary
    },
    consistency: run.consistency,
    sequentiality: run.sequentiality,
    cases: run.cases.map(publicCase)
  };
}

function publicCase(item) {
  return {
    id: item.id,
    displayId: item.displayId,
    title: item.title,
    category: item.category,
    command: item.command,
    expectedStatus: item.expectedStatus,
    outcome: item.outcome,
    missionStatus: item.missionStatus,
    stopReason: item.stopReason,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    durationMs: item.durationMs,
    loaded: item.loaded,
    pending: item.pending,
    resultPath: item.resultPath,
    loadError: item.loadError,
    assertions: item.assertions,
    artifacts: item.artifacts,
    actions: {
      total: item.actions.total,
      succeeded: item.actions.succeeded,
      failed: item.actions.failed,
      routeMismatchCount: item.actions.routeMismatchCount,
      failures: item.actions.items.filter((action) => FAILED_ACTION_STATUSES.has(String(action.status).toLowerCase())),
      routeMismatches: item.actions.items.filter((action) => action.routeMismatch),
      taskFailures: item.actions.taskFailures
    },
    rootCauses: item.rootCauses,
    diagnosticWarnings: item.diagnosticWarnings,
    controlledStop: item.controlledStop,
    email: item.email,
    correction: item.correction,
    verifications: item.verifications,
    latestVerification: item.latestVerification,
    latestCorrectedVerification: item.latestCorrectedVerification,
    effectiveVerification: item.effectiveVerification
  };
}

function countOutcomes(cases) {
  const counts = { SUCCESS: 0, EXPECTED_STOP: 0, PARTIAL: 0, FAILED: 0, NOT_RUN: 0 };
  for (const item of cases) counts[Object.hasOwn(counts, item.outcome) ? item.outcome : 'FAILED'] += 1;
  return counts;
}

function buildExecutionTotals(run) {
  const actionItems = run.cases.flatMap((item) => item.actions.items);
  const taskFailures = run.cases.flatMap((item) => item.actions.taskFailures);
  const actionStatusCounts = countNormalizedStatuses(actionItems.map((item) => item.status));
  const taskFailureStatusCounts = countNormalizedStatuses(taskFailures.map((item) => item.status));
  const succeededActionCount = actionStatusCounts.SUCCEEDED ?? 0;
  return {
    actionCount: actionItems.length,
    succeededActionCount,
    nonSucceededActionCount: actionItems.length - succeededActionCount,
    actionStatusCounts,
    linkedNonCompletedTaskCount: taskFailures.length,
    linkedNonCompletedTaskStatusCounts: taskFailureStatusCounts
  };
}

function countNormalizedStatuses(statuses) {
  const counts = {};
  for (const status of statuses) {
    const key = String(status ?? 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function renderReport(data) {
  const run = data.initialRun;
  const lines = [];
  lines.push('# JARVIS 복합 워크플로 50개 실전 감사 보고서', '');
  lines.push(`- 생성 시각: ${formatTimestamp(data.generatedAt)}`);
  lines.push(`- 최초 실행 루트: \`${markdownInline(run.root)}\``);
  lines.push(`- 고정 코퍼스: ${run.selectedCaseCount ?? run.cases.length}개 선택 / SHA-256 \`${shortHash(run.corpusSha256)}\``);
  lines.push(`- 결과 기록: ${run.completedResultCount ?? run.cases.filter((item) => item.loaded).length}개 완료, ${run.pendingCaseIds.length}개 대기`);
  lines.push('');
  lines.push('이 보고서는 최초 실행 결과를 그대로 기준선으로 보존하고, 수정 후 재시험이 있으면 별도 실행 루트의 결과를 연결한다. `SUCCESS`는 미션 완료와 모든 독립 검증 통과, `EXPECTED_STOP`은 필요한 입력이나 권한이 없을 때 결과를 날조하지 않고 의도대로 멈춘 경우, `PARTIAL`은 일부 작업 또는 검증만 성공한 경우, `FAILED`는 유효한 성공 근거가 없는 경우다.', '');

  lines.push('## 전체 결과', '');
  lines.push('| 구분 | 건수 | 의미 |', '|---|---:|---|');
  for (const outcome of ['SUCCESS', 'EXPECTED_STOP', 'PARTIAL', 'FAILED', 'NOT_RUN']) {
    lines.push(`| ${outcomeLabel(outcome)} | ${run.counts[outcome] ?? 0} | ${outcomeMeaning(outcome)} |`);
  }
  const passed = (run.counts.SUCCESS ?? 0) + (run.counts.EXPECTED_STOP ?? 0);
  const denominator = ['SUCCESS', 'EXPECTED_STOP', 'PARTIAL', 'FAILED'].reduce((sum, key) => sum + (run.counts[key] ?? 0), 0);
  lines.push('', `의도된 결과 통과율은 **${passed}/${denominator || 0}${denominator ? ` (${((passed / denominator) * 100).toFixed(1)}%)` : ''}**다. 안전 정지는 실제 작업 성공과 구분해 집계했다.`, '');
  lines.push('위 수치는 최초 `result.json` 50개의 불변 기준선이다. 이후 읽기 전용 재검증이나 재시험 결과로 덮어쓰지 않는다.', '');

  const closure = data.closureAssessment;
  lines.push('## 수정 후 종합 판정', '');
  lines.push('아래 수치는 최초 실행을 바꾸지 않고, 별도 실제 재시험과 저장된 산출물의 읽기 전용 재검증을 연결한 종료 판정이다. 읽기 전용 재검증 통과는 저장된 결과를 다시 판정한 것이며 새 미션이나 외부 작업을 실행했다는 뜻이 아니다.', '');
  lines.push('| 구분 | 건수 | 의미 |', '|---|---:|---|');
  for (const outcome of ['SUCCESS', 'EXPECTED_STOP', 'HISTORICAL_PARTIAL', 'FAILED']) {
    lines.push(`| ${closureOutcomeLabel(outcome)} | ${closure.counts[outcome] ?? 0} | ${closureOutcomeMeaning(outcome)} |`);
  }
  lines.push('', `요구 결과가 충족된 종합 판정은 **${closure.goalSatisfiedCount}/${closure.totalCaseCount}**이며, 정상 성공과 의도된 안전 정지를 분리했다.`, '');
  if (closure.historicalPartialCaseIds.length) {
    lines.push(`역사적 전체 흐름 부분 성공은 ${closure.historicalPartialCaseIds.map(displayCaseId).join(', ')}다. 이 사례들은 현재 저장된 전체 실행 판정이 여전히 PARTIAL이다. 이미 수행된 외부 부작용을 중복하지 않기 위해 제품 수정의 로컬·계약 검증과 과거 전체 흐름 판정을 구분한다.`, '');
  }
  lines.push(`- 최초 불변 기준선 근거: ${closure.evidenceBasisCounts.IMMUTABLE_BASELINE ?? 0}건`);
  lines.push(`- 별도 실제 재시험 통과 근거: ${closure.evidenceBasisCounts.ACTUAL_RERUN ?? 0}건`);
  lines.push(`- 읽기 전용 재검증 근거: ${closure.evidenceBasisCounts.READ_ONLY_REVERIFICATION ?? 0}건`);
  lines.push(`- 역사적 비통과 실행 보존: ${closure.evidenceBasisCounts.HISTORICAL_NONPASSING_EXECUTION ?? 0}건`, '');

  lines.push('## 읽기 전용 재검증 증거', '');
  const verificationRows = [run, ...data.retestRuns].flatMap((item) => (
    item.verificationSummaries.map((summary) => ({ run: item, summary }))
  ));
  if (!verificationRows.length) {
    lines.push('발견된 `reverification-summary*.json`이 없다.', '');
  } else {
    lines.push('재검증은 저장된 결과와 산출물만 다시 판정했으며 미션·외부 호출·메일 액션을 실행하지 않았다. 따라서 아래 집계는 실행 기준선이나 실제 재시험 집계가 아니다.', '');
    lines.push('| 실행 루트 | 증거 종류 | 범위 | 재검증 집계 | 교정 규칙 | 시각 |', '|---|---|---|---|---|---|');
    for (const { run: sourceRun, summary } of verificationRows) {
      const counts = summary.counts
        ? `성공 ${summary.counts.SUCCESS ?? 0}, 안전정지 ${summary.counts.EXPECTED_STOP ?? 0}, 부분 ${summary.counts.PARTIAL ?? 0}, 실패 ${summary.counts.FAILED ?? 0}`
        : '-';
      lines.push(`| ${escapeTable(sourceRun.label)} | ${summary.readOnly ? '읽기 전용 재검증' : '정책 미확인 재검증'} | ${escapeTable(summary.selectedCaseIds.map(displayCaseId).join(', ') || '기록 없음')} | ${escapeTable(counts)} | ${escapeTable(correctionText(summary.correctionSet))} | ${formatTimestamp(summary.reverifiedAt)} |`);
    }
    lines.push('');
  }

  lines.push('## 실행 및 검증 방법', '');
  lines.push('1. 실행 전 50개 명령과 입력·예상 상태·산출물 조건을 `corpus.json`에 고정하고 해시를 남겼다.');
  lines.push('2. 각 사례는 자기 작업공간과 감사 로그를 사용했다. 결과 목록과 실행 타임스탬프로 사례 간 겹침을 검사했다.');
  lines.push('3. 미션 자체의 완료 선언과 별도로 파일 존재·크기·텍스트 내용·Office/ZIP 컨테이너·시트 및 슬라이드 수·PNG 서명과 크기·입력 SHA-256을 독립 검사했다.');
  lines.push('4. 웹 사례는 실제 HTTP 2xx, 수집 시각, 비재생 여부, URL 및 도메인 수를 검사했다. 메일 사례는 자기 수신자, 첨부 해시 결합, SMTP 제공자 수락을 검사했다.');
  lines.push('5. 최초 실패는 덮어쓰지 않았으며 재시험 결과는 아래 전후 연결표에서 별도로 판정했다. 이 보고서 생성기는 저장된 JSON만 읽고 보고서 파일 두 개만 썼으며 워크플로 실행이나 메일 발송을 하지 않았다.', '');
  lines.push(`- 최초 실행 미션 액션: 총 ${data.executionTotals.actionCount}건, 성공 ${data.executionTotals.succeededActionCount}건, 비성공 ${data.executionTotals.nonSucceededActionCount}건`);
  lines.push(`- 비성공 액션에 연결된 하위 작업 상태: ${statusCountsText(data.executionTotals.linkedNonCompletedTaskStatusCounts)}`, '');

  lines.push('## 순차 실행 증거', '');
  lines.push(`- 판정: **${sequentialVerdictLabel(run.sequentiality.verdict)}**`);
  lines.push(`- 결과 순서와 코퍼스 순서 일치: ${yesNo(run.sequentiality.orderMatchesCorpus)}`);
  lines.push(`- 결과 순서와 summary 순서 일치: ${yesNo(run.sequentiality.orderMatchesSummary)}`);
  lines.push(`- 완전한 시작·종료 시각: ${yesNo(run.sequentiality.timestampComplete)}`);
  lines.push(`- 인접 실행 구간 겹침: ${run.sequentiality.overlapCount}건`);
  lines.push(`- 누적 기록 실행시간: ${formatDuration(run.sequentiality.totalRecordedDurationMs)} / 전체 시각 범위: ${formatDuration(run.sequentiality.wallClockSpanMs)}`);
  lines.push(`- 근거: ${cleanText(run.sequentiality.evidenceStatement, 1000)}`, '');
  if (run.sequentiality.overlaps.length) {
    lines.push('| 앞 사례 | 뒤 사례 | 겹친 시간 |', '|---|---|---:|');
    for (const overlap of run.sequentiality.overlaps) {
      lines.push(`| ${displayCaseId(overlap.previousCaseId)} | ${displayCaseId(overlap.nextCaseId)} | ${formatDuration(overlap.overlapMs)} |`);
    }
    lines.push('');
  }

  lines.push('## 기록 무결성', '');
  lines.push(`- corpus 문서 해시와 summary 일치: ${yesNo(run.corpusIntegrity.documentMatchesSummary)}`);
  lines.push(`- 실제 corpus.json 파일 해시와 summary 일치: ${yesNo(run.corpusIntegrity.fileMatchesSummary)}`);
  lines.push(`- 결과 개수 일치: ${yesNo(run.consistency.completedResultCountMatches)}`);
  lines.push(`- 결과 구분별 집계 일치: ${yesNo(run.consistency.outcomeCountsMatch)}`);
  if (run.consistency.legacyAssertionBooleanRedactionCaseIds.length) {
    lines.push(`- 레거시 assertion 불리언 마스킹: ${run.consistency.legacyAssertionBooleanRedactionCaseIds.map(displayCaseId).join(', ')}. 이 값은 추측하지 않고 UNKNOWN으로 표시했다.`);
  }
  if (run.consistency.missingOrInvalidResultCaseIds.length) {
    lines.push(`- 누락·손상 결과: ${run.consistency.missingOrInvalidResultCaseIds.map(displayCaseId).join(', ')}`);
  }
  lines.push('');

  for (const outcome of ['SUCCESS', 'EXPECTED_STOP', 'PARTIAL', 'FAILED']) {
    lines.push(`## ${outcomeLabel(outcome)} 사례`, '');
    const cases = run.cases.filter((item) => item.outcome === outcome);
    if (!cases.length) {
      lines.push('해당 사례 없음.', '');
      continue;
    }
    lines.push('| 사례 | 명령 | 범주 | 미션 상태 | 시간 | 독립 검증 | 핵심 진단 |', '|---|---|---|---|---:|---|---|');
    for (const item of cases) {
      const diagnosis = item.controlledStop
        ? `의도된 안전 정지${item.stopReason ? `: ${item.stopReason}` : ''}`
        : item.rootCauses.map((cause) => cause.label).join(', ') || '이상 없음';
      lines.push(`| ${item.displayId} | ${escapeTable(item.title)} | ${escapeTable(item.category)} | ${escapeTable(item.missionStatus ?? '-')} | ${formatDuration(item.durationMs)} | ${assertionSummaryText(item.assertions)} | ${escapeTable(diagnosis)} |`);
    }
    lines.push('');
  }

  if ((run.counts.NOT_RUN ?? 0) > 0) {
    lines.push('## 미실행 또는 결과 미완성 사례', '');
    lines.push('| 사례 | 명령 | 상태 | 원인 |', '|---|---|---|---|');
    for (const item of run.cases.filter((entry) => entry.outcome === 'NOT_RUN')) {
      lines.push(`| ${item.displayId} | ${escapeTable(item.title)} | 대기 | ${escapeTable(errorText(item.loadError) || 'summary에 pending으로 기록')} |`);
    }
    lines.push('');
  }

  lines.push('## 실패 원인 군집과 해결책', '');
  if (!data.rootCauseClusters.length) {
    lines.push('최초 실행에서 `PARTIAL` 또는 `FAILED`로 분류된 사례가 없어 실패 원인 군집이 없다.', '');
  } else {
    lines.push('| 원인 군집 | 심각도 | 영향 사례 | 근거 요약 | 해결책 | 재시험 상태 |', '|---|---|---|---|---|---|');
    for (const cluster of data.rootCauseClusters) {
      const evidence = cluster.evidence.slice(0, 2).map((item) => `${item.displayId}: ${item.detail}`).join('; ');
      lines.push(`| ${escapeTable(cluster.label)} | ${escapeTable(cluster.severity)} | ${cluster.caseIds.map(displayCaseId).join(', ')} | ${escapeTable(evidence || cluster.description)} | ${escapeTable(cluster.solution)} | ${retestDispositionLabel(cluster.retestDisposition.status)} |`);
    }
    lines.push('');
  }

  lines.push('## 수정 전후 재시험 연결', '');
  if (!data.retestRuns.length) {
    lines.push('연결된 재시험 루트가 없다. 최초 실행의 실패는 아직 재시험으로 해소됐다고 판정하지 않았다.', '');
  } else {
    lines.push('아래 재시험 루트는 실제 미션 실행이다. 각 단계의 `재검증` 표시는 그 실행 결과를 이후 읽기 전용으로 다시 판정한 값이다.', '');
    lines.push('| 사례 | 최초 실행 | 실제 재시험 경로 | 최신 실제 판정 | 읽기 전용 재검증 | 교정 | 변화 |', '|---|---|---|---|---|---|---|');
    for (const link of data.retestLinks) {
      const trail = link.retests.map((step) => `${step.runLabel}: 실행 ${step.outcome}/${step.missionStatus ?? '-'}${step.effectiveVerification ? `, 재검증 ${step.effectiveVerification.outcome}` : ''}`).join(' → ') || '-';
      const verification = link.effectiveVerification;
      const correction = link.latestCorrectedVerification?.correctionSet ?? verification?.correctionSet ?? link.latest?.correctionSet ?? null;
      lines.push(`| ${link.displayId} ${escapeTable(link.title)} | ${escapeTable(link.initial ? `${link.initial.outcome}/${link.initial.missionStatus ?? '-'}` : '기준선 없음')} | ${escapeTable(trail)} | ${escapeTable(link.latest ? `${link.latest.outcome}/${link.latest.missionStatus ?? '-'}` : '-')} | ${escapeTable(verification ? `${verification.outcome} (${verification.readOnly ? '읽기 전용' : '정책 미확인'}, ${link.verificationSourceRunLabel})` : '-')} | ${escapeTable(correctionText(correction))} | ${actualExecutionChangeLabel(link.actualExecutionChange)} / ${verificationChangeLabel(link.readOnlyVerificationChange)} |`);
    }
    lines.push('');
  }

  const unresolvedWithoutRerun = data.retestLinks
    .filter((link) => link.initial && !PASSING_OUTCOMES.has(link.initial.outcome) && link.retests.length === 0)
    .map((link) => link.displayId);
  if (unresolvedWithoutRerun.length) {
    lines.push(`실제 재시험이 없는 최초 비통과 사례(${unresolvedWithoutRerun.join(', ')})에는 과거 실행 액션이 남아 있다. 읽기 전용 재검증만으로 액션을 다시 실행했다고 해석하지 않는다.`, '');
  }

  lines.push('## 보안 및 자기 Gmail 전송 증거', '');
  lines.push('메일의 `providerAccepted=true`는 SMTP 제공자가 의도된 자기 수신자 한 명을 수락했다는 전송 계층 증거다. 받은편지함 배치, 메시지 열람, 내용 확인까지 증명하지는 않는다. 따라서 아래 표에서 SMTP 수락과 받은편지함·열람을 분리해 표시한다.', '');
  const emailRecords = data.securityAndEmail.records;
  if (emailRecords.length) {
    lines.push('| 실행 | 사례 | 사전 허용 | email.send 성공 | 자기수신·해시결합 | SMTP 수락 | 첨부 | 받은편지함/열람 |', '|---|---|---|---:|---|---|---|---|');
    for (const item of emailRecords) {
      const binding = item.succeededActionCount > 0
        ? `${item.trustedSelfAuthorizationCount}/${item.succeededActionCount} 자기승인, ${item.exactHashBoundActionCount}/${item.succeededActionCount} 해시결합`
        : '실행 없음';
      lines.push(`| ${runLabelText(item.runLabel)} | ${item.displayId} | ${yesNo(item.explicitlyAllowed)} | ${item.succeededActionCount} | ${binding} | ${item.providerAccepted && item.recipientMatched ? '확인' : '미확인'} | 기대 ${item.expectedAttachmentCount ?? '-'} / 관찰 ${item.observedAttachmentCounts.join(', ') || '-'} | 증명 안 됨 / 증명 안 됨 |`);
    }
    const acceptedRecords = emailRecords.filter((item) => item.succeededActionCount === 1 && item.providerAccepted && item.recipientMatched);
    lines.push('', `SMTP 제공자 수락과 자기 수신자 일치가 함께 확인된 실행 기록은 **${acceptedRecords.length}건**이다. 이는 전송 계층 수락 횟수이며 받은편지함 도착이나 열람 횟수가 아니다.`);
  } else {
    lines.push('연결된 실행에 메일 예상·실행·관찰 기록이 없다.');
  }
  lines.push('');
  const violations = data.securityAndEmail.violations;
  lines.push(`- 허용되지 않은 성공 발송: ${violations.unauthorizedSuccessfulSendCaseIds.length ? violations.unauthorizedSuccessfulSendCaseIds.join(', ') : '0건'}`);
  lines.push(`- 자기 수신 모드 위반: ${violations.recipientModeViolationCaseIds.length ? violations.recipientModeViolationCaseIds.join(', ') : '0건'}`);
  lines.push(`- 사례당 복수 성공 발송: ${violations.multipleSuccessfulSendCaseIds.length ? violations.multipleSuccessfulSendCaseIds.join(', ') : '0건'}`);
  lines.push('- 보고서에는 이메일 주소, SMTP 비밀번호, 원문 메일 본문, 원시 멱등키를 포함하지 않았다.', '');

  lines.push('## 감사 범위와 남은 설계 한계', '');
  lines.push('- C06·C10·C17·C21·C22·C23·C40의 숨김 시트명은 실제 명령이 그 이름을 요구할 때만 합격 조건으로 사용했다. 코퍼스 내부 보조 라벨을 사용자 명령으로 간주하지 않았다.');
  lines.push('- C08 발주 임계값 조합, C17 접근성 좌석 규칙, C18 우선순위 조합, C31 개선 채널 지표, C34 SLA 임계값, C41 정확한 7장 구성은 명령에 세부 규칙이 완전히 지정되지 않았다. 구현은 입력과 명시 조건을 따랐지만 이 업무 규칙의 유일한 정답까지 증명하지는 않는다.');
  lines.push('- C45는 원본 점수와 “공동 1위” 문구가 모순되어 `c45-ranking-v1` 교정 오버레이로 상위 두 옵션 표현을 검증했다. C47은 `c47-stop-report-v1`로 누락 파일과 필수 필드 보고를 강화했다. 원본 코퍼스는 변경하지 않았다.');
  lines.push('- PNG 1200×675와 ZIP 내부 평탄화는 재현 가능한 감사를 위한 하네스 규약이다. 사용자 명령이 형식이나 폴더 구조를 직접 지정하면 그 명령이 우선한다.');
  lines.push('- C07·C08·C15·C18·C19·C29·C34·C38·C45·C48·C49·C50의 검증은 구조, 해시, 필수 토큰과 수치 일관성을 강하게 확인하지만 모든 전문가적 의미 판단을 완전히 자동 증명하지는 않는다.');
  lines.push('- C26의 `metrics.csv`는 코퍼스 선언에서 텍스트형으로 분류된 경미한 명세 부정확성이 남아 있다. 실제 CSV 바이트와 내용 검증은 수행했다.', '');

  lines.push('## 사례별 상세 결과', '');
  for (const item of run.cases) renderCaseDetails(lines, item, data.retestLinks.find((link) => link.id === item.id));

  lines.push('## 기계 판독 자료', '');
  lines.push('원인별 전체 증거, 개별 실패 assertion 세부값, 산출물 SHA-256, 재시험 연결은 같은 폴더의 `diagnosis.json`에 기록했다.', '');
  return `${lines.join('\n')}\n`;
}

function renderCaseDetails(lines, item, retestLink) {
  lines.push(`### ${item.displayId} · ${item.title}`, '');
  lines.push(`- 범주: \`${markdownInline(item.category)}\``);
  lines.push(`- 결과: **${outcomeLabel(item.outcome)}** / 기대 상태: \`${markdownInline(item.expectedStatus ?? '-')}\` / 미션 상태: \`${markdownInline(item.missionStatus ?? '-')}\``);
  lines.push(`- 시간: ${formatDuration(item.durationMs)} (${formatTimestamp(item.startedAt)} → ${formatTimestamp(item.finishedAt)})`);
  lines.push(`- 독립 검증: ${assertionSummaryText(item.assertions)} / 액션: ${item.actions.total}개 중 성공 ${item.actions.succeeded}, 실패 ${item.actions.failed}, 라우팅 불일치 ${item.actions.routeMismatchCount}`);
  if (item.stopReason) lines.push(`- 정지 사유: \`${markdownInline(item.stopReason)}\``);
  lines.push(`- 결과 증거: \`${markdownInline(item.resultPath)}\``);
  lines.push('');
  lines.push('**실제 전달한 명령**', '');
  lines.push('~~~text', safeCodeBlock(item.command || '(명령 기록 없음)'), '~~~', '');

  if (item.assertions.failedItems.length) {
    lines.push('**실패한 독립 검증**', '');
    for (const failed of item.assertions.failedItems) {
      lines.push(`- ${failed.check}${failed.details ? ` — ${compactDetailsText(failed.details)}` : ''}`);
    }
    lines.push('');
  } else if (item.assertions.unknown > 0) {
    lines.push(`**독립 검증 제한**: ${item.assertions.unknown}개 검사의 불리언이 레거시 기록에서 마스킹되어 개별 성공·실패를 추정하지 않았다.`, '');
  }

  lines.push('**산출물 및 입력 무결성**', '');
  if (!item.artifacts.length) {
    lines.push('- 기록된 파일 없음.', '');
  } else {
    lines.push('| 역할 | 파일 | 크기 | SHA-256 |', '|---|---|---:|---|');
    for (const artifact of item.artifacts) {
      lines.push(`| ${artifact.role === 'input' ? '입력' : '산출물'} | \`${markdownInline(artifact.path)}\` | ${formatBytes(artifact.size)} | \`${shortHash(artifact.sha256)}\` |`);
    }
    lines.push('');
  }

  if (item.controlledStop) {
    lines.push(`**판정 근거**: ${item.controlledStop.meaning}${item.controlledStop.stopReason ? ` (\`${markdownInline(item.controlledStop.stopReason)}\`)` : ''}`, '');
  } else if (item.rootCauses.length) {
    lines.push('**원인 진단과 조치**', '');
    for (const cause of item.rootCauses) {
      lines.push(`- **${cause.label}**: ${cause.evidence.join(' / ') || cause.description} 해결: ${cause.solution}`);
    }
    lines.push('');
  } else {
    lines.push('**원인 진단**: 미션 상태와 독립 수용 기준이 모두 기대 결과와 일치했다.', '');
  }

  for (const warning of item.diagnosticWarnings) lines.push(`- 주의: ${warning.message}`);
  if (item.diagnosticWarnings.length) lines.push('');

  if (item.email.expected || item.email.actionCount || item.email.observations.length) {
    lines.push(`**메일 증거**: 사전 허용 ${yesNo(item.email.explicitlyAllowed)}, 성공 액션 ${item.email.succeededActionCount}, SMTP 수락 ${yesNo(item.email.providerAccepted)}, 수신자 일치 ${yesNo(item.email.recipientMatched)}, 해시 결합 액션 ${item.email.exactHashBoundActionCount}. 받은편지함 배치와 열람은 증명되지 않았다.`, '');
  }
  if (retestLink?.retests?.length) {
    lines.push(`**실제 재시험**: ${retestLink.retests.map((step) => `${step.runLabel} 실행 ${step.outcome}/${step.missionStatus ?? '-'}${step.effectiveVerification ? `, 읽기 전용 재검증 ${step.effectiveVerification.outcome}` : ''}${step.correctionSet ? `, 교정 ${step.correctionSet.setId}` : ''}`).join(' → ')} · ${actualExecutionChangeLabel(retestLink.actualExecutionChange)} / ${verificationChangeLabel(retestLink.readOnlyVerificationChange)}`, '');
  } else if (item.effectiveVerification) {
    lines.push(`**읽기 전용 재검증**: ${item.effectiveVerification.outcome} (${item.effectiveVerification.resultPath})${item.latestCorrectedVerification ? ` · 교정 overlay ${item.latestCorrectedVerification.correctionSet.setId}` : ''}. 실제 재시험은 아니다.`, '');
  }
}

function correctionText(correction) {
  if (!correction?.setId) return '-';
  return correction.description ? `${correction.setId}: ${correction.description}` : correction.setId;
}

function verificationChangeLabel(value) {
  return ({
    NOT_REVERIFIED: '재검증 없음',
    RESOLVED_BY_READ_ONLY_REVERIFY: '읽기 전용 재검증에서 통과',
    REGRESSION_IN_READ_ONLY_REVERIFY: '읽기 전용 재검증에서 비통과',
    UNCHANGED_BY_READ_ONLY_REVERIFY: '읽기 전용 재검증 동일'
  })[value] ?? value;
}

function actualExecutionChangeLabel(value) {
  return ({
    RESOLVED: '실제 재시험 원시 판정 통과',
    STILL_FAILING: '실제 재시험 원시 판정 비통과',
    REGRESSION: '실제 재시험 원시 판정 회귀',
    STABLE_PASS: '실제 재시험 원시 판정 통과 유지',
    NOT_RETESTED: '실제 재시험 없음'
  })[value] ?? value;
}

function isEmailAction(action) {
  return action?.expectedToolName === 'email.send' || action?.actualToolName === 'email.send';
}

function normalizeError(error) {
  if (error === null || error === undefined || error === false) return null;
  if (typeof error === 'string') return { message: cleanText(error, 2000) };
  if (typeof error !== 'object') return { message: cleanText(String(error), 2000) };
  const normalized = {
    code: cleanText(error.code ?? error.name ?? null, 300),
    message: cleanText(error.message ?? error.error ?? error.reason ?? null, 2000),
    reasons: Array.isArray(error.reasons) ? error.reasons.slice(0, 20).map((item) => cleanText(typeof item === 'string' ? item : JSON.stringify(compactValue(item, 0)), 1000)) : []
  };
  return normalized.code || normalized.message || normalized.reasons.length ? normalized : { message: cleanText(JSON.stringify(compactValue(error, 0)), 2000) };
}

function errorText(error) {
  const normalized = normalizeError(error);
  if (!normalized) return '';
  return [normalized.code, normalized.message, ...(normalized.reasons ?? [])].filter(Boolean).join(': ');
}

function compactValue(value, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return cleanText(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[truncated-depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key, compactValue(child, depth + 1)]));
  }
  return cleanText(String(value), 1000);
}

function compactDetailsText(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return cleanText(text, 1200);
}

function cleanText(value, maxLength = 2000) {
  if (value === null || value === undefined) return null;
  return redactString(String(value)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').slice(0, maxLength);
}

function redactDeep(value, key = '') {
  const sensitiveKey = /^(?:password|passwordHash|passphrase|secret|apiKey|accessToken|rawToken|authorizationToken|signingSecret|smtpPass|credential|credentials|cookie|cookies|idempotencyKey|ownerSessionId|mailBody|rawBody|rawRecipient)$/iu;
  if (sensitiveKey.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key));
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactDeep(child, childKey)]));
}

function redactString(value) {
  return String(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted-email]')
    .replace(/(?:bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|token|api_key|apikey|key|auth|signature)=)[^&#\s]+/giu, '$1[redacted]')
    .replace(/((?:password|passphrase|smtp[_-]?pass|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]');
}

function parseJsonDocument(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${path}: ${error.message}`);
    wrapped.code = 'INVALID_JSON';
    throw wrapped;
  }
}

function safeResolveInside(root, child) {
  const base = resolve(root);
  const candidate = isAbsolute(String(child ?? '')) ? resolve(String(child)) : resolve(base, String(child ?? ''));
  const rel = relative(base, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return candidate;
  const error = new Error(`Result path escapes run root: ${child}`);
  error.code = 'PATH_ESCAPE';
  throw error;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function validIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/iu.test(String(value ?? ''));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRelativePath(value) {
  return cleanText(value ?? '', 2000).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sortCaseIds(ids) {
  return [...ids].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
}

function displayCaseId(id) {
  const value = String(id ?? '');
  return /^\d+$/u.test(value) ? `C${value.padStart(2, '0')}` : value;
}

function severityRank(value) {
  return ({ critical: 4, high: 3, medium: 2, low: 1 })[value] ?? 0;
}

function shortHash(value) {
  return validSha256(value) ? `${String(value).slice(0, 12)}…` : '-';
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}초`;
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}분 ${remainingSeconds}초`;
}

function formatTimestamp(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return cleanText(value, 100);
  return parsed.toISOString();
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function assertionSummaryText(assertions) {
  if (assertions.unknown > 0) return `통과 ${assertions.passed} / 실패 ${assertions.failed} / 판정불가 ${assertions.unknown}`;
  return `통과 ${assertions.passed} / 실패 ${assertions.failed}`;
}

function outcomeLabel(value) {
  return ({ SUCCESS: '성공 (SUCCESS)', EXPECTED_STOP: '의도된 안전 정지 (EXPECTED_STOP)', PARTIAL: '부분 성공 (PARTIAL)', FAILED: '실패 (FAILED)', NOT_RUN: '미실행 (NOT_RUN)' })[value] ?? value;
}

function outcomeMeaning(value) {
  return ({
    SUCCESS: '미션 완료와 모든 독립 검증 통과',
    EXPECTED_STOP: '필수 입력·허용 범위 부족을 정확히 보고하고 무생성 정지',
    PARTIAL: '일부 실제 작업 또는 검증만 성공',
    FAILED: '유효한 성공 근거 없음 또는 결과 기록 실패',
    NOT_RUN: 'summary 기준 아직 실행되지 않음'
  })[value] ?? '-';
}

function closureOutcomeLabel(outcome) {
  return ({
    SUCCESS: '성공 (SUCCESS)',
    EXPECTED_STOP: '의도된 안전 정지 (EXPECTED_STOP)',
    HISTORICAL_PARTIAL: '역사적 전체 흐름 부분 성공',
    FAILED: '실패 (FAILED)'
  })[outcome] ?? outcome;
}

function closureOutcomeMeaning(outcome) {
  return ({
    SUCCESS: '최초 실행, 별도 실제 재시험 또는 저장 산출물 재검증으로 성공 기준을 충족',
    EXPECTED_STOP: '필수 입력이 없어 정확한 누락 정보를 보고하고 안전하게 정지',
    HISTORICAL_PARTIAL: '제품 수정 증거와 별개로 저장된 전체 실행 판정은 PARTIAL로 보존',
    FAILED: '종합 판정에도 유효한 성공 근거가 없음'
  })[outcome] ?? '-';
}

function runLabelText(label) {
  if (label === 'initial') return '최초 실행';
  const match = /^retest-(\d+)$/u.exec(String(label ?? ''));
  return match ? `실제 재시험 ${match[1]}` : cleanText(label ?? '-', 80);
}

function statusCountsText(counts) {
  const entries = Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([status, count]) => `${status} ${count}건`).join(', ') : '0건';
}

function sequentialVerdictLabel(value) {
  return ({ SUPPORTED: '순차 실행 증거 충족', CONTRADICTED: '순차 실행과 충돌', PARTIAL: '증거 일부 부족', INSUFFICIENT_SAMPLE: '표본 부족' })[value] ?? value;
}

function retestDispositionLabel(value) {
  return ({ RESOLVED: '모두 해결됨', PARTIALLY_RESOLVED: '일부 해결', UNRESOLVED: '미해결', NOT_RETESTED: '재시험 없음' })[value] ?? value;
}

function retestChangeLabel(value) {
  return ({ RESOLVED: '해결 확인', STILL_FAILING: '계속 실패', REGRESSION: '회귀', STABLE_PASS: '통과 유지', NOT_RETESTED: '재시험 없음' })[value] ?? value;
}

function yesNo(value) {
  return value === true ? '예' : value === false ? '아니요' : '-';
}

function escapeTable(value) {
  return cleanText(value ?? '-', 4000).replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>');
}

function markdownInline(value) {
  return cleanText(value ?? '-', 4000).replaceAll('`', '\\`').replace(/\r?\n/gu, ' ');
}

function safeCodeBlock(value) {
  return cleanText(value ?? '', 20_000).replaceAll('~~~', '~ ~ ~');
}
