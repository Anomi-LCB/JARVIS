param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$PdfOnly
)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $InputPath).Path
if([IO.Path]::GetExtension($source) -ne '.xlsx' -or $ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'EXCEL_RENDER_INPUT_INVALID'}
if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $ExpectedSha256){throw 'EXCEL_RENDER_INPUT_CHANGED'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'EXCEL_RENDER_OUTPUT_EXISTS'}
New-Item -ItemType Directory -Path $output | Out-Null
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class JarvisExcelProcess{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);}'
$before=@(Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$app=$null;$book=$null;$owned=$false;$processId=0
function Release-ComReference($reference){if($null -ne $reference -and [Runtime.InteropServices.Marshal]::IsComObject($reference)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($reference)}}
try{
  $app=New-Object -ComObject Excel.Application
  [uint32]$taskExcelPid=0
  [JarvisExcelProcess]::GetWindowThreadProcessId([IntPtr]$app.Hwnd,[ref]$taskExcelPid) | Out-Null
  $processId=[int]$taskExcelPid
  if($processId -le 0 -or $before -contains $processId){throw 'EXCEL_RENDER_INSTANCE_NOT_ISOLATED'}
  $owned=$true
  Write-Output ("EXCEL_RENDER_OWNED_PROCESS="+$processId)
  $app.Visible=$false;$app.DisplayAlerts=$false;$app.EnableEvents=$false;$app.AskToUpdateLinks=$false;$app.AutomationSecurity=3
  $book=$app.Workbooks.Open($source,0,$true)
  if(-not $book.ReadOnly){throw 'EXCEL_RENDER_NOT_READ_ONLY'}
  $sheets=@();$charts=@();$images=@()
  for($i=1;$i -le $book.Worksheets.Count;$i++){
    $sheet=$book.Worksheets.Item($i)
    try{
      $sheets+=@{name=[string]$sheet.Name;visible=[int]$sheet.Visible;usedRows=[int]$sheet.UsedRange.Rows.Count;usedColumns=[int]$sheet.UsedRange.Columns.Count}
      if($sheet.Visible -eq -1){$sheet.ExportAsFixedFormat(0,(Join-Path $output ("sheet-{0}.pdf" -f $i)))}
      $objects=$sheet.ChartObjects()
      try{
        for($j=1;$j -le $objects.Count;$j++){
          $object=$objects.Item($j);$chart=$object.Chart
          try{
            $axes=@()
            if([int]$chart.ChartType -ne 5){$axisItems=$chart.Axes();try{for($axisNumber=1;$axisNumber -le $axisItems.Count;$axisNumber++){$axis=$axisItems.Item($axisNumber,1);try{$ticks=$axis.TickLabels;try{$font=$ticks.Font;try{$axes+=@{type=$axisNumber;tickLabelPosition=[int]$axis.TickLabelPosition;fontSize=$font.Size;fontColor=$font.Color;numberFormat=[string]$ticks.NumberFormat}}finally{Release-ComReference $font}}finally{Release-ComReference $ticks}}finally{Release-ComReference $axis}}}finally{Release-ComReference $axisItems}}
            $series=@();$items=$chart.SeriesCollection()
            try{for($k=1;$k -le $items.Count;$k++){$item=$items.Item($k);try{$series+=@{name=[string]$item.Name;formula=[string]$item.Formula;values=@($item.Values);categories=@($item.XValues)}}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)}}}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($items)}
            $png=$null
            if(-not $PdfOnly){
              $png=Join-Path $output ("sheet-{0}-chart-{1}.png" -f $i,$j)
              $chart.Refresh()
              if(-not $chart.Export($png,'PNG')){throw 'EXCEL_RENDER_CHART_EXPORT_FAILED'}
              if((Test-Path -LiteralPath $png) -and (Get-Item -LiteralPath $png).Length -eq 0){Start-Sleep -Milliseconds 200;$chart.Refresh();if(-not $chart.Export($png,'PNG')){throw 'EXCEL_RENDER_CHART_EXPORT_FAILED'}}
              if(-not (Test-Path -LiteralPath $png) -or (Get-Item -LiteralPath $png).Length -le 0){throw 'EXCEL_RENDER_CHART_IMAGE_MISSING'}
              $images+=@{path=[IO.Path]::GetFileName($png);sha256=(Get-FileHash -LiteralPath $png -Algorithm SHA256).Hash.ToLowerInvariant()}
            }
            $charts+=@{sheet=[string]$sheet.Name;title=[string]$chart.ChartTitle.Text;chartType=[int]$chart.ChartType;series=$series;axes=$axes;titleIncludedInLayout=[bool]$chart.ChartTitle.IncludeInLayout;image=$(if($png){[IO.Path]::GetFileName($png)}else{$null});pngExportRequested=(-not $PdfOnly)}
          }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($chart);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object)}
        }
      }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($objects)}
    }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet)}
  }
  $unchanged=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $ExpectedSha256
  if(-not $unchanged){throw 'EXCEL_RENDER_SOURCE_CHANGED'}
  $report=@{observedAt=[DateTime]::UtcNow.ToString('o');renderer='Microsoft Excel COM';mode=$(if($PdfOnly){'pdf-only'}else{'pdf-and-chart-png'});version=[string]$app.Version;build=[string]$app.Build;isolatedProcessId=$processId;readOnly=$true;sourceSha256=$ExpectedSha256.ToLowerInvariant();sourceUnchanged=$unchanged;sheets=$sheets;charts=$charts;images=$images;actualRenderingExecuted=$true;visualQualityReviewed=$false;noRepairPromptClaim=$false}
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $output 'render-report.json') -Encoding UTF8
  $report | ConvertTo-Json -Depth 12
}finally{
  if($book){try{$book.Close($false)}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)}}
  if($app){try{if($owned){$app.Quit()}}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}}
  [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
