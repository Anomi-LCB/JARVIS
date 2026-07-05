# JARVIS D Bridge always-on launcher (user context).
# Registered as the "JarvisBridge" logon scheduled task by install-bridge-autostart.ps1.
# Runs in the user session so the Claude CLI credentials (LLM intent/planner/content) are available.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$launcherLog = Join-Path $logDir 'bridge-launcher.log'
$outLog = Join-Path $logDir 'bridge-runtime.out.log'
$errLog = Join-Path $logDir 'bridge-runtime.err.log'

# Bind to all interfaces so phones on the private network can reach the bridge.
# The bridge network guard still rejects non-private clients.
$env:JARVIS_BRIDGE_HOST = if ($env:JARVIS_BRIDGE_HOST) { $env:JARVIS_BRIDGE_HOST } else { '0.0.0.0' }
$env:JARVIS_BRIDGE_PORT = if ($env:JARVIS_BRIDGE_PORT) { $env:JARVIS_BRIDGE_PORT } else { '17777' }

# Advertise the LAN address in pairing QR payloads so phones can connect directly.
if (-not $env:JARVIS_BRIDGE_URL) {
    $lanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        Select-Object -First 1).IPv4Address.IPAddress
    if ($lanIp) { $env:JARVIS_BRIDGE_URL = "http://${lanIp}:$($env:JARVIS_BRIDGE_PORT)" }
}

# Keep a single instance: exit if the port is already served.
$existing = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:JARVIS_BRIDGE_PORT) -ErrorAction SilentlyContinue
if ($existing) {
    Add-Content -Path $launcherLog -Value "[$(Get-Date -Format o)] bridge already listening on port $($env:JARVIS_BRIDGE_PORT); launcher exit."
    exit 0
}

Add-Content -Path $launcherLog -Value "[$(Get-Date -Format o)] starting JARVIS bridge on $($env:JARVIS_BRIDGE_HOST):$($env:JARVIS_BRIDGE_PORT)"
Start-Process -FilePath 'node' `
    -ArgumentList 'apps/bridge/src/main.mjs' `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog
