import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { createManagedGoogleSync } from '../packages/core/src/personal-operations/google-sync-service.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
const validity={validFrom:'2026-10-01T00:00:00Z',expiresAt:'2026-11-01T00:00:00Z'};
const scope={readFrom:'2026-09-30T00:00:00Z',readUntil:'2026-10-04T00:00:00Z'};
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-read-delegation-'));let now=new Date('2026-10-02T12:00:00Z'),binding={connectionId:'synthetic-connection',revision:'revision-1'},reads=0;
  const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite'),clock:()=>now});
  let before=()=>{},after=()=>{};
  const client={configured:()=>true,account:async()=> 'synthetic@example.test',authorizationBinding:()=>binding,
    async page(job,{authorization}){before(job,authorization);sync.evidence.authorize(job,authorization);reads++;after(job);return {items:[{id:'one',title:'Synthetic',start:null}],nextCursor:null};}};
  const sync=createManagedGoogleSync({store,client,clock:()=>now,requireMandates:true}),inbox=new PersonalSourceInbox(store);
  t.after(async()=>{await sync.stop();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,sync,inbox,reads:()=>reads,setBinding:value=>{binding=value;},setNow:value=>{now=new Date(value);},before:fn=>{before=fn;},after:fn=>{after=fn;},
    configure:(provider='gmail',extra={})=>sync.evidence.configure({provider,maxPages:10,...validity,...scope,...extra})};
}
test('strict reads without a mandate perform no source page and produce no source evidence',async t=>{
  const f=setup(t),result=await f.sync.run();assert.equal(result.status,'degraded');assert.equal(f.reads(),0);assert.equal(f.inbox.list().length,0);
  assert.equal(result.providers.gmail.code,'A_GOOGLE_MANDATE_REQUIRED');assert.equal(result.providers['google-calendar'].code,'A_GOOGLE_MANDATE_REQUIRED');
  assert.equal(f.sync.evidence.status().every(row=>row.pages===0),true);
});
test('explicit scope intersects existing polling windows and both providers preserve their independent limits',async t=>{
  const f=setup(t);f.configure();f.configure('google-calendar');const jobs=[];f.before(job=>jobs.push({...job}));
  assert.equal((await f.sync.run()).status,'ready');assert.equal(f.reads(),2);assert.equal(f.inbox.list().length,2);
  assert.equal(Date.parse(jobs[0].timeMin),Date.parse(scope.readFrom));assert.equal(Date.parse(jobs[1].timeMax),Date.parse(scope.readUntil));
  for(const job of jobs){assert.ok(Date.parse(job.timeMin)>=Date.parse(scope.readFrom));assert.ok(Date.parse(job.timeMax)<=Date.parse(scope.readUntil));}
});
test('account revision changes invalidate a saved delegation instead of reusing it',async t=>{
  const f=setup(t);f.configure();f.setBinding({connectionId:'synthetic-connection',revision:'revision-2'});
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_READ_SCOPE_DENIED');assert.equal(f.reads(),0);
  f.setBinding({connectionId:'another-connection',revision:'revision-1'});
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_READ_SCOPE_DENIED');assert.equal(f.reads(),0);
});
test('missing scope, inverted range and subsecond boundaries do not create a mandate',t=>{
  const f=setup(t);
  for(const extra of [{readFrom:undefined},{readUntil:scope.readFrom},{readFrom:'2026-09-30T00:00:00.001Z'},{readFrom:'2026-02-31T00:00:00Z'}])assert.throws(()=>f.configure('gmail',extra),/READ_SCOPE_DENIED/u);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM personal_mandates').get().n,0);
});
test('revocation between reservation and dispatch makes no provider read and retains conservative accounting',async t=>{
  const f=setup(t),q=f.configure();f.before(()=>f.store.revokeMandate(q.mandate.id));
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_MANDATE_DENIED');assert.equal(f.reads(),0);assert.equal(f.inbox.list().length,0);
  assert.equal(f.sync.evidence.status()[0].latest.state,'failed');
});
test('query range expanded after reservation is rejected at the actual dispatch gate',async t=>{
  const f=setup(t);f.configure();f.before(job=>{job.timeMax='2099-01-01T00:00:00Z';});
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_READ_SCOPE_DENIED');assert.equal(f.reads(),0);assert.equal(f.inbox.list().length,0);
});
test('revocation while provider is reading prevents returned source material and checkpoint from committing',async t=>{
  const f=setup(t),q=f.configure();f.after(()=>f.store.revokeMandate(q.mandate.id));
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_MANDATE_DENIED');assert.equal(f.reads(),1);assert.equal(f.inbox.list().length,0);
  assert.equal(f.sync.evidence.status()[0].committedPages,0);
  const job=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_jobs').get().body);assert.equal(job.complete,false);
});
test('an expired delegation cannot dispatch and an explicit replacement requires the current mandate',async t=>{
  const f=setup(t),q=f.configure();f.setNow(validity.expiresAt);
  assert.equal((await f.sync.run()).providers.gmail.code,'A_GOOGLE_MANDATE_DENIED');assert.equal(f.reads(),0);
  assert.throws(()=>f.configure('gmail',{expiresAt:'2026-12-01T00:00:00Z'}),/BINDING_CONFLICT/u);
  const replacement=f.configure('gmail',{replaceMandateId:q.mandate.id,expiresAt:'2026-12-01T00:00:00Z'});
  assert.notEqual(replacement.mandate.id,q.mandate.id);
});
