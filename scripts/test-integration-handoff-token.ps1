$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'A_WINDOWS_USER_SESSION_REQUIRED' }

$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$testRoot = Join-Path $tempRoot ("Jarvis-HandoffTokenSmoke-" + [Guid]::NewGuid().ToString('N'))
$previousLocalAppData = $env:LOCALAPPDATA
$secure = $null
$pointer = [IntPtr]::Zero
$token = $null
$tokenBytes = $null
$hashBytes = $null
$sha256 = $null
$failureCode = 'A_HANDOFF_TOKEN_SMOKE_FAILED'

function Assert-RestrictedAcl([string]$Path, [bool]$IsDirectory, [string[]]$ExpectedSids) {
  $acl = if ($IsDirectory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  if (-not $acl.AreAccessRulesProtected) { throw 'A_HANDOFF_TOKEN_ACL_INHERITANCE_ENABLED' }
  $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  $actual = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  $expected = @($ExpectedSids | Sort-Object -Unique)
  if (($actual -join ',') -ne ($expected -join ',')) { throw 'A_HANDOFF_TOKEN_ACL_PRINCIPALS_INVALID' }
  foreach ($rule in $rules) {
    $hasFullControl = (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or -not $hasFullControl) {
      throw 'A_HANDOFF_TOKEN_ACL_RIGHTS_INVALID'
    }
  }
}

try {
  $warmSecure = Microsoft.PowerShell.Security\ConvertTo-SecureString -String 'temporary-module-load-check' -AsPlainText -Force
  [void](Microsoft.PowerShell.Security\ConvertFrom-SecureString -SecureString $warmSecure)
  $warmSecure.Dispose()
  [void][IO.Directory]::CreateDirectory($testRoot)
  $env:LOCALAPPDATA = $testRoot
  $provisionPath = [IO.Path]::Combine($PSScriptRoot, 'configure-integration-handoff-token.ps1')
  $output = @(& $provisionPath | ForEach-Object { [string]$_ })
  $joinedOutput = $output -join "`n"
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'A_HANDOFF_TOKEN_PROVISION_COMMAND_FAILED' }
  $match = [Regex]::Match($joinedOutput, '(?m)^JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256=([0-9a-f]{64})$')
  if (-not $match.Success) { throw 'A_HANDOFF_TOKEN_HASH_OUTPUT_INVALID' }

  $credentialDirectory = [IO.Path]::Combine($testRoot, 'Jarvis', 'credentials')
  $tokenPath = [IO.Path]::Combine($credentialDirectory, 'integration-handoff-token.dpapi')
  if (-not ([IO.File]::Exists($tokenPath))) { throw 'A_HANDOFF_TOKEN_FILE_MISSING' }
  if (-not $joinedOutput.Contains('raw token was not printed')) { throw 'A_HANDOFF_TOKEN_DISCLOSURE_NOTICE_MISSING' }
  Assert-RestrictedAcl $credentialDirectory $true @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    'S-1-5-18', 'S-1-5-32-544'
  )
  Assert-RestrictedAcl $tokenPath $false @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    'S-1-5-18', 'S-1-5-32-544'
  )

  $protected = [IO.File]::ReadAllText($tokenPath)
  $secure = Microsoft.PowerShell.Security\ConvertTo-SecureString -String $protected
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $pointer = [IntPtr]::Zero
  $tokenBytes = [Text.Encoding]::UTF8.GetBytes($token)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha256.ComputeHash($tokenBytes)
  $actualHash = [BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
  if ($actualHash -ne $match.Groups[1].Value) { throw 'A_HANDOFF_TOKEN_DPAPI_HASH_MISMATCH' }
  if ($joinedOutput.Contains($token)) { throw 'A_HANDOFF_TOKEN_SECRET_WAS_PRINTED' }

  Write-Output 'DPAPI_CURRENT_USER_ROUNDTRIP=passed'
  Write-Output 'TOKEN_HASH_MATCH=passed'
  Write-Output 'DIRECTORY_AND_FILE_ACL=passed'
  Write-Output 'RAW_TOKEN_OUTPUT=absent'
} catch {
  $safeFailure = $_.Exception.Message
  if ($safeFailure -notmatch '^A_(HANDOFF_TOKEN|INTEGRATION)_[A-Z0-9_]+$') {
    $safeFailure = "$failureCode ($($_.Exception.GetType().Name):$($_.FullyQualifiedErrorId):line$($_.InvocationInfo.ScriptLineNumber):$($_.InvocationInfo.MyCommand.Name))"
  }
  Write-Error $safeFailure
  exit 1
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($secure) { $secure.Dispose() }
  if ($sha256) { $sha256.Dispose() }
  if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
  if ($hashBytes) { [Array]::Clear($hashBytes, 0, $hashBytes.Length) }
  $token = $null
  $env:LOCALAPPDATA = $previousLocalAppData
  $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedRootIsInsideTemp = $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)
  if ($resolvedRootIsInsideTemp -and (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  }
}
