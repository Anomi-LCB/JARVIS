param([Parameter(Mandatory=$true)][string]$JobPath,[int]$NativeParentProcessId)
$ErrorActionPreference='Stop'
$job=Get-Content -LiteralPath $JobPath -Raw -Encoding UTF8 | ConvertFrom-Json
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'HANCOM_RENDER_INTERACTIVE_SESSION_REQUIRED'}
if($NativeParentProcessId -le 0){throw 'HANCOM_RENDER_PARENT_REQUIRED'}
$hostProcess=Get-CimInstance Win32_Process -Filter ("ProcessId="+[Diagnostics.Process]::GetCurrentProcess().Id)
if($hostProcess.ParentProcessId -ne $NativeParentProcessId){throw 'HANCOM_RENDER_PARENT_INVALID'}
if((Get-FileHash -LiteralPath $job.inputPath -Algorithm SHA256).Hash -ne $job.sourceSha256){throw 'HANCOM_RENDER_SOURCE_CHANGED'}
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JarvisHancomWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
Add-Type -Path (Join-Path $PSScriptRoot 'native-process-guard.cs')
$before=@(Get-Process Hwp -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
$app=$null;$owned=$false;$guard=$null
try{
 $app=New-Object -ComObject HWPFrame.HwpObject
 [uint32]$ownedId=0
 [void][JarvisHancomWindow]::GetWindowThreadProcessId([IntPtr]$app.XHwpWindows.Active_XHwpWindow.WindowHandle,[ref]$ownedId)
 if($ownedId -eq 0 -or $before -contains [int]$ownedId){throw 'HANCOM_RENDER_INSTANCE_NOT_ISOLATED'}
 $process=Get-Process -Id $ownedId -ErrorAction Stop
 $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId"
 if($cim.Name -ne 'Hwp.exe' -or $cim.CommandLine -notmatch '(?i)-Automation' -or $cim.CommandLine -notmatch '(?i)-Embedding'){throw 'HANCOM_RENDER_INSTANCE_INVALID'}
 $owned=$true
 $guard=[JarvisHancomProcessGuard]::new($ownedId,$NativeParentProcessId)
 if($guard.OwnedStartTicks -ne $process.StartTime.ToUniversalTime().Ticks){throw 'HANCOM_RENDER_IDENTITY_CHANGED'}
 @{marker='jarvis-hwp-owned-v1';processId=$ownedId;startedAtUtc=$process.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.ownerPath -Encoding UTF8
 Write-Output ("HANCOM_RENDER_OWNED_PROCESS="+$ownedId+":"+$guard.OwnedStartTicks)
 try{$app.RegisterModule('FilePathCheckDLL','FilePathCheckerModule') | Out-Null}catch{}
 Write-Output 'HANCOM_RENDER_PHASE=open-start'
 if(-not $app.Open([string]$job.inputPath,'','')){throw 'HANCOM_RENDER_OPEN_FAILED'}
 Write-Output 'HANCOM_RENDER_PHASE=open-returned'
 $tables=0;$control=$app.HeadCtrl
 while($null -ne $control){if([string]$control.CtrlID -eq 'tbl'){$tables++};$control=$control.Next}
 if($tables -ne [int]$job.expectedTableCount){throw 'HANCOM_RENDER_TABLE_COUNT_MISMATCH'}
 Write-Output 'HANCOM_RENDER_PHASE=structure-save-start'
 if(-not $app.SaveAs([string]$job.structurePath,'HWPX','')){throw 'HANCOM_RENDER_STRUCTURE_EXPORT_FAILED'}
 Write-Output 'HANCOM_RENDER_PHASE=structure-save-returned'
 Write-Output 'HANCOM_RENDER_PHASE=pdf-save-start'
 if(-not $app.SaveAs([string]$job.pdfPath,'PDF','')){throw 'HANCOM_RENDER_EXPORT_FAILED'}
 Write-Output 'HANCOM_RENDER_PHASE=pdf-save-returned'
 $version=(Get-Item -LiteralPath $cim.ExecutablePath).VersionInfo
 @{schemaVersion='jarvis-hancom-render-v2';status='rendered';renderer='Hancom COM';build=$version.FileVersion;version=$version.ProductVersion;sourceSha256=$job.sourceSha256;tableCount=$tables;opened=$true;saved=$true;structureExported=$true;processId=$ownedId;startTicks=$guard.OwnedStartTicks.ToString();parentPid=$NativeParentProcessId;jobAssigned=$guard.JobAssigned;parentWatchEnabled=$guard.ParentWatchEnabled} | ConvertTo-Json -Compress | Set-Content -LiteralPath $job.receiptPath -Encoding UTF8
}finally{
 if($null -ne $app){if($owned){try{$app.Quit() | Out-Null}catch{}};try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}catch{}}
 if($null -ne $guard){$guard.Dispose()}
}
