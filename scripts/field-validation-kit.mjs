import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultDistDir = 'dist';
const defaultOutputDir = 'dist/field-validation-kit';
const defaultEvidenceDir = 'dist/field-validation';
const defaultJsonPath = 'dist/field-validation-kit-report.json';
const defaultMarkdownPath = 'dist/field-validation-kit-report.md';

const requiredScripts = [
  {
    id: 'core-install-all',
    path: 'core-service-package/install-all.ps1',
    label: 'A Core install, verify, and smoke'
  },
  {
    id: 'core-installed-soak',
    path: 'core-service-package/run-installed-service-soak.ps1',
    label: 'A Core installed service soak'
  },
  {
    id: 'pc-agent-install-release',
    path: 'pc-agent-installer/install-verify-release.ps1',
    label: 'B PC Agent install and release verification'
  }
];

const coreEvidenceFiles = [
  'package-manifest.json',
  'installed-service-verification.json',
  'installed-service-smoke.json',
  'installed-service-soak.json'
];

const pcEvidenceFiles = [
  'package-manifest.json',
  'service-smoke-report.json',
  'install-release-report.json',
  'release-gate-report.json',
  'release-evidence.json',
  'signature-verification-report.json',
  'tray-state.json'
];

function normalizePath(path) {
  return path.split(sep).join('/');
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
    return JSON.parse(stripBom(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

function stripBom(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function statusFromReport(report) {
  return String(report?.status ?? '').toLowerCase();
}

function isPassedStatus(status) {
  return ['passed', 'passed-with-warnings', 'ready', 'ready-with-warnings', 'verified'].includes(status);
}

async function evidenceRecord({ id, label, fileName, evidenceDir, packageDir }) {
  const evidencePath = join(evidenceDir, fileName);
  const packagePath = join(packageDir, fileName);
  const path = await exists(evidencePath) ? evidencePath : packagePath;
  const present = await exists(path);
  const report = present ? await readJson(path) : null;
  const status = statusFromReport(report);
  return {
    id,
    label,
    fileName,
    present,
    path: normalizePath(relative(process.cwd(), path)),
    sha256: present ? await sha256File(path) : null,
    status: status || (present ? 'present' : 'missing'),
    passed: present && (status ? isPassedStatus(status) : true)
  };
}

function summarizeEvidence(records, requiredFileNames) {
  const required = records.filter((record) => requiredFileNames.includes(record.fileName));
  if (required.every((record) => record.passed)) return 'verified';
  if (required.some((record) => record.present)) return 'partial';
  return 'pending-field-validation';
}

export async function runFieldValidationKit({
  workspaceRoot = process.cwd(),
  distDir = join(workspaceRoot, defaultDistDir),
  outputDir = join(workspaceRoot, defaultOutputDir),
  evidenceDir = join(workspaceRoot, defaultEvidenceDir),
  jsonPath = join(workspaceRoot, defaultJsonPath),
  markdownPath = join(workspaceRoot, defaultMarkdownPath),
  workflowPath = join(workspaceRoot, '.github/workflows/product-evidence.yml')
} = {}) {
  const distRoot = resolve(distDir);
  const kitRoot = resolve(outputDir);
  const evidenceRoot = resolve(evidenceDir);
  const corePackageDir = join(distRoot, 'core-service-package');
  const pcPackageDir = join(distRoot, 'pc-agent-installer');
  const wormManifest = await readJson(join(distRoot, 'worm-promotion/manifest.json'));
  const externalWormSyncProof = await readJson(join(distRoot, 'worm-promotion/external-sync-proof.json'));
  const handoff = await readJson(join(distRoot, 'ag-operator-handoff.json'));
  const adminAttempts = await readJson(join(distRoot, 'windows-admin-install-attempts.json'));
  const fieldRunSummaryPath = join(evidenceRoot, 'field-validation-run-summary.json');
  const fieldRunSummaryPresent = await exists(fieldRunSummaryPath);
  const fieldRunSummary = fieldRunSummaryPresent ? await readJson(fieldRunSummaryPath) : null;
  const fieldRunStatus = statusFromReport(fieldRunSummary) || (fieldRunSummaryPresent ? 'present' : 'missing');

  await mkdir(kitRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(join(evidenceRoot, 'core'), { recursive: true });
  await mkdir(join(evidenceRoot, 'pc-agent'), { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  const scriptChecks = [];
  for (const script of requiredScripts) {
    const absolutePath = join(distRoot, script.path);
    scriptChecks.push({
      ...script,
      absolutePath: resolve(absolutePath),
      exists: await exists(absolutePath),
      sha256: await exists(absolutePath) ? await sha256File(absolutePath) : null
    });
  }

  const workflowExists = await exists(workflowPath);
  const coreEvidence = [];
  for (const fileName of coreEvidenceFiles) {
    coreEvidence.push(await evidenceRecord({
      id: `core-${fileName}`,
      label: `Core ${fileName}`,
      fileName,
      evidenceDir: join(evidenceRoot, 'core'),
      packageDir: corePackageDir
    }));
  }
  const pcEvidence = [];
  for (const fileName of pcEvidenceFiles) {
    pcEvidence.push(await evidenceRecord({
      id: `pc-agent-${fileName}`,
      label: `PC Agent ${fileName}`,
      fileName,
      evidenceDir: join(evidenceRoot, 'pc-agent'),
      packageDir: pcPackageDir
    }));
  }

  const coreStatus = summarizeEvidence(coreEvidence, [
    'installed-service-verification.json',
    'installed-service-smoke.json',
    'installed-service-soak.json'
  ]);
  const pcStatus = summarizeEvidence(pcEvidence, [
    'service-smoke-report.json',
    'install-release-report.json',
    'release-evidence.json'
  ]);
  const scriptsReady = scriptChecks.every((check) => check.exists);
  const workflowReady = workflowExists;
  const wormReady = wormManifest?.status === 'ready-for-external-worm-promotion';
  const adminAttemptsStatus = adminAttempts?.status ?? 'missing';
  const fieldRunVerified = fieldRunStatus === 'passed';
  const evidenceVerified = coreStatus === 'verified' && pcStatus === 'verified' && fieldRunVerified;
  const status = scriptsReady && workflowReady
    ? evidenceVerified
      ? 'field-evidence-verified'
      : 'ready-for-field-validation'
    : 'blocked';

  const runScriptPath = join(kitRoot, 'run-field-validation.ps1');
  const adminLauncherPath = join(kitRoot, 'start-field-validation-admin.ps1');
  const readmePath = join(kitRoot, 'README.md');
  await writeFile(runScriptPath, renderFieldValidationPowerShell(), 'utf8');
  await writeFile(adminLauncherPath, renderAdminLauncherPowerShell(), 'utf8');

  const report = {
    reportVersion: 'ag-field-validation-kit-v1',
    generatedAt: new Date().toISOString(),
    status,
    fieldValidationKit: {
      kitRoot: resolve(kitRoot),
      evidenceRoot: resolve(evidenceRoot),
      runScript: resolve(runScriptPath),
      adminLauncher: resolve(adminLauncherPath),
      readme: resolve(readmePath),
      rawScriptBodiesStored: false,
      rawAdminTokenStored: false
    },
    checks: [
      {
        checkId: 'required_admin_scripts_present',
        passed: scriptsReady,
        detail: scriptChecks.map((check) => ({ id: check.id, exists: check.exists }))
      },
      {
        checkId: 'product_evidence_workflow_present',
        passed: workflowReady,
        detail: { workflowPath: normalizePath(relative(workspaceRoot, workflowPath)) }
      },
      {
        checkId: 'worm_local_staging_ready',
        passed: wormReady,
        detail: { status: wormManifest?.status ?? 'missing', bundleHash: wormManifest?.bundleHash ?? null }
      },
      {
        checkId: 'field_run_summary_passed',
        passed: fieldRunVerified,
        detail: { status: fieldRunStatus, present: fieldRunSummaryPresent }
      },
      {
        checkId: 'core_admin_evidence_verified',
        passed: coreStatus === 'verified',
        detail: { status: coreStatus }
      },
      {
        checkId: 'pc_agent_admin_evidence_verified',
        passed: pcStatus === 'verified',
        detail: { status: pcStatus }
      }
    ],
    scriptChecks,
    coreAdminEvidence: {
      status: coreStatus,
      records: coreEvidence
    },
    pcAgentAdminEvidence: {
      status: pcStatus,
      records: pcEvidence
    },
    wormPromotion: {
      status: wormManifest?.status ?? 'missing',
      bundleHash: wormManifest?.bundleHash ?? null,
      artifactCount: wormManifest?.artifactCount ?? null,
      externalSyncStatus: externalWormSyncProof?.status ?? wormManifest?.externalSync?.status ?? 'missing',
      externalSyncProofVersion: externalWormSyncProof?.proofVersion ?? null,
      externalSyncProofPath: externalWormSyncProof ? 'dist/worm-promotion/external-sync-proof.json' : null
    },
    handoff: {
      status: handoff?.status ?? 'missing',
      externalValidationPending: handoff?.summary?.externalValidationPending ?? null
    },
    fieldRunSummary: {
      status: fieldRunStatus,
      present: fieldRunSummaryPresent,
      path: normalizePath(relative(workspaceRoot, fieldRunSummaryPath)),
      sha256: fieldRunSummaryPresent ? await sha256File(fieldRunSummaryPath) : null,
      generatedAt: fieldRunSummary?.generatedAt ?? null,
      stepCount: Array.isArray(fieldRunSummary?.steps) ? fieldRunSummary.steps.length : 0,
      transcriptPath: fieldRunSummary?.transcriptPath ?? null
    },
    windowsAdminInstallAttempts: {
      status: adminAttemptsStatus,
      elevated: adminAttempts?.elevated ?? null
    },
    nextActions: buildNextActions({ coreStatus, pcStatus, wormReady, fieldRunStatus })
  };

  await writeFile(readmePath, renderReadme(report), 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildNextActions({ coreStatus, pcStatus, wormReady, fieldRunStatus }) {
  const actions = [];
  if (coreStatus !== 'verified' || pcStatus !== 'verified' || fieldRunStatus !== 'passed') {
    actions.push('Run dist/field-validation-kit/start-field-validation-admin.ps1 from PowerShell, or run run-field-validation.ps1 inside Administrator PowerShell.');
  }
  if (!wormReady) {
    actions.push('Run npm run product:evidence, then npm run ops:worm-promotion before final handoff.');
  }
  actions.push('Run npm run ops:field-kit, then npm run ag:handoff to refresh operator evidence.');
  return actions;
}

function renderFieldValidationPowerShell() {
  return `# Generated by JARVIS field validation kit.
param(
  [string]$EvidenceDir,
  [switch]$Production
)
$ErrorActionPreference = "Stop"
$kitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Split-Path -Parent $kitRoot
$workspaceRoot = Split-Path -Parent $distRoot
if ([string]::IsNullOrWhiteSpace($EvidenceDir)) {
  $EvidenceDir = Join-Path $distRoot "field-validation"
}
$coreRoot = Join-Path $distRoot "core-service-package"
$pcRoot = Join-Path $distRoot "pc-agent-installer"
$coreEvidenceRoot = Join-Path $EvidenceDir "core"
$pcEvidenceRoot = Join-Path $EvidenceDir "pc-agent"
$transcriptRoot = Join-Path $EvidenceDir "transcripts"
New-Item -ItemType Directory -Force -Path $coreEvidenceRoot | Out-Null
New-Item -ItemType Directory -Force -Path $pcEvidenceRoot | Out-Null
New-Item -ItemType Directory -Force -Path $transcriptRoot | Out-Null
$script:transcriptPath = Join-Path $transcriptRoot ("field-validation-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$script:transcriptStarted = $false
$steps = @()
function Add-Step($id, $status, $detail) {
  $script:steps += [pscustomobject]@{ id = $id; status = $status; detail = $detail }
}
function Write-Summary($status) {
  $summary = [pscustomobject]@{
    reportVersion = "ag-field-validation-run-v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = $status
    workspaceRoot = $workspaceRoot
    evidenceDir = $EvidenceDir
    transcriptPath = $script:transcriptPath
    steps = $script:steps
  }
  $summaryPath = Join-Path $EvidenceDir "field-validation-run-summary.json"
  $summary | ConvertTo-Json -Depth 12 | Set-Content -Path $summaryPath -Encoding UTF8
  Write-Host "Wrote $summaryPath"
}
function Invoke-FieldScript($id, $scriptPath, $arguments = @()) {
  if (-not (Test-Path $scriptPath)) {
    Add-Step $id "fail" @{ script = $scriptPath; message = "Missing script." }
    throw "Missing field validation script: $scriptPath"
  }
  try {
    & $scriptPath @arguments
    Add-Step $id "pass" @{ script = $scriptPath }
  } catch {
    Add-Step $id "fail" @{ script = $scriptPath; message = $_.Exception.Message }
    throw
  }
}
function Copy-Evidence($id, $sourceRoot, $targetRoot, $names) {
  foreach ($name in $names) {
    $source = Join-Path $sourceRoot $name
    if (Test-Path $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $targetRoot $name) -Force
      Add-Step "$id-$name" "pass" @{ source = $source; target = (Join-Path $targetRoot $name) }
    } else {
      Add-Step "$id-$name" "warning" @{ source = $source; message = "Evidence file not present yet." }
    }
  }
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
try {
  Start-Transcript -Path $script:transcriptPath -Force | Out-Null
  $script:transcriptStarted = $true
} catch {
  Add-Step "transcript-start" "warning" @{ message = $_.Exception.Message; path = $script:transcriptPath }
}
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Add-Step "administrator-shell" "fail" @{ message = "Administrator PowerShell is required." }
  Write-Summary "blocked-non-admin"
  throw "Administrator PowerShell is required for JARVIS field validation."
}
Add-Step "administrator-shell" "pass" @{ message = "Administrator shell is available." }
try {
  Invoke-FieldScript "core-install-all" (Join-Path $coreRoot "install-all.ps1")
  Invoke-FieldScript "core-installed-soak" (Join-Path $coreRoot "run-installed-service-soak.ps1")
  $pcArgs = $(if ($Production) { @("-Production") } else { @() })
  Invoke-FieldScript "pc-agent-install-release" (Join-Path $pcRoot "install-verify-release.ps1") $pcArgs
  Copy-Evidence "core" $coreRoot $coreEvidenceRoot @(
    "package-manifest.json",
    "installed-service-verification.json",
    "installed-service-smoke.json",
    "installed-service-soak.json"
  )
  Copy-Evidence "pc-agent" $pcRoot $pcEvidenceRoot @(
    "package-manifest.json",
    "service-smoke-report.json",
    "install-release-report.json",
    "release-gate-report.json",
    "release-evidence.json",
    "signature-verification-report.json",
    "tray-state.json"
  )
  Write-Summary "passed"
  Write-Host "JARVIS field validation completed. Run npm run ops:field-kit and npm run ag:handoff to refresh reports."
} catch {
  Write-Summary "failed"
  throw
} finally {
  if ($script:transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
}
`;
}

function renderAdminLauncherPowerShell() {
  return `# Generated by JARVIS field validation kit.
param(
  [switch]$Production
)
$ErrorActionPreference = "Stop"
$kitRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Split-Path -Parent $kitRoot
$workspaceRoot = Split-Path -Parent $distRoot
$runScript = Join-Path $kitRoot "run-field-validation.ps1"
if (-not (Test-Path $runScript)) {
  throw "Missing field validation run script: $runScript"
}
$argumentList = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "\`"$runScript\`""
)
if ($Production) { $argumentList += "-Production" }
Write-Host "Requesting Administrator approval for JARVIS field validation..."
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -Verb RunAs -Wait -PassThru
if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
  throw "JARVIS field validation exited with code $($process.ExitCode)."
}
Push-Location $workspaceRoot
try {
  & npm run ops:field-kit
  & npm run ag:handoff
} finally {
  Pop-Location
}
Write-Host "JARVIS field validation reports refreshed."
`;
}

function renderReadme(report) {
  return [
    '# JARVIS Field Validation Kit',
    '',
    `Status: **${report.status}**`,
    '',
    'Run this from Administrator PowerShell on the target Windows machine:',
    '',
    '```powershell',
    'powershell -NoProfile -ExecutionPolicy Bypass -File dist/field-validation-kit/run-field-validation.ps1',
    '```',
    '',
    'Or launch the UAC prompt from a normal PowerShell session:',
    '',
    '```powershell',
    'powershell -NoProfile -ExecutionPolicy Bypass -File dist/field-validation-kit/start-field-validation-admin.ps1',
    '```',
    '',
    'Then refresh the local evidence reports:',
    '',
    '```powershell',
    'npm run ops:field-kit',
    'npm run ag:handoff',
    '```',
    '',
    'Evidence is copied into `dist/field-validation/` and summarized by `dist/field-validation-kit-report.json`.',
    ''
  ].join('\n');
}

function renderMarkdown(report) {
  return [
    '# JARVIS Field Validation Kit',
    '',
    `Status: **${report.status}**`,
    `Core admin evidence: ${report.coreAdminEvidence.status}`,
    `PC Agent admin evidence: ${report.pcAgentAdminEvidence.status}`,
    `WORM staging: ${report.wormPromotion.status}`,
    `External WORM sync: ${report.wormPromotion.externalSyncStatus}`,
    `Run script: \`${normalizePath(relative(process.cwd(), report.fieldValidationKit.runScript))}\``,
    `Admin launcher: \`${normalizePath(relative(process.cwd(), report.fieldValidationKit.adminLauncher))}\``,
    `Field run summary: ${report.fieldRunSummary.status}`,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.passed ? 'yes' : 'no'} |`),
    '',
    '## Required Scripts',
    '',
    '| Script | Exists | SHA-256 |',
    '| --- | --- | --- |',
    ...report.scriptChecks.map((check) => `| ${check.path} | ${check.exists ? 'yes' : 'no'} | ${check.sha256 ?? 'missing'} |`),
    '',
    '## Next Actions',
    '',
    ...report.nextActions.map((action) => `- ${action}`),
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dist-dir') args.distDir = argv[++index];
    else if (arg === '--output-dir' || arg === '--output') args.outputDir = argv[++index];
    else if (arg === '--evidence-dir') args.evidenceDir = argv[++index];
    else if (arg === '--json') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--workflow') args.workflowPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFieldValidationKit(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Field Validation Kit');
  console.log(`Status: ${report.status}`);
  console.log(`Core admin evidence: ${report.coreAdminEvidence.status}`);
  console.log(`PC Agent admin evidence: ${report.pcAgentAdminEvidence.status}`);
  console.log(`WORM staging: ${report.wormPromotion.status}`);
  console.log('Reports: dist/field-validation-kit-report.json, dist/field-validation-kit-report.md');
  if (report.status === 'blocked') process.exitCode = 1;
}
