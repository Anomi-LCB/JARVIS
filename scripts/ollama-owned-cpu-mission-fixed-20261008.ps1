param([string]$OutputPath)
$ErrorActionPreference='Stop'
$taskRoot=Join-Path ([IO.Path]::GetTempPath()) ('jarvis-cpu-probe-'+[guid]::NewGuid())
$guard=$null;$server=$null;$result=@{observedAt=[DateTime]::UtcNow.ToString('o');model='gemma3:latest';clientVersion='0.33.1';status='failed';cost='unmeasured';productActivated=$false;originalMissionExecuted=$false}
$baseline=@(Get-Process ollama* -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;ticks=$_.StartTime.ToUniversalTime().Ticks.ToString()} })
$result.baselineProcessCount=$baseline.Count
if(Test-Path -LiteralPath $OutputPath){throw 'EVIDENCE_ALREADY_EXISTS'}
if(Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue){throw 'ISOLATED_PORT_IN_USE'}
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$names=@('OLLAMA_HOST','OLLAMA_VULKAN','GGML_VK_VISIBLE_DEVICES','CUDA_VISIBLE_DEVICES','ROCR_VISIBLE_DEVICES','OLLAMA_NO_CLOUD','OLLAMA_NUM_PARALLEL')
$prior=@{};foreach($name in $names){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
 $guardSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../apps/pc-agent/src/adapters/word/native-process-guard.cs')).Replace('JarvisWordProcessGuard','JarvisOwnedOllamaGuard').Replace('"WINWORD"','"ollama"')
 Add-Type -TypeDefinition $guardSource
 $env:OLLAMA_HOST='127.0.0.1:11435';$env:OLLAMA_VULKAN='0';$env:GGML_VK_VISIBLE_DEVICES='-1';$env:CUDA_VISIBLE_DEVICES='-1';$env:ROCR_VISIBLE_DEVICES='-1';$env:OLLAMA_NO_CLOUD='1';$env:OLLAMA_NUM_PARALLEL='1'
 $server=Start-Process -FilePath 'C:/Users/user/AppData/Local/Programs/Ollama/ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'out.log') -RedirectStandardError (Join-Path $taskRoot 'err.log')
 if(@($baseline | Where-Object {$_.pid -eq $server.Id}).Count){throw 'OWNERSHIP_CONFLICT'}
 $guard=[JarvisOwnedOllamaGuard]::new($server.Id,$PID)
 $result.jobAssigned=$guard.JobAssigned;$result.ownedPid=$server.Id
 $ready=$false;$until=[DateTime]::UtcNow.AddSeconds(20)
 while([DateTime]::UtcNow -lt $until){try{$tags=Invoke-RestMethod 'http://127.0.0.1:11435/api/tags' -TimeoutSec 2;$ready=$true;break}catch{Start-Sleep -Milliseconds 200}}
 if(-not $ready){throw 'CPU_SERVER_NOT_READY'}
 $model=@($tags.models | Where-Object {$_.name -eq 'gemma3:latest'})
 if($model.Count -ne 1 -or $model[0].size -lt 1000000){throw 'INSTALLED_MODEL_UNAVAILABLE'}
 $result.modelDigest=$model[0].digest;$result.modelBytes=$model[0].size
 $env:PATH="$(Resolve-Path artifacts/bundled-node-runtime-20261003/package/runtime);$env:PATH"
 & node scripts/local-model-cpu-mission-20261008.mjs artifacts/local-model-cpu-mission-fixed-20261008
 $result.nodeExitCode=$LASTEXITCODE
 $missionResult=[IO.File]::ReadAllText((Join-Path $PWD 'artifacts/local-model-cpu-mission-fixed-20261008/result.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
 $result.missionSummary=$missionResult.summary
 $result.correct=($missionResult.summary.outcome -eq 'passed')
 $result.originalMissionExecuted=$true
 $logStream=[IO.FileStream]::new((Join-Path $taskRoot 'err.log'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 $logReader=[IO.StreamReader]::new($logStream)
 try{$log=$logReader.ReadToEnd()}finally{$logReader.Dispose()}
 $result.cpuBackendObserved=($log -match 'library=cpu|device=CPU|CPU model buffer|CPU_Mapped model buffer')
 $result.gpuOffloadObserved=($log -match 'offloaded [1-9][0-9]*/[0-9]+ layers to GPU')
 $result.backendLines=@(($log -split "`n") | Where-Object {$_ -match 'inference compute|offload|model buffer|library=cpu'} | Select-Object -First 12)
 $result.serverAliveAfterRequest=(-not $server.HasExited)
 if($result.correct -and $result.cpuBackendObserved -and -not $result.gpuOffloadObserved -and $result.serverAliveAfterRequest){$result.status='passed'}
}catch{$result.setupError=$_.Exception.GetType().FullName}
finally{
 if($guard){$guard.Dispose()}elseif($server -and -not $server.HasExited){$server.Kill()}
 foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}
 $result.baselinePreserved=(@($baseline | Where-Object { $p=Get-Process -Id $_.pid -ErrorAction SilentlyContinue; -not $p -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $_.ticks }).Count -eq 0)
 if($server){$result.ownedServerStopped=$server.WaitForExit(5000)}
 $resolved=[IO.Path]::GetFullPath($taskRoot);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
 if(-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'TEMP_SCOPE_INVALID'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
 $json=$result | ConvertTo-Json -Depth 8
 $file=[IO.File]::Open($OutputPath,[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes($json);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
 Write-Output $json
}
