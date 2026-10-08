import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
import {coreServiceRuntimeOptionsFromEnv} from '../scripts/core-service-runtime.mjs';
const serviceId='service:11111111-1111-4111-8111-111111111111',other='service:22222222-2222-4222-8222-222222222222';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-service-binding-'));let now=Date.parse('2026-10-08T00:00:00Z');const clock=()=>new Date(now),ops=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite'),clock}),store=new SqliteMissionStore({operationsStore:ops,clock});t.after(()=>{ops.close();rmSync(root,{recursive:true,force:true});});return {store,ops,advance:()=>now+=5000};}
const claim=(s,ownerId,extra={})=>s.acquireCoreAuthority({ownerId,expectedToken:0,ttlMs:1000,serviceId,...extra});
test('enrolled service repeats same bootstrap config, fences competing owners and survives DB reopen',t=>{
 const {store,ops}=fixture(t),a=claim(store,'first');assert.equal(a.token,1);assert.equal(claim(store,'competitor'),null);store.releaseCoreAuthority(a);
 const reopened=new SqliteMissionStore({operationsStore:ops}),b=claim(reopened,'second');assert.equal(b.token,2);assert.throws(()=>store.assertCoreAuthority(a),/STALE_FENCE/);store.releaseCoreAuthority(b);
 assert.throws(()=>claim(store,'different',{serviceId:other,expectedToken:2}),/CONTINUATION_DENIED/);assert.equal(store.coreAuthorityStatus().token,2);
 assert.throws(()=>claim(store,'changed-bootstrap',{expectedToken:2}),/CONTINUATION_DENIED/);assert.equal(store.coreAuthorityStatus().token,2);
 const c=store.acquireCoreAuthority({ownerId:'manual-approved-transfer',expectedToken:2,ttlMs:1000});assert.equal(c.token,3);store.releaseCoreAuthority(c);
 assert.throws(()=>claim(store,'old-service',{expectedToken:3}),/CONTINUATION_DENIED/);assert.equal(store.coreAuthorityStatus().ownerId,null);
});
test('service continuation respects expired fence, active Mission and uncertain effects',t=>{
 const f=fixture(t),a=claim(f.store,'expired');f.advance();const b=claim(f.store,'replacement');assert.equal(b.token,2);assert.throws(()=>f.store.assertCoreAuthority(a),/STALE_FENCE/);f.store.releaseCoreAuthority(b);
 f.store.db.prepare('UPDATE mission_sqlite_snapshot SET body=? WHERE id=1').run(JSON.stringify([{status:'RUNNING'}]));
 assert.throws(()=>claim(f.store,'blocked'),/MISSIONS_ACTIVE/);assert.equal(f.store.coreAuthorityStatus().token,2);
 const recovery=claim(f.store,'recovery',{recoveryOnly:true});assert.equal(recovery.token,3);
 f.store.db.prepare("UPDATE mission_sqlite_snapshot SET body='[]' WHERE id=1").run();f.store.releaseCoreAuthority(recovery);
 const now='2026-10-08T00:00:00Z';f.store.db.prepare('INSERT INTO mission_effects(effect_id,mission_id,operation_id,request_sha256,intent_sha256,intent_json,state,resource_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('e','m','o','hash','hash','{}','uncertain','resource',now,now);
 assert.throws(()=>claim(f.store,'uncertain-blocked'),/RECONCILIATION_REQUIRED/);assert.equal(f.store.coreAuthorityStatus().token,3);
});
test('initial service enrollment needs exact prior token and rejects malformed IDs',t=>{
 const {store}=fixture(t);assert.throws(()=>claim(store,'stale',{expectedToken:1}),/REVISION_CONFLICT/);
 for(const id of ['',other.toUpperCase(),'service:anything',{},123])assert.throws(()=>claim(store,'invalid',{serviceId:id}),/ID_INVALID/);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mission_service_authority').get().n,0);
});
test('service continuation configuration requires owned Windows pipe and existing strict authority config',()=>{
 const env={JARVIS_WINDOWS_SERVICE:'1',JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1',JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID:serviceId,JARVIS_CORE_MISSION_AUTHORITY_ENABLED:'1',JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_MISSION_AUTHORITY_EXPECTED_TOKEN:'0'};
 assert.equal(coreServiceRuntimeOptionsFromEnv({env}).missionAuthorityServiceId,serviceId);
 for(const key of ['JARVIS_WINDOWS_SERVICE','JARVIS_CORE_SERVICE_STDIN_SHUTDOWN','JARVIS_CORE_MISSION_AUTHORITY_ENABLED'])assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...env,[key]:'0'}}),/CONFIGURATION_REQUIRED/);
 assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{...env,JARVIS_CORE_MISSION_AUTHORITY_SERVICE_ID:''}}),/CONFIGURATION_REQUIRED/);
});
