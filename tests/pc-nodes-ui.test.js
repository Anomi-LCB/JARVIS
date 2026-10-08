import {pcTaskOptions} from '../packages/core/src/client/pc-task-options.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcNodeSetup } from '../src/ui/connections/pc-nodes.js';
import { escape } from '../src/ui/connections/connection-center.js';
import { PcOutboundNodeController } from '../packages/core/src/client/pc-outbound-service.js';
import { PcOutboundMailbox } from '../packages/core/src/client/pc-outbound-mailbox.js';
import { PcOutboundCommandMailbox } from '../packages/core/src/client/pc-outbound-command-mailbox.js';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('public certificate preview checks signature, issuer, device purpose and excludes private keys',t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-cert-preview-')),mailbox=new PcOutboundMailbox({dbPath:join(root,'test.sqlite')});
  t.after(()=>{mailbox.close();rmSync(root,{recursive:true,force:true});});
  const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url),'utf8');
  const controller=new PcOutboundNodeController({mailbox,authorityGuard:()=>({token:1}),ca:pem('ca')});
  const result=controller.previewCertificate({certificatePem:pem('core')});
  assert.equal(result.deviceConnected,false);assert.equal(result.executionAuthority,false);
  assert.ok(result.certificateFingerprint);assert.equal(mailbox.status().devices.length,0);
  for(const contents of [pem('core-key'),pem('core')+pem('core-key'),pem('server'),pem('ca'),'invalid'])
    assert.throws(()=>controller.previewCertificate({certificatePem:contents}),/A_PC_OUTBOUND_CERTIFICATE_/u);
});

test('device screen distinguishes missing prerequisites, registration, current connection and escaped labels',()=>{
  const screen=createPcNodeSetup({request:async()=>{},changed:()=>{},refresh:async()=>{},escape});
  const missing=screen.render({auth:true});assert.match(missing,/상시 노드 준비가 필요합니다/u);assert.match(missing,/type="file"[^>]*disabled/u);
  screen.update({configured:true,authorityActive:true,devices:[{deviceId:'pc-one',label:'<img onerror=unsafe>',generation:1,status:'waiting',expiresAt:'2099-01-01T00:00:00Z',selectedTaskCount:0}]});
  const registered=screen.render({auth:true});assert.match(registered,/PC 접속 대기/u);assert.match(registered,/&lt;img onerror=unsafe&gt;/u);assert.doesNotMatch(registered,/<img/u);
  assert.match(registered,/data-pc-check="pc-one"/u);assert.match(registered,/등록은 실제 접속이나 업무 완료를 의미하지 않습니다/u);
  screen.dispose();
});

test('lost readiness invalidates pending PC responses even after the same authority returns',async()=>{
 let release;const handlers={},requests=[];
 const screen=createPcNodeSetup({request:async path=>{requests.push(path);return await new Promise(resolve=>{release=resolve;});},changed:()=>{},refresh:async()=>{},escape});
 const current={configured:true,authorityActive:true,authorityToken:1,devices:[{deviceId:'pc-one',generation:1,status:'connected',expiresAt:'2099-01-01T00:00:00Z'}]};
 screen.update(current);screen.attach({addEventListener:(name,fn)=>handlers[name]=fn});
 handlers.click({target:{closest:()=>({disabled:false,dataset:{pcCheck:'pc-one'},hasAttribute:()=>false})}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);
 screen.update({configured:false,authorityActive:false,devices:[]});screen.update(current);
 release({requestId:'old-read',state:'queued'});await new Promise(resolve=>setImmediate(resolve));
 assert.match(screen.render({auth:true}),/아직 이 화면에서 PC 상태를 조회하지 않았습니다/);
 assert.doesNotMatch(screen.render({auth:true}),/조회 대기 중입니다/);
 screen.dispose();
});

function commandScreen(t,{afterRequest=async()=>{}}={}){
  const root=mkdtempSync(join(tmpdir(),'jarvis-command-ui-'));
  const mailbox=new PcOutboundMailbox({dbPath:join(root,'test.sqlite'),authorityGuard:()=>({token:1})});
  const command=new PcOutboundCommandMailbox({mailbox});
  const pem=name=>readFileSync(new URL(`./fixtures/google-broker-tls/${name}.pem`,import.meta.url),'utf8');
  const controller=new PcOutboundNodeController({mailbox,commandMailbox:command,authorityGuard:()=>({token:1}),ca:pem('ca')});
  const expiresAt=new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/u,'Z');
  controller.enroll({deviceId:'pc-one',label:'내 PC',certificateFingerprint:'AB:'.repeat(31)+'AB',expiresAt,allowedTaskIds:['report','read-only'],allowedArtifactTaskIds:['report'],expectedGeneration:0});
  const calls=[],handlers={};let changed=0;
  const screen=createPcNodeSetup({request:async(path,options={})=>{
    calls.push({path,...options});
    if(path.startsWith('/pc-nodes/task-options'))return pcTaskOptions(new Map([['named-task',{taskId:'named-task',plan:{title:'<img> 연구 문서'},status:'CREATED'}]]),new URL(path,'http://127.0.0.1').searchParams);
    if(path==='/pc-nodes/certificate')return controller.previewCertificate(options.body);
    if(path==='/pc-nodes')return controller.enroll(options.body);
    if(path.endsWith('/command-scope')){const result=options.method==='POST'?controller.updateCommandScope('pc-one',options.body):controller.commandScope('pc-one');await afterRequest(path,options,result);return result;}
    if(path.endsWith('/scope'))return controller.scope('pc-one');
    throw new Error('unexpected request');
  },changed:()=>changed++,refresh:async()=>screen.update({...controller.status(),configured:true}),escape});
  screen.update({...controller.status(),configured:true});screen.attach({addEventListener:(name,handler)=>handlers[name]=handler});
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const click=async(dataset={},attributes=[])=>{const b={dataset,disabled:false,hasAttribute:name=>attributes.includes(name)};handlers.click({target:{closest:()=>b}});await settle();};
  const submit=async()=>{handlers.submit({target:{matches:s=>s==='[data-pc-command-form]'},preventDefault(){}});await settle();};
  const toggle=checked=>handlers.change({target:{name:'commandTask',value:'report',checked,closest:()=>true}});
  const expiry=value=>handlers.input({target:{name:'commandExpiresAt',value,closest:s=>s==='[data-pc-command-form]'}});
  t.after(()=>{screen.dispose();mailbox.close();rmSync(root,{recursive:true,force:true});});
  return {screen,controller,command,calls,click,submit,toggle,expiry,expiresAt,changes:()=>changed,
    certificate:()=>handlers.change({target:{name:'certificate',files:[{name:'public.pem',size:pem('core').length,text:async()=>pem('core')}],closest:s=>s==='[data-pc-enroll]'}}),
    enroll:async()=>{handlers.submit({target:{matches:s=>s==='[data-pc-enroll]'},preventDefault(){}});await settle();},
    readOption:checked=>handlers.change({target:{name:'readTaskOption',value:'named-task',checked,closest:s=>s==='[data-pc-enroll]'}}),
    artifacts:checked=>handlers.change({target:{name:'artifactsAll',checked,closest:s=>s==='[data-pc-enroll]'}})};
}

test('execution selection saves through actual scope controller and full revocation ignores invalid editor date',async t=>{
  const f=commandScreen(t);await f.click({pcCommand:'pc-one'});
  assert.match(f.screen.render({auth:true}),/value="report"/u);
  assert.doesNotMatch(f.screen.render({auth:true}),/name="commandTask" value="read-only"/u);
  f.toggle(true);assert.match(f.screen.render({auth:true}),/선택한 작업 1개/u);
  await f.submit();assert.equal(f.controller.commandScope('pc-one').revision,1);
  assert.deepEqual(f.controller.commandScope('pc-one').allowedTaskIds,['report']);
  const post=f.calls.find(c=>c.method==='POST');assert.equal(post.body.expectedRevision,0);assert.equal(post.body.expectedGeneration,1);
  f.expiry('');await f.click({},['data-pc-command-revoke']);
  assert.deepEqual(f.controller.commandScope('pc-one').allowedTaskIds,[]);
  assert.equal(f.controller.commandScope('pc-one').revision,2);
  assert.match(f.screen.render({auth:true}),/실행 허용을 전부 철회했습니다/u);
});

test('stale revision blocks further writes until explicit reload and never overwrites competing grant',async t=>{
  const f=commandScreen(t);await f.click({pcCommand:'pc-one'});f.toggle(true);
  f.controller.updateCommandScope('pc-one',{expectedGeneration:1,expectedRevision:0,allowedTaskIds:[],expiresAt:f.expiresAt});
  await f.submit();assert.match(f.screen.render({auth:true}),/현재 범위를 다시 불러와/u);
  assert.match(f.screen.render({auth:true}),/<button disabled>선택한 실행 범위 저장/u);
  const posts=f.calls.filter(c=>c.method==='POST').length;await f.submit();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
  assert.equal(f.controller.commandScope('pc-one').revision,1);
  await f.click({pcCommand:'pc-one'});f.toggle(true);await f.submit();
  assert.equal(f.controller.commandScope('pc-one').revision,2);
  assert.deepEqual(f.controller.commandScope('pc-one').allowedTaskIds,['report']);
});

test('device generation change invalidates open editor and time beyond device expiry never posts',async t=>{
  const f=commandScreen(t);await f.click({pcCommand:'pc-one'});f.toggle(true);
  f.expiry('2099-01-01T00:00');await f.submit();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  assert.match(f.screen.render({auth:true}),/유효한 종료 시각/u);
  const status=f.controller.status();status.devices[0].generation++;f.screen.update(status);
  assert.match(f.screen.render({auth:true}),/<button disabled>선택한 실행 범위 저장/u);
  await f.submit();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  assert.match(f.screen.render({auth:false}),/<fieldset disabled>/u);
});

test('editing a device preserves partial artifact read scope and expands only on explicit selection',async t=>{
  const f=commandScreen(t);await f.click({pcEdit:'pc-one'});await f.certificate();await f.enroll();
  assert.deepEqual(f.controller.scope('pc-one').allowedArtifactTaskIds,['report']);
  await f.click({pcEdit:'pc-one'});f.artifacts(true);await f.certificate();await f.enroll();
  assert.deepEqual(f.controller.scope('pc-one').allowedArtifactTaskIds,['report','read-only']);
  assert.equal(f.controller.commandScope('pc-one').revision,0);
  assert.deepEqual(f.controller.commandScope('pc-one').allowedTaskIds,[]);
});

function heldResponse(){let release,held=false;const gate=new Promise(resolve=>release=resolve);return {get held(){return held;},release,wait:async()=>{held=true;await gate;}};}

test('late save response cannot reopen a closed execution editor',async t=>{
  const delayed=heldResponse();const f=commandScreen(t,{afterRequest:async(path,options)=>{if(options.method==='POST')await delayed.wait();}});
  await f.click({pcCommand:'pc-one'});f.toggle(true);await f.submit();assert.equal(delayed.held,true);
  await f.click({},['data-pc-command-close']);assert.doesNotMatch(f.screen.render({auth:true}),/id="pc-command-title"/u);
  delayed.release();await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(f.screen.render({auth:true}),/id="pc-command-title"/u);
  assert.equal(f.controller.commandScope('pc-one').revision,1,'The already committed server grant is not rolled back by closing the editor');
});

test('late reload response cannot reopen a closed execution editor',async t=>{
  const delayed=heldResponse();let hold=false;const f=commandScreen(t,{afterRequest:async()=>{if(hold)await delayed.wait();}});
  await f.click({pcCommand:'pc-one'});hold=true;await f.click({pcCommand:'pc-one'});assert.equal(delayed.held,true);
  await f.click({},['data-pc-command-close']);delayed.release();await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(f.screen.render({auth:true}),/id="pc-command-title"/u);
});

test('late save retains invalidation after device generation or authority changes',async t=>{
  for(const kind of ['generation','authority']){
    const delayed=heldResponse();const f=commandScreen(t,{afterRequest:async(path,options)=>{if(options.method==='POST')await delayed.wait();}});
    await f.click({pcCommand:'pc-one'});f.toggle(true);await f.submit();
    const status=f.controller.status();if(kind==='generation')status.devices[0].generation++;else status.authorityToken++;
    f.screen.update(status);delayed.release();await new Promise(resolve=>setImmediate(resolve));
    assert.match(f.screen.render({auth:true}),/<button disabled>선택한 실행 범위 저장/u,kind);
  }
});


test('initial scope load is discarded after authority changes or disposal',async t=>{
  for(const kind of ['authority','revoked','expired','dispose']){
    const delayed=heldResponse();const f=commandScreen(t,{afterRequest:async()=>delayed.wait()});
    await f.click({pcCommand:'pc-one'});assert.equal(delayed.held,true);
    if(kind==='dispose')f.screen.dispose();else{const status=f.controller.status();if(kind==='authority')status.authorityToken++;else status.devices[0].status=kind;f.screen.update(status);}
    delayed.release();await new Promise(resolve=>setImmediate(resolve));
    assert.doesNotMatch(f.screen.render({auth:true}),/id="pc-command-title"/u,kind);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  }
});


test('named Core task picker changes read selection only and preserves partial artifact scope',async t=>{
  const f=commandScreen(t);await f.click({pcEdit:'pc-one'});await f.click({},['data-pc-options']);
  const html=f.screen.render({auth:true});assert.match(html,/&lt;img&gt; 연구 문서/u);assert.doesNotMatch(html,/<img>/u);
  assert.match(html,/name="readTaskOption" value="named-task"/u);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'Discovering and choosing tasks is not a permission write');
  f.readOption(true);await f.certificate();await f.enroll();
  assert.deepEqual(f.controller.scope('pc-one').allowedTaskIds,['report','read-only','named-task']);
  assert.deepEqual(f.controller.scope('pc-one').allowedArtifactTaskIds,['report']);
  assert.deepEqual(f.controller.commandScope('pc-one').allowedTaskIds,[]);
});
