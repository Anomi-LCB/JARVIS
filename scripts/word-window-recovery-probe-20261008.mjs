import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {WindowsDesktopControlToolAdapter} from '../apps/pc-agent/src/windows-desktop-control.js';
const root=await mkdtemp(join(tmpdir(),'jarvis-word-window-')),ps='powershell.exe';
const host=spawn(ps,['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',resolve('scripts/fixtures/word-window-recovery.ps1'),'-Root',root,'-ParentPid',String(process.pid),'-GuardPath',resolve('apps/pc-agent/src/adapters/word/native-process-guard.cs')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let errorText='',owned,cases=[];host.stderr.on('data',x=>{errorText=(errorText+x).slice(-3000);});
async function stop(){if(host.exitCode!==null||host.signalCode!==null)return;await writeFile(join(root,'stop'),'STOP');await Promise.race([new Promise(r=>host.once('exit',r)),new Promise(r=>setTimeout(r,8000))]);if(host.exitCode===null&&host.signalCode===null){const ended=new Promise(r=>host.once('exit',r));host.kill();await ended;}}
try{
 const deadline=Date.now()+35000;
 while(Date.now()<deadline){try{owned=JSON.parse((await readFile(join(root,'ready.json'),'utf8')).replace(/^\uFEFF/,''));break;}catch{if(host.exitCode!==null||host.signalCode!==null)throw Error('OWNED_WORD_SETUP_FAILED');await new Promise(r=>setTimeout(r,100));}}
 if(!owned)throw Error('OWNED_WORD_SETUP_TIMEOUT');
 const adapter=new WindowsDesktopControlToolAdapter({allowedRoots:[root]});
 for(const mode of ['ambiguous','primary','secondary','primary-return']){
  const caption=mode==='primary'||mode==='primary-return'?owned.primaryTitle:owned.secondaryTitle;
  const target={processId:owned.wordPid,...(mode==='ambiguous'?{}:{titleContains:caption})};
  const result=await adapter.execute({target,operations:[{op:mode==='ambiguous'?'inspect':'focusWindow'}],verification:[{type:mode==='ambiguous'?'windowExists':'windowTitleContains',...(mode==='ambiguous'?{}:{expected:caption})}],timeoutMs:1000});
  cases.push({mode,...result});
 }
 await stop();
 const proc=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',"@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString()+':'+$_.StartTime.ToUniversalTime().Ticks.ToString() }) -join ','"],{windowsHide:true});
 const after=proc.stdout.trim().split(',').filter(Boolean);
 const assertions={saveFailureObserved:owned.saveFailureObserved,failedOutputAbsent:owned.failedOutputAbsent,primaryContentReopened:owned.primaryReopenedMatches,
  ambiguousWordWindowsRejected:cases[0].status==='failed'&&cases[0].error==='desktop-window-ambiguous',threeWindowTransitions:cases.slice(1).every(c=>c.status==='success'),
  ownedWordClosed:!after.includes(owned.wordPid+':'+owned.ownedStartTicks),preExistingWordPreserved:owned.baseline.every(p=>after.includes(p.pid+':'+p.ticks))};
 const report={observedAt:new Date().toISOString(),actualMicrosoftWord:true,scriptedOperations:true,liveModel:false,wordVersion:owned.wordVersion,jobAssigned:owned.jobAssigned,assertions,cases,status:Object.values(assertions).every(Boolean)?'passed':'failed'};
 await writeFile(process.argv[2]??'artifacts/word-window-recovery-20261008.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,assertions}));if(report.status!=='passed')process.exitCode=1;
}catch(e){let diagnostic=null;try{diagnostic=JSON.parse((await readFile(join(root,'setup-error.json'),'utf8')).replace(/^\uFEFF/,''));}catch{}console.log(JSON.stringify({status:'failed',code:e.message,hostErrorPresent:Boolean(errorText),diagnostic}));throw e;}
finally{await stop();if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-word-window-'))throw Error('CLEANUP_REJECTED');await rm(root,{recursive:true,force:true});}
