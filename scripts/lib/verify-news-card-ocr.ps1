$ErrorActionPreference = 'Stop'
$stage = 'startup'

function Wait-JarvisAsync($Operation, [Type]$ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if ($null -eq $method) { throw 'winrt-astask-unavailable' }
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Normalize-Ocr([string]$Text) {
  $normalized = ([string]$Text).Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()
  return [regex]::Replace($normalized, '[^\p{L}\p{Nd}]', '')
}

function Get-OrderedCharacterCoverage([string]$Expected, [string]$Observed) {
  if ([string]::IsNullOrEmpty($Expected) -or [string]::IsNullOrEmpty($Observed)) { return 0.0 }
  $previous = New-Object 'int[]' ($Expected.Length + 1)
  foreach ($character in $Observed.ToCharArray()) {
    $current = New-Object 'int[]' ($Expected.Length + 1)
    for ($index = 1; $index -le $Expected.Length; $index++) {
      if ($Expected[$index - 1] -eq $character) { $current[$index] = $previous[$index - 1] + 1 }
      else { $current[$index] = [Math]::Max($previous[$index], $current[$index - 1]) }
    }
    $previous = $current
  }
  return [Math]::Round($previous[$Expected.Length] / [double]$Expected.Length, 4)
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

try {
  $stage = 'request'
  $encoded = [string]$env:JARVIS_NEWS_CARD_OCR_REQUEST_B64
  if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'request-required' }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
  $allowedRoot = [IO.Path]::GetFullPath([string]$request.allowedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $records = @($request.cards)
  if ($records.Count -lt 1 -or $records.Count -gt 10) { throw 'card-count-out-of-range' }

  $stage = 'runtime-load'
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $language = [Windows.Globalization.Language]::new('ko-KR')
  if (![Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) {
    $result = @{ status = 'blocked'; reason = 'korean-ocr-language-unavailable'; engine = 'Windows.Media.Ocr'; rawOcrTextStored = $false; cards = @() }
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) { throw 'korean-ocr-engine-unavailable' }
    $cardResults = @()
    foreach ($card in $records) {
      $stage = 'image-validate'
      $path = [IO.Path]::GetFullPath([string]$card.path)
      if (!$path.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'image-outside-allowed-root' }
      $item = Get-Item -LiteralPath $path
      if ($item.PSIsContainer -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4MB -or $item.Extension -ne '.png') {
        throw 'image-file-rejected'
      }
      $hash = Get-Sha256 $path
      $stage = 'bitmap-decode'
      $storageFile = Wait-JarvisAsync ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
      $stream = Wait-JarvisAsync ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      try {
        $decoder = Wait-JarvisAsync ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $width = [int]$decoder.PixelWidth
        $height = [int]$decoder.PixelHeight
        if ($width -lt 1 -or $height -lt 1 -or $width -gt 4096 -or $height -gt 4096 -or [int64]$width * $height -gt 16000000) {
          throw 'image-dimensions-rejected'
        }
        $scale = if ($request.verificationScale -eq 2) { 2 } else { 1 }
        if ($scale -eq 2 -and [Math]::Max($width, $height) * 2 -le [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
          $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
          $transform.ScaledWidth = [uint32]($width * 2)
          $transform.ScaledHeight = [uint32]($height * 2)
          $bitmap = Wait-JarvisAsync ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        } else { $scale = 1; $bitmap = Wait-JarvisAsync ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) }
        try {
          $stage = 'recognition'
          $ocr = Wait-JarvisAsync ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        } finally { if ($null -ne $bitmap) { $bitmap.Dispose() } }
      } finally { if ($null -ne $stream) { $stream.Dispose() } }
      $recognized = (@($ocr.Lines | ForEach-Object { [string]$_.Text }) -join ' ')
      $normalized = Normalize-Ocr $recognized
      $title = Normalize-Ocr ([string]$card.title)
      $source = Normalize-Ocr ([string]$card.source)
      $titleMatchRatio = Get-OrderedCharacterCoverage $title $normalized
      $titleMatched = $title.Length -ge 4 -and $titleMatchRatio -ge 0.90
      $sourceMatched = $source.Length -ge 2 -and $normalized.Contains($source)
      $cardResults += @{ id = [string]$card.id; status = if ($titleMatched -and $sourceMatched) { 'verified' } else { 'mismatch' }
        sha256 = $hash; byteLength = [int64]$item.Length; width = $width; height = $height
        languageTag = [string]$engine.RecognizerLanguage.LanguageTag; titleMatched = $titleMatched; titleMatchRatio = $titleMatchRatio
        sourceMatched = $sourceMatched; recognizedCharacterCount = $recognized.Length; rawOcrTextStored = $false }
      $cardResults[-1].verificationScale = $scale
    }
    $result = @{ status = if (@($cardResults | Where-Object status -ne 'verified').Count -eq 0) { 'passed' } else { 'failed' }
      engine = 'Windows.Media.Ocr'; cards = $cardResults; rawOcrTextStored = $false }
  }
} catch {
  $result = @{ status = 'failed'; reason = 'news-card-ocr-failed'; stage = $stage
    errorType = $_.Exception.GetType().Name; rawOcrTextStored = $false; cards = @() }
}
$result | ConvertTo-Json -Compress -Depth 8
