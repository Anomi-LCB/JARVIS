import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync, linkSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPrivateFile } from '../packages/core/src/personal-operations/private-file.js';
import { setFixturePrivateAcl } from './fixtures/windows-private-acl.mjs';
// Fixed fixture reference also includes the live-role probe in the isolated validation bundle.
export const linuxRoleFixture = new URL('./fixtures/private-file-roles.mjs', import.meta.url);
export const linuxCoreBrokerFixture = new URL('./fixtures/isolated-core-broker-audit.mjs', import.meta.url);
test('private file reader bounds reads and omits unsafe path or secret from failures',t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-private-file-')),path=join(root,'key');
  t.after(()=>{if(process.platform==='win32'){unlinkSync(join(root,'hard-link'));unlinkSync(path);rmdirSync(root);}else rmSync(root,{recursive:true,force:true});});
  writeFileSync(path,'synthetic-secret',{mode:0o600});
  if(process.platform==='win32'){setFixturePrivateAcl(root);setFixturePrivateAcl(path);}
  assert.equal(readPrivateFile(path).toString(),'synthetic-secret');
  assert.throws(()=>readPrivateFile(path,{maxBytes:3}),{message:'A_GOOGLE_BROKER_PRIVATE_FILE_DENIED'});
  assert.throws(()=>readPrivateFile(root),{message:'A_GOOGLE_BROKER_PRIVATE_FILE_DENIED'});
  linkSync(path,join(root,'hard-link'));assert.throws(()=>readPrivateFile(path),/PRIVATE_FILE_DENIED/u);
});
test('Linux refuses readable-to-others secrets, shared parents and symlinked keys',{skip:process.platform==='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-private-mode-')),path=join(root,'key');t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(path,'synthetic',{mode:0o644});assert.throws(()=>readPrivateFile(path),/PRIVATE_FILE_DENIED/u);
  chmodSync(path,0o600);chmodSync(root,0o755);assert.throws(()=>readPrivateFile(path),/PRIVATE_FILE_DENIED/u);
  chmodSync(root,0o700);symlinkSync(path,join(root,'symlink'));assert.throws(()=>readPrivateFile(join(root,'symlink')),/PRIVATE_FILE_DENIED/u);
  assert.equal(readPrivateFile(path).toString(),'synthetic');
});
