import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserGymCapability,normalizeBenchmarkAction,toolName} from '../scripts/benchmarks/browsergym-capability.mjs';
const request=()=>({requestId:'one',episodeId:'11111111-1111-1111-1111-111111111111',expectedRevision:0,action:{kind:'click',bid:'13'}});
for(const [label,alter] of [
 ['script action',r=>r.action={kind:'evaluate',code:'process.exit()'}],
 ['bid injection',r=>r.action.bid="13');fetch('https://example.test')"],
 ['foreign target',r=>r.url='https://example.test'],
 ['stale revision type',r=>r.expectedRevision='0'],
 ['oversized fill',r=>r.action={kind:'fill',bid:'13',text:'a'.repeat(1025)}],
 ['raw provenance accessor',r=>Object.defineProperty(r,'rawText',{get:()=>assert.fail('accessor executed')})],
 ['accessor alongside provenance',r=>{r.rawText='공개';Object.defineProperty(r,'action',{enumerable:true,get:()=>assert.fail('accessor executed')});}]
])test('typed boundary rejects '+label,()=>{const r=request();alter(r);assert.throws(()=>normalizeBenchmarkAction(r));});
test('Core provenance is retained outside action and cannot widen action fields',()=>{
 assert.deepEqual(normalizeBenchmarkAction({...request(),rawText:'공개 시험'}),request());
 assert.throws(()=>normalizeBenchmarkAction({...request(),rawText:'공개 시험',command:'anything'}));
});
for(const scenario of ['valid','revoked-before','revoked-after','missing-fence','wrong-task','wrong-receipt','stale-state','forged-public'])test('isolated effect and current snapshot: '+scenario,async()=>{
 let allowed=true,calls=0;const r=request();const receipt={version:'browsergym-action-receipt-v1',request:r,postState:{episodeId:r.episodeId,revision:1},reward:1,terminated:true,truncated:false};
 const state={version:'browsergym-worker-state-v1',receipt,public:receipt.postState};
 const task={status:'EXECUTING',plan:{action:{toolName,arguments:{...r,rawText:'공개 시험'}}}};
 const definition=createBrowserGymCapability({authorize:()=>allowed,readTrustedTask:()=>task,readState:()=>state,runStep:async()=>{calls++;if(scenario==='revoked-after')allowed=false;return receipt;}});
 const adapter=definition.createAdapter();
 if(scenario==='revoked-before')allowed=false;
 const execute=()=>adapter.execute(r,{},scenario==='missing-fence'?{}:{assertAccess:()=>{}});
 if(['revoked-before','revoked-after','missing-fence'].includes(scenario)){
  await assert.rejects(execute);assert.equal(calls,scenario==='revoked-after'?1:0);return;
 }
 await execute();assert.equal(calls,1);
 let evidence=structuredClone(receipt);
 if(scenario==='wrong-task')task.plan.action.toolName='shell.execute';
 if(scenario==='wrong-receipt')evidence.request.requestId='other';
 if(scenario==='stale-state')state.receipt={...receipt,postState:{...receipt.postState,revision:2}};
 if(scenario==='forged-public')state.public={...receipt.postState,revision:8};
 const result=definition.verifyEvidence({taskId:'task',adapterEvidence:evidence});
 assert.equal(result.valid,scenario==='valid');
 if(result.valid)assert.equal(result.taskCompletionVerified,false);
});
