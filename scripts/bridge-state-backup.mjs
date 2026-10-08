import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {openSync,closeSync,fstatSync,lstatSync,readSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {hardenWindowsSecretFile} from '../packages/shared/src/product-runtime-secrets.js';

const names=['bridge-devices.jsonl','bridge-state-cache.jsonl','bridge-rate-limits.jsonl','bridge-request-nonces.jsonl',
  'bridge-event-cursors.jsonl','core-events.jsonl','core-orchestration.jsonl','executions.jsonl','evidence.jsonl',
  'memory-events.jsonl','memory-audit.jsonl','capability-journal.jsonl','capability-vault.jsonl','verification.jsonl'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function readStable(path){
  const initial=lstatSync(path,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink()||initial.size>4n*1024n*1024n)throw Error('BRIDGE_BACKUP_FILE_INVALID');
  const fd=openSync(path,'r');
  try{
    const before=fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.dev!==initial.dev||before.ino!==initial.ino||before.size>4n*1024n*1024n)throw Error('BRIDGE_BACKUP_FILE_CHANGED');
    // A writer may grow the journal after fstat. Never read an unbounded file.
    const buffer=Buffer.alloc(Number(before.size)+1);let offset=0;
    while(offset<buffer.length){const count=readSync(fd,buffer,offset,buffer.length-offset,null);if(!count)break;offset+=count;}
    const bytes=buffer.subarray(0,offset),after=fstatSync(fd,{bigint:true}),current=lstatSync(path,{bigint:true});
    if(current.isSymbolicLink()||[after,current].some(info=>info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size||info.mtimeNs!==before.mtimeNs||info.ctimeNs!==before.ctimeNs)
      ||BigInt(bytes.length)!==before.size)throw Error('BRIDGE_BACKUP_FILE_CHANGED');
    return bytes;
  }finally{closeSync(fd);}
}
function dpapi(bytes,mode){
  if(process.platform!=='win32')throw Error('BRIDGE_BACKUP_WINDOWS_DPAPI_REQUIRED');
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser;$out=[System.Security.Cryptography.ProtectedData]::${mode}($bytes,$null,$scope);[Console]::Write([Convert]::ToBase64String($out));`;
  return Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    input:bytes.toString('base64'),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:16*1024*1024,
    stdio:['pipe','pipe','pipe']}).trim(),'base64');
}
export function backupBridgeMigrationState({stateDir,backupRoot,protect=bytes=>dpapi(bytes,'Protect'),
  unprotect=bytes=>dpapi(bytes,'Unprotect'),harden=hardenWindowsSecretFile}={}){
  const source=resolve(stateDir);
  if(!lstatSync(source).isDirectory()||!samePath(realpathSync(source),source))throw Error('BRIDGE_BACKUP_ROOT_INVALID');
  const files=[];let total=0;
  for(const name of names){
    const path=join(source,name);let data;
    try{data=readStable(path);}catch(error){if(error.code==='ENOENT'&&!['bridge-devices.jsonl','bridge-state-cache.jsonl'].includes(name))continue;throw error;}
    total+=data.length;if(total>8*1024*1024)throw Error('BRIDGE_BACKUP_TOTAL_LIMIT');
    files.push({name,byteLength:data.length,sha256:digest(data),data:data.toString('base64')});
  }
  const packed=gzipSync(Buffer.from(JSON.stringify({version:'bridge-migration-state-v1',files})));
  const encrypted=protect(packed);
  // Verify the real ciphertext, not only the archive manifest or a source hash.
  if(digest(unprotect(encrypted))!==digest(packed))throw Error('BRIDGE_BACKUP_DECRYPT_VERIFY_FAILED');
  const directory=join(resolve(backupRoot),`bridge-gateway-${Date.now()}-${randomUUID()}`);
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(!samePath(realpathSync(directory),directory))throw Error('BRIDGE_BACKUP_DESTINATION_INVALID');
  const path=join(directory,'state.dpapi.json');
  const manifest=files.map(({name,byteLength,sha256})=>({name,byteLength,sha256}));
  const record={version:'bridge-migration-encrypted-backup-v1',provider:'windows-dpapi-current-user',
    createdAt:new Date().toISOString(),sourceRootSha256:digest(source),files:manifest,protectedPayload:encrypted.toString('base64')};
  writeFileSync(path,JSON.stringify(record),{flag:'wx',mode:0o600,flush:true});harden(path);
  const saved=JSON.parse(readStable(path).toString('utf8'));
  const recovered=JSON.parse(gunzipSync(unprotect(Buffer.from(saved.protectedPayload,'base64'))).toString('utf8'));
  if(recovered.version!=='bridge-migration-state-v1'||recovered.files.length!==files.length
    ||recovered.files.some((file,index)=>file.name!==files[index].name||digest(Buffer.from(file.data,'base64'))!==files[index].sha256)){
    throw Error('BRIDGE_BACKUP_STORED_VERIFY_FAILED');
  }
  if(files.some(file=>digest(readStable(join(source,file.name)))!==file.sha256))throw Error('BRIDGE_BACKUP_SOURCE_CHANGED');
  return {path,files:manifest,totalBytes:total,encrypted:true,decryptionVerified:true,sourceUnchanged:true,
    fullRuntimeRestoreVerified:false,credentialKeyFilesIncluded:false};
}
