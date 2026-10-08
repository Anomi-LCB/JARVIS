param([Parameter(Mandatory=$true)][string]$RequestPath,[int]$NativeParentProcessId)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'powerpoint-interactive-session-required'}
$mutex=New-Object Threading.Mutex($false,'Local\JarvisPowerPointAuthoringV1')
$locked=$false;$app=$null;$pres=$null;$owned=$false;$guard=$null
function Release-Com($value){if($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)}}
function Normalize-Newlines([string]$text){return $text.Replace("`r`n","`n").Replace("`r","`n")}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class JarvisPptWindow{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);}'
Add-Type -Path (Join-Path $PSScriptRoot 'native-process-guard.cs')
try{
 $locked=$mutex.WaitOne(0);if(-not $locked){throw 'powerpoint-authoring-busy'}
 $before=@(Get-Process POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
 if($before.Count -gt 0){throw 'powerpoint-user-session-in-use'}
 $hostInfo=Get-CimInstance Win32_Process -Filter ("ProcessId="+[Diagnostics.Process]::GetCurrentProcess().Id)
 if($NativeParentProcessId -le 0 -or $hostInfo.ParentProcessId -ne $NativeParentProcessId){throw 'powerpoint-parent-identity-invalid'}
 $app=New-Object -ComObject PowerPoint.Application
 [uint32]$ownedPid=0;[JarvisPptWindow]::GetWindowThreadProcessId([IntPtr]$app.HWND,[ref]$ownedPid) | Out-Null
 if($ownedPid -le 0 -or $before -contains [int]$ownedPid){throw 'powerpoint-instance-not-isolated'}
 $owned=$true;$guard=[JarvisPowerPointProcessGuard]::new([int]$ownedPid,$NativeParentProcessId)
 @{ownedProcessId=[int]$ownedPid;ownedStartTicks=[string]$guard.OwnedStartTicks;jobAssigned=$guard.JobAssigned} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $request.staging 'owned-process.json') -Encoding UTF8
 $app.DisplayAlerts=1;$app.AutomationSecurity=3
 $pres=$app.Presentations.Add(0);$pres.PageSetup.SlideWidth=960;$pres.PageSetup.SlideHeight=540
 $index=0
 foreach($item in $request.deck.slides){
  $index++;$slide=$pres.Slides.Add($index,12)
  $title=$slide.Shapes.AddTextbox(1,48,32,864,110);$title.Name='JARVIS_Title'
  $title.TextFrame.AutoSize=0;$title.Height=110
  $title.TextFrame.TextRange.Text=[string]$item.title;$title.TextFrame.TextRange.Font.Name='Malgun Gothic';$title.TextFrame.TextRange.Font.Size=32
  $body=$slide.Shapes.AddTextbox(1,48,166,864,326);$body.Name='JARVIS_Body'
  $body.TextFrame.AutoSize=0;$body.Height=326
  $body.TextFrame.TextRange.Text=(@($item.bullets) -join "`r")
  $body.TextFrame.TextRange.Font.Name='Malgun Gothic';$body.TextFrame.TextRange.Font.Size=22
  foreach($shape in @($title,$body)){$shape.TextFrame.AutoSize=0;$shape.TextFrame.WordWrap=-1;$shape.TextFrame.MarginLeft=0;$shape.TextFrame.MarginRight=0;$shape.TextFrame.MarginTop=0;$shape.TextFrame.MarginBottom=0}
  if($item.notes){$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text=[string]$item.notes}
 }
 $pptx=Join-Path $request.staging 'presentation.pptx';$pres.SaveAs($pptx,24);$pres.Close();Release-Com $pres;$pres=$null
 # Open the actual saved package read-only; input echoes are not evidence.
 $pres=$app.Presentations.Open($pptx,-1,0,0)
 if($pres.Slides.Count -ne @($request.deck.slides).Count){throw 'powerpoint-slide-count-mismatch'}
 $observations=@();$index=0
 foreach($item in $request.deck.slides){
  $index++;$slide=$pres.Slides.Item($index);$fields=@()
  foreach($role in @('title','body')){
   $name=if($role -eq 'title'){'JARVIS_Title'}else{'JARVIS_Body'}
   $shape=$slide.Shapes.Item($name);$range=$shape.TextFrame.TextRange
   $expected=if($role -eq 'title'){[string]$item.title}else{@($item.bullets) -join "`n"}
   if((Normalize-Newlines ([string]$range.Text)) -cne (Normalize-Newlines $expected)){throw "powerpoint-slide-$role-mismatch:$index"}
   $box=@([double]$shape.Left,[double]$shape.Top,[double]($shape.Left+$shape.Width),[double]($shape.Top+$shape.Height))
   $bounds=@([double]$range.BoundLeft,[double]$range.BoundTop,[double]($range.BoundLeft+$range.BoundWidth),[double]($range.BoundTop+$range.BoundHeight))
   if($expected -and ($box[0] -lt 0 -or $box[1] -lt 0 -or $box[2] -gt 960 -or $box[3] -gt 540 -or $bounds[0] -lt $box[0]-1 -or $bounds[1] -lt $box[1]-1 -or $bounds[2] -gt $box[2]+1 -or $bounds[3] -gt $box[3]+1)){throw "powerpoint-text-overflow:$index/$role"}
   $fields+=@{role=$role;text=[string]$range.Text;box=$box;bounds=$bounds;fontSize=[double]$range.Font.Size}
  }
  $actualNotes='';if($item.notes){$actualNotes=[string]$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text}
  if((Normalize-Newlines $actualNotes) -cne (Normalize-Newlines ([string]$item.notes))){throw "powerpoint-notes-mismatch:$index"}
  $png=Join-Path $request.staging ("slide-{0}.png" -f $index);$slide.Export($png,'PNG',1600,900)
  $observations+=@{index=$index;fields=$fields;notes=$actualNotes;png=[IO.Path]::GetFileName($png)}
 }
 # SaveAs PDF uses the documented ppSaveAsPDF=32 contract; the two-argument
 # ExportAsFixedFormat call fails optional-parameter COM binding on this host.
 if($request.pdf){$pres.SaveAs((Join-Path $request.staging 'presentation.pdf'),32)}
 @{status='verified';sourceSha256=(Get-FileHash -LiteralPath $pptx -Algorithm SHA256).Hash.ToLowerInvariant();slides=$observations;slideWidth=960;slideHeight=540;renderer='Microsoft PowerPoint COM';actualRenderingExecuted=$true;ownedProcessId=[int]$ownedPid;jobAssigned=$guard.JobAssigned} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $request.staging 'native-report.json') -Encoding UTF8
}finally{
 try{
  if($pres){try{$pres.Close()}catch{}finally{Release-Com $pres}}
  if($app){try{if($owned){$app.Quit()}}catch{}finally{Release-Com $app}}
 }finally{
  try{if($guard){$guard.Dispose()}}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
 }
 [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
