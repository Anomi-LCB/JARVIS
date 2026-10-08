import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
export async function createVerifiedPresentation(requestPath,{timeoutMs=120000,signal}={}){
 if(process.platform!=='win32')throw new Error('powerpoint-windows-required');
 const native=fileURLToPath(new URL('./native-create.ps1',import.meta.url));
 const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const env={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
 await run(executable,['-NoProfile','-NonInteractive','-File',native,'-RequestPath',requestPath,'-NativeParentProcessId',String(process.pid)],{env,signal,windowsHide:true,timeout:timeoutMs,maxBuffer:1024*1024});
 const verification=await run(process.env.JARVIS_PYTHON??'python',[fileURLToPath(new URL('./verify_presentation.py',import.meta.url)),requestPath],{encoding:'utf8',signal,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 const result=JSON.parse(verification.stdout.trim());
 if(result.status!=='verified')throw new Error('powerpoint-saved-content-unverified');
 const request=JSON.parse(await readFile(requestPath,'utf8'));
 const nativeReport=JSON.parse((await readFile(join(request.staging,'native-report.json'),'utf8')).replace(/^\uFEFF/u,''));
 return {verification:result,nativeReport};
}
