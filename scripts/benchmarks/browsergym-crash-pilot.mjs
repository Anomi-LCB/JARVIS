import assert from 'node:assert/strict';
import {fork,execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,dirname,basename} from 'node:path';
import {RemoteOperationStore} from '../../apps/pc-agent/src/remote-operation-store.js';
import {createBrowserGymClient} from './browsergym-client.mjs';
import {createBrowserGymEffectJournal,inspectBrowserGymEffect} from './browsergym-effect-journal.mjs';
import {digest} from './browsergym-capability.mjs';
const {values:a}=parseArgs({options:Object.fromEntries(['python','miniwob','chrome','browsers','output'].map(k=>[k,{type:'string'}]))});
for(const k of ['python','miniwob','chrome','browsers','output'])if(!a[k])throw Error('REQUIRED:'+k);
const root=await mkdtemp(join(tmpdir(),'jarvis-bg-crash-')),path=join(root,'effects.sqlite'),keyPath=join(root,'key'),key=randomBytes(32),checks=[];
const client=createBrowserGymClient({python:resolve(a.python),worker:resolve('scripts/benchmarks/browsergym-worker.py'),miniwob:resolve(a.miniwob),chrome:resolve(a.chrome),stateFile:join(root,'state.json'),browsersPath:resolve(a.browsers)});
let store,error=null,childPid=null,providerActions=0,providerReads=0,inspection=null,oracle=null;
const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
try{
 await writeFile(keyPath,key,{flag:'wx',mode:0o600});
 const obs=await client.call('reset',{task:'enter-text',seed:17}),text=/^Enter "(.+)" into the text field and press Submit[.]$/.exec(obs.goal)[1];
 const request={requestId:'crashed_fill',episodeId:obs.episodeId,expectedRevision:0,action:{kind:'fill',bid:obs.elements.find(e=>e.role==='textbox').bid,text}},taskId='crashed_task',authorizationHash=digest(['isolated-crash-campaign',obs.episodeId]);
 const configPath=join(root,'child.json');await writeFile(configPath,JSON.stringify({path,keyPath,request,taskId,authorizationHash}),{flag:'wx'});
 const childEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k)));
 const child=fork(resolve('tests/fixtures/browsergym-crash-before-archive.mjs'),[configPath],{windowsHide:true,env:childEnv,stdio:['ignore','ignore','pipe','ipc']});childPid=child.pid;let childError=null;
 child.stderr.resume();
 child.on('message',message=>{
  if(digest(message.request)!==digest(request)){childError='UNBOUND_CHILD_REQUEST';child.send({error:childError});return;}
  providerActions++;client.call('step',{request}).then(receipt=>child.send({receipt})).catch(e=>{childError=e.message;child.send({error:childError});});
 });
 const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHILD_CRASH_TIMEOUT')),30000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 await check('actual writer PID abruptly exited before archive',async()=>{assert.equal(exit,17);assert.equal(childError,null);assert.throws(()=>process.kill(childPid,0),e=>e.code==='ESRCH');});
 store=new RemoteOperationStore({path});
 await check('reopen converts in-flight to uncertain without receipt',async()=>{assert.equal(store.row('bg_crashed_fill').state,'uncertain');assert.equal(store.row('bg_crashed_fill').receipt_json,null);});
 await check('provider applied exactly one fill despite missing B receipt',async()=>{const actual=await client.call('observe');assert.equal(actual.revision,1);assert.equal(actual.elements.find(e=>e.role==='textbox').value,text);assert.equal(providerActions,1);});
 let allowed=false;
 const journal=createBrowserGymEffectJournal({store,key,authorize:()=>allowed,runStep:async r=>{providerActions++;return client.call('step',{request:r});},readProviderReceipt:async r=>{providerReads++;return client.lookupStepReceipt(r);}});
 const context={taskId,authorizationHash,assertAccess:()=>{}};
 await check('revoked recovery cannot query provider',async()=>{await assert.rejects(journal.reconcile(request,context),/REVOKED/);assert.equal(providerReads,0);});allowed=true;
 await check('changed request cannot query provider',async()=>{await assert.rejects(journal.reconcile({...request,action:{kind:'noop'}},context),/BINDING_MISMATCH/);assert.equal(providerReads,0);});
 await check('ordinary execute cannot redispatch uncertain effect',async()=>{await assert.rejects(journal.execute(request,context),/EXISTING_EFFECT/);assert.equal(providerActions,1);});
 await check('read-only provider reconciliation archives original effect',async()=>{const r=await journal.reconcile(request,context);assert.equal(r.status,'historical-matched');assert.equal(r.currentStateVerified,false);assert.equal(r.executionAuthority,false);assert.equal(providerReads,1);assert.equal(providerActions,1);});
 await check('reconciled receipt is authenticated historical proof only',async()=>{const r=inspectBrowserGymEffect({path,key,request,...context,authorize:()=>true});assert.equal(r.status,'historical-matched');assert.equal(r.wholeMissionCompleted,false);assert.equal(store.row('bg_crashed_fill').state,'succeeded');});
 await check('completed operation still cannot redispatch',async()=>{await assert.rejects(journal.execute(request,context),/EXISTING_EFFECT/);assert.equal(providerActions,1);});
 const next={requestId:'submit_after_recovery',episodeId:obs.episodeId,expectedRevision:1,action:{kind:'click',bid:obs.elements.find(e=>e.role==='button'&&e.name==='Submit').bid}};
 oracle=await journal.execute(next,{...context,taskId:'next_task'});
 await check('explicit next operation completes actual official task',async()=>{assert.equal(oracle.reward,1);assert.equal(oracle.terminated,true);assert.equal(oracle.truncated,false);assert.equal(oracle.postState.revision,2);assert.equal(providerActions,2);});
 await client.close();store.close();store=null;
 const indexPath=join(root,'index.json');await writeFile(indexPath,JSON.stringify([{taskId,request,authorizationHash},{taskId:'next_task',request:next,authorizationHash}]),{flag:'wx'});
 const result=await promisify(execFile)(process.execPath,[resolve('scripts/benchmarks/browsergym-history-inspect.mjs'),path,keyPath,indexPath],{windowsHide:true,timeout:10000});inspection=JSON.parse(result.stdout);
 await check('third PID recovers both histories after browser shutdown',async()=>{assert.notEqual(inspection.pid,process.pid);assert.notEqual(inspection.pid,childPid);assert.equal(inspection.results.length,2);assert.ok(inspection.results.every(r=>r.status==='historical-matched'&&!r.executionAuthority&&!r.currentStateVerified));});
}catch(e){error=e.stack;}finally{
 await client.close();store?.close();
 if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('jarvis-bg-crash-'))throw Error('CLEANUP_BOUNDARY');
 await rm(root,{recursive:true,force:true});
}
await writeFile(a.output,JSON.stringify({version:'browsergym-writer-crash-pilot-v1',observedAt:new Date().toISOString(),checks,error,childPid,providerActions,providerReads,inspection,oracle:oracle?{reward:oracle.reward,terminated:oracle.terminated,truncated:oracle.truncated}:null,actualModelInvoked:false,actualCost:null,limitation:'Abrupt research B-journal writer exit with live provider worker. Not whole-Core/OS/power-loss recovery or Mission G resumption.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({checks:checks.length,error,providerActions,providerReads}));if(error||checks.length!==11)process.exitCode=1;
