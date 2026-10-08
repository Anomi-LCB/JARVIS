import {readFile,writeFile,mkdtemp,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {expectedDocContentItems} from '../../pc-agent/src/pc-agent-runtime.js';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
export async function verifyHancomRenderingCurrent({executionResult,allowedRoots=[]}){
 let scratch;const snapshots=[];
 try{
  const roots=await Promise.all(allowedRoots.map(r=>realpath(resolve(r))));
  const read=async path=>{
   path=resolve(path);const actual=await realpath(path),info=await lstat(path);
   const inside=roots.some(root=>{const r=relative(root,actual);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);});
   if(!inside||actual!==path||!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('hancom-current-file-scope-invalid');
   const bytes=await readFile(path);snapshots.push({path,hash:sha(bytes)});return bytes;
  };
  const rendering=executionResult.nativeRendering;
  if(rendering?.status!=='passed'||rendering.actualRenderingExecuted!==true)throw Error('hancom-native-render-unverified');
  const source=await read(executionResult.targetPath);
  if(sha(source)!==executionResult.sha256)throw Error('hancom-source-changed');
  const directory=resolve(rendering.outputDirectory),manifest=JSON.parse((await read(join(directory,'manifest.json'))).toString('utf8'));
  const withStructure=manifest.schemaVersion==='jarvis-hancom-render-v2';
  if(!['jarvis-hancom-render-v1','jarvis-hancom-render-v2'].includes(manifest.schemaVersion)||manifest.status!=='passed'||manifest.renderer!=='Hancom COM'||!manifest.build||!manifest.version||manifest.sourceSha256!==sha(source)||manifest.actualRenderingExecuted!==true||manifest.processGuard?.jobAssigned!==true||manifest.processGuard?.parentWatchEnabled!==true||manifest.tableCount!==executionResult.document?.tableCount||!Number.isInteger(manifest.pageCount)||manifest.pageCount<1||manifest.pageCount>50||(withStructure&&manifest.tableStructureVerified!==true))throw Error('hancom-current-manifest-invalid');
  const names=['document.pdf',...Array.from({length:manifest.pageCount},(_,i)=>`page-${i+1}.png`),...(withStructure?['structure.hwpx']:[])];
  if(manifest.files?.length!==names.length||manifest.files.some((file,i)=>file.name!==names[i]))throw Error('hancom-current-file-sequence-invalid');
  scratch=await mkdtemp(join(tmpdir(),'jarvis-g-hancom-'));
  for(const file of manifest.files){const bytes=await read(join(directory,file.name));if(sha(bytes)!==file.sha256||bytes.length!==file.size)throw Error('hancom-current-artifact-hash-mismatch');await writeFile(join(scratch,file.name),bytes,{flag:'wx'});}
  const input=join(scratch,'input.json');await writeFile(input,JSON.stringify({pdfPath:join(scratch,'document.pdf'),expectedText:expectedDocContentItems(executionResult.document),verifyOnly:true}),{flag:'wx'});
  const {stdout}=await run(process.env.JARVIS_HWPX_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/hwpx/raster-pdf.py',import.meta.url)),input],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  const proof=JSON.parse(stdout);if(proof.pageCount!==manifest.pageCount||proof.requiredTextVerified!==true||proof.textBoundsVerified!==true)throw Error('hancom-current-content-invalid');
  if(withStructure){
   const structureInput=join(scratch,'structure-input.json');await writeFile(structureInput,JSON.stringify({outputPath:join(scratch,'structure.hwpx'),document:executionResult.document}),{flag:'wx'});
   const checked=await run(process.env.JARVIS_HWPX_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/hwpx/hwpx-content-verifier.py',import.meta.url)),structureInput],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});
   const structure=JSON.parse(checked.stdout);if(structure.tableStructureVerified!==true||structure.textVerified!==true||structure.tableCount!==manifest.tableCount)throw Error('hancom-current-structure-invalid');
  }
  for(const snapshot of snapshots)if(sha(await readFile(snapshot.path))!==snapshot.hash)throw Error('hancom-current-file-changed');
  return {passed:true,actualRenderingExecuted:true,pageCount:proof.pageCount,requiredTextVerified:true,textBoundsVerified:true,pagePixelsMatchPdf:true,tableStructureVerified:withStructure,visualQualityVerified:false,sourceSha256:sha(source)};
 }catch(error){
  let reason;try{reason=JSON.parse(error.stdout).reason;}catch{}
  reason??=/ValueError:\s*((?:hancom|hwpx)-[a-z-]+)/u.exec(String(error.stderr??''))?.[1];
  reason??=/^(?:hancom|hwpx)-[a-z-]+$/u.test(error.message)?error.message:'hancom-current-inspection-failed';
  return {passed:false,reason};
 }
 finally{if(scratch)await rm(scratch,{recursive:true,force:true});}
}
