param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ClientPath,
  [ValidateRange(1, 65535)]
  [int]$CorePort = 4071
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'A_WINDOWS_USER_SESSION_REQUIRED' }
if (-not [IO.Path]::IsPathRooted($ClientPath) -or -not $ClientPath.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) { throw 'A_GOOGLE_CLIENT_FILE_INVALID' }
$clientFile = Get-Item -LiteralPath $ClientPath
if ($clientFile.Length -gt 65536 -or $clientFile.PSIsContainer) { throw 'A_GOOGLE_CLIENT_FILE_INVALID' }
$clientConfig = Get-Content -LiteralPath $clientFile.FullName -Raw | ConvertFrom-Json
if (-not $clientConfig.installed.client_id -or -not $clientConfig.installed.client_secret) { throw 'A_GOOGLE_DESKTOP_CLIENT_INVALID' }

$tokenPath = Join-Path $env:LOCALAPPDATA 'Jarvis\credentials\integration-handoff-token.dpapi'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'A_GOOGLE_HANDOFF_TOKEN_NOT_CONFIGURED' }
$scopes = @('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly')
$base = "http://127.0.0.1:$CorePort"
$helperPath = Join-Path $PSScriptRoot 'personal-google-connect.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$http = [System.Net.Http.HttpClient]::new($handler)
$http.Timeout = [TimeSpan]::FromSeconds(20)
$brokerToken = $null
$tokenPointer = [IntPtr]::Zero
$secureToken = $null
$handoffId = $null
$process = $null
$issued = $null

function Send-Json([string]$Method, [string]$Uri, $Body, [string]$Bearer) {
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  if ($Bearer) { $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Bearer) }
  if ($null -ne $Body) { $request.Content = [System.Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json') }
  try {
    $response = $http.SendAsync($request).GetAwaiter().GetResult()
    try { return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } }
    finally { $response.Dispose() }
  } finally { $request.Dispose() }
}

function Quote-WindowsArgument([string]$Value) {
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

try {
  $protectedToken = Get-Content -LiteralPath $tokenPath -Raw
  $secureToken = ConvertTo-SecureString -String $protectedToken
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $brokerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  $tokenPointer = [IntPtr]::Zero
  $protectedToken = $null

  $issueBody = @{ connectorId = 'jarvis-google-workspace'; authMethod = 'oauth2'; scopes = $scopes; ttlMs = 360000 } | ConvertTo-Json -Compress
  $issuedResponse = Send-Json 'POST' "$base/integrations/handoffs" $issueBody $brokerToken
  if ($issuedResponse.StatusCode -ne 201) { throw "A_GOOGLE_HANDOFF_ISSUE_FAILED_$($issuedResponse.StatusCode)" }
  $issued = $issuedResponse.Content | ConvertFrom-Json
  $handoffId = [string]$issued.handoffId
  if ($handoffId -notmatch '^[0-9a-fA-F-]{36}$' -or $issued.ticket -notmatch '^[A-Za-z0-9_-]{43}$' -or (@($issued.scopes | Sort-Object) -join '|') -ne (@($scopes | Sort-Object) -join '|')) {
    throw 'A_GOOGLE_HANDOFF_CONTRACT_INVALID'
  }

  $completionUrl = "$base/integrations/handoffs/$handoffId/complete"
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node
  $startInfo.Arguments = "$(Quote-WindowsArgument $helperPath) $(Quote-WindowsArgument $clientFile.FullName) $(Quote-WindowsArgument $completionUrl)"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.WorkingDirectory = $PSScriptRoot
  $startInfo.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $startInfo.EnvironmentVariables[$name] = $value }
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'A_GOOGLE_CONNECT_FAILED' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $handoffJson = @{ handoffId = $handoffId; ticket = [string]$issued.ticket } | ConvertTo-Json -Compress
  $process.StandardInput.Write($handoffJson)
  $process.StandardInput.Close()
  $issued = $null
  $handoffJson = $null
  if (-not $process.WaitForExit(330000)) {
    try { $process.Kill() } catch { }
    throw 'A_GOOGLE_CONNECT_TIMEOUT'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout) { Write-Output $stdout.TrimEnd() }
  if ($process.ExitCode -ne 0) {
    if ($stderr -match '(?m)^(A_GOOGLE_[A-Z0-9_]+)$') { throw $Matches[1] }
    throw 'A_GOOGLE_CONSENT_NOT_COMPLETED'
  }
  Write-Output 'GOOGLE_HANDOFF=completed'
  Write-Output 'GOOGLE_SCOPE=read-only Gmail and Calendar'
  Write-Output 'Provider credential verification and sync state are shown in JARVIS; no JARVIS execution grant was created.'
} catch {
  if ($handoffId -and $brokerToken) { try { [void](Send-Json 'DELETE' "$base/integrations/handoffs/$handoffId" $null $brokerToken) } catch { } }
  if ($_.Exception.Message -match '^A_GOOGLE_[A-Z0-9_]+$') { throw $_.Exception.Message }
  $exceptionType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  throw "A_GOOGLE_CONNECT_FAILED_${exceptionType}"
} finally {
  if ($process) { $process.Dispose() }
  if ($tokenPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
  if ($secureToken) { $secureToken.Dispose() }
  $brokerToken = $null
  $issued = $null
  $handoffJson = $null
  $http.Dispose()
  $handler.Dispose()
}
