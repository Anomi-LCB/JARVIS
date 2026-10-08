import {open,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {validateMacroPublicationResult,macroPublicationDigest} from '../../../packages/shared/src/macro-publication-contract.js';
export async function verifyMacroPublicationCurrent({executionResult,registeredPath}) {
  let fd;
  try {
    const prepared=executionResult?.macroPublication;
    validateMacroPublicationResult(prepared,executionResult);
    if(typeof registeredPath!=='string'||resolve(registeredPath)!==prepared.path)throw Error('MACRO_REGISTERED_STORE_REQUIRED');
    const physical=async()=>{const path=resolve(await realpath(registeredPath));return process.platform==='win32'?path.toLowerCase():path;};
    if(await physical()!==prepared.physicalPath)throw Error('MACRO_CURRENT_STORE_CHANGED');
    const before=await lstat(registeredPath);
    if(!before.isFile()||before.isSymbolicLink()||before.size>2*1024*1024)throw Error('MACRO_CURRENT_STORE_UNSAFE');
    fd=await open(registeredPath,'r');const opened=await fd.stat();
    if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('MACRO_CURRENT_STORE_CHANGED');
    const bytes=Buffer.alloc(before.size),read=await fd.read(bytes,0,bytes.length,0),extra=await fd.read(Buffer.alloc(1),0,1,bytes.length);
    const after=await fd.stat(),pathAfter=await lstat(registeredPath);
    if(await physical()!==prepared.physicalPath||read.bytesRead!==bytes.length||extra.bytesRead!==0||after.size!==before.size||after.mtimeMs!==before.mtimeMs
      ||pathAfter.dev!==before.dev||pathAfter.ino!==before.ino||pathAfter.mtimeMs!==before.mtimeMs
      ||createHash('sha256').update(bytes).digest('hex')!==prepared.expectedSha256||bytes.length!==prepared.expectedSize)throw Error('MACRO_CURRENT_STORE_CHANGED');
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!Object.hasOwn(parsed,prepared.key)||macroPublicationDigest(parsed[prepared.key])!==macroPublicationDigest(prepared.record))throw Error('MACRO_CURRENT_RECORD_CHANGED');
    return {passed:true,path:prepared.path,sha256:prepared.expectedSha256,size:bytes.length};
  }catch(error){return {passed:false,reason:error.code??error.message};}
  finally{await fd?.close();}
}
