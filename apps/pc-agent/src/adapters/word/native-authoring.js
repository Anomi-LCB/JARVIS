import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export async function createVerifiedWordDocument(requestPath,{timeoutMs=120000,signal,onNativeStart}={}){
 if(process.platform!=='win32')throw Error('word-windows-required');
 const native=fileURLToPath(new URL('./native-create.ps1',import.meta.url));
 const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const env={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
 try{await new Promise((accept,reject)=>{
  const child=execFile(executable,['-NoProfile','-NonInteractive','-STA','-File',native,'-RequestPath',requestPath,'-NativeParentProcessId',String(process.pid)],
   {env,windowsHide:true,timeout:timeoutMs,signal,maxBuffer:1024*1024},(error,stdout,stderr)=>{
    if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else accept();
   });
  if(onNativeStart)onNativeStart(child);
 });}catch(error){
  const request=JSON.parse((await readFile(requestPath,'utf8')).replace(/^\uFEFF/u,''));
  let ownership=null,stage=null;
  try{ownership=JSON.parse((await readFile(join(request.staging,'owned-process.json'),'utf8')).replace(/^\uFEFF/u,''));}catch{}
  try{stage=JSON.parse((await readFile(join(request.staging,'native-stage.json'),'utf8')).replace(/^\uFEFF/u,''))?.stage;}catch{}
  error.nativeRecovery={autoRetryAllowed:false,activationGapUnverified:ownership?.jobAssigned!==true,
   jobAssignmentObserved:ownership?.jobAssigned===true,parentWatchObserved:ownership?.parentWatchEnabled===true,
   stage:typeof stage==='string'&&/^[a-z-]{1,60}$/u.test(stage)?stage:null};
  throw error;
 }
 const request=JSON.parse((await readFile(requestPath,'utf8')).replace(/^\uFEFF/u,''));
 const nativeReport=JSON.parse((await readFile(join(request.staging,'native-report.json'),'utf8')).replace(/^\uFEFF/u,''));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(nativeReport.status!=='verified'||nativeReport.savedReopenedReadOnly!==true||nativeReport.jobAssigned!==true||nativeReport.parentWatchEnabled!==true
   ||nativeReport.sourceSha256!==hash(await readFile(join(request.staging,'document.docx')))
   ||nativeReport.pdfSha256!==hash(await readFile(join(request.staging,'document.pdf'))))throw Error('word-native-current-proof-invalid');
 return nativeReport;
}
