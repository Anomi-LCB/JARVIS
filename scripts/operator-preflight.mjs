import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/operator-preflight-report.json';
const defaultMarkdownPath = 'dist/operator-preflight-report.md';
const defaultOutputDir = 'dist/operator-preflight';

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

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function check(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    detail
  };
}

function statusIsSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

function statusIsFieldVerified(status) {
  return status === 'field-evidence-verified';
}

export async function runOperatorPreflight({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  outputDir = workspacePath(workspaceRoot, defaultOutputDir),
  env = process.env
} = {}) {
  const gate = await readJson(workspacePath(workspaceRoot, 'dist/ag-product-readiness-gate.json'));
  const handoff = await readJson(workspacePath(workspaceRoot, 'dist/ag-operator-handoff.json'));
  const fieldKit = await readJson(workspacePath(workspaceRoot, 'dist/field-validation-kit-report.json'));
  const adminAttempts = await readJson(workspacePath(workspaceRoot, 'dist/windows-admin-install-attempts.json'));
  const wormManifest = await readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/manifest.json'));
  const wormProof = await readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/external-sync-proof.json'));
  const workflowPath = workspacePath(workspaceRoot, '.github/workflows/product-evidence.yml');
  const workflowText = await readText(workflowPath);

  const paths = {
    adminLauncher: workspacePath(workspaceRoot, 'dist/field-validation-kit/start-field-validation-admin.ps1'),
    fieldRunScript: workspacePath(workspaceRoot, 'dist/field-validation-kit/run-field-validation.ps1'),
    coreInstallAll: workspacePath(workspaceRoot, 'dist/core-service-package/install-all.ps1'),
    coreSoak: workspacePath(workspaceRoot, 'dist/core-service-package/run-installed-service-soak.ps1'),
    pcInstallRelease: workspacePath(workspaceRoot, 'dist/pc-agent-installer/install-verify-release.ps1'),
    wormManifest: workspacePath(workspaceRoot, 'dist/worm-promotion/manifest.json'),
    wormProof: workspacePath(workspaceRoot, 'dist/worm-promotion/external-sync-proof.json')
  };

  const productGatePassed = gate?.status === 'passed' && (gate?.nextExecutionQueue?.length ?? 1) === 0;
  const handoffReady = handoff?.status === 'ready-for-field-validation';
  const wearableValidation = handoff?.externalValidation?.find((item) => item.id === 'wearable-physical-field-validation');
  const wearablePhysicalVerified = !wearableValidation || wearableValidation.status === 'verified';
  const fieldKitReady = ['ready-for-field-validation', 'field-evidence-verified'].includes(fieldKit?.status);
  const adminEvidenceVerified = statusIsFieldVerified(fieldKit?.status);
  const wormReady = wormManifest?.status === 'ready-for-external-worm-promotion';
  const wormSynced = statusIsSynced(wormProof?.status);
  const wormTargetConfigured = Boolean(env.JARVIS_WORM_SYNC_DIR || env.JARVIS_WORM_APPEND_ONLY_DIR || wormSynced);
  const workflowHasWormSync = workflowText.includes('npm run ops:worm-sync');
  const workflowHasPreflight = workflowText.includes('npm run ops:preflight');

  const scriptPresence = {
    adminLauncher: await exists(paths.adminLauncher),
    fieldRunScript: await exists(paths.fieldRunScript),
    coreInstallAll: await exists(paths.coreInstallAll),
    coreSoak: await exists(paths.coreSoak),
    pcInstallRelease: await exists(paths.pcInstallRelease)
  };

  const checks = [
    check('product_gate_passed', productGatePassed, {
      status: gate?.status ?? 'missing',
      queueLength: gate?.nextExecutionQueue?.length ?? null
    }),
    check('operator_handoff_ready', handoffReady, {
      status: handoff?.status ?? 'missing',
      externalValidationPending: handoff?.summary?.externalValidationPending ?? null
    }),
    check('wearable_physical_field_verified', wearablePhysicalVerified, {
      tracked: Boolean(wearableValidation),
      status: wearableValidation?.status ?? 'not-tracked-in-legacy-handoff'
    }),
    check('field_validation_kit_ready', fieldKitReady, {
      status: fieldKit?.status ?? 'missing'
    }),
    check('field_validation_admin_evidence_verified', adminEvidenceVerified, {
      status: fieldKit?.status ?? 'missing',
      coreStatus: fieldKit?.coreAdminEvidence?.status ?? 'missing',
      pcAgentStatus: fieldKit?.pcAgentAdminEvidence?.status ?? 'missing'
    }),
    check('admin_launcher_present', scriptPresence.adminLauncher, {
      path: normalizePath(relative(workspaceRoot, paths.adminLauncher))
    }),
    check('field_run_script_present', scriptPresence.fieldRunScript, {
      path: normalizePath(relative(workspaceRoot, paths.fieldRunScript))
    }),
    check('core_admin_scripts_present', scriptPresence.coreInstallAll && scriptPresence.coreSoak, {
      installAll: scriptPresence.coreInstallAll,
      installedServiceSoak: scriptPresence.coreSoak
    }),
    check('pc_agent_admin_script_present', scriptPresence.pcInstallRelease, {
      installRelease: scriptPresence.pcInstallRelease
    }),
    check('worm_manifest_ready', wormReady, {
      status: wormManifest?.status ?? 'missing',
      bundleHash: wormManifest?.bundleHash ?? null
    }),
    check('external_worm_target_configured_or_synced', wormTargetConfigured, {
      proofStatus: wormProof?.status ?? 'missing',
      configuredEnv: {
        JARVIS_WORM_SYNC_DIR: Boolean(env.JARVIS_WORM_SYNC_DIR),
        JARVIS_WORM_APPEND_ONLY_DIR: Boolean(env.JARVIS_WORM_APPEND_ONLY_DIR)
      }
    }),
    check('external_worm_sync_verified', wormSynced, {
      proofStatus: wormProof?.status ?? 'missing',
      provider: wormProof?.provider ?? null
    }),
    check('workflow_worm_sync_step_present', workflowHasWormSync, {
      workflowPath: normalizePath(relative(workspaceRoot, workflowPath))
    }),
    check('workflow_preflight_step_present', workflowHasPreflight, {
      workflowPath: normalizePath(relative(workspaceRoot, workflowPath))
    }),
    check('worm_sync_does_not_store_raw_secret_or_command', wormProof?.rawCredentialsStored === false && wormProof?.rawCommandStored === false, {
      rawCredentialsStored: wormProof?.rawCredentialsStored ?? null,
      rawCommandStored: wormProof?.rawCommandStored ?? null
    })
  ];

  const criticalReady = productGatePassed
    && fieldKitReady
    && scriptPresence.adminLauncher
    && scriptPresence.fieldRunScript
    && scriptPresence.coreInstallAll
    && scriptPresence.coreSoak
    && scriptPresence.pcInstallRelease
    && wormReady
    && workflowHasWormSync
    && workflowHasPreflight;
  const operatorActions = buildOperatorActions({
    adminEvidenceVerified,
    wormSynced,
    wormTargetConfigured,
    handoffReady,
    fieldKitReady,
    wearablePhysicalVerified
  });
  const status = !criticalReady
    ? 'blocked'
    : operatorActions.length === 0
      ? 'ready-for-final-signoff'
      : 'ready-for-operator-action';

  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  const finalizationScriptPath = join(outputDir, 'run-final-validation.ps1');
  await writeFile(finalizationScriptPath, renderFinalizationPowerShell(), 'utf8');

  const report = {
    reportVersion: 'jarvis-operator-preflight-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      productGatePassed,
      handoffReady,
      fieldValidationKitStatus: fieldKit?.status ?? 'missing',
      adminAttemptStatus: adminAttempts?.status ?? 'missing',
      adminEvidenceVerified,
      wormPromotionStatus: wormManifest?.status ?? 'missing',
      externalWormSyncStatus: wormProof?.status ?? 'missing',
      externalWormTargetConfigured: wormTargetConfigured,
      externalValidationPending: handoff?.summary?.externalValidationPending ?? null,
      wearablePhysicalVerified,
      operatorActionCount: operatorActions.length
    },
    checks,
    operatorActions,
    generatedArtifacts: {
      finalizationScript: resolve(finalizationScriptPath),
      rawAdminTokenStored: false,
      rawWormCredentialStored: false,
      rawExternalCommandStored: false
    },
    paths: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, normalizePath(relative(workspaceRoot, value))]))
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildOperatorActions({
  adminEvidenceVerified,
  wormSynced,
  wormTargetConfigured,
  handoffReady,
  fieldKitReady,
  wearablePhysicalVerified
}) {
  const actions = [];
  if (!fieldKitReady || !adminEvidenceVerified) {
    actions.push({
      actionId: 'run-admin-field-validation',
      title: 'Run Core and PC Agent administrator field validation',
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -File dist/field-validation-kit/start-field-validation-admin.ps1',
      expectedEvidence: [
        'dist/field-validation/field-validation-run-summary.json',
        'dist/field-validation/core/*.json',
        'dist/field-validation/pc-agent/*.json',
        'dist/field-validation-kit-report.json'
      ],
      closesValidationIds: [
        'windows-core-service-admin-install',
        'windows-pc-agent-admin-install'
      ]
    });
    actions.push({
      actionId: 'import-admin-field-validation-evidence',
      title: 'Import Core and PC Agent administrator field evidence',
      command: 'npm run ops:field-import -- --source-dir "<field-validation-evidence-dir>"; npm run ops:field-kit; npm run ag:handoff; npm run ops:preflight',
      expectedEvidence: [
        'dist/field-evidence-import-report.json',
        'dist/field-validation/field-validation-run-summary.json',
        'dist/field-validation/core/*.json',
        'dist/field-validation/pc-agent/*.json',
        'dist/field-validation-kit-report.json'
      ],
      closesValidationIds: [
        'windows-core-service-admin-install',
        'windows-pc-agent-admin-install'
      ]
    });
  }
  if (!wormSynced) {
    actions.push({
      actionId: wormTargetConfigured ? 'run-external-worm-sync' : 'configure-and-run-external-worm-sync',
      title: wormTargetConfigured ? 'Run external WORM sync' : 'Configure append-only WORM target and run sync',
      command: 'npm run ops:worm-target -- --target-dir "<append-only-object-lock-path>"; npm run ops:worm-sync -- --external-dir "<append-only-object-lock-path>"',
      expectedEvidence: [
        'dist/worm-target-report.json',
        'dist/worm-promotion/external-sync-proof.json',
        'dist/worm-promotion/external-sync-proof.md'
      ],
      closesValidationIds: [
        'ci-worm-promotion'
      ]
    });
  }
  if (!wearablePhysicalVerified) {
    actions.push({
      actionId: 'run-wearable-physical-field-validation',
      title: 'Run the target AI glasses physical field lab',
      command: 'npm run wearable:field-kit; node dist/wearable-hud-field-kit/field-server.mjs --host 0.0.0.0 --port 4176; npm run wearable:physical-gate',
      expectedEvidence: [
        'dist/wearable-hud-field-kit/field-evidence/latest-field-evidence.json',
        'dist/wearable-physical-field-gate.json',
        'dist/wearable-field-chaos-report.json'
      ],
      closesValidationIds: [
        'wearable-physical-field-validation'
      ]
    });
  }
  if (!handoffReady || actions.length > 0) {
    actions.push({
      actionId: 'refresh-operator-evidence',
      title: 'Refresh field kit, handoff, and preflight reports',
      command: 'npm run ops:field-kit; npm run ag:handoff; npm run ops:preflight',
      expectedEvidence: [
        'dist/field-validation-kit-report.json',
        'dist/ag-operator-handoff.json',
        'dist/operator-preflight-report.json'
      ],
      closesValidationIds: []
    });
  }
  return actions;
}

function renderFinalizationPowerShell() {
  return `# Generated by JARVIS operator preflight.
param(
  [string]$WormTargetDir,
  [switch]$Production
)
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Split-Path -Parent $scriptRoot
$workspaceRoot = Split-Path -Parent $distRoot
$fieldLauncher = Join-Path $distRoot "field-validation-kit\\start-field-validation-admin.ps1"
if ($WormTargetDir) {
  $env:JARVIS_WORM_SYNC_DIR = $WormTargetDir
}
if (-not (Test-Path $fieldLauncher)) {
  throw "Missing field validation launcher: $fieldLauncher"
}
Push-Location $workspaceRoot
try {
  $launcherArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "\`"$fieldLauncher\`"")
  if ($Production) { $launcherArgs += "-Production" }
  & powershell @launcherArgs
  & npm run ops:worm-promotion
  if ($WormTargetDir) {
    & npm run ops:worm-target -- --target-dir $WormTargetDir
  }
  & npm run ops:worm-sync
  & npm run ops:field-kit
  & npm run ag:handoff
  & npm run ops:preflight
} finally {
  Pop-Location
}
`;
}

function renderMarkdown(report) {
  return [
    '# JARVIS Operator Preflight',
    '',
    `Status: **${report.status}**`,
    `Product gate: ${report.summary.productGatePassed ? 'passed' : 'not passed'}`,
    `Field validation kit: ${report.summary.fieldValidationKitStatus}`,
    `Admin evidence verified: ${report.summary.adminEvidenceVerified ? 'yes' : 'no'}`,
    `External WORM sync: ${report.summary.externalWormSyncStatus}`,
    `Operator actions: ${report.summary.operatorActionCount}`,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Operator Actions',
    '',
    ...report.operatorActions.map((item) => `- ${item.actionId}: \`${item.command}\``),
    '',
    '## Generated Artifacts',
    '',
    `- Finalization script: \`${normalizePath(relative(process.cwd(), report.generatedArtifacts.finalizationScript))}\``,
    `- Raw admin token stored: ${report.generatedArtifacts.rawAdminTokenStored ? 'yes' : 'no'}`,
    `- Raw WORM credential stored: ${report.generatedArtifacts.rawWormCredentialStored ? 'yes' : 'no'}`,
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--output-dir') args.outputDir = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runOperatorPreflight(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Operator Preflight');
  console.log(`Status: ${report.status}`);
  console.log(`Operator actions: ${report.summary.operatorActionCount}`);
  console.log(`External WORM sync: ${report.summary.externalWormSyncStatus}`);
  console.log('Reports: dist/operator-preflight-report.json, dist/operator-preflight-report.md');
  if (report.status === 'blocked') process.exitCode = 1;
}
