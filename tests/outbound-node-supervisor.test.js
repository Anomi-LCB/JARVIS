import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPcOutboundNodeSupervisor} from '../apps/pc-agent/src/outbound-node-supervisor.js';
import {startPcAgentServiceRuntime} from '../apps/pc-agent/src/main.mjs';
import {createConfiguredPcOutboundObserver} from '../scripts/pc-outbound-channel.mjs';

const wait=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('supervisor test timeout');await new Promise(resolve=>setTimeout(resolve,5));}};

test('read and command polling are independent; stop drains and closes exactly once',async()=>{
  let unblock,command=0,closes=0;
  const node=createPcOutboundNodeSupervisor({observer:{tick:()=>new Promise(resolve=>{unblock=resolve;})},dispatcher:{tick:async()=>{command++;return {status:'observed'};}},close:()=>{closes++;unblock({status:'idle'});},intervalMs:100,maxIdleMs:100});
  node.start();node.start();await wait(()=>command===1);assert.equal(node.status().connectedVerified,false);
  await Promise.all([node.stop(),node.stop()]);assert.equal(closes,1);assert.equal(node.status().stopped,true);
  assert.throws(()=>node.start(),/STOPPED/u);
});

test('temporary poll failures recover without exposing exception content',async()=>{
  let calls=0;
  const node=createPcOutboundNodeSupervisor({observer:{tick:()=>{calls++;if(calls===1)throw new Error('private credential must not appear');return {status:'observed'};}},close:()=>{},intervalMs:100,maxIdleMs:100});
  node.start();await wait(()=>node.status().ticks>=2);await node.stop();assert.equal(node.status().failures,1);
  assert.equal(node.status().last.read,'observed');assert.ok(!JSON.stringify(node.status()).includes('credential'));
});

test('standalone command config cannot substitute an HTTP client for a service B runtime',()=>{
  const env=Object.fromEntries(['URL','TLS_KEY','TLS_CERT','TLS_CA','LOCAL_URL','TOKEN_FILE'].map(key=>[`JARVIS_PC_OUTBOUND_${key}`,'not-read']));
  assert.throws(()=>createConfiguredPcOutboundObserver({env:{...env,JARVIS_PC_OUTBOUND_COMMAND_ENABLED:'1'}}),/COMMAND_RUNTIME_REQUIRED/u);
  assert.throws(()=>createConfiguredPcOutboundObserver({env:{...env,JARVIS_PC_OUTBOUND_COMMAND_ENABLED:'yes'}}),/CONFIG_INVALID/u);
});

for(const enabled of [false,true])test(`actual PC service outbound lifecycle enabled=${enabled}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-node-service-'));let polls=0,closes=0,factories=0;
  let service;
  t.after(async()=>{await service?.close();await rm(root,{recursive:true,force:true});});
  const env={PORT:'0',JARVIS_TEST_MODE:'1',JARVIS_ALLOWED_ROOTS:root,JARVIS_AUDIT_ROOT:join(root,'audit'),JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_TEST_AUDIT_ROOT:root,
    JARVIS_QUEUE_DRAIN_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PC_OUTBOUND_ENABLED:enabled?'1':'0',
    ...Object.fromEntries([['UNDO_JOURNAL','undo.jsonl'],['ROLLBACK_TRANSACTIONS','rollback.jsonl'],['PACKET_JOURNAL','packets.jsonl'],['PACKET_QUEUE','queue.json'],['TOKEN_VAULT','vault.jsonl']].map(([key,leaf])=>[`JARVIS_${key}`,join(root,leaf)]))};
  service=await startPcAgentServiceRuntime({env,pcOutboundNodeFactory:({env:received,pcAgent})=>{
    factories++;assert.equal(pcAgent.supportsTrustedLocalMissionEffects(),true);assert.match(received.JARVIS_PC_OUTBOUND_LOCAL_URL,/^http:\/\/127\.0\.0\.1:\d+$/u);
    return createPcOutboundNodeSupervisor({observer:{tick:async()=>{polls++;return {status:'idle'};}},close:()=>{closes++;},intervalMs:100,maxIdleMs:100});
  }});
  const response=await fetch(`http://127.0.0.1:${service.port}/health`);assert.equal(response.status,200);
  if(enabled){await wait(()=>polls>0);assert.equal(service.outboundNode.status().connectedVerified,false);}else assert.equal(service.outboundNode,null);
  await Promise.all([service.close(),service.close()]);assert.equal(factories,enabled?1:0);assert.equal(closes,enabled?1:0);assert.equal(service.server.listening,false);
});
