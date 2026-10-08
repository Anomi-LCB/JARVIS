import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInstallerPackagePlan } from '../apps/pc-agent/src/install/installer-packager.js';

const root = resolve(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function assertNoLegacyUiText(relativePath, forbidden) {
  const source = read(relativePath);
  for (const text of forbidden) {
    assert.equal(source.includes(text), false, `${relativePath} still exposes legacy UI text: ${text}`);
  }
}

test('PC Agent tray and installer expose Korean UI while preserving action contracts', () => {
  const daemonConfig = JSON.parse(read('apps/pc-agent/install/daemon-config.json'));
  const serviceManifest = JSON.parse(read('apps/pc-agent/install/windows-service-manifest.json'));
  const plan = createInstallerPackagePlan({ daemonConfig, serviceManifest, cwd: root });
  const trayUi = [plan.files['tray-agent.ps1'], plan.files['tray-agent.cs'], plan.files['tray-agent.xaml'], plan.files['tray-state.json']].join('\n');

  for (const text of [
    'Start Agent',
    'Stop Agent',
    'Restart Agent',
    'Update Agent',
    'Collect Logs',
    'Verify Package',
    'Open Local Endpoint',
    'Exit Tray'
  ]) {
    assert.equal(trayUi.includes(text), false, `generated tray still exposes: ${text}`);
  }

  for (const text of ['에이전트 시작', '에이전트 중지', '진단 기록 수집', '설치 패키지 검증', '로컬 접속 주소 열기', '트레이 종료']) {
    assert.match(trayUi, new RegExp(text));
  }

  assert.match(plan.files['installer.nsi'], /MUI_LANGUAGE "Korean"/);
  assert.match(plan.files['installer.nsi'], /Section "설치"/);
  assert.match(plan.files['installer.nsi'], /Section "Uninstall"/);
  assert.match(plan.files['installer.nsi'], /JARVIS PC 에이전트를 제거하고 있습니다/);
  assert.match(plan.files['tray-agent.cs'], /class JarvisControlWindow/);
  assert.match(plan.files['tray-agent.cs'], /에이전트 제어 센터 열기/);
  assert.match(plan.files['tray-agent.cs'], /XamlReader\.Parse/);
  assert.match(plan.files['tray-agent.cs'], /-WindowStyle Hidden/);
  assert.match(plan.files['tray-agent.cs'], /CreateNoWindow = true/);
  assert.match(plan.files['tray-agent.cs'], /Environment\.SpecialFolder\.System/);
  assert.match(plan.files['tray-agent.cs'], /PSModulePath/);
  assert.match(plan.files['tray-agent.cs'], /SetProcessDPIAware/);
  assert.match(plan.files['tray-agent.cs'], /EventWaitHandle\.OpenExisting/);
  // A refresh must probe the captured address and discard its result if the
  // user changes that address while the background request is running.
  assert.match(plan.files['tray-agent.cs'], /next\.ControlCenterAddress\s*=\s*controlCenterUrl\s*;[\s\S]*?ProbeHealthDetailed\(next\.ControlCenterAddress\s*\+\s*"\/health",\s*"JARVIS_CONTROL_CENTER"\)/);
  assert.match(plan.files['tray-agent.cs'], /next\.ControlCenterIdentityVerified\s*=\s*controlCenterProbe\.IdentityVerified\s*;/);
  assert.match(plan.files['tray-agent.cs'], /private void ApplySnapshot\(AgentSnapshot next\)\s*\{\s*if\s*\(next\.ControlCenterAddress\s*!=\s*controlCenterUrl\)\s*\{\s*BeginRefresh\(\);\s*return;\s*\}/);
  assert.match(plan.files['tray-agent.cs'], /ApiLatencyMs/);
  assert.match(plan.files['tray-agent.cs'], /IdentityVerified/);
  assert.match(plan.files['tray-agent.cs'], /RunAllChecks/);
  assert.match(plan.files['tray-agent.cs'], /SavePreferences/);
  assert.match(plan.files['tray-agent.cs'], /pc-agent-ui\.settings/);
  assert.match(plan.files['tray-agent.cs'], /실행 증거와 서비스 로그는 삭제하지 않았습니다/);
  assert.match(plan.files['tray-agent.cs'], /LoadVerifiedWindow/);
  assert.match(plan.files['tray-agent.cs'], /RequireInstalledService/);
  assert.match(plan.files['tray-agent.cs'], /public enum TrayVisualState/);
  for (const state of ['Connecting', 'Connected', 'Working', 'Warning', 'Offline', 'Error']) {
    assert.match(plan.files['tray-agent.cs'], new RegExp(`TrayVisualState\\.${state}`));
  }
  assert.match(plan.files['tray-agent.cs'], /CurrentTrayVisualState/);
  assert.match(plan.files['tray-agent.cs'], /CreateTrayIconSet/);
  assert.match(plan.files['tray-agent.cs'], /CreateTrayIconFrame/);
  assert.match(plan.files['tray-agent.cs'], /DrawTrayStatusDot/);
  assert.match(plan.files['tray-agent.cs'], /CreateTrayAnimation\(TrayVisualState\.Connecting, 12, highContrast\)/);
  assert.match(plan.files['tray-agent.cs'], /CreateTrayAnimation\(TrayVisualState\.Working, 6, highContrast\)/);
  assert.match(plan.files['tray-agent.cs'], /TimeSpan\.FromMilliseconds\(140\)/);
  assert.match(plan.files['tray-agent.cs'], /PixelOffsetMode\.Half/);
  assert.match(plan.files['tray-agent.cs'], /const float outerStroke = 4\.35F/);
  assert.match(plan.files['tray-agent.cs'], /DrawArc\(ring, 2\.45F, 2\.45F, 27\.1F, 27\.1F/);
  assert.match(plan.files['tray-agent.cs'], /new System\.Drawing\.Pen\(cyan, 4\.45F\)/);
  assert.match(plan.files['tray-agent.cs'], /FillEllipse\(dot, 22\.9F, 2\.8F, 6\.2F, 6\.2F\)/);
  for (const label of ['연결됨', '작업 실행 중', '주의 필요', '연결 끊김', '오류 확인 필요', '연결 중']) {
    assert.match(plan.files['tray-agent.cs'], new RegExp(label));
  }
  assert.match(plan.files['tray-agent.cs'], /HealthySnapshotsRequiredToRecover = 2/);
  assert.match(plan.files['tray-agent.cs'], /RecordStatusFault/);
  assert.match(plan.files['tray-agent.cs'], /EvaluateIncidentRecovery/);
  assert.match(plan.files['tray-agent.cs'], /ResolveActionIncident/);
  assert.match(plan.files['tray-agent.cs'], /TrayTransitionDelayMs/);
  assert.match(plan.files['tray-agent.cs'], /TrayVisualState\.Offline\) return 1200/);
  assert.match(plan.files['tray-agent.cs'], /TrayVisualState\.Warning\) return 900/);
  assert.match(plan.files['tray-agent.cs'], /icon\.Text = "JARVIS PC 에이전트"/);
  assert.doesNotMatch(plan.files['tray-agent.cs'], /icon\.Text = "JARVIS PC 에이전트 · " \+ label/);
  for (const label of ['상태 다시 확인', '진단 및 복구 열기', '오류 알림 확인', '아이콘 애니메이션']) {
    assert.match(plan.files['tray-agent.cs'], new RegExp(label));
  }
  assert.match(plan.files['tray-agent.cs'], /RegisterWindowMessage\("TaskbarCreated"\)/);
  assert.match(plan.files['tray-agent.cs'], /SystemEvents\.PowerModeChanged/);
  assert.match(plan.files['tray-agent.cs'], /SystemEvents\.SessionSwitch/);
  assert.match(plan.files['tray-agent.cs'], /SystemEvents\.DisplaySettingsChanged/);
  assert.match(plan.files['tray-agent.cs'], /SystemParameters\.ClientAreaAnimation/);
  assert.match(plan.files['tray-agent.cs'], /SystemParameters\.HighContrast/);
  assert.match(plan.files['tray-agent.cs'], /RefreshTrayIconPalette/);
  assert.match(plan.files['tray-agent.cs'], /trayAnimations=/);
  assert.match(plan.files['tray-agent.cs'], /ProtectSensitiveText/);
  assert.match(plan.files['tray-agent.cs'], /Bearer \[보호됨\]/);
  assert.match(plan.files['tray-agent.cs'], /github_pat_/);
  assert.match(plan.files['tray-agent.cs'], /JARVIS_OPENAI_API_KEY|api\[_-\]\?key/);
  assert.match(plan.files['tray-agent.cs'], /\(\?<!\[A-Za-z0-9_\]\)\(--\?/);
  assert.match(plan.files['tray-agent.cs'], /PC 에이전트 UI를 시작했습니다/);
  assert.match(plan.files['tray-agent.cs'], /pc-agent-ui-events\.log/);
  assert.match(plan.files['tray-agent.cs'], /Length \+ incomingLength > 1048576L/);
  assert.doesNotMatch(plan.files['tray-agent.cs'], /CreateBrandIcon/);
  assert.doesNotMatch(plan.files['tray-agent.cs'], /FlowLayoutPanel/);
  assert.doesNotMatch(plan.files['tray-agent.cs'], /WrapContents = true/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="OverviewPage"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="ServicePage"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="DiagnosticsPage"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="SettingsPage"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="StartupToggle"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="AutoRefreshToggle"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="RefreshIntervalCombo"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="NotificationToggle"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="TrayAnimationToggle"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="TrayAnimationStatusText"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="RunAllChecksButton"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="CopyDiagnosticsSummaryButton"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="ServiceLatencyText"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Key="GlassShadow"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Key="LavenderSoftBrush"/);
  assert.doesNotMatch(plan.files['tray-agent.xaml'], /Background="#0B0E11"/);
  assert.match(plan.files['tray-agent.xaml'], /MinWidth="1040"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Key="ScrollThumbStyle"/);
  assert.match(plan.files['tray-agent.xaml'], /x:Name="ContentScroll"/);
  assert.doesNotMatch(plan.files['tray-agent.xaml'], /ScrollBar\.LineUpCommand/);
  assert.match(plan.files['tray-agent.xaml'], /IsIndeterminate="True"/);
  assert.match(plan.files['build-tray-exe.ps1'], /PresentationFramework/);
  assert.match(plan.files['build-tray-exe.ps1'], /System\.Xaml/);
  assert.ok(plan.manifest.files.includes('tray-agent.xaml'));
  assert.match(plan.files['verify-package.ps1'], /function Get-Sha256/);
  assert.doesNotMatch(plan.files['verify-package.ps1'], /Get-FileHash/);
  assert.match(plan.files['verify-package.ps1'], /runtime-integrity\.psd1/);
  assert.match(plan.files['verify-package.ps1'], /JarvisPcAgentServiceHost\.exe/);
  assert.match(plan.files['verify-package.ps1'], /Get-AuthenticodeSignature/);
  assert.match(plan.files['verify-package.ps1'], /서명자가 런타임 매니페스트와 일치하지 않습니다/);
  assert.match(plan.files['sign-artifacts.ps1'], /jarvis-pc-agent-runtime-integrity-v1/);
  assert.match(plan.files['sign-artifacts.ps1'], /RuntimeOnly/);
  assert.match(plan.files['sign-artifacts.ps1'], /SetupOnly/);
  assert.match(plan.files['verify-signatures.ps1'], /thumbprintHash/);
  assert.doesNotMatch(plan.files['verify-signatures.ps1'], /thumbprint =/);
  assert.match(plan.files['collect-logs.ps1'], /jarvis-pc-agent-diagnostics-v1/);
  assert.match(plan.files['collect-logs.ps1'], /sensitiveFilesExcluded = \$true/);
  assert.match(plan.files['collect-logs.ps1'], /rawSecretsIncluded = \$false/);
  assert.match(plan.files['collect-logs.ps1'], /pc-agent-ui-events\.log/);
  assert.match(plan.files['collect-logs.ps1'], /uiEventLogIncluded/);
  assert.match(plan.files['collect-logs.ps1'], /vault\|secret\|token\|credential/);
  assert.match(plan.files['collect-logs.ps1'], /function Protect-SensitiveText/);
  assert.match(plan.files['collect-logs.ps1'], /function Copy-SanitizedTextFile/);
  assert.match(plan.files['collect-logs.ps1'], /maxTextFileBytes = 2097152/);
  assert.match(plan.files['collect-logs.ps1'], /privacyRedactionApplied = \$true/);
  assert.match(plan.files['collect-logs.ps1'], /%USERPROFILE%/);
  assert.doesNotMatch(plan.files['collect-logs.ps1'], /\$source = "apps\/pc-agent\/logs"/);
  assert.match(plan.files['install-tray-shortcut.ps1'], /\$shortcut\.TargetPath = \$trayExe/);
  assert.doesNotMatch(plan.files['install-tray-shortcut.ps1'], /TargetPath = "powershell\.exe"/);
  for (const fileName of ['tray-agent.ps1', 'tray-agent.cs', 'installer.nsi', 'install-service.ps1']) {
    assert.equal(plan.files[fileName].charCodeAt(0), 0xfeff, `${fileName} must be UTF-8 BOM encoded for Windows PowerShell and compiler compatibility`);
  }
  assert.ok(plan.trayState.menu.every((item) => /[가-힣]/.test(item.label)));
  assert.deepEqual(
    plan.trayState.menu.map((item) => item.id),
    [
      'open-panel',
      'open-console',
      'open-health',
      'open-queue',
      'review-approval-diff',
      'review-poison-queue',
      'start-service',
      'stop-service',
      'restart-service',
      'update-service',
      'collect-logs',
      'verify-package',
      'copy-endpoint'
    ]
  );
});

test('primary JARVIS product surfaces do not regress to legacy English UI', () => {
  assertNoLegacyUiText('index.html', ['JARVIS Control Center', 'JARVIS local control center']);
  assertNoLegacyUiText('apps/mobile/src/App.tsx', [
    'PC Bridge 페어링',
    'Mobile First, Execution Never',
    'Approval-centric UX',
    'Live error:',
    'Last response:',
    'navigate to HomeScreen',
    'select poison packet',
    'JARVIS Mobile root'
  ]);
  assertNoLegacyUiText('apps/mobile/src/components/NativeRuntimeProbe.tsx', ['Native runtime probe', 'SecureStore native:', 'Notifications native:', 'Sharing native:', 'Platform:']);
  assertNoLegacyUiText('apps/mobile/src/components/GrowthReviewDecisionPanel.tsx', ['Visual contract ', '기억 위생 trend']);
  assertNoLegacyUiText('apps/mobile/src/components/RetryPolicySettingsPanel.tsx', ['Execution Queue Retry Policy']);
  assertNoLegacyUiText('apps/rokid-control-center/src/public/index.html', ['DEVICE DETAILS', 'HARDWARE CAPABILITIES', 'BOOT CHAIN', 'OTA PROTOCOL', 'ANDROID LOGCAT', 'RAW ANDROID SETTINGS', '>System<', '>Secure<', '>Global<']);
  assertNoLegacyUiText('apps/wearable-hud/src/hud-view.js', ['JARVIS Wearable HUD']);
});

test('PC Agent professional glass console keeps native lookups aligned with named XAML controls', () => {
  const daemonConfig = JSON.parse(read('apps/pc-agent/install/daemon-config.json'));
  const serviceManifest = JSON.parse(read('apps/pc-agent/install/windows-service-manifest.json'));
  const plan = createInstallerPackagePlan({ daemonConfig, serviceManifest, cwd: root });
  const source = plan.files['tray-agent.cs'];
  const xaml = plan.files['tray-agent.xaml'];
  const xamlNameList = [...xaml.matchAll(/x:Name="([^"]+)"/g)].map((match) => match[1]);
  const xamlNames = new Set(xamlNameList);
  const requiredControls = [...source.matchAll(/Need<([^>]+)>\("([^"]+)"\)/g)]
    .map((match) => ({ type: match[1], name: match[2] }));
  const requiredNames = requiredControls.map(({ name }) => name);

  assert.deepEqual(requiredNames.filter((name) => !xamlNames.has(name)), []);
  // Looking up an existing control again is valid (for example, scaling the
  // ContentScroll content). Its XAML declaration and expected type stay unique.
  // Template-local names such as Chrome have their own WPF name scopes.
  for (const name of new Set(requiredNames)) {
    assert.equal(xamlNameList.filter((candidate) => candidate === name).length, 1, `ambiguous native control: ${name}`);
    assert.equal(new Set(requiredControls.filter((control) => control.name === name).map(({ type }) => type)).size, 1, `inconsistent lookup type: ${name}`);
  }
  for (const name of [
    'ServiceProbeButton',
    'ServiceOpenServicesButton',
    'DiagnosticsApiStateText',
    'DiagnosticsControlCenterStateText',
    'RunAllChecksButton',
    'CopyDiagnosticsSummaryButton',
    'AutoRefreshToggle',
    'RefreshIntervalCombo',
    'NotificationToggle',
    'TrayAnimationToggle',
    'TrayAnimationStatusText',
    'TestConnectionButton',
    'ClearActivityButton'
  ]) {
    assert.equal(xamlNames.has(name), true, `missing professional control: ${name}`);
    assert.equal(requiredNames.includes(name), true, `unbound professional control: ${name}`);
  }

  assert.match(xaml, /LinearGradientBrush x:Key="CanvasBrush"/);
  assert.match(xaml, /DropShadowEffect x:Key="GlassShadow"/);
  assert.match(xaml, /Background="{StaticResource LavenderSoftBrush}"/);
  assert.match(xaml, /x:Name="DiagnosticsLogText"[^>]*Height="98"/);
  assert.ok(xaml.indexOf('x:Name="HeaderStatusDot"') > xaml.indexOf('</ScrollViewer>'), 'runtime status belongs in the lower operation bar');
  assert.match(source, /UpdateContentScrollBar/);
  assert.match(source, /overflow > 1\.5/);
  assert.match(source, /ProbeHealthDetailed/);
  assert.match(source, /new UTF8Encoding\(false\)/);
  assert.match(source, /IsAllowedRefreshInterval/);
  assert.match(source, /IdentityVerified/);
});
