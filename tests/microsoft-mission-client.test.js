import test from 'node:test';import assert from 'node:assert/strict';
import {createMicrosoftMissionClient,microsoftObjective} from '../src/ui/connections/microsoft-mission-client.js';
function fixture(mode='ready'){
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},calls=[];let mission=null,lost=false,revoked=false;
 const selection={provider:'outlook',connectionId:'synthetic'},owner={sessionId:'owner',grants:['read_only'],expiresAt:'2099-01-01T00:00:00Z'};
 const request=async(path,o={})=>{calls.push({path,o});if(path==='/personal-inbox/microsoft/selections')return {version:'microsoft-collection-selections-v1',missionConfigured:true,items:[{...selection,ready:true}]};
  if(path==='/owner-session')return revoked?{active:false,recentAudit:[{eventType:'owner_session.revoked'}]}:{active:true,session:owner};
  if(path==='/missions'){mission={missionId:'mission-1',objective:microsoftObjective,microsoftCollection:{request:selection},status:'CREATED',waves:[]};if(mode==='lost-create'&&!lost){lost=true;throw Error('lost');}return structuredClone(mission);}
  if(path.startsWith('/missions?requestId='))return {items:mission?[structuredClone(mission)]:[]};
  if(path.endsWith('/cancel')){mission.status='CANCELLED';return structuredClone(mission);}
  if(path.endsWith('/run')){mission.status='COMPLETED';if(mode==='lost-run'&&!lost){lost=true;throw Error('lost');}return structuredClone(mission);}
  if(path.endsWith('/verified-microsoft-collection'))return {success:!revoked,status:revoked?'unverified':'verified',allPages:false,result:{request:selection,page:{items:[{title:'synthetic'}]}}};
  if(path==='/missions/mission-1')return structuredClone(mission);throw Error(path);
 };
 const make=()=>createMicrosoftMissionClient({request,storage,uuid:()=> 'synthetic-key'});
 return {selection,calls,make,storage,request,revoke:()=>{revoked=true;},change:()=>{mission.objective+=' 발송';}};
}
for(const mode of ['ready','lost-create','lost-run'])test('Microsoft client preserves idempotency journal '+mode,async()=>{
 const f=fixture(mode),c=f.make();if(mode==='ready')assert.equal((await c.submit(f.selection)).result.status,'verified');else await assert.rejects(c.submit(f.selection));
 const fresh=f.make(),found=await fresh.reconcile();assert.equal(f.calls.filter(c=>c.path==='/missions').length,1);
 if(mode==='lost-create'){assert.equal(found.mission.status,'CREATED');assert.equal(f.calls.some(c=>c.path.endsWith('/run')),false);assert.equal((await fresh.continueCreated()).result.status,'verified');}
 else assert.equal(found.result.status,'verified');
 assert.equal(f.calls.filter(c=>c.path.endsWith('/run')).length,1);assert.equal(fresh.pending(),true);
 const journal=JSON.parse(f.storage.getItem('jarvis.microsoft.mission.pending.v1'));assert.deepEqual(Object.keys(journal).sort(),['key','missionId','selection','version']);
 await fresh.reset();assert.equal(fresh.pending(),false);assert.equal(f.storage.getItem('jarvis.microsoft.mission.pending.v1'),null);
});
test('unsupported tail cannot create a partial command',async()=>{const f=fixture();await assert.rejects(f.make().submit(f.selection,microsoftObjective+' 메일로 보내.'),/MS_OBJECTIVE_UNSUPPORTED/);assert.equal(f.calls.length,0);});
test('revoked owner is never automatically reactivated for recovered read',async()=>{const f=fixture();await f.make().submit(f.selection);f.revoke();await assert.rejects(f.make().reconcile(),/MS_OWNER_REQUIRED/);assert.equal(f.calls.some(c=>c.path==='/owner-session/activate'),false);});
test('changed original binding cannot disclose or execute recovered work',async()=>{const f=fixture();await f.make().submit(f.selection);f.change();await assert.rejects(f.make().reconcile(),/MS_BINDING_CHANGED/);assert.equal(f.calls.filter(c=>c.path.endsWith('/run')).length,1);});
test('unavailable journal prevents execution',async()=>{const f=fixture();const storage={getItem:()=>null,setItem(){throw Error();}};await assert.rejects(createMicrosoftMissionClient({request:f.request,storage,uuid:()=> 'synthetic'}).submit(f.selection),/MS_JOURNAL_UNAVAILABLE/);assert.equal(f.calls.some(c=>c.path==='/missions'),false);});
test('approval has one explicit resume and preserves the pending selection',async()=>{
 const f=fixture('lost-create');await assert.rejects(f.make().submit(f.selection));await f.make().reconcile();let status='WAITING_APPROVAL';const calls=[];
 const request=async(path,o={})=>{calls.push({path,o});if(path==='/missions/mission-1')return {missionId:'mission-1',objective:microsoftObjective,microsoftCollection:{request:f.selection},status,pendingGates:[{gateId:'gate',type:'approval'}]};if(path.endsWith('/decision')){assert.equal(o.body.resume,false);status='CREATED';return {};}return f.request(path,o);};
 const client=createMicrosoftMissionClient({request,storage:f.storage});assert.equal((await client.approve()).result.status,'verified');assert.equal(calls.filter(c=>c.path.endsWith('/run')).length,1);assert.equal(calls.some(c=>c.path==='/missions'),false);
});
test('stop while creation is in flight cancels before any run',async()=>{
 const f=fixture();let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const request=async(path,o)=>{if(path==='/missions'){entered();await wait;}return f.request(path,o);};
 const client=createMicrosoftMissionClient({request,storage:f.storage,uuid:()=> 'synthetic-key'});const pending=client.submit(f.selection);await started;await assert.rejects(client.cancel(),/MS_RESULT_UNKNOWN/);release();assert.equal((await pending).mission.status,'CANCELLED');assert.equal(f.calls.some(c=>c.path.endsWith('/run')),false);
});
