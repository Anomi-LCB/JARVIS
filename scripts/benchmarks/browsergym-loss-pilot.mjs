import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {parseArgs} from 'node:util';
import {createBrowserGymClient} from './browsergym-client.mjs';
const {values:a}=parseArgs({options:Object.fromEntries(['python','miniwob','chrome','browsers','output'].map(k=>[k,{type:'string'}]))});
for(const key of ['python','miniwob','chrome','browsers','output'])if(!a[key])throw Error('REQUIRED:'+key);
const root=await mkdtemp(join(tmpdir(),'jarvis-browsergym-loss-')),stateFile=join(root,'worker-state.json'),checks=[];
const client=createBrowserGymClient({python:resolve(a.python),worker:resolve('tests/fixtures/browsergym-drop-reply.py'),miniwob:resolve(a.miniwob),chrome:resolve(a.chrome),stateFile,browsersPath:resolve(a.browsers)});
const checked=async(name,action)=>{await action();checks.push({name,passed:true});};
let error=null,oracle=null;
try{
 const obs=await client.call('reset',{task:'enter-text',seed:17});
 const text=/^Enter "(.+)" into the text field and press Submit[.]$/.exec(obs.goal)[1];
 const request={requestId:'lost_fill',episodeId:obs.episodeId,expectedRevision:0,action:{kind:'fill',bid:obs.elements.find(e=>e.role==='textbox').bid,text}};
 await checked('rpc reserved op override denied',()=>assert.rejects(client.call('observe',{op:'step'}),/RPC_INVALID/));
 const action=client.call('step',{request},{timeoutMs:50});
 const timeout=assert.rejects(action,/RESPONSE_UNCERTAIN/);
 await checked('concurrent second effect denied',()=>assert.rejects(client.call('step',{request}),/PENDING_OR_UNCERTAIN/));
 await checked('lost completed response becomes uncertain',()=>timeout);
 await checked('reset cannot discard unresolved effect',()=>assert.rejects(client.call('reset',{task:'click-test',seed:17}),/PENDING_OR_UNCERTAIN/));
 await checked('wrong request cannot reconcile',()=>assert.rejects(client.reconcileStep({...request,requestId:'other'}),/BINDING_INVALID/));
 // This read-only RPC queues behind the actual browser operation and observes its final state.
 const after=await client.call('observe');assert.equal(after.revision,1);
 const original=await readFile(stateFile,'utf8'),tampered=JSON.parse(original);tampered.public.revision=99;
 await writeFile(stateFile,JSON.stringify(tampered));
 await checked('tampered local snapshot cannot unlock effects',()=>assert.rejects(client.reconcileStep(request),/SNAPSHOT_INVALID/));
 await checked('failed reconciliation keeps effect blocked',()=>assert.rejects(client.call('step',{request}),/PENDING_OR_UNCERTAIN/));
 await writeFile(stateFile,original);
 await checked('exact provider receipt recovers without step resend',async()=>{const result=await client.reconcileStep(request);assert.equal(result.status,'matched');assert.equal(result.receipt.postState.revision,1);});
 await checked('observation confirms exactly one fill',async()=>{const actual=await client.call('observe');assert.equal(actual.revision,1);assert.equal(actual.elements.find(e=>e.role==='textbox').value,text);});
 oracle=await client.call('step',{request:{requestId:'submit',episodeId:obs.episodeId,expectedRevision:1,action:{kind:'click',bid:after.elements.find(e=>e.role==='button'&&e.name==='Submit').bid}}});
 await checked('continuation completes official task',async()=>{assert.equal(oracle.reward,1);assert.equal(oracle.terminated,true);assert.equal(oracle.truncated,false);assert.equal(oracle.postState.revision,2);});
 const fresh=await client.call('reset',{task:'click-test',seed:43});
 const rejected={requestId:'invalid_revision',episodeId:fresh.episodeId,expectedRevision:99,action:{kind:'noop'}};
 await checked('provider rejection retained as uncertain',()=>assert.rejects(client.call('step',{request:rejected}),/STATE_REVISION_CHANGED/));
 await checked('no receipt remains unresolved, not success',async()=>{assert.equal((await client.reconcileStep(rejected)).status,'unresolved');});
 await checked('missing receipt cannot unlock reset or retry',async()=>{await assert.rejects(client.call('reset',{task:'click-test',seed:17}),/PENDING_OR_UNCERTAIN/);await assert.rejects(client.call('step',{request:rejected}),/PENDING_OR_UNCERTAIN/);assert.equal((await client.call('observe')).revision,0);});
}catch(e){error=e.stack;}finally{
 await client.close();
 if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('jarvis-browsergym-loss-'))throw Error('CLEANUP_BOUNDARY');
 await rm(root,{recursive:true,force:true});
}
const report={version:'browsergym-real-response-loss-pilot-v1',observedAt:new Date().toISOString(),checks,error,oracle:oracle?{reward:oracle.reward,terminated:oracle.terminated,truncated:oracle.truncated,revision:oracle.postState.revision}:null,actualModelInvoked:false,actualCost:null,limitation:'Real isolated BrowserGym transport failure controls; no Core crash recovery, external account effects or autonomous model performance.'};
await writeFile(a.output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({checks:checks.length,error}));if(error||checks.length!==13)process.exitCode=1;
