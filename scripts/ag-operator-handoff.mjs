import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultArtifacts = [
  'dist/ag-product-readiness-gate.json',
  'dist/ag-strict-gap-audit.json',
  'dist/core-service-release-dossier.json',
  'dist/pc-agent-install-release-dossier.json',
  'dist/mobile-verification-report.json',
  'dist/mobile-device-smoke-report.json',
  'dist/mobile-live-bridge-e2e-report.json',
  'dist/windows-admin-install-attempts.json',
  'dist/field-validation-kit-report.json',
  'dist/field-validation-kit/run-field-validation.ps1',
  'dist/field-validation-kit/start-field-validation-admin.ps1',
  'dist/field-validation-kit/README.md',
  'dist/field-evidence-import-report.json',
  'dist/field-evidence-import-report.md',
  'dist/field-validation/field-validation-run-summary.json',
  'dist/operator-preflight-report.json',
  'dist/operator-preflight-report.md',
  'dist/operator-preflight/run-final-validation.ps1',
  'dist/final-release-gate.json',
  'dist/final-release-gate.md',
  'dist/final-release-gate.csv',
  'dist/final-signoff-kit-report.json',
  'dist/final-signoff-kit-report.md',
  'dist/final-signoff-kit/run-final-signoff.ps1',
  'dist/final-signoff-kit/README.md',
  'dist/worm-target-report.json',
  'dist/worm-target-report.md',
  'dist/worm-promotion/manifest.json',
  'dist/worm-promotion/manifest.sha256',
  'dist/worm-promotion/external-sync-proof.json',
  'dist/worm-promotion/external-sync-proof.md',
  'dist/verification-dashboard-dossier.json',
  'dist/security-redteam-corpus-report.json',
  'dist/growth-quality-corpus-report.json'
];

export async function runAgOperatorHandoff({
  jsonPath = 'dist/ag-operator-handoff.json',
  markdownPath = 'dist/ag-operator-handoff.md',
  csvPath = 'dist/ag-operator-handoff.csv'
} = {}) {
  const [
    gate,
    gap,
    coreRelease,
    pcInstall,
    mobileVerification,
    mobileDevice,
    mobileLiveBridge,
    windowsAdminInstall,
    fieldValidationKit,
    fieldEvidenceImport,
    wormPromotion,
    wormTarget,
    externalWormSyncProof,
    operatorPreflight,
    finalReleaseGate,
    finalSignoffKit
  ] = await Promise.all([
    readJson('dist/ag-product-readiness-gate.json'),
    readJson('dist/ag-strict-gap-audit.json'),
    readJson('dist/core-service-release-dossier.json'),
    readJson('dist/pc-agent-install-release-dossier.json'),
    readJson('dist/mobile-verification-report.json'),
    readJson('dist/mobile-device-smoke-report.json'),
    readJson('dist/mobile-live-bridge-e2e-report.json'),
    readJson('dist/windows-admin-install-attempts.json'),
    readJson('dist/field-validation-kit-report.json'),
    readJson('dist/field-evidence-import-report.json'),
    readJson('dist/worm-promotion/manifest.json'),
    readJson('dist/worm-target-report.json'),
    readJson('dist/worm-promotion/external-sync-proof.json'),
    readJson('dist/operator-preflight-report.json'),
    readJson('dist/final-release-gate.json'),
    readJson('dist/final-signoff-kit-report.json')
  ]);

  const artifactManifest = await Promise.all(defaultArtifacts.map(async (path) => ({
    path,
    exists: await exists(path)
  })));
  const lanes = gate?.lanes ?? [];
  const queueLength = gate?.nextExecutionQueue?.length ?? null;
  const evidenceComplete = gate?.status === 'passed'
    && queueLength === 0
    && lanes.length > 0
    && lanes.every((lane) => lane.status === 'evidence-present' && lane.missingArtifactCount === 0);

  const coreAdminAttempt = windowsAdminInstall?.attempts?.find((item) => item.id === 'windows-core-service-admin-install');
  const pcAdminAttempt = windowsAdminInstall?.attempts?.find((item) => item.id === 'windows-pc-agent-admin-install');
  const coreFieldStatus = fieldValidationKit?.coreAdminEvidence?.status ?? 'missing';
  const pcFieldStatus = fieldValidationKit?.pcAgentAdminEvidence?.status ?? 'missing';
  const fieldKitCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File dist/field-validation-kit/start-field-validation-admin.ps1';
  const externalWormSynced = ['synced', 'already-synced'].includes(externalWormSyncProof?.status);

  const externalValidation = [
    {
      id: 'windows-core-service-admin-install',
      title: 'A Core Windows Service administrator install',
      status: coreRelease?.releaseDossier?.serviceInstalledInThisRun === true || coreAdminAttempt?.status === 'verified' || coreFieldStatus === 'verified' ? 'verified' : 'pending-field-validation',
      localEvidenceStatus: [
        coreRelease?.status ?? 'missing',
        coreAdminAttempt ? `admin-attempt:${coreAdminAttempt.status}` : 'admin-attempt:missing',
        `field-kit:${coreFieldStatus}`
      ].join(' / '),
      requiredEnvironment: 'Administrator PowerShell on the target Windows machine',
      command: fieldKitCommand,
      evidenceToAttach: [
        'dist/field-validation-kit-report.json',
        'dist/field-validation/core/*.json',
        'dist/windows-admin-install-attempts.json',
        'installed-service-verification.json',
        'installed-service-smoke.json',
        'installed-service-soak.json'
      ]
    },
    {
      id: 'windows-pc-agent-admin-install',
      title: 'B PC Agent Windows Service administrator install',
      status: pcInstall?.releaseDossier?.serviceInstalledInThisRun === true || pcAdminAttempt?.status === 'verified' || pcFieldStatus === 'verified' ? 'verified' : 'pending-field-validation',
      localEvidenceStatus: [
        pcInstall?.status ?? 'missing',
        pcAdminAttempt ? `admin-attempt:${pcAdminAttempt.status}` : 'admin-attempt:missing',
        `field-kit:${pcFieldStatus}`
      ].join(' / '),
      requiredEnvironment: 'Administrator PowerShell on the operator PC',
      command: fieldKitCommand,
      evidenceToAttach: [
        'dist/field-validation-kit-report.json',
        'dist/field-validation/pc-agent/*.json',
        'dist/windows-admin-install-attempts.json',
        'service-verification-report.json',
        'installed-service-smoke.json',
        'tray-state-report.json'
      ]
    },
    {
      id: 'mobile-physical-device-smoke',
      title: 'C Android physical device or emulator smoke',
      status: mobileDevice?.actualDeviceVerified === true ? 'verified' : 'pending-field-validation',
      localEvidenceStatus: mobileDevice?.status ?? 'missing',
      requiredEnvironment: 'ADB plus a ready Android device or emulator with the app installed',
      command: 'npm run mobile:device',
      evidenceToAttach: [
        'dist/mobile-device/*.png',
        'dist/mobile-device/*.xml',
        'dist/mobile-device-smoke-report.json'
      ]
    },
    {
      id: 'mobile-live-bridge-e2e',
      title: 'C/D live mobile bridge E2E',
      status: mobileLiveBridge?.liveBridgeVerified === true ? 'verified' : 'pending-field-validation',
      localEvidenceStatus: mobileLiveBridge?.status ?? 'missing',
      requiredEnvironment: 'A paired Android device or emulator and the local bridge server',
      command: 'npm run mobile:live-bridge-e2e',
      evidenceToAttach: [
        'dist/mobile-live-bridge-e2e-report.json',
        'SecureStore restore evidence',
        'device revoke cleanup evidence'
      ]
    },
    {
      id: 'ci-worm-promotion',
      title: 'A-G CI and WORM artifact promotion',
      status: externalWormSynced ? 'verified' : 'pending-external-integration',
      localEvidenceStatus: externalWormSynced
        ? `external-worm:${externalWormSyncProof.status}`
        : evidenceComplete && wormPromotion?.status === 'ready-for-external-worm-promotion'
          ? `ready-with-local-worm-staging / external-worm:${externalWormSyncProof?.status ?? 'missing'}`
          : evidenceComplete
            ? `ready / external-worm:${externalWormSyncProof?.status ?? 'missing'}`
            : `missing-local-evidence / external-worm:${externalWormSyncProof?.status ?? 'missing'}`,
      requiredEnvironment: 'CI runner plus append-only object-lock artifact storage',
      command: 'npm run build; npm run product:evidence; npm test; npm run ops:worm-promotion; npm run ops:worm-sync',
      evidenceToAttach: [
        'dist/worm-promotion/manifest.json',
        'dist/worm-promotion/manifest.sha256',
        'dist/worm-promotion/external-sync-proof.json',
        '.github/workflows/product-evidence.yml',
        'dist/ag-product-readiness-gate.json',
        'dist/ag-strict-gap-audit.json',
        'all module release dossiers'
      ]
    }
  ];

  const handoff = {
    reportVersion: 'ag-operator-handoff-v1',
    generatedAt: new Date().toISOString(),
    status: evidenceComplete ? 'ready-for-field-validation' : 'needs-local-evidence',
    summary: {
      strictScore: gap?.overall?.strictScore ?? gate?.overall?.strictScore ?? null,
      productReadinessScore: gate?.overall?.productReadinessScore ?? gap?.overall?.productReadinessScore ?? null,
      requirementCount: gate?.overall?.requirementCount ?? gap?.overall?.requirementCount ?? null,
      laneCount: lanes.length,
      evidenceComplete,
      nextExecutionQueueLength: queueLength,
      externalValidationPending: externalValidation.filter((item) => item.status.startsWith('pending')).length,
      windowsAdminInstallAttemptStatus: windowsAdminInstall?.status ?? 'missing',
      fieldValidationKitStatus: fieldValidationKit?.status ?? 'missing',
      fieldEvidenceImportStatus: fieldEvidenceImport?.status ?? 'missing',
      operatorPreflightStatus: operatorPreflight?.status ?? 'missing',
      finalReleaseGateStatus: finalReleaseGate?.status ?? 'missing',
      finalSignoffKitStatus: finalSignoffKit?.status ?? 'missing',
      wormPromotionStatus: wormPromotion?.status ?? 'missing',
      wormTargetStatus: wormTarget?.status ?? 'missing',
      externalWormSyncStatus: externalWormSyncProof?.status ?? 'missing',
      actualDeviceVerified: mobileVerification?.deviceProbe?.actualDeviceVerified === true || mobileDevice?.actualDeviceVerified === true
    },
    lanes: lanes.map((lane) => ({
      laneId: lane.laneId,
      title: lane.title,
      status: lane.status,
      missingArtifactCount: lane.missingArtifactCount,
      primaryGap: lane.primaryGap
    })),
    externalValidation,
    artifactManifest,
    nextActions: buildNextActions({ evidenceComplete, externalValidation })
  };

  handoff.artifacts = {
    jsonPath: resolve(jsonPath),
    markdownPath: resolve(markdownPath),
    csvPath: resolve(csvPath)
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(handoff), 'utf8');
  await writeFile(csvPath, renderCsv(handoff), 'utf8');
  return handoff;
}

function buildNextActions({ evidenceComplete, externalValidation }) {
  if (!evidenceComplete) return ['Run npm run product:evidence after npm run build, then rerun npm run ag:handoff.'];
  return externalValidation
    .filter((item) => item.status.startsWith('pending'))
    .map((item) => `${item.id}: ${item.command}`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function renderMarkdown(handoff) {
  const lines = [
    '# JARVIS A-G Operator Handoff',
    '',
    `Status: **${handoff.status}**`,
    `Strict score: ${handoff.summary.strictScore}`,
    `Product readiness: ${handoff.summary.productReadinessScore}`,
    `Evidence lanes: ${handoff.lanes.filter((lane) => lane.status === 'evidence-present').length}/${handoff.lanes.length}`,
    `Execution queue: ${handoff.summary.nextExecutionQueueLength}`,
    `External WORM sync: ${handoff.summary.externalWormSyncStatus}`,
    `Field evidence import: ${handoff.summary.fieldEvidenceImportStatus}`,
    `WORM target: ${handoff.summary.wormTargetStatus}`,
    `Operator preflight: ${handoff.summary.operatorPreflightStatus}`,
    `Final release gate: ${handoff.summary.finalReleaseGateStatus}`,
    `Final signoff kit: ${handoff.summary.finalSignoffKitStatus}`,
    '',
    '## Lanes',
    '',
    '| Lane | Status | Missing |',
    '| --- | --- | --- |',
    ...handoff.lanes.map((lane) => `| ${lane.laneId} | ${lane.status} | ${lane.missingArtifactCount} |`),
    '',
    '## Field Validation',
    '',
    '| Item | Status | Environment | Command |',
    '| --- | --- | --- | --- |',
    ...handoff.externalValidation.map((item) => `| ${item.id} | ${item.status} | ${item.requiredEnvironment} | \`${item.command}\` |`),
    '',
    '## Next Actions',
    '',
    ...handoff.nextActions.map((item) => `- ${item}`),
    '',
    '## Artifacts',
    '',
    ...handoff.artifactManifest.map((item) => `- ${item.exists ? 'present' : 'missing'}: \`${item.path}\``)
  ];
  return `${lines.join('\n')}\n`;
}

function renderCsv(handoff) {
  const rows = [['kind', 'id', 'status', 'detail'].join(',')];
  for (const lane of handoff.lanes) {
    rows.push(['lane', lane.laneId, lane.status, `missing=${lane.missingArtifactCount}`].map(csv).join(','));
  }
  for (const item of handoff.externalValidation) {
    rows.push(['field_validation', item.id, item.status, item.command].map(csv).join(','));
  }
  for (const item of handoff.artifactManifest) {
    rows.push(['artifact', item.path, item.exists ? 'present' : 'missing', ''].map(csv).join(','));
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
    if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handoff = await runAgOperatorHandoff(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS A-G Operator Handoff');
  console.log(`Status: ${handoff.status}`);
  console.log(`Evidence lanes: ${handoff.lanes.filter((lane) => lane.status === 'evidence-present').length}/${handoff.lanes.length}`);
  console.log(`External validation pending: ${handoff.summary.externalValidationPending}`);
  console.log(`Reports: ${handoff.artifacts.jsonPath}, ${handoff.artifacts.markdownPath}, ${handoff.artifacts.csvPath}`);
  if (handoff.status !== 'ready-for-field-validation') process.exitCode = 1;
}
