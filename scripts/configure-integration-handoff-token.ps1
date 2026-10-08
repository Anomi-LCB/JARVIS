param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'A_WINDOWS_USER_SESSION_REQUIRED' }

$directory = [IO.Path]::Combine($env:LOCALAPPDATA, 'Jarvis', 'credentials')
$tokenPath = [IO.Path]::Combine($directory, 'integration-handoff-token.dpapi')
if ([IO.File]::Exists($tokenPath) -and -not $Force) {
  throw 'A_HANDOFF_TOKEN_ALREADY_EXISTS_USE_FORCE_TO_ROTATE'
}

[void][IO.Directory]::CreateDirectory($directory)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$principals = @(
  $identity.User,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
foreach ($principal in $principals) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($directory, $acl)

$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
try { $random.GetBytes($bytes) } finally { $random.Dispose() }
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[Array]::Clear($bytes, 0, $bytes.Length)
try {
  $secure = Microsoft.PowerShell.Security\ConvertTo-SecureString -String $token -AsPlainText -Force
  $protected = Microsoft.PowerShell.Security\ConvertFrom-SecureString -SecureString $secure
  [IO.File]::WriteAllText($tokenPath, $protected, [Text.Encoding]::ASCII)
  $fileAcl = New-Object System.Security.AccessControl.FileSecurity
  $fileAcl.SetAccessRuleProtection($true, $false)
  foreach ($principal in $principals) {
    $fileRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$fileAcl.AddAccessRule($fileRule)
  }
  [IO.File]::SetAccessControl($tokenPath, $fileAcl)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token)) } finally { $sha256.Dispose() }
  $hashText = [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
  [Array]::Clear($hash, 0, $hash.Length)
} finally {
  if ($null -ne $secure) { $secure.Dispose() }
  $token = $null
}

Write-Output 'DPAPI_CURRENT_USER_TOKEN_STORED=true'
Write-Output "TOKEN_FILE=$tokenPath"
Write-Output "JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256=$hashText"
Write-Output 'Configure that SHA-256 value in the Core service environment, then restart Core. The raw token was not printed.'
