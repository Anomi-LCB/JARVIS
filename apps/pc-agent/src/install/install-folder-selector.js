/** Embedded by NSIS before extraction; reserves a fresh code folder without removing old releases. */
export function renderInstallFolderSelector() {
 return String.raw`param([Parameter(Mandatory=$true)][string]$BaseRoot,[Parameter(Mandatory=$true)][string]$ReleaseId)
$ErrorActionPreference='Stop'
if ($ReleaseId -notmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted($BaseRoot)) {throw 'PC_INSTALL_FOLDER_INPUT_INVALID'}
$base=[IO.Path]::GetFullPath($BaseRoot).TrimEnd('\','/')
if ($base.StartsWith('\\')) {throw 'PC_INSTALL_REMOTE_CODE_ROOT_DENIED'}
$parent=$base
while ($parent) {
 if (Test-Path -LiteralPath $parent) {
  $item=Get-Item -LiteralPath $parent -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'PC_INSTALL_LINKED_CODE_ROOT_DENIED'}
 }
 $parent=[IO.Path]::GetDirectoryName($parent)
}
[IO.Directory]::CreateDirectory($base) | Out-Null
for ($attempt=0;$attempt -lt 8;$attempt++) {
 $name=$ReleaseId
 if ($attempt -gt 0 -or (Test-Path -LiteralPath (Join-Path $base $name))) {$name=$ReleaseId+'-repair-'+[Guid]::NewGuid().ToString('N')}
 $candidate=Join-Path $base $name
 if (Test-Path -LiteralPath $candidate) {continue}
 [IO.Directory]::CreateDirectory($candidate) | Out-Null
 $claim=Join-Path $candidate '.install-reservation'
 try {
  $stream=[IO.File]::Open($claim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
   $bytes=[Text.Encoding]::UTF8.GetBytes(($ReleaseId+[Environment]::NewLine+[DateTime]::UtcNow.ToString('o')))
   $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
  } finally {$stream.Dispose()}
  # No newline: NSIS uses this stdout value as the exact destination path.
  [Console]::Out.Write($candidate)
  exit 0
 } catch [IO.IOException] {continue}
}
throw 'PC_INSTALL_FOLDER_RESERVATION_FAILED'
`;
}
