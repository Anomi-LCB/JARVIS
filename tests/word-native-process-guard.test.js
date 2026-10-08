import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),ps=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const env={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules')};
async function snapshot(){const result=await run(ps,['-NoProfile','-NonInteractive','-Command',"@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString()+':'+$_.StartTime.ToUniversalTime().Ticks.ToString() }) -join ','"],{env,windowsHide:true});return result.stdout.trim().split(',').filter(Boolean);}
for(const mode of ['node-parent','native-host','cancel'])test(`owned Word cleanup on ${mode}`,{skip:process.env.JARVIS_NATIVE_WORD_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const before=await snapshot(),root=await mkdtemp(join(tmpdir(),'jarvis-word-crash-'));let child;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}await rm(root,{recursive:true,force:true});});
 const request=join(root,'request.json');
 await writeFile(request,JSON.stringify({staging:root,document:{title:'중단 복구 시험',blocks:[{type:'table',columns:['번호','값'],rows:Array.from({length:900},(_,index)=>[String(index),'원본 보존'])}]},expectedContentItems:['중단 복구 시험']}));
 child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/word-native-parent.mjs',import.meta.url)),request],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
 let receipt;const deadline=Date.now()+20000;
 while(Date.now()<deadline){try{receipt=JSON.parse((await readFile(join(root,'owned-process.json'),'utf8')).replace(/^\uFEFF/u,''));break;}catch{if(child.exitCode!==null)throw Error('Word parent exited before ownership:'+stdout+stderr);await new Promise(r=>setTimeout(r,50));}}
 assert.ok(receipt,'actual ownership missing:'+stdout+stderr);assert.equal(receipt.jobAssigned,true);assert.equal(receipt.parentWatchEnabled,true);assert.equal(receipt.parentPid,child.pid);
 assert.ok(!before.includes(receipt.pid+':'+receipt.startTicks));
 const ended=once(child,'exit');if(mode==='node-parent')child.kill('SIGKILL');else{child.stdin.write(mode==='cancel'?'cancel':'kill-native');child.stdin.end();}await ended;
 if(mode!=='node-parent'){
  const diagnostic=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(item=>item.nativeRecovery);
  assert.equal(diagnostic?.nativeRecovery.autoRetryAllowed,false);assert.equal(diagnostic.nativeRecovery.jobAssignmentObserved,true);assert.equal(diagnostic.nativeRecovery.activationGapUnverified,false);
 }
 let after;for(let attempt=0;attempt<20;attempt++){after=await snapshot();if(!after.includes(receipt.pid+':'+receipt.startTicks))break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(!after.includes(receipt.pid+':'+receipt.startTicks),'owned Word survived');for(const identity of before)assert.ok(after.includes(identity),'existing Word changed');
 const status=await run(ps,['-NoProfile','-NonInteractive','-Command',`if(Get-Process -Id ${Number(receipt.hostPid)} -ErrorAction SilentlyContinue){'running'}else{'gone'}`],{env,windowsHide:true});assert.equal(status.stdout.trim(),'gone');
 console.log(JSON.stringify({wordCrash:{mode,ownedPid:receipt.pid,ownedWordGone:true,nativeHostGone:true,preExistingWordPreserved:true,jobAssigned:true}}));
});
