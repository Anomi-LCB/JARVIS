import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBrowserReadOnlySoak } from '../apps/pc-agent/src/pc-agent-runtime.js';

export async function runBrowserReplaySoakReport({
  fixturePath = 'apps/pc-agent/fixtures/browser-network-replay-corpus.json',
  cycles = 3,
  jsonPath = 'dist/browser-replay-soak-report.json',
  markdownPath = 'dist/browser-replay-soak-report.md',
  csvPath = 'dist/browser-replay-soak-report.csv',
  clock = () => new Date()
} = {}) {
  const soak = await runBrowserReadOnlySoak({ fixturePath, cycles, clock });
  const artifactManifest = createBrowserReplayReleaseArtifactManifest({
    soak,
    fixturePath,
    jsonPath,
    markdownPath,
    csvPath
  });
  const operationalHandoffManifest = createBrowserReplayOperationalHandoffManifest({
    soak,
    artifactManifest
  });
  const ciNightlyGatePlan = createBrowserReplayCiNightlyGatePlan({
    artifactManifest,
    operationalHandoffManifest
  });
  const externalWormPromotionPackage = createBrowserReplayWormPromotionPackage({
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan
  });
  const report = {
    reportVersion: 'b-browser-replay-soak-report-v1',
    dossierVersion: 'b-browser-replay-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: soak.status === 'passed' && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
    fixturePathHash: sha256Json(resolve(fixturePath)),
    cycles,
    soak,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    artifacts: { jsonPath, markdownPath, csvPath },
    nextActions: soak.status === 'passed'
      ? ['Append real Playwright captures that fail in the field to the recorded replay corpus.']
      : ['Inspect failed browser replay items, update the read-only guard or fixture expectations, then rerun npm run browser:replay-soak.']
  };
  report.dossierSha256 = sha256Json(report);
  report.productGate = createBrowserReplayProductGate(report);
  await writeBrowserReplaySoakArtifacts(report, { jsonPath, markdownPath, csvPath });
  return report;
}

export function createBrowserReplayProductGate(report) {
  const soak = report.soak ?? {};
  const corpus = soak.report ?? {};
  const items = corpus.items ?? [];
  const renderingDiffs = corpus.renderingDiffs ?? [];
  const cacheRecoveryGuide = corpus.cacheRecoveryGuide ?? {};
  const blockedPostItem = items.find((item) => item.fixtureId === 'browser.blocked_post_attempt');
  const checks = [
    {
      checkId: 'browser_replay_soak_report_passed',
      passed: report.reportVersion === 'b-browser-replay-soak-report-v1'
        && report.status === 'passed'
        && soak.soakVersion === 'b-browser-readonly-soak-v1'
        && soak.passRate === 1
        && soak.fixtureCount >= 1
    },
    {
      checkId: 'browser_replay_get_only_guard_passed',
      passed: corpus.reportVersion === 'b-browser-network-replay-corpus-report-v1'
        && items.length > 0
        && items.every((item) => item.allRequestsGetOnly === true)
        && corpus.coverage?.blockedMutationAttemptFixtures >= 1
        && blockedPostItem?.blockedNonGetRequests >= 1,
      blockedMutationAttemptFixtures: corpus.coverage?.blockedMutationAttemptFixtures ?? 0,
      blockedPostFixtureObserved: Boolean(blockedPostItem)
    },
    {
      checkId: 'browser_replay_rendering_diff_stable',
      passed: soak.stableRendering === true
        && renderingDiffs.length === items.length
        && renderingDiffs.every((item) => item.status === 'passed')
        && items.every((item) => item.renderingSnapshot?.screenshot?.sha256?.length === 64),
      unstableFixtures: soak.unstableFixtures ?? []
    },
    {
      checkId: 'browser_replay_sensitive_retention_safe',
      passed: items.length > 0
        && items.every((item) => item.rawSensitiveLeak === false)
        && items.every((item) => item.domSnapshot?.captureMode === 'sanitized-text-only')
        && items.every((item) => item.renderingSnapshot?.excludedRawArtifacts?.includes('screenshotPixels')),
      rawSensitiveLeakCount: items.filter((item) => item.rawSensitiveLeak === true).length
    },
    {
      checkId: 'browser_cache_recovery_guide_ready',
      passed: cacheRecoveryGuide.guideVersion === 'b-playwright-cache-recovery-guide-v1'
        && cacheRecoveryGuide.recoveryPolicy?.destructiveCleanupAutomated === false
        && cacheRecoveryGuide.recoveryPolicy?.preferSystemChromeFallback === true
        && cacheRecoveryGuide.verificationCommands?.includes('npm run browser:replay-soak'),
      guideVersion: cacheRecoveryGuide.guideVersion ?? null
    },
    {
      checkId: 'browser_replay_release_dossier_ready',
      passed: report.dossierVersion === 'b-browser-replay-release-dossier-v1'
        && report.status === 'passed'
        && typeof report.dossierSha256 === 'string'
        && report.dossierSha256.length === 64
    },
    {
      checkId: 'browser_replay_release_artifact_manifest_ready',
      passed: report.artifactManifest?.artifactManifestVersion === 'b-browser-replay-release-artifact-manifest-v1'
        && report.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        && report.artifactManifest.rawFixturePathStored === false
        && report.artifactManifest.rawDomTextStored === false
    },
    {
      checkId: 'browser_replay_operational_handoff_ready',
      passed: report.operationalHandoffManifest?.manifestVersion === 'b-browser-replay-operational-handoff-manifest-v1'
        && report.operationalHandoffManifest?.healthHandshakeVersion === 'b-browser-replay-health-handshake-v1'
        && report.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-browser-replay-fallback-policy-v1'
        && report.operationalHandoffManifest?.status === 'ready'
    },
    {
      checkId: 'browser_replay_worm_promotion_package_ready',
      passed: report.externalWormPromotionPackage?.packageVersion === 'b-browser-replay-worm-promotion-package-v1'
        && report.externalWormPromotionPackage?.providerContractVersion === 'b-browser-replay-worm-provider-contract-v1'
        && report.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-browser-replay-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: report.dossierVersion,
      reportVersion: report.reportVersion,
      status: report.status,
      dossierSha256: report.dossierSha256
    }
  };
}

export async function writeBrowserReplaySoakArtifacts(report, { jsonPath, markdownPath, csvPath }) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderBrowserReplaySoakMarkdown(report), 'utf8');
  await writeFile(csvPath, renderBrowserReplaySoakCsv(report), 'utf8');
  return report.artifacts;
}

export function renderBrowserReplaySoakMarkdown(report) {
  const { soak } = report;
  const lines = [
    '# JARVIS Browser Replay Soak',
    '',
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Corpus: ${soak.report.fixturePackVersion}`,
    `Fixtures: ${soak.fixtureCount}`,
    `Cycles: ${soak.cycles}`,
    `Pass rate: ${soak.passRate}`,
    `Stable rendering: ${soak.stableRendering}`,
    `Cache guide: ${soak.report.cacheRecoveryGuide.guideVersion}`,
    `Operational handoff: ${report.operationalHandoffManifest.manifestVersion} / ${report.operationalHandoffManifest.status}`,
    `WORM promotion package: ${report.externalWormPromotionPackage.packageVersion} / ${report.externalWormPromotionPackage.status}`,
    `Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`,
    `Release dossier: ${report.dossierVersion}`,
    '',
    '## Failed Items'
  ];
  const failed = soak.report.items.filter((item) => item.status !== 'passed');
  if (!failed.length) lines.push('- none');
  for (const item of failed) {
    lines.push(`- ${item.fixtureId} cycle ${item.cycleIndex}: ${item.renderingDiff.failures.join(', ') || 'replay failed'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderBrowserReplaySoakCsv(report) {
  const rows = [['fixture_id', 'cycle', 'status', 'all_requests_get_only', 'blocked_non_get_requests', 'raw_sensitive_leak', 'rendering_status']];
  for (const item of report.soak.report.items) {
    rows.push([
      item.fixtureId,
      item.cycleIndex,
      item.status,
      item.allRequestsGetOnly,
      item.blockedNonGetRequests,
      item.rawSensitiveLeak,
      item.renderingDiff.status
    ]);
  }
  for (const check of report.productGate.checks) {
    rows.push([
      check.checkId,
      '',
      check.passed ? 'passed' : 'blocked',
      '',
      '',
      '',
      report.productGate.productGateVersion
    ]);
  }
  return `${rows.map((row) => row.map(csv).join(',')).join('\n')}\n`;
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createBrowserReplayReleaseArtifactManifest({
  soak,
  fixturePath,
  jsonPath,
  markdownPath,
  csvPath
}) {
  const corpus = soak?.report ?? {};
  const manifest = {
    artifactManifestVersion: 'b-browser-replay-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    soakHash: sha256Json({
      soakVersion: soak?.soakVersion ?? null,
      status: soak?.status ?? null,
      passRate: soak?.passRate ?? null,
      fixtureCount: soak?.fixtureCount ?? 0,
      stableRendering: soak?.stableRendering === true
    }),
    corpusHash: sha256Json({
      reportVersion: corpus.reportVersion ?? null,
      fixturePackVersion: corpus.fixturePackVersion ?? null,
      status: corpus.status ?? null,
      itemCount: corpus.items?.length ?? 0,
      blockedMutationAttemptFixtures: corpus.coverage?.blockedMutationAttemptFixtures ?? 0
    }),
    artifactPathHashes: {
      fixturePathHash: sha256Json(resolve(fixturePath)),
      jsonPathHash: sha256Json(resolve(jsonPath)),
      markdownPathHash: sha256Json(resolve(markdownPath)),
      csvPathHash: sha256Json(resolve(csvPath))
    },
    replayItemHashes: (corpus.items ?? []).slice(0, 100).map((item) => ({
      fixtureId: item.fixtureId,
      status: item.status,
      replayHash: sha256Json({
        fixtureId: item.fixtureId,
        allRequestsGetOnly: item.allRequestsGetOnly === true,
        blockedNonGetRequests: item.blockedNonGetRequests ?? 0,
        rawSensitiveLeak: item.rawSensitiveLeak === true,
        renderingStatus: item.renderingDiff?.status ?? null,
        screenshotSha256: item.renderingSnapshot?.screenshot?.sha256 ?? null
      })
    })),
    rawFixturePathStored: false,
    rawDomTextStored: false,
    rawScreenshotPixelsStored: false,
    rawNetworkPayloadStored: false,
    rawSensitivePayloadStored: false
  };
  manifest.rawLeakCheck = {
    checkVersion: 'b-browser-replay-release-raw-leak-check-v1',
    rawLeakDetected: containsBrowserReplayRawLeak(manifest),
    checkedRawFields: [
      'rawFixturePathStored',
      'rawDomTextStored',
      'rawScreenshotPixelsStored',
      'rawNetworkPayloadStored',
      'rawSensitivePayloadStored'
    ]
  };
  return manifest;
}

function createBrowserReplayOperationalHandoffManifest({ soak, artifactManifest }) {
  const corpus = soak?.report ?? {};
  return {
    manifestVersion: 'b-browser-replay-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'b-browser-replay-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: soak?.status === 'passed' && artifactManifest?.rawLeakCheck?.rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      soakVersion: soak?.soakVersion ?? null,
      passRate: soak?.passRate ?? null,
      fixtureCount: soak?.fixtureCount ?? 0,
      stableRendering: soak?.stableRendering === true,
      allRequestsGetOnly: (corpus.items ?? []).every((item) => item.allRequestsGetOnly === true),
      blockedMutationAttemptFixtures: corpus.coverage?.blockedMutationAttemptFixtures ?? 0,
      cacheRecoveryGuide: corpus.cacheRecoveryGuide?.guideVersion ?? null
    },
    fallbackPolicy: {
      policyVersion: 'b-browser-replay-fallback-policy-v1',
      primaryFlow: 'playwright_readonly_get_only_capture',
      fallbackFlows: [
        'python_playwright_system_chrome_fallback',
        'recorded_network_replay_corpus',
        'cache_recovery_guide_manual_operator_action'
      ],
      operatorEscalation: 'browser_replay_soak_report'
    },
    artifactManifestHash: sha256Json(artifactManifest),
    rawFixturePathStored: false,
    rawDomTextStored: false,
    rawScreenshotPixelsStored: false
  };
}

function createBrowserReplayCiNightlyGatePlan({ artifactManifest, operationalHandoffManifest }) {
  return {
    planVersion: 'b-browser-replay-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run browser:replay-soak',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'browser_replay_soak_report_passed',
      'browser_replay_get_only_guard_passed',
      'browser_replay_rendering_diff_stable',
      'browser_replay_sensitive_retention_safe',
      'browser_replay_release_artifact_manifest_ready',
      'browser_replay_operational_handoff_ready',
      'browser_replay_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    rawFixturePathStored: false
  };
}

function createBrowserReplayWormPromotionPackage({
  artifactManifest,
  operationalHandoffManifest,
  ciNightlyGatePlan
}) {
  return {
    packageVersion: 'b-browser-replay-worm-promotion-package-v1',
    providerContractVersion: 'b-browser-replay-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'b-browser-replay-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && operationalHandoffManifest?.status === 'ready'
      && ciNightlyGatePlan?.planVersion === 'b-browser-replay-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawDomTextStored: false,
    rawScreenshotPixelsStored: false,
    rawNetworkPayloadStored: false
  };
}

function containsBrowserReplayRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"fixturePath"\s*:|"textPreview"\s*:|"screenshotPixels"\s*:|"body"\s*:|"cookie"\s*:|token=|secret|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') args.fixturePath = argv[++index];
    else if (arg === '--cycles') args.cycles = Number(argv[++index]);
    else if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
  }
  return {
    fixturePath: args.fixturePath ?? 'apps/pc-agent/fixtures/browser-network-replay-corpus.json',
    cycles: Number.isFinite(args.cycles) ? args.cycles : 3,
    jsonPath: args.jsonPath ?? 'dist/browser-replay-soak-report.json',
    markdownPath: args.markdownPath ?? 'dist/browser-replay-soak-report.md',
    csvPath: args.csvPath ?? 'dist/browser-replay-soak-report.csv'
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBrowserReplaySoakReport(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Browser Replay Soak');
  console.log(`Status: ${report.status}`);
  console.log(`Report: ${resolve(report.artifacts.jsonPath)}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
