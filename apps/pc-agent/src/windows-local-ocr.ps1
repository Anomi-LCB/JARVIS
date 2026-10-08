param(
  [string]$RequestBase64 = $env:JARVIS_LOCAL_OCR_REQUEST_BASE64
)

$ErrorActionPreference = 'Stop'
$capturePath = $null
$scaledPath = $null
$stage = 'startup'

function Get-JarvisHash([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-JarvisFileHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Normalize-JarvisOcrText([string]$Value) {
  return ([regex]::Replace(([string]$Value).Trim().ToLowerInvariant(), '\s+', ' '))
}

function Wait-JarvisAsync($AsyncOperation, [Type]$ResultType) {
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
      $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  if ($null -eq $asTask) { throw 'winrt-astask-unavailable' }
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($AsyncOperation))
  $task.Wait()
  return $task.Result
}

function New-JarvisWordRect(
  $Words,
  [int]$Start,
  [int]$Length,
  [double]$Scale,
  [int]$CaptureX,
  [int]$CaptureY,
  [int]$OutputOriginX,
  [int]$OutputOriginY,
  [double]$ScreenScaleX,
  [double]$ScreenScaleY
) {
  $left = [double]::PositiveInfinity
  $top = [double]::PositiveInfinity
  $right = [double]::NegativeInfinity
  $bottom = [double]::NegativeInfinity
  for ($i = $Start; $i -lt ($Start + $Length); $i++) {
    $rect = $Words[$i].BoundingRect
    $left = [Math]::Min($left, $rect.X)
    $top = [Math]::Min($top, $rect.Y)
    $right = [Math]::Max($right, $rect.X + $rect.Width)
    $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
  }
  $logicalX = $CaptureX + [int][Math]::Round($left / $Scale)
  $logicalY = $CaptureY + [int][Math]::Round($top / $Scale)
  $logicalWidth = [Math]::Max(1, [int][Math]::Round(($right - $left) / $Scale))
  $logicalHeight = [Math]::Max(1, [int][Math]::Round(($bottom - $top) / $Scale))
  $x = $OutputOriginX + [int][Math]::Round($logicalX * $ScreenScaleX)
  $y = $OutputOriginY + [int][Math]::Round($logicalY * $ScreenScaleY)
  $physicalRight = $OutputOriginX + [int][Math]::Round(($logicalX + $logicalWidth) * $ScreenScaleX)
  $physicalBottom = $OutputOriginY + [int][Math]::Round(($logicalY + $logicalHeight) * $ScreenScaleY)
  $width = [Math]::Max(1, $physicalRight - $x)
  $height = [Math]::Max(1, $physicalBottom - $y)
  return @{
    x = $x
    y = $y
    width = $width
    height = $height
    centerX = $x + [int][Math]::Floor($width / 2)
    centerY = $y + [int][Math]::Floor($height / 2)
  }
}

try {
  $stage = 'runtime-load'
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JarvisOcrDpiNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
}
'@
  [JarvisOcrDpiNative]::SetProcessDPIAware() | Out-Null
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $desktopGraphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  try {
    $screenScaleX = [Math]::Max(1.0, [double]$desktopGraphics.DpiX / 96.0)
    $screenScaleY = [Math]::Max(1.0, [double]$desktopGraphics.DpiY / 96.0)
  } finally {
    $desktopGraphics.Dispose()
  }

  $stage = 'request-parse'
  if ([string]::IsNullOrWhiteSpace($RequestBase64)) { throw 'ocr-request-required' }
  $requestJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RequestBase64))
  $request = $requestJson | ConvertFrom-Json
  $bounds = $request.bounds
  $windowHandle = [IntPtr]([int64]$request.windowHandle)
  $query = ([string]$request.query).Trim()
  $matchMode = ([string]$request.matchMode).ToLowerInvariant()
  if ($matchMode -notin @('exact', 'contains')) { $matchMode = 'exact' }
  if ([string]::IsNullOrWhiteSpace($query)) { throw 'ocr-query-required' }

  $requestedX = [int]$bounds.x
  $requestedY = [int]$bounds.y
  $requestedWidth = [int]$bounds.width
  $requestedHeight = [int]$bounds.height
  if ($requestedWidth -lt 8 -or $requestedHeight -lt 8 -or $requestedWidth -gt 8192 -or $requestedHeight -gt 8192) {
    throw 'ocr-capture-bounds-invalid'
  }
  if ([int64]$requestedWidth * [int64]$requestedHeight -gt 33554432) { throw 'ocr-capture-area-too-large' }

  $captureMode = 'screen-copy'
  $outputOriginX = 0
  $outputOriginY = 0
  if ($windowHandle -ne [IntPtr]::Zero) {
    $captureMode = 'window-print'
    $captureX = 0
    $captureY = 0
    $captureWidth = [Math]::Max(8, [int][Math]::Round($requestedWidth / $screenScaleX))
    $captureHeight = [Math]::Max(8, [int][Math]::Round($requestedHeight / $screenScaleY))
    $outputOriginX = $requestedX
    $outputOriginY = $requestedY
  } else {
    # UI Automation is physical-pixel based, while .NET CopyFromScreen uses
    # system-DPI logical coordinates on Windows PowerShell 5.1.
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $logicalRequestedX = [int][Math]::Round($requestedX / $screenScaleX)
    $logicalRequestedY = [int][Math]::Round($requestedY / $screenScaleY)
    $logicalRequestedRight = [int][Math]::Round(($requestedX + $requestedWidth) / $screenScaleX)
    $logicalRequestedBottom = [int][Math]::Round(($requestedY + $requestedHeight) / $screenScaleY)
    $logicalVirtualLeft = [int][Math]::Round($virtual.Left / $screenScaleX)
    $logicalVirtualTop = [int][Math]::Round($virtual.Top / $screenScaleY)
    $logicalVirtualRight = [int][Math]::Round($virtual.Right / $screenScaleX)
    $logicalVirtualBottom = [int][Math]::Round($virtual.Bottom / $screenScaleY)
    $captureX = [Math]::Max($logicalRequestedX, $logicalVirtualLeft)
    $captureY = [Math]::Max($logicalRequestedY, $logicalVirtualTop)
    $captureRight = [Math]::Min($logicalRequestedRight, $logicalVirtualRight)
    $captureBottom = [Math]::Min($logicalRequestedBottom, $logicalVirtualBottom)
    $captureWidth = $captureRight - $captureX
    $captureHeight = $captureBottom - $captureY
    if ($captureWidth -lt 8 -or $captureHeight -lt 8) { throw 'ocr-capture-outside-virtual-screen' }
  }

  $stage = 'screen-capture'
  $capturePath = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-ocr-{0}.png" -f [Guid]::NewGuid().ToString('N'))
  $stage = 'screen-capture-bitmap'
  $bitmap = [System.Drawing.Bitmap]::new($captureWidth, $captureHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stage = 'screen-capture-graphics'
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    if ($captureMode -eq 'window-print') {
      $stage = 'window-capture-copy'
      $hdc = $graphics.GetHdc()
      try {
        if (![JarvisOcrDpiNative]::PrintWindow($windowHandle, $hdc, 0)) { throw 'ocr-window-capture-failed' }
      } finally {
        $graphics.ReleaseHdc($hdc)
      }
    } else {
      $stage = 'screen-capture-copy'
      $graphics.CopyFromScreen($captureX, $captureY, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    }
    $stage = 'screen-capture-save'
    $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  $stage = 'screen-capture-hash'
  $captureHash = Get-JarvisFileHash $capturePath

  $stage = 'ocr-engine'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'windows-ocr-language-unavailable' }
  $maxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $scale = [Math]::Min(1.0, $maxDimension / [double][Math]::Max($captureWidth, $captureHeight))
  $ocrPath = $capturePath
  if ($scale -lt 0.999) {
    $scaledPath = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-ocr-scaled-{0}.png" -f [Guid]::NewGuid().ToString('N'))
    $source = [System.Drawing.Image]::FromFile($capturePath)
    $scaledWidth = [Math]::Max(8, [int][Math]::Floor($captureWidth * $scale))
    $scaledHeight = [Math]::Max(8, [int][Math]::Floor($captureHeight * $scale))
    $scaled = [System.Drawing.Bitmap]::new($scaledWidth, $scaledHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaledGraphics.DrawImage($source, 0, 0, $scaledWidth, $scaledHeight)
      $scaled.Save($scaledPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $scaledGraphics.Dispose()
      $scaled.Dispose()
      $source.Dispose()
    }
    $ocrPath = $scaledPath
  }

  $stage = 'bitmap-decode'
  $storageFile = Wait-JarvisAsync ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPath)) ([Windows.Storage.StorageFile])
  $stream = Wait-JarvisAsync ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Wait-JarvisAsync ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Wait-JarvisAsync ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $stage = 'recognition'
  try {
    $ocrResult = Wait-JarvisAsync ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }

  $stage = 'matching'
  $normalizedQuery = Normalize-JarvisOcrText $query
  $queryTokens = @($normalizedQuery -split ' ' | Where-Object { $_ })
  $matches = @()
  $wordCount = 0
  foreach ($line in $ocrResult.Lines) {
    $words = @($line.Words)
    $wordCount += $words.Count
    if ($words.Count -eq 0) { continue }
    $candidateLengths = if ($matchMode -eq 'exact') {
      @($queryTokens.Count)
    } else {
      $minimum = [Math]::Max(1, $queryTokens.Count - 1)
      $maximum = [Math]::Min($words.Count, $queryTokens.Count + 2)
      @($minimum..$maximum)
    }
    foreach ($length in $candidateLengths) {
      if ($length -lt 1 -or $length -gt $words.Count) { continue }
      for ($start = 0; $start -le ($words.Count - $length); $start++) {
        $candidate = Normalize-JarvisOcrText ((@($words[$start..($start + $length - 1)] | ForEach-Object { [string]$_.Text })) -join ' ')
        $matched = if ($matchMode -eq 'contains') { $candidate.Contains($normalizedQuery) } else { $candidate -eq $normalizedQuery }
        if (!$matched) { continue }
        $rect = New-JarvisWordRect $words $start $length $scale $captureX $captureY $outputOriginX $outputOriginY $screenScaleX $screenScaleY
        $key = "$($rect.x):$($rect.y):$($rect.width):$($rect.height)"
        if (@($matches | Where-Object { $_.key -eq $key }).Count -eq 0) {
          $matches += @{ key = $key; x = $rect.x; y = $rect.y; width = $rect.width; height = $rect.height; centerX = $rect.centerX; centerY = $rect.centerY }
        }
      }
    }
  }

  $result = @{
    adapterVersion = 'b-windows-local-ocr-v1'
    status = 'success'
    engine = 'Windows.Media.Ocr'
    languageTag = [string]$engine.RecognizerLanguage.LanguageTag
    queryHash = Get-JarvisHash $normalizedQuery
    matchMode = $matchMode
    matchCount = $matches.Count
    matches = @($matches | ForEach-Object { @{ x = $_.x; y = $_.y; width = $_.width; height = $_.height; centerX = $_.centerX; centerY = $_.centerY } })
    wordCount = $wordCount
    captureHash = $captureHash
    captureMode = $captureMode
    captureWidth = $captureWidth
    captureHeight = $captureHeight
    screenshotStored = $false
    rawOcrTextStored = $false
  }
} catch {
  $result = @{
    adapterVersion = 'b-windows-local-ocr-v1'
    status = 'failed'
    error = 'windows-local-ocr-failed'
    stage = $stage
    errorType = $_.Exception.GetType().Name
    hresult = $_.Exception.HResult
    screenshotStored = $false
    rawOcrTextStored = $false
  }
} finally {
  foreach ($path in @($capturePath, $scaledPath)) {
    if ($path) { try { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } catch {} }
  }
}

$result | ConvertTo-Json -Compress -Depth 8
