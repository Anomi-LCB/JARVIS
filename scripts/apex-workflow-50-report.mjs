import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APEX_WORKFLOW_REPORT_VERSION = 'jarvis-apex-workflow-50-report-v1';

const DEFAULT_AUDIT_PARENT = join('artifacts', 'apex-workflow-50-audit');
const DEFAULT_INITIAL_ROOT = join(DEFAULT_AUDIT_PARENT, '2026-09-04-initial-v1');
const DEFAULT_FINAL_ROOT = join(DEFAULT_AUDIT_PARENT, '2026-09-04-final-v1');
const DEFAULT_SOAK_ROOT = join(DEFAULT_AUDIT_PARENT, '2026-09-04-soak-20x-v1');
const DEFAULT_PRODUCT_BASELINE_ROOT = join(DEFAULT_AUDIT_PARENT, '2026-09-04-baseline-product-gaps');
const DEFAULT_PRODUCT_RETEST_ROOT = join(DEFAULT_AUDIT_PARENT, '2026-09-04-product-retest-v1');
const DEFAULT_OUTPUT_ROOT = join(DEFAULT_AUDIT_PARENT, 'final-report-data-2026-09-04');
const DEFAULT_REMEDIATION_PATH = join(DEFAULT_AUDIT_PARENT, 'remediation-2026-09-04.json');

const EXPECTED_CASE_IDS = Object.freeze(Array.from({ length: 50 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`));

const CATEGORY_LABELS = Object.freeze({
  'causal-time': '인과관계·시간 모델',
  'provenance-trust': '출처·신뢰 체인',
  'planner-orchestration': '계획·오케스트레이션',
  'capability-policy': '권한·정책 경계',
  'resource-admission': '자원·수용 제어',
  'distributed-offline': '분산·오프라인 합의',
  'perception-integrity': '인식·입력 무결성',
  'privacy-lifecycle': '개인정보 수명주기',
  'state-evolution': '상태·스키마 진화',
  'observability-recovery': '관측성·복구'
});

const PRODUCT_PROBE_CATALOG = Object.freeze({
  TASK_RETRY_TRANSITION_ATOMIC: {
    component: 'TaskStateMachine',
    title: '실패한 retry 전이의 budget 오염',
    rootCause: 'retryCount가 상태 전이 검증보다 먼저 증가해, 거부된 전이도 재시도 budget을 소비했다.',
    correction: '다음 retryCount를 임시 계산하고 전이가 성공한 뒤에만 상태에 반영하도록 순서를 원자화했다.'
  },
  TASK_RETRY_BUDGET_VALIDATED: {
    component: 'TaskStateMachine',
    title: '비정상 retry budget 수용',
    rootCause: '생성자가 음수 또는 정수가 아닌 maxRetries를 거부하지 않았다.',
    correction: '유효 범위를 생성 시점에 검사하고 A_TASK_RETRY_BUDGET_INVALID로 실패하도록 했다.'
  },
  QUEUE_RESERVED_METADATA_OWNED: {
    component: 'FileWorkerQueueStore',
    title: '예약 저장 metadata 덮어쓰기',
    rootCause: '호출자 snapshot이 storeVersion과 persistedAt을 덮어쓸 수 있었다.',
    correction: '예약 metadata를 snapshot 병합 뒤 저장소가 마지막에 확정하도록 했다.'
  },
  QUEUE_COLLECTION_SHAPE_FAILS_CLOSED: {
    component: 'FileWorkerQueueStore',
    title: '손상된 queue collection의 fail-open',
    rootCause: 'queue 또는 runs가 배열이 아닌 snapshot도 load 경계에서 차단되지 않았다.',
    correction: 'load와 save 양쪽에서 collection shape를 검사하고 손상·부적합 code로 닫히게 했다.'
  },
  REPORT_ID_PATH_CONFINED: {
    component: 'VerificationReportStore',
    title: 'report ID 경로 이탈',
    rootCause: '../ 같은 report ID가 보고서 디렉터리 밖의 파일 경로로 해석될 수 있었다.',
    correction: '허용 문자·길이를 제한한 ID 검증과 경로 경계를 적용하고 잘못된 read는 null로 처리했다.'
  },
  REPORT_RESERVED_ID_PROTECTED: {
    component: 'VerificationReportStore',
    title: '예약 report ID 충돌',
    rootCause: 'report-index 등 내부 제어 파일 이름을 일반 보고서 ID로 사용할 수 있었다.',
    correction: '예약 이름과 점 경로를 G_REPORT_ID_INVALID로 차단했다.'
  },
  REPORT_SECRET_REDACTION_COMPLETE: {
    component: 'VerificationReportStore',
    title: '구조화·자유문 secret 마스킹 누락',
    rootCause: '민감 key와 Authorization Bearer 문자열이 공개 보고서 evidence에 남을 수 있었다.',
    correction: 'key 인지 재귀 마스킹과 Bearer 패턴 정규화를 함께 적용했다.'
  },
  JSON_RESPONSE_HEADERS_NON_WEAKENABLE: {
    component: 'Shared HTTP',
    title: '보안 응답 header 약화 가능성',
    rootCause: '사용자 정의 header가 JSON content type, no-store, nosniff, content length를 덮어쓸 수 있었다.',
    correction: '보호 header를 대소문자와 무관하게 제거한 뒤 안전한 필수 값을 마지막에 적용했다.'
  },
  ROUTE_PARAM_ENCODED_SEPARATOR_REJECTED: {
    component: 'Shared HTTP router',
    title: '인코딩된 경로 구분자 수용',
    rootCause: '%2f와 %5c가 route parameter 내부에서 slash와 backslash로 복원됐다.',
    correction: 'decode 뒤 구분자·점 경로·제어 문자를 route match 단계에서 거부했다.'
  },
  BULK_FILE_COMMAND_ROUTES_AS_MISSION: {
    component: 'Command lane router',
    title: '대량 다단계 파일 작업의 quick task 오분류',
    rootCause: '대량 파일 읽기·해시·중복 제거·압축·재검증 조합을 mission으로 승격하는 신호가 없었다.',
    correction: 'bulk-file 단계를 추가하고 해당 조합을 비동기 mission으로 분류하도록 했다.'
  }
});

export async function generateApexWorkflowReport(options = {}) {
  const cwd = resolve(options.cwd ?? '.');
  const roots = {
    initial: resolve(cwd, options.initialRoot ?? DEFAULT_INITIAL_ROOT),
    final: resolve(cwd, options.finalRoot ?? DEFAULT_FINAL_ROOT),
    soak: resolve(cwd, options.soakRoot ?? DEFAULT_SOAK_ROOT),
    productBaseline: resolve(cwd, options.productBaselineRoot ?? DEFAULT_PRODUCT_BASELINE_ROOT),
    productRetest: resolve(cwd, options.productRetestRoot ?? DEFAULT_PRODUCT_RETEST_ROOT),
    output: resolve(cwd, options.outputRoot ?? DEFAULT_OUTPUT_ROOT),
    remediation: resolve(cwd, options.remediationPath ?? DEFAULT_REMEDIATION_PATH),
    failedSoak: options.failedSoakRoot ? resolve(cwd, options.failedSoakRoot) : null,
    verification: options.verificationPath ? resolve(cwd, options.verificationPath) : null
  };

  const [initial, final, soak, failedSoak, productBaselineEvidence, productRetestEvidence, repositoryVerification] = await Promise.all([
    readCampaignEvidence(roots.initial, { reverificationRequired: false, allowInvalidCorpus: true }),
    readCampaignEvidence(roots.final, { reverificationRequired: true }),
    readCampaignEvidence(roots.soak, { reverificationRequired: true }),
    roots.failedSoak ? readCampaignEvidence(roots.failedSoak, { reverificationRequired: true }) : Promise.resolve(null),
    readProductEvidence(roots.productBaseline),
    readProductEvidence(roots.productRetest),
    roots.verification ? readRepositoryVerification(cwd, roots.verification) : Promise.resolve(null)
  ]);

  validateCampaignRelationship({ initial, final, soak, failedSoak });
  validateProductRelationship(productBaselineEvidence.data, productRetestEvidence.data);

  const remediationEvidence = await readRemediationEvidence(
    [initial.root, final.root, soak.root, ...(failedSoak ? [failedSoak.root] : [])],
    roots.remediation,
    options.remediationPath !== undefined
  );
  const remediationByCase = groupRecordsByKey(remediationEvidence.records, (item) => item.caseId);
  const corpusCases = final.corpus.cases;
  const finalByCase = groupLedgerByCase(final.ledger);
  const soakByCase = groupLedgerByCase(soak.ledger);
  const initialFindings = await buildInitialFindings({
    cwd,
    initial,
    corpusCases,
    finalByCase,
    soakByCase,
    remediationByCase
  });
  const productResilience = buildProductResilience(productBaselineEvidence, productRetestEvidence, remediationEvidence.productFixes);
  const failedSoakFinding = failedSoak
    ? buildFailedSoakFinding({ cwd, failedSoak, soak, remediationEvidence })
    : null;
  const repositoryRegressionGroups = buildRepositoryRegressionGroups({
    cwd,
    groups: remediationEvidence.repositoryRegressionGroups,
    repositoryVerification
  });
  const sourceModule = await import('./apex-workflow-50-cases.mjs');
  const currentSourceCorpusSha256 = sourceModule.APEX_WORKFLOW_CORPUS_SHA256
    ?? sourceModule.createApexWorkflowCorpusFingerprint?.().corpusSha256
    ?? null;

  const categoryCounts = countBy(corpusCases, (item) => item.category);
  const expectedTerminalStates = countBy(corpusCases, (item) => item.expected?.terminalState);
  const expectedOutcomes = countBy(corpusCases, (item) => item.expected?.outcome);
  const faultCountPerCycle = sum(corpusCases, (item) => item.faultPlan?.length);
  const checkpointCountPerCycle = sum(corpusCases, (item) => item.scenario?.checkpoints?.length);
  const operationCountPerCycle = sum(corpusCases, (item) => item.scenario?.operations?.reduce((total, operation) => total + Number(operation.repeat ?? 1), 0));
  const observed = soak.summary.totalExecutions;
  const observedFailures = soak.summary.failed;
  const observedSuccesses = soak.summary.contractPass ?? soak.summary.behavioralPass;
  const exactLowerBound = observedFailures === 0 && observed > 0 ? Math.pow(0.01, 1 / observed) : null;
  const behavioralEvidencePassed = final.summary.behavioralPass === final.summary.totalExecutions
    && soak.summary.behavioralPass === soak.summary.totalExecutions;
  const contractEvidencePassed = final.summary.failed === 0 && soak.summary.failed === 0;
  const reverificationPassed = final.reverification.status === 'passed' && soak.reverification.status === 'passed';
  const productRetestPassed = productRetestEvidence.data.failed === 0;
  const failedSoakRegressionPassed = !failedSoakFinding || failedSoakFinding.regressionPassed;
  const repositoryVerificationPassed = repositoryVerification ? repositoryVerification.data.status === 'passed' : null;
  const repositoryRegressionGroupsPassed = repositoryRegressionGroups.length
    ? repositoryRegressionGroups.every((item) => item.status === 'resolved-and-regression-covered')
    : null;
  const unresolvedProductFindings = productResilience.findings.filter((item) => item.status !== 'resolved-and-regression-covered');
  const unresolvedInitialFindings = initialFindings.filter((item) => item.resolutionStatus === 'unresolved');
  const status = behavioralEvidencePassed
    && contractEvidencePassed
    && reverificationPassed
    && productRetestPassed
    && failedSoakRegressionPassed
    && repositoryVerificationPassed !== false
    && repositoryRegressionGroupsPassed !== false
    ? 'passed-with-explicit-scope'
    : 'failed-or-incomplete';
  const missingRepairRecords = initialFindings.filter((item) => item.remediation.documentationStatus !== 'documented').length;

  const supportedClaim = observedFailures === 0
    ? `고정된 A01-A50 코퍼스와 선언 장애 분포를 ${soak.summary.campaign.cycles}회 반복한 ${observed}건에서 행동 ${soak.summary.behavioralPass}/${observed}건, 전체 계약 ${observedSuccesses}/${observed}건이 통과했다. 독립 재검증은 ${soak.reverification.passed}/${soak.reverification.checkCount}를 통과했다. 각 실행을 독립 Bernoulli 시행으로 간주하는 명목 모형에서 같은 시험 분포의 계약 성공률에 대한 단측 99% 정확 하한은 ${formatPercent(exactLowerBound, 4)}다.`
    : `반복 시험 ${observed}건 중 ${observedFailures}건이 기대 계약을 통과하지 못했다. 현재 증거는 같은 시험 분포에 대한 99% 무결함 주장을 지지하지 않는다.`;
  const universalLimit = '유한하고 결정론적인 격리 시험은 임의의 미래 명령, 실제 외부 사이트 변경, 계정 권한 변화, 공용망 장애, 새 운영체제·하드웨어 조합의 영구 무결함을 논리적으로 보증하지 않는다.';

  const evidenceFiles = await buildEvidenceFiles({
    cwd,
    initial,
    final,
    soak,
    failedSoak,
    productBaselineEvidence,
    productRetestEvidence,
    repositoryVerification,
    remediationEvidence,
    initialFindings
  });

  const report = {
    reportVersion: APEX_WORKFLOW_REPORT_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    verdict: {
      status,
      supportedClaim,
      universalLimit,
      claimScope: '현재 JARVIS 구현, 고정 A01-A50 코퍼스, 고정 seed·virtual clock, 격리 workspace, in-memory provider, 선언 fault plan',
      behavioralEvidencePassed,
      contractEvidencePassed,
      reverificationPassed,
      productRetestPassed,
      failedSoakRegressionPassed,
      failedSoakRemediationDocumentation: failedSoakFinding?.documentationStatus ?? 'not-applicable',
      repositoryVerificationPassed,
      repositoryRegressionGroupsPassed,
      unresolvedRepositoryRegressionGroupCount: repositoryRegressionGroups.filter((item) => item.status !== 'resolved-and-regression-covered').length,
      unresolvedInitialFindingCount: unresolvedInitialFindings.length,
      unresolvedProductFindingCount: unresolvedProductFindings.length,
      remediationDocumentation: {
        documented: initialFindings.length - missingRepairRecords,
        missing: missingRepairRecords,
        note: missingRepairRecords === 0
          ? '최초 실패마다 원인과 수정 기록이 증거 파일에 연결됐다.'
          : `${missingRepairRecords}건은 최종·반복 통과는 확인됐지만 원인·코드 수정 설명을 담은 remediation.json이 없어 재시험 사실과 수정 설명을 분리해 표시했다.`
      }
    },
    progression: {
      initial: campaignDigest(initial, cwd),
      final: campaignDigest(final, cwd),
      soak: campaignDigest(soak, cwd),
      failedSoak: failedSoak ? campaignDigest(failedSoak, cwd) : null,
      executionsAfterInitial: final.summary.totalExecutions + soak.summary.totalExecutions,
      behavioralPassesAfterInitial: final.summary.behavioralPass + soak.summary.behavioralPass,
      behavioralFailuresAfterInitial: (final.summary.totalExecutions - final.summary.behavioralPass)
        + (soak.summary.totalExecutions - soak.summary.behavioralPass),
      contractPassesAfterInitial: (final.summary.contractPass ?? final.summary.behavioralPass)
        + (soak.summary.contractPass ?? soak.summary.behavioralPass),
      contractFailuresAfterInitial: final.summary.failed + soak.summary.failed
    },
    corpus: {
      schemaVersion: final.corpus.schemaVersion,
      scenarioVersion: final.corpus.scenarioVersion ?? null,
      corpusSha256: final.campaign.selectedCorpusSha256,
      initialCorpusSha256: initial.campaign.selectedCorpusSha256,
      corpusChangedAfterInitial: initial.campaign.selectedCorpusSha256 !== final.campaign.selectedCorpusSha256,
      seed: final.corpus.seed ?? final.campaign.seed,
      virtualClock: final.corpus.virtualClock ?? final.campaign.virtualClock,
      isolation: final.corpus.isolation ?? final.campaign.isolation,
      commandCount: corpusCases.length,
      categoryCount: Object.keys(categoryCounts).length,
      categoryCounts,
      categoryLabels: CATEGORY_LABELS,
      expectedTerminalStates,
      expectedOutcomes,
      faultCountPerCycle,
      checkpointCountPerCycle,
      operationCountPerCycle,
      commands: corpusCases.map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        categoryLabel: CATEGORY_LABELS[item.category] ?? item.category,
        command: item.command,
        stepCount: item.scenario?.checkpoints?.length ?? 0,
        steps: (item.scenario?.checkpoints ?? []).map((step) => ({ id: step.checkpointId, description: step.description })),
        operationCount: (item.scenario?.operations ?? []).reduce((total, operation) => total + Number(operation.repeat ?? 1), 0),
        operations: (item.scenario?.operations ?? []).map((operation) => ({
          operationId: operation.operationId,
          checkpointId: operation.checkpointId,
          target: operation.target,
          phase: operation.phase,
          repeat: Number(operation.repeat ?? 1)
        })),
        faultCount: item.faultPlan?.length ?? 0,
        faults: (item.faultPlan ?? []).map((fault) => ({
          faultId: fault.faultId,
          target: fault.target,
          phase: fault.phase,
          when: fault.when ?? null,
          effectKind: fault.effect?.kind ?? null,
          effectCode: fault.effect?.code ?? null
        })),
        expectedOutcome: item.expected?.outcome ?? null,
        expectedTerminalState: item.expected?.terminalState ?? null,
        expectedStopCode: item.expected?.stopCode ?? null,
        expectedArtifacts: (item.expected?.files ?? []).map((file) => file.path),
        expectedDiagnostics: (item.expected?.diagnosticFiles ?? []).map((file) => file.path),
        invariants: item.expected?.invariants ?? [],
        verification: item.scenario?.verification ?? [],
        finalRetest: summarizeCaseRecords(finalByCase.get(item.id) ?? []),
        soakRetest: summarizeCaseRecords(soakByCase.get(item.id) ?? [])
      }))
    },
    initialEvidenceIntegrity: {
      ...initial.corpusIntegrity,
      path: normalizeDisplayPath(relative(cwd, initial.corpusIntegrity.path)),
      currentSourceCorpusSha256,
      campaignHashMatchesCurrentSource: currentSourceCorpusSha256 === initial.campaign.selectedCorpusSha256,
      reference: '현재 source corpus hash는 scripts/apex-workflow-50-cases.mjs에서 계산했다. 손상된 최초 corpus payload를 복원하거나 대체하지 않았다.'
    },
    evidenceDefects: buildEvidenceDefects({ cwd, initial, final, remediationEvidence, currentSourceCorpusSha256 }),
    failedSoakFinding,
    initialFailureRepairs: initialFindings,
    productResilience,
    repositoryVerification: repositoryVerification ? repositoryVerificationDigest(cwd, repositoryVerification) : null,
    repositoryRegressionGroups,
    statistics: {
      method: '0 failures일 때 단측 Clopper-Pearson 정확 이항 하한: alpha^(1/n)',
      statisticalClaimKind: 'nominal-under-independent-Bernoulli-assumption',
      confidence: 0.99,
      alpha: 0.01,
      sampleSize: observed,
      observedSuccesses,
      observedFailures,
      observedSuccessRate: observed > 0 ? observedSuccesses / observed : null,
      oneSided99PercentSuccessRateLowerBound: exactLowerBound,
      exceeds99PercentLowerBound: exactLowerBound !== null && exactLowerBound >= 0.99,
      independenceQualification: `${observed}건은 ${corpusCases.length}개 고정 명령을 ${soak.summary.campaign.cycles}회 반복한 결정론적 실행이다. 서로 다른 운영 환경에서 무작위 추출한 ${observed}개의 독립 표본으로 해석할 수 없다.`,
      appliesTo: '고정 corpus, seed, virtual clock, 격리 실행기, in-memory provider, 선언 fault plan과 현재 구현'
    },
    independentReverification: {
      final: reverificationDigest(final.reverification),
      soak: reverificationDigest(soak.reverification)
    },
    evidenceIntegrity: {
      ledgerChainsVerified: true,
      embeddedDigestsVerified: true,
      repositoryGateEvidenceVerified: repositoryVerification ? true : null,
      initialCorpusPayloadStatus: initial.corpusIntegrity.status,
      finalCorpusPayloadStatus: final.corpusIntegrity.status,
      soakCorpusPayloadStatus: soak.corpusIntegrity.status,
      failedSoakCorpusPayloadStatus: failedSoak?.corpusIntegrity.status ?? null,
      finalLedgerHash: final.ledger.at(-1)?.hash ?? 'GENESIS',
      soakLedgerHash: soak.ledger.at(-1)?.hash ?? 'GENESIS',
      failedSoakLedgerHash: failedSoak?.ledger.at(-1)?.hash ?? null,
      evidenceFileCount: evidenceFiles.length
    },
    evidenceFiles,
    limitations: [
      'audit harness와 in-memory provider의 계측 범위에서는 실제 외부 이메일·캘린더·업로드·결제·메시지 시도와 반영이 0건이었다.',
      'realExternalAttempts/realExternalCommits 카운터는 이 audit harness가 계측한 호출만 뜻한다. OS 전체 프로세스의 네트워크 무접속을 packet capture·firewall log로 증명한 결과가 아니다.',
      '외부 API·DOM·OAuth·DNS·rate limit·연결 단절은 선언된 결정론적 fault plan으로 재현했다.',
      ...(repositoryVerification ? ['저장소 전체 회귀 gate는 실행 명령과 결과 파일 SHA-256을 보존하지만 verification schema에 Git commit/tree hash가 없으므로 특정 source checkout과 암호학적으로 결합되지는 않는다. 이후 코드 변경도 자동 보증하지 않는다.'] : []),
      `BLOCKED ${expectedTerminalStates.BLOCKED ?? 0}건과 ROLLED_BACK ${expectedTerminalStates.ROLLED_BACK ?? 0}건은 명령이 요구한 안전 종료 상태·정지 code·부작용 부재를 만족할 때만 행동 통과로 계산했다.`,
      '명목상 통계 하한은 시험 분포 안의 수치이며 논리적·영구적 보증이 아니다.',
      'remediation.json이 없는 최초 실패는 실패 검사와 재시험 결과만 보고하며 정확한 코드 원인이나 수정 내용을 추정하지 않는다.'
    ]
  };
  report.reportSha256 = sha256Json({ ...report, generatedAt: undefined, reportSha256: undefined });

  await mkdir(roots.output, { recursive: true });
  const dataPath = join(roots.output, 'report-data.json');
  const markdownPath = join(roots.output, 'report.md');
  await Promise.all([
    writeFile(dataPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, renderApexWorkflowReportMarkdown(report), 'utf8')
  ]);
  return { report, dataPath, markdownPath };
}

export function renderApexWorkflowReportMarkdown(report) {
  const { initial, final, soak } = report.progression;
  const repairRows = report.initialFailureRepairs.map((item) => [
    item.caseId,
    item.failureClass,
    item.failedAssertions.join('<br>') || 'engine error',
    item.remediation.rootCause ?? '증거에 원인 기록 없음',
    item.remediation.correction ?? '수정 설명 없음; 재시험 결과만 확인',
    resolutionLabel(item)
  ]);
  const productRows = report.productResilience.findings.map((item) => [
    item.id,
    item.component,
    item.title,
    item.rootCause,
    item.correction,
    item.status === 'resolved-and-regression-covered' ? '수정 후 통과' : '미해결'
  ]);
  const repositoryVerification = report.repositoryVerification;
  const repositoryRegressionGroups = report.repositoryRegressionGroups ?? [];
  const hasRepositorySection = Boolean(repositoryVerification || repositoryRegressionGroups.length);
  const repositoryGateRows = (repositoryVerification?.gates ?? []).map((item) => [
    item.id,
    item.command,
    item.status,
    item.exitCode,
    JSON.stringify(item.summary),
    item.evidencePath,
    `\`${item.evidenceSha256}\``
  ]);
  const repositoryRegressionRows = repositoryRegressionGroups.map((item) => [
    item.id,
    item.component ?? '구성요소 미기록',
    item.symptom ?? '증상 미기록',
    item.rootCause ?? '원인 미기록',
    item.correction ?? '솔루션 미기록',
    item.changedFiles.join('<br>') || '변경 파일 미기록',
    item.regression ?? '집중 재검증 설명 미기록',
    item.verificationGates.map((gate) => `${gate.id}: ${gate.status} (${JSON.stringify(gate.summary)})`).join('<br>')
      || `연결된 gate 없음${item.missingVerificationGateIds.length ? ` (${item.missingVerificationGateIds.join(', ')})` : ''}`,
    item.status
  ]);
  const categoryRows = Object.entries(report.corpus.categoryCounts).map(([category, count]) => [
    report.corpus.categoryLabels[category] ?? category,
    category,
    count
  ]);
  const commandRows = report.corpus.commands.map((item) => [
    item.id,
    item.title,
    item.categoryLabel,
    item.stepCount,
    item.operationCount,
    item.faultCount,
    item.expectedTerminalState,
    item.expectedStopCode ?? '—',
    `${item.soakRetest.passed}/${item.soakRetest.executions}`
  ]);
  const commandDetails = report.corpus.commands.map((item) => {
    const faults = item.faults.length
      ? item.faults.map((fault) => `  - ${fault.faultId}: ${fault.target} / ${fault.phase} / ${fault.effectKind ?? 'effect 미기록'}${fault.effectCode ? ` / ${fault.effectCode}` : ''}`).join('\n')
      : '  - 없음';
    return [
      `### ${item.id} — ${item.title}`,
      '',
      `- 범주: ${item.categoryLabel} (\`${item.category}\`)`,
      `- 단계/작업/장애: ${item.stepCount}/${item.operationCount}/${item.faultCount}`,
      `- 기대 결과: ${item.expectedOutcome} · ${item.expectedTerminalState}${item.expectedStopCode ? ` · ${item.expectedStopCode}` : ''}`,
      `- 기대 산출물: ${item.expectedArtifacts.join(', ') || '없음'}`,
      `- 진단 산출물: ${item.expectedDiagnostics.join(', ') || '없음'}`,
      `- 최종 재시험: ${item.finalRetest.passed}/${item.finalRetest.executions}`,
      `- 반복 시험: ${item.soakRetest.passed}/${item.soakRetest.executions} · exact digest ${item.soakRetest.semanticDigests.length}종 · behavioral digest ${item.soakRetest.behavioralDigests.length || '미기록'}종`,
      '',
      '**명령 전문**',
      '',
      `> ${item.command.replace(/\r?\n/gu, '\n> ')}`,
      '',
      '**장애 계획**',
      '',
      faults,
      '',
      `**검증 계약:** ${item.verification.join(', ') || '없음'}`,
      '',
      `**불변조건:** ${item.invariants.join(', ') || '없음'}`,
      ''
    ].join('\n');
  }).join('\n');
  const failedSoak = report.failedSoakFinding;
  const failedSoakHeadline = failedSoak
    ? `- 교정 전 반복: 행동 **${failedSoak.behavioralPass}/${failedSoak.totalExecutions}**, 계약 **${failedSoak.contractPass}/${failedSoak.totalExecutions}**, 계약 실패 ${failedSoak.contractFailed}건`
    : null;
  const failedSoakRemediationRows = (failedSoak?.remediationSteps ?? []).map((item) => [
    item.id ?? 'ID 미기록',
    item.cases.join(', ') || '사례 미기록',
    item.affectedExecutions ?? '집중 검사 발견',
    item.rootCause ?? '원인 미기록',
    item.correction ?? '솔루션 미기록',
    item.regression ?? '재검증 미기록'
  ]);
  const failedSoakSection = failedSoak ? [
    '## 4. 교정 전 반복 계약 실패와 솔루션',
    '',
    `보존된 교정 전 반복 실행은 행동 결과 ${failedSoak.behavioralPass}/${failedSoak.totalExecutions}건을 충족했지만, 반복 안정성 계약은 ${failedSoak.contractPass}/${failedSoak.totalExecutions}건만 통과했다. 행동 성공과 계약 성공을 분리해 보고한다.`,
    '',
    `- 실패 계약: \`${failedSoak.failedContract}\``,
    `- 영향 사례: ${failedSoak.affectedCases.join(', ') || '증거에 사례 ID 없음'}`,
    `- 영향 실행: ${failedSoak.affectedExecutionCount}건`,
    `- 교정 전 독립 재검증: ${failedSoak.reverification.passed}/${failedSoak.reverification.checkCount}, 실패 ${failedSoak.reverification.failed}건 · ${reverificationCoverageText(failedSoak.reverification)}`,
    `- 관찰: ${failedSoak.observed}`,
    `- 원인: ${failedSoak.rootCause ?? 'remediation evidence에 원인 기록 없음'}`,
    `- 솔루션: ${failedSoak.correction ?? 'remediation evidence에 솔루션 기록 없음'}`,
    `- 집중 재검증: ${failedSoak.focusedVerification ?? '별도 집중 재검증 설명 없음'}`,
    '',
    '### 교정 단계별 추적',
    '',
    ...(failedSoakRemediationRows.length
      ? [markdownTable(['ID', '사례', '영향 실행', '원인', '솔루션', '재검증'], failedSoakRemediationRows)]
      : ['remediation evidence에 단계별 기록이 없다.']),
    '',
    `- 교정 후 반복: 계약 ${failedSoak.finalSoak.contractPass}/${failedSoak.finalSoak.totalExecutions}, 실패 ${failedSoak.finalSoak.contractFailed}건, 독립 재검증 ${failedSoak.finalSoak.reverificationStatus}`,
    `- 교정 후 digest 계약: clock profile ${failedSoak.finalSoak.digestRegression.profileCount}종 × 최소 ${failedSoak.finalSoak.digestRegression.minimumProfileRepeats}회, profile 내부 exact ${failedSoak.finalSoak.digestRegression.exactDigestStableWithinClockProfile ? '안정' : '불안정'}, profile 간 behavioral ${failedSoak.finalSoak.digestRegression.behavioralDigestStable ? '안정' : '불안정'}`,
    `- 처리 상태: **${failedSoak.status}** · remediation 문서화 ${failedSoak.documentationStatus}`,
    ''
  ] : [];
  const laterSectionOffset = failedSoak ? 1 : 0;
  const repositorySectionOffset = hasRepositorySection ? 1 : 0;
  const repositorySection = hasRepositorySection ? [
    `## ${5 + laterSectionOffset}. 저장소 전체 회귀 검증`,
    '',
    ...(repositoryVerification ? [
      `APEX 교정 뒤 저장소 전체 gate는 ${repositoryVerification.passed}/${repositoryVerification.total}건 통과, 실패 ${repositoryVerification.failed}건이며 최종 상태는 **${repositoryVerification.status}**다. 각 gate의 원시 evidence 파일 SHA-256을 다시 계산해 선언 hash와 대조했다.`,
      '',
      `- verification 파일: \`${repositoryVerification.path}\``,
      `- 파일 SHA-256: \`${repositoryVerification.fileSha256}\``,
      `- 내장 report SHA-256: \`${repositoryVerification.reportSha256}\``,
      '',
      markdownTable(['gate', '명령', '상태', 'exit', '요약', 'evidence', 'SHA-256'], repositoryGateRows),
      ''
    ] : [
      'repositoryRegressionGroups가 기록됐지만 저장소 verification evidence가 제공되지 않아 회귀 종료를 확정하지 않았다.',
      ''
    ]),
    ...(repositoryRegressionRows.length ? [
      '### 저장소 회귀 원인·해결·재검증 추적',
      '',
      '원인과 솔루션은 remediation evidence에서 읽고, 집중·전체 회귀 결과는 verification evidence의 gate와 hash로 연결했다. gate ID가 별도로 선언되지 않은 항목에는 저장소 전체 gate를 적용했다고 명시했다.',
      '',
      markdownTable(['ID', '구성요소', '증상', '원인', '솔루션', '변경 파일', '집중 재검증 기록', 'verification gate', '상태'], repositoryRegressionRows),
      ''
    ] : []),
    ''
  ] : [];

  return [
    '# JARVIS 어나더 레벨 복합 미션 50건 감사 보고서',
    '',
    `- 판정: **${report.verdict.status}**`,
    `- 보고서 데이터 SHA-256: \`${report.reportSha256}\``,
    `- 코퍼스 SHA-256: \`${report.corpus.corpusSha256}\``,
    `- 최초 실행: 행동 **${initial.behavioralPass}/${initial.totalExecutions}**, 계약 ${initial.contractPass}/${initial.totalExecutions}, 계약 실패 ${initial.failed}건`,
    `- 수정 후 최종 실행: 행동 **${final.behavioralPass}/${final.totalExecutions}**, 계약 ${final.contractPass}/${final.totalExecutions}, 계약 실패 ${final.failed}건`,
    ...(failedSoakHeadline ? [failedSoakHeadline] : []),
    `- ${soak.cycles}회 반복: 행동 **${soak.behavioralPass}/${soak.totalExecutions}**, 계약 ${soak.contractPass}/${soak.totalExecutions}, 계약 실패 ${soak.failed}건`,
    `- 제품 probe: 수정 전 ${report.productResilience.baseline.passed}/${report.productResilience.baseline.total}, 수정 후 ${report.productResilience.retest.passed}/${report.productResilience.retest.total}`,
    ...(repositoryVerification ? [`- 저장소 전체 회귀: **${repositoryVerification.passed}/${repositoryVerification.total}**, 실패 ${repositoryVerification.failed}건`] : []),
    ...(repositoryRegressionGroups.length ? [`- 추가 저장소 회귀 결함: 해결·회귀 연결 **${repositoryRegressionGroups.filter((item) => item.status === 'resolved-and-regression-covered').length}/${repositoryRegressionGroups.length}**`] : []),
    `- audit harness 계측 외부 시도/반영: 최종 ${final.realExternalAttempts}/${final.realExternalCommits}, 반복 ${soak.realExternalAttempts}/${soak.realExternalCommits}`,
    '',
    '## 1. 판정과 범위',
    '',
    report.verdict.supportedClaim,
    '',
    `검증 범위는 ${report.verdict.claimScope}이다.`,
    '',
    `**보증 경계:** ${report.verdict.universalLimit}`,
    '',
    `수정 기록 완전성: ${report.verdict.remediationDocumentation.documented}건 기록, ${report.verdict.remediationDocumentation.missing}건 미기록. ${report.verdict.remediationDocumentation.note}`,
    '',
    '## 2. 시험 설계',
    '',
    `- 명령 ${report.corpus.commandCount}건, 범주 ${report.corpus.categoryCount}개, 단계 ${report.corpus.checkpointCountPerCycle}개/회, 작업 ${report.corpus.operationCountPerCycle}개/회`,
    `- 선언 장애 ${report.corpus.faultCountPerCycle}개/회, 반복 실행에서 관찰한 장애 evidence ${soak.faultCount}개`,
    `- 기대 종료: COMPLETED ${report.corpus.expectedTerminalStates.COMPLETED ?? 0}, BLOCKED ${report.corpus.expectedTerminalStates.BLOCKED ?? 0}, ROLLED_BACK ${report.corpus.expectedTerminalStates.ROLLED_BACK ?? 0}`,
    `- 격리: network=${report.corpus.isolation?.network ?? '-'}, provider=${report.corpus.isolation?.providerMode ?? '-'}, externalSideEffects=${report.corpus.isolation?.externalSideEffects ?? '-'}`,
    `- scripted trace 보충: 최종 ${supplementText(final.scriptedTraceSupplements)}, 반복 ${supplementText(soak.scriptedTraceSupplements)}`,
    '',
    markdownTable(['범주', '코드', '명령 수'], categoryRows),
    '',
    'BLOCKED와 ROLLED_BACK은 실패를 숨긴 결과가 아니다. 각 사례가 선언한 정확한 종료 상태·정지 code·원복·무부작용 계약을 통과했을 때만 행동 통과로 집계했다.',
    '',
    '## 3. 최초 실패와 해결 검증',
    '',
    ...(report.evidenceDefects.length ? [
      '### 최초 corpus 증거 직렬화 결함',
      '',
      ...report.evidenceDefects.flatMap((item) => [
        `- ${item.id}: **${item.status}**`,
        `- 관찰: corpus byte SHA-256 \`${item.observed.byteSha256}\`, parse error \`${item.observed.parseError}\``,
        `- 원인: ${item.rootCause ?? 'remediation evidence에 원인 기록 없음'}`,
        `- 솔루션: ${item.correction ?? 'remediation evidence에 솔루션 기록 없음'}`,
        `- 재검증: ${item.regression}`,
        ''
      ])
    ] : []),
    initial.failed === 0
      ? '최초 실행에서 행동 실패가 관찰되지 않았다.'
      : `최초 실행에서 ${initial.failed}건이 실패했다. 원인·수정 설명은 remediation.json에 있는 경우에만 확정 사실로 표시하며, 그 파일이 없으면 검사 실패와 재시험 결과만 보고한다.`,
    '',
    repairRows.length ? markdownTable(['ID', '분류', '최초 실패', '기록된 원인', '기록된 솔루션', '최종/반복'], repairRows) : '',
    '',
    ...failedSoakSection,
    `## ${4 + laterSectionOffset}. 제품 probe 결함과 수정`,
    '',
    `수정 전 probe는 ${report.productResilience.baseline.passed}/${report.productResilience.baseline.total}, 수정 후 동일 ID probe는 ${report.productResilience.retest.passed}/${report.productResilience.retest.total}였다. 해결 ${report.productResilience.resolvedCount}건, 미해결 ${report.productResilience.unresolvedCount}건이다.`,
    '',
    markdownTable(['ID', '구성요소', '결함', '원인', '솔루션', '재시험'], productRows),
    '',
    ...repositorySection,
    `## ${5 + laterSectionOffset + repositorySectionOffset}. 최종·반복 결과와 통계`,
    '',
    markdownTable(['구간', 'cycle', '총 실행', '행동 통과', '계약 통과', '계약 실패', 'fault', 'terminal'], [
      ['최초', initial.cycles, initial.totalExecutions, initial.behavioralPass, initial.contractPass, initial.failed, initial.faultCount, JSON.stringify(initial.terminalStates)],
      ['최종', final.cycles, final.totalExecutions, final.behavioralPass, final.contractPass, final.failed, final.faultCount, JSON.stringify(final.terminalStates)],
      ['반복', soak.cycles, soak.totalExecutions, soak.behavioralPass, soak.contractPass, soak.failed, soak.faultCount, JSON.stringify(soak.terminalStates)]
    ]),
    '',
    `- 관찰 성공률: ${formatPercent(report.statistics.observedSuccessRate, 4)}`,
    `- 명목상 단측 99% 정확 하한: ${formatPercent(report.statistics.oneSided99PercentSuccessRateLowerBound, 4)}`,
    `- 계산: ${report.statistics.method}`,
    `- 해석: ${report.statistics.independenceQualification}`,
    '',
    `독립 재검증은 최종 ${report.independentReverification.final.passed}/${report.independentReverification.final.checkCount}, 반복 ${report.independentReverification.soak.passed}/${report.independentReverification.soak.checkCount}였다. 이 check 수는 campaign·ledger·result·artifact·digest assertion을 합친 값이며 전부가 실물 workspace 재검증이라는 뜻은 아니다.`,
    '',
    markdownTable(['구간', '결과 수', 'retained workspace 직접 재검증', 'hash-chain-bound compacted seal', 'coverage'], [
      ['최종', report.independentReverification.final.resultCount, report.independentReverification.final.retainedWorkspaceArtifactVerifications, report.independentReverification.final.compactedHashChainSealVerifications, report.independentReverification.final.artifactVerificationCoverageComplete ? '완전' : '불완전'],
      ['반복', report.independentReverification.soak.resultCount, report.independentReverification.soak.retainedWorkspaceArtifactVerifications, report.independentReverification.soak.compactedHashChainSealVerifications, report.independentReverification.soak.artifactVerificationCoverageComplete ? '완전' : '불완전']
    ]),
    '',
    `## ${6 + laterSectionOffset + repositorySectionOffset}. 50개 명령 결과 색인`,
    '',
    markdownTable(['ID', '제목', '범주', '단계', '작업', 'fault', '기대 종료', '정지 code', '반복'], commandRows),
    '',
    `## ${7 + laterSectionOffset + repositorySectionOffset}. 증거 무결성`,
    '',
    `- sequence ledger hash chain: 검증 완료`,
    `- 최종 ledger hash: \`${report.evidenceIntegrity.finalLedgerHash}\``,
    `- 반복 ledger hash: \`${report.evidenceIntegrity.soakLedgerHash}\``,
    ...(report.evidenceIntegrity.failedSoakLedgerHash ? [`- 교정 전 반복 ledger hash: \`${report.evidenceIntegrity.failedSoakLedgerHash}\``] : []),
    `- 증거 파일: ${report.evidenceIntegrity.evidenceFileCount}개`,
    '',
    markdownTable(['역할', '파일', 'SHA-256'], report.evidenceFiles.map((item) => [item.role, item.path, `\`${item.sha256}\``])),
    '',
    `## ${8 + laterSectionOffset + repositorySectionOffset}. 한계`,
    '',
    ...report.limitations.map((item) => `- ${item}`),
    '',
    '## 부록 A. A01-A50 명령 전문과 계약',
    '',
    commandDetails
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n');
}

export function parseApexReportArguments(argv) {
  const options = {};
  const flags = {
    '--initial-root': 'initialRoot',
    '--final-root': 'finalRoot',
    '--soak-root': 'soakRoot',
    '--failed-soak-root': 'failedSoakRoot',
    '--product-baseline-root': 'productBaselineRoot',
    '--product-retest-root': 'productRetestRoot',
    '--output-root': 'outputRoot',
    '--remediation': 'remediationPath',
    '--verification': 'verificationPath'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags[flag];
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function readCampaignEvidence(root, { reverificationRequired, allowInvalidCorpus = false }) {
  const paths = {
    campaign: join(root, 'campaign.json'),
    corpus: join(root, 'corpus.json'),
    summary: join(root, 'summary.json'),
    ledger: join(root, 'sequence-ledger.jsonl'),
    reverification: join(root, 'reverification.json')
  };
  const [campaign, corpusBytes, summary, ledgerText] = await Promise.all([
    readJsonRequired(paths.campaign),
    readFileRequired(paths.corpus),
    readJsonRequired(paths.summary),
    readTextRequired(paths.ledger)
  ]);
  let corpus = null;
  let corpusParseError = null;
  try {
    corpus = parseJson(corpusBytes.toString('utf8'), paths.corpus);
  } catch (error) {
    corpusParseError = error.message;
    if (!allowInvalidCorpus) throw error;
  }
  const corpusIntegrity = corpus && Array.isArray(corpus?.cases)
    ? {
        status: 'verified',
        path: paths.corpus,
        byteSha256: sha256(corpusBytes),
        parseError: null,
        campaignSelectedCorpusSha256: campaign.selectedCorpusSha256,
        parsedCorpusSha256: sha256Json(corpus)
      }
    : {
        status: 'degraded',
        path: paths.corpus,
        byteSha256: sha256(corpusBytes),
        parseError: corpusParseError ?? `Campaign corpus has no cases array: ${paths.corpus}`,
        rawUtf8Preview: corpusBytes.toString('utf8').slice(0, 200),
        campaignSelectedCorpusSha256: campaign.selectedCorpusSha256,
        parsedCorpusSha256: null
      };
  if (corpus && !Array.isArray(corpus?.cases)) {
    if (!allowInvalidCorpus) throw new Error(`Campaign corpus must contain a cases array: ${paths.corpus}`);
    corpus = null;
  }
  if (stableStringify(summary.campaign) !== stableStringify(campaign)) {
    throw new Error(`summary.json campaign differs from campaign.json: ${root}`);
  }
  if (campaign.campaignSha256 !== undefined) {
    validateEmbeddedDigest(campaign, 'campaignSha256', ['generatedAt'], paths.campaign);
  }
  validateEmbeddedDigest(summary, 'summarySha256', ['updatedAt'], paths.summary);
  if (corpus && campaign.selectedCorpusSha256 !== sha256Json(corpus)) {
    throw new Error(`Corpus SHA-256 mismatch at ${paths.corpus}: campaign=${campaign.selectedCorpusSha256}, actual=${sha256Json(corpus)}.`);
  }
  const ledger = parseJsonLines(ledgerText, paths.ledger);
  validateCampaignTotals({ root, campaign, summary, corpus, ledger });
  validateLedgerChain({ root, campaign, corpus, ledger });
  let reverification = null;
  if (await pathExists(paths.reverification)) {
    reverification = await readJsonRequired(paths.reverification);
    validateEmbeddedDigest(reverification, 'reportSha256', ['checkedAt'], paths.reverification);
    if (!Number.isInteger(reverification.checkCount)
      || !Number.isInteger(reverification.passed)
      || !Number.isInteger(reverification.failed)
      || reverification.checkCount < 1
      || reverification.passed < 0
      || reverification.failed < 0
      || reverification.passed + reverification.failed !== reverification.checkCount) {
      throw new Error(`Reverification totals are inconsistent at ${root}.`);
    }
    if (!Array.isArray(reverification.checks)
      || reverification.checks.length !== reverification.checkCount
      || reverification.checks.some((check) => typeof check?.name !== 'string' || typeof check?.pass !== 'boolean')) {
      throw new Error(`Reverification checks do not match checkCount at ${root}.`);
    }
    const actualReverificationPassed = reverification.checks.filter((check) => check.pass === true).length;
    const actualReverificationFailed = reverification.checks.length - actualReverificationPassed;
    if (actualReverificationPassed !== reverification.passed || actualReverificationFailed !== reverification.failed) {
      throw new Error(`Reverification check results differ from declared totals at ${root}.`);
    }
    const expectedReverificationStatus = reverification.failed === 0 ? 'passed' : 'failed';
    if (reverification.status !== expectedReverificationStatus) {
      throw new Error(`Reverification status is inconsistent at ${root}: ${reverification.status} != ${expectedReverificationStatus}.`);
    }
    if (reverification.resultCount !== summary.totalExecutions) {
      throw new Error(`Reverification result count mismatch at ${root}: ${reverification.resultCount} != ${summary.totalExecutions}.`);
    }
    if (!Number.isInteger(reverification.retainedArtifactVerifications)
      || reverification.retainedArtifactVerifications < 0
      || !Number.isInteger(reverification.compactedArtifactVerifications)
      || reverification.compactedArtifactVerifications < 0
      || reverification.retainedArtifactVerifications + reverification.compactedArtifactVerifications !== reverification.resultCount) {
      throw new Error(`Reverification retained/compacted artifact coverage is inconsistent at ${root}.`);
    }
    const retainedWorkspaceChecks = reverification.checks.filter((check) => /independent retained artifact verification$/u.test(check.name)).length;
    const compactedSealChecks = reverification.checks.filter((check) => /compacted artifact seal verification$/u.test(check.name)).length;
    if (retainedWorkspaceChecks !== reverification.retainedArtifactVerifications
      || compactedSealChecks !== reverification.compactedArtifactVerifications) {
      throw new Error(`Reverification retained/compacted check evidence differs from declared coverage at ${root}.`);
    }
    if (reverification.corpusSha256 !== campaign.selectedCorpusSha256) {
      throw new Error(`Reverification corpus hash mismatch at ${root}.`);
    }
    if (campaign.campaignSha256 !== undefined
      && reverification.campaignSha256 !== campaign.campaignSha256) {
      throw new Error(`Reverification campaign hash mismatch at ${root}.`);
    }
    if (reverification.finalLedgerHash !== (ledger.at(-1)?.hash ?? 'GENESIS')) {
      throw new Error(`Reverification ledger hash mismatch at ${root}.`);
    }
  }
  if (reverificationRequired && !reverification) {
    throw new Error(`Required evidence file is missing: ${paths.reverification}`);
  }
  return { root, paths, campaign, corpus, corpusIntegrity, summary, ledger, reverification };
}

function validateCampaignTotals({ root, campaign, summary, corpus, ledger }) {
  const caseIds = corpus?.cases?.map((item) => item.id) ?? campaign.selectedCaseIds;
  if (!Array.isArray(caseIds) || caseIds.length === 0) throw new Error(`Campaign has no selected cases at ${root}.`);
  const expectedExecutions = caseIds.length * campaign.cycles;
  if (!Number.isInteger(campaign.cycles) || campaign.cycles < 1) throw new Error(`Invalid campaign cycle count at ${root}.`);
  if (campaign.totalExecutions !== expectedExecutions || summary.totalExecutions !== expectedExecutions) {
    throw new Error(`Campaign execution totals are inconsistent at ${root}: expected ${expectedExecutions}, campaign ${campaign.totalExecutions}, summary ${summary.totalExecutions}.`);
  }
  if (!Number.isInteger(summary.behavioralPass) || summary.behavioralPass < 0 || summary.behavioralPass > summary.totalExecutions) {
    throw new Error(`Behavioral pass count is inconsistent at ${root}.`);
  }
  const contractPass = summary.contractPass ?? summary.behavioralPass;
  if (!Number.isInteger(contractPass) || contractPass + summary.failed !== summary.totalExecutions) {
    throw new Error(`Contract totals are inconsistent at ${root}: ${contractPass} + ${summary.failed} != ${summary.totalExecutions}.`);
  }
  if ((summary.failedCases ?? []).length !== summary.failed) {
    throw new Error(`failedCases count is inconsistent at ${root}.`);
  }
  if (ledger.length !== summary.totalExecutions) {
    throw new Error(`Ledger count mismatch at ${root}: ${ledger.length} != ${summary.totalExecutions}.`);
  }
  if (corpus && stableStringify(campaign.selectedCaseIds) !== stableStringify(caseIds)) {
    throw new Error(`Campaign selectedCaseIds differ from corpus order at ${root}.`);
  }
}

function validateLedgerChain({ root, campaign, corpus, ledger }) {
  const caseIds = corpus?.cases?.map((item) => item.id) ?? campaign.selectedCaseIds;
  validateCycleVariations({ root, campaign, caseIds });
  const variationByCycle = new Map((campaign.cycleVariations ?? []).map((item) => [item.cycle, item]));
  let previousHash = 'GENESIS';
  for (let index = 0; index < ledger.length; index += 1) {
    const record = ledger[index];
    const expectedCycle = Math.floor(index / caseIds.length) + 1;
    const orderIndex = index % caseIds.length;
    const variation = variationByCycle.get(expectedCycle);
    const executionOrder = variation?.executionOrder ?? caseIds;
    const expectedCaseId = executionOrder[orderIndex];
    const unsigned = { ...record };
    delete unsigned.hash;
    if (record.sequence !== index + 1 || record.caseId !== expectedCaseId || record.cycle !== expectedCycle) {
      throw new Error(`Ledger sequence mismatch at ${root}, record ${index + 1}.`);
    }
    if (record.orderIndex !== undefined && record.orderIndex !== orderIndex + 1) {
      throw new Error(`Ledger orderIndex mismatch at ${root}, record ${index + 1}.`);
    }
    if (variation?.variationSha256 && record.variationSha256 !== variation.variationSha256) {
      throw new Error(`Ledger variation hash mismatch at ${root}, record ${index + 1}.`);
    }
    if (campaign.campaignSha256 !== undefined
      && record.campaignSha256 !== campaign.campaignSha256) {
      throw new Error(`Ledger campaign hash mismatch at ${root}, record ${index + 1}.`);
    }
    if (record.previousHash !== previousHash) {
      throw new Error(`Ledger previousHash mismatch at ${root}, record ${index + 1}.`);
    }
    if (record.hash !== sha256Json(unsigned)) {
      throw new Error(`Ledger record hash mismatch at ${root}, record ${index + 1}.`);
    }
    previousHash = record.hash;
  }
  if (ledger.length !== campaign.totalExecutions) throw new Error(`Ledger execution count mismatch at ${root}.`);
}

function validateCycleVariations({ root, campaign, caseIds }) {
  if (campaign.cycleVariations === undefined) return;
  const variations = campaign.cycleVariations;
  if (!Array.isArray(variations) || variations.length !== campaign.cycles) {
    throw new Error(`Cycle variations must cover every campaign cycle exactly once at ${root}.`);
  }
  const cycleNumbers = variations.map((item) => item?.cycle);
  const expectedCycles = Array.from({ length: campaign.cycles }, (_, index) => index + 1);
  if (stableStringify([...cycleNumbers].sort((a, b) => a - b)) !== stableStringify(expectedCycles)) {
    throw new Error(`Cycle variation numbers are missing, duplicated, or out of range at ${root}.`);
  }
  const expectedCaseSet = new Set(caseIds);
  for (const variation of variations) {
    if (!Array.isArray(variation.executionOrder)
      || variation.executionOrder.length !== caseIds.length
      || new Set(variation.executionOrder).size !== caseIds.length
      || variation.executionOrder.some((caseId) => !expectedCaseSet.has(caseId))) {
      throw new Error(`Cycle ${variation.cycle} executionOrder is not a permutation of selected cases at ${root}.`);
    }
    const unsigned = { ...variation };
    delete unsigned.variationSha256;
    if (!/^[a-f0-9]{64}$/u.test(variation.variationSha256 ?? '')
      || variation.variationSha256 !== sha256Json(unsigned)) {
      throw new Error(`Cycle ${variation.cycle} variationSha256 mismatch at ${root}.`);
    }
  }
}

function validateCampaignRelationship({ initial, final, soak, failedSoak }) {
  const finalIds = final.corpus.cases.map((item) => item.id);
  const soakIds = soak.corpus.cases.map((item) => item.id);
  const initialIds = initial.corpus?.cases?.map((item) => item.id) ?? initial.campaign.selectedCaseIds;
  if (stableStringify(finalIds) !== stableStringify(EXPECTED_CASE_IDS)) {
    throw new Error(`Final corpus must contain A01-A50 exactly; found ${finalIds.join(', ')}.`);
  }
  if (stableStringify(initialIds) !== stableStringify(EXPECTED_CASE_IDS)) {
    throw new Error('Initial corpus must contain A01-A50 exactly.');
  }
  if (stableStringify(soakIds) !== stableStringify(finalIds)) {
    throw new Error('Soak case IDs or order differ from the final corpus.');
  }
  if (final.campaign.selectedCorpusSha256 !== soak.campaign.selectedCorpusSha256) {
    throw new Error('Final and soak corpus hashes differ.');
  }
  if (failedSoak) {
    const failedSoakIds = failedSoak.corpus.cases.map((item) => item.id);
    if (stableStringify(failedSoakIds) !== stableStringify(finalIds)) throw new Error('Failed-soak case IDs differ from the final corpus.');
    if (failedSoak.campaign.selectedCorpusSha256 !== final.campaign.selectedCorpusSha256) throw new Error('Failed-soak and final corpus hashes differ.');
  }
  for (const evidence of [final, soak, ...(failedSoak ? [failedSoak] : [])]) {
    const byCase = groupLedgerByCase(evidence.ledger);
    for (const caseId of EXPECTED_CASE_IDS) {
      const count = byCase.get(caseId)?.length ?? 0;
      if (count !== evidence.campaign.cycles) {
        throw new Error(`${caseId} has ${count} records instead of ${evidence.campaign.cycles} at ${evidence.root}.`);
      }
    }
  }
}

async function readProductEvidence(rootOrFile) {
  const path = await resolveRootFile(rootOrFile, 'product-probe.json');
  const data = await readJsonRequired(path);
  validateEmbeddedDigest(data, 'reportSha256', ['generatedAt'], path);
  validateProbeTotals(data, path);
  return { root: dirname(path), path, data };
}

function validateProductRelationship(baseline, retest) {
  const baselineIds = baseline.probes.map((item) => item.id);
  const retestIds = retest.probes.map((item) => item.id);
  const expectedIds = Object.keys(PRODUCT_PROBE_CATALOG);
  if (stableStringify(baselineIds) !== stableStringify(expectedIds)) {
    throw new Error(`Product baseline must contain the ${expectedIds.length} catalog probes in order.`);
  }
  if (stableStringify(baselineIds) !== stableStringify(retestIds)) {
    throw new Error('Product baseline and retest probe IDs or order differ.');
  }
  if (baseline.probes.some((item) => item.passed === true) || retest.probes.some((item) => item.passed !== true)) {
    throw new Error('Product evidence must preserve the all-failed baseline and all-passed retest for the catalog probes.');
  }
}

function validateProbeTotals(report, path) {
  if (!Array.isArray(report.probes)) throw new Error(`Product probe report has no probes array: ${path}`);
  const actualPassed = report.probes.filter((item) => item.passed === true).length;
  const actualFailed = report.probes.length - actualPassed;
  if (report.total !== report.probes.length || report.passed !== actualPassed || report.failed !== actualFailed) {
    throw new Error(`Product probe totals are inconsistent: ${path}`);
  }
}

async function readRepositoryVerification(cwd, rootOrFile) {
  const path = await resolveRootFile(rootOrFile, 'final-verification.json');
  const [data, bytes] = await Promise.all([readJsonRequired(path), readFileRequired(path)]);
  if (data.verificationVersion !== 'jarvis-apex-final-verification-v1') {
    throw new Error(`Unsupported repository verification version at ${path}: ${data.verificationVersion}.`);
  }
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) {
    throw new Error(`Repository verification generatedAt is invalid: ${path}`);
  }
  validateEmbeddedDigest(data, 'reportSha256', ['generatedAt'], path);
  if (!Array.isArray(data.gates) || data.gates.length < 3) {
    throw new Error(`Repository verification must contain at least three gates: ${path}`);
  }
  const ids = data.gates.map((gate) => gate.id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error(`Repository verification gate IDs are missing or duplicated: ${path}`);
  }
  const passed = data.gates.filter((gate) => gate.status === 'passed').length;
  const failed = data.gates.filter((gate) => gate.status === 'failed').length;
  if (passed + failed !== data.gates.length
    || data.total !== data.gates.length
    || data.passed !== passed
    || data.failed !== failed) {
    throw new Error(`Repository verification totals are inconsistent: ${path}`);
  }
  const expectedStatus = failed === 0 ? 'passed' : 'failed';
  if (data.status !== expectedStatus) {
    throw new Error(`Repository verification status is inconsistent at ${path}: ${data.status} != ${expectedStatus}.`);
  }
  const gateEvidence = [];
  for (const gate of data.gates) {
    if (typeof gate.command !== 'string' || gate.command.length === 0) {
      throw new Error(`Repository verification gate ${gate.id} has no command: ${path}`);
    }
    if (!Number.isInteger(gate.exitCode)) {
      throw new Error(`Repository verification gate ${gate.id} has an invalid exitCode: ${path}`);
    }
    if ((gate.status === 'passed') !== (gate.exitCode === 0)) {
      throw new Error(`Repository verification gate ${gate.id} status and exitCode disagree: ${path}`);
    }
    if (!gate.summary || typeof gate.summary !== 'object' || Array.isArray(gate.summary) || Object.keys(gate.summary).length === 0) {
      throw new Error(`Repository verification gate ${gate.id} has no structured summary: ${path}`);
    }
    if (Number.isInteger(gate.summary.total)
      && Number.isInteger(gate.summary.pass)
      && Number.isInteger(gate.summary.fail)
      && gate.summary.pass + gate.summary.fail !== gate.summary.total) {
      throw new Error(`Repository verification gate ${gate.id} probe summary is inconsistent: ${path}`);
    }
    if (Number.isInteger(gate.summary.tests)
      && Number.isInteger(gate.summary.pass)
      && Number.isInteger(gate.summary.fail)
      && Number.isInteger(gate.summary.skipped)
      && gate.summary.pass + gate.summary.fail + gate.summary.skipped !== gate.summary.tests) {
      throw new Error(`Repository verification gate ${gate.id} test summary is inconsistent: ${path}`);
    }
    if (gate.status === 'passed' && Number.isInteger(gate.summary.fail) && gate.summary.fail !== 0) {
      throw new Error(`Repository verification gate ${gate.id} passed with a nonzero summary failure count: ${path}`);
    }
    if (typeof gate.evidencePath !== 'string' || gate.evidencePath.length === 0
      || !/^[a-f0-9]{64}$/u.test(gate.evidenceSha256 ?? '')) {
      throw new Error(`Repository verification gate ${gate.id} has invalid evidence metadata: ${path}`);
    }
    const evidencePath = resolve(cwd, gate.evidencePath);
    const rawRelativePath = relative(cwd, evidencePath);
    const relativePath = normalizeDisplayPath(rawRelativePath);
    if (isAbsolute(rawRelativePath) || relativePath === '..' || relativePath.startsWith('../')) {
      throw new Error(`Repository verification gate ${gate.id} evidence escapes the project root: ${gate.evidencePath}`);
    }
    const evidenceBytes = await readFileRequired(evidencePath);
    const evidenceSha256 = sha256(evidenceBytes);
    if (evidenceSha256 !== gate.evidenceSha256) {
      throw new Error(`Repository verification gate ${gate.id} evidence SHA-256 mismatch: ${evidencePath}.`);
    }
    gateEvidence.push({ gateId: gate.id, path: evidencePath, relativePath, sizeBytes: evidenceBytes.length, sha256: evidenceSha256 });
  }
  const roles = new Set(data.gates.map(classifyRepositoryVerificationGate).filter(Boolean));
  for (const requiredRole of ['product-probe', 'full-test', 'production-build']) {
    if (!roles.has(requiredRole)) {
      throw new Error(`Repository verification is missing the required ${requiredRole} gate: ${path}`);
    }
  }
  return {
    path,
    data,
    sizeBytes: bytes.length,
    fileSha256: sha256(bytes),
    gateEvidence
  };
}

function classifyRepositoryVerificationGate(gate) {
  const identity = `${gate.id} ${gate.command}`.toLowerCase();
  if (/\bnpm(?:\.cmd)?\s+run\s+build\b/u.test(identity)) return 'production-build';
  if (/\bnpm(?:\.cmd)?\s+(?:run\s+)?test\b/u.test(identity)) return 'full-test';
  if (/probe/u.test(identity)
    && Number.isInteger(gate.summary?.total)
    && Number.isInteger(gate.summary?.pass)
    && Number.isInteger(gate.summary?.fail)) return 'product-probe';
  return 'supplemental';
}

function repositoryVerificationDigest(cwd, evidence) {
  return {
    verificationVersion: evidence.data.verificationVersion,
    generatedAt: evidence.data.generatedAt,
    status: evidence.data.status,
    total: evidence.data.total,
    passed: evidence.data.passed,
    failed: evidence.data.failed,
    path: normalizeDisplayPath(relative(cwd, evidence.path)),
    fileSha256: evidence.fileSha256,
    reportSha256: evidence.data.reportSha256,
    gates: evidence.data.gates.map((gate) => {
      const stored = evidence.gateEvidence.find((item) => item.gateId === gate.id);
      return {
        id: gate.id,
        role: classifyRepositoryVerificationGate(gate),
        command: gate.command,
        status: gate.status,
        exitCode: gate.exitCode,
        summary: gate.summary,
        evidencePath: stored?.relativePath ?? gate.evidencePath,
        evidenceSizeBytes: stored?.sizeBytes ?? null,
        evidenceSha256: stored?.sha256 ?? gate.evidenceSha256
      };
    })
  };
}

function buildProductResilience(baselineEvidence, retestEvidence, remediationFixes = []) {
  const retestById = new Map(retestEvidence.data.probes.map((item) => [item.id, item]));
  const remediationByProbe = new Map();
  for (const fix of remediationFixes) {
    for (const probeId of fix.probeIds) remediationByProbe.set(probeId, fix);
  }
  const findings = baselineEvidence.data.probes
    .filter((item) => item.passed !== true)
    .map((baselineProbe) => {
      const retestProbe = retestById.get(baselineProbe.id);
      const catalog = PRODUCT_PROBE_CATALOG[baselineProbe.id];
      const remediation = remediationByProbe.get(baselineProbe.id);
      return {
        id: baselineProbe.id,
        component: catalog?.component ?? '미분류 제품 경계',
        title: catalog?.title ?? baselineProbe.id,
        rootCause: catalog?.rootCause ?? 'probe가 기대 계약 위반을 기록했으나 보고서 코드에는 원인 설명이 등록되지 않았다.',
        correction: catalog?.correction ?? remediation?.solution ?? '동일 probe 재시험 결과만 보존한다. 구체 수정은 별도 remediation evidence가 필요하다.',
        changedFiles: remediation?.files ?? [],
        cataloged: Boolean(catalog),
        baselinePassed: false,
        baselineObserved: baselineProbe.observed ?? baselineProbe.detail ?? null,
        retestPassed: retestProbe?.passed === true,
        retestObserved: retestProbe?.observed ?? retestProbe?.detail ?? null,
        status: retestProbe?.passed === true ? 'resolved-and-regression-covered' : 'unresolved'
      };
    });
  return {
    baseline: {
      total: baselineEvidence.data.total,
      passed: baselineEvidence.data.passed,
      failed: baselineEvidence.data.failed,
      reportSha256: baselineEvidence.data.reportSha256
    },
    retest: {
      total: retestEvidence.data.total,
      passed: retestEvidence.data.passed,
      failed: retestEvidence.data.failed,
      reportSha256: retestEvidence.data.reportSha256
    },
    initiallyFailedCount: findings.length,
    resolvedCount: findings.filter((item) => item.status === 'resolved-and-regression-covered').length,
    unresolvedCount: findings.filter((item) => item.status === 'unresolved').length,
    findings
  };
}

async function readRemediationEvidence(roots, explicitPath, explicitRequired) {
  const paths = [];
  const records = [];
  const productFixes = [];
  const soakFailureGroups = [];
  const repositoryRegressionGroups = [];
  let initialCorpusRecord = null;
  const candidates = [explicitPath, ...roots.flatMap((root) => [join(root, 'remediation.json'), join(root, 'remediations.json')])];
  for (const path of candidates) {
      if (!(await pathExists(path))) {
        if (explicitRequired && path === explicitPath) throw new Error(`Required remediation evidence is missing: ${path}`);
        continue;
      }
      if (paths.includes(path)) continue;
      const data = await readJsonRequired(path);
      const items = Array.isArray(data) ? data : data.repairs ?? data.findings ?? data.cases ?? [];
      if (!Array.isArray(items)) throw new Error(`Remediation evidence repair records must be an array: ${path}`);
      for (const item of items) {
        if (!EXPECTED_CASE_IDS.includes(item.caseId)) throw new Error(`Invalid remediation caseId at ${path}: ${item.caseId}`);
        records.push({
          caseId: item.caseId,
          defectClass: item.defectClass ?? item.failureClass ?? null,
          rootCause: item.rootCause ?? null,
          correction: item.correction ?? item.solution ?? null,
          changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles : [],
          focusedVerification: item.focusedVerification ?? item.verification ?? null,
          evidenceSource: path
        });
      }
      for (const group of data.missionFailureGroups ?? []) {
        if (!Array.isArray(group.cases)) throw new Error(`missionFailureGroups cases must be an array: ${path}`);
        for (const caseId of group.cases) {
          if (!EXPECTED_CASE_IDS.includes(caseId)) throw new Error(`Invalid remediation caseId at ${path}: ${caseId}`);
          records.push({
            caseId,
            defectClass: group.id ?? 'mission-failure-group',
            rootCause: group.rootCause ?? null,
            correction: group.solution ?? null,
            changedFiles: Array.isArray(group.files) ? group.files : [],
            focusedVerification: group.regression ?? null,
            symptom: group.symptom ?? null,
            evidenceSource: path
          });
        }
      }
      for (const fix of data.productProbe?.fixes ?? []) {
        if (!Array.isArray(fix.probeIds)) throw new Error(`productProbe.fix probeIds must be an array: ${path}`);
        productFixes.push({ probeIds: fix.probeIds, files: fix.files ?? [], solution: fix.solution ?? null, evidenceSource: path });
      }
      for (const group of data.soakFailureGroups ?? data.campaignFailureGroups ?? []) {
        soakFailureGroups.push({ ...group, evidenceSource: path });
      }
      for (const group of data.repositoryRegressionGroups ?? []) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
          throw new Error(`repositoryRegressionGroups entries must be objects: ${path}`);
        }
        if (typeof group.id !== 'string' || group.id.length === 0) {
          throw new Error(`repositoryRegressionGroups entry has no ID: ${path}`);
        }
        const declaredGateIds = group.verificationGateIds
          ?? group.gateIds
          ?? group.regressionGateIds
          ?? group.verification?.gateIds
          ?? [];
        if (!Array.isArray(declaredGateIds) || declaredGateIds.some((id) => typeof id !== 'string' || id.length === 0)) {
          throw new Error(`repositoryRegressionGroups ${group.id} gate IDs must be a string array: ${path}`);
        }
        const changedFiles = group.changedFiles ?? group.files ?? [];
        if (!Array.isArray(changedFiles) || changedFiles.some((file) => typeof file !== 'string' || file.length === 0)) {
          throw new Error(`repositoryRegressionGroups ${group.id} changed files must be a string array: ${path}`);
        }
        repositoryRegressionGroups.push({
          id: group.id,
          component: group.component ?? null,
          symptom: group.symptom ?? group.observed ?? null,
          rootCause: group.rootCause ?? group.cause ?? null,
          correction: group.solution ?? group.correction ?? null,
          changedFiles,
          regression: group.regression ?? group.focusedVerification ?? null,
          declaredGateIds: [...new Set(declaredGateIds)],
          evidenceSource: path
        });
      }
      if (data.initialMissionRun?.corpusPayload) {
        initialCorpusRecord = { ...data.initialMissionRun.corpusPayload, evidenceSource: path };
      }
      paths.push(path);
  }
  const repositoryGroupIds = repositoryRegressionGroups.map((item) => item.id);
  if (new Set(repositoryGroupIds).size !== repositoryGroupIds.length) {
    throw new Error(`repositoryRegressionGroups IDs are duplicated across remediation evidence: ${repositoryGroupIds.join(', ')}.`);
  }
  return { paths, records, productFixes, initialCorpusRecord, soakFailureGroups, repositoryRegressionGroups };
}

function buildRepositoryRegressionGroups({ cwd, groups, repositoryVerification }) {
  if (!groups.length) return [];
  const verificationDigest = repositoryVerification ? repositoryVerificationDigest(cwd, repositoryVerification) : null;
  const gateById = new Map((verificationDigest?.gates ?? []).map((gate) => [gate.id, gate]));
  return groups.map((group) => {
    const selectedGateIds = group.declaredGateIds.length
      ? group.declaredGateIds
      : [...gateById.keys()];
    const missingGateIds = selectedGateIds.filter((id) => !gateById.has(id));
    if (repositoryVerification && missingGateIds.length) {
      throw new Error(`Repository regression group ${group.id} references unknown verification gate(s): ${missingGateIds.join(', ')}.`);
    }
    const verificationGates = selectedGateIds.map((id) => gateById.get(id)).filter(Boolean);
    const documentationComplete = Boolean(group.rootCause && group.correction);
    const regressionCovered = verificationGates.length > 0 && verificationGates.every((gate) => gate.status === 'passed');
    let status = 'resolved-and-regression-covered';
    if (!documentationComplete) status = 'missing-remediation-details';
    else if (!repositoryVerification || verificationGates.length === 0) status = 'verification-not-linked';
    else if (!regressionCovered) status = 'regression-failed';
    return {
      id: group.id,
      component: group.component,
      symptom: group.symptom,
      rootCause: group.rootCause,
      correction: group.correction,
      changedFiles: group.changedFiles,
      regression: group.regression,
      source: normalizeDisplayPath(relative(cwd, group.evidenceSource)),
      verificationLink: group.declaredGateIds.length ? 'declared-gates' : 'repository-wide-gates',
      verificationGateIds: selectedGateIds,
      missingVerificationGateIds: missingGateIds,
      verificationGates,
      documentationComplete,
      regressionCovered,
      status
    };
  });
}

async function buildInitialFindings({ cwd, initial, corpusCases, finalByCase, soakByCase, remediationByCase }) {
  const caseById = new Map(corpusCases.map((item) => [item.id, item]));
  const findings = [];
  for (const failure of initial.summary.failedCases ?? []) {
    const ledgerRecord = initial.ledger.find((item) => item.cycle === failure.cycle && item.caseId === failure.caseId);
    const resultPath = caseResultPath(initial.root, failure.cycle, failure.caseId);
    let result = null;
    let resultSha256 = null;
    if (await pathExists(resultPath)) {
      const bytes = await readFile(resultPath);
      resultSha256 = sha256(bytes);
      if (ledgerRecord?.resultSha256 && ledgerRecord.resultSha256 !== resultSha256) {
        throw new Error(`Initial failed result SHA-256 differs from ledger: ${resultPath}`);
      }
      result = parseJson(bytes.toString('utf8'), resultPath);
    }
    const failedAssertionObjects = (result?.assertions ?? [])
      .filter((item) => item.pass !== true)
      .map((item) => ({ name: item.name, detail: item.detail ?? null }));
    const failedAssertions = failure.failedAssertions?.length
      ? failure.failedAssertions
      : failedAssertionObjects.map((item) => item.name);
    const remediationRecords = remediationByCase.get(failure.caseId) ?? [];
    const remediation = combineRemediationRecords(remediationRecords);
    const finalRetest = summarizeCaseRecords(finalByCase.get(failure.caseId) ?? []);
    const soakRetest = summarizeCaseRecords(soakByCase.get(failure.caseId) ?? []);
    const retestedPass = finalRetest.executions > 0 && finalRetest.failed === 0
      && soakRetest.executions > 0 && soakRetest.failed === 0;
    findings.push({
      caseId: failure.caseId,
      title: caseById.get(failure.caseId)?.title ?? failure.caseId,
      category: caseById.get(failure.caseId)?.category ?? null,
      failureClass: remediation?.defectClass ?? classifyFailure(failedAssertions, result?.engineError ?? failure.engineError),
      initialCycle: failure.cycle,
      initialTerminalState: failure.terminalState ?? result?.terminalState ?? null,
      initialStopCode: failure.stopCode ?? result?.stopCode ?? null,
      failedAssertions,
      failedAssertionDetails: failedAssertionObjects,
      engineError: result?.engineError ?? failure.engineError ?? null,
      observedDiagnosis: observedDiagnosis(failedAssertions, result?.engineError ?? failure.engineError),
      initialResultEvidence: result ? {
        path: normalizeDisplayPath(relative(cwd, resultPath)),
        sha256: resultSha256
      } : null,
      remediation: remediation ? {
        documentationStatus: 'documented',
        source: remediation.evidenceSources.map((path) => normalizeDisplayPath(relative(cwd, path))).join(', '),
        rootCause: remediation.rootCause,
        correction: remediation.correction,
        changedFiles: remediation.changedFiles,
        focusedVerification: remediation.focusedVerification
      } : {
        documentationStatus: 'missing-remediation-ledger',
        source: null,
        rootCause: null,
        correction: null,
        changedFiles: [],
        focusedVerification: null
      },
      finalRetest,
      soakRetest,
      resolutionStatus: retestedPass
        ? remediation ? 'resolved-and-regression-covered' : 'retested-passed-remediation-undocumented'
        : 'unresolved'
    });
  }
  return findings;
}

function classifyFailure(assertions, engineError) {
  const joined = assertions.join(' ').toLowerCase();
  if (engineError) return '실행 엔진·fixture';
  if (/virtual time|wall time|budget/u.test(joined)) return '예산·시간 모델';
  if (/artifact|산출물|valid zip|valid json|valid xlsx|reread/u.test(joined)) return '산출물 생성·검증';
  if (/stop code|terminal state/u.test(joined)) return '종료 계약';
  if (/fault|call count|ordered events|journal/u.test(joined)) return '실행 trace 계약';
  return '행동 계약';
}

function observedDiagnosis(assertions, engineError) {
  if (engineError) return `실행 결과가 ${engineError.code ?? engineError.name ?? 'engine error'}를 기록했다: ${engineError.message ?? '메시지 없음'}`;
  if (assertions.length) return `최초 결과에서 다음 계약 검사가 실패했다: ${assertions.join(', ')}.`;
  return '최초 summary는 실패를 기록했지만 세부 assertion 또는 engine error가 남아 있지 않다.';
}

function combineRemediationRecords(records) {
  if (!records.length) return null;
  return {
    defectClass: [...new Set(records.map((item) => item.defectClass).filter(Boolean))].join(' + ') || null,
    rootCause: records.map((item) => item.rootCause).filter(Boolean).join(' / ') || null,
    correction: records.map((item) => item.correction).filter(Boolean).join(' / ') || null,
    changedFiles: [...new Set(records.flatMap((item) => item.changedFiles ?? []))],
    focusedVerification: records.map((item) => item.focusedVerification).filter(Boolean).join(' / ') || null,
    evidenceSources: [...new Set(records.map((item) => item.evidenceSource))]
  };
}

function buildEvidenceDefects({ cwd, initial, final, remediationEvidence, currentSourceCorpusSha256 }) {
  if (initial.corpusIntegrity.status === 'verified') return [];
  const documented = remediationEvidence.initialCorpusRecord;
  return [{
    id: 'INITIAL_CORPUS_PAYLOAD_NOT_SERIALIZED',
    defectClass: '감사 runner 증거 직렬화 결함',
    status: final.corpusIntegrity.status === 'verified' ? 'resolved-in-final-run-original-preserved' : 'unresolved',
    observed: {
      path: normalizeDisplayPath(relative(cwd, initial.corpusIntegrity.path)),
      byteSha256: initial.corpusIntegrity.byteSha256,
      rawUtf8Preview: initial.corpusIntegrity.rawUtf8Preview,
      parseError: initial.corpusIntegrity.parseError,
      campaignSelectedCorpusSha256: initial.campaign.selectedCorpusSha256,
      currentSourceCorpusSha256,
      campaignHashMatchesCurrentSource: initial.campaign.selectedCorpusSha256 === currentSourceCorpusSha256
    },
    rootCause: documented?.cause ?? null,
    correction: documented?.solution ?? null,
    evidenceSource: documented?.evidenceSource ? normalizeDisplayPath(relative(cwd, documented.evidenceSource)) : null,
    regression: final.corpusIntegrity.status === 'verified'
      ? `최종 실행은 유효한 canonical corpus payload를 저장했고 campaign hash ${final.campaign.selectedCorpusSha256}와 일치했다.`
      : '최종 corpus payload 검증이 통과하지 않았다.'
  }];
}

function campaignDigest(evidence, cwd) {
  return {
    root: normalizeDisplayPath(relative(cwd, evidence.root)),
    cycles: evidence.campaign.cycles,
    totalExecutions: evidence.summary.totalExecutions,
    behavioralPass: evidence.summary.behavioralPass,
    behavioralFailed: evidence.summary.totalExecutions - evidence.summary.behavioralPass,
    contractPass: evidence.summary.contractPass ?? evidence.summary.behavioralPass,
    failed: evidence.summary.failed,
    outcomes: evidence.summary.outcomes ?? {},
    terminalStates: evidence.summary.terminalStates ?? {},
    faultCount: evidence.summary.faultCount ?? 0,
    faultConsumptionFailures: evidence.summary.faultConsumptionFailures ?? [],
    semanticDigestMismatches: evidence.summary.semanticDigestMismatches ?? [],
    exactSemanticDigestMismatches: evidence.summary.exactSemanticDigestMismatches ?? evidence.summary.semanticDigestMismatches ?? [],
    behavioralDigestMismatches: evidence.summary.behavioralDigestMismatches ?? [],
    stabilityContract: evidence.summary.stabilityContract ?? null,
    scriptedTraceSupplements: evidence.summary.scriptedTraceSupplements ?? null,
    realExternalAttempts: evidence.summary.realExternalAttempts ?? 0,
    realExternalCommits: evidence.summary.realExternalCommits ?? 0,
    corpusSha256: evidence.campaign.selectedCorpusSha256,
    campaignSha256: evidence.campaign.campaignSha256 ?? null,
    summarySha256: evidence.summary.summarySha256,
    reverificationStatus: evidence.reverification?.status ?? null
  };
}

function buildFailedSoakFinding({ cwd, failedSoak, soak, remediationEvidence }) {
  const mismatchCases = [...new Set((failedSoak.summary.semanticDigestMismatches ?? []).map((item) => item.caseId))];
  const failedContracts = [...new Set((failedSoak.summary.failedCases ?? [])
    .flatMap((item) => item.contractFailures ?? []))];
  if (failedSoak.summary.failed < 1) {
    throw new Error(`--failed-soak-root contains no failed contracts: ${failedSoak.root}`);
  }
  if (mismatchCases.length === 0 || !failedContracts.includes('semantic-digest-unstable-across-cycles')) {
    throw new Error(`--failed-soak-root does not contain the preserved semantic-digest instability evidence: ${failedSoak.root}`);
  }
  const relatedRemediations = remediationEvidence.soakFailureGroups.filter((item) => {
    const cases = item.cases ?? [];
    return cases.some((caseId) => mismatchCases.includes(caseId));
  });
  const documented = relatedRemediations.find((item) => {
    const cases = item.cases ?? [];
    return mismatchCases.length > 0 && mismatchCases.every((caseId) => cases.includes(caseId));
  }) ?? null;
  const digestRegression = assessCorrectedDigestStability(soak, mismatchCases);
  const finalStable = digestRegression.stable;
  const comparableCycleCoverage = soak.campaign.cycles >= failedSoak.campaign.cycles;
  const regressionPassed = soak.summary.behavioralPass === soak.summary.totalExecutions
    && soak.summary.failed === 0
    && soak.reverification.status === 'passed'
    && finalStable
    && comparableCycleCoverage;
  const rootCause = documented?.rootCause ?? documented?.cause ?? null;
  const correction = documented?.solution ?? documented?.correction ?? null;
  const documentationStatus = rootCause && correction ? 'documented' : 'missing';
  const status = !regressionPassed
    ? 'unresolved'
    : documentationStatus === 'documented'
      ? 'resolved-and-regression-covered'
      : 'retested-passed-remediation-undocumented';
  return {
    id: documented?.id ?? 'SEMANTIC_DIGEST_VARIATION_CONTRACT',
    sourceRoot: normalizeDisplayPath(relative(cwd, failedSoak.root)),
    status,
    documentationStatus,
    regressionPassed,
    behavioralPass: failedSoak.summary.behavioralPass,
    behavioralFailed: failedSoak.summary.totalExecutions - failedSoak.summary.behavioralPass,
    contractPass: failedSoak.summary.contractPass ?? failedSoak.summary.behavioralPass,
    contractFailed: failedSoak.summary.failed,
    totalExecutions: failedSoak.summary.totalExecutions,
    affectedCases: mismatchCases,
    affectedExecutionCount: (failedSoak.summary.failedCases ?? []).length,
    failedContract: failedContracts.join(', ') || 'contract-failure-code-not-recorded',
    reverification: reverificationDigest(failedSoak.reverification),
    observed: `${mismatchCases.join(', ')}의 semantic digest가 허용된 cycle variation 사이에서 달라져 contract ${failedSoak.summary.failed}건과 독립 재검증 ${failedSoak.reverification.failed}건이 실패했다.`,
    rootCause,
    correction,
    focusedVerification: documented?.regression ?? null,
    evidenceSource: documented?.evidenceSource ? normalizeDisplayPath(relative(cwd, documented.evidenceSource)) : null,
    remediationSteps: relatedRemediations.map((item) => ({
      id: item.id ?? null,
      cases: item.cases ?? [],
      affectedExecutions: item.affectedExecutions ?? null,
      symptom: item.symptom ?? null,
      rootCause: item.rootCause ?? item.cause ?? null,
      correction: item.solution ?? item.correction ?? null,
      regression: item.regression ?? null,
      evidenceSource: item.evidenceSource ? normalizeDisplayPath(relative(cwd, item.evidenceSource)) : null
    })),
    finalSoak: {
      cycles: soak.campaign.cycles,
      totalExecutions: soak.summary.totalExecutions,
      behavioralPass: soak.summary.behavioralPass,
      behavioralFailed: soak.summary.totalExecutions - soak.summary.behavioralPass,
      contractPass: soak.summary.contractPass ?? soak.summary.behavioralPass,
      contractFailed: soak.summary.failed,
      reverificationStatus: soak.reverification.status,
      affectedCasesStable: finalStable,
      comparableCycleCoverage,
      digestRegression
    }
  };
}

function assessCorrectedDigestStability(soak, caseIds) {
  const variations = soak.campaign.cycleVariations ?? [];
  const variationByCycle = new Map(variations.map((item) => [item.cycle, item]));
  const profileCounts = countBy(variations, (item) => item.virtualClockProfileId ?? item.virtualClockStart ?? 'UNKNOWN');
  const profileCount = Object.keys(profileCounts).length;
  const minimumProfileRepeats = profileCount > 0 ? Math.min(...Object.values(profileCounts)) : 0;
  const behavioralSummaryMismatches = new Set((soak.summary.behavioralDigestMismatches ?? []).map((item) => item.caseId));
  const exactSummaryMismatches = new Set((soak.summary.exactSemanticDigestMismatches
    ?? soak.summary.semanticDigestMismatches
    ?? []).map((item) => item.caseId));
  let behavioralDigestStable = true;
  let exactDigestStableWithinClockProfile = true;
  const cases = [];
  for (const caseId of caseIds) {
    const records = soak.ledger.filter((item) => item.caseId === caseId);
    const behavioralDigests = new Set(records.map((item) => item.behavioralDigest).filter(Boolean));
    const behavioralStable = records.length === soak.campaign.cycles
      && records.every((item) => typeof item.behavioralDigest === 'string' && item.behavioralDigest.length > 0)
      && behavioralDigests.size === 1
      && !behavioralSummaryMismatches.has(caseId);
    const exactGroups = new Map();
    for (const record of records) {
      const variation = variationByCycle.get(record.cycle);
      const profile = variation?.virtualClockProfileId ?? variation?.virtualClockStart ?? 'UNKNOWN';
      if (!exactGroups.has(profile)) exactGroups.set(profile, []);
      exactGroups.get(profile).push(record.semanticDigest);
    }
    const exactStable = profileCount >= 2
      && [...exactGroups.entries()].every(([profile, digests]) =>
        digests.length === profileCounts[profile]
        && digests.every(Boolean)
        && new Set(digests).size === 1)
      && exactGroups.size === profileCount
      && !exactSummaryMismatches.has(caseId);
    behavioralDigestStable &&= behavioralStable;
    exactDigestStableWithinClockProfile &&= exactStable;
    cases.push({
      caseId,
      executions: records.length,
      behavioralDigestCount: behavioralDigests.size,
      exactProfileCount: exactGroups.size,
      behavioralStable,
      exactStable
    });
  }
  const modelDeclared = Boolean(soak.summary.stabilityContract?.behavioralDigestScope
    && soak.summary.stabilityContract?.exactDigestScope);
  const stable = modelDeclared
    && profileCount >= 2
    && minimumProfileRepeats >= 2
    && behavioralDigestStable
    && exactDigestStableWithinClockProfile;
  return {
    evidenceModel: modelDeclared ? 'exact-plus-variation-normalized-behavioral-digest' : 'required-dual-digest-contract-not-declared',
    profileCount,
    minimumProfileRepeats,
    behavioralDigestStable,
    exactDigestStableWithinClockProfile,
    summaryBehavioralMismatchCount: behavioralSummaryMismatches.size,
    summaryExactMismatchCount: exactSummaryMismatches.size,
    cases,
    stable
  };
}

function reverificationDigest(report) {
  return {
    status: report.status,
    checkCount: report.checkCount,
    passed: report.passed,
    failed: report.failed,
    resultCount: report.resultCount,
    retainedWorkspaceArtifactVerifications: report.retainedArtifactVerifications,
    compactedHashChainSealVerifications: report.compactedArtifactVerifications,
    artifactVerificationCoverage: report.retainedArtifactVerifications + report.compactedArtifactVerifications,
    artifactVerificationCoverageComplete: report.retainedArtifactVerifications + report.compactedArtifactVerifications === report.resultCount,
    checkCountInterpretation: 'checkCount는 campaign·ledger·result·artifact·digest 검사를 합친 전체 assertion 수다. retained workspace 결과만 실물 파일을 직접 재검증하며, compacted 결과는 ledger hash chain에 결합된 compacted seal을 재검증한다.',
    corpusSha256: report.corpusSha256,
    finalLedgerHash: report.finalLedgerHash,
    reportSha256: report.reportSha256
  };
}

function summarizeCaseRecords(records) {
  return {
    executions: records.length,
    passed: records.filter((item) => item.outcome !== 'FAILED').length,
    failed: records.filter((item) => item.outcome === 'FAILED').length,
    outcomes: countBy(records, (item) => item.outcome),
    terminalStates: countBy(records, (item) => item.terminalState),
    semanticDigests: [...new Set(records.map((item) => item.semanticDigest).filter(Boolean))],
    behavioralDigests: [...new Set(records.map((item) => item.behavioralDigest).filter(Boolean))]
  };
}

function groupLedgerByCase(ledger) {
  const grouped = new Map();
  for (const record of ledger) {
    if (!grouped.has(record.caseId)) grouped.set(record.caseId, []);
    grouped.get(record.caseId).push(record);
  }
  return grouped;
}

function groupRecordsByKey(records, selector) {
  const grouped = new Map();
  for (const record of records) {
    const key = selector(record);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return grouped;
}

async function buildEvidenceFiles({ cwd, initial, final, soak, failedSoak, productBaselineEvidence, productRetestEvidence, repositoryVerification, remediationEvidence, initialFindings }) {
  const descriptors = [
    ['최초 campaign', initial.paths.campaign],
    ['최초 corpus', initial.paths.corpus],
    ['최초 summary', initial.paths.summary],
    ['최초 sequence ledger', initial.paths.ledger],
    ['최종 campaign', final.paths.campaign],
    ['최종 corpus', final.paths.corpus],
    ['최종 summary', final.paths.summary],
    ['최종 sequence ledger', final.paths.ledger],
    ['최종 독립 재검증', final.paths.reverification],
    ['반복 campaign', soak.paths.campaign],
    ['반복 corpus', soak.paths.corpus],
    ['반복 summary', soak.paths.summary],
    ['반복 sequence ledger', soak.paths.ledger],
    ['반복 독립 재검증', soak.paths.reverification],
    ...(failedSoak ? [
      ['교정 전 반복 campaign', failedSoak.paths.campaign],
      ['교정 전 반복 corpus', failedSoak.paths.corpus],
      ['교정 전 반복 summary', failedSoak.paths.summary],
      ['교정 전 반복 sequence ledger', failedSoak.paths.ledger],
      ['교정 전 반복 독립 재검증', failedSoak.paths.reverification]
    ] : []),
    ['제품 probe 수정 전', productBaselineEvidence.path],
    ['제품 probe 수정 후', productRetestEvidence.path],
    ...(repositoryVerification ? [
      ['저장소 전체 회귀 검증', repositoryVerification.path],
      ...repositoryVerification.gateEvidence.map((item) => [`저장소 회귀 gate ${item.gateId}`, item.path])
    ] : []),
    ...remediationEvidence.paths.map((path) => ['실패 원인·수정 기록', path]),
    ...initialFindings.filter((item) => item.initialResultEvidence).map((item) => [`최초 실패 결과 ${item.caseId}`, resolve(cwd, item.initialResultEvidence.path)])
  ];
  const unique = [];
  const seen = new Set();
  for (const [role, path] of descriptors) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = await readFileRequired(path);
    unique.push({ role, path: normalizeDisplayPath(relative(cwd, path)), sizeBytes: bytes.length, sha256: sha256(bytes) });
  }
  return unique;
}

function resolutionLabel(item) {
  const finalText = `${item.finalRetest.passed}/${item.finalRetest.executions}`;
  const soakText = `${item.soakRetest.passed}/${item.soakRetest.executions}`;
  const documentation = item.remediation.documentationStatus === 'documented' ? '원인·수정 기록' : '수정 설명 미기록';
  return `${finalText}; 반복 ${soakText}; ${documentation}`;
}

function supplementText(value) {
  if (!value) return '기록 없음';
  return `call ${value.callUnits ?? 0}, event ${value.events ?? 0}, fault ${value.faults ?? 0}`;
}

function reverificationCoverageText(value) {
  return `결과 ${value.resultCount}건 중 retained workspace 직접 재검증 ${value.retainedWorkspaceArtifactVerifications}건, hash-chain-bound compacted seal 재검증 ${value.compactedHashChainSealVerifications}건`;
}

function markdownTable(headers, rows) {
  const escape = (value) => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`)
  ].join('\n');
}

function formatPercent(value, digits = 2) {
  return value === null || value === undefined ? '계산 불가' : `${(value * 100).toFixed(digits)}%`;
}

function caseResultPath(root, cycle, caseId) {
  return join(root, `cycle-${String(cycle).padStart(2, '0')}`, caseId, 'result.json');
}

function validateEmbeddedDigest(value, digestKey, omittedKeys, path) {
  const embedded = value?.[digestKey];
  if (!embedded) throw new Error(`Required embedded digest ${digestKey} is missing: ${path}`);
  if (!/^[a-f0-9]{64}$/u.test(embedded)) throw new Error(`Invalid ${digestKey} format: ${path}`);
  const payload = { ...value, [digestKey]: undefined };
  for (const key of omittedKeys) payload[key] = undefined;
  const actual = sha256Json(payload);
  if (embedded !== actual) throw new Error(`${digestKey} mismatch at ${path}: embedded=${embedded}, actual=${actual}.`);
}

async function resolveRootFile(rootOrFile, defaultName) {
  try {
    const info = await stat(rootOrFile);
    return info.isDirectory() ? join(rootOrFile, defaultName) : rootOrFile;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (extname(rootOrFile).toLowerCase() === '.json') return rootOrFile;
    return join(rootOrFile, defaultName);
  }
}

function parseJsonLines(text, path) {
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL at ${path}, line ${index + 1}: ${error.message}`); }
  });
}

function parseJson(text, path) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON evidence at ${path}: ${error.message}`); }
}

async function readJsonRequired(path) {
  return parseJson(await readTextRequired(path), path);
}

async function readTextRequired(path) {
  return (await readFileRequired(path)).toString('utf8');
}

async function readFileRequired(path) {
  try { return await readFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Required evidence file is missing: ${path}`);
    throw error;
  }
}

async function pathExists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function sum(items, selector) {
  return items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
}

function normalizeDisplayPath(path) {
  return path.replaceAll('\\', '/');
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

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(stableStringify(value), 'utf8'));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const options = parseApexReportArguments(process.argv.slice(2));
  const generated = await generateApexWorkflowReport(options);
  console.log(`APEX_REPORT_DATA ${generated.dataPath}`);
  console.log(`APEX_REPORT_MARKDOWN ${generated.markdownPath}`);
  console.log(`APEX_REPORT_STATUS ${generated.report.verdict.status}`);
}
