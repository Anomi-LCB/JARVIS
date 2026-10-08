#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3', 'turbo')]
  [string]$Model = 'small',
  [string]$HostName = '0.0.0.0',
  [ValidateRange(1, 65535)]
  [int]$Port = 4176
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.runtime\wearable-stt\Scripts\python.exe'
$cacheDir = Join-Path $root '.runtime\wearable-stt-models'
$runner = Join-Path $PSScriptRoot 'wearable-local-stt.py'
$fieldServer = Join-Path $root 'dist\wearable-hud-field-kit\field-server.mjs'

if (-not (Test-Path -LiteralPath $python)) {
  throw 'Wearable STT runtime is missing. Run npm run wearable:stt:setup first.'
}

& node (Join-Path $PSScriptRoot 'wearable-hud-field-kit.mjs') | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fieldServer)) {
  throw 'Failed to generate the wearable field kit.'
}

$sttArgs = @(
  $runner,
  '--daemon',
  '--model', $Model,
  '--cache-dir', $cacheDir
)
$env:JARVIS_WEARABLE_STT_COMMAND = $python
$env:JARVIS_WEARABLE_STT_ARGS_JSON = $sttArgs | ConvertTo-Json -Compress
$env:JARVIS_WEARABLE_STT_MODE = 'daemon'
& node $fieldServer --host $HostName --port $Port
exit $LASTEXITCODE
