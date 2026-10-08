import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {createHmac} from 'node:crypto';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {MicrosoftCollectionEffects} from '../packages/core/src/personal-operations/microsoft-collection-effects.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {MissionExecutionAuthority} from '../packages/core/src/mission/mission-execution-authority.js';
const sign=text=>createHmac('sha256','synthetic-abandon-key').update(text).digest('hex'),signer={keyId:'synthetic',sign,verify:(text,s)=>sign(text)===s};
for(const provider of ['outlook','teams-chat'])for(const mode of ['in-flight','uncertain','missing-claim','tampered-claim','changed-intent','receipt-present','same-owner','signer-fails','committed','expired-recovery'])test('fenced noncommit recovery '+provider+' '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-abandon-'));let now=Date.now();const store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock:()=>new Date(now)}),inbox=new PersonalSourceInbox(store),sql=new SqliteMissionStore({operationsStore:store,clock:()=>new Date(now)});
 t.after(async()=>{store.close();const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('jarvis-ms-abandon-'));await rm(path,{recursive:true,force:true});});
 const old=new MissionExecutionAuthority({store:sql,ownerId:'old',ttlMs:30});old.activate({expectedToken:0,heartbeat:false});
 const ledger=new MicrosoftCollectionEffects({store,inbox,signer,authority:old}),binding={operationId:'op',missionId:'mission',actionId:'action',taskId:'task',goalRevision:1,authorizationRevision:1},request={provider,connectionId:'synthetic',...(provider==='teams-chat'?{chatId:'synthetic-chat'}:{})};
 ledger.claim(binding,request);if(mode==='uncertain')ledger.uncertain(binding);
 assert.throws(()=>ledger.abandonUncommitted('op'),/RECOVERY_ONLY_REQUIRED/);
 if(mode==='missing-claim')store.db.prepare('DELETE FROM microsoft_collection_claims').run();
 if(mode==='tampered-claim')store.db.prepare("UPDATE microsoft_collection_claims SET signature='bad'").run();
 if(mode==='changed-intent')store.db.prepare("UPDATE microsoft_collection_effects SET resource_id='other'").run();
 if(mode==='receipt-present')store.db.prepare("UPDATE microsoft_collection_effects SET receipt='{}'").run();
 now+=100;if(mode!=='committed')assert.throws(()=>sql.acquireCoreAuthority({ownerId:'normal',expectedToken:1}),/RECONCILIATION_REQUIRED/);
 if(mode==='committed')store.db.prepare("UPDATE microsoft_collection_effects SET state='committed'").run();
 const next=new MissionExecutionAuthority({store:sql,ownerId:mode==='same-owner'?'old':'recovery',ttlMs:30000});next.activate({expectedToken:1,heartbeat:false,recoveryOnly:true});
 const recovery=new MicrosoftCollectionEffects({store,inbox,authority:next,signer:mode==='signer-fails'?{...signer,sign(){throw Error('synthetic signer unavailable');}}:signer});
 if(mode==='expired-recovery')now+=40000;
 if(!['in-flight','uncertain'].includes(mode)){assert.throws(()=>recovery.abandonUncommitted('op'));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM microsoft_collection_effects').get().n,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM microsoft_collection_abandoned').get().n,0);return;}
 assert.deepEqual(recovery.abandonUncommitted('op'),{status:'not-committed',operationId:'op',replayed:false,completed:false});assert.equal(recovery.abandonUncommitted('op').replayed,true);
 const archived=store.db.prepare('SELECT signature FROM microsoft_collection_abandoned WHERE operation_id=?').get('op');store.db.prepare("UPDATE microsoft_collection_abandoned SET signature='tampered'").run();assert.throws(()=>recovery.abandonUncommitted('op'),/PROOF_REQUIRED/);store.db.prepare('UPDATE microsoft_collection_abandoned SET signature=?').run(archived.signature);
 assert.equal(inbox.list().length,0);assert.throws(()=>ledger.claim(binding,request),/ALREADY_ABANDONED/);assert.throws(()=>ledger.recover(binding,request),/PROOF_REQUIRED/);
 store.db.exec('BEGIN IMMEDIATE');try{assert.throws(()=>ledger.commit(binding,request,{}),/STALE_FENCE/);}finally{store.db.exec('ROLLBACK');}
 next.release();const normal=new MissionExecutionAuthority({store:sql,ownerId:'new',ttlMs:30000});normal.activate({expectedToken:2,heartbeat:false});
 const fresh=new MicrosoftCollectionEffects({store,inbox,signer,authority:normal});fresh.claim({...binding,operationId:'new-operation'},request);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM microsoft_collection_abandoned').get().n,1);
});
