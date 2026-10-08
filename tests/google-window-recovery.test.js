import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GoogleInboxSync} from '../packages/core/src/personal-operations/google-sync.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-recovery-')),store=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let account='isolated@example.test',calls=0,now=new Date('2026-10-08T00:00:00Z'),scopeDenied=false,onAccount=null;
 const client={configured:()=>true,account:async()=>{calls++;onAccount?.();return account;},page:async job=>({items:job.provider==='gmail'?[{id:'retained',title:'기존 자료'}]:[],nextCursor:job.provider==='gmail'?'pending-cursor':null})};
 const sync=new GoogleInboxSync({inbox,client,clock:()=>now,evidence:{window:(provider,range)=>{if(scopeDenied)throw Error('A_GOOGLE_READ_SCOPE_DENIED');return range;},before:()=>null,failed:()=>{},status:()=>[]}});
 await sync.run();const row=store.db.prepare('SELECT id,body FROM personal_google_jobs').all().find(row=>JSON.parse(row.body).provider==='gmail'),job=JSON.parse(row.body);
 job.timeMin='2026-09-24T00:00:00.456Z';job.timeMax='2026-10-08T00:00:00.789Z';store.db.prepare('UPDATE personal_google_jobs SET body=? WHERE id=?').run(JSON.stringify(job),row.id);
 now=new Date('2026-10-08T00:01:00Z');
 const request=sync.status().recoveryOptions.find(x=>x.provider==='gmail');
 const input={provider:request.provider,expectedWindowId:request.expectedWindowId,expectedGeneration:request.expectedGeneration};
 return {root,store,inbox,sync,client,input,job,id:row.id,calls:()=>calls,setAccount:x=>account=x,setScopeDenied:()=>scopeDenied=true,onAccount:fn=>onAccount=fn,setClock:x=>now=new Date(x)};
}

test('recovery atomically preserves source items and original checkpoint, then new reads resume without duplication',async t=>{
 const f=await fixture(t),originalItems=f.inbox.list();const result=await f.sync.restartWindow(f.input);
 assert.equal(result.sourceItemsPreserved,true);assert.equal(result.collectionStarted,false);assert.equal(result.providerGrantChanged,false);
 assert.notEqual(result.windowId,f.job.windowId);assert.equal(result.timeMin,'2026-09-24T00:00:01.000Z');assert.equal(result.timeMax,'2026-10-08T00:00:00.000Z');
 assert.deepEqual(f.inbox.list(),originalItems);
 const saved=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_window_recoveries').get().body);assert.deepEqual(saved.originalJob,f.job);assert.equal(saved.originalStream.cursor,'pending-cursor');
 const next=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body);assert.equal(next.cursor,null);assert.equal(next.observedAt,'2026-10-08T00:01:00.000Z');
 const beforeReplay=f.calls(),replayed=await f.sync.restartWindow(f.input);assert.equal(replayed.replayed,true);assert.equal(replayed.currentWindowVerified,false);assert.equal(f.calls(),beforeReplay);
 f.client.page=async job=>({items:job.provider==='gmail'?[{id:'retained',title:'기존 자료'},{id:'new',title:'새 자료'}]:[],nextCursor:null});
 assert.equal((await f.sync.run()).status,'ready');assert.equal(f.inbox.list().length,2);
 const cursor=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body);
 await f.sync.restartWindow(f.input);assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body),cursor);
});

for(const [name,mutate,code]of [
 ['wrong account',f=>f.setAccount('other@example.test'),'A_GOOGLE_RECOVERY_CONFLICT'],
 ['scope revoked',f=>f.setScopeDenied(),'A_GOOGLE_READ_SCOPE_DENIED'],
 ['paused collection',f=>f.sync.pauseCollection(),'A_GOOGLE_RECOVERY_PAUSED'],
 ['generation changed',f=>{f.sync.pauseCollection();f.sync.resumeAfterVerifiedConnection();},'A_GOOGLE_RECOVERY_CONFLICT'],
 ['clock not advanced',f=>f.setClock('2026-10-08T00:00:00Z'),'A_GOOGLE_RECOVERY_CLOCK_NOT_ADVANCED'],
 ['another worker lease',f=>f.store.db.prepare('INSERT OR REPLACE INTO personal_google_lock VALUES(1,?,?)').run('other-worker',Date.now()+60000),'A_GOOGLE_RECOVERY_BUSY'],
 ['pause during identity read',f=>f.onAccount(()=>f.sync.pauseCollection()),'A_GOOGLE_RECOVERY_PAUSED'],
 ['source cursor changed',f=>f.store.db.prepare("UPDATE personal_source_streams SET cursor='another-cursor' WHERE provider='gmail'").run(),'A_GOOGLE_RECOVERY_SOURCE_CONFLICT']
])test(`recovery denies ${name} without changing the checkpoint or items`,async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body,items=f.inbox.list();mutate(f);
 await assert.rejects(f.sync.restartWindow(f.input),{message:code});
 assert.equal(f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body,before);assert.deepEqual(f.inbox.list(),items);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM personal_google_window_recoveries').get().n,0);
});

test('archive write failure rolls back generation, source cursor and checkpoint',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body,generation=f.input.expectedGeneration;
 f.store.db.exec("CREATE TRIGGER recovery_fail BEFORE INSERT ON personal_google_window_recoveries BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 await assert.rejects(f.sync.restartWindow(f.input));
 assert.equal(f.store.db.prepare('SELECT revision FROM personal_google_sync_generation').get().revision,generation);
 assert.equal(f.store.db.prepare('SELECT cursor FROM personal_source_streams WHERE provider=?').get('gmail').cursor,'pending-cursor');
 assert.equal(f.store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(f.id).body,before);
});

test('historical acknowledgement cannot expose arbitrary stored receipt fields or start collection',async t=>{
 const f=await fixture(t);await f.sync.restartWindow(f.input);
 const row=f.store.db.prepare('SELECT body FROM personal_google_window_recoveries').get(),record=JSON.parse(row.body);
 record.receipt={secret:'private-cursor',collectionStarted:true,currentWindowVerified:true,executionAuthority:true};
 f.store.db.prepare('UPDATE personal_google_window_recoveries SET body=?').run(JSON.stringify(record));
 const before=f.calls(),ack=await f.sync.restartWindow(f.input);
 assert.equal(ack.replayed,true);assert.equal(ack.collectionStarted,false);assert.equal(ack.currentWindowVerified,false);assert.equal(ack.executionAuthority,false);
 assert.equal(f.calls(),before);assert.doesNotMatch(JSON.stringify(ack),/private-cursor|secret|isolated@example/);
});

test('historical acknowledgement rejects a replacement for a different account',async t=>{
 const f=await fixture(t);await f.sync.restartWindow(f.input);
 const record=JSON.parse(f.store.db.prepare('SELECT body FROM personal_google_window_recoveries').get().body);
 record.replacementJob.account='different@example.test';f.store.db.prepare('UPDATE personal_google_window_recoveries SET body=?').run(JSON.stringify(record));
 await assert.rejects(f.sync.restartWindow(f.input),{message:'A_GOOGLE_RECOVERY_CONFLICT'});
});

test('authenticated Core recovery endpoint uses exact versions and returns only a local recovery receipt',async t=>{
 const f=await fixture(t),server=createCoreServer(undefined,{adminToken:'isolated-recovery-admin',googleSync:f.sync,personalInbox:f.inbox});
 const a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-google/restart-window`;
 t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(f.input)})).status,401);
 const send=body=>fetch(url,{method:'POST',headers:{authorization:'Bearer isolated-recovery-admin','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send({...f.input,provider:'unknown'})).status,409);
 const response=await send(f.input);assert.equal(response.status,200);const body=await response.json();assert.equal(body.proof,'atomic-local-recovery');assert.equal(body.collectionStarted,false);
 assert.doesNotMatch(JSON.stringify(body),/isolated@example|pending-cursor/);
 assert.equal((await (await send(f.input)).json()).replayed,true);
});
