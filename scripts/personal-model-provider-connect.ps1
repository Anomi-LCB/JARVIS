param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('xai', 'meta', 'gemini', 'openai-agents')]
  [string]$Provider,
  [ValidateRange(1, 65535)]
  [int]$CorePort = 4071,
  [switch]$Verify,
  [ValidateLength(1, 200)]
  [string]$ModelId
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'A_WINDOWS_USER_SESSION_REQUIRED' }
$Provider = $Provider.ToLowerInvariant()
$tokenPath = Join-Path $env:LOCALAPPDATA 'Jarvis\credentials\integration-handoff-token.dpapi'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'A_MODEL_HANDOFF_TOKEN_NOT_CONFIGURED' }

$isOpenAiAgents = $Provider -eq 'openai-agents'
$connectorId = if ($isOpenAiAgents) { 'jarvis-openai-agents' } else { "jarvis-model-$Provider" }
$scopeList = @()
if ($isOpenAiAgents) { $scopeList = @('agents.session.create', 'agents.session.read', 'agents.provider.verify') }
else { $scopeList = @('model.plan') }
$base = "http://127.0.0.1:$CorePort"
Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(60)
$secureToken = $null
$tokenPointer = [IntPtr]::Zero
$secureKey = $null
$keyPointer = [IntPtr]::Zero
$keyText = $null
$handoffId = $null
$brokerToken = $null
$stage = 'token-read'

function Send-Json($Method, $Uri, $Body, $Bearer) {
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  if ($Bearer) { $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Bearer) }
  if ($null -ne $Body) { $request.Content = [System.Net.Http.StringContent]::new($Body, [System.Text.Encoding]::UTF8, 'application/json') }
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  try {
    $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $content }
  } finally { $response.Dispose(); $request.Dispose() }
}

try {
  $protectedToken = Get-Content -LiteralPath $tokenPath -Raw
  $secureToken = ConvertTo-SecureString -String $protectedToken
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $brokerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  $tokenPointer = [IntPtr]::Zero
  $protectedToken = $null

  $stage = 'handoff-issue'
  $issueBody = @{ connectorId = $connectorId; authMethod = 'api-key'; scopes = $scopeList } | ConvertTo-Json -Compress
  $issuedResponse = Send-Json 'POST' "$base/integrations/handoffs" $issueBody $brokerToken
  if ($issuedResponse.StatusCode -ne 201) { throw "A_MODEL_HANDOFF_ISSUE_FAILED_$($issuedResponse.StatusCode)" }
  $issued = $issuedResponse.Content | ConvertFrom-Json
  $handoffId = [string]$issued.handoffId
  $scopeMatches = $issued.scopes.Count -eq $scopeList.Count
  foreach ($scope in $scopeList) { if ($scopeList.Count -ne $issued.scopes.Count -or $scope -notin $issued.scopes) { $scopeMatches = $false } }
  if (-not $handoffId -or -not $issued.ticket -or -not $scopeMatches) {
    throw 'A_MODEL_HANDOFF_CONTRACT_INVALID'
  }

  $stage = 'api-key-prompt'
  $secureKey = Read-Host -Prompt "$Provider API key (입력은 화면에 표시되지 않습니다)" -AsSecureString
  if ($secureKey.Length -lt 1 -or $secureKey.Length -gt 8192) { throw 'A_MODEL_API_KEY_LENGTH_INVALID' }
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $keyText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  $keyPointer = [IntPtr]::Zero
  $stage = 'handoff-complete'
  $label = if ($isOpenAiAgents) { 'JARVIS OpenAI Agents session key' } else { "JARVIS $Provider planning key" }
  $completeBody = @{ providerAccountId = 'primary'; label = $label; credentials = @{ apiKey = $keyText } } | ConvertTo-Json -Depth 6 -Compress
  $completeUrl = "$base/integrations/handoffs/$($issued.handoffId)/complete"
  $completed = Send-Json 'POST' $completeUrl $completeBody ([string]$issued.ticket)
  if ($completed.StatusCode -ne 202) { throw "A_MODEL_HANDOFF_STORE_FAILED_$($completed.StatusCode)" }
  $result = $completed.Content | ConvertFrom-Json
  if ($result.providerVerified -ne $false -or $result.executionAuthorized -ne $false) { throw 'A_MODEL_HANDOFF_RESULT_INVALID' }
  if ($Verify) {
    $stage = 'provider-verification'
    $verificationBody = if ($ModelId) { @{ modelId = $ModelId } | ConvertTo-Json -Compress } else { '{}' }
    $verification = Send-Json 'POST' "$base/integrations/model-providers/$Provider/verify" $verificationBody $brokerToken
    if ($verification.StatusCode -ne 200) { throw "A_MODEL_PROVIDER_VERIFY_FAILED_$($verification.StatusCode)" }
    $verificationResult = $verification.Content | ConvertFrom-Json
    if ($verificationResult.executionAuthorized -isnot [bool] -or $verificationResult.executionAuthorized) { throw 'A_MODEL_PROVIDER_VERIFY_RESULT_INVALID' }
    if ($verificationResult.providerVerified -isnot [bool]) { throw 'A_MODEL_PROVIDER_VERIFY_RESPONSE_INVALID' }
    Write-Output 'CREDENTIAL_STATE=stored'
    Write-Output "PROVIDER_VERIFIED=$($verificationResult.providerVerified.ToString().ToLowerInvariant())"
    Write-Output "PROVIDER_VERIFICATION_STATUS=$($verificationResult.status)"
    if ($null -ne $verificationResult.modelCount) { Write-Output "AVAILABLE_MODEL_COUNT=$($verificationResult.modelCount)" }
    if ($null -ne $verificationResult.requestedModelAvailable) { Write-Output "REQUESTED_MODEL_AVAILABLE=$($verificationResult.requestedModelAvailable.ToString().ToLowerInvariant())" }
  } else {
    Write-Output 'CREDENTIAL_STATE=stored-unverified'
  }
  Write-Output "PROVIDER=$Provider"
  Write-Output 'EXECUTION_AUTHORIZED=false'
  if ($isOpenAiAgents) {
    Write-Output "SCOPES=$($scopeList -join ',')"
    Write-Output 'SESSION_EXECUTION_AUTHORIZED=false'
    Write-Output 'Next: verify the configured service identity can decrypt this CurrentUser DPAPI record; hosted session creation remains disabled until the service broker and per-Mission resource authorization are configured.'
  } else {
    Write-Output 'Next: select this provider and a model in Core configuration, restart Core, then run an approved public-data connection pilot.'
  }
} catch {
  if ($handoffId -and $brokerToken) {
    try { [void](Send-Json 'DELETE' "$base/integrations/handoffs/$handoffId" $null $brokerToken) } catch { }
  }
  if ($_.Exception.Message -match '^A_(MODEL|INTEGRATION)_[A-Z0-9_]+$') { throw $_.Exception.Message }
  $exceptionType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9]', ''
  $errorLine = [int]$_.InvocationInfo.ScriptLineNumber
  throw "A_MODEL_PROVIDER_CONNECT_FAILED_$($stage.ToUpperInvariant().Replace('-', '_'))_${exceptionType}_LINE_$errorLine"
} finally {
  if ($tokenPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($secureToken) { $secureToken.Dispose() }
  if ($secureKey) { $secureKey.Dispose() }
  $brokerToken = $null
  $keyText = $null
  $completeBody = $null
  $verificationBody = $null
  $issued = $null
  $client.Dispose()
  $handler.Dispose()
}
