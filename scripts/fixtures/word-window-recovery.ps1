param([string]$Root,[int]$ParentPid,[string]$GuardPath)
$ErrorActionPreference='Stop';$app=$null;$first=$null;$second=$null;$guard=$null;$owned=$false
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class JarvisRecoveryWordWindow{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);}'
Add-Type -Path $GuardPath
$before=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;ticks=$_.StartTime.ToUniversalTime().Ticks.ToString()} })
try{
 $app=New-Object -ComObject Word.Application;$first=$app.Documents.Add()
 [uint32]$wordPid=0;[JarvisRecoveryWordWindow]::GetWindowThreadProcessId([IntPtr]$first.Windows.Item(1).Hwnd,[ref]$wordPid)|Out-Null
 if($wordPid -le 0 -or @($before|Where-Object {$_.pid -eq $wordPid}).Count -gt 0){throw 'WORD_INSTANCE_NOT_ISOLATED'}
 $owned=$true;$guard=[JarvisWordProcessGuard]::new([int]$wordPid,$ParentPid)
 $app.AutomationSecurity=3
 $app.DisplayAlerts=0
 $app.Visible=$true
 $first.Content.Text='synthetic primary document'
 [string]$bad=Join-Path $Root 'missing-parent/failed.docx';$failed=$false;$saveHresult=$null
 try{$first.SaveAs2([ref]$bad,[ref]16)}catch{$failed=$true;$saveHresult=$_.Exception.HResult}
 [string]$one=Join-Path $Root 'jarvis-primary.docx';$first.SaveAs2([ref]$one,[ref]16)
 $first.Close(0);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($first);$first=$app.Documents.Open($one,$false,$true,$false)
 $primaryMatches=$first.Content.Text.Trim() -eq 'synthetic primary document'
 $second=$app.Documents.Add();$second.Content.Text='synthetic secondary document'
 [string]$two=Join-Path $Root 'jarvis-secondary.docx';$second.SaveAs2([ref]$two,[ref]16)
  @{observedAt=[DateTime]::UtcNow.ToString('o');wordPid=[int]$wordPid;ownedStartTicks=$guard.OwnedStartTicks.ToString();hostPid=$PID;wordVersion=$app.Version;saveFailureObserved=$failed;saveFailureHresult=$saveHresult;failedOutputAbsent=(-not(Test-Path -LiteralPath $bad));primaryReopenedMatches=$primaryMatches;primaryTitle=$first.Windows.Item(1).Caption;secondaryTitle=$second.Windows.Item(1).Caption;baseline=$before;jobAssigned=$guard.JobAssigned} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Root 'ready.json') -Encoding UTF8
 $deadline=[DateTime]::UtcNow.AddSeconds(90)
 while(-not(Test-Path -LiteralPath (Join-Path $Root 'stop')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
}catch{
 @{exceptionType=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;errorId=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;message=$_.Exception.Message.Substring(0,[Math]::Min(300,$_.Exception.Message.Length));innerHresult=$_.Exception.InnerException.HResult} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Root 'setup-error.json') -Encoding UTF8
 throw
}finally{
 foreach($doc in @($second,$first)){if($null -ne $doc){try{$doc.Close(0)}catch{};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc)}}
 if($app){try{if($owned){$app.Quit(0)}}catch{};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)}
 if($guard){$guard.Dispose()};[GC]::Collect();[GC]::WaitForPendingFinalizers()
}
