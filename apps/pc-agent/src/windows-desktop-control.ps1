param(
  [string]$RequestBase64 = $env:JARVIS_DESKTOP_REQUEST_BASE64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:JarvisDesktopDiagnostic = $null
$desktopLease = $null
$desktopLeaseOwned = $false
$desktopLeaseAbandoned = $false
$desktopLeaseWaitMs = 0
$operationResults = @()
$verificationResults = @()
$currentOperationName = $null

function Get-JarvisHash([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Value)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-JarvisProperty($Object, [string]$Name, $Default = $null) {
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Test-JarvisText([string]$Actual, [string]$Expected, [switch]$Contains) {
  if ($Contains) {
    return ([string]$Actual).IndexOf([string]$Expected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  return [string]::Equals([string]$Actual, [string]$Expected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-JarvisWindow($Selector, [int]$TimeoutMs = 3000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $TimeoutMs))
  do {
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $windows = New-Object System.Collections.ArrayList
    $requestedProcess = [int](Get-JarvisProperty $Selector 'processId' 0)
    $seenHandles = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($root in $roots) {
      try {
        if ($requestedProcess -gt 0 -and $root.Current.ProcessId -ne $requestedProcess) { continue }
        if ($seenHandles.Add($root.Current.NativeWindowHandle)) { [void]$windows.Add($root) }
        if ($requestedProcess -gt 0) {
          $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
          foreach ($child in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)) {
            if ($child.Current.ProcessId -eq $requestedProcess -and $seenHandles.Add($child.Current.NativeWindowHandle)) { [void]$windows.Add($child) }
          }
        }
      } catch { }
    }
    $matching = New-Object System.Collections.ArrayList
    foreach ($window in $windows) {
      try {
        $current = $window.Current
        $processId = [int](Get-JarvisProperty $Selector 'processId' 0)
        if ($processId -gt 0 -and $current.ProcessId -ne $processId) { continue }
        $title = [string](Get-JarvisProperty $Selector 'title' '')
        if ($title -and !(Test-JarvisText $current.Name $title)) { continue }
        $titleContains = [string](Get-JarvisProperty $Selector 'titleContains' '')
        if ($titleContains -and !(Test-JarvisText $current.Name $titleContains -Contains)) { continue }
        $className = [string](Get-JarvisProperty $Selector 'className' '')
        if ($className -and !(Test-JarvisText $current.ClassName $className)) { continue }
        $processName = [string](Get-JarvisProperty $Selector 'processName' '')
        if ($processName) {
          $candidate = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
          if ($null -eq $candidate -or !(Test-JarvisText $candidate.ProcessName $processName)) { continue }
        }
        [void]$matching.Add($window)
      } catch { }
    }
    if ($matching.Count -gt 1) { throw 'desktop-window-ambiguous' }
    if ($matching.Count -eq 1) { return $matching[0] }
    if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Test-JarvisElement($Element, $Selector) {
  try {
    $current = $Element.Current
    $automationId = [string](Get-JarvisProperty $Selector 'automationId' '')
    if ($automationId -and !(Test-JarvisText $current.AutomationId $automationId)) { return $false }
    $name = [string](Get-JarvisProperty $Selector 'name' '')
    if ($name -and !(Test-JarvisText $current.Name $name)) { return $false }
    $nameContains = [string](Get-JarvisProperty $Selector 'nameContains' '')
    if ($nameContains -and !(Test-JarvisText $current.Name $nameContains -Contains)) { return $false }
    $className = [string](Get-JarvisProperty $Selector 'className' '')
    if ($className -and !(Test-JarvisText $current.ClassName $className)) { return $false }
    $controlType = [string](Get-JarvisProperty $Selector 'controlType' '')
    if ($controlType) {
      $actualType = ([string]$current.ControlType.ProgrammaticName).Replace('ControlType.', '')
      if (!(Test-JarvisText $actualType $controlType)) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function Get-JarvisElement($Window, $Selector) {
  if ($null -eq $Window -or $null -eq $Selector) { return $null }
  $explicitIndex = Get-JarvisProperty $Selector 'index' $null
  $index = if ($null -eq $explicitIndex) { 0 } else { [int]$explicitIndex }
  $matched = New-Object System.Collections.ArrayList
  $elements = $Window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $elements) {
    if (Test-JarvisElement $element $Selector) {
      [void]$matched.Add($element)
    }
  }
  if ($null -eq $explicitIndex -and $matched.Count -gt 1) { throw 'desktop-element-ambiguous' }
  if ($index -ge 0 -and $index -lt $matched.Count) { return $matched[$index] }
  return $null
}

function Get-JarvisElementValue($Element) {
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    return [string]$pattern.Current.Value
  }
  $legacy = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacy)) {
    if ($null -ne $legacy.Current.Value) { return [string]$legacy.Current.Value }
  }
  return [string]$Element.Current.Name
}

function Set-JarvisForeground($Window) {
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -ne [IntPtr]::Zero) {
    [JarvisDesktopNative]::ActivateWindow($handle) | Out-Null
  }
  try { $Window.SetFocus() } catch { }
}

function Invoke-JarvisVerifiedMouseClick($Window, [int]$ClickX, [int]$ClickY) {
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  $processId = [int]$Window.Current.ProcessId
  if ($handle -eq [IntPtr]::Zero -or $processId -le 0) { throw 'desktop-visual-target-window-invalid' }

  Set-JarvisForeground $Window
  Start-Sleep -Milliseconds 30
  if ([JarvisDesktopNative]::GetForegroundWindow() -ne $handle) {
    throw 'desktop-visual-target-lost-foreground'
  }

  $original = New-Object JarvisDesktopPoint
  $restoreCursor = [JarvisDesktopNative]::GetCursorPos([ref]$original)
  try {
    if (![JarvisDesktopNative]::SetCursorPos($ClickX, $ClickY)) { throw 'desktop-visual-cursor-position-failed' }
    if ([JarvisDesktopNative]::GetForegroundWindow() -ne $handle) {
      throw 'desktop-visual-target-lost-foreground'
    }
    if (![JarvisDesktopNative]::PointBelongsToProcess($ClickX, $ClickY, $processId)) {
      throw 'desktop-visual-point-not-owned-by-target'
    }
    [JarvisDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [JarvisDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  } finally {
    if ($restoreCursor) { [JarvisDesktopNative]::SetCursorPos($original.X, $original.Y) | Out-Null }
  }
  Start-Sleep -Milliseconds 120
}

function Invoke-JarvisVisualTextClick($Window, $Operation) {
  $started = [DateTime]::UtcNow
  $text = [string](Get-JarvisProperty $Operation 'text' '')
  if ([string]::IsNullOrWhiteSpace($text)) { throw 'desktop-visual-text-required' }
  $matchMode = ([string](Get-JarvisProperty $Operation 'matchMode' 'exact')).ToLowerInvariant()
  if ($matchMode -notin @('exact', 'contains')) { $matchMode = 'exact' }
  $occurrence = [int](Get-JarvisProperty $Operation 'occurrence' -1)

  Set-JarvisForeground $Window
  Start-Sleep -Milliseconds 180
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero -or [JarvisDesktopNative]::GetForegroundWindow() -ne $handle) {
    throw 'desktop-visual-foreground-verification-failed'
  }

  $bounds = $Window.Current.BoundingRectangle
  $capture = @{
    x = [int][Math]::Floor($bounds.X)
    y = [int][Math]::Floor($bounds.Y)
    width = [int][Math]::Ceiling($bounds.Width)
    height = [int][Math]::Ceiling($bounds.Height)
  }
  $ocrRequest = @{ bounds = $capture; windowHandle = $handle.ToInt64(); query = $text; matchMode = $matchMode }
  $ocrJson = $ocrRequest | ConvertTo-Json -Compress -Depth 5
  $ocrBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ocrJson))
  $ocrHelper = Join-Path $PSScriptRoot 'windows-local-ocr.ps1'
  if (!(Test-Path -LiteralPath $ocrHelper)) { throw 'desktop-local-ocr-helper-missing' }
  $previousOcrRequest = $env:JARVIS_LOCAL_OCR_REQUEST_BASE64
  try {
    $env:JARVIS_LOCAL_OCR_REQUEST_BASE64 = $ocrBase64
    $ocrOutput = & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $ocrHelper
  } finally {
    if ($null -eq $previousOcrRequest) { Remove-Item Env:JARVIS_LOCAL_OCR_REQUEST_BASE64 -ErrorAction SilentlyContinue }
    else { $env:JARVIS_LOCAL_OCR_REQUEST_BASE64 = $previousOcrRequest }
  }
  if ($LASTEXITCODE -ne 0 -or !$ocrOutput) { throw 'desktop-local-ocr-process-failed' }
  try { $ocr = ($ocrOutput | Select-Object -Last 1) | ConvertFrom-Json } catch { throw 'desktop-local-ocr-output-invalid' }
  $script:JarvisDesktopDiagnostic = @{
    kind = 'local-ocr'
    status = [string]$ocr.status
    matchCount = [int]$ocr.matchCount
    wordCount = [int]$ocr.wordCount
    captureWidth = [int]$ocr.captureWidth
    captureHeight = [int]$ocr.captureHeight
    captureHash = [string]$ocr.captureHash
    captureMode = [string]$ocr.captureMode
  }
  if ($ocr.status -ne 'success') { throw "desktop-local-ocr-failed:$([string]$ocr.stage):$([string]$ocr.errorType):$([string]$ocr.hresult)" }

  $matches = @($ocr.matches)
  if ($matches.Count -eq 0) { throw 'desktop-visual-text-not-found' }
  if ($occurrence -lt 0 -and $matches.Count -ne 1) { throw 'desktop-visual-text-ambiguous' }
  $selectedIndex = if ($occurrence -ge 0) { $occurrence } else { 0 }
  if ($selectedIndex -ge $matches.Count) { throw 'desktop-visual-occurrence-out-of-range' }
  $selected = $matches[$selectedIndex]
  $clickX = [int]$selected.centerX
  $clickY = [int]$selected.centerY
  if ($clickX -lt $bounds.Left -or $clickX -gt $bounds.Right -or $clickY -lt $bounds.Top -or $clickY -gt $bounds.Bottom) {
    throw 'desktop-visual-point-outside-target-window'
  }

  Invoke-JarvisVerifiedMouseClick $Window $clickX $clickY

  return @{
    op = 'clicktext'
    status = 'completed'
    perception = @{
      adapterVersion = [string]$ocr.adapterVersion
      engine = [string]$ocr.engine
      languageTag = [string]$ocr.languageTag
      queryHash = [string]$ocr.queryHash
      matchMode = [string]$ocr.matchMode
      matchCount = [int]$ocr.matchCount
      selectedIndex = $selectedIndex
      wordCount = [int]$ocr.wordCount
      captureHash = [string]$ocr.captureHash
      captureMode = [string]$ocr.captureMode
      screenshotStored = $false
      rawOcrTextStored = $false
      foregroundVerified = $true
    }
    durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  }
}

function Invoke-JarvisVisualTemplateClick($Window, $Operation) {
  $started = [DateTime]::UtcNow
  $templatePath = [string](Get-JarvisProperty $Operation 'templatePath' '')
  $templateHash = [string](Get-JarvisProperty $Operation 'templateHash' '')
  $minimumConfidence = [double](Get-JarvisProperty $Operation 'minConfidence' 0.9)
  $scaleTolerance = [double](Get-JarvisProperty $Operation 'scaleTolerance' 0.2)
  $requiredAmbiguityGap = [double](Get-JarvisProperty $Operation 'ambiguityGap' 0.03)
  $occurrence = [int](Get-JarvisProperty $Operation 'occurrence' -1)
  if ([string]::IsNullOrWhiteSpace($templatePath) -or [string]::IsNullOrWhiteSpace($templateHash)) {
    throw 'desktop-visual-template-required'
  }

  Set-JarvisForeground $Window
  Start-Sleep -Milliseconds 180
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero -or [JarvisDesktopNative]::GetForegroundWindow() -ne $handle) {
    throw 'desktop-visual-foreground-verification-failed'
  }

  $bounds = $Window.Current.BoundingRectangle
  $capture = @{
    x = [int][Math]::Floor($bounds.X)
    y = [int][Math]::Floor($bounds.Y)
    width = [int][Math]::Ceiling($bounds.Width)
    height = [int][Math]::Ceiling($bounds.Height)
  }
  $templateRequest = @{
    bounds = $capture
    windowHandle = $handle.ToInt64()
    templatePath = $templatePath
    templateHash = $templateHash
    minConfidence = $minimumConfidence
    scaleTolerance = $scaleTolerance
  }
  $templateJson = $templateRequest | ConvertTo-Json -Compress -Depth 5
  $templateBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($templateJson))
  $templateHelper = Join-Path $PSScriptRoot 'windows-local-template-match.ps1'
  if (!(Test-Path -LiteralPath $templateHelper)) { throw 'desktop-local-template-helper-missing' }
  $previousTemplateRequest = $env:JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64
  try {
    $env:JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64 = $templateBase64
    $templateOutput = & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $templateHelper
  } finally {
    if ($null -eq $previousTemplateRequest) { Remove-Item Env:JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64 -ErrorAction SilentlyContinue }
    else { $env:JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64 = $previousTemplateRequest }
  }
  if ($LASTEXITCODE -ne 0 -or !$templateOutput) { throw 'desktop-local-template-process-failed' }
  try { $templateResult = ($templateOutput | Select-Object -Last 1) | ConvertFrom-Json } catch { throw 'desktop-local-template-output-invalid' }
  $script:JarvisDesktopDiagnostic = @{
    kind = 'local-template'
    status = [string]$templateResult.status
    matchCount = [int]$templateResult.matchCount
    candidateCount = [int]$templateResult.candidateCount
    captureHash = [string]$templateResult.captureHash
    captureMode = [string]$templateResult.captureMode
  }
  if ($templateResult.status -ne 'success') {
    throw "desktop-local-template-failed:$([string]$templateResult.stage):$([string]$templateResult.errorType):$([string]$templateResult.hresult)"
  }

  $matches = @($templateResult.matches)
  if ($matches.Count -eq 0) { throw 'desktop-visual-template-not-found' }
  $observedGap = [double]$templateResult.bestConfidence - [double]$templateResult.secondConfidence
  if ($occurrence -lt 0 -and ($matches.Count -ne 1 -or $observedGap -lt $requiredAmbiguityGap)) {
    throw 'desktop-visual-template-ambiguous'
  }
  $selectedIndex = if ($occurrence -ge 0) { $occurrence } else { 0 }
  if ($selectedIndex -ge $matches.Count) { throw 'desktop-visual-occurrence-out-of-range' }
  $selected = $matches[$selectedIndex]
  $clickX = [int]$selected.centerX
  $clickY = [int]$selected.centerY
  if ($clickX -lt $bounds.Left -or $clickX -gt $bounds.Right -or $clickY -lt $bounds.Top -or $clickY -gt $bounds.Bottom) {
    throw 'desktop-visual-point-outside-target-window'
  }

  Invoke-JarvisVerifiedMouseClick $Window $clickX $clickY

  return @{
    op = 'clicktemplate'
    status = 'completed'
    perception = @{
      adapterVersion = [string]$templateResult.adapterVersion
      engine = [string]$templateResult.engine
      templateHash = [string]$templateResult.templateHash
      matchCount = [int]$templateResult.matchCount
      candidateCount = [int]$templateResult.candidateCount
      selectedIndex = $selectedIndex
      confidence = [double]$selected.confidence
      secondConfidence = [double]$templateResult.secondConfidence
      ambiguityGap = $observedGap
      selectedScale = [double]$selected.scale
      captureHash = [string]$templateResult.captureHash
      captureMode = [string]$templateResult.captureMode
      screenshotStored = $false
      rawPixelsStored = $false
      templateCopied = $false
      foregroundVerified = $true
    }
    durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  }
}

function Get-JarvisWindowRecord($Window) {
  if ($null -eq $Window) { return @{ found = $false } }
  $current = $Window.Current
  $title = [string]$current.Name
  $bounds = $current.BoundingRectangle
  return @{
    found = $true
    processId = $current.ProcessId
    className = $current.ClassName
    titleLength = $title.Length
    titleHash = Get-JarvisHash $title
    bounds = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
  }
}

function Get-JarvisElementRecord($Element) {
  if ($null -eq $Element) { return @{ found = $false } }
  $current = $Element.Current
  $name = [string]$current.Name
  return @{
    found = $true
    automationId = $current.AutomationId
    className = $current.ClassName
    controlType = ([string]$current.ControlType.ProgrammaticName).Replace('ControlType.', '')
    enabled = $current.IsEnabled
    offscreen = $current.IsOffscreen
    password = $current.IsPassword
    nameLength = $name.Length
    nameHash = Get-JarvisHash $name
  }
}

function Invoke-JarvisOperation($Operation, $DefaultTarget, [int]$DefaultTimeoutMs) {
  $opName = ([string](Get-JarvisProperty $Operation 'op' '')).ToLowerInvariant()
  $started = [DateTime]::UtcNow
  $target = Get-JarvisProperty $Operation 'target' $DefaultTarget
  $timeoutMs = [int](Get-JarvisProperty $Operation 'timeoutMs' $DefaultTimeoutMs)
  $window = $null
  $element = $null

  if ($opName -eq 'launch') {
    $filePath = [string](Get-JarvisProperty $Operation 'filePath' '')
    $arguments = @((Get-JarvisProperty $Operation 'arguments' @()) | ForEach-Object { [string]$_ })
    $process = if ($arguments.Count -gt 0) {
      Start-Process -FilePath $filePath -ArgumentList $arguments -PassThru
    } else {
      Start-Process -FilePath $filePath -PassThru
    }
    return @{ op = $opName; status = 'completed'; processId = $process.Id; durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds }
  }

  if ($opName -eq 'wait') {
    Start-Sleep -Milliseconds ([Math]::Min(5000, [Math]::Max(0, $timeoutMs)))
    return @{ op = $opName; status = 'completed'; durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds }
  }

  $window = Get-JarvisWindow $target $timeoutMs
  if ($null -eq $window) { throw "desktop-window-not-found:$opName" }

  if ($opName -eq 'inspect') {
    return @{ op = $opName; status = 'completed'; window = Get-JarvisWindowRecord $window; durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds }
  }
  if ($opName -eq 'focuswindow') {
    Set-JarvisForeground $window
    return @{ op = $opName; status = 'completed'; window = Get-JarvisWindowRecord $window; durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds }
  }
  if ($opName -eq 'clicktext') {
    return Invoke-JarvisVisualTextClick $window $Operation
  }
  if ($opName -eq 'clicktemplate') {
    return Invoke-JarvisVisualTemplateClick $window $Operation
  }

  $selector = Get-JarvisProperty $Operation 'selector' $null
  $element = Get-JarvisElement $window $selector
  if ($null -eq $element) { throw "desktop-element-not-found:$opName" }
  if ($element.Current.IsPassword) { throw 'desktop-password-control-blocked' }

  if ($opName -eq 'setfocus') {
    Set-JarvisForeground $window
    $element.SetFocus()
  } elseif ($opName -eq 'setvalue') {
    $value = [string](Get-JarvisProperty $Operation 'value' '')
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      throw 'desktop-value-pattern-unavailable'
    }
    if ($pattern.Current.IsReadOnly) { throw 'desktop-value-control-readonly' }
    $pattern.SetValue($value)
  } elseif ($opName -eq 'sendkeys') {
    Set-JarvisForeground $window
    $element.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait([string](Get-JarvisProperty $Operation 'keys' ''))
  } elseif ($opName -eq 'invoke' -or $opName -eq 'clickelement') {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      throw 'desktop-invoke-pattern-unavailable'
    }
    $pattern.Invoke()
  } elseif ($opName -eq 'toggle') {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
      throw 'desktop-toggle-pattern-unavailable'
    }
    $pattern.Toggle()
  } elseif ($opName -eq 'select') {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      throw 'desktop-selection-pattern-unavailable'
    }
    $pattern.Select()
  } elseif ($opName -eq 'expand' -or $opName -eq 'collapse') {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
      throw 'desktop-expand-pattern-unavailable'
    }
    if ($opName -eq 'expand') { $pattern.Expand() } else { $pattern.Collapse() }
  } else {
    throw "desktop-operation-unsupported:$opName"
  }

  return @{
    op = $opName
    status = 'completed'
    element = Get-JarvisElementRecord $element
    durationMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  }
}

function Test-JarvisVerificationOnce($Check, $DefaultTarget, [int]$DefaultTimeoutMs) {
  $type = ([string](Get-JarvisProperty $Check 'type' '')).ToLowerInvariant()
  $target = Get-JarvisProperty $Check 'target' $DefaultTarget
  $timeoutMs = [int](Get-JarvisProperty $Check 'timeoutMs' $DefaultTimeoutMs)
  $window = Get-JarvisWindow $target $timeoutMs
  if ($type -eq 'windowexists') {
    return @{ type = $type; passed = $null -ne $window }
  }
  if ($null -eq $window) { return @{ type = $type; passed = $false; reason = 'window-not-found' } }
  if ($type -eq 'windowtitlecontains') {
    $expected = [string](Get-JarvisProperty $Check 'expected' '')
    return @{ type = $type; passed = Test-JarvisText $window.Current.Name $expected -Contains; expectedHash = Get-JarvisHash $expected; actualHash = Get-JarvisHash ([string]$window.Current.Name) }
  }
  $element = Get-JarvisElement $window (Get-JarvisProperty $Check 'selector' $null)
  if ($type -eq 'elementexists') { return @{ type = $type; passed = $null -ne $element } }
  if ($null -eq $element) { return @{ type = $type; passed = $false; reason = 'element-not-found' } }
  if ($element.Current.IsPassword) { return @{ type = $type; passed = $false; reason = 'password-control-blocked' } }
  if ($type -eq 'elementvalueequals') {
    $expected = [string](Get-JarvisProperty $Check 'expected' '')
    $actual = Get-JarvisElementValue $element
    return @{ type = $type; passed = [string]::Equals($actual, $expected, [System.StringComparison]::Ordinal); expectedHash = Get-JarvisHash $expected; actualHash = Get-JarvisHash $actual }
  }
  if ($type -eq 'elementnameequals') {
    $expected = [string](Get-JarvisProperty $Check 'expected' '')
    $actual = [string]$element.Current.Name
    return @{ type = $type; passed = [string]::Equals($actual, $expected, [System.StringComparison]::Ordinal); expectedHash = Get-JarvisHash $expected; actualHash = Get-JarvisHash $actual }
  }
  if ($type -eq 'elementnamecontains') {
    $expected = [string](Get-JarvisProperty $Check 'expected' '')
    $actual = [string]$element.Current.Name
    return @{ type = $type; passed = Test-JarvisText $actual $expected -Contains; expectedHash = Get-JarvisHash $expected; actualHash = Get-JarvisHash $actual }
  }
  if ($type -eq 'elementenabled') {
    $rawExpected = Get-JarvisProperty $Check 'expected' $true
    $expected = if ($rawExpected -is [bool]) { $rawExpected } else { [bool]::Parse(([string]$rawExpected).Trim()) }
    return @{ type = $type; passed = $element.Current.IsEnabled -eq $expected; actual = $element.Current.IsEnabled }
  }
  return @{ type = $type; passed = $false; reason = 'verification-type-unsupported' }
}

function Test-JarvisVerification($Check, $DefaultTarget, [int]$DefaultTimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $DefaultTimeoutMs))
  $last = $null
  do {
    $last = Test-JarvisVerificationOnce $Check $DefaultTarget ([Math]::Min(500, $DefaultTimeoutMs))
    if ($last.passed -eq $true) { return $last }
    if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $last
}

$result = $null
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JarvisDesktopNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out JarvisDesktopPoint point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(JarvisDesktopPoint point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static bool PointBelongsToProcess(int x, int y, int expectedProcessId) {
    JarvisDesktopPoint point = new JarvisDesktopPoint { X = x, Y = y };
    IntPtr pointWindow = WindowFromPoint(point);
    if (pointWindow == IntPtr.Zero) return false;
    uint actualProcessId;
    GetWindowThreadProcessId(pointWindow, out actualProcessId);
    return actualProcessId == (uint)expectedProcessId;
  }
  public static bool ActivateWindow(IntPtr targetWindow) {
    if (targetWindow == IntPtr.Zero) return false;
    uint ignoredProcessId;
    uint currentThread = GetCurrentThreadId();
    uint targetThread = GetWindowThreadProcessId(targetWindow, out ignoredProcessId);
    IntPtr foregroundWindow = GetForegroundWindow();
    uint foregroundThread = foregroundWindow == IntPtr.Zero
      ? 0
      : GetWindowThreadProcessId(foregroundWindow, out ignoredProcessId);
    bool attachedTarget = false;
    bool attachedForeground = false;
    try {
      if (targetThread != 0 && targetThread != currentThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
      if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != targetThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      ShowWindow(targetWindow, 9);
      BringWindowToTop(targetWindow);
      SetForegroundWindow(targetWindow);
      SetActiveWindow(targetWindow);
      SetFocus(targetWindow);
      return GetForegroundWindow() == targetWindow;
    } finally {
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
    }
  }
}
public struct JarvisDesktopPoint { public int X; public int Y; }
'@
  [JarvisDesktopNative]::SetProcessDPIAware() | Out-Null

  if ([string]::IsNullOrWhiteSpace($RequestBase64)) { throw 'desktop-request-required' }
  $requestJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RequestBase64))
  $request = $requestJson | ConvertFrom-Json
  $target = Get-JarvisProperty $request 'target' $null
  $timeoutMs = [int](Get-JarvisProperty $request 'timeoutMs' 5000)
  $operations = @((Get-JarvisProperty $request 'operations' @()))
  $checks = @((Get-JarvisProperty $request 'verification' @()))
  $desktopLease = [System.Threading.Mutex]::new($false, 'Local\JARVIS.DesktopControl.Execution.v1')
  $leaseStarted = [DateTime]::UtcNow
  try {
    $desktopLeaseOwned = $desktopLease.WaitOne([Math]::Min(15000, [Math]::Max(1000, $timeoutMs)))
  } catch [System.Threading.AbandonedMutexException] {
    $desktopLeaseOwned = $true
    $desktopLeaseAbandoned = $true
  }
  $desktopLeaseWaitMs = [int]([DateTime]::UtcNow - $leaseStarted).TotalMilliseconds
  if (!$desktopLeaseOwned) { throw 'desktop-control-busy' }

  foreach ($operation in $operations) {
    $currentOperationName = ([string](Get-JarvisProperty $operation 'op' '')).ToLowerInvariant()
    $operationResults += Invoke-JarvisOperation $operation $target $timeoutMs
    $currentOperationName = $null
  }
  foreach ($check in $checks) {
    $verificationResults += Test-JarvisVerification $check $target $timeoutMs
  }
  $verificationPassed = $checks.Count -gt 0 -and @($verificationResults | Where-Object { $_.passed -ne $true }).Count -eq 0
  $finalWindow = Get-JarvisWindow $target ([Math]::Min($timeoutMs, 1200))
  $result = @{
    adapterVersion = 'b-windows-desktop-control-v1'
    status = if ($verificationPassed) { 'success' } else { 'failed' }
    interactiveSession = [Environment]::UserInteractive
    operationCount = $operations.Count
    operations = $operationResults
    verification = @{ passed = $verificationPassed; checks = $verificationResults }
    observedWindow = Get-JarvisWindowRecord $finalWindow
    desktopLease = @{ serialized = $true; waitMs = $desktopLeaseWaitMs; abandonedRecovered = $desktopLeaseAbandoned }
  }
} catch {
  $result = @{
    adapterVersion = 'b-windows-desktop-control-v1'
    status = 'failed'
    interactiveSession = [Environment]::UserInteractive
    error = ([string]$_.Exception.Message).Substring(0, [Math]::Min(240, ([string]$_.Exception.Message).Length))
    failedOperation = $currentOperationName
    operationCount = @($operationResults).Count
    operations = @($operationResults)
    verification = @{ passed = $false; checks = @($verificationResults) }
    observedWindow = @{ found = $false }
    diagnostics = $script:JarvisDesktopDiagnostic
    desktopLease = @{ serialized = $true; waitMs = $desktopLeaseWaitMs; abandonedRecovered = $desktopLeaseAbandoned }
  }
} finally {
  if ($desktopLeaseOwned -and $null -ne $desktopLease) {
    try { $desktopLease.ReleaseMutex() } catch { }
  }
  if ($null -ne $desktopLease) { $desktopLease.Dispose() }
}

$result | ConvertTo-Json -Compress -Depth 10
