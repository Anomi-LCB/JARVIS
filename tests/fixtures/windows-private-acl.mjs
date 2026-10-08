import { execFileSync } from 'node:child_process';

// Synthetic fixtures only. Caller supplies its newly created temporary file/directory.
export function setFixturePrivateAcl(target, shared = false) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop';
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$sections=[System.Security.AccessControl.AccessControlSections]::Access;
$directory=[IO.Directory]::Exists($env:JARVIS_ACL_TEST_PATH);
$acl=if($directory){[IO.Directory]::GetAccessControl($env:JARVIS_ACL_TEST_PATH,$sections)}else{[IO.File]::GetAccessControl($env:JARVIS_ACL_TEST_PATH,$sections)};
$acl.SetAccessRuleProtection($true,$false);
foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)};
$inherit=if($directory){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl',$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow));
if($env:JARVIS_ACL_TEST_SHARED -eq '1'){$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadData',$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow))};
if($directory){[IO.Directory]::SetAccessControl($env:JARVIS_ACL_TEST_PATH,$acl)}else{[IO.File]::SetAccessControl($env:JARVIS_ACL_TEST_PATH,$acl)};
`], { windowsHide: true, encoding: 'utf8', timeout: 5000, env: { ...process.env, JARVIS_ACL_TEST_PATH: target, JARVIS_ACL_TEST_SHARED: shared ? '1' : '0' } });
}
