param([string]$FixtureRoot,[switch]$Bootstrap,[switch]$Cleanup)
$ErrorActionPreference='Stop'
$global:fixtureRoot=$FixtureRoot
$global:fixtureSvc=Get-Content (Join-Path $fixtureRoot 'service.json') -Raw | ConvertFrom-Json
function global:Save-Service {[IO.File]::WriteAllText((Join-Path $fixtureRoot 'service.json'),($fixtureSvc|ConvertTo-Json))}
function global:Get-CimInstance {return $fixtureSvc}
function global:Get-Service {$v=[pscustomobject]@{Status=$fixtureSvc.State};$v|Add-Member ScriptMethod WaitForStatus {param($status,$timeout)};return $v}
function global:Stop-Service {
 $file=Join-Path $fixtureRoot 'owner.json'
 if(Test-Path $file){
  $record=Get-Content $file -Raw|ConvertFrom-Json
  $owner=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if($owner){
   if($owner.Path -ne $record.path -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.ticks){throw 'OWNER_MISMATCH'}
   [IO.File]::WriteAllText($record.stop,'stop')
   if(-not $owner.WaitForExit(15000)){throw 'OWNER_STOP_TIMEOUT'}
  }
 }
 $fixtureSvc.State='Stopped';Save-Service
}
function global:Start-Service {
 $hostExe=$fixtureSvc.PathName.Trim('"')
 $version=Split-Path (Split-Path $hostExe -Parent) -Leaf
 $ready=Join-Path $fixtureRoot ('ready-'+[Guid]::NewGuid().ToString());$stop=$ready+'.stop'
 $env:JARVIS_TEST_MODE='0';$env:JARVIS_LLM_INTENT='0';$env:JARVIS_LLM_PLANNER='0';$env:JARVIS_LLM_CONTENT='0'
 $env:JARVIS_CORE_WORKER_DAEMON_ENABLED='0';$env:JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED='0'
 $env:JARVIS_PERSONAL_IMPORT_ENABLED='0';$env:JARVIS_GOOGLE_SYNC_ENABLED='0'
 $env:LOCALAPPDATA=Join-Path $fixtureRoot 'local-app-data'
 $env:JARVIS_CORE_MISSION_AUTHORITY_RECOVERY_ONLY=if((Split-Path $fixtureRoot -Leaf) -eq 'startup-failure' -and $version -eq 'new'){'invalid'}else{$null}
 $runner=Join-Path (Split-Path $fixtureRoot -Parent) 'owner.exe'
 $owner=Start-Process -FilePath $runner -ArgumentList @(('"'+$hostExe+'"'),('"'+$ready+'"'),('"'+$stop+'"')) -WorkingDirectory $fixtureRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot 'owner.stdout') -RedirectStandardError (Join-Path $fixtureRoot 'owner.stderr')
 [IO.File]::WriteAllText((Join-Path $fixtureRoot 'owner.json'),(@{pid=$owner.Id;path=$runner;ticks=$owner.StartTime.ToUniversalTime().Ticks.ToString();stop=$stop}|ConvertTo-Json))
 for($n=0;$n -lt 150;$n++){
  if(Test-Path $ready){$fixtureSvc.State='Running';Save-Service;return}
  $owner.Refresh();if($owner.HasExited){throw ('NATIVE_START_FAILED: '+(Get-Content (Join-Path $fixtureRoot 'owner.stderr') -Raw))}
  Start-Sleep -Milliseconds 100
 }
 throw 'NATIVE_READY_TIMEOUT'
}
function global:sc.exe {if($args[0] -ne 'config'){throw 'UNEXPECTED_SCM_COMMAND'};$fixtureSvc.PathName=$args[3];Save-Service;$global:LASTEXITCODE=0}
if($Cleanup){Stop-Service;exit}
if($Bootstrap){Start-Service;exit}
$failure=$null
try {& (Join-Path $fixtureRoot 'new/update-service.ps1')}catch{$failure=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'result.json'),(@{failure=$failure;service=$fixtureSvc}|ConvertTo-Json -Depth 5))
