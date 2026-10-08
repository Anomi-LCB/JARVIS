import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {normalizeStrictIsoInstant} from '../packages/shared/src/strict-iso-instant.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-source-time-'));const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date('2026-10-07T00:00:00Z')});t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});return {store,inbox:new PersonalSourceInbox(store)};}
const page={provider:'google-calendar',account:'synthetic-time',scope:'calendar.read',cursor:null,nextCursor:'next',observedAt:'2026-10-01T00:00:00Z',items:[{id:'event',title:'시각 검증',start:'2026-10-08T00:00:00Z'}]};
for(const observedAt of ['2026-02-30T00:00:00Z','2026-02-29T00:00:00Z','2026-10-01T24:00:00Z','2026-10-01T00:00:00-00:00','2026-10-01 00:00:00Z','2026-10-01T00:00:00.0001Z'])test('invalid imported observation never alters source or cursor: '+observedAt,t=>{
 const {store,inbox}=fixture(t);inbox.ingest(page);
 assert.throws(()=>inbox.ingest({...page,cursor:'next',nextCursor:'after',observedAt,items:[{id:'other',title:'should not persist'}]}),/A_SOURCE_TIME_INVALID/);
 assert.equal(inbox.list().length,1);assert.equal(store.db.prepare('SELECT cursor FROM personal_source_streams').get().cursor,'next');
});
test('source supports explicit minute precision while deadline retains required seconds',t=>{
 const {store,inbox}=fixture(t);inbox.ingest({...page,observedAt:'2026-10-01T12:30+09:00'});
 assert.equal(inbox.list()[0].observedAt,'2026-10-01T03:30:00.000Z');
 assert.throws(()=>store.createCommitment({title:'minute',dueAt:'2026-10-01T12:30+09:00',sourceRef:'synthetic'}),/A_PERSONAL_OPS_INVALID/);
});
test('Gregorian centuries and UTC four-digit storage boundary are explicit',()=>{
 for(const v of ['1900-02-29T00:00:00Z','2100-02-29T00:00:00Z','2026-01-01T00:60:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00+09:60','0000-01-01T00:00:00+01:00','9999-12-31T23:59:59-01:00'])assert.equal(normalizeStrictIsoInstant(v),null,v);
 for(const [v,expected] of [['2000-02-29T12:00:00Z','2000-02-29T12:00:00.000Z'],['0096-02-29T12:00:00Z','0096-02-29T12:00:00.000Z']])assert.equal(normalizeStrictIsoInstant(v),expected);
});
test('actual authenticated Core rejects invalid acceptance and deadline changes without effects',async t=>{
 const {store,inbox}=fixture(t);inbox.ingest(page);
 const server=createCoreServer(undefined,{adminToken:'synthetic-time-admin',personalOperations:{store},personalInbox:inbox});await listenOnFetchSafePort(server);
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer synthetic-time-admin','content-type':'application/json'};
 const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}),id=inbox.list()[0].id;
 assert.equal((await post('/personal-inbox/accept',{id,dueAt:'2026-02-30T00:00:00Z'})).status,409);
 assert.equal(store.summary().commitments.length,0);
 const good=await post('/personal-inbox/accept',{id,dueAt:'2026-10-08T09:00:00+09:00'});assert.equal(good.status,200);const commitment=await good.json();
 assert.equal(commitment.dueAt,'2026-10-08T00:00:00.000Z');
 const path='/personal-operations/commitments/'+commitment.id+'/deadline';
 assert.equal((await post(path,{dueAt:'2026-10-08T24:00:00Z',expectedRevision:1,changeId:'bad'})).status,400);
 assert.equal(store.deadlineChangeReceipt('bad'),null);
 assert.equal(store.summary().commitments[0].due_at,'2026-10-08T00:00:00.000Z');
 const changed=await post(path,{dueAt:'2026-10-09T09:00:00+09:00',expectedRevision:1,changeId:'good'});assert.equal(changed.status,200);
 assert.equal(store.deadlineChangeReceipt('good').dueAt,'2026-10-09T00:00:00.000Z');
});
for(const dueAt of ['2026-02-30T00:00:00Z','2026-10-01T24:00:00Z','2026-10-01T00:00:00-00:00'])test('invalid commitment deadline is not calendar-normalized: '+dueAt,t=>{
 const {store,inbox}=fixture(t);inbox.ingest(page);
 assert.throws(()=>inbox.accept({id:inbox.list()[0].id,dueAt}),/A_PERSONAL_OPS_INVALID/);
 assert.equal(store.summary().commitments.length,0);assert.equal(inbox.list()[0].commitmentId,null);
});
for(const [supplied,expected] of [['2024-02-29T23:59:59.1+09:00','2024-02-29T14:59:59.100Z'],['2026-12-31T23:30:00-03:00','2027-01-01T02:30:00.000Z'],['2026-10-07T00:15:00+05:45','2026-10-06T18:30:00.000Z']])test('valid instant preserves independently specified UTC: '+supplied,t=>{
 const {store,inbox}=fixture(t);inbox.ingest({...page,observedAt:supplied});assert.equal(inbox.list()[0].observedAt,expected);
 const c=inbox.accept({id:inbox.list()[0].id,dueAt:supplied});assert.equal(c.dueAt,expected);assert.equal(store.summary().commitments.length,1);
});
