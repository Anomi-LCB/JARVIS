import test from 'node:test';
import assert from 'node:assert/strict';
import {createMicrosoftMissionClient,microsoftPagesObjective} from '../src/ui/connections/microsoft-mission-client.js';
function fixture(provider='outlook',fault=null){
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},calls=[];
 const selection={provider,connectionId:'synthetic',...(provider==='teams-chat'?{chatId:'19:synthetic@thread.v2'}:{}),maxPages:4};
 const {maxPages,...base}=selection;let mission=null;
 const request=async(path,o={})=>{calls.push({path,o});
  if(path==='/personal-inbox/microsoft/selections')return {version:'microsoft-collection-selections-v1',missionConfigured:true,items:[{...base,ready:true}]};
  if(path==='/personal-inbox/microsoft/progress')return {version:'personal-source-cursor-v1',provider,present:fault==='prior-partial',paginationComplete:null,nextCursor:fault==='prior-partial'?'https://graph.microsoft.com/v1.0/me/messages?$skip=1':null};
  if(path==='/owner-session')return {active:true,session:{sessionId:'owner',grants:['read_only','high_impact'],expiresAt:'2099-01-01T00:00:00Z'}};
  if(path==='/missions'){mission={missionId:'mission',objective:o.body.objective,microsoftCollection:{version:'microsoft-collection-pages-goal-v1',request:base,maxPages:4},status:'CREATED',waves:[]};if(fault==='lost-create')throw Error('lost');return structuredClone(mission);}
  if(path.startsWith('/missions?requestId='))return {items:[structuredClone(mission)]};
  if(path==='/missions/mission')return structuredClone(mission);
  if(path.endsWith('/run')){mission.status=fault==='limit'?'PAUSED':'COMPLETED';mission.stopReason=fault==='limit'?'microsoft-collection-page-limit':null;return structuredClone(mission);}
  if(path.endsWith('/verified-microsoft-collection')){
   const result={success:true,status:'verified',allPages:true,snapshotVerified:false,result:{version:'microsoft-collection-pages-receipt-v1',request:base,snapshotVerified:false,verification:{status:'passed'},pages:[{request:{...base,cursor:null},page:{items:[{title:'synthetic'}],nextCursor:null}}]}};
   if(fault==='wrong-account')result.result.pages[0].request.connectionId='foreign';
   if(fault==='wrong-limit')mission.microsoftCollection.maxPages=5;
   if(fault==='unfinished')result.result.pages[0].page.nextCursor='more';
   if(fault==='single-page')result.allPages=false;
   return result;
  }
  throw Error(path);
 };
 return {selection,calls,records,storage,request,make:()=>createMicrosoftMissionClient({request,storage,uuid:()=> 'synthetic'})};
}
for(const provider of ['outlook','teams-chat'])test('multi-page UI client binds scope, budget and reload journal '+provider,async()=>{
 const f=fixture(provider),client=f.make();assert.equal((await client.submit(f.selection,microsoftPagesObjective)).result.status,'verified');
 const body=f.calls.find(c=>c.path==='/missions').o.body;
 assert.deepEqual(body.budgets,{maxWaves:4,maxActions:4});assert.deepEqual(body.authorization.grants,['read_only','high_impact']);
 const j=JSON.parse([...f.records.values()][0]);assert.equal(j.version,2);assert.equal(j.selection.maxPages,4);assert.equal(j.objective,microsoftPagesObjective);assert.doesNotMatch(JSON.stringify(j),/title|synthetic-secret|refreshToken/);
 assert.equal((await f.make().reconcile()).result.status,'verified');assert.equal(f.calls.filter(c=>c.path.endsWith('/run')).length,1);
});
for(const fault of ['wrong-account','unfinished','single-page'])test('multi-page UI client withholds unbound result '+fault,async()=>{const f=fixture('outlook',fault);await assert.rejects(f.make().submit(f.selection,microsoftPagesObjective),/MS_RESULT_UNBOUND/);});
test('page-limit pause never fetches or displays a completed result',async()=>{const f=fixture('outlook','limit');const r=await f.make().submit(f.selection,microsoftPagesObjective);assert.equal(r.mission.status,'PAUSED');assert.equal(r.result.status,'unverified');assert.equal(f.calls.some(c=>c.path.endsWith('/verified-microsoft-collection')),false);await assert.rejects(f.make().continuePaused(),/MS_CONTINUATION_UNSAFE/);});
test('multi-page original limit cannot change during request recovery',async()=>{const f=fixture('outlook','lost-create');await assert.rejects(f.make().submit(f.selection,microsoftPagesObjective));f.selection.maxPages=5;assert.equal((await f.make().reconcile()).mission.microsoftCollection.maxPages,4);assert.equal(f.calls.filter(c=>c.path==='/missions').length,1);});
for(const n of [0,51,1.5,'4',null])test('multi-page UI rejects invalid page count '+String(n),async()=>{const f=fixture();await assert.rejects(f.make().submit({...f.selection,maxPages:n},microsoftPagesObjective),/MS_OBJECTIVE_UNSUPPORTED/);assert.equal(f.calls.length,0);});
test('extra clause is never discarded by multi-page UI',async()=>{const f=fixture();await assert.rejects(f.make().submit(f.selection,microsoftPagesObjective+' 그리고 발송해.'),/MS_OBJECTIVE_UNSUPPORTED/);assert.equal(f.calls.length,0);});

test('existing partial cursor prevents a new multi-page request without discarding history',async()=>{const f=fixture('outlook','prior-partial');await assert.rejects(f.make().submit(f.selection,microsoftPagesObjective),/MS_PRIOR_COLLECTION_PENDING/);assert.equal(f.calls.some(c=>c.path==='/missions'),false);assert.equal(f.calls.some(c=>c.path==='/owner-session/activate'),false);});

test('cancel during multi-page progress lookup never creates a Mission',async()=>{
 const f=fixture();let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const request=async(path,o)=>{if(path==='/personal-inbox/microsoft/progress'){entered();await wait;}return f.request(path,o);};
 const c=createMicrosoftMissionClient({request,storage:f.storage,uuid:()=> 'cancel-progress'});
 const run=c.submit(f.selection,microsoftPagesObjective);await started;
 assert.equal((await c.cancel()).cancelledBeforeCreation,true);release();assert.equal((await run).cancelledBeforeCreation,true);
 assert.equal(f.calls.some(c=>c.path==='/missions'),false);assert.equal(c.pending(),false);
});

for(const maxPages of [0,4,51,1.5,'5'])test('page limit amendment rejects unsafe total '+maxPages,async()=>{
 const f=fixture('outlook','limit'),client=f.make();await client.submit(f.selection,microsoftPagesObjective);
 await assert.rejects(client.extendLimit(maxPages),/MS_CONTINUATION_UNSAFE/);
 assert.equal(f.calls.some(c=>c.path.endsWith('/extend-microsoft-collection')),false);
});
test('page limit amendment never elevates a read-only owner',async()=>{
 const f=fixture('outlook','limit'),client=createMicrosoftMissionClient({storage:f.storage,uuid:()=> 'owner-test',request:async(path,o)=>path==='/owner-session'?{active:true,session:{sessionId:'owner',grants:['read_only'],expiresAt:'2099-01-01T00:00:00Z'}}:f.request(path,o)});
 await client.submit(f.selection,microsoftPagesObjective);await assert.rejects(client.extendLimit(5),/MS_OWNER_REQUIRED/);
 assert.equal(f.calls.some(c=>c.path.endsWith('/extend-microsoft-collection')),false);
});
