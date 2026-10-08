param([Parameter(Mandatory=$true)][string]$RequestPath,[int]$NativeParentProcessId)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'word-interactive-session-required'}
$mutex=New-Object Threading.Mutex($false,'Local\JarvisWordAuthoringV1')
$locked=$false;$app=$null;$doc=$null;$owned=$false;$guard=$null
function Release-Com($value){if($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)}}
function Normalize-Newlines([string]$text){return $text.Replace("`r`n","`n").Replace("`r","`n")}
function Cell-Text($cell){$value=[string]$cell.Range.Text;if($value.EndsWith("`r"+[char]7)){$value=$value.Substring(0,$value.Length-2)};return Normalize-Newlines $value}
function Progress-Stage([string]$stage){@{stage=$stage;observedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $request.staging 'native-stage.json') -Encoding UTF8}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class JarvisWordWindow{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);}'
Add-Type -Path (Join-Path $PSScriptRoot 'native-process-guard.cs')
try{
 $locked=$mutex.WaitOne(0);if(-not $locked){throw 'word-authoring-busy'}
 $before=@(Get-Process WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
 $hostInfo=Get-CimInstance Win32_Process -Filter ("ProcessId="+[Diagnostics.Process]::GetCurrentProcess().Id)
 if($NativeParentProcessId -le 0 -or $hostInfo.ParentProcessId -ne $NativeParentProcessId){throw 'word-parent-identity-invalid'}
 $app=New-Object -ComObject Word.Application
 # Word exposes HWND on Window, not Application. Only this newly created
 # empty document may be closed if activation returns an existing instance.
 $doc=$app.Documents.Add()
 [uint32]$ownedPid=0;[JarvisWordWindow]::GetWindowThreadProcessId([IntPtr]$doc.Windows.Item(1).Hwnd,[ref]$ownedPid) | Out-Null
 if($ownedPid -le 0 -or $before -contains [int]$ownedPid){throw 'word-instance-not-isolated'}
 $owned=$true;$guard=[JarvisWordProcessGuard]::new([int]$ownedPid,$NativeParentProcessId)
 @{pid=[int]$ownedPid;startTicks=$guard.OwnedStartTicks.ToString();parentPid=$NativeParentProcessId;hostPid=[Diagnostics.Process]::GetCurrentProcess().Id;jobAssigned=$guard.JobAssigned;parentWatchEnabled=$guard.ParentWatchEnabled} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $request.staging 'owned-process.json') -Encoding UTF8
 $app.Visible=$false;$app.DisplayAlerts=0;$app.AutomationSecurity=3
 Progress-Stage 'owned-authoring'
 $data=$request.document;$sel=$app.Selection
 function Set-Style([int]$id){$sel.Style=$doc.Styles.Item($id)}
 if($data.title){Set-Style(-63);$sel.TypeText([string]$data.title);$sel.TypeParagraph()}
 foreach($block in $data.blocks){
  $sel.EndKey(6) | Out-Null
  switch([string]$block.type){
   'heading' {Set-Style(-1-[int]$block.level);$sel.TypeText([string]$block.text);$sel.TypeParagraph()}
   'paragraph' {Set-Style(-1);$sel.TypeText([string]$block.text);$sel.TypeParagraph()}
   'bullets' {foreach($item in $block.items){Set-Style(-49);$sel.TypeText([string]$item);$sel.TypeParagraph()};Set-Style(-1)}
   'table' {
    $columns=@($block.columns);$rows=@($block.rows)
    $table=$doc.Tables.Add($sel.Range,$rows.Count+1,$columns.Count)
    $table.Borders.Enable=$true;$table.AutoFitBehavior(1)
    for($c=0;$c -lt $columns.Count;$c++){$table.Cell(1,$c+1).Range.Text=[string]$columns[$c]}
    for($r=0;$r -lt $rows.Count;$r++){$row=@($rows[$r]);if($row.Count -ne $columns.Count){throw 'word-table-input-width-mismatch'};for($c=0;$c -lt $columns.Count;$c++){$table.Cell($r+2,$c+1).Range.Text=[string]$row[$c]}}
    $sel.EndKey(6) | Out-Null;$sel.TypeParagraph()
   }
   default {throw 'word-block-type-unsupported'}
  }
 }
 [string]$path=Join-Path $request.staging 'document.docx';$doc.SaveAs2([ref]$path,[ref]16);Progress-Stage 'saved';$doc.Close(0);Release-Com $doc;$doc=$null
 Progress-Stage 'saved-closed'
 $doc=$app.Documents.Open($path,$false,$true,$false)
 Progress-Stage 'reopened'
 $wantedTables=@($data.blocks | Where-Object {$_.type -eq 'table'})
 if($doc.Tables.Count -ne $wantedTables.Count){throw 'word-table-structure-mismatch'}
 $actualTables=@();$index=0;$cellCount=0
 foreach($wanted in $wantedTables){
  $index++;$table=$doc.Tables.Item($index);$columns=@($wanted.columns);$rows=@($wanted.rows)
  if($table.Rows.Count -ne $rows.Count+1 -or $table.Columns.Count -ne $columns.Count){throw 'word-table-saved-dimensions-mismatch'}
  $actualRows=@()
  for($r=0;$r -lt $table.Rows.Count;$r++){
   $expected=if($r -eq 0){$columns}else{@($rows[$r-1])};$actualRow=@()
   for($c=0;$c -lt $columns.Count;$c++){$actual=Cell-Text ($table.Cell($r+1,$c+1));if($actual -cne (Normalize-Newlines ([string]$expected[$c]))){throw 'word-table-saved-cell-mismatch'};$actualRow+=,$actual;$cellCount++}
   $actualRows+=,@($actualRow)
  }
  $actualTables+=,@($actualRows)
 }
 function Normalize-Content([string]$value){return [regex]::Replace($value.Normalize([Text.NormalizationForm]::FormKC),'[\s\u0007]+','')}
 $rendered=Normalize-Content ([string]$doc.Content.Text)
 foreach($item in $request.expectedContentItems){if(-not $rendered.Contains((Normalize-Content ([string]$item)))){throw 'word-content-verification-failed'}}
 Progress-Stage 'saved-content-verified'
 [string]$pdf=Join-Path $request.staging 'document.pdf';$doc.ExportAsFixedFormat($pdf,17)
 Progress-Stage 'pdf-rendered'
 @{status='verified';sourceSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();pdfSha256=(Get-FileHash -LiteralPath $pdf -Algorithm SHA256).Hash.ToLowerInvariant();tables=$actualTables;cellCount=$cellCount;pageCount=$doc.ComputeStatistics(2);renderer='Microsoft Word COM';savedReopenedReadOnly=$true;actualRenderingExecuted=$true;ownedProcessId=[int]$ownedPid;jobAssigned=$guard.JobAssigned;parentWatchEnabled=$guard.ParentWatchEnabled} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $request.staging 'native-report.json') -Encoding UTF8
}finally{
 try{
  if($doc){try{$doc.Close(0)}catch{}finally{Release-Com $doc}}
  if($app){try{if($owned){$app.Quit(0)}}catch{}finally{Release-Com $app}}
 }finally{try{if($guard){$guard.Dispose()}}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}}
 [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
