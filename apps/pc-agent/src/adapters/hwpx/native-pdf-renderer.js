import {execFile,spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {readFileSync,lstatSync,renameSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {hwpPathApprovalWatcherScript} from '../../pc-agent-runtime.js';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
const inside=(root,path)=>{const r=relative(root,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
/** Fixed native renderer for the host's generated HWP/HWPX artifacts. No selected executable or script. */
export class NativeHancomPdfRenderer{
 constructor({allowedRoots=[],timeoutMs=30000}={}){this.allowedRoots=allowedRoots;this.timeoutMs=timeoutMs;}
 async render({inputPath,outputDirectory,expectedSha256,expectedText,expectedTableCount,expectedDocument,signal,beforePublish}){
  if(process.platform!=='win32')throw failure('HANCOM_RENDER_WINDOWS_REQUIRED');
  if(signal?.aborted)throw failure('HANCOM_RENDER_CANCELLED');
  if(!/^[a-f0-9]{64}$/u.test(expectedSha256??'')||!Array.isArray(expectedText)||expectedText.length>200||expectedText.some(x=>typeof x!=='string'||x.length>5000)||!Number.isInteger(expectedTableCount)||expectedTableCount<0||expectedTableCount>20)throw failure('HANCOM_RENDER_REQUIREMENTS_INVALID');
  if(!expectedDocument||!Array.isArray(expectedDocument.blocks)||expectedDocument.tableCount!==expectedTableCount)throw failure('HANCOM_RENDER_DOCUMENT_REQUIRED');
  const source=resolve(inputPath),destination=resolve(outputDirectory),roots=await Promise.all(this.allowedRoots.map(p=>realpath(resolve(p))));
  const sourceReal=await realpath(source),parent=await realpath(dirname(destination)),info=await lstat(source);
  if(sourceReal!==source||parent!==dirname(destination)||!roots.some(r=>inside(r,sourceReal))||!roots.some(r=>inside(r,destination))||!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024||!['.hwp','.hwpx'].includes(extname(source).toLowerCase()))throw failure('HANCOM_RENDER_SCOPE_INVALID');
  try{await lstat(destination);throw failure('HANCOM_RENDER_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  const bytes=await readFile(source);if(sha(bytes)!==expectedSha256)throw failure('HANCOM_RENDER_SOURCE_CHANGED');
  const scratch=await mkdtemp(join(parent,'.jarvis-hancom-render-')),watchers=[];
  const input=join(scratch,'input'+extname(source).toLowerCase()),pdf=join(scratch,'document.pdf'),owner=join(scratch,'owner.json'),receipt=join(scratch,'native.json'),job=join(scratch,'job.json'),watcher=join(scratch,'watcher.ps1');
  const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const env={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
  try{
   await writeFile(input,bytes,{flag:'wx'});
   await writeFile(job,JSON.stringify({inputPath:input,pdfPath:pdf,structurePath:join(scratch,'structure.hwpx'),ownerPath:owner,receiptPath:receipt,sourceSha256:expectedSha256,expectedText,expectedTableCount}),{flag:'wx'});
   await writeFile(watcher,'\uFEFF'+hwpPathApprovalWatcherScript(),{flag:'wx'});
   for(const [index,path] of [input,pdf,join(scratch,'structure.hwpx')].entries())watchers.push(spawn(executable,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',watcher,'-OwnerPath',owner,'-ExpectedOutputPath',path,'-ResultPath',join(scratch,`watcher-${index}.json`),'-TimeoutMs',String(this.timeoutMs)],{windowsHide:true,stdio:'ignore',env}));
   watchers.push(spawn(executable,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./inspect-owned-dialog.ps1',import.meta.url)),'-OwnerPath',owner,'-OutputPath',join(scratch,'dialog-diagnostic.json')],{windowsHide:true,stdio:'ignore',env}));
   await run(executable,['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./native-pdf.ps1',import.meta.url)),'-JobPath',job,'-NativeParentProcessId',String(process.pid)],{windowsHide:false,env,timeout:this.timeoutMs,signal,maxBuffer:65536});
   const native=JSON.parse((await readFile(receipt,'utf8')).replace(/^\uFEFF/u,''));
   if(sha(await readFile(input))!==expectedSha256)throw failure('HANCOM_RENDER_SNAPSHOT_CHANGED');
   if(native.schemaVersion!=='jarvis-hancom-render-v2'||native.status!=='rendered'||native.sourceSha256!==expectedSha256||native.renderer!=='Hancom COM'||!native.build||!native.version||native.opened!==true||native.saved!==true||native.structureExported!==true||native.tableCount!==expectedTableCount||native.jobAssigned!==true||native.parentWatchEnabled!==true||native.parentPid!==process.pid)throw failure('HANCOM_RENDER_RECEIPT_INVALID');
   const structureInput=join(scratch,'structure-input.json');await writeFile(structureInput,JSON.stringify({outputPath:join(scratch,'structure.hwpx'),document:expectedDocument}),{flag:'wx'});
   const structureRun=await run(process.env.JARVIS_HWPX_PYTHON??'python',[fileURLToPath(new URL('./hwpx-content-verifier.py',import.meta.url)),structureInput],{windowsHide:true,timeout:20000,signal,maxBuffer:1024*1024});
   const structureProof=JSON.parse(structureRun.stdout),structureBytes=await readFile(join(scratch,'structure.hwpx'));
   if(structureProof.tableStructureVerified!==true||structureProof.textVerified!==true||structureProof.tableCount!==expectedTableCount)throw failure('HANCOM_RENDER_STRUCTURE_INVALID');
   const {stdout}=await run(process.env.JARVIS_HWPX_PYTHON??'python',[fileURLToPath(new URL('./raster-pdf.py',import.meta.url)),job],{windowsHide:true,timeout:20000,signal,maxBuffer:1024*1024});
   const raster=JSON.parse(stdout),pdfBytes=await readFile(pdf);
   if(raster.pdfSha256!==sha(pdfBytes)||raster.requiredTextVerified!==true||raster.textBoundsVerified!==true||raster.pages.length!==raster.pageCount)throw failure('HANCOM_RENDER_RASTER_INVALID');
   const files=[{name:'document.pdf',sha256:raster.pdfSha256,size:pdfBytes.length},...raster.pages,{name:'structure.hwpx',sha256:sha(structureBytes),size:structureBytes.length}];
   for(const [index,page] of raster.pages.entries()){
    if(page.page!==index+1||page.name!==`page-${index+1}.png`)throw failure('HANCOM_RENDER_PAGE_SEQUENCE_INVALID');
    const file=await readFile(join(scratch,page.name));if(sha(file)!==page.sha256||file.length!==page.size)throw failure('HANCOM_RENDER_PAGE_HASH_INVALID');
   }
   if(sha(await readFile(source))!==expectedSha256||signal?.aborted)throw failure('HANCOM_RENDER_SOURCE_CHANGED_OR_CANCELLED');
   await beforePublish?.();
   const manifest={schemaVersion:'jarvis-hancom-render-v2',status:'passed',actualRenderingExecuted:true,sourceSha256:expectedSha256,sourceUnchanged:true,renderer:native.renderer,build:native.build,version:native.version,tableCount:native.tableCount,pageCount:raster.pageCount,requiredTextVerified:true,textBoundsVerified:true,tableStructureVerified:true,visualQualityVerified:false,processGuard:{jobAssigned:true,parentWatchEnabled:true,ownedProcessId:native.processId},files};
   await writeFile(join(scratch,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
   for(const child of watchers)child.kill();
   for(const name of ['job.json','owner.json','watcher.ps1','native.json','structure-input.json','input'+extname(source).toLowerCase(),'watcher-0.json','watcher-1.json','watcher-2.json','dialog-diagnostic.json'])await rm(join(scratch,name),{force:true});
   await publishHancomRenderDirectory({scratch,destination,source,expectedSha256,signal,beforePublish});
   return {...manifest,outputDirectory:destination,manifestPath:join(destination,'manifest.json'),pdfPath:join(destination,'document.pdf')};
  }catch(error){
   try{error.nativeDiagnostic=JSON.parse((await readFile(join(scratch,'dialog-diagnostic.json'),'utf8')).replace(/^\uFEFF/u,''));}catch{}
   error.nativePhases=String(error.stdout??'').match(/HANCOM_RENDER_PHASE=[a-z-]+/gu)??[];
   if(error.name==='AbortError')throw Object.assign(failure('HANCOM_RENDER_CANCELLED'),{nativeDiagnostic:error.nativeDiagnostic,nativePhases:error.nativePhases});throw error;
  }
  finally{for(const child of watchers)child.kill();await rm(scratch,{recursive:true,force:true});}
 }
}

/** Recheck after asynchronous manifest creation and diagnostic cleanup. */
export async function publishHancomRenderDirectory({scratch,destination,source,expectedSha256,signal,beforePublish}){
 if(signal?.aborted)throw failure('HANCOM_RENDER_CANCELLED');
 await beforePublish?.();
 if(signal?.aborted)throw failure('HANCOM_RENDER_CANCELLED');
 if(sha(readFileSync(source))!==expectedSha256)throw failure('HANCOM_RENDER_SOURCE_CHANGED');
 try{lstatSync(destination);throw failure('HANCOM_RENDER_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
 renameSync(scratch,destination);
}
