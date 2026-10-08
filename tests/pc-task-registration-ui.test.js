import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {createPcTaskRegistration} from '../src/ui/connections/pc-task-registration.js';
import {escape} from '../src/ui/connections/connection-center.js';
const options=(offset=0)=>({source:'core-runtime-and-mission-records',executionAuthority:false,verifiedCompletion:false,deviceAvailabilityVerified:false,snapshot:'a'.repeat(64),offset,totalEntries:2,nextOffset:offset+1,hasMore:offset===0,items:[{taskId:offset?'second':'first',title:offset?'다음 자료 읽기':'<b>연구 보고서 작성</b>',status:'RESERVED'}]});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'jarvis-registration-ui-')),scope=new PcLocalTaskScope({dbPath:join(root,'scope.sqlite'),managedCatalog:true});
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0'}});
  const server=createPcAgentServer(runtime.pcAgent,{localTaskScope:scope,apiGuard:new PcAgentApiGuard({apiToken:'synthetic-registration-admin'})});const address=await listenOnFetchSafePort(server);
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));scope.close();await rm(root,{recursive:true,force:true});});
  let lost=false,delay=null,optionsReader=query=>options(query.includes('offset=1')?1:0),calls=0;
  const panel=createPcTaskRegistration({escape,changed:()=>{},readOptions:async query=>optionsReader(query),request:async(input={})=>{
    calls++;const response=await fetch(`http://127.0.0.1:${address.port}/outbound/local-task-catalog`,{method:input.method??'GET',headers:{authorization:'Bearer synthetic-registration-admin',...(input.body?{'content-type':'application/json'}:{})},...(input.body?{body:JSON.stringify(input.body)}:{})});
    const value=await response.json();if(!response.ok)throw new Error(value.error.code);if(input.method==='PUT'&&lost){lost=false;throw new Error('lost');}if(delay)await delay;return value;
  }});
  return {panel,scope,calls:()=>calls,lose:()=>lost=true,delay:value=>delay=value,reader:value=>optionsReader=value};
}
test('real PC API preserves paged selections and registration never grants execution',async t=>{
  const f=await fixture(t);await f.panel.load();assert.equal(f.calls(),0);f.panel.setEnabled(true);await f.panel.load();await f.panel.find();
  f.panel.select('first',3);await f.panel.find(true);f.panel.select('second',1);await f.panel.save();
  assert.deepEqual(f.scope.catalog().allowedTaskIds,['first','second']);assert.deepEqual(f.scope.catalog().allowedCommandTaskIds,['first']);assert.equal(f.scope.snapshot().active,false);
  assert.match(f.panel.render(),/&lt;b&gt;연구 보고서 작성/u);assert.doesNotMatch(f.panel.render(),/<b>연구/u);
  f.scope.replace({expectedRevision:1,allowedTaskIds:['first'],expiresAt:Date.now()+60000});const lease=f.scope.capture('first');
  f.panel.select('first',0);await f.panel.save();assert.equal(f.scope.snapshot().active,false);assert.throws(()=>f.scope.assertCurrent('first',lease),/CHANGED/u);
});
test('actual competing catalog change and lost successful PUT require reload instead of blind retry',async t=>{
  const f=await fixture(t);f.panel.setEnabled(true);await f.panel.load();await f.panel.find();f.panel.select('first',3);
  f.scope.replaceCatalog({expectedRevision:0,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});await f.panel.save();assert.match(f.panel.render(),/다른 곳에서 등록/u);
  let calls=f.calls();await f.panel.save();assert.equal(f.calls(),calls);
  await f.panel.load();await f.panel.find();f.panel.select('first',2);f.lose();await f.panel.save();assert.match(f.panel.render(),/저장 결과를 확인하지/u);
  calls=f.calls();await f.panel.save();assert.equal(f.calls(),calls);await f.panel.load();assert.deepEqual(f.scope.catalog().allowedArtifactTaskIds,['first']);
});
test('late responses cannot restore disposed or disconnected registration controls',async t=>{
  const f=await fixture(t);f.panel.setEnabled(true);await f.panel.load();await f.panel.find();f.panel.select('first',3);
  let release;f.delay(new Promise(resolve=>release=resolve));const saving=f.panel.save();await new Promise(resolve=>setTimeout(resolve,30));f.panel.setEnabled(false);release();await saving;
  assert.doesNotMatch(f.panel.render(),/data-registration-form/u);assert.match(f.panel.render(),/data-registration-load disabled/u);
  f.panel.dispose();f.panel.setEnabled(true);assert.doesNotMatch(f.panel.render(),/data-registration-form/u);
});
test('changed page snapshot and forged authority cannot replace or erase existing selections',async t=>{
  const f=await fixture(t);f.panel.setEnabled(true);await f.panel.load();await f.panel.find();f.panel.select('first',1);
  f.reader(()=>({...options(1),snapshot:'b'.repeat(64)}));await f.panel.find(true);assert.match(f.panel.render(),/업무 이름을 조회하지/u);await f.panel.save();assert.deepEqual(f.scope.catalog().allowedTaskIds,['first']);
  f.reader(()=>({...options(),executionAuthority:true}));await f.panel.find();f.panel.select('second',3);await f.panel.save();assert.deepEqual(f.scope.catalog().allowedCommandTaskIds,[]);
});
