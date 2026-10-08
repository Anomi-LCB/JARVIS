import {realpath,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
async function boundedRead(handle,limit){
 const buffer=Buffer.alloc(limit+1);let length=0;
 while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,null);if(result.bytesRead===0)break;length+=result.bytesRead;}
 if(length>limit)throw new Error('UI_PACKAGE_FILE_TOO_LARGE');return buffer.subarray(0,length);
}

/** Integrity is against a local manifest, not a certificate/signature attestation. */
export async function createPackagedUiReader(packageDir){
 if(typeof packageDir!=='string'||!isAbsolute(packageDir))throw new Error('UI_PACKAGE_ABSOLUTE_PATH_REQUIRED');
 const root=resolve(packageDir),manifestPath=resolve(root,'package-manifest.json');
 const metadata=await lstat(manifestPath);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>1048576)throw new Error('UI_PACKAGE_MANIFEST_INVALID');
 const manifestHandle=await open(manifestPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 let manifest;try{manifest=JSON.parse((await boundedRead(manifestHandle,1048576)).toString('utf8'));}finally{await manifestHandle.close();}
 if(manifest.packageId!=='jarvis-pc-agent-windows-service'||!manifest.fileIntegrity)throw new Error('UI_PACKAGE_MANIFEST_INVALID');
 const inventory=new Map();
 for(const [name,value] of Object.entries(manifest.fileIntegrity)){
  if(!/^control-center-ui\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.(?:html|js|css)$/u.test(name)||name.split('/').some(part=>part==='..'))continue;
  if(!/^[a-f0-9]{64}$/u.test(value.sha256))throw new Error('UI_PACKAGE_MANIFEST_INVALID');
  inventory.set(name,value.sha256);
 }
 if(!inventory.has('control-center-ui/index.html'))throw new Error('UI_PACKAGE_ENTRY_MISSING');
 const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 return async pathname=>{
  if(typeof pathname!=='string'||pathname.includes('\\')||pathname.split('/').some(part=>part==='..')||/[\u0000-\u001f]/u.test(pathname))throw new Error('UI_PACKAGE_PATH_INVALID');
  const name=`control-center-ui/${pathname==='/'?'index.html':pathname.replace(/^\//u,'')}`,expected=inventory.get(name);
  if(!expected)throw new Error('UI_PACKAGE_NOT_LISTED');
  const path=resolve(root,name);if(!same(await realpath(path),path))throw new Error('UI_PACKAGE_LINK_DENIED');
  let handle;
  try{
   handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const before=await handle.stat();if(!before.isFile()||before.size>8388608)throw new Error('UI_PACKAGE_FILE_INVALID');
   const bytes=await boundedRead(handle,8388608);const after=await handle.stat();
   if(bytes.length>8388608||before.size!==after.size||before.mtimeMs!==after.mtimeMs||createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('UI_PACKAGE_INTEGRITY_FAILED');
   return bytes;
  }finally{await handle?.close();}
 };
}
