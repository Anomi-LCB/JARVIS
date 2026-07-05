# Registers the "JarvisBridge" logon scheduled task (current user, no elevation needed)
# and starts it immediately. The bridge then survives reboots in the user session,
# keeping Claude CLI credentials available for the LLM intent/planner/content features.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repoRoot 'scripts\bridge-autostart.ps1'
$taskName = 'JarvisBridge'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"" `
    -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'JARVIS D Bridge always-on server (user context, port 17777)' | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "Registered and started scheduled task '$taskName'."
Write-Output "Bridge logs: $repoRoot\logs\bridge-runtime.out.log"
