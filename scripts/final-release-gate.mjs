import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/final-release-gate.json';
const defaultMarkdownPath = 'dist/final-release-gate.md';
const defaultCsvPath = 'dist/final-release-gate.csv';

function normalizePath(path) {
  return path.split(sep).join('/');
}

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function check(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    detail
  };
}

function isSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

function externalValidationItems(handoff) {
  return Array.isArray(handoff?.externalValidation) ? handoff.externalValidation : [];
}

export async function runFinalReleaseGate({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  csvPath = workspacePath(workspaceRoot, defaultCsvPath)
} = {}) {
  const [
    gate,
    gap,
    handoff,
    preflight,
    fieldKit,
    wormManifest,
    wormProof,
    mobileDevice,
    mobileLiveBridge,
    wearablePhysicalField
  ] = await Promise.all([
    readJson(workspacePath(workspaceRoot, 'dist/ag-product-readiness-gate.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ag-strict-gap-audit.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ag-operator-handoff.json')),
    readJson(workspacePath(workspaceRoot, 'dist/operator-preflight-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/field-validation-kit-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/manifest.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/external-sync-proof.json')),
    readJson(workspacePath(workspaceRoot, 'dist/mobile-device-smoke-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/mobile-live-bridge-e2e-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/wearable-physical-field-gate.json'))
  ]);

  const validationItems = externalValidationItems(handoff);
  const pendingValidation = validationItems.filter((item) => item.status !== 'verified');
  const fieldEvidenceVerified = fieldKit?.status === 'field-evidence-verified'
    && fieldKit?.coreAdminEvidence?.status === 'verified'
    && fieldKit?.pcAgentAdminEvidence?.status === 'verified'
    && fieldKit?.fieldRunSummary?.status === 'passed';
  const wormSynced = isSynced(wormProof?.status);
  const strictScore = gap?.overall?.strictScore ?? gate?.overall?.strictScore ?? null;
  const productReadinessScore = gate?.overall?.productReadinessScore ?? gap?.overall?.productReadinessScore ?? null;
  const productGatePassed = gate?.status === 'passed'
    && (gate?.nextExecutionQueue?.length ?? 1) === 0
    && (gate?.lanes ?? []).every((lane) => lane.status === 'evidence-present' && lane.missingArtifactCount === 0);
  const artifactPaths = [
    'dist/ag-product-readiness-gate.json',
    'dist/ag-strict-gap-audit.json',
    'dist/ag-operator-handoff.json',
    'dist/operator-preflight-report.json',
    'dist/field-validation-kit-report.json',
    'dist/field-validation/field-validation-run-summary.json',
    'dist/worm-promotion/manifest.json',
    'dist/worm-promotion/external-sync-proof.json',
    'dist/wearable-physical-field-gate.json'
  ];
  const artifactPresence = await Promise.all(artifactPaths.map(async (path) => ({
    path,
    exists: await exists(workspacePath(workspaceRoot, path))
  })));

  const checks = [
    check('ag_product_gate_passed', productGatePassed, {
      status: gate?.status ?? 'missing',
      queueLength: gate?.nextExecutionQueue?.length ?? null
    }),
    check('ag_strict_implementation_complete', strictScore === 100, {
      strictScore
    }),
    check('ag_product_readiness_target_met', Number(productReadinessScore) >= 95, {
      productReadinessScore,
      target: 95
    }),
    check('operator_handoff_ready', handoff?.status === 'ready-for-field-validation', {
      status: handoff?.status ?? 'missing'
    }),
    check('external_validation_all_verified', pendingValidation.length === 0 && validationItems.length > 0, {
      pending: pendingValidation.map((item) => item.id),
      total: validationItems.length
    }),
    check('operator_preflight_final_signoff_ready', preflight?.status === 'ready-for-final-signoff', {
      status: preflight?.status ?? 'missing',
      operatorActionCount: preflight?.summary?.operatorActionCount ?? null
    }),
    check('field_validation_admin_evidence_verified', fieldEvidenceVerified, {
      fieldKitStatus: fieldKit?.status ?? 'missing',
      coreStatus: fieldKit?.coreAdminEvidence?.status ?? 'missing',
      pcAgentStatus: fieldKit?.pcAgentAdminEvidence?.status ?? 'missing',
      fieldRunSummaryStatus: fieldKit?.fieldRunSummary?.status ?? 'missing'
    }),
    check('external_worm_sync_verified', wormSynced, {
      proofStatus: wormProof?.status ?? 'missing',
      provider: wormProof?.provider ?? null,
      bundleHash: wormProof?.bundleHash ?? null
    }),
    check('worm_manifest_ready', wormManifest?.status === 'ready-for-external-worm-promotion', {
      status: wormManifest?.status ?? 'missing',
      artifactCount: wormManifest?.artifactCount ?? null
    }),
    check('mobile_device_verified', mobileDevice?.actualDeviceVerified === true, {
      status: mobileDevice?.status ?? 'missing',
      actualDeviceVerified: mobileDevice?.actualDeviceVerified ?? null
    }),
    check('mobile_live_bridge_verified', mobileLiveBridge?.liveBridgeVerified === true, {
      status: mobileLiveBridge?.status ?? 'missing',
      liveBridgeVerified: mobileLiveBridge?.liveBridgeVerified ?? null
    }),
    check('wearable_physical_field_verified', wearablePhysicalField?.status === 'passed'
      && wearablePhysicalField?.physicalValidationPassed === true
      && wearablePhysicalField?.integrity?.passed === true
      && wearablePhysicalField?.evaluation?.status === 'passed', {
      status: wearablePhysicalField?.status ?? 'missing',
      physicalValidationPassed: wearablePhysicalField?.physicalValidationPassed ?? false,
      evidenceState: wearablePhysicalField?.evidence?.state ?? 'missing',
      integrityState: wearablePhysicalField?.integrity?.state ?? 'missing'
    }),
    check('no_raw_operator_secret_or_command_stored', preflight?.generatedArtifacts?.rawAdminTokenStored === false
      && preflight?.generatedArtifacts?.rawWormCredentialStored === false
      && preflight?.generatedArtifacts?.rawExternalCommandStored === false
      && wormProof?.rawCredentialsStored === false
      && wormProof?.rawCommandStored === false, {
      preflightRawAdminTokenStored: preflight?.generatedArtifacts?.rawAdminTokenStored ?? null,
      preflightRawWormCredentialStored: preflight?.generatedArtifacts?.rawWormCredentialStored ?? null,
      preflightRawExternalCommandStored: preflight?.generatedArtifacts?.rawExternalCommandStored ?? null,
      wormRawCredentialsStored: wormProof?.rawCredentialsStored ?? null,
      wormRawCommandStored: wormProof?.rawCommandStored ?? null
    }),
    check('final_release_artifacts_present', artifactPresence.every((item) => item.exists), {
      missing: artifactPresence.filter((item) => !item.exists).map((item) => item.path)
    })
  ];

  const blockingChecks = checks.filter((item) => !item.passed);
  const status = blockingChecks.length === 0 ? 'passed' : 'blocked-field-validation';
  const blockingItems = [
    ...blockingChecks.map((item) => ({
      type: 'check',
      id: item.checkId,
      detail: item.detail
    })),
    ...pendingValidation.map((item) => ({
      type: 'external-validation',
      id: item.id,
      status: item.status,
      command: item.command
    }))
  ];

  const report = {
    reportVersion: 'jarvis-final-release-gate-v1',
    generatedAt: new Date().toISOString(),
    status,
    releaseMode: status === 'passed' ? 'final-release-ready' : 'field-validation-required',
    summary: {
      strictScore,
      productReadinessScore,
      productGateStatus: gate?.status ?? 'missing',
      handoffStatus: handoff?.status ?? 'missing',
      preflightStatus: preflight?.status ?? 'missing',
      fieldValidationKitStatus: fieldKit?.status ?? 'missing',
      wearablePhysicalFieldStatus: wearablePhysicalField?.status ?? 'missing',
      wormSyncStatus: wormProof?.status ?? 'missing',
      externalValidationTotal: validationItems.length,
      externalValidationPending: pendingValidation.length,
      blockingCheckCount: blockingChecks.length
    },
    checks,
    blockingItems,
    recommendedActions: buildRecommendedActions({ preflight, pendingValidation, blockingChecks }),
    artifactPresence,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      csvPath: resolve(csvPath)
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

function buildRecommendedActions({ preflight, pendingValidation, blockingChecks }) {
  const fromPreflight = Array.isArray(preflight?.operatorActions)
    ? preflight.operatorActions.map((item) => ({
        actionId: item.actionId,
        title: item.title,
        command: item.command,
        source: 'operator-preflight'
      }))
    : [];
  if (fromPreflight.length > 0) return fromPreflight;
  return pendingValidation.map((item) => ({
    actionId: item.id,
    title: item.title,
    command: item.command,
    source: 'operator-handoff'
  })).concat(blockingChecks.map((item) => ({
    actionId: `resolve-${item.checkId}`,
    title: `Resolve ${item.checkId}`,
    command: item.checkId === 'wearable_physical_field_verified'
      ? 'npm run wearable:field-kit; node dist/wearable-hud-field-kit/field-server.mjs --host 0.0.0.0 --port 4176; npm run wearable:physical-gate; npm run ops:final-gate'
      : 'npm run product:evidence; npm run ops:preflight; npm run ops:final-gate',
    source: 'final-release-gate'
  })));
}

function renderMarkdown(report) {
  return [
    '# JARVIS Final Release Gate',
    '',
    `Status: **${report.status}**`,
    `Release mode: ${report.releaseMode}`,
    `Strict score: ${report.summary.strictScore}`,
    `Product readiness: ${report.summary.productReadinessScore}`,
    `Preflight: ${report.summary.preflightStatus}`,
    `Field validation: ${report.summary.fieldValidationKitStatus}`,
    `Wearable physical field: ${report.summary.wearablePhysicalFieldStatus}`,
    `External WORM sync: ${report.summary.wormSyncStatus}`,
    `Pending external validation: ${report.summary.externalValidationPending}/${report.summary.externalValidationTotal}`,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Blocking Items',
    '',
    ...(report.blockingItems.length > 0
      ? report.blockingItems.map((item) => `- ${item.type}:${item.id}`)
      : ['- none']),
    '',
    '## Recommended Actions',
    '',
    ...(report.recommendedActions.length > 0
      ? report.recommendedActions.map((item) => `- ${item.actionId}: \`${item.command}\``)
      : ['- none']),
    ''
  ].join('\n');
}

function renderCsv(report) {
  const rows = [['kind', 'id', 'status', 'detail'].join(',')];
  rows.push(['report', report.reportVersion, report.status, report.releaseMode].map(csv).join(','));
  for (const checkItem of report.checks) {
    rows.push(['check', checkItem.checkId, checkItem.passed ? 'passed' : 'blocked', JSON.stringify(checkItem.detail)].map(csv).join(','));
  }
  for (const item of report.blockingItems) {
    rows.push(['blocking_item', item.id, item.type, item.command ?? ''].map(csv).join(','));
  }
  for (const item of report.recommendedActions) {
    rows.push(['recommended_action', item.actionId, item.source, item.command].map(csv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFinalReleaseGate(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Final Release Gate');
  console.log(`Status: ${report.status}`);
  console.log(`Release mode: ${report.releaseMode}`);
  console.log(`Blocking checks: ${report.summary.blockingCheckCount}`);
  console.log('Reports: dist/final-release-gate.json, dist/final-release-gate.md, dist/final-release-gate.csv');
  if (report.status !== 'passed') process.exitCode = 1;
}
