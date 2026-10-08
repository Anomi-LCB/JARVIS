import {readFile,writeFile,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyHwpxContentCurrent({executionResult,allowedRoots=[]}){
 let scratch;
 try{
  const path=resolve(executionResult.targetPath),actual=await realpath(path),info=await lstat(path);
  const roots=await Promise.all(allowedRoots.map(root=>realpath(resolve(root))));
  const inside=roots.some(root=>{const rel=relative(root,actual);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);});
  if(!inside||actual!==path||info.isSymbolicLink()||!info.isFile()||info.size>16*1024*1024)throw Error('hwpx-verification-scope-invalid');
  const bytes=await readFile(path),digest=sha(bytes);
  if(digest!==executionResult.sha256)throw Error('hwpx-current-hash-mismatch');
  scratch=await mkdtemp(join(tmpdir(),'jarvis-g-hwpx-'));
  const snapshot=join(scratch,'document.hwpx'),input=join(scratch,'input.json');
  await writeFile(snapshot,bytes,{flag:'wx'});
  await writeFile(input,JSON.stringify({outputPath:snapshot,document:executionResult.hwpxDocument}),{flag:'wx'});
  const script=fileURLToPath(new URL('../../pc-agent/src/adapters/hwpx/hwpx-content-verifier.py',import.meta.url));
  const {stdout}=await run(process.env.JARVIS_HWPX_PYTHON??'python',[script,input],{encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:1024*1024});
  const verified=JSON.parse(stdout);
  const after=await lstat(path);
  if(after.ino!==info.ino||after.dev!==info.dev||after.mtimeMs!==info.mtimeMs||after.size!==bytes.length||sha(await readFile(path))!==digest)throw Error('hwpx-current-file-changed');
  return {passed:verified.packageVerified===true&&verified.textVerified===true&&verified.tableStructureVerified===true,sha256:digest,...verified};
 }catch(error){return {passed:false,reason:String(error.message).slice(0,600),rendering:{status:'unverified',reason:'native-render-not-observed'}};}
 finally{if(scratch)await rm(scratch,{recursive:true,force:true});}
}
