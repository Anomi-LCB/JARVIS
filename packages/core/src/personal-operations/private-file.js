import { openSync, closeSync, fstatSync, lstatSync, readSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Read-only conservative DACL check: no account names or secret bytes leave PowerShell.
// Administrators/SYSTEM remain trusted OS principals; this is not process isolation.
function assertWindowsPrivateAccess(path) {
  const script = `$ErrorActionPreference='Stop';
$securityModule=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1';
Import-Module $securityModule -ErrorAction Stop;
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$trusted=@($current,'S-1-5-18','S-1-5-32-544');
foreach($target in @($env:JARVIS_PRIVATE_ACL_PATH,[IO.Path]::GetDirectoryName($env:JARVIS_PRIVATE_ACL_PATH))){
 $sections=[System.Security.AccessControl.AccessControlSections]'Access,Owner';
 $acl=if([IO.Directory]::Exists($target)){[IO.Directory]::GetAccessControl($target,$sections)}else{[IO.File]::GetAccessControl($target,$sections)};
 if($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value){throw 'Denied'};
 $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));
 if(@($rules | Where-Object {$_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow}).Count -eq 0){throw 'Denied'};
 foreach($rule in $rules){
  if($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $trusted -notcontains $rule.IdentityReference.Value -and [int64]$rule.FileSystemRights -ne 0){throw 'Denied'}
 }
}
[Console]::Write('PRIVATE_ACL_OK');`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JARVIS_PRIVATE_ACL_PATH: path }
  });
  if (output !== 'PRIVATE_ACL_OK') throw new Error();
}

/** Bounded descriptor read. Linux private files require a non-root owner and private parent directory.
 * Windows denies untrusted owner/allow DACL rules on file and immediate parent.
 * Same-user/administrator isolation and full effective-access audit remain deployment requirements. */
export function readPrivateFile(path, { maxBytes = 16384, allowEmpty = false, errorCode = 'A_GOOGLE_BROKER_PRIVATE_FILE_DENIED' } = {}) {
  let fd;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || typeof allowEmpty !== 'boolean') throw new Error();
    const absolute = resolve(path), original = lstatSync(absolute);
    if (!original.isFile() || original.isSymbolicLink()) throw new Error();
    if (process.platform === 'win32') {
      for (let current = dirname(absolute);;) {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
        const next = dirname(current); if (next === current) break; current = next;
      }
      assertWindowsPrivateAccess(absolute);
    }
    if (process.platform !== 'win32') {
      const uid = process.geteuid(); if (uid === 0) throw new Error();
      const parent = lstatSync(dirname(absolute));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) throw new Error();
      for (let current = dirname(absolute);;) {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid)
          || ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000)))) throw new Error();
        const next = dirname(current); if (next === current) break; current = next;
      }
    }
    fd = openSync(absolute, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < (allowEmpty ? 0 : 1) || info.size > maxBytes
      || info.dev !== original.dev || info.ino !== original.ino
      || (process.platform !== 'win32' && (info.uid !== process.geteuid() || (info.mode & 0o077)))) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1); let total = 0, count;
    while ((count = readSync(fd, bytes, total, bytes.length - total, total)) > 0) { total += count; if (total > maxBytes) throw new Error(); }
    const after = fstatSync(fd);
    if (total !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error();
    return bytes.subarray(0, total);
  } catch { throw new Error(errorCode); }
  finally { if (fd !== undefined) closeSync(fd); }
}
