param(
  [string]$ExecutablePath = "",
  [string]$OutputDirectory = "",
  [switch]$SkipFunctionalActions
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
  $ExecutablePath = Join-Path $projectRoot "dist\pc-agent-installer\JarvisPcAgentTray.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "artifacts\ui-qa\pc-agent-tray-smoke"
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public static class JarvisTraySmokeMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int Dx;
    public int Dy;
    public uint MouseData;
    public uint Flags;
    public uint Time;
    public UIntPtr ExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint Type; public MOUSEINPUT Mouse; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int maximum);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr handle, uint objectId, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out object accessibleObject);
  [DllImport("oleacc.dll")] private static extern int AccessibleChildren(IAccessible container, int startIndex, int childCount, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children, out int obtainedCount);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public static bool RevealTaskbar() {
    var handle = FindWindow("Shell_TrayWnd", null);
    RECT rect;
    if (handle == IntPtr.Zero || !GetWindowRect(handle, out rect)) return false;
    var width = rect.Right - rect.Left;
    var height = rect.Bottom - rect.Top;
    if (width >= height) {
      var y = rect.Top <= 1 ? rect.Top + 1 : rect.Bottom - 1;
      return SetCursorPos(rect.Left + (width / 2), y);
    }
    var x = rect.Left <= 1 ? rect.Left + 1 : rect.Right - 1;
    return SetCursorPos(x, rect.Top + (height / 2));
  }

  public static bool SendRightClick() {
    var inputs = new[] {
      new INPUT { Type = 0, Mouse = new MOUSEINPUT { Flags = 0x0008 } },
      new INPUT { Type = 0, Mouse = new MOUSEINPUT { Flags = 0x0010 } }
    };
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
  }

  public static bool DismissNotificationAt(int x, int y) {
    var handle = WindowFromPoint(new POINT { X = x, Y = y });
    if (handle == IntPtr.Zero) return false;
    var className = new StringBuilder(256);
    var title = new StringBuilder(256);
    GetClassName(handle, className, className.Capacity);
    GetWindowText(handle, title, title.Capacity);
    if (!String.Equals(className.ToString(), "Windows.UI.Core.CoreWindow", StringComparison.Ordinal)) return false;
    if (!String.Equals(title.ToString(), "새 알림", StringComparison.Ordinal)
      && !String.Equals(title.ToString(), "New notification", StringComparison.OrdinalIgnoreCase)) return false;
    ShowWindow(handle, 0);
    PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return true;
  }

  public static string DescribeWindowAt(int x, int y) {
    var handle = WindowFromPoint(new POINT { X = x, Y = y });
    if (handle == IntPtr.Zero) return "창을 찾을 수 없음";
    var className = new StringBuilder(256);
    var title = new StringBuilder(256);
    GetClassName(handle, className, className.Capacity);
    GetWindowText(handle, title, title.Capacity);
    return className.ToString() + (title.Length > 0 ? " · " + title.ToString() : "");
  }

  public static string[] GetAccessibleNames(IntPtr handle) {
    var names = new List<string>();
    object accessibleObject;
    var interfaceId = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    var result = AccessibleObjectFromWindow(handle, 0xFFFFFFFC, ref interfaceId, out accessibleObject);
    if (result < 0 || accessibleObject == null) return names.ToArray();
    WalkAccessibleTree((IAccessible)accessibleObject, names, 0);
    return names.ToArray();
  }

  private static void WalkAccessibleTree(IAccessible accessible, List<string> names, int depth) {
    if (accessible == null || depth > 4) return;
    try {
      var ownName = accessible.get_accName(0);
      if (!String.IsNullOrWhiteSpace(ownName)) names.Add(ownName);
    } catch { }

    int childCount;
    try { childCount = accessible.accChildCount; } catch { return; }
    if (childCount <= 0) return;

    var children = new object[childCount];
    int obtainedCount;
    if (AccessibleChildren(accessible, 0, childCount, children, out obtainedCount) < 0) return;
    for (var index = 0; index < obtainedCount; index++) {
      var child = children[index] as IAccessible;
      if (child != null) {
        WalkAccessibleTree(child, names, depth + 1);
        continue;
      }
      try {
        var childName = accessible.get_accName(children[index]);
        if (!String.IsNullOrWhiteSpace(childName)) names.Add(childName);
      } catch { }
    }
  }
}
'@ -ReferencedAssemblies Accessibility
try { [JarvisTraySmokeMouse]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }

function Find-ControlByName {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$Name
  )
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-ControlByAutomationId {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId
  )
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-Control {
  param([System.Windows.Automation.AutomationElement]$Control)
  if ($null -eq $Control) { throw "호출할 UI 컨트롤을 찾지 못했습니다." }
  $candidate = $Control
  for ($attempt = 0; $attempt -lt 4 -and $null -ne $candidate; $attempt++) {
    try {
      $pattern = $candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
      return
    } catch [System.InvalidOperationException] {
      $candidate = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($candidate)
    }
  }
  throw "호출 가능한 UI 컨트롤을 찾지 못했습니다: $($Control.Current.Name)"
}

function Wait-Until {
  param(
    [scriptblock]$Condition,
    [int]$TimeoutMilliseconds = 10000,
    [int]$PollMilliseconds = 120
  )
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    try {
      if (& $Condition) { return $true }
    } catch { }
    Start-Sleep -Milliseconds $PollMilliseconds
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Get-ControlNameById {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId
  )
  $control = Find-ControlByAutomationId $Root $AutomationId
  if ($null -eq $control) { return "" }
  return [string]$control.Current.Name
}

function Get-ToggleStateById {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId
  )
  $control = Find-ControlByAutomationId $Root $AutomationId
  if ($null -eq $control) { throw "토글 컨트롤을 찾지 못했습니다: $AutomationId" }
  $pattern = $control.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  return ([System.Windows.Automation.TogglePattern]$pattern).Current.ToggleState.ToString()
}

function Set-ToggleStateById {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId,
    [string]$ExpectedState
  )
  $current = Get-ToggleStateById $Root $AutomationId
  if ($current -eq $ExpectedState) { return $true }
  $control = Find-ControlByAutomationId $Root $AutomationId
  $pattern = $control.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
  return Wait-Until -TimeoutMilliseconds 5000 -Condition {
    (Get-ToggleStateById $Root $AutomationId) -eq $ExpectedState
  }
}

function Read-PreferenceMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $separator = $rawLine.IndexOf('=')
    if ($separator -le 0) { continue }
    $map[$rawLine.Substring(0, $separator).Trim()] = $rawLine.Substring($separator + 1).Trim()
  }
  return $map
}

function Capture-WindowScreenshot {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$Path
  )
  $bounds = $Root.Current.BoundingRectangle
  $bitmap = New-Object System.Drawing.Bitmap(
    [Math]::Max(1, [int][Math]::Ceiling($bounds.Width)),
    [Math]::Max(1, [int][Math]::Ceiling($bounds.Height))
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(
      [int][Math]::Floor($bounds.Left),
      [int][Math]::Floor($bounds.Top),
      0,
      0,
      $bitmap.Size
    )
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return $Path
}

function Show-PageByAutomationId {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$NavigationAutomationId,
    [string]$ExpectedTitle
  )
  $button = $null
  $invoked = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(6)
  do {
    $button = Find-ControlByAutomationId $Root $NavigationAutomationId
    if ($null -ne $button) {
      try {
        Invoke-Control $button
        $invoked = $true
        break
      } catch { }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $invoked) { throw "화면 탐색 버튼을 호출하지 못했습니다: $NavigationAutomationId" }
  $ready = Wait-Until -TimeoutMilliseconds 5000 -Condition {
    (Get-ControlNameById $Root "PageTitleText") -eq $ExpectedTitle
  }
  if (-not $ready) { throw "화면 전환을 확인하지 못했습니다: $ExpectedTitle" }
  Start-Sleep -Milliseconds 250
}

function Dismiss-NoticeIfVisible {
  param([System.Windows.Automation.AutomationElement]$Root)
  $button = Find-ControlByAutomationId $Root "NoticeDismissButton"
  if ($null -eq $button -or $button.Current.IsOffscreen) { return $false }
  Invoke-Control $button
  Wait-Until -TimeoutMilliseconds 3000 -Condition {
    $current = Find-ControlByAutomationId $Root "NoticeDismissButton"
    $null -eq $current -or $current.Current.IsOffscreen
  } | Out-Null
  return $true
}

function Wait-ForControlEnabled {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId,
    [int]$TimeoutMilliseconds = 60000
  )
  return Wait-Until -TimeoutMilliseconds $TimeoutMilliseconds -Condition {
    $control = Find-ControlByAutomationId $Root $AutomationId
    $null -ne $control -and $control.Current.IsEnabled
  }
}

function Get-SelectedComboItemNameById {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId
  )
  $combo = Find-ControlByAutomationId $Root $AutomationId
  if ($null -eq $combo) { throw "선택 컨트롤을 찾지 못했습니다: $AutomationId" }
  $pattern = $combo.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
  $selection = @(([System.Windows.Automation.SelectionPattern]$pattern).Current.GetSelection())
  if ($selection.Count -eq 0) { return "" }
  return [string]$selection[0].Current.Name
}

function Select-ComboItemByName {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$AutomationId,
    [string]$ItemName
  )
  $combo = Find-ControlByAutomationId $Root $AutomationId
  if ($null -eq $combo) { throw "선택 컨트롤을 찾지 못했습니다: $AutomationId" }
  $expand = $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  ([System.Windows.Automation.ExpandCollapsePattern]$expand).Expand()
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  $item = $null
  $found = Wait-Until -TimeoutMilliseconds 4000 -Condition {
    $candidates = $desktop.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($candidate in $candidates) {
      if ($candidate.Current.ProcessId -eq $combo.Current.ProcessId `
        -and $candidate.Current.Name -eq $ItemName `
        -and $candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) {
        $supportsSelection = @($candidate.GetSupportedPatterns() | Where-Object {
          $_.Id -eq [System.Windows.Automation.SelectionItemPattern]::Pattern.Id
        }).Count -gt 0
        if ($supportsSelection) {
          $script:comboItemCandidate = $candidate
          return $true
        }
      }
    }
    return $false
  }
  if ($found) { $item = $script:comboItemCandidate }
  if ($null -eq $item) {
    ([System.Windows.Automation.ExpandCollapsePattern]$expand).Collapse()
    throw "선택 항목을 찾지 못했습니다: $ItemName"
  }
  $selection = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  ([System.Windows.Automation.SelectionItemPattern]$selection).Select()
  ([System.Windows.Automation.ExpandCollapsePattern]$expand).Collapse()
  return Wait-Until -TimeoutMilliseconds 5000 -Condition {
    (Get-SelectedComboItemNameById $Root $AutomationId) -eq $ItemName
  }
}

function Find-VisibleTrayButton {
  param(
    [System.Windows.Automation.AutomationElement]$DesktopRoot,
    [System.Windows.Automation.Condition]$NameCondition
  )
  $elements = $DesktopRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $NameCondition)
  foreach ($element in $elements) {
    $bounds = $element.Current.BoundingRectangle
    if (($element.Current.ClassName -eq "SystemTray.NormalButton") -and (-not $element.Current.IsOffscreen) -and ($bounds.Width -gt 0) -and ($bounds.Height -gt 0)) {
      return $element
    }
  }
  return $null
}

function Get-TrayMenuItems {
  $DesktopRoot = [System.Windows.Automation.AutomationElement]::RootElement
  $ProcessId = [int]$script:process.Id
  $menuRoot = $null
  $fallbackMenuRoot = $null
  $visibleProcessWindows = @()
  $topLevelElements = $DesktopRoot.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $topLevelElements) {
    if ($element.Current.ProcessId -eq $ProcessId) {
      $visibleProcessWindows += ($element.Current.Name + "|" + $element.Current.ControlType.ProgrammaticName + "|" + $element.Current.ClassName)
    }
    $bounds = $element.Current.BoundingRectangle
    $isNamedMenu = ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu) -and ($element.Current.Name -eq "DropDown")
    $isWinFormsPopup = $element.Current.ClassName.StartsWith("WindowsForms10.Window.", [StringComparison]::Ordinal) -and ($bounds.Width -gt 100) -and ($bounds.Height -gt 100)
    if (($element.Current.ProcessId -eq $ProcessId) -and $isNamedMenu) {
      $menuRoot = $element
      break
    }
    if (($element.Current.ProcessId -eq $ProcessId) -and $isWinFormsPopup -and $null -eq $fallbackMenuRoot) {
      $fallbackMenuRoot = $element
    }
  }
  if ($null -eq $menuRoot) { $menuRoot = $fallbackMenuRoot }
  $provider = "none"
  $accessibleNameCount = 0
  $script:lastTrayMenuProbe = [ordered]@{
    processId = $ProcessId
    menuRootFound = $null -ne $menuRoot
    topLevelElements = $visibleProcessWindows
    provider = $provider
    accessibleNameCount = $accessibleNameCount
  }
  if ($null -eq $menuRoot) { return @() }
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::MenuItem
  )
  $menuItems = @($menuRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
  if ($menuItems.Count -gt 0) {
    $script:lastTrayMenuProbe.provider = "uia"
    return $menuItems
  }

  # Windows PowerShell 5.1 can expose a WinForms popup as an empty UIA Pane.
  # MSAA is the native accessibility source used by the same menu and remains complete.
  $menuBounds = $menuRoot.Current.BoundingRectangle
  $accessibleNames = @(
    [JarvisTraySmokeMouse]::GetAccessibleNames([IntPtr]$menuRoot.Current.NativeWindowHandle) |
      Where-Object { -not [String]::IsNullOrWhiteSpace($_) -and $_ -ne "DropDown" }
  )
  $script:lastTrayMenuProbe.provider = "msaa"
  $script:lastTrayMenuProbe.accessibleNameCount = $accessibleNames.Count
  return @($accessibleNames | ForEach-Object {
    [pscustomobject]@{
      Current = [pscustomobject]@{
        Name = $_
        BoundingRectangle = $menuBounds
      }
    }
  })
}

function Add-Check {
  param([string]$Name, [bool]$Passed, [hashtable]$Detail)
  $script:checks.Add([ordered]@{
    name = $Name
    status = $(if ($Passed) { "pass" } else { "fail" })
    detail = $Detail
  })
}

function Add-Skip {
  param([string]$Name, [string]$Reason, [hashtable]$Detail)
  $Detail.blockedBy = $Reason
  $script:checks.Add([ordered]@{
    name = $Name
    status = "skip"
    detail = $Detail
  })
}

function Add-TrayCheck {
  param([string]$Name, [bool]$Passed, [hashtable]$Detail, [string]$Blocker)
  if ([String]::IsNullOrWhiteSpace($Blocker)) {
    Add-Check $Name $Passed $Detail
  } else {
    Add-Skip $Name $Blocker $Detail
  }
}

if (-not (Test-Path -LiteralPath $ExecutablePath)) {
  throw "PC 에이전트 트레이 실행 파일을 찾을 수 없습니다: $ExecutablePath"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Start-Process -FilePath $ExecutablePath -ArgumentList "--show" | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(12)
$process = $null
do {
  Start-Sleep -Milliseconds 250
  $process = Get-Process -Name "JarvisPcAgentTray" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($process) { $process.Refresh() }
} while ((-not $process -or $process.MainWindowHandle -eq 0) -and [DateTime]::UtcNow -lt $deadline)

if (-not $process -or $process.MainWindowHandle -eq 0) {
  throw "PC 에이전트 제어 센터 창을 12초 안에 찾지 못했습니다."
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$checks = New-Object System.Collections.Generic.List[object]
Add-Check "window-responsive" $process.Responding @{
  processId = $process.Id
  title = $root.Current.Name
}

$windowBounds = $root.Current.BoundingRectangle
$screenshotPath = Join-Path $OutputDirectory "settings-page.png"
$serviceScreenshotPath = Join-Path $OutputDirectory "service-page.png"
$diagnosticsScreenshotPath = Join-Path $OutputDirectory "diagnostics-page.png"
$preferencePath = Join-Path $env:LOCALAPPDATA "JARVIS\pc-agent-ui.settings"
$preferenceExisted = Test-Path -LiteralPath $preferencePath
$preferenceBytes = if ($preferenceExisted) { [IO.File]::ReadAllBytes($preferencePath) } else { $null }
$originalToggleStates = @{}
$originalRefreshInterval = ""
$functionalArtifacts = [ordered]@{
  preferencePath = $preferencePath
  diagnosticZip = ""
  serviceStateBefore = ""
  serviceStateAfter = ""
}

try {
  Show-PageByAutomationId $root "NavSettingsButton" "에이전트 설정"
  Add-Check "settings-navigation-functional" $true @{ title = Get-ControlNameById $root "PageTitleText" }
  Dismiss-NoticeIfVisible $root | Out-Null

  $expectedControls = @(
    @{ id = "StartupToggle"; name = "Windows 로그인 시 자동 실행" },
    @{ id = "RefreshIntervalCombo"; name = "상태 자동 갱신 주기" },
    @{ id = "AutoRefreshToggle"; name = "상태 자동 갱신" },
    @{ id = "NotificationToggle"; name = "작업 완료 알림" },
    @{ id = "TrayAnimationToggle"; name = "트레이 아이콘 애니메이션" },
    @{ id = "TestConnectionButton"; name = "로컬 API 연결 테스트" },
    @{ id = "SettingsCopyEndpointButton"; name = "로컬 API 접속 주소 복사" },
    @{ id = "OpenHealthButton"; name = "로컬 API 상태 응답 열기" }
  )

  foreach ($expected in $expectedControls) {
    $control = Find-ControlByAutomationId $root $expected.id
    $visible = $null -ne $control -and -not $control.Current.IsOffscreen
    $bounds = if ($null -ne $control) { $control.Current.BoundingRectangle } else { $null }
    $hasBounds = $null -ne $bounds -and $bounds.Width -gt 0 -and $bounds.Height -gt 0
    $insideWindow = $hasBounds `
      -and $bounds.Left -ge ($windowBounds.Left - 1) `
      -and $bounds.Top -ge ($windowBounds.Top - 1) `
      -and $bounds.Right -le ($windowBounds.Right + 1) `
      -and $bounds.Bottom -le ($windowBounds.Bottom + 1)
    Add-Check ("control-" + $expected.id) ($null -ne $control -and $visible -and $hasBounds -and $insideWindow) @{
      label = $expected.name
      visible = $visible
      insideWindow = $insideWindow
      width = $(if ($bounds) { [Math]::Round($bounds.Width, 1) } else { 0 })
      height = $(if ($bounds) { [Math]::Round($bounds.Height, 1) } else { 0 })
    }
  }

  Capture-WindowScreenshot $root $screenshotPath | Out-Null
  Add-Check "settings-screenshot" (Test-Path -LiteralPath $screenshotPath) @{ path = $screenshotPath }

  if (-not $SkipFunctionalActions) {
    $healthBefore = $null
    try { $healthBefore = Invoke-RestMethod -Uri "http://127.0.0.1:17776/health" -Method Get -TimeoutSec 5 } catch { }
    Add-Check "live-api-preflight" ($null -ne $healthBefore -and $healthBefore.module -eq "B_PC_AGENT" -and $healthBefore.localOnly -eq $true) @{
      module = $(if ($null -ne $healthBefore) { $healthBefore.module } else { "" })
      localOnly = $(if ($null -ne $healthBefore) { $healthBefore.localOnly } else { $false })
    }

    foreach ($toggle in @(
      @{ id = "AutoRefreshToggle"; key = "autoRefresh"; label = "상태 자동 갱신"; statusId = "RefreshIntervalStatusText" },
      @{ id = "NotificationToggle"; key = "notifications"; label = "작업 완료 알림"; statusId = "NotificationStatusText" },
      @{ id = "TrayAnimationToggle"; key = "trayAnimations"; label = "트레이 아이콘 애니메이션"; statusId = "TrayAnimationStatusText" }
    )) {
      try {
        $before = Get-ToggleStateById $root $toggle.id
        $originalToggleStates[$toggle.id] = $before
        $target = if ($before -eq "On") { "Off" } else { "On" }
        $changed = Set-ToggleStateById $root $toggle.id $target
        $expectedValue = if ($target -eq "On") { "true" } else { "false" }
        $saved = Wait-Until -TimeoutMilliseconds 5000 -Condition {
          $preferences = Read-PreferenceMap $preferencePath
          $preferences[$toggle.key] -eq $expectedValue
        }
        $statusText = Get-ControlNameById $root $toggle.statusId
        Add-Check ("setting-write-" + $toggle.key) ($changed -and $saved -and -not [String]::IsNullOrWhiteSpace($statusText)) @{
          label = $toggle.label
          before = $before
          target = $target
          storedValue = $(if ($saved) { $expectedValue } else { "" })
          statusText = $statusText
        }
        $restored = Set-ToggleStateById $root $toggle.id $before
        Add-Check ("setting-restore-" + $toggle.key) $restored @{ restoredState = Get-ToggleStateById $root $toggle.id }
      } catch {
        Add-Check ("setting-write-" + $toggle.key) $false @{ label = $toggle.label; error = $_.Exception.Message }
      }
    }

    try {
      $intervalPhase = "write"
      $autoRefreshBefore = Get-ToggleStateById $root "AutoRefreshToggle"
      if ($autoRefreshBefore -ne "On") { Set-ToggleStateById $root "AutoRefreshToggle" "On" | Out-Null }
      $intervalBefore = Get-SelectedComboItemNameById $root "RefreshIntervalCombo"
      $originalRefreshInterval = $intervalBefore
      $targetInterval = @("5초", "15초", "30초", "1분") | Where-Object { $_ -ne $intervalBefore } | Select-Object -First 1
      $intervalSeconds = @{ "5초" = "5"; "15초" = "15"; "30초" = "30"; "1분" = "60" }
      $selected = Select-ComboItemByName $root "RefreshIntervalCombo" $targetInterval
      $intervalSaved = Wait-Until -TimeoutMilliseconds 5000 -Condition {
        $preferences = Read-PreferenceMap $preferencePath
        $preferences["refreshSeconds"] -eq $intervalSeconds[$targetInterval]
      }
      Add-Check "setting-write-refresh-interval" ($selected -and $intervalSaved) @{
        before = $intervalBefore
        target = $targetInterval
        storedSeconds = $intervalSeconds[$targetInterval]
      }
      if ($autoRefreshBefore -ne "On") { Set-ToggleStateById $root "AutoRefreshToggle" $autoRefreshBefore | Out-Null }
    } catch {
      Add-Check ("setting-" + $intervalPhase + "-refresh-interval") $false @{ error = $_.Exception.Message }
    }

    try {
      Show-PageByAutomationId $root "NavOverviewButton" "에이전트 개요"
      Show-PageByAutomationId $root "NavSettingsButton" "에이전트 설정"
      $connectionControlReady = Wait-ForControlEnabled $root "TestConnectionButton" 5000
      if (-not $connectionControlReady) { throw "연결 테스트 컨트롤이 준비 상태로 돌아오지 않았습니다." }
      $connectionButton = Find-ControlByAutomationId $root "TestConnectionButton"
      Invoke-Control $connectionButton
      $connectionReady = Wait-Until -TimeoutMilliseconds 12000 -Condition {
        (Get-ControlNameById $root "SettingsConnectionStateText") -like "연결됨 · 정체성 확인*"
      }
      $connectionNotice = Wait-Until -TimeoutMilliseconds 12000 -Condition {
        (Get-ControlNameById $root "NoticeTitleText") -eq "전체 점검 완료"
      }
      Add-Check "settings-live-connection-test" ($connectionReady -and $connectionNotice) @{
        state = Get-ControlNameById $root "SettingsConnectionStateText"
        notice = Get-ControlNameById $root "NoticeTitleText"
      }
    } catch {
      Add-Check "settings-live-connection-test" $false @{ error = $_.Exception.Message }
    }

    Show-PageByAutomationId $root "NavServiceButton" "Windows 서비스"
    Add-Check "service-navigation-functional" $true @{ title = Get-ControlNameById $root "PageTitleText" }
    Dismiss-NoticeIfVisible $root | Out-Null
    Capture-WindowScreenshot $root $serviceScreenshotPath | Out-Null
    Add-Check "service-screenshot" (Test-Path -LiteralPath $serviceScreenshotPath) @{ path = $serviceScreenshotPath }

    $serviceBefore = Get-CimInstance Win32_Service -Filter "Name='JarvisPcAgent'" -ErrorAction SilentlyContinue
    $functionalArtifacts.serviceStateBefore = if ($null -ne $serviceBefore) { [string]$serviceBefore.State } else { "not-installed" }
    $conflictText = Get-ControlNameById $root "ServiceConflictText"
    $conflictControl = Find-ControlByAutomationId $root "ServiceConflictText"
    Add-Check "service-dev-runtime-conflict-visible" ($conflictText -like "개발 런타임이 로컬 API 포트를 사용 중입니다*" -and $null -ne $conflictControl -and -not $conflictControl.Current.IsOffscreen) @{
      text = $conflictText
      serviceState = $functionalArtifacts.serviceStateBefore
    }
    $stopButton = Find-ControlByAutomationId $root "ServiceStopButton"
    Add-Check "service-stop-disabled-while-installed-service-stopped" ($null -ne $stopButton -and -not $stopButton.Current.IsEnabled) @{
      enabled = $(if ($null -ne $stopButton) { $stopButton.Current.IsEnabled } else { $null })
    }
    try {
      Invoke-Control (Find-ControlByAutomationId $root "ServiceStartButton")
      $guardNotice = Wait-Until -TimeoutMilliseconds 5000 -Condition {
        (Get-ControlNameById $root "NoticeTitleText") -eq "개발 런타임이 사용 중입니다"
      }
      $serviceAfter = Get-CimInstance Win32_Service -Filter "Name='JarvisPcAgent'" -ErrorAction SilentlyContinue
      $functionalArtifacts.serviceStateAfter = if ($null -ne $serviceAfter) { [string]$serviceAfter.State } else { "not-installed" }
      $healthAfterGuard = $null
      try { $healthAfterGuard = Invoke-RestMethod -Uri "http://127.0.0.1:17776/health" -Method Get -TimeoutSec 5 } catch { }
      Add-Check "service-start-conflict-fails-closed" ($guardNotice -and $functionalArtifacts.serviceStateAfter -eq $functionalArtifacts.serviceStateBefore -and $null -ne $healthAfterGuard -and $healthAfterGuard.module -eq "B_PC_AGENT") @{
        notice = Get-ControlNameById $root "NoticeTitleText"
        before = $functionalArtifacts.serviceStateBefore
        after = $functionalArtifacts.serviceStateAfter
        liveModule = $(if ($null -ne $healthAfterGuard) { $healthAfterGuard.module } else { "" })
      }
    } catch {
      Add-Check "service-start-conflict-fails-closed" $false @{ error = $_.Exception.Message }
    }

    Show-PageByAutomationId $root "NavDiagnosticsButton" "진단 및 복구"
    Add-Check "diagnostics-navigation-functional" $true @{ title = Get-ControlNameById $root "PageTitleText" }
    try {
      Invoke-Control (Find-ControlByAutomationId $root "RunAllChecksButton")
      $fullCheckReady = Wait-Until -TimeoutMilliseconds 12000 -Condition {
        (Get-ControlNameById $root "NoticeTitleText") -eq "전체 점검 완료"
      }
      Add-Check "diagnostics-full-check" ($fullCheckReady `
        -and (Get-ControlNameById $root "DiagnosticsApiStateText") -eq "정상" `
        -and (Get-ControlNameById $root "DiagnosticsControlCenterStateText") -eq "정상") @{
        api = Get-ControlNameById $root "DiagnosticsApiStateText"
        controlCenter = Get-ControlNameById $root "DiagnosticsControlCenterStateText"
        service = Get-ControlNameById $root "DiagnosticsServiceStateText"
      }
    } catch {
      Add-Check "diagnostics-full-check" $false @{ error = $_.Exception.Message }
    }

    try {
      $collectStartedAt = [DateTime]::UtcNow
      Invoke-Control (Find-ControlByAutomationId $root "CollectLogsButton")
      $busyGuard = Wait-Until -TimeoutMilliseconds 3000 -Condition {
        $verify = Find-ControlByAutomationId $root "VerifyPackageButton"
        $null -ne $verify -and -not $verify.Current.IsEnabled
      }
      Add-Check "diagnostics-busy-reentrancy-guard" $busyGuard @{}
      $collectFinished = Wait-ForControlEnabled $root "CollectLogsButton" 120000
      $diagnosticZip = Get-ChildItem -LiteralPath (Split-Path -Parent $ExecutablePath) -Filter "logs-*.zip" -File `
        | Where-Object { $_.LastWriteTimeUtc -ge $collectStartedAt.AddSeconds(-2) } `
        | Sort-Object LastWriteTimeUtc -Descending `
        | Select-Object -First 1
      if ($null -ne $diagnosticZip) { $functionalArtifacts.diagnosticZip = $diagnosticZip.FullName }
      $summary = $null
      $entries = @()
      if ($null -ne $diagnosticZip) {
        $archive = [IO.Compression.ZipFile]::OpenRead($diagnosticZip.FullName)
        try {
          $entries = @($archive.Entries | ForEach-Object { $_.FullName })
          $summaryEntry = $archive.Entries | Where-Object { $_.FullName -eq "diagnostic-summary.json" } | Select-Object -First 1
          if ($null -ne $summaryEntry) {
            $reader = New-Object IO.StreamReader($summaryEntry.Open(), [Text.Encoding]::UTF8)
            try { $summary = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
          }
        } finally {
          $archive.Dispose()
        }
      }
      Add-Check "diagnostics-collection-functional" ($collectFinished -and $null -ne $diagnosticZip -and $diagnosticZip.Length -gt 0 -and $entries -contains "diagnostic-summary.json") @{
        path = $(if ($null -ne $diagnosticZip) { $diagnosticZip.FullName } else { "" })
        bytes = $(if ($null -ne $diagnosticZip) { $diagnosticZip.Length } else { 0 })
        status = Get-ControlNameById $root "CollectStatusText"
      }
      Add-Check "diagnostics-privacy-contract" ($null -ne $summary `
        -and $summary.sensitiveFilesExcluded -eq $true `
        -and $summary.privacyRedactionApplied -eq $true `
        -and $summary.rawSecretsIncluded -eq $false) @{
        sensitiveFilesExcluded = $(if ($null -ne $summary) { $summary.sensitiveFilesExcluded } else { $null })
        privacyRedactionApplied = $(if ($null -ne $summary) { $summary.privacyRedactionApplied } else { $null })
        rawSecretsIncluded = $(if ($null -ne $summary) { $summary.rawSecretsIncluded } else { $null })
      }
    } catch {
      Add-Check "diagnostics-collection-functional" $false @{ error = $_.Exception.Message }
    }

    try {
      Invoke-Control (Find-ControlByAutomationId $root "VerifyPackageButton")
      $verifyFinished = Wait-ForControlEnabled $root "VerifyPackageButton" 60000
      $verifyStatus = Get-ControlNameById $root "VerifyStatusText"
      Add-Check "package-verification-functional" ($verifyFinished -and $verifyStatus -like "현재 설치 패키지의 파일 무결성을 확인했습니다*") @{
        status = $verifyStatus
        notice = Get-ControlNameById $root "NoticeTitleText"
      }
    } catch {
      Add-Check "package-verification-functional" $false @{ error = $_.Exception.Message }
    }

    Dismiss-NoticeIfVisible $root | Out-Null
    Capture-WindowScreenshot $root $diagnosticsScreenshotPath | Out-Null
    Add-Check "diagnostics-screenshot" (Test-Path -LiteralPath $diagnosticsScreenshotPath) @{ path = $diagnosticsScreenshotPath }
  } else {
    Add-Skip "functional-actions" "SkipFunctionalActions가 지정됨" @{}
  }
} catch {
  Add-Check "functional-ui-flow-unhandled" $false @{ error = $_.Exception.Message }
} finally {
  if (-not $SkipFunctionalActions) {
    try {
      Show-PageByAutomationId $root "NavSettingsButton" "에이전트 설정"
      $autoRefreshOriginal = $originalToggleStates["AutoRefreshToggle"]
      if (-not [String]::IsNullOrWhiteSpace($originalRefreshInterval)) {
        if ((Get-ToggleStateById $root "AutoRefreshToggle") -ne "On") {
          Set-ToggleStateById $root "AutoRefreshToggle" "On" | Out-Null
        }
        if ((Get-SelectedComboItemNameById $root "RefreshIntervalCombo") -ne $originalRefreshInterval) {
          Select-ComboItemByName $root "RefreshIntervalCombo" $originalRefreshInterval | Out-Null
        }
        Show-PageByAutomationId $root "NavOverviewButton" "에이전트 개요"
        Show-PageByAutomationId $root "NavSettingsButton" "에이전트 설정"
        if (-not (Wait-ForControlEnabled $root "RefreshIntervalCombo" 5000)) {
          throw "복원된 갱신 주기 컨트롤을 다시 확인할 수 없습니다."
        }
        $restoredRefreshInterval = Get-SelectedComboItemNameById $root "RefreshIntervalCombo"
        Add-Check "setting-restore-refresh-interval" ($restoredRefreshInterval -eq $originalRefreshInterval) @{
          restored = $restoredRefreshInterval
        }
      }
      foreach ($entry in $originalToggleStates.GetEnumerator()) {
        Set-ToggleStateById $root $entry.Key $entry.Value | Out-Null
      }
      Add-Check "settings-runtime-restored" $true @{
        refreshInterval = $(if ([String]::IsNullOrWhiteSpace($originalRefreshInterval)) { "not-changed" } else { Get-SelectedComboItemNameById $root "RefreshIntervalCombo" })
        autoRefresh = $(if ([String]::IsNullOrWhiteSpace($autoRefreshOriginal)) { "not-captured" } else { Get-ToggleStateById $root "AutoRefreshToggle" })
      }
    } catch {
      Add-Check "settings-runtime-restored" $false @{ error = $_.Exception.Message }
    }
    try {
      $preferenceDirectory = Split-Path -Parent $preferencePath
      if ($preferenceExisted) {
        if (-not (Test-Path -LiteralPath $preferenceDirectory)) { New-Item -ItemType Directory -Path $preferenceDirectory -Force | Out-Null }
        [IO.File]::WriteAllBytes($preferencePath, $preferenceBytes)
      } elseif (Test-Path -LiteralPath $preferencePath) {
        Remove-Item -LiteralPath $preferencePath -Force
      }
      Add-Check "settings-file-restored-exactly" $true @{ existedBefore = $preferenceExisted }
    } catch {
      Add-Check "settings-file-restored-exactly" $false @{ existedBefore = $preferenceExisted; error = $_.Exception.Message }
    }
  }
}

try { Show-PageByAutomationId $root "NavOverviewButton" "에이전트 개요" } catch { Add-Check "overview-navigation-functional" $false @{ error = $_.Exception.Message } }

$desktopRoot = [System.Windows.Automation.AutomationElement]::RootElement
[JarvisTraySmokeMouse]::RevealTaskbar() | Out-Null
Start-Sleep -Milliseconds 700
$jarvisNameCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  "JARVIS PC 에이전트"
)
$trayButton = Find-VisibleTrayButton $desktopRoot $jarvisNameCondition

if ($null -eq $trayButton) {
  $overflowCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "숨겨진 아이콘 표시"
  )
  $overflowButton = $desktopRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $overflowCondition)
  if ($null -ne $overflowButton) {
    Invoke-Control $overflowButton
    Start-Sleep -Milliseconds 450
    $trayButton = Find-VisibleTrayButton $desktopRoot $jarvisNameCondition
  }
}

$trayButtonBounds = if ($null -ne $trayButton) { $trayButton.Current.BoundingRectangle.ToString() } else { "" }
Add-Check "tray-icon-accessible-name" ($null -ne $trayButton) @{
  expected = "JARVIS PC 에이전트"
  dynamicStatusExcluded = $true
  bounds = $trayButtonBounds
}

$trayMenuScreenshotPath = ""
$lastTrayClickBounds = ""
$lastCursorPosition = ""
$lastClickX = 0
$lastClickY = 0
$notificationOcclusionDismissed = $false
if ($null -ne $trayButton) {
  $trayMenuItems = @(Get-TrayMenuItems)
  for ($attempt = 0; $attempt -lt 3 -and $trayMenuItems.Count -eq 0; $attempt++) {
    $trayButton = Find-VisibleTrayButton $desktopRoot $jarvisNameCondition
    if ($null -eq $trayButton) {
      [JarvisTraySmokeMouse]::RevealTaskbar() | Out-Null
      Start-Sleep -Milliseconds 550
      $overflowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        "숨겨진 아이콘 표시"
      )
      $overflowButton = $desktopRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $overflowCondition)
      if ($null -ne $overflowButton) {
        Invoke-Control $overflowButton
        Start-Sleep -Milliseconds 450
        $trayButton = Find-VisibleTrayButton $desktopRoot $jarvisNameCondition
      }
    }
    if ($null -eq $trayButton) { continue }
    $trayBounds = $trayButton.Current.BoundingRectangle
    $clickX = [int]($trayBounds.Left + ($trayBounds.Width / 2))
    $clickY = [int]($trayBounds.Top + ($trayBounds.Height / 2))
    if ([JarvisTraySmokeMouse]::DismissNotificationAt($clickX, $clickY)) {
      $notificationOcclusionDismissed = $true
      Start-Sleep -Milliseconds 550
      $trayButton = Find-VisibleTrayButton $desktopRoot $jarvisNameCondition
      if ($null -eq $trayButton) { continue }
      $trayBounds = $trayButton.Current.BoundingRectangle
      $clickX = [int]($trayBounds.Left + ($trayBounds.Width / 2))
      $clickY = [int]($trayBounds.Top + ($trayBounds.Height / 2))
    }
    $lastTrayClickBounds = $trayBounds.ToString()
    $lastClickX = $clickX
    $lastClickY = $clickY
    $cursorMoved = [JarvisTraySmokeMouse]::SetCursorPos(
      $clickX,
      $clickY
    )
    $lastCursorPosition = [System.Windows.Forms.Cursor]::Position.ToString()
    $rightClickSent = [JarvisTraySmokeMouse]::SendRightClick()
    if ($attempt -eq 0) {
      Start-Sleep -Milliseconds 240
      $probeBitmap = New-Object System.Drawing.Bitmap(720, 620)
      $probeGraphics = [System.Drawing.Graphics]::FromImage($probeBitmap)
      try {
        $probeGraphics.CopyFromScreen([Math]::Max(0, $clickX - 470), [Math]::Max(0, $clickY - 570), 0, 0, $probeBitmap.Size)
        $probeBitmap.Save((Join-Path $OutputDirectory "tray-click-attempt.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $probeGraphics.Dispose()
        $probeBitmap.Dispose()
      }
    }
    $menuDeadline = [DateTime]::UtcNow.AddSeconds(1.8)
    do {
      Start-Sleep -Milliseconds 120
      $trayMenuItems = @(Get-TrayMenuItems)
    } while ($trayMenuItems.Count -eq 0 -and [DateTime]::UtcNow -lt $menuDeadline)
    if ($trayMenuItems.Count -eq 0) {
      [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
      Start-Sleep -Milliseconds 180
    }
  }
  $trayMenuBlocker = ""
  if ($trayMenuItems.Count -eq 0 -and $lastClickX -ne 0 -and $lastClickY -ne 0) {
    $windowAtTrayIcon = [JarvisTraySmokeMouse]::DescribeWindowAt($lastClickX, $lastClickY)
    if ((-not $windowAtTrayIcon.StartsWith("TopLevelWindowForOverflowXamlIsland", [StringComparison]::Ordinal)) -and (-not $windowAtTrayIcon.StartsWith("#32768", [StringComparison]::Ordinal))) {
      $trayMenuBlocker = "외부 창이 트레이 아이콘을 가림: " + $windowAtTrayIcon
    }
  }
  Add-TrayCheck "tray-menu-discovered" ($trayMenuItems.Count -gt 0) @{
    menuItemCount = $trayMenuItems.Count
    clickBounds = $lastTrayClickBounds
    cursorPosition = $lastCursorPosition
    cursorMoved = $cursorMoved
    rightClickSent = $rightClickSent
    notificationOcclusionDismissed = $notificationOcclusionDismissed
  } $trayMenuBlocker
  $trayMenuNames = @($trayMenuItems | ForEach-Object { $_.Current.Name })
  Add-TrayCheck "tray-menu-current-status" (@($trayMenuNames | Where-Object { $_ -like "현재 상태 · *" }).Count -eq 1) @{} $trayMenuBlocker
  Add-TrayCheck "tray-menu-status-detail" (@($trayMenuNames | Where-Object { $_ -like "세부 정보 · *" }).Count -eq 1) @{} $trayMenuBlocker
  foreach ($menuName in @(
    "상태 다시 확인",
    "진단 및 복구 열기",
    "에이전트 시작",
    "에이전트 중지",
    "에이전트 다시 시작",
    "에이전트 업데이트",
    "진단 기록 수집",
    "설치 패키지 검증",
    "아이콘 애니메이션",
    "JARVIS 제어 센터 열기",
    "트레이 종료"
  )) {
    Add-TrayCheck ("tray-menu-" + $menuName) ($trayMenuNames -contains $menuName) @{} $trayMenuBlocker
  }
  Add-TrayCheck "incident-action-hidden-when-healthy" (-not ($trayMenuNames -contains "오류 알림 확인")) @{} $trayMenuBlocker

  if ($trayMenuItems.Count -gt 0) {
    $left = ($trayMenuItems | ForEach-Object { $_.Current.BoundingRectangle.Left } | Measure-Object -Minimum).Minimum
    $top = ($trayMenuItems | ForEach-Object { $_.Current.BoundingRectangle.Top } | Measure-Object -Minimum).Minimum
    $right = ($trayMenuItems | ForEach-Object { $_.Current.BoundingRectangle.Right } | Measure-Object -Maximum).Maximum
    $bottom = ($trayMenuItems | ForEach-Object { $_.Current.BoundingRectangle.Bottom } | Measure-Object -Maximum).Maximum
    $trayMenuScreenshotPath = Join-Path $OutputDirectory "tray-menu.png"
    $menuBitmap = New-Object System.Drawing.Bitmap(
      [Math]::Max(1, [int][Math]::Ceiling($right - $left + 12)),
      [Math]::Max(1, [int][Math]::Ceiling($bottom - $top + 12))
    )
    $menuGraphics = [System.Drawing.Graphics]::FromImage($menuBitmap)
    try {
      $menuGraphics.CopyFromScreen([int]$left - 6, [int]$top - 6, 0, 0, $menuBitmap.Size)
      $menuBitmap.Save($trayMenuScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $menuGraphics.Dispose()
      $menuBitmap.Dispose()
    }
  }
  $trayMenuScreenshotExists = -not [String]::IsNullOrWhiteSpace($trayMenuScreenshotPath) -and (Test-Path -LiteralPath $trayMenuScreenshotPath)
  Add-TrayCheck "tray-menu-screenshot" $trayMenuScreenshotExists @{ path = $trayMenuScreenshotPath } $trayMenuBlocker
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
}

$failed = @($checks | Where-Object { $_.status -eq "fail" })
$report = [ordered]@{
  schema = "jarvis-pc-agent-tray-ui-smoke-v2"
  generatedAt = [DateTime]::UtcNow.ToString("o")
  executablePath = $ExecutablePath
  processId = $process.Id
  functionalActionsExecuted = -not $SkipFunctionalActions
  allPassed = $failed.Count -eq 0
  checks = $checks
  screenshotPath = $screenshotPath
  serviceScreenshotPath = $serviceScreenshotPath
  diagnosticsScreenshotPath = $diagnosticsScreenshotPath
  trayMenuScreenshotPath = $trayMenuScreenshotPath
  functionalArtifacts = $functionalArtifacts
  lastTrayMenuProbe = $lastTrayMenuProbe
}
$reportPath = Join-Path $OutputDirectory "report.json"
[System.IO.File]::WriteAllText(
  $reportPath,
  ($report | ConvertTo-Json -Depth 8),
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "PC 에이전트 트레이 UI 스모크 결과: $reportPath"
if ($failed.Count -gt 0) {
  throw "PC 에이전트 트레이 UI 스모크 검사에서 $($failed.Count)개 항목이 실패했습니다."
}
