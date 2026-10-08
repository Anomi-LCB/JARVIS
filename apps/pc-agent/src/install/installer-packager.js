import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve,relative,isAbsolute } from 'node:path';
import { createServicePlan, serviceRecoveryCommands } from './service-planner.js';
import { createTrayState } from './tray-runtime.js';
import { renderTrayAgentXaml } from './tray-wpf-xaml.js';
import { createJarvisBrandIcon } from './brand-icon.js';
import {readControlCenterUiPayload} from './control-center-ui-payload.js';
import {readControlCenterHostPayload} from './control-center-host-payload.js';
import {readBundledNodeRuntime,renderVerifiedNodeRuntimeSource} from './bundled-node-runtime.js';
import {renderTransactionalPcUpdateScript,renderVersionInstallScript} from './transactional-update.js';
import {renderInstallFolderSelector} from './install-folder-selector.js';
import {renderNsisFileLayout} from './nsis-file-layout.js';
import {renderInstallationPreflightScript} from './installation-preflight.js';
import {readPcAgentRuntimePayload} from './pc-agent-runtime-payload.js';
import {
  renderProfessionalTrayAgentSource,
  renderProfessionalTrayBuildScript
} from './tray-wpf-source.js';

const derivedReleaseArtifactNames = Object.freeze([
  'JarvisPcAgentTray.exe',
  'JarvisPcAgentServiceHost.exe',
  'runtime-integrity.psd1',
  'JARVIS-PC-Agent-Setup.exe',
  'signature-report.json',
  'signature-verification-report.json',
  'production-signing-report.json',
  'release-gate-report.json',
  'release-evidence.json',
  'install-release-report.json'
]);

const webViewAssets = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Wpf.dll', 'WebView2Loader.dll'];
function readWebViewAssets() {
  return Object.fromEntries([
    ...webViewAssets.map(name => [name, readFileSync(new URL(`../../vendor/webview2/${name}`, import.meta.url))]),
    ['WebView2-LICENSE.txt', readFileSync(new URL('../../vendor/webview2/LICENSE.txt', import.meta.url))],
    ['WebView2-provenance.json', readFileSync(new URL('../../vendor/webview2/provenance.json', import.meta.url))]
  ]);
}

export function createInstallerPackagePlan({
  daemonConfig,
  serviceManifest,
  cwd = process.cwd(),
  outputDir = 'dist/pc-agent-installer',
  signed = false,
  bundledNodeRuntime = null,
  pcAgentStateRoot = null,
  generatedAt = new Date().toISOString()
}) {
  const installPlan = createServicePlan({ action: 'install', daemonConfig, serviceManifest, cwd, execute: false });
  const statusPlan = createServicePlan({ action: 'status', daemonConfig, serviceManifest, cwd, execute: false });
  const uninstallPlan = createServicePlan({ action: 'uninstall', daemonConfig, serviceManifest, cwd, execute: false });
  const updatePlan = createServicePlan({ action: 'update', daemonConfig, serviceManifest, cwd, execute: false });
  const startPlan = createServicePlan({ action: 'start', daemonConfig, serviceManifest, cwd, execute: false });
  const stopPlan = createServicePlan({ action: 'stop', daemonConfig, serviceManifest, cwd, execute: false });
  const restartPlan = createServicePlan({ action: 'restart', daemonConfig, serviceManifest, cwd, execute: false });
  const resolvedOutputDir = resolve(cwd, outputDir);
  const serviceHostExe = 'JarvisPcAgentServiceHost.exe';
  const trayState = createTrayState({
    daemonConfig,
    serviceManifest,
    clock: () => new Date(generatedAt),
    service: { status: 'stopped' },
    health: { status: 'offline' },
    warnings: ['설치 패키지가 시험 실행 모드로 생성되었습니다.']
  });
  const trayAgentXaml = renderTrayAgentXaml();
  const trayAgentXamlSha256 = createHash('sha256').update(trayAgentXaml).digest('hex');
  const nodeBundle = readBundledNodeRuntime(bundledNodeRuntime);
  if(pcAgentStateRoot!==null&&!isAbsolute(pcAgentStateRoot))throw new Error('PC_AGENT_STATE_ROOT_ABSOLUTE_REQUIRED');
  const stateRoot = resolve(pcAgentStateRoot ?? cwd);
  const stateRelative=relative(resolvedOutputDir,stateRoot);
  if(!stateRelative||(!stateRelative.startsWith('..\\')&&!stateRelative.startsWith('../')&&stateRelative!=='..'&&!isAbsolute(stateRelative)))throw new Error('PC_AGENT_STATE_ROOT_IS_CODE');
  const uiPayload=readControlCenterUiPayload(),hostPayload=readControlCenterHostPayload(),pcPayload=readPcAgentRuntimePayload({daemonConfig,serviceManifest});
  const releaseId=createHash('sha256').update(JSON.stringify({serviceName:serviceManifest.serviceName,stateRoot,builderRoot:resolve(cwd),logicalPackageRoot:resolvedOutputDir,nodeExecutable:nodeBundle.sha256?null:process.execPath,daemonConfig,serviceManifest,nodeSha:nodeBundle.sha256,trayXamlSha256:trayAgentXamlSha256,files:createFileIntegrityManifest({...uiPayload,...hostPayload,...pcPayload})})).digest('hex');
  const baseFiles = {
    ...uiPayload,
    ...hostPayload,
    ...nodeBundle.files,
    ...pcPayload,
    'service-host.cs': renderPcAgentServiceHostSource({ installPlan, nodeExecutable: process.execPath, cwd:stateRoot, originalCwd:cwd, bundledNodeSha256:nodeBundle.sha256,
      runtimeLauncherSha256:createHash('sha256').update(pcPayload['pc-agent-runtime/launch.mjs']).digest('hex') }),
    'build-service-host.ps1': renderBuildServiceHostScript({ serviceHostExe }),
    'install-service.ps1': renderInstallServiceScript({ installPlan, serviceManifest, serviceHostExe }),
    'select-install-folder.ps1': renderInstallFolderSelector(),
    'installation-preflight.ps1': renderInstallationPreflightScript(),
    'uninstall-service.ps1': renderPowerShellScript({
      title: 'JARVIS PC 에이전트 서비스 제거',
      commands: [
        '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
        `$current = Get-CimInstance Win32_Service -Filter "Name='${serviceManifest.serviceName}'"`,
        '$ownedPath = \'"\' + (Join-Path $root "JarvisPcAgentServiceHost.exe") + \'"\'',
        'if ($null -ne $current -and $current.PathName -ne $ownedPath) {throw "PC_UNINSTALL_OTHER_VERSION_ACTIVE"}',
        ...uninstallPlan.commands
      ],
      requiresAdmin: true
    }),
    'status-service.ps1': renderPowerShellScript({
      title: 'JARVIS PC 에이전트 서비스 상태 확인',
      commands: statusPlan.commands,
      requiresAdmin: false
    }),
    'start-service.ps1': renderPowerShellScript({
      title: 'JARVIS PC 에이전트 서비스 시작',
      commands: startPlan.commands,
      requiresAdmin: true
    }),
    'stop-service.ps1': renderPowerShellScript({
      title: 'JARVIS PC 에이전트 서비스 중지',
      commands: stopPlan.commands,
      requiresAdmin: true
    }),
    'restart-service.ps1': renderPowerShellScript({
      title: 'JARVIS PC 에이전트 서비스 다시 시작',
      commands: restartPlan.commands,
      requiresAdmin: true
    }),
    'update-service.ps1': renderUpdateScript({ updatePlan, statusPlan, serviceManifest, serviceHostExe }),
    'collect-logs.ps1': renderCollectLogsScript({
      daemonConfig,
      outputDir: resolvedOutputDir,
      cwd:stateRoot,
      endpoint: installPlan.endpoint,
      serviceName: serviceManifest.serviceName
    }),
    'verify-package.ps1': renderVerifyPackageScript(),
    'verify-installed-service.ps1': renderVerifyInstalledServiceScript({ daemonConfig, serviceManifest, endpoint: installPlan.endpoint, cwd:stateRoot }),
    'install-all.ps1': renderVersionInstallScript({serviceName:serviceManifest.serviceName}),
    'install-verify-release.ps1': renderInstallVerifyReleaseScript(),
    'sign-artifacts.ps1': renderSignArtifactsScript(),
    'verify-signatures.ps1': renderVerifySignaturesScript(),
    'production-signing-policy.json': renderProductionSigningPolicy({ serviceManifest }),
    'verify-production-signing.ps1': renderVerifyProductionSigningScript(),
    'create-dev-signing-cert.ps1': renderCreateDevSigningCertScript(),
    'trust-dev-signing-cert.ps1': renderTrustDevSigningCertScript(),
    'untrust-dev-signing-cert.ps1': renderUntrustDevSigningCertScript(),
    'verify-release-gate.ps1': renderVerifyReleaseGateScript(),
    'build-release-evidence.ps1': renderBuildReleaseEvidenceScript(),
    'installer.nsi': '',
    'build-nsis-installer.ps1': renderBuildNsisInstallerScript(),
    'release-manifest.json': renderReleaseManifest({ serviceManifest }),
    'tray-agent.ps1': renderTrayAgentScript({ endpoint: installPlan.endpoint }),
    'tray-agent.xaml': trayAgentXaml,
    'jarvis.ico': createJarvisBrandIcon(),
    ...readWebViewAssets(),
    'tray-agent.cs': renderProfessionalTrayAgentSource({
      endpoint: installPlan.endpoint,
      serviceName: serviceManifest.serviceName,
      displayName: serviceManifest.displayName,
      xamlSha256: trayAgentXamlSha256,
      bundledNodeSha256:nodeBundle.sha256
    }),
    'launch-tray.ps1': renderLaunchTrayScript(),
    'build-tray-exe.ps1': renderProfessionalTrayBuildScript(),
    'install-tray-shortcut.ps1': renderInstallTrayShortcutScript(),
    'uninstall-tray-shortcut.ps1': renderUninstallTrayShortcutScript(),
    'tray-state.json': JSON.stringify(trayState, null, 2),
    'README-install.md': renderInstallReadme({ serviceManifest, installPlan, signed }) + '\n\n## 설치본 제어 센터 화면 서버\n\nPC 프로그램의 제어 센터 또는 기능별 열기·조절을 누르면 기본 주소 http://127.0.0.1:41730 의 화면 서버를 확인하고 필요하면 설치본 서버를 준비합니다. 이미 실행 중인 제어 센터는 재사용하며 다른 프로그램의 포트는 변경하지 않습니다. 직접 시작한 서버는 PC 프로그램 종료 시 함께 정리합니다. Node.js 24 이상이 필요하며, 포함형 패키지는 검증된 runtime/node.exe를 사용하고 외부형은 설치에 사용한 절대 실행 경로를 사용합니다. 화면과 서버 모듈은 이 설치 폴더에서 읽습니다. Core·PC·Bridge 서비스와 서버 측 인증 설정은 별도로 준비해야 합니다. 로그인 시 무조건 자동 시작하는 방식은 활성화하지 않습니다. 파일 해시 검사는 배포 서명 인증을 대체하지 않습니다. 수동 진단은 `node control-center-host/launch.mjs`로 할 수 있습니다.\n'
  };
  baseFiles['README-install.md'] += '\n## 설치본 Core의 격리 실행\n\n최신 Core 코드와 검증 자료도 pc-agent-runtime에 포함됩니다. 개발 저장소 없이 실행하려면 JARVIS_CORE_STATE_ROOT에 설치 폴더 밖의 별도 절대 데이터 경로를 지정하고, JARVIS_CORE_ADMIN_TOKEN 또는 기존 토큰 해시 설정 및 허용 작업 경로를 준비한 뒤 포함된 Node.js로 pc-agent-runtime/core-launch.mjs를 실행합니다. 실행 주소는 127.0.0.1로 제한됩니다. Core와 PC 실행기의 포트는 서로 다르게 지정해야 합니다. 이 경로는 기존 Windows 서비스 등록이나 실행 권위 이전을 자동으로 수행하지 않습니다. 기존 Core와 동시에 같은 데이터 폴더를 사용하지 마세요. 제어 센터 서버에는 해당 Core 주소와 서버 측 인증 설정을 연결합니다. 토큰은 화면이나 대화에 입력하지 않고 보호된 서비스 설정에서 관리합니다. 복원 시 코드 패키지는 이전 버전으로 되돌리되 별도 데이터 폴더를 덮어쓰지 않습니다.\n';
  const distributionFiles=[...Object.keys(baseFiles),'package-manifest.json','JarvisPcAgentTray.exe','JarvisPcAgentServiceHost.exe'];
  const optionalDistributionFiles=['runtime-integrity.psd1','signature-report.json','signature-verification-report.json','production-signing-report.json','release-gate-report.json'];
  baseFiles['installer.nsi']=renderNsisInstallerScript({serviceManifest,releaseId,distributionFiles,optionalDistributionFiles});
  for (const [fileName, content] of Object.entries(baseFiles)) {
    // Generated scripts need a BOM for Windows PowerShell. Reviewed source
    // payload Buffers must remain byte-for-byte identical to their pinned hashes.
    if (typeof content === 'string' && /\.(?:ps1|cs|nsi)$/i.test(fileName)) {
      baseFiles[fileName] = withUtf8Bom(content);
    }
  }
  const fileIntegrity = createFileIntegrityManifest(baseFiles);
  const manifest = {
    packageId: 'jarvis-pc-agent-windows-service',
    serviceName: serviceManifest.serviceName,
    displayName: serviceManifest.displayName,
    version: '1.0.0',
    platform: 'win32',
    architecture: 'x64',
    signed,
    signatureStatus: signed ? 'signed-local-dev-digest' : 'unsigned-local-build',
    signature: signPackageManifest({ fileIntegrity, serviceName: serviceManifest.serviceName, version: '1.0.0' }),
    endpoint: installPlan.endpoint,
    serviceHostExecutable: serviceHostExe,
    nodeExecutable: process.execPath,
    bundledNodeRuntime:nodeBundle.sha256?{path:'runtime/node.exe',sha256:nodeBundle.sha256}:null,
    runtimeEntry:'pc-agent-runtime/launch.mjs',
    releaseLayout:{id:releaseId,versionedCode:true,root:'ProgramFiles64/JARVIS/PC-Agent/releases',stateMoved:false},
    distribution:{mode:'exact-reviewed-file-list',requiredFiles:distributionFiles,optionalFiles:optionalDistributionFiles,unlistedFilesIncluded:false,requiredBeforeServiceInstall:['runtime-integrity.psd1'],signaturesRequiredBeforeServiceInstall:true},
    optionalRuntimeDependencies:{bundled:['nodemailer@6.9.14'],notBundled:['exceljs','playwright'],externalAccountsAutomaticallyConnected:false},
    runtimeState:{root:stateRoot,mode:pcAgentStateRoot===null?'legacy-preserved':'explicit',migrationAutomaticallyPerformed:false},
    localOnly: installPlan.localOnly,
    outputDir: resolvedOutputDir,
    files: [
      'service-host.cs',
      'build-service-host.ps1',
      'install-service.ps1',
      'select-install-folder.ps1',
      'installation-preflight.ps1',
      'uninstall-service.ps1',
      'status-service.ps1',
      'start-service.ps1',
      'stop-service.ps1',
      'restart-service.ps1',
      'update-service.ps1',
      'collect-logs.ps1',
      'verify-package.ps1',
      'verify-installed-service.ps1',
      'install-all.ps1',
      'install-verify-release.ps1',
      'sign-artifacts.ps1',
      'verify-signatures.ps1',
      'production-signing-policy.json',
      'verify-production-signing.ps1',
      'create-dev-signing-cert.ps1',
      'trust-dev-signing-cert.ps1',
      'untrust-dev-signing-cert.ps1',
      'verify-release-gate.ps1',
      'build-release-evidence.ps1',
      'installer.nsi',
      'build-nsis-installer.ps1',
      'release-manifest.json',
      'tray-agent.ps1',
      'tray-agent.xaml',
      'jarvis.ico',
      ...webViewAssets,
      'WebView2-LICENSE.txt',
      'WebView2-provenance.json',
      'tray-agent.cs',
      'launch-tray.ps1',
      'build-tray-exe.ps1',
      'install-tray-shortcut.ps1',
      'uninstall-tray-shortcut.ps1',
      'tray-state.json',
      'package-manifest.json',
      'README-install.md',
      ...Object.keys(baseFiles).filter(name=>name.startsWith('control-center-ui/')||name.startsWith('control-center-host/')||name.startsWith('runtime/')||name.startsWith('pc-agent-runtime/'))
    ],
    fileIntegrity,
    safety: {
      ...installPlan.safety,
      dryRunDefault: true,
      executeRequiresAdminShell: true,
      bindsTo: daemonConfig.host
    },
    generatedAt
  };
  const files = {
    ...baseFiles,
    'package-manifest.json': JSON.stringify(manifest, null, 2)
  };
  return {
    manifest,
    outputDir: resolvedOutputDir,
    installPlan,
    statusPlan,
    uninstallPlan,
    updatePlan,
    startPlan,
    stopPlan,
    restartPlan,
    trayState,
    files
  };
}

export async function writeInstallerPackage(options) {
  const { writeOutputDir = null, ...planOptions } = options;
  const cwd = options.cwd ?? process.cwd();
  const logicalOutputDir = resolve(cwd, options.outputDir ?? 'dist/pc-agent-installer');
  const physicalOutputDir = writeOutputDir
    ? resolve(cwd, writeOutputDir)
    : logicalOutputDir;
  await mkdir(physicalOutputDir, { recursive: true });
  let previousManifest = null;
  try {
    previousManifest = JSON.parse(await readFile(resolve(physicalOutputDir, 'package-manifest.json'), 'utf8'));
  } catch {
    previousManifest = null;
  }

  const previousGeneratedAt = typeof previousManifest?.generatedAt === 'string'
    ? previousManifest.generatedAt
    : null;
  let plan = createInstallerPackagePlan({
    ...planOptions,
    generatedAt: previousGeneratedAt ?? new Date().toISOString()
  });
  const sourcePackageUnchanged = previousManifest !== null
    && JSON.stringify(previousManifest) === JSON.stringify(plan.manifest);
  if (previousManifest !== null && !sourcePackageUnchanged) {
    plan = createInstallerPackagePlan({
      ...planOptions,
      generatedAt: new Date().toISOString()
    });
  }

  const derivedArtifactsStale = previousManifest && !sourcePackageUnchanged
    ? await findExistingDerivedReleaseArtifacts(physicalOutputDir)
    : [];
  const written = [];
  for (const [fileName, content] of Object.entries(plan.files)) {
    const path = resolve(physicalOutputDir, fileName);
    await mkdir(resolve(path,'..'),{recursive:true});
    await writeFile(path, content, 'utf8');
    written.push(path);
  }
  return {
    success: true,
    packageId: plan.manifest.packageId,
    outputDir: physicalOutputDir,
    logicalOutputDir: plan.outputDir,
    files: written,
    manifest: plan.manifest,
    trayState: plan.trayState,
    sourcePackageChanged: previousManifest !== null && !sourcePackageUnchanged,
    derivedArtifactsStale
  };
}

async function findExistingDerivedReleaseArtifacts(outputDir) {
  const existing = [];
  for (const fileName of derivedReleaseArtifactNames) {
    try {
      const entry = await stat(resolve(outputDir, fileName));
      if (entry.isFile()) existing.push(fileName);
    } catch {
      // Missing derived artifacts are already fail-closed by the release verifier.
    }
  }
  return existing;
}

function renderPowerShellScript({ title, commands, requiresAdmin }) {
  const guard = requiresAdmin
    ? [
        '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
        'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
        '  throw "이 작업에는 관리자 권한 PowerShell이 필요합니다."',
        '}'
      ]
    : [];
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    `$ErrorActionPreference = "Stop"`,
    `Write-Host "${title}"`,
    ...guard,
    ...commands
  ].join('\n');
}

function renderInstallServiceScript({ installPlan, serviceManifest, serviceHostExe }) {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "JARVIS PC 에이전트 서비스 설치"',
    '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
    '  throw "이 작업에는 관리자 권한 PowerShell이 필요합니다."',
    '}',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `$serviceName = "${serviceManifest.serviceName}"`,
    `$displayName = "${serviceManifest.displayName}"`,
    `$description = "${serviceManifest.description}"`,
    `$startType = "${serviceManifest.startType}"`,
    ...scConfigHelperLines(),
    `$serviceHost = Join-Path $root "${serviceHostExe}"`,
    'if (-not (Test-Path -LiteralPath $serviceHost -PathType Leaf)) { throw "서명된 서비스 호스트가 없습니다. 릴리스 빌드 및 서명 절차를 먼저 실행하세요: $serviceHost" }',
    '& (Join-Path $root "verify-package.ps1")',
    '$binaryPathName = "\`"" + $serviceHost + "\`""',
    '$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue',
    'if ($null -ne $existingService) {',
    '  & (Join-Path $root "update-service.ps1")',
    '  return',
    '}',
    'New-Service -Name $serviceName -DisplayName $displayName -Description $description -StartupType $startType -BinaryPathName $binaryPathName',
    'Set-Service -Name $serviceName -StartupType $startType',
    ...serviceRecoveryCommands({ serviceName: serviceManifest.serviceName, recovery: serviceManifest.recovery }),
    'Write-Host "JARVIS PC 에이전트 서비스를 설치하거나 업데이트했습니다."'
  ].join('\n');
}

function renderUpdateScript({serviceManifest}) {
  return renderTransactionalPcUpdateScript({serviceName:serviceManifest.serviceName,helpers:scConfigHelperLines()});
}

function renderBuildServiceHostScript({ serviceHostExe }) {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$source = Join-Path $root "service-host.cs"',
    `$output = Join-Path $root "${serviceHostExe}"`,
    '$candidateCompilers = @(',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe")',
    ')',
    '$csc = $candidateCompilers | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $csc) { throw ".NET Framework C# 컴파일러를 찾을 수 없습니다. .NET Framework 빌드 도구 또는 csc를 지원하는 .NET SDK를 설치하세요." }',
    '& $csc /target:exe /out:$output /reference:System.ServiceProcess.dll $source',
    'if ($LASTEXITCODE -ne 0) { throw "C# 서비스 호스트 빌드에 실패했습니다. 종료 코드: $LASTEXITCODE" }',
    'if (-not (Test-Path $output)) { throw "C# 서비스 호스트 빌드가 파일을 만들지 못했습니다: $output" }',
    'Write-Host "JARVIS PC 에이전트 서비스 호스트를 빌드했습니다: $output"'
  ].join('\n');
}

function scConfigHelperLines() {
  return [
    'function Convert-ToScStartType([string]$Value) {',
    '  switch ($Value.ToLowerInvariant()) {',
    '    "automatic" { return "auto" }',
    '    "auto" { return "auto" }',
    '    "delayed-auto" { return "delayed-auto" }',
    '    "manual" { return "demand" }',
    '    "demand" { return "demand" }',
    '    "disabled" { return "disabled" }',
    '    default { throw "sc.exe에서 지원하지 않는 서비스 시작 유형입니다: $Value" }',
    '  }',
    '}',
    'function Invoke-ScConfig([string]$ServiceName, [string]$BinaryPathName, [string]$StartTypeValue) {',
    '  $scStartType = Convert-ToScStartType $StartTypeValue',
    '  $output = & sc.exe config $ServiceName binPath= $BinaryPathName start= $scStartType 2>&1',
    '  if ($LASTEXITCODE -ne 0) { throw "sc.exe 서비스 설정에 실패했습니다: $ServiceName ($LASTEXITCODE): $output" }',
    '}',
    'function Invoke-ScDescription([string]$ServiceName, [string]$Description) {',
    '  $output = & sc.exe description $ServiceName $Description 2>&1',
    '  if ($LASTEXITCODE -ne 0) { throw "sc.exe 서비스 설명 설정에 실패했습니다: $ServiceName ($LASTEXITCODE): $output" }',
    '}',
    'function Stop-ServiceIfRunning([string]$ServiceName) {',
    '  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue',
    '  if ($null -ne $service -and $service.Status -ne "Stopped") {',
    '    Stop-Service -Name $ServiceName -Force -ErrorAction Stop',
    '    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))',
    '  }',
    '}'
  ];
}

function renderPcAgentServiceHostSource({ installPlan, nodeExecutable, cwd, originalCwd=cwd, bundledNodeSha256 = null, runtimeLauncherSha256 }) {
  if(!/^[a-f0-9]{64}$/u.test(runtimeLauncherSha256??''))throw new Error('PC_RUNTIME_LAUNCHER_DIGEST_REQUIRED');
  const runtimeEnvironment={...installPlan.environment,JARVIS_PC_AGENT_STATE_ROOT:cwd};
  const relocate=path=>{const sub=relative(originalCwd,path);return sub==='..'||sub.startsWith('..\\')||sub.startsWith('../')||isAbsolute(sub)?path:resolve(cwd,sub);};
  for(const key of ['JARVIS_AUDIT_ROOT','JARVIS_UNDO_JOURNAL','JARVIS_ROLLBACK_TRANSACTIONS','JARVIS_PACKET_JOURNAL','JARVIS_PACKET_QUEUE','JARVIS_TOKEN_VAULT'])runtimeEnvironment[key]=relocate(installPlan.environment[key]);
  runtimeEnvironment.JARVIS_ALLOWED_ROOTS=installPlan.environment.JARVIS_ALLOWED_ROOTS.split(';').map(relocate).join(';');
  const envLines = Object.entries(runtimeEnvironment)
    .map(([key, value]) => `    SetEnv(psi, ${csharpString(key)}, ${csharpString(value)});`);
  return [
    '// Generated by JARVIS PC Agent installer packager.',
    'using System;',
    'using System.Diagnostics;',
    'using System.IO;',
    'using System.ServiceProcess;',
    'using System.Threading;',
    '',
    renderVerifiedNodeRuntimeSource(),
    'public sealed class JarvisPcAgentServiceHost : ServiceBase {',
    '  private Process child;',
    '  private volatile bool stopping = false;',
    '  private readonly object logLock = new object();',
    `  private readonly string workspaceRoot = ${csharpString(cwd)};`,
    `  private readonly string nodeExecutable = ${csharpString(nodeExecutable)};`,
    `  private readonly string serviceNameValue = ${csharpString(installPlan.serviceName)};`,
    '',
    '  public JarvisPcAgentServiceHost() {',
    '    ServiceName = serviceNameValue;',
    '    CanStop = true;',
    '    CanShutdown = true;',
    '    AutoLog = true;',
    '  }',
    '',
    '  protected override void OnStart(string[] args) {',
    '    var packageRoot = AppDomain.CurrentDomain.BaseDirectory;',
    `    VerifyRuntimeLauncher(packageRoot,${csharpString(runtimeLauncherSha256)});`,
    '    Directory.CreateDirectory(Path.Combine(workspaceRoot, "apps", "pc-agent", "logs"));',
    '    var psi = new ProcessStartInfo();',
    `    psi.FileName = VerifiedNodeRuntime.Resolve(packageRoot,nodeExecutable,${bundledNodeSha256?csharpString(bundledNodeSha256):'null'});`,
    '    psi.Arguments = Quote(Path.Combine(packageRoot,"pc-agent-runtime","launch.mjs"));',
    '    psi.WorkingDirectory = workspaceRoot;',
    '    psi.UseShellExecute = false;',
    '    psi.RedirectStandardOutput = true;',
    '    psi.RedirectStandardError = true;',
    '    psi.CreateNoWindow = true;',
    ...envLines,
    '    child = new Process();',
    '    child.StartInfo = psi;',
    '    child.EnableRaisingEvents = true;',
    '    child.OutputDataReceived += (sender, eventArgs) => WriteLog(packageRoot, eventArgs.Data);',
    '    child.ErrorDataReceived += (sender, eventArgs) => WriteLog(packageRoot, eventArgs.Data);',
    '    child.Exited += (sender, eventArgs) => {',
    '      if (stopping) return;',
    '      var exitCode = child.ExitCode == 0 ? 1 : child.ExitCode;',
    '      WriteLog(packageRoot, "JARVIS PC 에이전트 하위 프로세스가 예기치 않게 종료되었습니다. 종료 코드: " + child.ExitCode + ". 서비스 복구를 위해 호스트를 종료합니다.");',
    '      Environment.Exit(exitCode);',
    '    };',
    '    child.Start();',
    '    child.BeginOutputReadLine();',
    '    child.BeginErrorReadLine();',
    '    Thread.Sleep(1500);',
    '    if (child.HasExited) {',
    '      throw new Exception("서비스 시작 중 JARVIS PC 에이전트가 종료되었습니다. 종료 코드: " + child.ExitCode + ". pc-agent-service-host.log를 확인하세요.");',
    '    }',
    '  }',
    '',
    '  private static void VerifyRuntimeLauncher(string root, string expected) {',
    '    var folder = Path.Combine(root,"pc-agent-runtime");',
    '    var path = Path.Combine(folder,"launch.mjs");',
    '    if (!File.Exists(path)) throw new InvalidOperationException("PC_RUNTIME_LAUNCHER_MISSING");',
    '    foreach (var item in new string[]{root,folder,path}) {',
    '      if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("PC_RUNTIME_LAUNCHER_LINK_DENIED");',
    '    }',
    '    using (var stream = File.OpenRead(path)) using (var sha = System.Security.Cryptography.SHA256.Create()) {',
    '      var actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();',
    '      if (actual != expected) throw new InvalidOperationException("PC_RUNTIME_LAUNCHER_INTEGRITY_FAILED");',
    '    }',
    '  }',
    '',
    '  protected override void OnStop() {',
    '    stopping = true;',
    '    if (child == null) return;',
    '    try {',
    '      if (!child.HasExited) {',
    '        child.Kill();',
    '        child.WaitForExit(10000);',
    '      }',
    '    } catch (Exception error) {',
    '      WriteLog(AppDomain.CurrentDomain.BaseDirectory, "서비스 중지 실패: " + error.Message);',
    '    }',
    '  }',
    '',
    '  private static void SetEnv(ProcessStartInfo psi, string key, string value) {',
    '    psi.EnvironmentVariables[key] = value ?? "";',
    '  }',
    '',
    '  private static string Quote(string value) {',
    '    return "\\\"" + value.Replace("\\\"", "\\\\\\\"") + "\\\"";',
    '  }',
    '',
    '  private void WriteLog(string packageRoot, string line) {',
    '    if (line == null) return;',
    '    lock (logLock) {',
    '      File.AppendAllText(Path.Combine(workspaceRoot, "apps", "pc-agent", "logs", "pc-agent-service-host.log"), DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);',
    '    }',
    '  }',
    '',
    '  public static void Main() {',
    '    ServiceBase.Run(new JarvisPcAgentServiceHost());',
    '  }',
    '}',
    ''
  ].join('\n');
}

function renderCollectLogsScript({ daemonConfig, outputDir, cwd, endpoint, serviceName }) {
  const auditRoot = resolve(cwd, daemonConfig.logs.auditRoot);
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    'Write-Host "JARVIS PC 에이전트 진단 기록 수집"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `$configuredAuditRoot = "${auditRoot}"`,
    `$endpoint = "${endpoint}"`,
    `$serviceName = "${serviceName}"`,
    `$target = Join-Path "${outputDir}" ("logs-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")`,
    '$staging = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-diagnostics-" + [guid]::NewGuid().ToString("N"))',
    '$maxTextFileBytes = 2097152',
    '$sanitizedFileCount = 0',
    '$truncatedFileCount = 0',
    "function Protect-SensitiveText([string]$Text) {",
    "  if ([String]::IsNullOrWhiteSpace($Text)) { return $Text }",
    "  $protected = [regex]::Replace($Text, '\\bsk-[A-Za-z0-9_-]{6,}\\b', 'sk-[보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '\\bBearer\\s+[A-Za-z0-9._~+/=-]{6,}', 'Bearer [보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\\b', '[보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b', '[보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '(\"[A-Za-z0-9_-]*(?:api[_-]?key|token|authorization|password|passwd|pwd|secret|cookie|session)[A-Za-z0-9_-]*\"\\s*:\\s*)\"[^\"]*\"', '$1\"[보호됨]\"', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '\\b([A-Za-z0-9_-]*(?:api[_-]?key|token|authorization|password|passwd|pwd|secret|cookie|session)[A-Za-z0-9_-]*)(\\s*[:=]\\s*)([^\\s,;]+)', '$1$2[보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  $protected = [regex]::Replace($protected, '(?<![A-Za-z0-9_])(--?(?:api[_-]?key|token|authorization|password|passwd|pwd|secret|cookie|session))(\\s+)([^\\s,;]+)', '$1$2[보호됨]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    "  if (-not [String]::IsNullOrWhiteSpace($env:USERPROFILE)) { $protected = [regex]::Replace($protected, [regex]::Escape($env:USERPROFILE), '%USERPROFILE%', [Text.RegularExpressions.RegexOptions]::IgnoreCase) }",
    '  return $protected',
    '}',
    'function Copy-SanitizedTextFile([string]$Source, [string]$Destination, [long]$MaxBytes) {',
    '  $stream = $null',
    '  $reader = $null',
    '  $writer = $null',
    '  $truncated = $false',
    '  try {',
    '    $stream = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)',
    '    if ($stream.Length -gt $MaxBytes) {',
    '      $stream.Seek(-1 * $MaxBytes, [IO.SeekOrigin]::End) | Out-Null',
    '      $truncated = $true',
    '    }',
    '    $encoding = New-Object Text.UTF8Encoding($false)',
    '    $reader = New-Object IO.StreamReader($stream, $encoding, $true, 65536)',
    '    $writer = New-Object IO.StreamWriter($Destination, $false, $encoding, 65536)',
    '    if ($truncated) { $reader.ReadLine() | Out-Null }',
    '    while (($line = $reader.ReadLine()) -ne $null) { $writer.WriteLine((Protect-SensitiveText $line)) }',
    '  } finally {',
    '    if ($null -ne $writer) { $writer.Dispose() }',
    '    if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $stream) { $stream.Dispose() }',
    '  }',
    '  return $truncated',
    '}',
    'New-Item -ItemType Directory -Force -Path $staging | Out-Null',
    'try {',
    '  $sources = @($configuredAuditRoot, (Join-Path $root "logs")) | Select-Object -Unique',
    '  $copiedSources = @()',
    '  foreach ($source in $sources) {',
    '    if (-not (Test-Path -LiteralPath $source)) { continue }',
    '    $sourceFiles = @(Get-ChildItem -LiteralPath $source -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "(?i)(vault|secret|token|credential)" -and $_.Extension -match "(?i)^\.(json|jsonl|ndjson|log|txt|csv)$" })',
    '    if ($sourceFiles.Count -eq 0) { continue }',
    '    $destination = Join-Path $staging ("runtime-logs-" + $copiedSources.Count)',
    '    New-Item -ItemType Directory -Force -Path $destination | Out-Null',
    '    foreach ($file in $sourceFiles) {',
    '      $wasTruncated = Copy-SanitizedTextFile $file.FullName (Join-Path $destination $file.Name) $maxTextFileBytes',
    '      $sanitizedFileCount += 1',
    '      if ($wasTruncated) { $truncatedFileCount += 1 }',
    '    }',
    '    $copiedSources += $source',
    '  }',
    '  $packageFiles = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "(?i)(\\.log$|-report\\.json$)" -and $_.Name -notmatch "(?i)(vault|secret|token|credential)" })',
    '  if ($packageFiles.Count -gt 0) {',
    '    $packageDestination = Join-Path $staging "package-reports"',
    '    New-Item -ItemType Directory -Force -Path $packageDestination | Out-Null',
    '    foreach ($file in $packageFiles) {',
    '      $wasTruncated = Copy-SanitizedTextFile $file.FullName (Join-Path $packageDestination $file.Name) $maxTextFileBytes',
    '      $sanitizedFileCount += 1',
    '      if ($wasTruncated) { $truncatedFileCount += 1 }',
    '    }',
    '  }',
    '  $uiEventLog = Join-Path $env:LOCALAPPDATA "JARVIS\\pc-agent-ui-events.log"',
    '  $uiEventLogIncluded = $false',
    '  if (Test-Path -LiteralPath $uiEventLog) {',
    '    $uiDestination = Join-Path $staging "ui-events"',
    '    New-Item -ItemType Directory -Force -Path $uiDestination | Out-Null',
    '    $wasTruncated = Copy-SanitizedTextFile $uiEventLog (Join-Path $uiDestination "pc-agent-ui-events.log") $maxTextFileBytes',
    '    $sanitizedFileCount += 1',
    '    if ($wasTruncated) { $truncatedFileCount += 1 }',
    '    $uiEventLogIncluded = $true',
    '  }',
    '  $serviceState = "설치되지 않음"',
    '  try { $serviceState = (Get-Service -Name $serviceName -ErrorAction Stop).Status.ToString() } catch { }',
    '  $healthState = "응답 없음"',
    '  try {',
    '    $health = Invoke-RestMethod -Uri ($endpoint + "/health") -Method Get -TimeoutSec 3',
    '    $healthState = if ($health.status) { [string]$health.status } else { "정상 응답" }',
    '  } catch { }',
    '  $summary = [ordered]@{',
    '    reportVersion = "jarvis-pc-agent-diagnostics-v1"',
    '    collectedAt = [DateTime]::UtcNow.ToString("o")',
    '    serviceState = $serviceState',
    '    endpoint = $endpoint',
    '    healthState = $healthState',
    '    copiedSourceCount = $copiedSources.Count',
    '    copiedPackageReportCount = $packageFiles.Count',
    '    uiEventLogIncluded = $uiEventLogIncluded',
    '    sensitiveFilesExcluded = $true',
    '    privacyRedactionApplied = $true',
    '    rawSecretsIncluded = $false',
    '    sanitizedFileCount = $sanitizedFileCount',
    '    truncatedFileCount = $truncatedFileCount',
    '    maxTextFileBytes = $maxTextFileBytes',
    '  }',
    '  $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging "diagnostic-summary.json") -Encoding UTF8',
    '  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $target -Force',
    '} finally {',
    '  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }',
    '}',
    'Write-Host "진단 묶음을 저장했습니다: $target"'
  ].join('\n');
}

function renderVerifyPackageScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [switch]$SourceOnly,',
    '  [switch]$RuntimeOnly',
    ')',
    '$ErrorActionPreference = "Stop"',
    'if ($SourceOnly -and $RuntimeOnly) { throw "소스 전용 검사와 런타임 전용 검사를 함께 선택할 수 없습니다." }',
    '# Node launched from another PowerShell version can inherit its module path.',
    '# Import this host version explicitly; never evaluate the data file as code.',
    'Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1") -ErrorAction Stop',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$manifestPath = Join-Path $root "package-manifest.json"',
    '$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json',
    'function Get-Sha256([string]$Path) {',
    '  $algorithm = [Security.Cryptography.SHA256]::Create()',
    '  try {',
    '    $stream = [IO.File]::OpenRead($Path)',
    '    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }',
    '    finally { $stream.Dispose() }',
    '  } finally { $algorithm.Dispose() }',
    '}',
    'foreach ($file in $manifest.fileIntegrity.PSObject.Properties) {',
    '  $name = $file.Name',
    '  $expected = $file.Value.sha256',
    '  $path = Join-Path $root $name',
    '  if (-not (Test-Path $path)) { throw "패키지 파일이 없습니다: $name" }',
    '  $actual = Get-Sha256 $path',
    '  if ($actual -ne $expected) { throw "파일 무결성 값이 일치하지 않습니다: $name" }',
    '}',
    '$runtimeArtifactNames = @("JarvisPcAgentTray.exe", "JarvisPcAgentServiceHost.exe")',
    '$presentRuntimeArtifacts = @($runtimeArtifactNames | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf })',
    '$runtimeSignerThumbprint = $null',
    'if (-not $SourceOnly -and $presentRuntimeArtifacts.Count -gt 0) {',
    '  $runtimeIntegrityPath = Join-Path $root "runtime-integrity.psd1"',
    '  if (-not (Test-Path -LiteralPath $runtimeIntegrityPath -PathType Leaf)) { throw "실행 파일 무결성 매니페스트가 없습니다: runtime-integrity.psd1" }',
    '  $runtimeSignature = Get-AuthenticodeSignature -LiteralPath $runtimeIntegrityPath',
    '  if ($runtimeSignature.Status -ne "Valid") { throw "실행 파일 무결성 매니페스트 서명이 유효하지 않습니다: $($runtimeSignature.Status)" }',
    '  $runtimeSignerThumbprint = [string]$runtimeSignature.SignerCertificate.Thumbprint',
    '  if ([string]::IsNullOrWhiteSpace($runtimeSignerThumbprint)) { throw "실행 파일 무결성 매니페스트 서명자를 확인할 수 없습니다." }',
    '  $runtimeIntegrity = Import-PowerShellDataFile -LiteralPath $runtimeIntegrityPath',
    '  if ($runtimeIntegrity.schema -ne "jarvis-pc-agent-runtime-integrity-v1") { throw "지원하지 않는 실행 파일 무결성 매니페스트입니다." }',
    '  $packageManifestHash = Get-Sha256 $manifestPath',
    '  if ($runtimeIntegrity.packageManifestSha256 -ne $packageManifestHash) { throw "실행 파일이 현재 패키지 매니페스트와 일치하지 않습니다." }',
    '  $records = @($runtimeIntegrity.artifacts)',
    '  foreach ($record in $records) {',
    '    $name = [string]$record.name',
    '    if ($runtimeArtifactNames -notcontains $name) { throw "허용되지 않은 실행 파일 무결성 항목입니다: $name" }',
    '    $path = Join-Path $root $name',
    '    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "서명된 실행 파일이 없습니다: $name" }',
    '    if ((Get-Sha256 $path) -ne [string]$record.sha256) { throw "실행 파일 무결성 값이 일치하지 않습니다: $name" }',
    '    if ((Get-Item -LiteralPath $path).Length -ne [long]$record.sizeBytes) { throw "실행 파일 크기가 일치하지 않습니다: $name" }',
    '    $signature = Get-AuthenticodeSignature -LiteralPath $path',
    '    if ($signature.Status -ne "Valid") { throw "실행 파일 서명이 유효하지 않습니다: $name ($($signature.Status))" }',
    '    if ([string]$signature.SignerCertificate.Thumbprint -ne $runtimeSignerThumbprint) { throw "실행 파일 서명자가 런타임 매니페스트와 일치하지 않습니다: $name" }',
    '  }',
    '  foreach ($name in $presentRuntimeArtifacts) {',
    '    if (@($records | Where-Object { $_.name -eq $name }).Count -ne 1) { throw "실행 파일 무결성 항목이 없거나 중복되었습니다: $name" }',
    '  }',
    '}',
    'if (-not $SourceOnly -and -not $RuntimeOnly) {',
    '  $setupPath = Join-Path $root "JARVIS-PC-Agent-Setup.exe"',
    '  if (Test-Path -LiteralPath $setupPath -PathType Leaf) {',
    '    $setupSignature = Get-AuthenticodeSignature -LiteralPath $setupPath',
    '    if ($setupSignature.Status -ne "Valid") { throw "설치 프로그램 서명이 유효하지 않습니다: $($setupSignature.Status)" }',
    '    if ($runtimeSignerThumbprint -and [string]$setupSignature.SignerCertificate.Thumbprint -ne $runtimeSignerThumbprint) { throw "설치 프로그램 서명자가 런타임 매니페스트와 일치하지 않습니다." }',
    '  }',
    '}',
    'Write-Host $(if ($SourceOnly) { "JARVIS PC 에이전트 소스 패키지 무결성 검증을 통과했습니다." } elseif ($RuntimeOnly) { "JARVIS PC 에이전트 소스와 런타임 무결성을 검증했습니다. Setup 검사는 포함하지 않습니다." } else { "JARVIS PC 에이전트 패키지와 실행 파일 무결성 검증을 통과했습니다." })'
  ].join('\n');
}

function renderVerifyInstalledServiceScript({ daemonConfig, serviceManifest, endpoint, cwd }) {
  const auditRoot = resolve(cwd, daemonConfig.logs.auditRoot);
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$checks = @()',
    'function Add-Check($id, $status, $detail) {',
    '  $script:checks += [pscustomobject]@{ id = $id; status = $status; detail = $detail }',
    '}',
    `Write-Host "설치된 JARVIS PC 에이전트 서비스 검증"`,
    `$service = Get-Service -Name "${serviceManifest.serviceName}" -ErrorAction SilentlyContinue`,
    'if ($null -eq $service) {',
    '  Add-Check "service-present" "fail" @{ message = "Service is not registered." }',
    '} else {',
    '  Add-Check "service-present" "pass" @{ status = $service.Status.ToString(); startType = $service.StartType.ToString() }',
    '  Add-Check "service-running" $(if ($service.Status -eq "Running") { "pass" } else { "fail" }) @{ status = $service.Status.ToString() }',
    '}',
    'try {',
    `  $health = Invoke-RestMethod -Uri "${endpoint}/health" -TimeoutSec 5`,
    '  Add-Check "health-endpoint" "pass" @{ status = $health.status; module = $health.module; localOnly = $health.localOnly }',
    '  Add-Check "health-local-only" $(if ($health.localOnly -eq $true) { "pass" } else { "fail" }) @{ localOnly = $health.localOnly }',
    '  Add-Check "undo-chain" $(if ($health.undoJournal.chain -eq "valid") { "pass" } else { "fail" }) @{ chain = $health.undoJournal.chain }',
    '  Add-Check "packet-journal" "pass" @{ records = $health.packetJournal.records; pending = $health.packetJournal.pending; completed = $health.packetJournal.completed }',
    '} catch {',
    '  Add-Check "health-endpoint" "fail" @{ message = $_.Exception.Message }',
    '}',
    `$auditRoot = "${auditRoot}"`,
    'Add-Check "audit-root" $(if (Test-Path $auditRoot) { "pass" } else { "warning" }) @{ path = $auditRoot }',
    '$trayExe = Join-Path $root "JarvisPcAgentTray.exe"',
    'Add-Check "tray-executable" $(if (Test-Path $trayExe) { "pass" } else { "warning" }) @{ path = $trayExe }',
    '$failed = @($checks | Where-Object { $_.status -eq "fail" })',
    '$warnings = @($checks | Where-Object { $_.status -eq "warning" })',
    '$report = [pscustomobject]@{',
    '  status = $(if ($failed.Count -gt 0) { "failed" } elseif ($warnings.Count -gt 0) { "passed-with-warnings" } else { "passed" })',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    `  serviceName = "${serviceManifest.serviceName}"`,
    `  endpoint = "${endpoint}"`,
    '  checks = $checks',
    '}',
    '$reportPath = Join-Path $root "service-smoke-report.json"',
    '$report | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "보고서를 저장했습니다: $reportPath"',
    'if ($failed.Count -gt 0) {',
    '  $failed | Format-Table -AutoSize',
    '  exit 1',
    '}',
    'Write-Host "설치된 서비스 검증을 통과했습니다."'
  ].join('\n');
}

function renderInstallVerifyReleaseScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [switch]$Production',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$steps = @()',
    'function Add-Step($id, $status, $detail) {',
    '  $script:steps += [pscustomobject]@{ id = $id; status = $status; detail = $detail }',
    '}',
    'function Write-InstallReleaseReport($status) {',
    '  $report = [pscustomobject]@{',
    '    reportId = "b-pc-agent-install-release-v1"',
    '    status = $status',
    '    generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '    production = [bool]$Production',
    '    steps = $script:steps',
    '  }',
    '  $reportPath = Join-Path $root "install-release-report.json"',
    '  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $reportPath -Encoding UTF8',
    '  Write-Host "보고서를 저장했습니다: $reportPath"',
    '}',
    'function Invoke-PackageScript($id, $scriptName, $arguments = @(), $required = $true) {',
    '  $scriptPath = Join-Path $root $scriptName',
    '  try {',
    '    & $scriptPath @arguments',
    '    Add-Step $id "pass" @{ script = $scriptName }',
    '    return $true',
    '  } catch {',
    '    $status = $(if ($required) { "fail" } else { "warning" })',
    '    Add-Step $id $status @{ script = $scriptName; message = $_.Exception.Message }',
    '    if ($required) { throw }',
    '    return $false',
    '  }',
    '}',
    'function Invoke-WorkspaceNodeScript($id, $relativeScript, $arguments = @(), $required = $true) {',
    '  $distRoot = Split-Path -Parent $root',
    '  $workspaceRoot = Split-Path -Parent $distRoot',
    '  $scriptPath = Join-Path $workspaceRoot $relativeScript',
    '  $node = Get-Command node -ErrorAction SilentlyContinue',
    '  $locationPushed = $false',
    '  try {',
    '    if (-not $node) { throw "$relativeScript 실행에 Node.js가 필요합니다." }',
    '    if (-not (Test-Path $scriptPath)) { throw "작업 공간 스크립트가 없습니다: $scriptPath" }',
    '    Push-Location $workspaceRoot',
    '    $locationPushed = $true',
    '    & $node.Source $scriptPath @arguments',
    '    if ($LASTEXITCODE -ne 0) { throw "Node.js 스크립트 $relativeScript 실행에 실패했습니다. 종료 코드: $LASTEXITCODE" }',
    '    Add-Step $id "pass" @{ script = $relativeScript }',
    '    return $true',
    '  } catch {',
    '    $status = $(if ($required) { "fail" } else { "warning" })',
    '    Add-Step $id $status @{ script = $relativeScript; message = $_.Exception.Message }',
    '    if ($required) { throw }',
    '    return $false',
    '  } finally {',
    '    if ($locationPushed) { Pop-Location }',
    '  }',
    '}',
    '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
    '  Add-Step "administrator-shell" "fail" @{ message = "Administrator PowerShell is required for install-verify-release." }',
    '  Write-InstallReleaseReport "failed"',
    '  throw "설치 및 릴리스 검증에는 관리자 권한 PowerShell이 필요합니다."',
    '}',
    'Add-Step "administrator-shell" "pass" @{ message = "Administrator shell is available." }',
    'try {',
    '  Invoke-PackageScript "verify-source-package" "verify-package.ps1" @("-SourceOnly")',
    '  $setupPath = Join-Path $root "JARVIS-PC-Agent-Setup.exe"',
    '  if (Test-Path -LiteralPath $setupPath -PathType Leaf) { Remove-Item -LiteralPath $setupPath -Force }',
    '  Add-Step "remove-stale-setup" "pass" @{ removed = -not (Test-Path -LiteralPath $setupPath -PathType Leaf) }',
    '  Invoke-PackageScript "build-tray-exe" "build-tray-exe.ps1"',
    '  Invoke-PackageScript "build-service-host" "build-service-host.ps1"',
    '  if (-not $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT -and -not $Production) {',
    '    if (Invoke-PackageScript "create-dev-signing-cert" "create-dev-signing-cert.ps1" @() $false) {',
    '      $certReportPath = Join-Path $root "dev-signing-cert-report.json"',
    '      if (Test-Path $certReportPath) {',
    '        $certReport = Get-Content $certReportPath -Raw | ConvertFrom-Json',
    '        $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT = $certReport.thumbprint',
    '        Add-Step "dev-signing-cert-selected" "pass" @{ certificateSelected = $true }',
    '      }',
    '    }',
    '  }',
    '  if ($env:JARVIS_CODE_SIGN_CERT_THUMBPRINT) {',
    '    $runtimeSignArgs = @("-RuntimeOnly")',
    '    if ($Production) { $runtimeSignArgs += "-RequireTimestamp" }',
    '    Invoke-PackageScript "sign-runtime-artifacts" "sign-artifacts.ps1" $runtimeSignArgs',
    '  } else {',
    '    Add-Step "sign-runtime-artifacts" "fail" @{ message = "No code-signing certificate configured." }',
    '    throw "런타임 서명에는 JARVIS_CODE_SIGN_CERT_THUMBPRINT가 필요합니다."',
    '  }',
    '  Invoke-PackageScript "verify-signed-runtime" "verify-package.ps1"',
    '  $setupBuilt = Invoke-PackageScript "build-nsis-installer" "build-nsis-installer.ps1" @() ([bool]$Production)',
    '  if ([bool]$setupBuilt) {',
    '    $setupSignArgs = @("-SetupOnly")',
    '    if ($Production) { $setupSignArgs += "-RequireTimestamp" }',
    '    Invoke-PackageScript "sign-setup-artifact" "sign-artifacts.ps1" $setupSignArgs',
    '  }',
    '  Invoke-PackageScript "verify-final-package" "verify-package.ps1"',
    '  Invoke-PackageScript "verify-signatures" "verify-signatures.ps1"',
    '  Invoke-PackageScript "install-service" "install-service.ps1"',
    '  Invoke-PackageScript "start-service" "start-service.ps1"',
    '  Start-Sleep -Seconds 2',
    '  Invoke-PackageScript "verify-installed-service" "verify-installed-service.ps1"',
    '  Invoke-PackageScript "install-tray-shortcut" "install-tray-shortcut.ps1"',
    '  $daemonSmokePath = Join-Path $root "daemon-smoke-report.json"',
    '  Invoke-WorkspaceNodeScript "daemon-smoke" "scripts/pc-agent-daemon-smoke.mjs" @("--output", $daemonSmokePath)',
    '  $queueSoakPath = Join-Path $root "queue-soak-report.json"',
    '  Invoke-WorkspaceNodeScript "queue-soak" "scripts/pc-agent-queue-soak.mjs" @("--output", $queueSoakPath, "--packets", "24")',
    '  $gateArgs = $(if ($Production) { @("-Production") } else { @() })',
    '  Invoke-PackageScript "verify-production-signing" "verify-production-signing.ps1" $gateArgs',
    '  Invoke-PackageScript "verify-release-gate" "verify-release-gate.ps1" $gateArgs',
    '  Invoke-PackageScript "build-release-evidence" "build-release-evidence.ps1"',
    '  $warnings = @($steps | Where-Object { $_.status -eq "warning" })',
    '  Write-InstallReleaseReport $(if ($warnings.Count -gt 0) { "passed-with-warnings" } else { "passed" })',
    '  Write-Host "JARVIS PC 에이전트 설치 및 릴리스 검증을 완료했습니다."',
    '} catch {',
    '  try { Invoke-PackageScript "build-release-evidence-after-failure" "build-release-evidence.ps1" @() $false | Out-Null } catch { }',
    '  Write-InstallReleaseReport "failed"',
    '  throw',
    '}'
  ].join('\n');
}

function renderSignArtifactsScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT,',
    '  [string]$TimestampServer = "http://timestamp.digicert.com",',
    '  [string]$SignToolPath = $env:JARVIS_SIGNTOOL_PATH,',
    '  [ValidateSet("CurrentUser", "LocalMachine")]',
    '  [string]$CertificateStoreLocation = "CurrentUser",',
    '  [switch]$RuntimeOnly,',
    '  [switch]$SetupOnly,',
    '  [switch]$RequireTimestamp',
    ')',
    '$ErrorActionPreference = "Stop"',
    'if ($RuntimeOnly -and $SetupOnly) { throw "RuntimeOnly와 SetupOnly를 동시에 사용할 수 없습니다." }',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'function Resolve-SignTool([string]$ConfiguredPath) {',
    '  if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {',
    '    $resolved = [IO.Path]::GetFullPath($ConfiguredPath)',
    '    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "지정한 SignTool을 찾을 수 없습니다." }',
    '    return $resolved',
    '  }',
    '  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue',
    '  if ($command) { return $command.Source }',
    '  $candidates = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}\\Windows Kits\\10\\bin\\*\\x64\\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)',
    '  if ($candidates.Count -eq 0) { throw "Windows SDK SignTool을 찾을 수 없습니다." }',
    '  return $candidates[0].FullName',
    '}',
    'function Get-Sha256([string]$Path) {',
    '  $algorithm = [Security.Cryptography.SHA256]::Create()',
    '  try {',
    '    $stream = [IO.File]::OpenRead($Path)',
    '    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }',
    '    finally { $stream.Dispose() }',
    '  } finally { $algorithm.Dispose() }',
    '}',
    'function Set-JarvisSignature([string]$Target, $Certificate) {',
    '  $arguments = @("sign", "/q", "/fd", "SHA256", "/sha1", $normalizedThumbprint, "/s", "My", "/d", "JARVIS")',
    '  if ($CertificateStoreLocation -eq "LocalMachine") { $arguments += "/sm" }',
    '  if ($RequireTimestamp) { $arguments += @("/tr", $TimestampServer, "/td", "SHA256") }',
    '  $arguments += $Target',
    '  & $resolvedSignTool @arguments',
    '  if ($LASTEXITCODE -ne 0) { throw "SignTool 서명에 실패했습니다: $([IO.Path]::GetFileName($Target)) (종료 코드 $LASTEXITCODE)" }',
    '  $verified = Get-AuthenticodeSignature -LiteralPath $Target',
    '  if ($verified.Status -ne "Valid") { throw "산출물 서명이 유효하지 않습니다: $Target ($($verified.Status))" }',
    '  if ($null -eq $verified.SignerCertificate -or $verified.SignerCertificate.Thumbprint -ne $normalizedThumbprint) { throw "선택한 인증서와 산출물 서명자가 일치하지 않습니다." }',
    '  if ($RequireTimestamp -and $null -eq $verified.TimeStamperCertificate) { throw "신뢰 타임스탬프가 없습니다: $Target" }',
    '  return [pscustomobject]@{ artifact = [IO.Path]::GetFileName($Target); status = $verified.Status.ToString(); timestamped = ($null -ne $verified.TimeStamperCertificate); fileDigestAlgorithm = "SHA256"; timestampProtocol = $(if ($RequireTimestamp) { "RFC3161" } else { "none" }); timestampDigestAlgorithm = $(if ($RequireTimestamp) { "SHA256" } else { $null }); pathStored = $false }',
    '}',
    '$runtimeTargets = @(',
    '  "JarvisPcAgentTray.exe",',
    '  "JarvisPcAgentServiceHost.exe"',
    ') | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }',
    '$setupTarget = Join-Path $root "JARVIS-PC-Agent-Setup.exe"',
    'if (-not $SetupOnly -and $runtimeTargets.Count -ne 2) { throw "트레이와 서비스 호스트를 모두 빌드한 뒤 서명해야 합니다." }',
    'if ($SetupOnly -and -not (Test-Path -LiteralPath $setupTarget -PathType Leaf)) { throw "서명할 설치 프로그램이 없습니다: $setupTarget" }',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) { throw "JARVIS_CODE_SIGN_CERT_THUMBPRINT 또는 -CertificateThumbprint가 필요합니다." }',
    '$normalizedThumbprint = $CertificateThumbprint.Replace(" ", "").ToUpperInvariant()',
    '$certificateStorePath = if ($CertificateStoreLocation -eq "LocalMachine") { "Cert:\\LocalMachine\\My" } else { "Cert:\\CurrentUser\\My" }',
    '$certificate = Get-ChildItem -Path $certificateStorePath -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $normalizedThumbprint } | Select-Object -First 1',
    'if (-not $certificate) { throw "코드 서명 인증서를 찾을 수 없습니다: $normalizedThumbprint" }',
    'if (-not $certificate.HasPrivateKey) { throw "코드 서명 인증서의 개인 키를 사용할 수 없습니다." }',
    'if ($RequireTimestamp -and $certificate.Subject -eq $certificate.Issuer) { throw "프로덕션 서명에는 자체 서명 인증서를 사용할 수 없습니다." }',
    '$resolvedSignTool = Resolve-SignTool $SignToolPath',
    '$operationResults = @()',
    'if (-not $SetupOnly) {',
    '  foreach ($target in $runtimeTargets) { $operationResults += Set-JarvisSignature $target $certificate }',
    '    $packageManifestPath = Join-Path $root "package-manifest.json"',
    '    if (-not (Test-Path -LiteralPath $packageManifestPath -PathType Leaf)) { throw "패키지 매니페스트를 찾을 수 없습니다." }',
    '    $runtimeIntegrityPath = Join-Path $root "runtime-integrity.psd1"',
    '    $artifactLines = @($runtimeTargets | ForEach-Object {',
    '      $name = [IO.Path]::GetFileName($_).Replace("\'", "\'\'")',
    '      "    @{ name = \'" + $name + "\'; sha256 = \'" + (Get-Sha256 $_) + "\'; sizeBytes = " + (Get-Item -LiteralPath $_).Length + " }"',
    '    })',
    '    $runtimeData = @(',
    '      "@{"',
    '      "  schema = \'jarvis-pc-agent-runtime-integrity-v1\'"',
    '      "  generatedAt = \'" + (Get-Date).ToUniversalTime().ToString("o") + "\'"',
    '      "  packageManifestSha256 = \'" + (Get-Sha256 $packageManifestPath) + "\'"',
    '      "  artifacts = @("',
    '    ) + $artifactLines + @(',
    '      "  )"',
    '      "}"',
    '    )',
    '    [IO.File]::WriteAllLines($runtimeIntegrityPath, $runtimeData, (New-Object Text.UTF8Encoding($true)))',
    '    $operationResults += Set-JarvisSignature $runtimeIntegrityPath $certificate',
    '}',
    'if (-not $RuntimeOnly -and (Test-Path -LiteralPath $setupTarget -PathType Leaf)) {',
    '  $operationResults += Set-JarvisSignature $setupTarget $certificate',
    '}',
    '$reportTargets = @($runtimeTargets)',
    '$runtimeIntegrityPath = Join-Path $root "runtime-integrity.psd1"',
    'if (Test-Path -LiteralPath $runtimeIntegrityPath -PathType Leaf) { $reportTargets += $runtimeIntegrityPath }',
    'if (Test-Path -LiteralPath $setupTarget -PathType Leaf) { $reportTargets += $setupTarget }',
    '$results = @($reportTargets | ForEach-Object {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $_',
    '  [pscustomobject]@{ artifact = [IO.Path]::GetFileName($_); status = $signature.Status.ToString(); timestamped = ($null -ne $signature.TimeStamperCertificate); pathStored = $false }',
    '})',
    '$reportPath = Join-Path $root "signature-report.json"',
    '$reportJson = [pscustomobject]@{ reportVersion = "jarvis-pc-agent-signature-report-v2"; generatedAt = (Get-Date).ToUniversalTime().ToString("o"); signer = "windows-sdk-signtool"; fileDigestAlgorithm = "SHA256"; timestampProtocol = $(if ($RequireTimestamp) { "RFC3161" } else { "none" }); timestampDigestAlgorithm = $(if ($RequireTimestamp) { "SHA256" } else { $null }); certificateStoreLocation = $CertificateStoreLocation; certificateThumbprintStored = $false; artifactPathsStored = $false; mode = $(if ($RuntimeOnly) { "runtime-only" } elseif ($SetupOnly) { "setup-only" } else { "all" }); operations = $operationResults; results = $results } | ConvertTo-Json -Depth 8',
    '[IO.File]::WriteAllText($reportPath, $reportJson + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))',
    'Write-Host "보고서를 저장했습니다: $reportPath"'
  ].join('\n');
}

function renderVerifySignaturesScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'function Hash-String([string]$Value) {',
    '  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }',
    '  $algorithm = [Security.Cryptography.SHA256]::Create()',
    '  try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").ToLowerInvariant() }',
    '  finally { $algorithm.Dispose() }',
    '}',
    '$targets = @("JarvisPcAgentTray.exe", "JarvisPcAgentServiceHost.exe", "JARVIS-PC-Agent-Setup.exe", "runtime-integrity.psd1") | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }',
    '$results = foreach ($target in $targets) {',
    '  $signature = Get-AuthenticodeSignature -FilePath $target',
    '  [pscustomobject]@{ path = $target; status = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject; thumbprintHash = (Hash-String $signature.SignerCertificate.Thumbprint); timestamped = ($null -ne $signature.TimeStamperCertificate) }',
    '}',
    '$reportPath = Join-Path $root "signature-verification-report.json"',
    '[pscustomobject]@{ generatedAt = (Get-Date).ToUniversalTime().ToString("o"); results = @($results) } | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "보고서를 저장했습니다: $reportPath"',
    '$bad = @($results | Where-Object { $_.status -ne "Valid" })',
    'if ($bad.Count -gt 0) {',
    '  Write-Warning "서명되지 않았거나 유효하지 않은 산출물이 있습니다. signature-verification-report.json을 확인하세요."',
    '  exit 1',
    '}'
  ].join('\n');
}

function renderProductionSigningPolicy({ serviceManifest }) {
  return JSON.stringify({
    policyVersion: 'b-pc-agent-production-signing-policy-v1',
    serviceName: serviceManifest.serviceName,
    platform: 'win32',
    mode: {
      development: {
        allowsSelfSignedCertificate: true,
        trustedCurrentUserCertificateAllowed: true,
        productionReleaseAllowed: false
      },
      production: {
        allowsSelfSignedCertificate: false,
        requiresTrustedChain: true,
        requiresOnlineRevocationCheck: true,
        requiresPrivateKey: true,
        requiresCodeSigningEku: true,
        requiresTimestamp: true,
        fileDigestAlgorithm: 'SHA256',
        timestampProtocol: 'RFC3161',
        timestampDigestAlgorithm: 'SHA256',
        allowedPublicKeyAlgorithms: ['RSA'],
        minimumRsaKeySize: 2048,
        minimumDaysValid: 30
      }
    },
    requiredEkuOids: ['1.3.6.1.5.5.7.3.3'],
    signableArtifacts: [
      'JarvisPcAgentTray.exe',
      'JarvisPcAgentServiceHost.exe',
      'runtime-integrity.psd1',
      'JARVIS-PC-Agent-Setup.exe'
    ],
    report: 'production-signing-report.json',
    rawCertificateThumbprintStored: false,
    rawPrivateKeyMaterialStored: false
  }, null, 2);
}

function renderVerifyProductionSigningScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [switch]$Production,',
    '  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$checks = @()',
    'function Add-Check($id, $status, $detail) {',
    '  $script:checks += [pscustomobject]@{ id = $id; status = $status; detail = $detail }',
    '}',
    'function Hash-String([string]$Value) {',
    '  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  try {',
    '    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace("-", "").ToLowerInvariant())',
    '  } finally {',
    '    $sha.Dispose()',
    '  }',
    '}',
    'function Find-SigningCertificate([string]$Thumbprint) {',
    '  if ([string]::IsNullOrWhiteSpace($Thumbprint)) { return $null }',
    '  $normalized = $Thumbprint.Replace(" ", "").ToUpperInvariant()',
    '  return Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\LocalMachine\\My -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $normalized } | Select-Object -First 1',
    '}',
    'function Test-CodeSigningEku($Certificate, $RequiredOids) {',
    '  if (-not $Certificate) { return $false }',
    '  $ekuOids = @($Certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })',
    '  foreach ($oid in @($RequiredOids)) {',
    '    if ($ekuOids -contains $oid) { return $true }',
    '  }',
    '  return $false',
    '}',
    'function Test-CertificateChain($Certificate) {',
    '  if (-not $Certificate) { return [pscustomobject]@{ ok = $false; statuses = @("certificate-missing") } }',
    '  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain',
    '  try {',
    '    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online',
    '    $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot',
    '    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)',
    '    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag',
    '    $ok = $chain.Build($Certificate)',
    '    $statuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })',
    '    return [pscustomobject]@{ ok = $ok; statuses = $statuses; revocationMode = "Online" }',
    '  } finally {',
    '    $chain.Dispose()',
    '  }',
    '}',
    'function Read-JsonFile($name) {',
    '  $path = Join-Path $root $name',
    '  if (Test-Path $path) { return Get-Content $path -Raw | ConvertFrom-Json }',
    '  return $null',
    '}',
    '$policy = Read-JsonFile "production-signing-policy.json"',
    'if (-not $policy) {',
    '  Add-Check "production-signing-policy-present" $(if ($Production) { "fail" } else { "warning" }) @{ message = "production-signing-policy.json is missing." }',
    '  $requiredOids = @("1.3.6.1.5.5.7.3.3")',
    '  $signableArtifacts = @("JarvisPcAgentTray.exe", "JarvisPcAgentServiceHost.exe", "runtime-integrity.psd1", "JARVIS-PC-Agent-Setup.exe")',
    '  $minimumDaysValid = 30',
    '  $minimumRsaKeySize = 2048',
    '} else {',
    '  Add-Check "production-signing-policy-present" "pass" @{ policyVersion = $policy.policyVersion }',
    '  $requiredOids = @($policy.requiredEkuOids)',
    '  $signableArtifacts = @($policy.signableArtifacts)',
    '  $minimumDaysValid = [int]$policy.mode.production.minimumDaysValid',
    '  $minimumRsaKeySize = [int]$policy.mode.production.minimumRsaKeySize',
    '}',
    '$certificate = Find-SigningCertificate $CertificateThumbprint',
    '$thumbprintHash = Hash-String $CertificateThumbprint',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {',
    '  Add-Check "production-certificate-configured" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; requiredForProduction = $true }',
    '} else {',
    '  Add-Check "production-certificate-configured" "pass" @{ certificateThumbprintHash = $thumbprintHash }',
    '}',
    'if ($certificate) {',
    '  Add-Check "production-certificate-found" "pass" @{ certificateThumbprintHash = Hash-String $certificate.Thumbprint; subjectHash = Hash-String $certificate.Subject }',
    '  $isSelfSigned = $certificate.Subject -eq $certificate.Issuer',
    '  Add-Check "production-certificate-not-self-signed" $(if (-not $isSelfSigned -or -not $Production) { "pass" } else { "fail" }) @{ production = [bool]$Production; selfSigned = $isSelfSigned }',
    '  Add-Check "production-certificate-has-private-key" $(if ($certificate.HasPrivateKey) { "pass" } else { $(if ($Production) { "fail" } else { "warning" }) }) @{ hasPrivateKey = $certificate.HasPrivateKey }',
    '  $hasEku = Test-CodeSigningEku $certificate $requiredOids',
    '  Add-Check "production-certificate-code-signing-eku" $(if ($hasEku) { "pass" } else { $(if ($Production) { "fail" } else { "warning" }) }) @{ requiredOids = $requiredOids }',
    '  $keyAlgorithm = $certificate.PublicKey.Oid.Value',
    '  $keySize = try { $certificate.PublicKey.Key.KeySize } catch { 0 }',
    '  $supportedKey = $keyAlgorithm -eq "1.2.840.113549.1.1.1" -and $keySize -ge $minimumRsaKeySize -and $keySize -le 4096',
    '  Add-Check "production-certificate-key-policy" $(if ($supportedKey) { "pass" } else { $(if ($Production) { "fail" } else { "warning" }) }) @{ algorithm = $(if ($keyAlgorithm -eq "1.2.840.113549.1.1.1") { "RSA" } else { "unsupported" }); keySize = $keySize; minimumRsaKeySize = $minimumRsaKeySize; maximumRsaKeySize = 4096 }',
    '  $daysValid = [Math]::Floor(($certificate.NotAfter.ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalDays)',
    '  Add-Check "production-certificate-validity-window" $(if ($daysValid -ge $minimumDaysValid) { "pass" } else { $(if ($Production) { "fail" } else { "warning" }) }) @{ daysValid = $daysValid; minimumDaysValid = $minimumDaysValid }',
    '  $chain = Test-CertificateChain $certificate',
    '  Add-Check "production-certificate-chain-trusted" $(if ($chain.ok -or -not $Production) { "pass" } else { "fail" }) @{ trusted = $chain.ok; statuses = $chain.statuses; revocationMode = $chain.revocationMode; production = [bool]$Production }',
    '} else {',
    '  Add-Check "production-certificate-found" $(if ($Production) { "fail" } else { "pass" }) @{ certificateThumbprintHash = $thumbprintHash; production = [bool]$Production }',
    '  Add-Check "production-certificate-not-self-signed" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '  Add-Check "production-certificate-has-private-key" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '  Add-Check "production-certificate-code-signing-eku" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '  Add-Check "production-certificate-key-policy" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '  Add-Check "production-certificate-validity-window" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '  Add-Check "production-certificate-chain-trusted" $(if ($Production) { "fail" } else { "pass" }) @{ production = [bool]$Production; skipped = $true }',
    '}',
    '$signatureReport = Read-JsonFile "signature-report.json"',
    '$signaturePolicyPassed = $signatureReport -and $signatureReport.reportVersion -eq "jarvis-pc-agent-signature-report-v2" -and $signatureReport.signer -eq "windows-sdk-signtool" -and $signatureReport.fileDigestAlgorithm -eq "SHA256" -and $signatureReport.timestampProtocol -eq "RFC3161" -and $signatureReport.timestampDigestAlgorithm -eq "SHA256"',
    'Add-Check "production-signing-algorithm-policy" $(if ($signaturePolicyPassed) { "pass" } else { $(if ($Production) { "fail" } else { "pass" }) }) @{ signer = $signatureReport.signer; fileDigestAlgorithm = $signatureReport.fileDigestAlgorithm; timestampProtocol = $signatureReport.timestampProtocol; timestampDigestAlgorithm = $signatureReport.timestampDigestAlgorithm; production = [bool]$Production }',
    '$artifactResults = @()',
    'foreach ($artifact in $signableArtifacts) {',
    '  $path = Join-Path $root $artifact',
    '  if (-not (Test-Path $path)) {',
    '    $artifactResults += [pscustomobject]@{ artifact = $artifact; exists = $false; status = "missing"; timestamped = $false; signerThumbprintHash = $null }',
    '    continue',
    '  }',
    '  $signature = Get-AuthenticodeSignature -FilePath $path',
    '  $artifactResults += [pscustomobject]@{',
    '    artifact = $artifact',
    '    exists = $true',
    '    status = $signature.Status.ToString()',
    '    timestamped = [bool]$signature.TimeStamperCertificate',
    '    signerThumbprintHash = Hash-String $signature.SignerCertificate.Thumbprint',
    '  }',
    '}',
    '$presentArtifacts = @($artifactResults | Where-Object { $_.exists })',
    '$unsignedArtifacts = @($presentArtifacts | Where-Object { $_.status -eq "NotSigned" -or -not $_.signerThumbprintHash })',
    '$invalidArtifacts = @($presentArtifacts | Where-Object { $_.status -ne "Valid" })',
    '$untimestampedArtifacts = @($presentArtifacts | Where-Object { -not $_.timestamped })',
    'Add-Check "production-artifacts-present" $(if ($presentArtifacts.Count -eq $signableArtifacts.Count) { "pass" } else { $(if ($Production) { "fail" } else { "pass" }) }) @{ expected = $signableArtifacts.Count; present = $presentArtifacts.Count }',
    'Add-Check "production-artifacts-signed" $(if ($unsignedArtifacts.Count -eq 0 -and $presentArtifacts.Count -gt 0) { "pass" } else { $(if ($Production) { "fail" } else { "pass" }) }) @{ unsigned = @($unsignedArtifacts.artifact); production = [bool]$Production }',
    'Add-Check "production-artifacts-trusted" $(if ($invalidArtifacts.Count -eq 0 -and $presentArtifacts.Count -gt 0) { "pass" } else { $(if ($Production) { "fail" } else { "pass" }) }) @{ invalid = @($invalidArtifacts | ForEach-Object { [pscustomobject]@{ artifact = $_.artifact; status = $_.status } }); production = [bool]$Production }',
    'Add-Check "production-artifacts-timestamped" $(if ($untimestampedArtifacts.Count -eq 0 -and $presentArtifacts.Count -gt 0) { "pass" } else { $(if ($Production) { "fail" } else { "pass" }) }) @{ untimestamped = @($untimestampedArtifacts.artifact); production = [bool]$Production }',
    '$failed = @($checks | Where-Object { $_.status -eq "fail" })',
    '$warnings = @($checks | Where-Object { $_.status -eq "warning" })',
    '$report = [pscustomobject]@{',
    '  reportVersion = "b-pc-agent-production-signing-report-v1"',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  production = [bool]$Production',
    '  status = $(if ($failed.Count -gt 0) { "failed" } elseif ($warnings.Count -gt 0) { "passed-with-warnings" } else { $(if ($Production) { "passed" } else { "not-required-local" }) })',
    '  policyVersion = $policy.policyVersion',
    '  certificateThumbprintHash = $thumbprintHash',
    '  rawCertificateThumbprintStored = $false',
    '  rawPrivateKeyMaterialStored = $false',
    '  checks = $checks',
    '  artifacts = $artifactResults',
    '}',
    '$reportPath = Join-Path $root "production-signing-report.json"',
    '$report | ConvertTo-Json -Depth 12 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "보고서를 저장했습니다: $reportPath"',
    'if ($failed.Count -gt 0) {',
    '  $failed | Format-Table -AutoSize',
    '  exit 1',
    '}',
    'if ($warnings.Count -gt 0) { $warnings | ForEach-Object { Write-Warning "$($_.id): $($_.status)" } }'
  ].join('\n');
}

function renderCreateDevSigningCertScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [string]$Subject = "CN=JARVIS Local Dev Code Signing",',
    '  [int]$Years = 1',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears($Years)',
    '$report = [pscustomobject]@{',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  subject = $certificate.Subject',
    '  thumbprint = $certificate.Thumbprint',
    '  store = "Cert:\\CurrentUser\\My"',
    '  warning = "Development certificate only. Do not use for public release signing."',
    '}',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$reportPath = Join-Path $root "dev-signing-cert-report.json"',
    '$report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "개발용 서명 인증서를 만들었습니다: $($certificate.Thumbprint)"',
    'Write-Host "보고서를 저장했습니다: $reportPath"'
  ].join('\n');
}

function renderTrustDevSigningCertScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT,',
    '  [switch]$TrustCurrentUser,',
    '  [switch]$IncludeLocalMachineSearch',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'if (-not $TrustCurrentUser) {',
    '  throw "이 스크립트는 현재 사용자의 인증서 신뢰 저장소를 변경합니다. 로컬 개발용 신뢰 설정임을 확인한 뒤 -TrustCurrentUser 옵션으로 다시 실행하세요."',
    '}',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {',
    '  $reportPath = Join-Path $root "dev-signing-cert-report.json"',
    '  if (Test-Path $reportPath) {',
    '    $certReport = Get-Content $reportPath -Raw | ConvertFrom-Json',
    '    $CertificateThumbprint = $certReport.thumbprint',
    '  }',
    '}',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) { throw "인증서 지문이 필요합니다. create-dev-signing-cert.ps1을 먼저 실행하거나 JARVIS_CODE_SIGN_CERT_THUMBPRINT를 설정하세요." }',
    'Write-Host "인증서 지문으로 서명 인증서를 확인합니다."',
    '$searchStores = @("Cert:\\CurrentUser\\My\\$CertificateThumbprint")',
    'if ($IncludeLocalMachineSearch) { $searchStores += "Cert:\\LocalMachine\\My\\$CertificateThumbprint" }',
    '$certificate = $null',
    'foreach ($searchPath in $searchStores) {',
    '  $certificate = Get-Item $searchPath -ErrorAction SilentlyContinue',
    '  if ($certificate) { break }',
    '}',
    'if (-not $certificate) { throw "코드 서명 인증서를 찾을 수 없습니다: $CertificateThumbprint" }',
    '$targetStores = @(',
    '  "Cert:\\CurrentUser\\Root",',
    '  "Cert:\\CurrentUser\\TrustedPublisher"',
    ')',
    '$tempCertPath = Join-Path $env:TEMP ("jarvis-dev-signing-{0}.cer" -f $CertificateThumbprint)',
    'Export-Certificate -Cert $certificate -FilePath $tempCertPath -Force | Out-Null',
    '$installed = @()',
    'try {',
    'foreach ($targetStore in $targetStores) {',
    '  Write-Host "인증서 저장소를 업데이트합니다: $targetStore"',
    '  $existing = Get-Item (Join-Path $targetStore $CertificateThumbprint) -ErrorAction SilentlyContinue',
    '  if (-not $existing) { Import-Certificate -FilePath $tempCertPath -CertStoreLocation $targetStore | Out-Null }',
    '  $installed += [pscustomobject]@{ store = $targetStore; alreadyPresent = [bool]$existing }',
    '}',
    '} finally {',
    '  if (Test-Path $tempCertPath) { Remove-Item $tempCertPath -Force }',
    '}',
    '$report = [pscustomobject]@{',
    '  reportVersion = "b-pc-agent-dev-signing-trust-v1"',
    '  status = "trusted-current-user"',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  thumbprint = $certificate.Thumbprint',
    '  subject = $certificate.Subject',
    '  stores = $installed',
    '  scope = "CurrentUser"',
    '  warning = "Development certificate trust only. Use a production code-signing certificate for public release."',
    '}',
    '$trustReportPath = Join-Path $root "dev-signing-trust-report.json"',
    '$report | ConvertTo-Json -Depth 8 | Set-Content -Path $trustReportPath -Encoding UTF8',
    'Write-Host "현재 사용자에 대해 개발용 서명 인증서를 신뢰하도록 설정했습니다: $($certificate.Thumbprint)"',
    'Write-Host "보고서를 저장했습니다: $trustReportPath"'
  ].join('\n');
}

function renderUntrustDevSigningCertScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [string]$CertificateThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {',
    '  $reportPath = Join-Path $root "dev-signing-cert-report.json"',
    '  if (Test-Path $reportPath) {',
    '    $certReport = Get-Content $reportPath -Raw | ConvertFrom-Json',
    '    $CertificateThumbprint = $certReport.thumbprint',
    '  }',
    '}',
    'if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) { throw "인증서 지문이 필요합니다. -CertificateThumbprint를 전달하거나 dev-signing-cert-report.json을 유지하세요." }',
    '$stores = @(',
    '  @{ Name = "Root"; Location = "CurrentUser" },',
    '  @{ Name = "TrustedPublisher"; Location = "CurrentUser" }',
    ')',
    '$removed = @()',
    'foreach ($storeInfo in $stores) {',
    '  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeInfo.Name, $storeInfo.Location)',
    '  try {',
    '    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)',
    '    $matches = @($store.Certificates | Where-Object { $_.Thumbprint -eq $CertificateThumbprint })',
    '    foreach ($certificate in $matches) { $store.Remove($certificate) }',
    '    $removed += [pscustomobject]@{ store = ("Cert:\\{0}\\{1}" -f $storeInfo.Location, $storeInfo.Name); removedCount = $matches.Count }',
    '  } finally { $store.Close() }',
    '}',
    '$report = [pscustomobject]@{',
    '  reportVersion = "b-pc-agent-dev-signing-untrust-v1"',
    '  status = "removed-current-user-trust"',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  thumbprint = $CertificateThumbprint',
    '  stores = $removed',
    '  scope = "CurrentUser"',
    '}',
    '$untrustReportPath = Join-Path $root "dev-signing-untrust-report.json"',
    '$report | ConvertTo-Json -Depth 8 | Set-Content -Path $untrustReportPath -Encoding UTF8',
    'Write-Host "현재 사용자의 개발용 서명 인증서 신뢰 항목을 제거했습니다: $CertificateThumbprint"',
    'Write-Host "보고서를 저장했습니다: $untrustReportPath"'
  ].join('\n');
}

function renderVerifyReleaseGateScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    'param(',
    '  [switch]$Production',
    ')',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$checks = @()',
    'function Add-Check($id, $status, $detail) {',
    '  $script:checks += [pscustomobject]@{ id = $id; status = $status; detail = $detail }',
    '}',
    'function Read-JsonFile($name) {',
    '  $path = Join-Path $root $name',
    '  if (Test-Path $path) { return Get-Content $path -Raw | ConvertFrom-Json }',
    '  return $null',
    '}',
    'function Add-FileCheck($id, $name, [bool]$Required = $true) {',
    '  $path = Join-Path $root $name',
    '  $status = $(if (Test-Path $path) { "pass" } elseif ($Required) { "fail" } else { "warning" })',
    '  Add-Check $id $status @{ path = $path; file = $name; required = $Required }',
    '}',
    'Write-Host "JARVIS PC 에이전트 릴리스 기준 검증"',
    'Add-FileCheck "package-manifest" "package-manifest.json"',
    'Add-FileCheck "release-manifest" "release-manifest.json"',
    'Add-FileCheck "setup-executable" "JARVIS-PC-Agent-Setup.exe" ([bool]$Production)',
    'Add-FileCheck "tray-executable" "JarvisPcAgentTray.exe"',
    'Add-FileCheck "service-host-executable" "JarvisPcAgentServiceHost.exe"',
    'Add-FileCheck "runtime-integrity-manifest" "runtime-integrity.psd1"',
    '$daemonSmoke = Read-JsonFile "daemon-smoke-report.json"',
    'if (-not $daemonSmoke) {',
    '  Add-Check "daemon-smoke" "fail" @{ message = "daemon-smoke-report.json is missing." }',
    '} else {',
    '  $daemonFailures = @($daemonSmoke.checks | Where-Object { $_.status -ne "pass" })',
    '  Add-Check "daemon-smoke" $(if ($daemonSmoke.status -eq "passed" -and $daemonFailures.Count -eq 0) { "pass" } else { "fail" }) @{ status = $daemonSmoke.status; failedChecks = @($daemonFailures.id) }',
    '}',
    '$queueSoak = Read-JsonFile "queue-soak-report.json"',
    'if (-not $queueSoak) {',
    '  Add-Check "queue-soak" "fail" @{ message = "queue-soak-report.json is missing." }',
    '} else {',
    '  $queueFailures = @($queueSoak.checks | Where-Object { $_.status -ne "pass" })',
    '  Add-Check "queue-soak" $(if ($queueSoak.status -eq "passed" -and $queueFailures.Count -eq 0) { "pass" } else { "fail" }) @{ status = $queueSoak.status; packetCount = $queueSoak.parameters.packetCount; processed = $queueSoak.summary.processed; failedChecks = @($queueFailures.checkId) }',
    '}',
    '$serviceSmoke = Read-JsonFile "service-smoke-report.json"',
    'if (-not $serviceSmoke) {',
    '  Add-Check "installed-service-smoke" "fail" @{ message = "service-smoke-report.json is missing." }',
    '} elseif ($serviceSmoke.status -eq "passed") {',
    '  Add-Check "installed-service-smoke" "pass" @{ status = $serviceSmoke.status }',
    '} elseif ($serviceSmoke.status -eq "passed-with-warnings") {',
    '  Add-Check "installed-service-smoke" "warning" @{ status = $serviceSmoke.status }',
    '} else {',
    '  $failedServiceChecks = @($serviceSmoke.checks | Where-Object { $_.status -eq "fail" })',
    '  Add-Check "installed-service-smoke" "fail" @{ status = $serviceSmoke.status; failedChecks = @($failedServiceChecks.id) }',
    '}',
    '$signatureVerification = Read-JsonFile "signature-verification-report.json"',
    '$productionSigning = Read-JsonFile "production-signing-report.json"',
    'if (-not $signatureVerification) {',
    '  Add-Check "signature-verification" $(if ($Production) { "fail" } else { "warning" }) @{ message = "signature-verification-report.json is missing."; production = [bool]$Production }',
    '} else {',
    '  $signatureResults = @($signatureVerification.results)',
    '  $unsigned = @($signatureResults | Where-Object { -not $_.signer -or -not $_.thumbprintHash -or $_.status -eq "NotSigned" })',
    '  $untrusted = @($signatureResults | Where-Object { $_.status -ne "Valid" })',
    '  Add-Check "signature-artifacts-signed" $(if ($signatureResults.Count -gt 0 -and $unsigned.Count -eq 0) { "pass" } elseif ($Production) { "fail" } else { "warning" }) @{ artifacts = $signatureResults.Count; unsigned = @($unsigned.path); production = [bool]$Production }',
    '  Add-Check "trusted-code-signing" $(if ($untrusted.Count -eq 0) { "pass" } elseif ($Production) { "fail" } else { "warning" }) @{ production = [bool]$Production; untrusted = @($untrusted | ForEach-Object { [pscustomobject]@{ path = $_.path; status = $_.status; signer = $_.signer } }) }',
    '}',
    'if (-not $productionSigning) {',
    '  Add-Check "production-signing-readiness" $(if ($Production) { "fail" } else { "pass" }) @{ message = "production-signing-report.json is missing."; production = [bool]$Production }',
    '} elseif ($Production) {',
    '  Add-Check "production-signing-readiness" $(if ($productionSigning.status -eq "passed") { "pass" } else { "fail" }) @{ status = $productionSigning.status; rawCertificateThumbprintStored = $productionSigning.rawCertificateThumbprintStored; rawPrivateKeyMaterialStored = $productionSigning.rawPrivateKeyMaterialStored }',
    '} else {',
    '  Add-Check "production-signing-readiness" $(if ($productionSigning.status -in @("not-required-local", "passed", "passed-with-warnings")) { "pass" } else { "warning" }) @{ status = $productionSigning.status; rawCertificateThumbprintStored = $productionSigning.rawCertificateThumbprintStored; rawPrivateKeyMaterialStored = $productionSigning.rawPrivateKeyMaterialStored }',
    '}',
    '$releaseEvidence = Read-JsonFile "release-evidence.json"',
    'if ($releaseEvidence) {',
    '  Add-Check "release-evidence" $(if ($releaseEvidence.status -eq "ready") { "pass" } elseif ($releaseEvidence.status -eq "ready-with-warnings") { "warning" } else { "fail" }) @{ status = $releaseEvidence.status; warnings = @($releaseEvidence.warnings) }',
    '} else {',
    '  Add-Check "release-evidence" "warning" @{ message = "release-evidence.json is usually written after this gate." }',
    '}',
    '$failed = @($checks | Where-Object { $_.status -eq "fail" })',
    '$warnings = @($checks | Where-Object { $_.status -eq "warning" })',
    '$report = [pscustomobject]@{',
    '  reportId = "b-pc-agent-release-gate-v1"',
    '  status = $(if ($failed.Count -gt 0) { "failed" } elseif ($warnings.Count -gt 0) { "passed-with-warnings" } else { "passed" })',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  production = [bool]$Production',
    '  checks = $checks',
    '  nextActions = @(',
    '    $(if (@($checks | Where-Object { $_.id -eq "installed-service-smoke" -and $_.status -eq "fail" }).Count -gt 0) { "Run install-all.ps1 from Administrator PowerShell and keep the passing service-smoke-report.json." })',
    '    $(if (@($checks | Where-Object { $_.id -eq "trusted-code-signing" -and $_.status -ne "pass" }).Count -gt 0) { "Use a trusted production code-signing certificate, or run trust-dev-signing-cert.ps1 -TrustCurrentUser for local-only development trust and then rerun verify-signatures.ps1 and verify-release-gate.ps1." })',
    '    $(if (@($checks | Where-Object { $_.id -eq "production-signing-readiness" -and $_.status -ne "pass" }).Count -gt 0) { "Run verify-production-signing.ps1 -Production with a trusted commercial code-signing certificate and timestamped signatures." })',
    '    $(if (@($checks | Where-Object { $_.id -eq "daemon-smoke" -and $_.status -eq "fail" }).Count -gt 0) { "Run npm run pc-agent:daemon-smoke -- --output dist/pc-agent-installer/daemon-smoke-report.json." })',
    '    $(if (@($checks | Where-Object { $_.id -eq "queue-soak" -and $_.status -eq "fail" }).Count -gt 0) { "Run npm run pc-agent:queue-soak -- --output dist/pc-agent-installer/queue-soak-report.json." })',
    '  ) | Where-Object { $_ }',
    '}',
    '$reportPath = Join-Path $root "release-gate-report.json"',
    '$report | ConvertTo-Json -Depth 12 | Set-Content -Path $reportPath -Encoding UTF8',
    'Write-Host "보고서를 저장했습니다: $reportPath"',
    'if ($failed.Count -gt 0) {',
    '  $failed | Format-Table -AutoSize',
    '  exit 1',
    '}',
    'if ($warnings.Count -gt 0) { $warnings | ForEach-Object { Write-Warning "$($_.id): $($_.status)" } }',
    'Write-Host "릴리스 검증 기준을 통과했습니다."'
  ].join('\n');
}

function renderBuildReleaseEvidenceScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'function Read-JsonFile($name) {',
    '  $path = Join-Path $root $name',
    '  if (Test-Path $path) { return Get-Content $path -Raw | ConvertFrom-Json }',
    '  return $null',
    '}',
    'function File-HashRecord($name) {',
    '  $path = Join-Path $root $name',
    '  if (-not (Test-Path $path)) { return [pscustomobject]@{ name = $name; exists = $false } }',
    '  $hash = Get-FileHash $path -Algorithm SHA256',
    '  return [pscustomobject]@{ name = $name; exists = $true; sha256 = $hash.Hash.ToLowerInvariant(); sizeBytes = (Get-Item $path).Length }',
    '}',
    '$makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue',
    'if (-not $makensis) {',
    '  $commonMakensis = @(',
    '    "$env:ProgramFiles\\NSIS\\makensis.exe",',
    '    "${env:ProgramFiles(x86)}\\NSIS\\makensis.exe"',
    '  ) | Where-Object { Test-Path $_ } | Select-Object -First 1',
    '  if ($commonMakensis) { $makensis = [pscustomobject]@{ Source = $commonMakensis } }',
    '}',
    '$certThumbprint = $env:JARVIS_CODE_SIGN_CERT_THUMBPRINT',
    '$artifactNames = @(',
    '  "JarvisPcAgentTray.exe",',
    '  "JarvisPcAgentServiceHost.exe",',
    '  "runtime-integrity.psd1",',
    '  "JARVIS-PC-Agent-Setup.exe",',
    '  "package-manifest.json",',
    '  "release-manifest.json",',
    '  "service-smoke-report.json",',
    '  "daemon-smoke-report.json",',
    '  "queue-soak-report.json",',
    '  "signature-report.json",',
    '  "signature-verification-report.json",',
    '  "production-signing-report.json",',
    '  "production-signing-policy.json",',
    '  "dev-signing-cert-report.json",',
    '  "dev-signing-trust-report.json",',
    '  "release-gate-report.json",',
    '  "install-release-report.json",',
    '  "installer.nsi",',
    '  "build-nsis-installer.ps1",',
    '  "sign-artifacts.ps1",',
    '  "verify-signatures.ps1",',
    '  "trust-dev-signing-cert.ps1",',
    '  "untrust-dev-signing-cert.ps1",',
    '  "verify-installed-service.ps1",',
    '  "install-all.ps1",',
    '  "install-verify-release.ps1",',
    '  "verify-package.ps1",',
    '  "build-tray-exe.ps1",',
    '  "tray-agent.xaml",',
    '  "tray-agent.cs",',
    '  "tray-agent.ps1",',
    '  "launch-tray.ps1",',
    '  "install-service.ps1",',
    '  "uninstall-service.ps1",',
    '  "collect-logs.ps1",',
    '  "tray-state.json",',
    '  "README-install.md"',
    ')',
    '$artifacts = $artifactNames | ForEach-Object { File-HashRecord $_ }',
    '$signatureReport = Read-JsonFile "signature-report.json"',
    '$signatureVerification = Read-JsonFile "signature-verification-report.json"',
    '$productionSigning = Read-JsonFile "production-signing-report.json"',
    '$devSigningTrust = Read-JsonFile "dev-signing-trust-report.json"',
    '$signatureResults = @()',
    'if ($signatureReport -and $signatureReport.results) { $signatureResults = @($signatureReport.results) }',
    '$serviceSmoke = Read-JsonFile "service-smoke-report.json"',
    '$daemonSmoke = Read-JsonFile "daemon-smoke-report.json"',
    '$queueSoak = Read-JsonFile "queue-soak-report.json"',
    '$releaseGate = Read-JsonFile "release-gate-report.json"',
    '$packageManifest = Read-JsonFile "package-manifest.json"',
    '$releaseManifest = Read-JsonFile "release-manifest.json"',
    '$warnings = @()',
    'if (-not $makensis) { $warnings += "NSIS makensis.exe not found; setup executable was not built here." }',
    'if (-not $certThumbprint -and $signatureResults.Count -eq 0) { $warnings += "JARVIS_CODE_SIGN_CERT_THUMBPRINT not set and signature-report.json has no signed artifacts." }',
    'if (-not (Test-Path (Join-Path $root "production-signing-report.json"))) {',
    '  $warnings += "production-signing-report.json is missing until production signing readiness verification runs."',
    '} elseif ($productionSigning.status -notin @("not-required-local", "passed", "passed-with-warnings")) {',
    '  $warnings += "production-signing-report.json status is $($productionSigning.status); production signing readiness has not passed."',
    '}',
    'if (-not (Test-Path (Join-Path $root "JARVIS-PC-Agent-Setup.exe"))) { $warnings += "JARVIS-PC-Agent-Setup.exe is missing." }',
    'if (-not (Test-Path (Join-Path $root "JarvisPcAgentServiceHost.exe"))) { $warnings += "JarvisPcAgentServiceHost.exe is missing." }',
    'if (-not (Test-Path (Join-Path $root "runtime-integrity.psd1"))) { $warnings += "runtime-integrity.psd1 is missing." }',
    'if (-not (Test-Path (Join-Path $root "service-smoke-report.json"))) {',
    '  $warnings += "service-smoke-report.json is missing until installed-service smoke verification runs."',
    '} elseif ($serviceSmoke.status -notin @("passed", "passed-with-warnings")) {',
    '  $warnings += "service-smoke-report.json status is $($serviceSmoke.status); installed-service smoke verification has not passed."',
    '}',
    'if (-not (Test-Path (Join-Path $root "daemon-smoke-report.json"))) {',
    '  $warnings += "daemon-smoke-report.json is missing until user-process daemon smoke verification runs."',
    '} elseif ($daemonSmoke.status -ne "passed") {',
    '  $warnings += "daemon-smoke-report.json status is $($daemonSmoke.status); PC Agent daemon entrypoint smoke has not passed."',
    '}',
    'if (-not (Test-Path (Join-Path $root "queue-soak-report.json"))) {',
    '  $warnings += "queue-soak-report.json is missing until queue soak verification runs."',
    '} elseif ($queueSoak.status -ne "passed") {',
    '  $warnings += "queue-soak-report.json status is $($queueSoak.status); PC Agent queue soak has not passed."',
    '}',
    'if (-not (Test-Path (Join-Path $root "release-gate-report.json"))) {',
    '  $warnings += "release-gate-report.json is missing until release gate verification runs."',
    '} elseif ($releaseGate.status -notin @("passed", "passed-with-warnings")) {',
    '  $warnings += "release-gate-report.json status is $($releaseGate.status); release gate has not passed."',
    '}',
    '$evidence = [pscustomobject]@{',
    '  releaseId = $releaseManifest.releaseId',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  packageManifest = $packageManifest',
    '  releaseManifest = $releaseManifest',
    '  signatureReport = $signatureReport',
    '  signatureVerification = $signatureVerification',
    '  productionSigning = $productionSigning',
    '  devSigningTrust = $devSigningTrust',
    '  serviceSmoke = $serviceSmoke',
    '  daemonSmoke = $daemonSmoke',
    '  queueSoak = $queueSoak',
    '  releaseGate = $releaseGate',
    '  environment = [pscustomobject]@{ makensis = $makensis.Source; codeSigningThumbprint = $certThumbprint }',
    '  artifacts = $artifacts',
    '  warnings = $warnings',
    '  status = $(if ($warnings.Count -gt 0) { "ready-with-warnings" } else { "ready" })',
    '}',
    '$out = Join-Path $root "release-evidence.json"',
    '$evidence | ConvertTo-Json -Depth 12 | Set-Content -Path $out -Encoding UTF8',
    'Write-Host "파일을 저장했습니다: $out"',
    'if ($warnings.Count -gt 0) { $warnings | ForEach-Object { Write-Warning $_ } }'
  ].join('\n');
}

function renderNsisInstallerScript({ serviceManifest,releaseId,distributionFiles,optionalDistributionFiles }) {
  return [
    '; Generated by JARVIS PC Agent installer packager.',
    'Unicode true',
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    '!define MUI_ICON "jarvis.ico"',
    '!define MUI_UNICON "jarvis.ico"',
    '!define APP_NAME "JARVIS PC 에이전트"',
    '!define COMPANY_NAME "Local JARVIS"',
    '!define APP_VERSION "1.0.0"',
    'Name "${APP_NAME}"',
    'OutFile "JARVIS-PC-Agent-Setup.exe"',
    `InstallDir "$PROGRAMFILES64\\JARVIS\\PC-Agent\\releases\\${releaseId}"`,
    'RequestExecutionLevel admin',
    'ShowInstDetails show',
    'ShowUninstDetails show',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_UNPAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "Korean"',
    '',
    'Section "설치"',
    '  InitPluginsDir',
    '  SetOutPath "$PLUGINSDIR"',
    '  File /oname=select-install-folder.ps1 "select-install-folder.ps1"',
    `  nsExec::ExecToStack 'powershell.exe -NoProfile -File "$PLUGINSDIR\\select-install-folder.ps1" -BaseRoot "$PROGRAMFILES64\\JARVIS\\PC-Agent\\releases" -ReleaseId "${releaseId}"'`,
    '  Pop $0',
    '  Pop $1',
    '  ${If} $0 != 0',
    '    MessageBox MB_ICONSTOP|MB_OK "새 설치 폴더를 준비하지 못했습니다. 기존 파일을 보존하고 설치를 중단합니다."',
    '    Abort',
    '  ${EndIf}',
    '  StrCpy $INSTDIR $1',
    '  IfFileExists "$INSTDIR\\package-manifest.json" existing_code',
    '  IfFileExists "$INSTDIR\\JarvisPcAgentServiceHost.exe" existing_code fresh_install',
    'existing_code:',
    '  MessageBox MB_ICONSTOP|MB_OK "기존 설치 파일을 덮어쓰지 않습니다. 새 버전 폴더에서 검증된 업데이트 절차를 사용하세요."',
    '  Abort',
    'fresh_install:',
    '  SetOutPath "$INSTDIR"',
    ...renderNsisFileLayout({files:distributionFiles,optionalFiles:optionalDistributionFiles}),
    '  DetailPrint "패키지와 실행 파일 무결성을 확인하고 있습니다..."',
    '  ExecWait \'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\\verify-package.ps1"\' $0',
    '  ${If} $0 != 0',
    '    MessageBox MB_ICONSTOP|MB_OK "패키지 무결성 검증에 실패했습니다. 설치를 중단합니다."',
    '    Abort',
    '  ${EndIf}',
    "  DetailPrint \"서비스와 기존 실행 설정을 확인하고 있습니다...\"",
    "  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$INSTDIR\\install-all.ps1\"' $0",
    "  ${If} $0 != 0",
    "    MessageBox MB_ICONSTOP|MB_OK \"설치 또는 업데이트에 실패했습니다. 기존 서비스와 복구 기록을 확인하세요.\"",
    "    Abort",
    "  ${EndIf}",
    "  CreateShortCut \"$SMPROGRAMS\\JARVIS PC Agent.lnk\" \"$INSTDIR\\JarvisPcAgentTray.exe\" \"\" \"$INSTDIR\\JarvisPcAgentTray.exe\" 0",
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    `  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${serviceManifest.serviceName}" "DisplayName" "\${APP_NAME}"`,
    `  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${serviceManifest.serviceName}" "UninstallString" "$INSTDIR\\Uninstall.exe"`,
    'SectionEnd',
    '',
    'Section "Uninstall"',
    '  DetailPrint "JARVIS PC 에이전트를 제거하고 있습니다..."',
    '  ExecWait \'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\\uninstall-service.ps1"\' $0',
    '  ${If} $0 != 0',
    '    MessageBox MB_ICONSTOP|MB_OK "현재 활성 버전과 다르거나 서비스 제거가 실패했습니다. 기존 설치를 보존합니다."',
    '    Abort',
    '  ${EndIf}',
    '  ExecWait \'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\\uninstall-tray-shortcut.ps1"\'',
    '  Delete "$SMPROGRAMS\\JARVIS PC Agent.lnk"',
    '  Delete "$INSTDIR\\Uninstall.exe"',
    '  RMDir /r "$INSTDIR"',
    `  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${serviceManifest.serviceName}"`,
    'SectionEnd'
  ].join('\n');
}

function renderBuildNsisInstallerScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'foreach ($name in @("JarvisPcAgentTray.exe", "JarvisPcAgentServiceHost.exe", "runtime-integrity.psd1", "verify-package.ps1")) {',
    '  if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { throw "설치 파일 생성 전 필수 자료가 없습니다: $name" }',
    '}',
    '# Validate current source and signed runtime before invoking the compiler.',
    '# An older Setup may be present; it is not the artifact being built now.',
    '& (Join-Path $root "verify-package.ps1") -RuntimeOnly',
    '$makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue',
    'if (-not $makensis) {',
    '  $common = @(',
    '    "$env:ProgramFiles\\NSIS\\makensis.exe",',
    '    "${env:ProgramFiles(x86)}\\NSIS\\makensis.exe"',
    '  ) | Where-Object { Test-Path $_ } | Select-Object -First 1',
    '  if ($common) { $makensis = [pscustomobject]@{ Source = $common } }',
    '}',
    'if (-not $makensis) { throw "NSIS makensis.exe를 찾을 수 없습니다. JARVIS-PC-Agent-Setup.exe를 만들려면 NSIS를 설치하세요." }',
    '& $makensis.Source (Join-Path $root "installer.nsi")',
    'if ($LASTEXITCODE -ne 0) { throw "NSIS 설치 파일 생성에 실패했습니다. 종료 코드: $LASTEXITCODE" }',
    '$setupPath = Join-Path $root "JARVIS-PC-Agent-Setup.exe"',
    'if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw "NSIS가 성공을 반환했지만 설치 파일이 없습니다: $setupPath" }',
    'Write-Host "NSIS 설치 파일을 만들었습니다: $setupPath"'
  ].join('\n');
}

function renderReleaseManifest({ serviceManifest }) {
  return JSON.stringify({
    releaseId: 'jarvis-pc-agent-win32-1.0.0',
    serviceName: serviceManifest.serviceName,
    version: '1.0.0',
    platform: 'win32',
    signableArtifacts: [
      'JarvisPcAgentTray.exe',
      'JarvisPcAgentServiceHost.exe',
      'runtime-integrity.psd1',
      'JARVIS-PC-Agent-Setup.exe'
    ],
    requiredReleaseSteps: [
      'verify-package.ps1',
      'build-tray-exe.ps1',
      'build-service-host.ps1',
      'build-nsis-installer.ps1',
      'sign-artifacts.ps1',
      'verify-production-signing.ps1',
      'trust-dev-signing-cert.ps1',
      'untrust-dev-signing-cert.ps1',
      'verify-signatures.ps1',
      'verify-release-gate.ps1',
      'install-all.ps1',
      'install-verify-release.ps1',
      'verify-installed-service.ps1'
    ],
    reports: [
      'signature-report.json',
      'signature-verification-report.json',
      'production-signing-report.json',
      'production-signing-policy.json',
      'dev-signing-trust-report.json',
      'daemon-smoke-report.json',
      'queue-soak-report.json',
      'release-gate-report.json',
      'install-release-report.json',
      'service-smoke-report.json'
    ]
  }, null, 2);
}

function renderTrayAgentScript({ endpoint }) {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$statePath = Join-Path $root "tray-state.json"',
    '$state = Get-Content $statePath | ConvertFrom-Json',
    '$icon = New-Object System.Windows.Forms.NotifyIcon',
    '$icon.Icon = [System.Drawing.SystemIcons]::Shield',
    '$icon.Text = "JARVIS PC 에이전트"',
    '$icon.Visible = $true',
    '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
    'function Add-MenuItem($label, $scriptName, $elevated) {',
    '  $item = New-Object System.Windows.Forms.ToolStripMenuItem',
    '  $item.Text = $label',
    '  $item.Add_Click({',
    '    $scriptPath = Join-Path $root $scriptName',
    '    if ($elevated) {',
    '      Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$scriptPath`"")',
    '    } else {',
    '      Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$scriptPath`"")',
    '    }',
    '  }.GetNewClosure())',
    '  [void]$menu.Items.Add($item)',
    '}',
    `Add-MenuItem "서비스 상태 확인" "status-service.ps1" $false`,
    'Add-MenuItem "에이전트 시작" "start-service.ps1" $true',
    'Add-MenuItem "에이전트 중지" "stop-service.ps1" $true',
    'Add-MenuItem "에이전트 다시 시작" "restart-service.ps1" $true',
    'Add-MenuItem "에이전트 업데이트" "update-service.ps1" $true',
    'Add-MenuItem "진단 기록 수집" "collect-logs.ps1" $false',
    'Add-MenuItem "설치 패키지 검증" "verify-package.ps1" $false',
    '$openEndpoint = New-Object System.Windows.Forms.ToolStripMenuItem',
    '$openEndpoint.Text = "로컬 접속 주소 열기"',
    `$openEndpoint.Add_Click({ Start-Process "${endpoint}/health" })`,
    '[void]$menu.Items.Add($openEndpoint)',
    '$exit = New-Object System.Windows.Forms.ToolStripMenuItem',
    '$exit.Text = "트레이 종료"',
    '$exit.Add_Click({ $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })',
    '[void]$menu.Items.Add($exit)',
    '$icon.ContextMenuStrip = $menu',
    '$icon.BalloonTipTitle = "JARVIS PC 에이전트"',
    '$icon.BalloonTipText = "로컬 PC 에이전트 트레이가 실행 중입니다."',
    '$icon.ShowBalloonTip(2000)',
    '[System.Windows.Forms.Application]::Run()'
  ].join('\n');
}

function renderTrayAgentSource({ endpoint, serviceName, displayName }) {
  return String.raw`// Generated by JARVIS PC Agent installer packager.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public sealed class AgentSnapshot {
  public string ServiceState = "확인 중";
  public bool ServiceInstalled;
  public bool ServiceRunning;
  public bool ApiHealthy;
  public string CheckedAt = "-";
}

public sealed class ScriptResult {
  public int ExitCode;
  public string Output = "";
  public string Error = "";
}

public sealed class AgentControlForm : Form {
  private static readonly Color Canvas = Color.FromArgb(13, 16, 19);
  private static readonly Color Surface = Color.FromArgb(20, 24, 28);
  private static readonly Color SurfaceRaised = Color.FromArgb(28, 33, 38);
  private static readonly Color Line = Color.FromArgb(57, 65, 72);
  private static readonly Color TextPrimary = Color.FromArgb(241, 244, 246);
  private static readonly Color TextMuted = Color.FromArgb(158, 169, 178);
  private static readonly Color Accent = Color.FromArgb(48, 201, 148);
  private static readonly Color Attention = Color.FromArgb(244, 183, 64);
  private static readonly Color Danger = Color.FromArgb(235, 104, 104);

  private readonly string root;
  private readonly string endpoint;
  private readonly string serviceName;
  private readonly Action<string, string, ToolTipIcon> notify;
  private readonly Label overallValue;
  private readonly Label serviceValue;
  private readonly Label apiValue;
  private readonly Label checkedValue;
  private readonly Label endpointValue;
  private readonly Label serviceControlHint;
  private readonly Label footerStatus;
  private readonly TextBox activityLog;
  private readonly ProgressBar progress;
  private readonly Button startButton;
  private readonly Button stopButton;
  private readonly Button restartButton;
  private readonly Button updateButton;
  private readonly Button collectButton;
  private readonly Button verifyButton;
  private readonly ToolTip toolTip;
  private readonly System.Windows.Forms.Timer refreshTimer;
  private bool busy;
  private bool refreshing;
  private bool allowClose;
  private AgentSnapshot snapshot = new AgentSnapshot();

  public event EventHandler StatusChanged;

  public bool IsAgentAvailable {
    get { return snapshot.ServiceRunning || snapshot.ApiHealthy; }
  }

  public AgentControlForm(string rootPath, string endpointValueText, string serviceNameValue, string displayNameValue, Action<string, string, ToolTipIcon> notification) {
    root = rootPath;
    endpoint = endpointValueText;
    serviceName = serviceNameValue;
    notify = notification;

    Text = "JARVIS PC 에이전트";
    Icon = SystemIcons.Shield;
    BackColor = Canvas;
    ForeColor = TextPrimary;
    Font = new Font("맑은 고딕", 9F, FontStyle.Regular, GraphicsUnit.Point);
    StartPosition = FormStartPosition.CenterScreen;
    AutoScaleDimensions = new SizeF(96F, 96F);
    AutoScaleMode = AutoScaleMode.Dpi;
    ClientSize = new Size(920, 720);
    MinimumSize = new Size(900, 650);
    Padding = new Padding(0);
    DoubleBuffered = true;

    toolTip = new ToolTip();
    toolTip.AutoPopDelay = 8000;
    toolTip.InitialDelay = 450;
    toolTip.ReshowDelay = 100;

    var layout = new TableLayoutPanel();
    layout.Dock = DockStyle.Fill;
    layout.BackColor = Canvas;
    layout.Padding = new Padding(24, 20, 24, 18);
    layout.ColumnCount = 1;
    layout.RowCount = 6;
    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 86F));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 116F));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 124F));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 124F));
    layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44F));
    Controls.Add(layout);

    var header = CreateHeader(displayNameValue);
    overallValue = new Label();
    overallValue.Text = "상태 확인 중";
    overallValue.AutoSize = false;
    overallValue.TextAlign = ContentAlignment.MiddleRight;
    overallValue.Dock = DockStyle.Fill;
    overallValue.Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold, GraphicsUnit.Point);
    overallValue.ForeColor = Attention;
    header.Controls.Add(overallValue, 1, 0);
    layout.Controls.Add(header, 0, 0);

    serviceValue = CreateMetricValue("확인 중");
    apiValue = CreateMetricValue("확인 중");
    checkedValue = CreateMetricValue("-");
    endpointValue = CreateMetricValue(endpoint);
    layout.Controls.Add(CreateStatusSection(), 0, 1);

    startButton = CreateActionButton("에이전트 시작", Accent, delegate { StartOrInstallAgent(); });
    stopButton = CreateActionButton("에이전트 중지", SurfaceRaised, delegate { StopInstalledAgent(); });
    restartButton = CreateActionButton("다시 시작", SurfaceRaised, delegate { RestartInstalledAgent(); });
    updateButton = CreateActionButton("업데이트", SurfaceRaised, delegate { UpdateInstalledAgent(); });
    serviceControlHint = CreateLabel("Windows 서비스 상태를 확인하고 있습니다.", 8.5F, FontStyle.Regular, TextMuted);
    layout.Controls.Add(CreateActionSection(), 0, 2);

    collectButton = CreateActionButton("진단 기록 수집", SurfaceRaised, delegate { RunScript("진단 기록 수집", "collect-logs.ps1", false); });
    verifyButton = CreateActionButton("설치 패키지 검증", SurfaceRaised, delegate { RunScript("설치 패키지 검증", "verify-package.ps1", false); });
    layout.Controls.Add(CreateToolSection(), 0, 3);

    activityLog = new TextBox();
    activityLog.Dock = DockStyle.Fill;
    activityLog.Multiline = true;
    activityLog.ReadOnly = true;
    activityLog.ScrollBars = ScrollBars.Vertical;
    activityLog.BorderStyle = BorderStyle.None;
    activityLog.BackColor = SurfaceRaised;
    activityLog.ForeColor = TextMuted;
    activityLog.Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point);
    activityLog.Margin = new Padding(4, 0, 4, 4);
    activityLog.WordWrap = true;
    layout.Controls.Add(CreateLogSection(), 0, 4);

    var footer = new Panel();
    footer.Dock = DockStyle.Fill;
    footer.Margin = new Padding(0, 8, 0, 0);
    footer.Padding = new Padding(14, 6, 14, 6);
    footer.BackColor = SurfaceRaised;
    footerStatus = CreateLabel("준비됨", 8.5F, FontStyle.Regular, TextMuted);
    footerStatus.Dock = DockStyle.Fill;
    progress = new ProgressBar();
    progress.Style = ProgressBarStyle.Marquee;
    progress.MarqueeAnimationSpeed = 25;
    progress.Width = 148;
    progress.Dock = DockStyle.Right;
    progress.Visible = false;
    footer.Controls.Add(footerStatus);
    footer.Controls.Add(progress);
    layout.Controls.Add(footer, 0, 5);

    FormClosing += OnFormClosing;
    Shown += delegate { AppendLog("제어 패널을 열었습니다."); BeginRefresh(); };
    refreshTimer = new System.Windows.Forms.Timer();
    refreshTimer.Interval = 4000;
    refreshTimer.Tick += delegate { BeginRefresh(); };
    refreshTimer.Start();
  }

  private TableLayoutPanel CreateHeader(string displayNameValue) {
    var header = new TableLayoutPanel();
    header.Dock = DockStyle.Fill;
    header.Margin = new Padding(0, 0, 0, 8);
    header.ColumnCount = 2;
    header.RowCount = 1;
    header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
    header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
    header.Padding = new Padding(14, 8, 12, 8);

    var identity = new Panel();
    identity.Dock = DockStyle.Fill;
    var title = CreateLabel("JARVIS PC 에이전트", 17F, FontStyle.Bold, TextPrimary);
    title.Dock = DockStyle.Top;
    title.Height = 34;
    var subtitle = CreateLabel(displayNameValue + "  |  로컬 실행 관리자", 8.5F, FontStyle.Regular, TextMuted);
    subtitle.Dock = DockStyle.Top;
    subtitle.Height = 22;
    identity.Controls.Add(subtitle);
    identity.Controls.Add(title);
    header.Controls.Add(identity, 0, 0);
    return header;
  }

  private Control CreateStatusSection() {
    var panel = new Panel();
    panel.Dock = DockStyle.Fill;
    panel.Padding = new Padding(8);
    panel.Margin = new Padding(0, 0, 0, 8);
    panel.BackColor = Surface;

    var metrics = new TableLayoutPanel();
    metrics.Dock = DockStyle.Fill;
    metrics.ColumnCount = 4;
    metrics.RowCount = 1;
    metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22F));
    metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20F));
    metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24F));
    metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34F));
    metrics.Controls.Add(CreateMetric("Windows 서비스", serviceValue), 0, 0);
    metrics.Controls.Add(CreateMetric("로컬 API", apiValue), 1, 0);
    metrics.Controls.Add(CreateMetric("마지막 확인", checkedValue), 2, 0);
    metrics.Controls.Add(CreateMetric("접속 주소", endpointValue), 3, 0);
    panel.Controls.Add(metrics);
    return panel;
  }

  private Control CreateActionSection() {
    var panel = CreateSectionPanel("Windows 서비스", serviceControlHint);
    var grid = CreateButtonGrid(4);
    grid.Controls.Add(startButton, 0, 0);
    grid.Controls.Add(stopButton, 1, 0);
    grid.Controls.Add(restartButton, 2, 0);
    grid.Controls.Add(updateButton, 3, 0);
    panel.Controls.Add(grid, 0, 2);
    return panel;
  }

  private Control CreateToolSection() {
    var subtitle = CreateLabel("운영 · 진단 · 설치", 8.5F, FontStyle.Regular, TextMuted);
    var panel = CreateSectionPanel("관리 도구", subtitle);
    var grid = CreateButtonGrid(5);
    var consoleButton = CreateActionButton("JARVIS 제어 센터", Accent, delegate { OpenControlCenter(); });
    var healthButton = CreateActionButton("상태 세부정보", SurfaceRaised, delegate { ShowStatusDetails(); });
    var folderButton = CreateActionButton("설치 폴더", SurfaceRaised, delegate { OpenInstallFolder(); });
    toolTip.SetToolTip(consoleButton, "JARVIS 제어 센터를 엽니다.");
    toolTip.SetToolTip(healthButton, "현재 서비스 및 로컬 API 상태를 확인합니다.");
    toolTip.SetToolTip(collectButton, "지원용 진단 묶음을 로컬에 생성합니다.");
    toolTip.SetToolTip(verifyButton, "설치 파일의 무결성을 검사합니다.");
    toolTip.SetToolTip(folderButton, "PC 에이전트 설치 폴더를 엽니다.");
    grid.Controls.Add(consoleButton, 0, 0);
    grid.Controls.Add(healthButton, 1, 0);
    grid.Controls.Add(collectButton, 2, 0);
    grid.Controls.Add(verifyButton, 3, 0);
    grid.Controls.Add(folderButton, 4, 0);
    panel.Controls.Add(grid, 0, 2);
    return panel;
  }

  private TableLayoutPanel CreateSectionPanel(string titleText, Label subtitle) {
    var panel = new TableLayoutPanel();
    panel.Dock = DockStyle.Fill;
    panel.Padding = new Padding(16, 10, 16, 10);
    panel.Margin = new Padding(0, 0, 0, 8);
    panel.BackColor = Surface;
    panel.ColumnCount = 1;
    panel.RowCount = 3;
    panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
    panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24F));
    panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 18F));
    panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    var title = CreateLabel(titleText, 10.5F, FontStyle.Bold, TextPrimary);
    title.Dock = DockStyle.Fill;
    panel.Controls.Add(title, 0, 0);
    subtitle.Dock = DockStyle.Fill;
    panel.Controls.Add(subtitle, 0, 1);
    return panel;
  }

  private static TableLayoutPanel CreateButtonGrid(int columns) {
    var grid = new TableLayoutPanel();
    grid.Dock = DockStyle.Fill;
    grid.Margin = new Padding(0);
    grid.Padding = new Padding(0);
    grid.ColumnCount = columns;
    grid.RowCount = 1;
    grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    for (var index = 0; index < columns; index++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / columns));
    return grid;
  }

  private static Control CreateMetric(string titleText, Label value) {
    var panel = new Panel();
    panel.Dock = DockStyle.Fill;
    panel.Margin = new Padding(4);
    panel.Padding = new Padding(12, 7, 12, 7);
    panel.BackColor = SurfaceRaised;
    var title = CreateLabel(titleText, 8F, FontStyle.Regular, TextMuted);
    title.Dock = DockStyle.Top;
    title.Height = 22;
    value.Dock = DockStyle.Fill;
    panel.Controls.Add(value);
    panel.Controls.Add(title);
    return panel;
  }

  private static Label CreateMetricValue(string text) {
    var label = CreateLabel(text, 10.5F, FontStyle.Bold, TextPrimary);
    label.AutoEllipsis = true;
    return label;
  }

  private static Label CreateLabel(string text, float size, FontStyle style, Color color) {
    var label = new Label();
    label.Text = text;
    label.ForeColor = color;
    label.BackColor = Color.Transparent;
    label.Font = new Font("맑은 고딕", size, style, GraphicsUnit.Point);
    label.AutoSize = false;
    label.TextAlign = ContentAlignment.MiddleLeft;
    return label;
  }

  private static Button CreateActionButton(string text, Color backColor, EventHandler action) {
    var button = new Button();
    button.Text = text;
    button.Dock = DockStyle.Fill;
    button.Margin = new Padding(4, 3, 4, 3);
    button.FlatStyle = FlatStyle.Flat;
    button.FlatAppearance.BorderColor = backColor == Accent ? Accent : Line;
    button.FlatAppearance.BorderSize = 1;
    button.FlatAppearance.MouseOverBackColor = backColor == Accent ? Color.FromArgb(62, 218, 162) : Color.FromArgb(36, 42, 48);
    button.FlatAppearance.MouseDownBackColor = backColor == Accent ? Color.FromArgb(41, 181, 133) : Color.FromArgb(23, 28, 33);
    button.BackColor = backColor;
    button.ForeColor = backColor == Accent ? Canvas : TextPrimary;
    button.Font = new Font("맑은 고딕", 9F, FontStyle.Bold, GraphicsUnit.Point);
    button.TextAlign = ContentAlignment.MiddleCenter;
    button.AutoEllipsis = true;
    button.UseVisualStyleBackColor = false;
    button.Cursor = Cursors.Hand;
    button.Click += action;
    return button;
  }

  private Control CreateLogSection() {
    var section = new TableLayoutPanel();
    section.Dock = DockStyle.Fill;
    section.Margin = new Padding(0);
    section.Padding = new Padding(12, 8, 12, 10);
    section.BackColor = Surface;
    section.ColumnCount = 1;
    section.RowCount = 2;
    section.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
    section.RowStyles.Add(new RowStyle(SizeType.Absolute, 34F));
    section.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

    var heading = new TableLayoutPanel();
    heading.Dock = DockStyle.Fill;
    heading.Margin = new Padding(4, 0, 4, 4);
    heading.ColumnCount = 2;
    heading.RowCount = 1;
    heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
    heading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 72F));
    var logTitle = CreateLabel("작업 기록", 10.5F, FontStyle.Bold, TextPrimary);
    logTitle.Dock = DockStyle.Fill;
    var clearButton = new Button();
    clearButton.Text = "지우기";
    clearButton.Dock = DockStyle.Fill;
    clearButton.Margin = new Padding(4, 0, 0, 2);
    clearButton.FlatStyle = FlatStyle.Flat;
    clearButton.FlatAppearance.BorderColor = Line;
    clearButton.FlatAppearance.BorderSize = 1;
    clearButton.BackColor = SurfaceRaised;
    clearButton.ForeColor = TextMuted;
    clearButton.Font = new Font("맑은 고딕", 8F, FontStyle.Regular, GraphicsUnit.Point);
    clearButton.Cursor = Cursors.Hand;
    clearButton.Click += delegate { activityLog.Clear(); footerStatus.Text = "작업 기록을 지웠습니다."; };
    heading.Controls.Add(logTitle, 0, 0);
    heading.Controls.Add(clearButton, 1, 0);
    section.Controls.Add(heading, 0, 0);
    section.Controls.Add(activityLog, 0, 1);
    return section;
  }

  public void ShowPanel() {
    ShowInTaskbar = true;
    if (!Visible) Show();
    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
    Activate();
    BringToFront();
    BeginRefresh();
  }

  public void CloseForExit() {
    allowClose = true;
    refreshTimer.Stop();
    Close();
  }

  public void StartAgent() { ShowPanel(); StartOrInstallAgent(); }
  public void StopAgent() { ShowPanel(); StopInstalledAgent(); }
  public void RestartAgent() { ShowPanel(); RestartInstalledAgent(); }
  public void UpdateAgent() { ShowPanel(); UpdateInstalledAgent(); }

  private void StartOrInstallAgent() {
    if (!snapshot.ServiceInstalled) {
      RunScript("에이전트 서비스 설치", "install-service.ps1", true);
      return;
    }
    if (snapshot.ServiceRunning) {
      ShowInformation("에이전트 시작", "Windows 서비스가 이미 실행 중입니다.");
      return;
    }
    if (snapshot.ApiHealthy) {
      ShowInformation("에이전트 시작", "로컬 PC 에이전트가 개발 런타임으로 이미 실행 중입니다. 같은 포트를 사용하는 Windows 서비스를 동시에 시작할 수 없습니다.");
      return;
    }
    RunScript("에이전트 시작", "start-service.ps1", true);
  }

  private void StopInstalledAgent() {
    if (!RequireInstalledService("에이전트 중지")) return;
    if (!snapshot.ServiceRunning) {
      ShowInformation("에이전트 중지", "Windows 서비스가 이미 중지되어 있습니다.");
      return;
    }
    RunScript("에이전트 중지", "stop-service.ps1", true);
  }

  private void RestartInstalledAgent() {
    if (!RequireInstalledService("에이전트 다시 시작")) return;
    if (!snapshot.ServiceRunning && snapshot.ApiHealthy) {
      ShowInformation("에이전트 다시 시작", "현재 연결된 것은 Windows 서비스가 아닌 개발 런타임입니다. 제어 센터를 계속 사용할 수 있으며 Windows 서비스와 동시에 실행할 수 없습니다.");
      return;
    }
    RunScript("에이전트 다시 시작", "restart-service.ps1", true);
  }

  private void UpdateInstalledAgent() {
    if (!RequireInstalledService("에이전트 업데이트")) return;
    if (!snapshot.ServiceRunning && snapshot.ApiHealthy) {
      ShowInformation("에이전트 업데이트", "개발 런타임이 같은 포트를 사용 중입니다. Windows 서비스 업데이트를 실행하기 전에 개발 런타임을 종료해 주세요.");
      return;
    }
    RunScript("에이전트 업데이트", "update-service.ps1", true);
  }

  private bool RequireInstalledService(string actionName) {
    if (snapshot.ServiceInstalled) return true;
    ShowInformation(actionName, "Windows 서비스가 아직 설치되지 않았습니다. 먼저 '서비스 설치'를 실행해 주세요. 현재 연결된 개발 런타임에는 영향을 주지 않습니다.");
    return false;
  }

  private void OnFormClosing(object sender, FormClosingEventArgs eventArgs) {
    if (allowClose || eventArgs.CloseReason == CloseReason.WindowsShutDown) return;
    eventArgs.Cancel = true;
    Hide();
    ShowInTaskbar = false;
    footerStatus.Text = "트레이에서 계속 실행 중";
  }

  private void BeginRefresh() {
    if (refreshing || IsDisposed) return;
    refreshing = true;
    var worker = new BackgroundWorker();
    worker.DoWork += delegate(object sender, DoWorkEventArgs args) { args.Result = ReadSnapshot(); };
    worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs args) {
      refreshing = false;
      if (IsDisposed) return;
      if (args.Error != null) {
        footerStatus.Text = "상태 확인 실패";
        AppendLog("상태 확인 실패: " + FriendlyError(args.Error));
        return;
      }
      ApplySnapshot((AgentSnapshot)args.Result);
    };
    worker.RunWorkerAsync();
  }

  private AgentSnapshot ReadSnapshot() {
    var next = new AgentSnapshot();
    next.CheckedAt = DateTime.Now.ToString("tt h:mm:ss");
    try {
      using (var service = new ServiceController(serviceName)) {
        service.Refresh();
        next.ServiceInstalled = true;
        next.ServiceState = TranslateServiceState(service.Status);
        next.ServiceRunning = service.Status == ServiceControllerStatus.Running;
      }
    } catch {
      next.ServiceInstalled = false;
      next.ServiceState = "설치되지 않음";
      next.ServiceRunning = false;
    }
    try {
      var request = (HttpWebRequest)WebRequest.Create(endpoint + "/health");
      request.Method = "GET";
      request.Timeout = 1200;
      request.ReadWriteTimeout = 1200;
      request.Proxy = null;
      using (var response = (HttpWebResponse)request.GetResponse()) {
        next.ApiHealthy = (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
      }
    } catch {
      next.ApiHealthy = false;
    }
    return next;
  }

  private void ApplySnapshot(AgentSnapshot next) {
    snapshot = next;
    startButton.Text = next.ServiceInstalled ? "에이전트 시작" : "서비스 설치";
    serviceValue.Text = next.ServiceState;
    serviceValue.ForeColor = next.ServiceRunning ? Accent : TextPrimary;
    apiValue.Text = next.ApiHealthy ? "연결됨" : "응답 없음";
    apiValue.ForeColor = next.ApiHealthy ? Accent : Danger;
    checkedValue.Text = next.CheckedAt;
    endpointValue.Text = endpoint.Replace("http://", "");
    if (next.ServiceInstalled) {
      serviceControlHint.Text = next.ServiceRunning ? "설치됨 · 실행 중" : "설치됨 · 현재 중지됨";
      toolTip.SetToolTip(stopButton, "Windows 서비스를 중지합니다.");
      toolTip.SetToolTip(restartButton, "Windows 서비스를 안전하게 다시 시작합니다.");
      toolTip.SetToolTip(updateButton, "설치 파일을 검증한 뒤 서비스를 업데이트합니다.");
    } else {
      serviceControlHint.Text = next.ApiHealthy ? "개발 런타임 연결됨 · Windows 서비스 미설치" : "Windows 서비스 미설치";
      toolTip.SetToolTip(stopButton, "Windows 서비스 설치 후 사용할 수 있습니다.");
      toolTip.SetToolTip(restartButton, "Windows 서비스 설치 후 사용할 수 있습니다.");
      toolTip.SetToolTip(updateButton, "Windows 서비스 설치 후 사용할 수 있습니다.");
    }

    if (next.ApiHealthy) {
      overallValue.Text = next.ServiceRunning ? "정상 작동 중" : "로컬 런타임 연결됨";
      overallValue.ForeColor = Accent;
      footerStatus.Text = "로컬 PC 작업을 실행할 수 있습니다.";
    } else if (next.ServiceRunning) {
      overallValue.Text = "서비스 시작 중";
      overallValue.ForeColor = Attention;
      footerStatus.Text = "로컬 API 응답을 기다리고 있습니다.";
    } else {
      overallValue.Text = "에이전트 중지됨";
      overallValue.ForeColor = Danger;
      footerStatus.Text = "에이전트를 시작하면 PC 작업을 사용할 수 있습니다.";
    }
    ApplyActionAvailability();
    var changed = StatusChanged;
    if (changed != null) changed(this, EventArgs.Empty);
  }

  private void ApplyActionAvailability() {
    startButton.Enabled = !busy;
    stopButton.Enabled = !busy;
    restartButton.Enabled = !busy;
    updateButton.Enabled = !busy;
    collectButton.Enabled = !busy;
    verifyButton.Enabled = !busy;
  }

  private void RunScript(string actionName, string scriptName, bool elevated) {
    if (busy) {
      footerStatus.Text = "현재 작업이 끝날 때까지 기다려 주세요.";
      return;
    }
    var scriptPath = Path.Combine(root, scriptName);
    if (!File.Exists(scriptPath)) {
      ShowFailure(actionName, "필요한 작업 파일을 찾지 못했습니다: " + scriptName);
      return;
    }
    busy = true;
    progress.Visible = true;
    footerStatus.Text = actionName + " 처리 중";
    AppendLog(actionName + " 작업을 시작했습니다." + (elevated ? " Windows 권한 확인이 표시될 수 있습니다." : ""));
    ApplyActionAvailability();

    var worker = new BackgroundWorker();
    worker.DoWork += delegate(object sender, DoWorkEventArgs args) {
      args.Result = ExecuteScript(scriptPath, elevated);
    };
    worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs args) {
      busy = false;
      progress.Visible = false;
      if (args.Error != null) {
        ShowFailure(actionName, FriendlyError(args.Error));
      } else {
        var result = (ScriptResult)args.Result;
        if (result.ExitCode == 0) {
          AppendLog(actionName + " 작업을 완료했습니다.");
          AppendOutput(result.Output);
          footerStatus.Text = actionName + " 완료";
          notify("작업 완료", actionName + " 작업을 마쳤습니다.", ToolTipIcon.Info);
        } else {
          var detail = String.IsNullOrWhiteSpace(result.Error) ? "종료 코드 " + result.ExitCode : result.Error.Trim();
          ShowFailure(actionName, detail);
        }
      }
      BeginRefresh();
      ApplyActionAvailability();
    };
    worker.RunWorkerAsync();
  }

  private ScriptResult ExecuteScript(string scriptPath, bool elevated) {
    var result = new ScriptResult();
    var startInfo = new ProcessStartInfo();
    startInfo.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
    startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + scriptPath + "\"";
    startInfo.WorkingDirectory = root;
    startInfo.WindowStyle = ProcessWindowStyle.Hidden;
    if (elevated) {
      startInfo.UseShellExecute = true;
      startInfo.Verb = "runas";
    } else {
      startInfo.UseShellExecute = false;
      startInfo.CreateNoWindow = true;
      startInfo.RedirectStandardOutput = true;
      startInfo.RedirectStandardError = true;
      startInfo.StandardOutputEncoding = Encoding.Default;
      startInfo.StandardErrorEncoding = Encoding.Default;
      startInfo.EnvironmentVariables["PSModulePath"] = String.Join(";", new[] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "WindowsPowerShell", "Modules"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Microsoft", "Windows", "PowerShell", "Modules"),
        Path.Combine(Path.GetDirectoryName(startInfo.FileName), "Modules")
      });
    }
    using (var process = new Process()) {
      process.StartInfo = startInfo;
      process.Start();
      if (!elevated) {
        result.Output = process.StandardOutput.ReadToEnd();
        result.Error = process.StandardError.ReadToEnd();
      }
      process.WaitForExit();
      result.ExitCode = process.ExitCode;
    }
    return result;
  }

  private void ShowFailure(string actionName, string detail) {
    busy = false;
    progress.Visible = false;
    footerStatus.Text = actionName + " 실패";
    AppendLog(actionName + " 실패: " + detail);
    notify("작업 확인 필요", actionName + " 작업을 완료하지 못했습니다.", ToolTipIcon.Warning);
    MessageBox.Show(this, detail, actionName + " 실패", MessageBoxButtons.OK, MessageBoxIcon.Warning);
  }

  private void ShowInformation(string actionName, string detail) {
    footerStatus.Text = detail;
    AppendLog(actionName + ": " + detail);
    MessageBox.Show(this, detail, actionName, MessageBoxButtons.OK, MessageBoxIcon.Information);
  }

  private void ShowStatusDetails() {
    var runtimeMode = snapshot.ServiceInstalled ? "Windows 서비스" : (snapshot.ApiHealthy ? "개발 런타임" : "중지됨");
    var detail = String.Join(Environment.NewLine, new[] {
      "실행 형태       " + runtimeMode,
      "Windows 서비스  " + snapshot.ServiceState,
      "로컬 API        " + (snapshot.ApiHealthy ? "연결됨" : "응답 없음"),
      "접속 주소       " + endpoint,
      "마지막 확인     " + snapshot.CheckedAt
    });
    footerStatus.Text = "상태 세부정보를 확인했습니다.";
    AppendLog("상태 세부정보를 확인했습니다.");
    MessageBox.Show(this, detail, "PC 에이전트 상태", MessageBoxButtons.OK, snapshot.ApiHealthy ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
  }

  private void AppendOutput(string output) {
    if (String.IsNullOrWhiteSpace(output)) return;
    var compact = output.Trim();
    if (compact.Length > 1600) compact = compact.Substring(compact.Length - 1600);
    foreach (var line in compact.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)) AppendLog(line.Trim());
  }

  private void AppendLog(string message) {
    if (activityLog == null || activityLog.IsDisposed) return;
    activityLog.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine);
    activityLog.SelectionStart = activityLog.TextLength;
    activityLog.ScrollToCaret();
  }

  private void OpenControlCenter() {
    OpenTarget("http://127.0.0.1:41730/");
  }

  private void OpenInstallFolder() {
    try {
      var startInfo = new ProcessStartInfo();
      startInfo.FileName = "explorer.exe";
      startInfo.Arguments = "\"" + root + "\"";
      startInfo.UseShellExecute = true;
      Process.Start(startInfo);
      footerStatus.Text = "설치 폴더를 열었습니다.";
      AppendLog("설치 폴더를 열었습니다.");
    } catch (Exception error) {
      ShowFailure("설치 폴더 열기", FriendlyError(error));
    }
  }

  private void OpenTarget(string target) {
    try {
      Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true });
      footerStatus.Text = "연결된 화면을 열었습니다.";
      AppendLog("열기: " + target);
    } catch (Exception error) {
      ShowFailure("열기", FriendlyError(error));
    }
  }

  private static string FriendlyError(Exception error) {
    var native = error as Win32Exception;
    if (native != null && native.NativeErrorCode == 1223) return "관리자 권한 요청이 취소되었습니다.";
    return error == null || String.IsNullOrWhiteSpace(error.Message) ? "알 수 없는 오류가 발생했습니다." : error.Message;
  }

  private static string TranslateServiceState(ServiceControllerStatus status) {
    switch (status) {
      case ServiceControllerStatus.Running: return "실행 중";
      case ServiceControllerStatus.Stopped: return "중지됨";
      case ServiceControllerStatus.StartPending: return "시작 중";
      case ServiceControllerStatus.StopPending: return "중지 중";
      case ServiceControllerStatus.Paused: return "일시 중지";
      case ServiceControllerStatus.PausePending: return "일시 중지 중";
      case ServiceControllerStatus.ContinuePending: return "재개 중";
      default: return "알 수 없음";
    }
  }
}

public sealed class JarvisTrayContext : ApplicationContext {
  private readonly NotifyIcon icon;
  private readonly AgentControlForm panel;
  private readonly ToolStripMenuItem statusItem;
  private bool exiting;

  public JarvisTrayContext(bool showOnStart) {
    var root = AppDomain.CurrentDomain.BaseDirectory;
    icon = new NotifyIcon();
    icon.Icon = SystemIcons.Shield;
    icon.Text = "JARVIS PC 에이전트";
    icon.Visible = true;
    panel = new AgentControlForm(root, ${csharpString(endpoint)}, ${csharpString(serviceName)}, ${csharpString(displayName)}, ShowNotification);
    panel.StatusChanged += delegate { UpdateStatusMenu(); };

    var menu = new ContextMenuStrip();
    var openPanel = new ToolStripMenuItem("제어 패널 열기");
    openPanel.Font = new Font(openPanel.Font, FontStyle.Bold);
    openPanel.Click += delegate { panel.ShowPanel(); };
    menu.Items.Add(openPanel);
    statusItem = new ToolStripMenuItem("상태 확인 중");
    statusItem.Enabled = false;
    menu.Items.Add(statusItem);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("에이전트 시작", null, delegate { panel.StartAgent(); });
    menu.Items.Add("에이전트 중지", null, delegate { panel.StopAgent(); });
    menu.Items.Add("에이전트 다시 시작", null, delegate { panel.RestartAgent(); });
    menu.Items.Add("에이전트 업데이트", null, delegate { panel.UpdateAgent(); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("JARVIS 제어 센터 열기", null, delegate { OpenUrl("http://127.0.0.1:41730/"); });
    menu.Items.Add("트레이 종료", null, delegate { ExitTray(); });
    menu.Opening += delegate { UpdateStatusMenu(); };
    icon.ContextMenuStrip = menu;
    icon.MouseDoubleClick += delegate { panel.ShowPanel(); };
    icon.MouseClick += delegate(object sender, MouseEventArgs args) { if (args.Button == MouseButtons.Left) panel.ShowPanel(); };
    ShowNotification("JARVIS PC 에이전트", "트레이에서 실행 중입니다. 아이콘을 누르면 제어 패널이 열립니다.", ToolTipIcon.Info);
    if (showOnStart) panel.ShowPanel();
  }

  private void UpdateStatusMenu() {
    statusItem.Text = panel.IsAgentAvailable ? "상태: 연결됨" : "상태: 중지됨";
  }

  private void ShowNotification(string title, string message, ToolTipIcon type) {
    if (!icon.Visible) return;
    icon.ShowBalloonTip(2200, title, message, type);
  }

  private static void OpenUrl(string url) {
    Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
  }

  private void ExitTray() {
    if (exiting) return;
    exiting = true;
    icon.Visible = false;
    panel.CloseForExit();
    icon.Dispose();
    ExitThread();
  }
}

public static class JarvisPcAgentTray {
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  [STAThread]
  public static void Main(string[] args) {
    try { SetProcessDPIAware(); } catch { }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    bool created;
    using (var mutex = new Mutex(true, @"Local\JARVIS_PC_AGENT_TRAY_V1", out created)) {
      if (!created) return;
      var showOnStart = false;
      foreach (var argument in args) if (String.Equals(argument, "--show", StringComparison.OrdinalIgnoreCase)) showOnStart = true;
      Application.Run(new JarvisTrayContext(showOnStart));
      GC.KeepAlive(mutex);
    }
  }
}
`;
}

function renderLaunchTrayScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$trayExe = Join-Path $root "JarvisPcAgentTray.exe"',
    'if (-not (Test-Path -LiteralPath $trayExe -PathType Leaf)) { throw "서명된 트레이 실행 파일이 없습니다: $trayExe" }',
    '& (Join-Path $root "verify-package.ps1")',
    'Start-Process $trayExe',
    'Write-Host "JARVIS PC 에이전트 트레이 실행을 요청했습니다."'
  ].join('\n');
}

function renderBuildTrayExeScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$source = Join-Path $root "tray-agent.cs"',
    '$output = Join-Path $root "JarvisPcAgentTray.exe"',
    '$candidateCompilers = @(',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),',
    '  (Join-Path $env:WINDIR "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe")',
    ')',
    '$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue',
    'if ($dotnet) {',
    '  $sdkRoot = & $dotnet.Path --list-sdks | Select-Object -Last 1',
    '  if ($sdkRoot) {',
    '    $sdkVersion = ($sdkRoot -split " ")[0]',
    '    $sdkPath = Join-Path (Split-Path $dotnet.Path -Parent) "sdk\\$sdkVersion\\Roslyn\\bincore\\csc.dll"',
    '    if (Test-Path $sdkPath) {',
      '      & $dotnet.Path $sdkPath -target:winexe -out:$output -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.ServiceProcess.dll $source',
    '      if ($LASTEXITCODE -ne 0) { throw "C# 트레이 빌드에 실패했습니다. 종료 코드: $LASTEXITCODE" }',
    '      if (-not (Test-Path $output)) { throw "C# 트레이 빌드가 파일을 만들지 못했습니다: $output" }',
    '      Write-Host "트레이 실행 파일을 만들었습니다: $output"',
    '      exit 0',
    '    }',
    '  }',
    '}',
    '$csc = $candidateCompilers | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $csc) { throw "C# 컴파일러를 찾을 수 없습니다. .NET SDK 또는 Windows .NET Framework 빌드 도구를 설치하세요." }',
    '& $csc /target:winexe /out:$output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.ServiceProcess.dll $source',
    'if ($LASTEXITCODE -ne 0) { throw "C# 트레이 빌드에 실패했습니다. 종료 코드: $LASTEXITCODE" }',
    'if (-not (Test-Path $output)) { throw "C# 트레이 빌드가 파일을 만들지 못했습니다: $output" }',
    'Write-Host "트레이 실행 파일을 만들었습니다: $output"'
  ].join('\n');
}

function renderInstallTrayShortcutScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$startup = [Environment]::GetFolderPath("Startup")',
    '$shortcutPath = Join-Path $startup "JARVIS PC Agent Tray.lnk"',
    '$trayExe = Join-Path $root "JarvisPcAgentTray.exe"',
    'if (-not (Test-Path -LiteralPath $trayExe -PathType Leaf)) { throw "서명된 트레이 실행 파일이 없습니다: $trayExe" }',
    '& (Join-Path $root "verify-package.ps1")',
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcut = $shell.CreateShortcut($shortcutPath)',
    '$shortcut.TargetPath = $trayExe',
    '$shortcut.Arguments = ""',
    '$shortcut.WorkingDirectory = $root',
    '$shortcut.IconLocation = $trayExe + ",0"',
    '$shortcut.WindowStyle = 7',
    '$shortcut.Description = "사용자 로그인 시 JARVIS PC 에이전트 트레이를 실행합니다."',
    '$shortcut.Save()',
    'Write-Host "트레이 자동 시작 바로 가기를 설치했습니다: $shortcutPath"'
  ].join('\n');
}

function renderUninstallTrayShortcutScript() {
  return [
    '# Generated by JARVIS PC Agent installer packager.',
    '$ErrorActionPreference = "Stop"',
    '$startup = [Environment]::GetFolderPath("Startup")',
    '$shortcutPath = Join-Path $startup "JARVIS PC Agent Tray.lnk"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    'if (Test-Path -LiteralPath $shortcutPath) {',
    '  $shell = New-Object -ComObject WScript.Shell',
    '  $shortcut = $shell.CreateShortcut($shortcutPath)',
    '  if ($shortcut.TargetPath -eq (Join-Path $root "JarvisPcAgentTray.exe")) { Remove-Item -LiteralPath $shortcutPath -Force }',
    '}',
    'Write-Host "트레이 자동 시작 바로 가기가 있으면 제거했습니다."'
  ].join('\n');
}

export function createFileIntegrityManifest(files) {
  return Object.fromEntries(Object.entries(files).map(([fileName, content]) => [
    fileName,
    {
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: Buffer.byteLength(content, 'utf8')
    }
  ]));
}

export function signPackageManifest({ fileIntegrity, serviceName, version }) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ fileIntegrity, serviceName, version }))
    .digest('hex');
  return {
    algorithm: 'sha256-local-dev',
    digest,
    signer: 'jarvis-local-packager'
  };
}

function withUtf8Bom(content) {
  return String(content).startsWith('\uFEFF') ? String(content) : `\uFEFF${content}`;
}

function csharpString(value) {
  return `@"${String(value ?? '').replaceAll('"', '""')}"`;
}

function renderInstallReadme({ serviceManifest, installPlan, signed }) {
  return [
    '# JARVIS PC Agent Windows Service Package',
    '',
    `Service: ${serviceManifest.displayName} (${serviceManifest.serviceName})`,
    `Endpoint: ${installPlan.endpoint}`,
    `Signature: ${signed ? 'signed-local-dev-digest' : 'unsigned-local-build'}`,
    'Package digest: recorded in package-manifest.json',
    '',
    'Run `verify-package.ps1` before installing to check file integrity.',
    'Run `install-all.ps1` from an Administrator PowerShell only with prebuilt, signed tray and service-host artifacts; it verifies the trust chain before service install/start, smoke verification, and tray startup registration.',
    'Run `install-verify-release.ps1` from an Administrator PowerShell to build and sign runtime artifacts, embed them into the installer, sign the installer, install, smoke-test, run the release gate, and write final release evidence in one sequence.',
    'Run `verify-installed-service.ps1` after installation to write `service-smoke-report.json`.',
    'Run `npm run pc-agent:queue-soak -- --output dist/pc-agent-installer/queue-soak-report.json` after adapter changes to refresh long queue soak evidence.',
    'Run `build-nsis-installer.ps1` when NSIS is installed to create `JARVIS-PC-Agent-Setup.exe`.',
    'Run `sign-artifacts.ps1 -RuntimeOnly` before building the NSIS installer, then run `sign-artifacts.ps1 -SetupOnly` after the installer build. Production signing also requires `-RequireTimestamp`.',
    'Run `verify-production-signing.ps1 -Production` before external distribution; it requires a trusted non-self-signed code-signing certificate, private key, Code Signing EKU, validity window, trusted chain, and timestamped artifacts.',
    'Run `trust-dev-signing-cert.ps1 -TrustCurrentUser` only when you explicitly want to trust the generated development certificate for local-only testing.',
    'Run `untrust-dev-signing-cert.ps1` to remove the generated development certificate from CurrentUser Root and TrustedPublisher stores.',
    'Run `verify-signatures.ps1` to write `signature-verification-report.json`.',
    'Set `JARVIS_PC_AGENT_VAULT_KEY_PROVIDER=windows-dpapi` in the service environment to protect the capability vault key with Windows DPAPI.',
    'Set `JARVIS_PC_AGENT_VAULT_KEY` only when an operator-managed vault secret is required; otherwise the DPAPI provider creates and protects a local key cache.',
    'Run `status-service.ps1` to inspect the service.',
    'Run `install-service.ps1` from an Administrator PowerShell to register the service.',
    'Run `start-service.ps1`, `stop-service.ps1`, or `restart-service.ps1` from an Administrator PowerShell for lifecycle control.',
    'Run `update-service.ps1` from an Administrator PowerShell to update/restart the service.',
    'Run `launch-tray.ps1` to start the Windows notification-area tray.',
    'Run `build-tray-exe.ps1` to compile `tray-agent.cs` into `JarvisPcAgentTray.exe` when .NET build tools are available.',
    'Run `install-tray-shortcut.ps1` to launch the tray on user sign-in.',
    'Run `uninstall-tray-shortcut.ps1` to remove the tray startup shortcut.',
    'Run `collect-logs.ps1` to gather local diagnostic logs into a zip file.',
    'Run `uninstall-service.ps1` from an Administrator PowerShell to remove it.',
    '',
    'The service binds to localhost/private local use only and still requires scoped capability tokens plus user confirmation before execution.'
  ].join('\n');
}
