import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PcOutboundMailbox} from '../packages/core/src/client/pc-outbound-mailbox.js';
import {createPcOutboundObserver} from '../apps/pc-agent/src/outbound-observer.js';
import {validPcDeviceObservation} from '../packages/shared/src/pc-device-observation-contract.js';
import {createConfiguredPcOutboundObserver} from '../scripts/pc-outbound-channel.mjs';
const peer='a'.repeat(64),value=()=>({deviceType:'pc',os:{platform:'win32',release:'fixture',architecture:'x64',source:'node-os'},hardware:{manufacturer:'Fixture',model:'PC',source:'windows-cim'},permissions:{elevatedToken:false,source:'windows-token'},probeStatus:'observed',startedAt:'2026-10-07T00:00:00.000Z',observedAt:'2026-10-07T00:00:01.000Z',executionAuthority:false,hardwareAttested:false,accountIdentityVerified:false});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-node-device-'));let time=Date.now(),store;
 const open=()=>new PcOutboundMailbox({dbPath:join(root,'read.sqlite'),clock:()=>time,freshnessMs:100});store=open();
 store.enroll({deviceId:'pc',certificateFingerprint:peer,expiresAt:time+10000});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const enqueue=id=>store.enqueue({deviceId:'pc',requestId:id,operation:'device-observation',taskId:null});
 return {get store(){return store;},enqueue,advance(){time+=101;},restart(){store.close();store=open();}};
}
test('selected observation persists by credential identity; expiration/revocation are not current',async t=>{
 const f=fixture(t);f.enqueue('device');
 const observer=createPcOutboundObserver({pcClient:{health:async()=>({})},deviceReader:async()=>({...value(),hostname:'not replicated',connection:{status:'not-evaluated'}}),transport:{exchange:async(method,input)=>method==='pull'?f.store.pull(peer):f.store.submit(peer,input)}});
 await observer.tick();const result=f.store.result('device');assert.equal(result.deviceId,'pc');assert.equal(result.deviceGeneration,1);assert.equal(result.observationCurrent,true);
 assert.equal(result.observation.value.hostname,undefined);assert.equal(result.executionAuthority,false);assert.equal(result.observation.value.hardwareAttested,false);
 f.restart();assert.deepEqual(f.store.result('device').observation,result.observation);f.advance();assert.equal(f.store.result('device').observationCurrent,false);
 f.store.revoke('pc',{expectedGeneration:1});assert.equal(f.store.result('device').observationCurrent,false);assert.throws(()=>f.enqueue('again'),/DEVICE_DENIED/);
});
test('disabled local reader never invokes probe and returns explicit unavailability',async t=>{
 const f=fixture(t);f.enqueue('disabled');
 await createPcOutboundObserver({pcClient:{health:async()=>({})},transport:{exchange:async(method,input)=>method==='pull'?f.store.pull(peer):f.store.submit(peer,input)}}).tick();
 const result=f.store.result('disabled');assert.equal(result.observation.status,'unavailable');assert.equal(result.observation.value,undefined);assert.equal(result.verifiedCompletion,false);
});
for(const [name,mutate] of [
 ['private identifier',v=>{v.hardware.serial='secret';}],['execution grant',v=>{v.executionAuthority=true;}],['attestation claim',v=>{v.hardwareAttested=true;}],
 ['missing permission',v=>{delete v.permissions.elevatedToken;}],['future inverted time',v=>{v.startedAt='2026-10-08T00:00:00.000Z';}],['unknown reported as observed',v=>{v.hardware=null;}],
 ['secret in envelope',(_,r)=>{r.credentials='secret';}]
])test(`Core rejects device result: ${name}`,t=>{
 const f=fixture(t);f.enqueue('malformed');const packet=f.store.pull(peer),result={status:'observed',observedAt:'2026-10-07T00:00:01.000Z',value:value()};mutate(result.value,result);
 assert.throws(()=>f.store.submit(peer,{requestId:packet.requestId,generation:packet.generation,lease:packet.lease,result}),/RESULT_INVALID/);
 assert.equal(f.store.result('malformed').observation,null);
});
test('unknown hardware has explicit non-authoritative representation',()=>{
 const v=value();v.hardware=null;v.permissions={elevatedToken:null,source:'not-observed'};v.probeStatus='unavailable';assert.equal(validPcDeviceObservation(v),true);
});
test('device transfer configuration rejects ambiguous consent flags before opening TLS files',()=>{
 const env=Object.fromEntries(['URL','TLS_KEY','TLS_CERT','TLS_CA','LOCAL_URL','TOKEN_FILE'].map(name=>[`JARVIS_PC_OUTBOUND_${name}`,'not-opened']));
 assert.throws(()=>createConfiguredPcOutboundObserver({env:{...env,JARVIS_PC_OUTBOUND_DEVICE_OBSERVATION_ENABLED:'yes'}}),/CONFIG_INVALID/);
});
