import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
const due=Date.parse('2026-10-07T00:01:00.000Z'),iso=ms=>new Date(ms).toISOString();
for(const deadlineMode of [false,true,'tomorrow','duration'])for(const [boundary,offset] of (deadlineMode==='tomorrow'
 ?[['b-receipt',86400000+30_000],['b-receipt',86400000+60_001]]:deadlineMode
 ?[['prepared',30_000],['prepared',60_001],['b-receipt',30_000],['b-receipt',60_001],['file-effect',60_001],['completed-before-ack',60_001]]
 :[['prepared',60_000],['prepared',300_001],['b-receipt',60_000],['b-receipt',300_001],['file-effect',300_001],['completed-before-ack',300_001]])){
 test(`actual timed routine OS kill ${boundary} recovery offset ${offset} deadline ${deadlineMode}`,{timeout:30_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-timed-process-')),children=new Set();
  const configuration=JSON.stringify({createdAt:iso(due-60_000),dispatchAt:iso(due),resumeAt:iso(due+offset),deadline:deadlineMode});
  t.after(async()=>{
   for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
   assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-timed-process-'));rmSync(root,{recursive:true,force:true});
  });
  const next=child=>new Promise((done,reject)=>{
   const clean=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);};
   const message=value=>{clean();value.type==='error'?reject(new Error(JSON.stringify(value))):done(value);};
   const exit=code=>{clean();reject(new Error(`child exited ${code}`));};
   const timer=setTimeout(()=>{clean();reject(new Error('live child observation timeout'));},15_000);
   child.once('message',message);child.once('exit',exit);
  });
  const launch=async mode=>{
   const child=fork(new URL('./fixtures/routine-process-recovery-child.mjs',import.meta.url),[root,mode,boundary,configuration],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
   children.add(child);let errors='';child.stderr.on('data',b=>errors+=b);
   try{assert.equal((await next(child)).type,'ready');}catch(error){throw new Error(`${error.message}: ${errors}`);}
   return child;
  };
  const first=await launch(boundary),arrived=next(first);first.send('run');assert.equal((await arrived).boundary,boundary);
  assert.equal(existsSync(join(root,'workspace/result.txt')),boundary!=='prepared');
  const killed=once(first,'exit');assert.equal(first.kill('SIGKILL'),true);await killed;children.delete(first);
  const resumed=await launch('resume'),resultWaiting=next(resumed);resumed.send('run');const result=await resultWaiting;
  const deadlineOffset=deadlineMode==='tomorrow'?86400000+60_000:60_000;
  const expiredPrepared=boundary==='prepared'&&offset>(deadlineMode?deadlineOffset:300_000);
  const expiredReceipt=deadlineMode&&boundary==='b-receipt'&&offset>deadlineOffset;
  const blocked=boundary==='file-effect'||expiredPrepared||expiredReceipt;
  assert.equal(result.routine.status,blocked?'blocked':'completed',JSON.stringify(result));
  assert.equal(result.missionStatus,blocked?'PAUSED':'COMPLETED');assert.equal(result.recovered.recoveredDispatches,1);
  const calls=()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  const expectedCalls=expiredPrepared?0:1;
  assert.equal(calls().length,expectedCalls);
  if(!blocked){
   assert.equal(result.actualText,'실제 프로세스 종료 후 예약 결과');
   assert.equal(result.completion.scheduleTiming.dispatchTimingVerified,true);
   assert.equal(result.completion.scheduleTiming.completionDeadlineVerified,false);
   assert.equal(result.scheduleTemporalVerification.scheduledFor,iso(due));
   assert.equal(result.effect.state,'succeeded');assert.equal(result.growthEvents,1);assert.equal(result.workEntries,1);
   if(deadlineMode){assert.equal(result.completion.deadlineTiming.completionDeadlineVerified,true);assert.equal(result.completion.deadlineTiming.deadlineAt,iso(due+deadlineOffset));}
  }else if(boundary==='file-effect')assert.equal(result.effect.state,'uncertain');
  else if(expiredReceipt){assert.equal(result.stopReason,'completion-deadline-unverified');assert.equal(result.effect.state,'succeeded');assert.equal(result.actualText,'실제 프로세스 종료 후 예약 결과');}
  else {assert.equal(result.actualText,null);if(deadlineMode)assert.ok(result.lastError.reasons.some(r=>r.code==='goal-time-deadline-exceeded'));}
  const ended=once(resumed,'exit');await ended;children.delete(resumed);
  const again=await launch('resume'),againWaiting=next(again);again.send('run');const stable=await againWaiting;
  assert.equal(stable.recovered.recoveredDispatches,0);assert.equal(stable.missionId,result.missionId);assert.equal(stable.routine.status,result.routine.status);
  assert.equal(calls().length,expectedCalls);assert.deepEqual(stable.completion,result.completion);
  const finalExit=once(again,'exit');await finalExit;children.delete(again);
  t.diagnostic(JSON.stringify({actualOsKill:true,actualCoreEBG:true,boundary,offset,deadlineMode,oldPid:first.pid,resumedPid:resumed.pid,againPid:again.pid,
   adapterCalls:expectedCalls,status:result.missionStatus,routine:result.routine.status,completion:result.completion?.scheduleTiming??null,deadlineProof:result.completion?.deadlineTiming??null,stopReason:result.stopReason,sourceObjective:result.routine.missionRequest.objective}));
 });
}
