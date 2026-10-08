[CmdletBinding()]
param(
  [ValidateSet('OpenAI', 'Anthropic')]
  [string]$Provider = 'OpenAI',

  [ValidateSet('User', 'Machine')]
  [string]$Scope = 'User',

  [switch]$Clear
)

$ErrorActionPreference = 'Stop'
$variableName = if ($Provider -eq 'OpenAI') {
  'JARVIS_OPENAI_API_KEY'
} else {
  'JARVIS_ANTHROPIC_API_KEY'
}

if ($Clear) {
  [Environment]::SetEnvironmentVariable($variableName, $null, $Scope)
  Write-Host "Cleared $variableName from the $Scope environment."
  exit 0
}

$secureValue = Read-Host "Enter the $Provider API key (input is hidden)" -AsSecureString
$bstr = [IntPtr]::Zero
$plainValue = $null
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainValue) -or $plainValue.Length -lt 20) {
    throw 'The API key was empty or unexpectedly short.'
  }

  [Environment]::SetEnvironmentVariable($variableName, $plainValue, $Scope)
  $configured = ![string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($variableName, $Scope))
  if (-not $configured) {
    throw "Failed to persist $variableName in the $Scope environment."
  }
} finally {
  $plainValue = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ($secureValue -is [IDisposable]) {
    $secureValue.Dispose()
  }
}

Write-Host "Configured $variableName in the $Scope environment without writing it to a file or command argument."
Write-Host 'Restart the JARVIS bridge/runtime so the new environment value is loaded.'
