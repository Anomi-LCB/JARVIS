param(
  [string]$RequestBase64 = $env:JARVIS_LOCAL_TEMPLATE_REQUEST_BASE64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'startup'

function Get-JarvisByteHash([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

try {
  $stage = 'runtime-load'
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -ReferencedAssemblies 'System.Drawing.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public sealed class JarvisTemplateCandidate
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public double Confidence { get; set; }
    public double Scale { get; set; }
}

public static class JarvisTemplateDpiNative
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
}

public static class JarvisLocalTemplateMatcher
{
    private sealed class TemplateSamples
    {
        public int[] X;
        public int[] Y;
        public double[] Value;
        public double Mean;
        public double RootVariance;
    }

    public static JarvisTemplateCandidate[] Match(Bitmap capture, Bitmap template, double minimumConfidence, double scaleTolerance)
    {
        if (capture == null || template == null) throw new ArgumentNullException();
        if (capture.Width < 8 || capture.Height < 8) throw new InvalidOperationException("template-capture-too-small");
        if (template.Width < 8 || template.Height < 8) throw new InvalidOperationException("template-image-too-small");

        double workingScale = Math.Min(1.0, 800.0 / Math.Max(capture.Width, capture.Height));
        int captureWidth = Math.Max(8, (int)Math.Round(capture.Width * workingScale));
        int captureHeight = Math.Max(8, (int)Math.Round(capture.Height * workingScale));
        List<JarvisTemplateCandidate> pool = new List<JarvisTemplateCandidate>();
        double candidateFloor = Math.Max(0.55, minimumConfidence - 0.15);

        using (Bitmap workingCapture = Resize(capture, captureWidth, captureHeight))
        {
            byte[] captureGray = ToGray(workingCapture);
            double[] scales = BuildScales(scaleTolerance);
            foreach (double requestedScale in scales)
            {
                int templateWidth = Math.Max(4, (int)Math.Round(template.Width * requestedScale * workingScale));
                int templateHeight = Math.Max(4, (int)Math.Round(template.Height * requestedScale * workingScale));
                if (templateWidth >= captureWidth || templateHeight >= captureHeight) continue;

                using (Bitmap workingTemplate = Resize(template, templateWidth, templateHeight))
                {
                    byte[] templateGray = ToGray(workingTemplate);
                    TemplateSamples samples = CreateSamples(templateGray, templateWidth, templateHeight);
                    if (samples.RootVariance < 6.0) throw new InvalidOperationException("template-image-low-information");

                    int scanStep = Math.Max(captureWidth, captureHeight) > 640 ? 2 : 1;
                    for (int y = 0; y <= captureHeight - templateHeight; y += scanStep)
                    {
                        for (int x = 0; x <= captureWidth - templateWidth; x += scanStep)
                        {
                            double score = ScoreAt(captureGray, captureWidth, x, y, samples);
                            if (score < candidateFloor) continue;
                            pool.Add(new JarvisTemplateCandidate {
                                X = (int)Math.Round(x / workingScale),
                                Y = (int)Math.Round(y / workingScale),
                                Width = Math.Max(1, (int)Math.Round(templateWidth / workingScale)),
                                Height = Math.Max(1, (int)Math.Round(templateHeight / workingScale)),
                                Confidence = Math.Round(score, 6),
                                Scale = Math.Round(requestedScale, 4)
                            });
                            if (pool.Count >= 512) TrimPool(pool, 256);
                        }
                    }
                }
            }
        }

        pool.Sort(delegate(JarvisTemplateCandidate left, JarvisTemplateCandidate right) {
            return right.Confidence.CompareTo(left.Confidence);
        });
        List<JarvisTemplateCandidate> accepted = new List<JarvisTemplateCandidate>();
        foreach (JarvisTemplateCandidate candidate in pool)
        {
            if (candidate.Confidence < candidateFloor) break;
            bool overlaps = false;
            foreach (JarvisTemplateCandidate prior in accepted)
            {
                if (IntersectionOverUnion(candidate, prior) >= 0.30) {
                    overlaps = true;
                    break;
                }
            }
            if (overlaps) continue;
            accepted.Add(candidate);
            if (accepted.Count >= 16) break;
        }
        return accepted.ToArray();
    }

    private static double[] BuildScales(double tolerance)
    {
        tolerance = Math.Max(0.0, Math.Min(0.35, tolerance));
        if (tolerance < 0.001) return new double[] { 1.0 };
        return new double[] { 1.0 - tolerance, 1.0 - tolerance / 2.0, 1.0, 1.0 + tolerance / 2.0, 1.0 + tolerance };
    }

    private static Bitmap Resize(Bitmap source, int width, int height)
    {
        Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(result))
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.DrawImage(source, new Rectangle(0, 0, width, height));
        }
        return result;
    }

    private static byte[] ToGray(Bitmap source)
    {
        Rectangle rect = new Rectangle(0, 0, source.Width, source.Height);
        BitmapData data = source.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int rowBytes = Math.Abs(data.Stride);
            byte[] raw = new byte[rowBytes * source.Height];
            byte[] gray = new byte[source.Width * source.Height];
            Marshal.Copy(data.Scan0, raw, 0, raw.Length);
            for (int y = 0; y < source.Height; y++)
            {
                int row = data.Stride >= 0 ? y * data.Stride : (source.Height - 1 - y) * rowBytes;
                int output = y * source.Width;
                for (int x = 0; x < source.Width; x++)
                {
                    int pixel = row + x * 4;
                    gray[output + x] = (byte)((raw[pixel + 2] * 77 + raw[pixel + 1] * 150 + raw[pixel] * 29) >> 8);
                }
            }
            return gray;
        }
        finally
        {
            source.UnlockBits(data);
        }
    }

    private static TemplateSamples CreateSamples(byte[] template, int width, int height)
    {
        int columns = Math.Min(11, Math.Max(4, width / 3));
        int rows = Math.Min(11, Math.Max(4, height / 3));
        List<int> xs = new List<int>();
        List<int> ys = new List<int>();
        List<double> values = new List<double>();
        for (int row = 0; row < rows; row++)
        {
            int y = Math.Min(height - 1, Math.Max(0, (int)Math.Round((row + 0.5) * height / rows)));
            for (int column = 0; column < columns; column++)
            {
                int x = Math.Min(width - 1, Math.Max(0, (int)Math.Round((column + 0.5) * width / columns)));
                xs.Add(x);
                ys.Add(y);
                values.Add(template[y * width + x]);
            }
        }
        double mean = 0.0;
        foreach (double value in values) mean += value;
        mean /= values.Count;
        double variance = 0.0;
        foreach (double value in values) {
            double delta = value - mean;
            variance += delta * delta;
        }
        return new TemplateSamples {
            X = xs.ToArray(),
            Y = ys.ToArray(),
            Value = values.ToArray(),
            Mean = mean,
            RootVariance = Math.Sqrt(variance)
        };
    }

    private static double ScoreAt(byte[] capture, int captureWidth, int originX, int originY, TemplateSamples samples)
    {
        int count = samples.Value.Length;
        double candidateMean = 0.0;
        for (int i = 0; i < count; i++) {
            candidateMean += capture[(originY + samples.Y[i]) * captureWidth + originX + samples.X[i]];
        }
        candidateMean /= count;

        double covariance = 0.0;
        double candidateVariance = 0.0;
        for (int i = 0; i < count; i++)
        {
            double candidateDelta = capture[(originY + samples.Y[i]) * captureWidth + originX + samples.X[i]] - candidateMean;
            double templateDelta = samples.Value[i] - samples.Mean;
            covariance += candidateDelta * templateDelta;
            candidateVariance += candidateDelta * candidateDelta;
        }
        if (candidateVariance < 1.0 || samples.RootVariance < 1.0) return 0.0;
        double correlation = covariance / (Math.Sqrt(candidateVariance) * samples.RootVariance);
        correlation = Math.Max(0.0, Math.Min(1.0, correlation));
        double meanSimilarity = 1.0 - Math.Min(1.0, Math.Abs(candidateMean - samples.Mean) / 255.0);
        double candidateContrast = Math.Sqrt(candidateVariance / count);
        double templateContrast = samples.RootVariance / Math.Sqrt(count);
        double contrastSimilarity = Math.Min(candidateContrast, templateContrast) / Math.Max(candidateContrast, templateContrast);
        return correlation * 0.82 + meanSimilarity * 0.10 + contrastSimilarity * 0.08;
    }

    private static void TrimPool(List<JarvisTemplateCandidate> pool, int keep)
    {
        pool.Sort(delegate(JarvisTemplateCandidate left, JarvisTemplateCandidate right) {
            return right.Confidence.CompareTo(left.Confidence);
        });
        if (pool.Count > keep) pool.RemoveRange(keep, pool.Count - keep);
    }

    private static double IntersectionOverUnion(JarvisTemplateCandidate a, JarvisTemplateCandidate b)
    {
        int left = Math.Max(a.X, b.X);
        int top = Math.Max(a.Y, b.Y);
        int right = Math.Min(a.X + a.Width, b.X + b.Width);
        int bottom = Math.Min(a.Y + a.Height, b.Y + b.Height);
        if (right <= left || bottom <= top) return 0.0;
        double intersection = (right - left) * (bottom - top);
        double union = a.Width * a.Height + b.Width * b.Height - intersection;
        return union <= 0.0 ? 0.0 : intersection / union;
    }
}
'@
  [JarvisTemplateDpiNative]::SetProcessDPIAware() | Out-Null
  $desktopGraphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  try {
    $screenScaleX = [Math]::Max(1.0, [double]$desktopGraphics.DpiX / 96.0)
    $screenScaleY = [Math]::Max(1.0, [double]$desktopGraphics.DpiY / 96.0)
  } finally {
    $desktopGraphics.Dispose()
  }

  $stage = 'request-parse'
  if ([string]::IsNullOrWhiteSpace($RequestBase64)) { throw 'template-request-required' }
  $requestJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RequestBase64))
  $request = $requestJson | ConvertFrom-Json
  $bounds = $request.bounds
  $windowHandle = [IntPtr]([int64]$request.windowHandle)
  $templatePath = [string]$request.templatePath
  $expectedTemplateHash = ([string]$request.templateHash).ToLowerInvariant()
  $minimumConfidence = [Math]::Min(0.995, [Math]::Max(0.8, [double]$request.minConfidence))
  $scaleTolerance = [Math]::Min(0.35, [Math]::Max(0.0, [double]$request.scaleTolerance))

  if ([string]::IsNullOrWhiteSpace($templatePath) -or !(Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw 'template-file-missing'
  }
  if ([string]::IsNullOrWhiteSpace($expectedTemplateHash)) { throw 'template-hash-required' }

  $stage = 'template-load'
  $templateBytes = [System.IO.File]::ReadAllBytes($templatePath)
  if ($templateBytes.Length -lt 32 -or $templateBytes.Length -gt 4194304) { throw 'template-file-size-invalid' }
  $templateHash = Get-JarvisByteHash $templateBytes
  if ($templateHash -ne $expectedTemplateHash) { throw 'template-hash-mismatch' }
  $templateStream = New-Object System.IO.MemoryStream(,$templateBytes)
  $templateSource = [System.Drawing.Image]::FromStream($templateStream, $true, $true)
  $template = New-Object System.Drawing.Bitmap($templateSource)
  if ($template.Width -lt 8 -or $template.Height -lt 8 -or $template.Width -gt 1024 -or $template.Height -gt 1024) {
    throw 'template-dimensions-invalid'
  }
  if ([int64]$template.Width * [int64]$template.Height -gt 1048576) { throw 'template-area-too-large' }

  $requestedX = [int]$bounds.x
  $requestedY = [int]$bounds.y
  $requestedWidth = [int]$bounds.width
  $requestedHeight = [int]$bounds.height
  if ($requestedWidth -lt 8 -or $requestedHeight -lt 8 -or $requestedWidth -gt 8192 -or $requestedHeight -gt 8192) {
    throw 'template-capture-bounds-invalid'
  }
  if ([int64]$requestedWidth * [int64]$requestedHeight -gt 33554432) { throw 'template-capture-area-too-large' }

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
    if ($captureWidth -lt 8 -or $captureHeight -lt 8) { throw 'template-capture-outside-virtual-screen' }
  }

  $stage = 'screen-capture'
  $capture = New-Object System.Drawing.Bitmap($captureWidth, $captureHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($capture)
  try {
    if ($captureMode -eq 'window-print') {
      $hdc = $graphics.GetHdc()
      try {
        if (![JarvisTemplateDpiNative]::PrintWindow($windowHandle, $hdc, 0)) { throw 'template-window-capture-failed' }
      } finally {
        $graphics.ReleaseHdc($hdc)
      }
    } else {
      $graphics.CopyFromScreen($captureX, $captureY, 0, 0, $capture.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    }
  } finally {
    $graphics.Dispose()
  }

  $captureStream = New-Object System.IO.MemoryStream
  try {
    $capture.Save($captureStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $captureHash = Get-JarvisByteHash $captureStream.ToArray()
  } finally {
    $captureStream.Dispose()
  }

  $stage = 'matching'
  $candidates = @([JarvisLocalTemplateMatcher]::Match($capture, $template, $minimumConfidence, $scaleTolerance))
  $qualified = @($candidates | Where-Object { [double]$_.Confidence -ge $minimumConfidence })
  $matches = @($qualified | ForEach-Object {
    $logicalX = $captureX + [int]$_.X
    $logicalY = $captureY + [int]$_.Y
    $logicalWidth = [int]$_.Width
    $logicalHeight = [int]$_.Height
    $physicalX = $outputOriginX + [int][Math]::Round($logicalX * $screenScaleX)
    $physicalY = $outputOriginY + [int][Math]::Round($logicalY * $screenScaleY)
    $physicalRight = $outputOriginX + [int][Math]::Round(($logicalX + $logicalWidth) * $screenScaleX)
    $physicalBottom = $outputOriginY + [int][Math]::Round(($logicalY + $logicalHeight) * $screenScaleY)
    @{
      x = $physicalX
      y = $physicalY
      width = [Math]::Max(1, $physicalRight - $physicalX)
      height = [Math]::Max(1, $physicalBottom - $physicalY)
      centerX = $outputOriginX + [int][Math]::Round(($logicalX + ($logicalWidth / 2.0)) * $screenScaleX)
      centerY = $outputOriginY + [int][Math]::Round(($logicalY + ($logicalHeight / 2.0)) * $screenScaleY)
      confidence = [double]$_.Confidence
      scale = [double]$_.Scale
    }
  })
  $bestConfidence = if ($candidates.Count -gt 0) { [double]$candidates[0].Confidence } else { 0.0 }
  $secondConfidence = if ($candidates.Count -gt 1) { [double]$candidates[1].Confidence } else { 0.0 }

  $result = @{
    adapterVersion = 'b-windows-local-template-v1'
    status = 'success'
    engine = 'Jarvis.LocalTemplateMatcher'
    templateHash = $templateHash
    captureHash = $captureHash
    captureMode = $captureMode
    minConfidence = $minimumConfidence
    scaleTolerance = $scaleTolerance
    bestConfidence = $bestConfidence
    secondConfidence = $secondConfidence
    matchCount = $matches.Count
    candidateCount = $candidates.Count
    matches = $matches
    screenshotStored = $false
    rawPixelsStored = $false
    templateCopied = $false
  }
} catch {
  $result = @{
    adapterVersion = 'b-windows-local-template-v1'
    status = 'failed'
    error = 'windows-local-template-failed'
    stage = $stage
    errorType = $_.Exception.GetType().Name
    hresult = $_.Exception.HResult
    screenshotStored = $false
    rawPixelsStored = $false
    templateCopied = $false
  }
} finally {
  foreach ($resource in @($capture, $template, $templateSource, $templateStream)) {
    if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
  }
}

$result | ConvertTo-Json -Compress -Depth 8
