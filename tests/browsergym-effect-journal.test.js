import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,basename} from 'node:path';import {randomBytes} from 'node:crypto';
import {RemoteOperationStore} from '../apps/pc-agent/src/remote-operation-store.js';
import {createBrowserGymEffectJournal,inspectBrowserGymEffect} from '../scripts/benchmarks/browsergym-effect-journal.mjs';
const request=()=>({requestId:'one',episodeId:'11111111-1111-1111-1111-111111111111',expectedRevision:0,action:{kind:'click',bid:'13'}});
for(const mode of ['valid','wrong-key','wrong-task','wrong-auth','wrong-request','wrong-resource','wrong-resources','tamper','missing','uncertain','revoked','revoked-during-read'])test('historical effect lookup: '+mode,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-bg-journal-')),path=join(root,'effects.sqlite'),key=randomBytes(32);let store=new RemoteOperationStore({path}),calls=0;
 t.after(()=>{store.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('jarvis-bg-journal-'));rmSync(root,{recursive:true,force:true});});
 const r=request(),receipt={version:'browsergym-action-receipt-v1',request:r,postState:{episodeId:r.episodeId,revision:1},reward:1,terminated:true,truncated:false};
 const authorizationHash='a'.repeat(64),taskId='task';
 const journal=createBrowserGymEffectJournal({store,key,authorize:()=>true,runStep:async()=>{calls++;return receipt;}});
 await journal.execute(r,{taskId,authorizationHash,assertAccess:()=>{}});
 await assert.rejects(journal.execute(r,{taskId,authorizationHash,assertAccess:()=>{}}),/EXISTING_EFFECT/);assert.equal(calls,1);
 store.close();store=new RemoteOperationStore({path});
 const query={path,key,taskId,request:r,authorizationHash,authorize:()=>true};
 if(mode==='wrong-key')query.key=randomBytes(32);
 if(mode==='wrong-task')query.taskId='other';
 if(mode==='wrong-auth')query.authorizationHash='b'.repeat(64);
 if(mode==='wrong-request')query.request={...r,action:{kind:'noop'}};
 if(mode==='wrong-resource')store.db.exec("UPDATE remote_operations SET resource_key='other'");
 if(mode==='wrong-resources')store.db.exec("UPDATE remote_operations SET resource_keys_json='[]'");
 if(mode==='tamper'){const v=JSON.parse(store.row('bg_one').receipt_json);v.body.receipt.reward=100;store.db.prepare('UPDATE remote_operations SET receipt_json=?').run(JSON.stringify(v));}
 if(mode==='missing')store.db.exec('DELETE FROM remote_operations');
 if(mode==='uncertain')store.db.exec("UPDATE remote_operations SET state='uncertain'");
 if(mode==='revoked')query.authorize=()=>false;
 if(mode==='revoked-during-read'){let n=0;query.authorize=()=>++n===1;}
 const before=store.db.prepare('SELECT * FROM remote_operations').all();
 const result=inspectBrowserGymEffect(query);assert.equal(result.status,mode==='valid'?'historical-matched':'unresolved');
 assert.equal(result.executionAuthority,false);assert.equal(result.currentStateVerified,false);assert.equal(result.wholeMissionCompleted,false);
 assert.deepEqual(store.db.prepare('SELECT * FROM remote_operations').all(),before);
});
for(const mode of ['provider-loss','revoked-after','expired-fence'])test('unrecorded effect never redispatched after restart: '+mode,async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-bg-journal-')),path=join(root,'effects.sqlite'),key=randomBytes(32);let time=Date.now(),store=new RemoteOperationStore({path,clock:()=>new Date(time)}),allowed=true,calls=0;
 t.after(()=>{store.close();assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('jarvis-bg-journal-'));rmSync(root,{recursive:true,force:true});});
 const r=request(),authorizationHash='a'.repeat(64),context={taskId:'task',authorizationHash,assertAccess:()=>{}};
 const runStep=async()=>{calls++;if(mode==='provider-loss')throw Error('LOST');if(mode==='revoked-after')allowed=false;if(mode==='expired-fence')time+=31000;return {version:'browsergym-action-receipt-v1',request:r,postState:{episodeId:r.episodeId,revision:1}};};
 let journal=createBrowserGymEffectJournal({store,key,authorize:()=>allowed,runStep});
 await assert.rejects(journal.execute(r,context));assert.equal(store.row('bg_one').state,'uncertain');
 store.close();store=new RemoteOperationStore({path});allowed=true;
 journal=createBrowserGymEffectJournal({store,key,authorize:()=>allowed,runStep});
 await assert.rejects(journal.execute(r,context),/EXISTING_EFFECT/);assert.equal(calls,1);
 assert.equal(inspectBrowserGymEffect({path,key,...context,request:r,authorize:()=>true}).status,'unresolved');
});
