import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createPcAgentServer,PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { createPcLocalPermissions } from '../src/ui/connections/pc-local-permissions.js';
import { escape } from '../src/ui/connections/connection-center.js';

async function fixture(t,{readLabels=null}={}){
  const root=await mkdtemp(join(tmpdir(),'jarvis-scope-ui-')),scope=new PcLocalTaskScope({dbPath:join(root,'scope.sqlite')});
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0'}});
  const server=createPcAgentServer(runtime.pcAgent,{localTaskScope:scope,localTaskIds:['보고서_작성','자료_읽기'],apiGuard:new PcAgentApiGuard({apiToken:'synthetic-ui-admin'})});
  const address=await listenOnFetchSafePort(server);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));scope.close();await rm(root,{recursive:true,force:true});});
  const calls=[],handlers=new Map(),labelElements=[];let lost=false,release=null,renders=0;
  const panel=createPcLocalPermissions({escape,readLabels,changed:()=>{renders++;},request:async(options={})=>{
    calls.push(options);const response=await fetch(`http://127.0.0.1:${address.port}/outbound/local-task-scope`,{method:options.method??'GET',headers:{authorization:'Bearer synthetic-ui-admin',...(options.body?{'content-type':'application/json'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
    const value=await response.json();if(!response.ok)throw new Error(value.error.code);
    if(options.method==='PUT'&&lost){lost=false;throw new Error('lost response');}
    if(release)await release;return value;
  }});
  panel.attach({addEventListener:(type,fn)=>handlers.set(type,fn),querySelectorAll:()=>labelElements});
  const select=id=>handlers.get('change')({target:{dataset:{localTask:id},checked:true}});
  return {panel,scope,calls,select,labelElements,renders:()=>renders,lose:()=>{lost=true;},delay:promise=>{release=promise;}};
}

test('bound titles are escaped display metadata and saving retains the exact task ID',async t=>{
  const f=await fixture(t,{readLabels:async taskIds=>({source:'core-runtime-and-mission-records',executionAuthority:false,verifiedCompletion:false,deviceAvailabilityVerified:false,items:taskIds.map(taskId=>({taskId,title:'<script>제출 보고서 작성</script>',found:true}))})});
  f.panel.setEnabled(true);await f.panel.load();await new Promise(setImmediate);assert.match(f.panel.render(),/&lt;script&gt;제출 보고서 작성/u);
  assert.doesNotMatch(f.panel.render(),/<script>/u);f.select('보고서_작성');await f.panel.save();assert.deepEqual(f.scope.snapshot().allowedTaskIds,['보고서_작성']);
});

test('reordered label response falls back without changing local grant choices',async t=>{
  const f=await fixture(t,{readLabels:async taskIds=>({source:'core-runtime-and-mission-records',executionAuthority:false,verifiedCompletion:false,deviceAvailabilityVerified:false,items:taskIds.slice().reverse().map(taskId=>({taskId,title:'잘못 결속된 제목',found:true}))})});
  f.panel.setEnabled(true);await f.panel.load();await new Promise(setImmediate);assert.doesNotMatch(f.panel.render(),/잘못 결속된 제목/u);assert.match(f.panel.render(),/업무 이름 확인 필요/u);assert.equal(f.scope.snapshot().revision,0);
});

const labelResult=(ids,title)=>({source:'core-runtime-and-mission-records',executionAuthority:false,verifiedCompletion:false,deviceAvailabilityVerified:false,items:ids.map(taskId=>({taskId,title,found:true}))});

test('pending optional titles never block actual PC settings or saving',async t=>{
  let release,started;const pending=new Promise(resolve=>{release=resolve;}),lookupStarted=new Promise(resolve=>{started=resolve;});
  let signal;
  const f=await fixture(t,{readLabels:(_,options)=>{signal=options.signal;started();return pending;}});f.panel.setEnabled(true);
  let ready=false;const loaded=f.panel.load().then(()=>{ready=true;});await lookupStarted;await new Promise(setImmediate);
  // Guard cleanup even on the original blocking implementation.
  if(!ready){release({});await loaded;assert.fail('optional Core title response must not gate PC settings');}
  f.select('자료_읽기');await f.panel.save();assert.deepEqual(f.scope.snapshot().allowedTaskIds,['자료_읽기']);
  assert.equal(signal.aborted,true);release({});await loaded;
});

test('late title text updates do not redraw the form or erase selected work',async t=>{
  let release,ids;const pending=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{readLabels:taskIds=>{ids=taskIds;return pending;}});f.panel.setEnabled(true);await f.panel.load();
  const title={dataset:{localTaskLabel:'보고서_작성'},textContent:'업무 이름 확인 필요'};f.labelElements.push(title);
  f.select('보고서_작성');const renders=f.renders();release(labelResult(ids,'<b>새로운 제목</b>'));await new Promise(setImmediate);
  assert.equal(title.textContent,'<b>새로운 제목</b>');assert.equal(f.renders(),renders,'partial date input and focus must not be replaced');
  assert.match(f.panel.render(),/data-local-task="보고서_작성" checked/u);assert.match(f.panel.render(),/&lt;b&gt;새로운 제목/u);
  await f.panel.save();assert.deepEqual(f.scope.snapshot().allowedTaskIds,['보고서_작성']);
});

test('reload and disposal abort optional lookups and ignore stale titles',async t=>{
  const lookups=[];
  const f=await fixture(t,{readLabels:(ids,{signal})=>new Promise(resolve=>lookups.push({ids,signal,resolve}))});
  f.panel.setEnabled(true);await f.panel.load();await f.panel.load();assert.equal(lookups[0].signal.aborted,true);
  lookups[1].resolve(labelResult(lookups[1].ids,'현재 제목'));await new Promise(setImmediate);
  lookups[0].resolve(labelResult(lookups[0].ids,'이전 제목'));await new Promise(setImmediate);
  assert.match(f.panel.render(),/현재 제목/u);assert.doesNotMatch(f.panel.render(),/이전 제목/u);
  await f.panel.load();f.panel.dispose();assert.equal(lookups[2].signal.aborted,true);
  lookups[2].resolve(labelResult(lookups[2].ids,'폐기한 제목'));await new Promise(setImmediate);
  assert.doesNotMatch(f.panel.render(),/폐기한 제목/u);
});

test('unresponsive title lookup is aborted within its independent deadline',async t=>{
  let aborted;const cancelled=new Promise(resolve=>{aborted=resolve;});
  const f=await fixture(t,{readLabels:(_, {signal})=>{signal.addEventListener('abort',aborted,{once:true});return new Promise(()=>{});}});
  f.panel.setEnabled(true);await f.panel.load();await cancelled;
  assert.match(f.panel.render(),/현재 PC 설정을 불러왔습니다/u);
  f.select('자료_읽기');await f.panel.save();assert.deepEqual(f.scope.snapshot().allowedTaskIds,['자료_읽기']);f.panel.dispose();
});

test('panel uses actual API to grant selected work and revoke; unprepared controls never request',async t=>{
  const f=await fixture(t);await f.panel.load();assert.equal(f.calls.length,0);
  f.panel.setEnabled(true);await f.panel.load();f.select('보고서_작성');await f.panel.save();
  assert.deepEqual(f.scope.snapshot().allowedTaskIds,['보고서_작성']);assert.equal(f.scope.snapshot().revision,1);
  await f.panel.save(true);assert.equal(f.scope.snapshot().active,false);assert.equal(f.scope.snapshot().revision,2);
});

test('concurrent revision conflict preserves newer server state and requires a reload',async t=>{
  const f=await fixture(t);f.panel.setEnabled(true);await f.panel.load();f.select('보고서_작성');
  f.scope.replace({expectedRevision:0,allowedTaskIds:['자료_읽기'],expiresAt:Date.now()+60000});
  await f.panel.save();assert.match(f.panel.render(),/다른 곳에서 설정/u);assert.deepEqual(f.scope.snapshot().allowedTaskIds,['자료_읽기']);
  const before=f.calls.length;await f.panel.save();assert.equal(f.calls.length,before);
  await f.panel.load();assert.match(f.panel.render(),/현재 설정 버전 1/u);
});

test('lost successful save is reconciled by reading; late disposed response cannot restore controls',async t=>{
  const f=await fixture(t);f.panel.setEnabled(true);await f.panel.load();f.select('자료_읽기');f.lose();await f.panel.save();
  assert.equal(f.scope.snapshot().revision,1);assert.match(f.panel.render(),/재전송 전에/u);
  await f.panel.load();assert.match(f.panel.render(),/현재 설정 버전 1/u);
  let resolve;f.delay(new Promise(r=>{resolve=r;}));const pending=f.panel.load();f.panel.dispose();resolve();await pending;
  assert.equal(f.panel.render().includes('data-local-scope-form'),false);
});

test('scope response cannot claim execution authority or select an unconfigured task',async()=>{
  const input={configured:true,executionAuthority:true,verifiedCompletion:false,revision:0,allowedTaskIds:[],selectableTaskIds:['task'],expiresAt:0,active:false};
  const panel=createPcLocalPermissions({request:async()=>input,changed:()=>{},escape});panel.setEnabled(true);await panel.load();assert.equal(panel.render().includes('data-local-scope-form'),false);panel.dispose();
});
