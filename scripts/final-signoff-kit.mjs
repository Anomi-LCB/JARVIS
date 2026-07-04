import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultOutputDir = 'dist/final-signoff-kit';
const defaultJsonPath = 'dist/final-signoff-kit-report.json';
const defaultMarkdownPath = 'dist/final-signoff-kit-report.md';

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

function isFieldVerified(fieldKit) {
  return fieldKit?.status === 'field-evidence-verified'
    && fieldKit?.coreAdminEvidence?.status === 'verified'
    && fieldKit?.pcAgentAdminEvidence?.status === 'verified'
    && fieldKit?.fieldRunSummary?.status === 'passed';
}

export async function runFinalSignoffKit({
  workspaceRoot = process.cwd(),
  outputDir = workspacePath(workspaceRoot, defaultOutputDir),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath)
} = {}) {
  const [
    finalGate,
    preflight,
    handoff,
    fieldKit,
    fieldEvidenceImport,
    wormTarget,
    wormProof,
    wormManifest
  ] = await Promise.all([
    readJson(workspacePath(workspaceRoot, 'dist/final-release-gate.json')),
    readJson(workspacePath(workspaceRoot, 'dist/operator-preflight-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ag-operator-handoff.json')),
    readJson(workspacePath(workspaceRoot, 'dist/field-validation-kit-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/field-evidence-import-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-target-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/external-sync-proof.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/manifest.json'))
  ]);

  const finalGatePassed = finalGate?.status === 'passed';
  const fieldVerified = isFieldVerified(fieldKit);
  const wormSynced = isSynced(wormProof?.status);
  const pendingValidation = Array.isArray(handoff?.externalValidation)
    ? handoff.externalValidation.filter((item) => item.status !== 'verified')
    : [];
  const operatorActions = Array.isArray(preflight?.operatorActions) ? preflight.operatorActions : [];

  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  const runScriptPath = join(outputDir, 'run-final-signoff.ps1');
  const readmePath = join(outputDir, 'README.md');
  await writeFile(runScriptPath, renderFinalSignoffPowerShell(), 'utf8');

  const checks = [
    check('final_release_gate_present', Boolean(finalGate), {
      status: finalGate?.status ?? 'missing'
    }),
    check('operator_preflight_present', Boolean(preflight), {
      status: preflight?.status ?? 'missing'
    }),
    check('operator_handoff_present', Boolean(handoff), {
      status: handoff?.status ?? 'missing'
    }),
    check('field_validation_kit_present', Boolean(fieldKit), {
      status: fieldKit?.status ?? 'missing'
    }),
    check('field_validation_admin_evidence_verified', fieldVerified, {
      status: fieldKit?.status ?? 'missing',
      coreStatus: fieldKit?.coreAdminEvidence?.status ?? 'missing',
      pcAgentStatus: fieldKit?.pcAgentAdminEvidence?.status ?? 'missing'
    }),
    check('worm_manifest_ready', wormManifest?.status === 'ready-for-external-worm-promotion', {
      status: wormManifest?.status ?? 'missing',
      bundleHash: wormManifest?.bundleHash ?? null
    }),
    check('external_worm_sync_verified', wormSynced, {
      status: wormProof?.status ?? 'missing',
      provider: wormProof?.provider ?? null
    }),
    check('final_signoff_script_generated', await exists(runScriptPath), {
      path: normalizePath(relative(workspaceRoot, runScriptPath))
    }),
    check('raw_secret_or_command_not_stored', wormProof?.rawCredentialsStored === false
      && wormProof?.rawCommandStored === false
      && preflight?.generatedArtifacts?.rawAdminTokenStored === false
      && preflight?.generatedArtifacts?.rawWormCredentialStored === false
      && preflight?.generatedArtifacts?.rawExternalCommandStored === false, {
      wormRawCredentialsStored: wormProof?.rawCredentialsStored ?? null,
      wormRawCommandStored: wormProof?.rawCommandStored ?? null,
      preflightRawAdminTokenStored: preflight?.generatedArtifacts?.rawAdminTokenStored ?? null,
      preflightRawWormCredentialStored: preflight?.generatedArtifacts?.rawWormCredentialStored ?? null,
      preflightRawExternalCommandStored: preflight?.generatedArtifacts?.rawExternalCommandStored ?? null
    })
  ];

  const status = finalGatePassed
    ? 'ready-for-final-signoff'
    : checks.find((item) => item.checkId === 'final_release_gate_present')?.passed
      ? 'ready-for-operator-action'
      : 'blocked-missing-final-gate';
  const primaryCommand = wormSynced
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -File dist/final-signoff-kit/run-final-signoff.ps1'
    : 'powershell -NoProfile -ExecutionPolicy Bypass -File dist/final-signoff-kit/run-final-signoff.ps1 -WormTargetDir "<append-only-object-lock-path>"';
  const fieldEvidenceImportCommand = fieldVerified
    ? null
    : 'npm run ops:field-import -- --source-dir "<field-validation-evidence-dir>"';

  const report = {
    reportVersion: 'jarvis-final-signoff-kit-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      finalGateStatus: finalGate?.status ?? 'missing',
      finalReleaseMode: finalGate?.releaseMode ?? 'missing',
      preflightStatus: preflight?.status ?? 'missing',
      handoffStatus: handoff?.status ?? 'missing',
      fieldValidationKitStatus: fieldKit?.status ?? 'missing',
      fieldEvidenceImportStatus: fieldEvidenceImport?.status ?? 'missing',
      fieldValidationVerified: fieldVerified,
      wormTargetStatus: wormTarget?.status ?? 'missing',
      wormSyncStatus: wormProof?.status ?? 'missing',
      wormSyncVerified: wormSynced,
      pendingExternalValidation: pendingValidation.length,
      operatorActionCount: operatorActions.length,
      primaryCommand,
      fieldEvidenceImportCommand
    },
    checks,
    operatorActions: operatorActions.map((item) => ({
      actionId: item.actionId,
      title: item.title,
      command: item.command,
      expectedEvidence: item.expectedEvidence ?? [],
      closesValidationIds: item.closesValidationIds ?? []
    })),
    pendingValidation: pendingValidation.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      command: item.command
    })),
    generatedArtifacts: {
      runScript: resolve(runScriptPath),
      readme: resolve(readmePath),
      fieldEvidenceImportReport: workspacePath(workspaceRoot, 'dist/field-evidence-import-report.json'),
      wormTargetReport: workspacePath(workspaceRoot, 'dist/worm-target-report.json'),
      rawAdminTokenStored: false,
      rawWormCredentialStored: false,
      rawExternalCommandStored: false
    },
    finalGate: {
      status: finalGate?.status ?? 'missing',
      blockingItems: finalGate?.blockingItems ?? [],
      recommendedActions: finalGate?.recommendedActions ?? []
    }
  };

  await writeFile(readmePath, renderReadme(report), 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function renderFinalSignoffPowerShell() {
  return `# Generated by JARVIS final signoff kit.
param(
  [string]$WormTargetDir,
  [string]$FieldEvidenceSourceDir,
  [switch]$Production,
  [switch]$SkipAdminFieldValidation,
  [switch]$AllowBlocked
)
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Split-Path -Parent $scriptRoot
$workspaceRoot = Split-Path -Parent $distRoot
$transcriptRoot = Join-Path $scriptRoot "transcripts"
New-Item -ItemType Directory -Force -Path $transcriptRoot | Out-Null
$transcriptPath = Join-Path $transcriptRoot ("final-signoff-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$transcriptStarted = $false
try {
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  $transcriptStarted = $true
} catch {
  Write-Warning "Could not start transcript: $($_.Exception.Message)"
}
if ($WormTargetDir) {
  $env:JARVIS_WORM_SYNC_DIR = $WormTargetDir
}
$fieldLauncher = Join-Path $distRoot "field-validation-kit\\start-field-validation-admin.ps1"
Push-Location $workspaceRoot
try {
  if (-not $SkipAdminFieldValidation) {
    if (-not (Test-Path $fieldLauncher)) {
      throw "Missing field validation launcher: $fieldLauncher"
    }
    $launcherArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "\`"$fieldLauncher\`"")
    if ($Production) { $launcherArgs += "-Production" }
    & powershell @launcherArgs
    if ($LASTEXITCODE -ne 0) { throw "Administrator field validation failed with exit code $LASTEXITCODE." }
  }
  if ($FieldEvidenceSourceDir) {
    & npm run ops:field-import -- --source-dir $FieldEvidenceSourceDir
    if ($LASTEXITCODE -ne 0) { throw "Field evidence import failed with exit code $LASTEXITCODE." }
  }
  & npm run ops:worm-promotion
  if ($LASTEXITCODE -ne 0) { throw "WORM promotion failed with exit code $LASTEXITCODE." }
  if ($WormTargetDir) {
    & npm run ops:worm-target -- --target-dir $WormTargetDir
    if ($LASTEXITCODE -ne 0) { throw "WORM target prepare failed with exit code $LASTEXITCODE." }
  }
  & npm run ops:worm-sync
  if ($LASTEXITCODE -ne 0) { throw "WORM sync failed with exit code $LASTEXITCODE." }
  & npm run ops:field-kit
  if ($LASTEXITCODE -ne 0) { throw "Field kit refresh failed with exit code $LASTEXITCODE." }
  & npm run ops:preflight
  if ($LASTEXITCODE -ne 0) { throw "Operator preflight failed with exit code $LASTEXITCODE." }
  & npm run ag:handoff
  if ($LASTEXITCODE -ne 0) { throw "Operator handoff failed with exit code $LASTEXITCODE." }
  & npm run ops:final-gate
  $finalGateExit = $LASTEXITCODE
  & npm run ops:signoff-kit
  if ($LASTEXITCODE -ne 0) { throw "Signoff kit refresh failed with exit code $LASTEXITCODE." }
  if ($finalGateExit -ne 0 -and -not $AllowBlocked) {
    throw "Final release gate is still blocked. Rerun with -AllowBlocked only when collecting blocked evidence intentionally."
  }
} finally {
  Pop-Location
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
}
Write-Host "JARVIS final signoff flow completed. Transcript: $transcriptPath"
`;
}

function renderReadme(report) {
  return [
    '# JARVIS Final Signoff Kit',
    '',
    `Status: **${report.status}**`,
    `Final gate: ${report.summary.finalGateStatus}`,
    `Pending external validation: ${report.summary.pendingExternalValidation}`,
    `Field evidence import: ${report.summary.fieldEvidenceImportStatus}`,
    `WORM target: ${report.summary.wormTargetStatus}`,
    '',
    'Run from a normal PowerShell session. The admin field validation step will request UAC:',
    '',
    '```powershell',
    report.summary.primaryCommand,
    '```',
    '',
    'For a blocked evidence collection run, add `-AllowBlocked`.',
    '',
    'If administrator validation was completed on another machine or session, import its copied evidence folder first:',
    '',
    '```powershell',
    report.summary.fieldEvidenceImportCommand ?? 'npm run ops:field-import -- --source-dir "<field-validation-evidence-dir>"',
    '```',
    ''
  ].join('\n');
}

function renderMarkdown(report) {
  return [
    '# JARVIS Final Signoff Kit',
    '',
    `Status: **${report.status}**`,
    `Final gate: ${report.summary.finalGateStatus}`,
    `Field validation verified: ${report.summary.fieldValidationVerified ? 'yes' : 'no'}`,
    `External WORM verified: ${report.summary.wormSyncVerified ? 'yes' : 'no'}`,
    `WORM target: ${report.summary.wormTargetStatus}`,
    `Pending external validation: ${report.summary.pendingExternalValidation}`,
    `Primary command: \`${report.summary.primaryCommand}\``,
    `Field evidence import: \`${report.summary.fieldEvidenceImportCommand ?? 'not required'}\``,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Pending Validation',
    '',
    ...(report.pendingValidation.length > 0
      ? report.pendingValidation.map((item) => `- ${item.id}: ${item.status}`)
      : ['- none']),
    '',
    '## Operator Actions',
    '',
    ...(report.operatorActions.length > 0
      ? report.operatorActions.map((item) => `- ${item.actionId}: \`${item.command}\``)
      : ['- none']),
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--output-dir') args.outputDir = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFinalSignoffKit(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Final Signoff Kit');
  console.log(`Status: ${report.status}`);
  console.log(`Final gate: ${report.summary.finalGateStatus}`);
  console.log(`Primary command: ${report.summary.primaryCommand}`);
  console.log('Reports: dist/final-signoff-kit-report.json, dist/final-signoff-kit-report.md');
  if (report.status === 'blocked-missing-final-gate') process.exitCode = 1;
}
