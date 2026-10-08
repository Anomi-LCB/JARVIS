import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPrivateFile } from '../packages/core/src/personal-operations/private-file.js';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';

test('empty SQLite sidecar opt-in preserves Windows ACL checks and the nonempty default',{skip:process.platform!=='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-empty-sidecar-'));setFixturePrivateAcl(root);
  const path=join(root,'empty-wal');writeFileSync(path,'');t.after(()=>{unlinkSync(path);rmdirSync(root);});
  assert.throws(()=>readPrivateFile(path),/PRIVATE_FILE_DENIED/u);
  assert.equal(readPrivateFile(path,{allowEmpty:true}).length,0);
  assert.throws(()=>readPrivateFile(path,{allowEmpty:'true'}),/PRIVATE_FILE_DENIED/u);
  setFixturePrivateAcl(path,true);
  assert.throws(()=>readPrivateFile(path,{allowEmpty:true}),/PRIVATE_FILE_DENIED/u);
});

test('actual Windows ACL changes deny shared key/file parent and allow restored private ACL', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-private-acl-한글-'));
  const path = join(root, 'synthetic-key');
  t.after(() => { unlinkSync(path); rmdirSync(root); });
  writeFileSync(path, 'synthetic-private-credential');
  const setAcl = (target, shared) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop';
Import-Module (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1');
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$sections=[System.Security.AccessControl.AccessControlSections]::Access;
$acl=if([IO.Directory]::Exists($env:JARVIS_ACL_TEST_PATH)){[IO.Directory]::GetAccessControl($env:JARVIS_ACL_TEST_PATH,$sections)}else{[IO.File]::GetAccessControl($env:JARVIS_ACL_TEST_PATH,$sections)};
$acl.SetAccessRuleProtection($true,$false);
foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)};
$inherit=if([IO.Directory]::Exists($env:JARVIS_ACL_TEST_PATH)){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl',$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule);
if($env:JARVIS_ACL_TEST_SHARED -eq '1'){$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadData',$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow))};
if([IO.Directory]::Exists($env:JARVIS_ACL_TEST_PATH)){[IO.Directory]::SetAccessControl($env:JARVIS_ACL_TEST_PATH,$acl)}else{[IO.File]::SetAccessControl($env:JARVIS_ACL_TEST_PATH,$acl)};
`], { windowsHide: true, encoding: 'utf8', timeout: 5000, env: { ...process.env, JARVIS_ACL_TEST_PATH: target, JARVIS_ACL_TEST_SHARED: shared ? '1' : '0' } });
  setAcl(root, false); setAcl(path, false);
  assert.equal(readPrivateFile(path).toString(), 'synthetic-private-credential');
  setAcl(path, true);
  assert.throws(() => readPrivateFile(path), { message: 'A_GOOGLE_BROKER_PRIVATE_FILE_DENIED' });
  setAcl(path, false); setAcl(root, true);
  assert.throws(() => readPrivateFile(path), { message: 'A_GOOGLE_BROKER_PRIVATE_FILE_DENIED' });
  setAcl(root, false);
  assert.equal(readPrivateFile(path).toString(), 'synthetic-private-credential');
  console.log(JSON.stringify({ windowsPrivateFileEvidence: { actualOSACL: true, fileSharedDenied: true, parentSharedDenied: true, restoredPrivateReadable: true, credentialsSynthetic: true, actualServiceAccountNotTested: true } }));
});
