import test from 'node:test';import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PersonalProfileStore,createPersonalContextProvider,projectPersonalContext} from '../packages/core/src/personal-operations/personal-profile.js';
import {normalizePersonalContext} from '../packages/core/src/planning/personal-context.js';
import {CoreFacade} from '../packages/core/src/core-facade.js';import {createCoreServer} from '../packages/core/src/main.mjs';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

test('selected profile relations use current encrypted revision, hide identity and disappear after correction or deletion',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-profile-relations-')),key=randomBytes(32),path=join(root,'profile','synthetic.dpapi.json');
 // Injected test cipher; this is not a Windows DPAPI observation.
 const cipher={protect:value=>{const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',key,nonce);return Buffer.concat([nonce,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64');},
  unprotect:value=>{const bytes=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(-16));return Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]).toString('utf8');},harden:()=>{}};
 const profile={version:1,ownerUserId:'local_user',source:{kind:'direct-user-statement',receivedAt:'2026-09-14T00:00:00.000Z'},
  identity:{name:'PRIVATE_SYNTHETIC_IDENTITY',country:'합성 국가',roles:[],family:'PRIVATE_SYNTHETIC_FAMILY'},sourceDocument:'PRIVATE_SYNTHETIC_DOCUMENT',
  sections:[{id:'general',scope:'general',items:['근거 구분']}],
  goals:[{id:'goal-research',scope:'strategy',title:'합성 연구 목표',detail:'명시적 목표'},{id:'goal-other',scope:'business',title:'PRIVATE_OTHER_GOAL',detail:'다른 분야'}],
  projects:[{id:'project-research',scope:'strategy',title:'합성 연구',description:'명시적 프로젝트'},{id:'project-other',scope:'business',title:'PRIVATE_OTHER_PROJECT',description:'다른 분야'}],
  relations:[{from:'local_user',type:'pursues',to:'goal-research'},{from:'project-research',type:'supports',to:'goal-research'},{from:'project-other',type:'supports',to:'goal-other'}]};
 let profileStore=new PersonalProfileStore({path,...cipher}),saved=profileStore.save(profile);
 const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 const core=new CoreFacade({workspaceRoot:root,memoryStore:growth,personalContextProvider:createPersonalContextProvider({env:{},store:profileStore})});
 const server=createCoreServer(core,{adminToken:'synthetic-profile-relations'});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();core.cognition?.close();rmSync(root,{recursive:true,force:true});});
 const task=core.createTask('합성 프로필 관계 조회');
 const read=async(entity='프로젝트:합성 연구')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/memory/knowledge/relations?`+new URLSearchParams({taskId:task.taskId,entity,depth:'3'}),{headers:{authorization:'Bearer synthetic-profile-relations'}});assert.equal(r.status,200);return r.json();};
 let graph=await read();assert.equal(graph.edges.length,2);assert.ok(graph.nodes.some(x=>x.type==='person'&&x.label==='사용자'));
 assert.ok(graph.edges.every(x=>x.sourceEventId.startsWith('profile-relation:')&&x.basis==='user-statement'));
 for(const value of ['PRIVATE_SYNTHETIC','PRIVATE_OTHER','profile-owner:'])assert.equal(JSON.stringify(graph).includes(value),false);
 assert.equal(projectPersonalContext(profileStore.load(),{rawText:'합성 연구',userId:'local_user'}).relations,undefined,'ordinary planning still excludes relations');
 const selected=projectPersonalContext(profileStore.load(),{rawText:'합성 연구',userId:'local_user',includeRelations:true});
 assert.ok(normalizePersonalContext(selected));
 for(const relation of [{from:'project-other',type:'supports',to:'goal-research'},{from:'local_user',type:'pursues',to:'goal-research'},{from:'project-research',type:'supports',to:'goal-research',privateBody:'MUST_NOT_PASS'}])
  assert.equal(normalizePersonalContext({...selected,relations:[relation]}),null);
 const question="'프로젝트:합성 연구'의 연결 관계를 3단계까지 보여줘";
 assert.ok(core.createTask(question).contextSnapshot.memoryEvidence.some(x=>x.sourceEventIds[0]?.startsWith('profile-relation:')));
 const oldIds=graph.edges.map(x=>x.sourceEventId);
 const revised=structuredClone(profile);revised.relations=[];profileStore.save(revised,{expectedRevision:saved.revision});
 graph=await read();assert.equal(graph.found,false);assert.deepEqual(graph.edges,[]);
 profileStore=new PersonalProfileStore({path,...cipher});core.personalContextProvider=createPersonalContextProvider({env:{},store:profileStore});
 assert.equal((await read()).found,false);assert.equal(JSON.stringify(await read()).includes(oldIds[0]),false);
 saved=profileStore.save(profile,{expectedRevision:profileStore.load().revision});assert.equal((await read()).edges.length,2);
 unlinkSync(path);assert.equal((await read()).found,false,'encrypted history must not reactivate deleted current profile');
 assert.equal(core.createTask(question,{userId:'different-owner'}).contextSnapshot.memoryEvidence.length,0);
});
