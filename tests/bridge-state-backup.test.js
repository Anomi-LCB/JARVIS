import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backupBridgeMigrationState} from '../scripts/bridge-state-backup.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'jarvis-backup-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'state');await mkdir(source);
  for(const name of ['bridge-devices.jsonl','bridge-state-cache.jsonl'])await writeFile(join(source,name),'synthetic-private-narrative');
  return {stateDir:source,backupRoot:join(root,'backups'),harden(){}};
}
test('backup stores ciphertext and checks decryption of the actual saved file without changing source',async t=>{
  const options=await fixture(t);const sealed=new Map();let n=0;
  const protect=bytes=>{const ciphertext=Buffer.from(`synthetic-ciphertext-${++n}`);sealed.set(ciphertext.toString(),Buffer.from(bytes));return ciphertext;};
  const unprotect=bytes=>sealed.get(bytes.toString());
  const result=backupBridgeMigrationState({...options,protect,unprotect});
  assert.equal((await readFile(result.path,'utf8')).includes('synthetic-private-narrative'),false);
  assert.equal(result.decryptionVerified,true);assert.equal(result.sourceUnchanged,true);
  assert.equal(result.fullRuntimeRestoreVerified,false);assert.equal(result.credentialKeyFilesIncluded,false);
  assert.equal(await readFile(join(options.stateDir,'bridge-devices.jsonl'),'utf8'),'synthetic-private-narrative');
});
test('a codec that cannot recover the original bytes prevents a backup success',async t=>{
  const options=await fixture(t);
  assert.throws(()=>backupBridgeMigrationState({...options,protect:()=>Buffer.from('cipher'),unprotect:()=>Buffer.from('wrong')}),/BRIDGE_BACKUP_DECRYPT_VERIFY_FAILED/);
});
test('source change during backup is rejected and never overwritten with the older copy',async t=>{
  const options=await fixture(t);
  const {writeFileSync}=await import('node:fs');
  assert.throws(()=>backupBridgeMigrationState({...options,protect:bytes=>{writeFileSync(join(options.stateDir,'bridge-devices.jsonl'),'changed');return bytes;},unprotect:bytes=>bytes}),/BRIDGE_BACKUP_SOURCE_CHANGED/);
  assert.equal(await readFile(join(options.stateDir,'bridge-devices.jsonl'),'utf8'),'changed');
});
