import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcTaskCatalog } from '../src/ui/connections/pc-task-catalog.js';

function fixture(options={}){
  let time=Date.now(),changes=0;const calls=[],timers=new Map();let timerId=0;
  const taskIds=Array.from({length:102},(_,i)=>`task-${i}`),scope={deviceId:'one',generation:1,authorityToken:2,taskIds};
  const observations=new Map();
  const request=async(path,input={})=>{
    calls.push({path,...input});
    if(input.method==='POST'){
      const body=input.body,selected=taskIds.slice(body.offset,body.offset+100);
      const result={deviceId:'one',deviceGeneration:1,authorityToken:2,state:'observed',observationCurrent:true,observationCurrentUntil:new Date(time+1000).toISOString(),
        observation:{status:'observed',value:{items:selected.map(taskId=>({taskId,title:'파일 작성',status:'COMPLETED',available:true,dryRun:false})),offset:body.offset,totalEntries:taskIds.length,hasMore:body.offset+selected.length<taskIds.length,executionAuthority:false,verifiedCompletion:false}}};
      observations.set(body.requestId,options.mutate?options.mutate(result):result);
      if(options.lostPost&&!options.postLost){options.postLost=true;throw new Error('network');}
      return {requestId:body.requestId};
    }
    if(options.defer)return await options.defer;
    return observations.get(path.split('/').pop());
  };
  const catalog=createPcTaskCatalog({request,changed:()=>changes++,clock:()=>time,setTimer:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
  catalog.reset(scope);
  return {catalog,scope,calls,timers,changes:()=>changes,advance(ms){time+=ms;},expire(ms=1001){time+=ms;for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}},settle:()=>new Promise(r=>setImmediate(r))};
}

test('metadata page progression preserves original selection and expires the oldest page independently',async()=>{
  const f=fixture();await f.catalog.load();await f.settle();
  assert.equal(f.catalog.view().items.size,100);assert.equal(f.catalog.view().hasMore,true);
  assert.deepEqual(Object.keys(f.calls[0].body).sort(),['limit','offset','operation','requestId','taskId']);
  f.advance(200);await f.catalog.load(true);await f.settle();assert.equal(f.catalog.view().items.size,102);
  assert.equal(f.calls.filter(c=>c.method==='POST')[1].body.offset,100);
  assert.equal(f.catalog.view().hasMore,false);f.expire(801);assert.equal(f.catalog.view().items.size,2);f.expire(200);assert.equal(f.catalog.view().items.size,0);
  assert.equal(f.catalog.view().state,'stale');f.catalog.dispose();assert.equal(f.timers.size,0);
});

test('wrong device, generation, authority, stale record and reordered page cannot label the selection',async()=>{
  for(const mutate of [r=>({...r,deviceId:'other'}),r=>({...r,deviceGeneration:2}),r=>({...r,authorityToken:3}),r=>({...r,observationCurrent:false}),
    r=>({...r,observationCurrentUntil:'2000-01-01T00:00:00Z'}),r=>({...r,observation:{...r.observation,value:{...r.observation.value,items:r.observation.value.items.slice().reverse()}}})]){
    const f=fixture({mutate});await f.catalog.load();await f.settle();assert.equal(f.catalog.view().items.size,0);assert.equal(f.catalog.view().state,'unavailable');f.catalog.dispose();
  }
});

test('lost POST acknowledgement resumes with the same id and does not create a new catalog request',async()=>{
  const f=fixture({lostPost:true});await f.catalog.load();assert.equal(f.catalog.view().state,'waiting-retry');
  await f.catalog.load();await f.settle();const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[0].body.requestId,posts[1].body.requestId);assert.equal(f.catalog.view().items.size,100);f.catalog.dispose();
});

test('authority invalidation clears labels and a closed editor ignores a late response',async()=>{
  const f=fixture();await f.catalog.load();await f.settle();f.catalog.invalidateAuthority(true,3);assert.equal(f.catalog.view().items.size,0);
  const before=f.calls.length;await f.catalog.load();assert.equal(f.calls.length,before);
  let resolve;const late=fixture({defer:new Promise(r=>{resolve=r;})});await late.catalog.load();late.catalog.dispose();
  resolve({deviceId:'one',deviceGeneration:1,authorityToken:2,state:'observed'});await late.settle();assert.equal(late.catalog.view().items.size,0);assert.equal(late.timers.size,0);
});
