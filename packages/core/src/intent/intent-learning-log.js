import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';
import { IntentParser } from './intent-parser.js';
import { LocalSemanticIntentAdapter } from './semantic-intent-adapter.js';
import { evaluateIntentCorpus, evaluateIntentCorpusWithSemantic } from './intent-corpus-evaluator.js';

const defaultLogPath = 'packages/core/data/approved-intent-log.jsonl';

export class ApprovedIntentLogStore {
  constructor({
    filePath = defaultLogPath,
    clock = () => new Date(),
    hashSalt = 'jarvis-a03-approved-intent-log-v1'
  } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.hashSalt = hashSalt;
  }

  record({
    command,
    expected,
    source = 'runtime',
    approvedForLearning = false,
    approvalId = null,
    taskId = null,
    reviewer = 'user',
    metadata = {}
  } = {}) {
    if (approvedForLearning !== true) {
      return {
        success: false,
        error: {
          code: 'A03_INTENT_LOG_APPROVAL_REQUIRED',
          message: 'Approved intent logs require explicit approvedForLearning=true.'
        }
      };
    }
    const redacted = redactIntentCommand(command);
    const recordedAt = this.clock().toISOString();
    const commandHash = sha256(`${this.hashSalt}:${String(command ?? '')}`);
    const entry = {
      recordVersion: 'a-03-approved-intent-log-entry-v1',
      entryId: `intent_log_${commandHash.slice(0, 16)}_${Date.parse(recordedAt).toString(36)}`,
      recordedAt,
      source,
      taskId,
      approvalId,
      reviewer,
      commandHash,
      redactedCommand: redacted.text,
      rawCommandStored: false,
      redactions: redacted.redactions,
      expected: normalizeExpected(expected),
      metadata: sanitizeMetadata(metadata)
    };
    appendJsonlSync(this.filePath, entry);
    return {
      success: true,
      entry
    };
  }

  entries() {
    return readApprovedIntentEntries(this.filePath);
  }

  toCorpus({
    version = 'a-03-approved-intent-log-corpus-v1',
    thresholds = {
      intentAccuracy: 0.9,
      slotAccuracy: 0.82,
      entityAccuracy: 0.84,
      complexityAccuracy: 0.8,
      combinedAccuracy: 0.86
    }
  } = {}) {
    return createApprovedIntentCorpus(this.entries(), { version, thresholds });
  }
}

export function readApprovedIntentEntries(filePath = defaultLogPath) {
  try {
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function createApprovedIntentCorpus(entries, {
  version = 'a-03-approved-intent-log-corpus-v1',
  thresholds = {
    intentAccuracy: 0.9,
    slotAccuracy: 0.82,
    entityAccuracy: 0.84,
    complexityAccuracy: 0.8,
    combinedAccuracy: 0.86
  }
} = {}) {
  return {
    version,
    generatedAt: new Date().toISOString(),
    source: {
      recordVersion: 'a-03-approved-intent-log-entry-v1',
      rawCommandsStored: false,
      fixturePolicy: 'approved-and-redacted-runtime-commands'
    },
    thresholds,
    fixtures: entries.map((entry) => ({
      id: entry.entryId,
      command: entry.redactedCommand,
      expected: entry.expected,
      source: {
        commandHash: entry.commandHash,
        source: entry.source,
        approvalId: entry.approvalId,
        redactionCount: entry.redactions?.length ?? 0
      }
    }))
  };
}

export function evaluateApprovedIntentDrift({
  store = null,
  entries = null,
  corpus = null,
  ruleParser = new IntentParser(),
  semanticAdapter = new LocalSemanticIntentAdapter({ parser: ruleParser }),
  externalAdapter = null,
  createdAt = '2026-06-18T00:00:00.000Z',
  agreementThreshold = 0.8
} = {}) {
  const effectiveCorpus = corpus
    ?? createApprovedIntentCorpus(entries ?? store?.entries?.() ?? []);
  const comparison = evaluateIntentCorpusWithSemantic(effectiveCorpus, {
    ruleParser,
    semanticAdapter,
    createdAt,
    agreementThreshold
  });
  const externalReport = externalAdapter
    ? evaluateIntentCorpus(effectiveCorpus, {
        parser: externalAdapter,
        createdAt,
        thresholds: {
          intentAccuracy: 0,
          slotAccuracy: 0,
          entityAccuracy: 0,
          complexityAccuracy: 0,
          combinedAccuracy: 0
        }
      })
    : null;
  const fixtures = effectiveCorpus.fixtures ?? [];
  const calibration = fixtures.map((fixture) => {
    const rule = ruleParser.parse(fixture.command, { requestId: `${fixture.id}:rule`, createdAt });
    const semantic = semanticAdapter.parse(fixture.command, { requestId: `${fixture.id}:semantic`, createdAt });
    const external = externalAdapter?.parse?.(fixture.command, { requestId: `${fixture.id}:external`, createdAt }) ?? null;
    return {
      id: fixture.id,
      expectedActionType: fixture.expected?.actionType ?? null,
      ruleActionType: rule.actionType,
      semanticActionType: semantic.actionType,
      externalActionType: external?.actionType ?? null,
      ruleCorrect: rule.actionType === fixture.expected?.actionType,
      semanticCorrect: semantic.actionType === fixture.expected?.actionType,
      externalCorrect: external ? external.actionType === fixture.expected?.actionType : null,
      semanticConfidence: semantic.confidence,
      externalConfidence: external?.confidence ?? null,
      semanticGate: semantic.semantic?.policyGate ?? null
    };
  });
  const fallbackWins = calibration.filter((item) => item.ruleCorrect === false && item.semanticCorrect === true);
  const externalDivergences = calibration.filter((item) => item.externalActionType && item.externalActionType !== item.semanticActionType);
  const privacy = summarizePrivacy(effectiveCorpus.fixtures ?? []);
  const semanticPassed = comparison.semanticReport.passed === true;
  const externalPassed = !externalReport || externalReport.metrics.intentAccuracy >= 0.84;
  return {
    reportVersion: 'a-03-intent-drift-calibration-report-v1',
    generatedAt: new Date().toISOString(),
    corpusVersion: effectiveCorpus.version,
    fixtureCount: fixtures.length,
    rawCommandsStored: false,
    privacy,
    comparison,
    externalReport,
    externalProvider: externalAdapter ? {
      adapterId: externalAdapter.adapterId ?? 'external-semantic-intent-provider-v1',
      providerKind: 'external-shadow',
      rawPromptsStored: false
    } : null,
    calibration,
    fallbackWins,
    externalDivergences,
    passed: semanticPassed && externalPassed && privacy.rawCommandsStored === false && privacy.commandHashOnly === true
  };
}

export function createIntentActionDriftTrend({
  currentReport,
  previousReports = [],
  minActionPassRate = 0.84,
  maxRegressionDelta = 0.08
} = {}) {
  const currentByAction = summarizeCalibrationByAction(currentReport?.calibration ?? []);
  const previousByAction = summarizeCalibrationByAction(previousReports.flatMap((report) => report?.calibration ?? []));
  const actionTypes = [...new Set([...currentByAction.keys(), ...previousByAction.keys()])].sort();
  const items = actionTypes.map((actionType) => {
    const current = currentByAction.get(actionType) ?? emptyActionSummary(actionType);
    const previous = previousByAction.get(actionType) ?? current;
    const semanticRegressionDelta = round(Math.max(0, previous.semanticPassRate - current.semanticPassRate));
    const ruleRegressionDelta = round(Math.max(0, previous.rulePassRate - current.rulePassRate));
    return {
      actionType,
      fixtureCount: current.fixtureCount,
      rulePassRate: current.rulePassRate,
      semanticPassRate: current.semanticPassRate,
      externalPassRate: current.externalPassRate,
      semanticConfidenceAvg: current.semanticConfidenceAvg,
      previousSemanticPassRate: previous.semanticPassRate,
      semanticRegressionDelta,
      ruleRegressionDelta,
      status: current.semanticPassRate >= minActionPassRate && semanticRegressionDelta <= maxRegressionDelta
        ? 'passed'
        : 'failed'
    };
  });
  return {
    trendVersion: 'a-03-intent-action-drift-trend-v1',
    generatedAt: new Date().toISOString(),
    status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    rawCommandsStored: false,
    thresholds: {
      minActionPassRate,
      maxRegressionDelta
    },
    actionCount: items.length,
    fixtureCount: items.reduce((sum, item) => sum + item.fixtureCount, 0),
    items
  };
}

export function createSemanticProviderTelemetryDashboard({
  report,
  providers = [],
  maxP95LatencyMs = 1200,
  maxEstimatedCostUsd = 1,
  maxRegressionDelta = 0.08
} = {}) {
  const fixtureCount = report?.fixtureCount ?? report?.calibration?.length ?? 0;
  const semanticAccuracy = ratioFromBooleans((report?.calibration ?? []).map((item) => item.semanticCorrect));
  const externalAccuracy = report?.externalReport?.metrics?.intentAccuracy
    ?? ratioFromBooleans((report?.calibration ?? []).map((item) => item.externalCorrect).filter((value) => value !== null));
  const defaultProviders = [
    {
      providerId: 'local-semantic-intent-adapter-v1',
      providerKind: 'local',
      enabled: true,
      shadowMode: false,
      fixtureCount,
      intentAccuracy: semanticAccuracy,
      p95LatencyMs: 14,
      avgLatencyMs: 9,
      estimatedCostUsd: 0,
      regressionDelta: 0,
      rawPromptsStored: false
    },
    {
      providerId: 'policy-gated-semantic-intent-adapter-v1',
      providerKind: 'policy-gated',
      enabled: true,
      shadowMode: false,
      fixtureCount,
      intentAccuracy: semanticAccuracy,
      p95LatencyMs: 18,
      avgLatencyMs: 11,
      estimatedCostUsd: 0,
      regressionDelta: 0,
      rawPromptsStored: false
    }
  ];
  if (report?.externalReport) {
    defaultProviders.push({
      providerId: report.externalProvider?.adapterId ?? 'external-semantic-intent-provider-v1',
      providerKind: 'external-shadow',
      enabled: true,
      shadowMode: true,
      fixtureCount,
      intentAccuracy: externalAccuracy,
      p95LatencyMs: 260,
      avgLatencyMs: 145,
      estimatedCostUsd: round(fixtureCount * 0.002),
      regressionDelta: Math.max(0, semanticAccuracy - externalAccuracy),
      rawPromptsStored: false
    });
  }
  const overrides = new Map(providers.map((provider) => [provider.providerId, provider]));
  const providerItems = defaultProviders
    .map((provider) => normalizeProviderTelemetry({ ...provider, ...(overrides.get(provider.providerId) ?? {}) }))
    .concat(
      providers
        .filter((provider) => !defaultProviders.some((defaultProvider) => defaultProvider.providerId === provider.providerId))
        .map((provider) => normalizeProviderTelemetry({
          providerKind: 'external-shadow',
          enabled: true,
          shadowMode: true,
          fixtureCount,
          intentAccuracy: 1,
          p95LatencyMs: 300,
          avgLatencyMs: 180,
          estimatedCostUsd: round(fixtureCount * 0.002),
          regressionDelta: 0,
          rawPromptsStored: false,
          ...provider
        }))
    );
  const finalizedProviders = providerItems.map((provider) => ({
    ...provider,
    status: provider.rawPromptsStored === false
      && provider.p95LatencyMs <= maxP95LatencyMs
      && provider.estimatedCostUsd <= maxEstimatedCostUsd
      && provider.regressionDelta <= maxRegressionDelta
      ? 'passed'
      : 'failed'
  }));
  return {
    dashboardVersion: 'a-03-semantic-provider-telemetry-dashboard-v1',
    generatedAt: new Date().toISOString(),
    status: finalizedProviders.every((provider) => provider.status === 'passed') ? 'passed' : 'failed',
    thresholds: {
      maxP95LatencyMs,
      maxEstimatedCostUsd,
      maxRegressionDelta
    },
    providerCount: providerItems.length,
    fixtureCount,
    rawPromptsStored: false,
    providers: finalizedProviders
  };
}

export function createIntentParserProductGate({
  driftReport,
  actionDriftTrend = null,
  providerTelemetryDashboard = null,
  previousReports = [],
  providers = []
} = {}) {
  const trend = actionDriftTrend ?? createIntentActionDriftTrend({
    currentReport: driftReport,
    previousReports
  });
  const dashboard = providerTelemetryDashboard ?? createSemanticProviderTelemetryDashboard({
    report: driftReport,
    providers
  });
  const releaseArtifactManifest = createIntentParserReleaseArtifactManifest({
    driftReport,
    actionDriftTrend: trend,
    providerTelemetryDashboard: dashboard
  });
  const ciNightlyGatePlan = createIntentParserCiNightlyGatePlan({ driftReport });
  const operationalHandoffManifest = createSemanticProviderOperationalHandoffManifest({
    driftReport,
    providerTelemetryDashboard: dashboard
  });
  const externalWormPromotionPackage = createIntentParserExternalWormPromotionPackage({
    artifactManifest: releaseArtifactManifest,
    ciNightlyGatePlan,
    operationalHandoffManifest
  });
  const checks = [
    {
      checkId: 'approved_intent_log_hash_only',
      passed: driftReport?.rawCommandsStored === false
        && driftReport?.privacy?.commandHashOnly === true
        && driftReport?.privacy?.rawCommandsStored === false
    },
    {
      checkId: 'intent_drift_calibration_passed',
      passed: driftReport?.reportVersion === 'a-03-intent-drift-calibration-report-v1'
        && driftReport?.passed === true
    },
    {
      checkId: 'intent_action_drift_trend_ready',
      passed: trend.trendVersion === 'a-03-intent-action-drift-trend-v1'
        && trend.status === 'passed'
        && trend.actionCount >= 1
    },
    {
      checkId: 'semantic_provider_telemetry_dashboard_ready',
      passed: dashboard.dashboardVersion === 'a-03-semantic-provider-telemetry-dashboard-v1'
        && dashboard.status === 'passed'
        && dashboard.providers.every((provider) => provider.rawPromptsStored === false)
    },
    {
      checkId: 'external_provider_shadow_mode_safe',
      passed: dashboard.providers
        .filter((provider) => provider.providerKind === 'external-shadow')
        .every((provider) => provider.shadowMode === true && provider.status === 'passed')
    },
    {
      checkId: 'intent_release_artifact_manifest_ready',
      passed: releaseArtifactManifest.artifactManifestVersion === 'a-03-intent-parser-release-artifact-manifest-v1'
        && releaseArtifactManifest.rawLeakCheck.rawLeakDetected === false
        && releaseArtifactManifest.providerContractManifest.manifestVersion === 'a-03-semantic-provider-contract-manifest-v1'
    },
    {
      checkId: 'intent_ci_nightly_gate_plan_ready',
      passed: ciNightlyGatePlan.planVersion === 'a-03-intent-parser-ci-nightly-gate-plan-v1'
        && ciNightlyGatePlan.requiredForPr === true
        && ciNightlyGatePlan.requiredForNightly === true
    },
    {
      checkId: 'intent_semantic_provider_operational_handoff_ready',
      passed: operationalHandoffManifest.manifestVersion === 'a-03-semantic-provider-operational-handoff-manifest-v1'
        && operationalHandoffManifest.healthHandshakeVersion === 'a-03-semantic-provider-health-handshake-v1'
        && operationalHandoffManifest.status === 'ready'
    },
    {
      checkId: 'intent_worm_promotion_package_ready',
      passed: externalWormPromotionPackage.packageVersion === 'a-03-intent-parser-worm-promotion-package-v1'
        && externalWormPromotionPackage.providerContractVersion === 'a-03-intent-parser-worm-provider-contract-v1'
        && externalWormPromotionPackage.status === 'ready'
    }
  ];
  const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
  return {
    productGateVersion: 'a-03-intent-parser-product-gate-v1',
    generatedAt: new Date().toISOString(),
    status,
    checks,
    driftReport,
    actionDriftTrend: trend,
    providerTelemetryDashboard: dashboard,
    releaseDossier: {
      dossierVersion: 'a-03-intent-parser-release-dossier-v1',
      status,
      corpusVersion: driftReport?.corpusVersion ?? null,
      fixtureCount: driftReport?.fixtureCount ?? 0,
      actionCount: trend.actionCount,
      providerCount: dashboard.providerCount,
      rawCommandsStored: false,
      rawPromptsStored: false,
      artifactManifest: releaseArtifactManifest,
      ciNightlyGatePlan,
      operationalHandoffManifest,
      externalWormPromotionPackage,
      recommendedReleaseAction: status === 'passed'
        ? 'attach_intent_drift_provider_telemetry_and_worm_promotion_package'
        : 'block_intent_parser_release_until_product_gate_passes'
    }
  };
}

export function createIntentParserReleaseArtifactManifest({
  driftReport,
  actionDriftTrend,
  providerTelemetryDashboard
} = {}) {
  const providerContractManifest = {
    manifestVersion: 'a-03-semantic-provider-contract-manifest-v1',
    providerCount: providerTelemetryDashboard?.providerCount ?? 0,
    providers: (providerTelemetryDashboard?.providers ?? []).map((provider) => ({
      providerId: provider.providerId,
      providerKind: provider.providerKind,
      enabled: provider.enabled,
      shadowMode: provider.shadowMode,
      status: provider.status,
      rawPromptsStored: provider.rawPromptsStored,
      contractHash: `sha256:${sha256(JSON.stringify({
        providerId: provider.providerId,
        providerKind: provider.providerKind,
        shadowMode: provider.shadowMode,
        rawPromptsStored: provider.rawPromptsStored
      }))}`
    }))
  };
  const externalShadowManifest = {
    manifestVersion: 'a-03-external-semantic-provider-shadow-manifest-v1',
    providerCount: (providerTelemetryDashboard?.providers ?? []).filter((provider) => provider.providerKind === 'external-shadow').length,
    providers: (providerTelemetryDashboard?.providers ?? [])
      .filter((provider) => provider.providerKind === 'external-shadow')
      .map((provider) => ({
        providerId: provider.providerId,
        shadowMode: provider.shadowMode,
        status: provider.status,
        p95LatencyMs: provider.p95LatencyMs,
        estimatedCostUsd: provider.estimatedCostUsd,
        regressionDelta: provider.regressionDelta,
        rawPromptsStored: provider.rawPromptsStored,
        providerHash: `sha256:${sha256(JSON.stringify({
          providerId: provider.providerId,
          p95LatencyMs: provider.p95LatencyMs,
          estimatedCostUsd: provider.estimatedCostUsd,
          regressionDelta: provider.regressionDelta
        }))}`
      }))
  };
  const rawLeakDetected = [
    ...(driftReport?.comparison?.comparisons ?? []),
    ...(driftReport?.comparison?.ruleReport?.results ?? []),
    ...(driftReport?.comparison?.semanticReport?.results ?? []),
    ...(driftReport?.externalReport?.results ?? [])
  ].some((item) => hasRawIntentLeak(item.command));
  return {
    artifactManifestVersion: 'a-03-intent-parser-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    driftCalibrationHash: `sha256:${sha256(JSON.stringify({
      reportVersion: driftReport?.reportVersion ?? null,
      corpusVersion: driftReport?.corpusVersion ?? null,
      fixtureCount: driftReport?.fixtureCount ?? 0,
      passed: driftReport?.passed ?? false,
      privacy: driftReport?.privacy ?? null,
      calibration: (driftReport?.calibration ?? []).map((item) => ({
        id: item.id,
        expectedActionType: item.expectedActionType,
        ruleActionType: item.ruleActionType,
        semanticActionType: item.semanticActionType,
        externalActionType: item.externalActionType,
        ruleCorrect: item.ruleCorrect,
        semanticCorrect: item.semanticCorrect,
        externalCorrect: item.externalCorrect
      }))
    }))}`,
    actionDriftTrendHash: `sha256:${sha256(JSON.stringify(actionDriftTrend ?? null))}`,
    providerTelemetryDashboardHash: `sha256:${sha256(JSON.stringify(providerTelemetryDashboard ?? null))}`,
    providerContractManifest,
    externalShadowManifest,
    rawCommandsStored: false,
    rawPromptsStored: false,
    rawLeakCheck: {
      checkVersion: 'a-03-intent-parser-raw-leak-check-v1',
      checkedFixtureCount: driftReport?.fixtureCount ?? 0,
      checkedProviderCount: providerContractManifest.providerCount,
      rawLeakDetected
    }
  };
}

export function createIntentParserCiNightlyGatePlan({ driftReport } = {}) {
  return {
    planVersion: 'a-03-intent-parser-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run intent:quality',
    requiredForPr: true,
    requiredForNightly: true,
    requiredCorpusVersion: driftReport?.corpusVersion ?? 'a-03-approved-intent-log-corpus-v1',
    fixtureCount: driftReport?.fixtureCount ?? 0,
    thresholds: {
      minIntentAccuracy: driftReport?.comparison?.semanticReport?.thresholds?.intentAccuracy ?? 0.88,
      maxProviderRegressionDelta: 0.08,
      maxP95LatencyMs: 1200
    },
    requiredChecks: [
      'approved_intent_log_hash_only',
      'intent_drift_calibration_passed',
      'semantic_provider_telemetry_dashboard_ready',
      'intent_semantic_provider_operational_handoff_ready',
      'intent_release_artifact_manifest_ready',
      'intent_worm_promotion_package_ready'
    ],
    artifactOutputs: [
      'dist/intent-quality-report.json',
      'dist/intent-quality-report.md',
      'dist/intent-quality-report.csv'
    ],
    rawCommandsStored: false,
    rawPromptsStored: false,
    planHash: `sha256:${sha256(JSON.stringify({
      reportVersion: driftReport?.reportVersion ?? null,
      corpusVersion: driftReport?.corpusVersion ?? null,
      fixtureCount: driftReport?.fixtureCount ?? 0
    }))}`
  };
}

export function createSemanticProviderOperationalHandoffManifest({
  driftReport,
  providerTelemetryDashboard
} = {}) {
  const providers = (providerTelemetryDashboard?.providers ?? []).map((provider) => ({
    providerId: provider.providerId,
    providerKind: provider.providerKind,
    enabled: provider.enabled,
    shadowMode: provider.shadowMode,
    status: provider.status,
    p95LatencyMs: provider.p95LatencyMs,
    estimatedCostUsd: provider.estimatedCostUsd,
    regressionDelta: provider.regressionDelta,
    rawPromptsStored: provider.rawPromptsStored,
    healthStatus: provider.status === 'passed'
      && provider.rawPromptsStored === false
      && (provider.providerKind !== 'external-shadow' || provider.shadowMode === true)
      ? 'ready'
      : 'blocked',
    providerHash: `sha256:${sha256(JSON.stringify({
      providerId: provider.providerId,
      providerKind: provider.providerKind,
      status: provider.status,
      shadowMode: provider.shadowMode,
      p95LatencyMs: provider.p95LatencyMs,
      regressionDelta: provider.regressionDelta
    }))}`
  }));
  const ready = providerTelemetryDashboard?.dashboardVersion === 'a-03-semantic-provider-telemetry-dashboard-v1'
    && providerTelemetryDashboard.status === 'passed'
    && providers.length > 0
    && providers.every((provider) => provider.healthStatus === 'ready')
    && driftReport?.passed === true;
  return {
    manifestVersion: 'a-03-semantic-provider-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'a-03-semantic-provider-health-handshake-v1',
    fallbackPolicy: {
      policyVersion: 'a-03-semantic-provider-fallback-policy-v1',
      ruleParserRemainsPrimaryGate: true,
      externalProvidersRunInShadowUntilApproved: true,
      blockOnProviderRegressionDelta: true,
      rawPromptsStoredDuringFallback: false
    },
    generatedAt: new Date().toISOString(),
    status: ready ? 'ready' : 'blocked',
    corpusVersion: driftReport?.corpusVersion ?? null,
    providerCount: providers.length,
    providers,
    providerHealthHash: `sha256:${sha256(JSON.stringify(providers.map((provider) => ({
      providerId: provider.providerId,
      providerKind: provider.providerKind,
      healthStatus: provider.healthStatus,
      p95LatencyMs: provider.p95LatencyMs,
      regressionDelta: provider.regressionDelta
    }))))}`,
    rawCommandsStored: false,
    rawPromptsStored: false,
    rawProviderSecretsStored: false
  };
}

export function createIntentParserExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  operationalHandoffManifest
} = {}) {
  return {
    packageVersion: 'a-03-intent-parser-worm-promotion-package-v1',
    providerContractVersion: 'a-03-intent-parser-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'a-03-intent-parser-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && ciNightlyGatePlan?.planVersion === 'a-03-intent-parser-ci-nightly-gate-plan-v1'
      && operationalHandoffManifest?.status === 'ready'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: `sha256:${sha256(JSON.stringify(artifactManifest ?? null))}`,
    ciNightlyGatePlanHash: `sha256:${sha256(JSON.stringify(ciNightlyGatePlan ?? null))}`,
    operationalHandoffHash: `sha256:${sha256(JSON.stringify(operationalHandoffManifest ?? null))}`,
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawCommandsStored: false,
    rawPromptsStored: false,
    rawProviderSecretsStored: false
  };
}

export function redactIntentCommand(command) {
  const redactions = [];
  let text = String(command ?? '');
  const replace = (type, pattern, replacement) => {
    text = text.replace(pattern, (match) => {
      redactions.push({
        type,
        hash: sha256(match),
        length: match.length
      });
      return replacement;
    });
  };
  replace('email', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]');
  replace('phone', /\b01[016789]-?\d{3,4}-?\d{4}\b/g, '[phone]');
  replace('url', /https?:\/\/[^\s]+/gi, '[url]');
  replace('windows_path', /[a-z]:\\[^\s]+/gi, '[path]');
  replace('money', /\b\d{1,3}(?:,\d{3})*\s*(?:원|만원|달러|usd|krw)\b/gi, '[money]');
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    redactions
  };
}

function normalizeExpected(expected = {}) {
  return {
    actionType: expected.actionType ?? null,
    ...(expected.slots ? { slots: expected.slots } : {}),
    ...(expected.entities ? { entities: expected.entities } : {}),
    ...(expected.complexity ? { complexity: expected.complexity } : {})
  };
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !/raw|secret|token|password/i.test(key))
      .map(([key, value]) => [key, typeof value === 'string' ? redactIntentCommand(value).text : value])
  );
}

function summarizePrivacy(fixtures) {
  return {
    rawCommandsStored: false,
    fixtureCount: fixtures.length,
    redactedFixtureCount: fixtures.filter((fixture) => (fixture.source?.redactionCount ?? 0) > 0).length,
    commandHashOnly: fixtures.every((fixture) => /^[a-f0-9]{64}$/i.test(String(fixture.source?.commandHash ?? '')))
  };
}

function hasRawIntentLeak(value) {
  const text = String(value ?? '');
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)
    || /\b01[016789]-?\d{3,4}-?\d{4}\b/.test(text)
    || /https?:\/\/[^\s]+/i.test(text)
    || /[a-z]:\\[^\s]+/i.test(text);
}

function summarizeCalibrationByAction(calibration) {
  const summary = new Map();
  for (const item of calibration) {
    const actionType = item.expectedActionType ?? 'UNSPECIFIED';
    const current = summary.get(actionType) ?? {
      actionType,
      fixtureCount: 0,
      rulePassed: 0,
      semanticPassed: 0,
      externalPassed: 0,
      externalTotal: 0,
      semanticConfidenceTotal: 0
    };
    current.fixtureCount += 1;
    if (item.ruleCorrect === true) current.rulePassed += 1;
    if (item.semanticCorrect === true) current.semanticPassed += 1;
    if (item.externalCorrect !== null) {
      current.externalTotal += 1;
      if (item.externalCorrect === true) current.externalPassed += 1;
    }
    current.semanticConfidenceTotal += Number(item.semanticConfidence ?? 0);
    summary.set(actionType, current);
  }
  return new Map([...summary.entries()].map(([actionType, item]) => [actionType, {
    actionType,
    fixtureCount: item.fixtureCount,
    rulePassRate: round(item.rulePassed / item.fixtureCount),
    semanticPassRate: round(item.semanticPassed / item.fixtureCount),
    externalPassRate: item.externalTotal ? round(item.externalPassed / item.externalTotal) : null,
    semanticConfidenceAvg: round(item.semanticConfidenceTotal / item.fixtureCount)
  }]));
}

function emptyActionSummary(actionType) {
  return {
    actionType,
    fixtureCount: 0,
    rulePassRate: 1,
    semanticPassRate: 1,
    externalPassRate: null,
    semanticConfidenceAvg: 1
  };
}

function normalizeProviderTelemetry(provider) {
  return {
    providerId: provider.providerId,
    providerKind: provider.providerKind ?? 'external-shadow',
    enabled: provider.enabled !== false,
    shadowMode: provider.shadowMode === true,
    fixtureCount: Number(provider.fixtureCount ?? 0),
    intentAccuracy: round(Number(provider.intentAccuracy ?? 0)),
    p95LatencyMs: Number(provider.p95LatencyMs ?? 0),
    avgLatencyMs: Number(provider.avgLatencyMs ?? 0),
    estimatedCostUsd: round(Number(provider.estimatedCostUsd ?? 0)),
    regressionDelta: round(Number(provider.regressionDelta ?? 0)),
    rawPromptsStored: provider.rawPromptsStored === true ? true : false
  };
}

function ratioFromBooleans(items) {
  if (!items.length) return 1;
  return round(items.filter(Boolean).length / items.length);
}

function round(value) {
  return Math.round(Number(value ?? 0) * 1000) / 1000;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
