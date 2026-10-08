import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
const exec=promisify(execFile),nativePS=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const psEnv={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules')};
async function excelSnapshot(){const r=await exec(nativePS,['-NoProfile','-NonInteractive','-Command',"@(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString()+':'+$_.StartTime.ToUniversalTime().Ticks.ToString() }) -join ','"],{env:psEnv,windowsHide:true});return r.stdout.trim().split(',').filter(Boolean);}
for(const crashTarget of ['node-parent','native-host','cancel'])test(`${crashTarget} death after job assignment terminates only the owned native processes`,
 {skip:process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const before=await excelSnapshot(),root=await mkdtemp(join(tmpdir(),'jarvis-native-crash-'));let child,receiptDirectory;
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
  await rm(root,{recursive:true,force:true});
  if(receiptDirectory){const scratch=dirname(receiptDirectory),rel=relative(resolve(tmpdir()),scratch);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('jarvis-excel-pdf-'));await rm(scratch,{recursive:true,force:true});}
 });
 const inputPath=join(root,'source.xlsx'),outputPath=join(root,'output.pdf');
 await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20]]});
 const original=await readFile(inputPath);let hostPid,childOutput='';
 child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/native-parent-crash.mjs',import.meta.url)),inputPath,outputPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',chunk=>{childOutput+=chunk;});
 const event=await new Promise((accept,reject)=>{let stdout='',stderr='';const timer=setTimeout(()=>reject(Error('native host not started:'+stderr)),15000);
  child.stdout.on('data',data=>{stdout+=data;for(const line of stdout.split('\n'))try{const item=JSON.parse(line);if(item.receiptDirectory){clearTimeout(timer);accept(item);return;}}catch{}});
  child.stderr.on('data',d=>{stderr+=d;});child.once('exit',code=>{clearTimeout(timer);reject(Error('parent exited before ownership:'+code));});
 });
 receiptDirectory=event.receiptDirectory;hostPid=event.nativeHostPid;
 let receipt;const until=Date.now()+15000;
 while(Date.now()<until){try{receipt=JSON.parse((await readFile(join(receiptDirectory,'owned-process.json'),'utf8')).replace(/^\uFEFF/u,''));break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.ok(receipt,'actual ownership receipt missing');assert.equal(receipt.parentPid,child.pid);assert.equal(receipt.jobAssigned,true);assert.equal(receipt.parentWatchEnabled,true);
 assert.match(receipt.startTicks,/^\d+$/);assert.ok(!before.includes(receipt.pid+':'+receipt.startTicks));
 const exited=once(child,'exit');if(crashTarget==='node-parent')child.kill('SIGKILL');else{child.stdin.write(crashTarget==='cancel'?'cancel':'kill-native');child.stdin.end();}await exited;
 if(crashTarget==='cancel'){
  const diagnostic=childOutput.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(item=>item.nativeError);
  assert.equal(diagnostic?.nativeError,'EXCEL_PDF_CANCELLED');assert.equal(diagnostic.nativeRecovery.autoRetryAllowed,false);assert.equal(diagnostic.nativeRecovery.activationGapUnverified,false);
 }
 let after;for(let attempt=0;attempt<12;attempt++){after=await excelSnapshot();if(!after.includes(receipt.pid+':'+receipt.startTicks))break;await new Promise(r=>setTimeout(r,250));}
 assert.ok(!after.includes(receipt.pid+':'+receipt.startTicks),'owned Excel survived parent death');
 for(const identity of before)assert.ok(after.includes(identity),'pre-existing Excel changed');
 const host=await exec(nativePS,['-NoProfile','-NonInteractive','-Command',`if(Get-Process -Id ${Number(hostPid)} -ErrorAction SilentlyContinue){'running'}else{'gone'}`],{env:psEnv,windowsHide:true});assert.equal(host.stdout.trim(),'gone');
 assert.deepEqual(await readFile(inputPath),original);await assert.rejects(stat(outputPath),{code:'ENOENT'});
 console.log(JSON.stringify({nativeParentDeath:{crashTarget,actualExcelOwned:receipt.pid,jobAssigned:true,parentWatchEnabled:true,ownedExcelGone:true,nativeHostGone:true,preExistingExcelPreserved:true,originalUnchanged:true,pdfNotPublished:true}}));
});
