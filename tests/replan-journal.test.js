import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createReplanJournal,replanRequestFingerprint,replanRecoveryMatches} from '../src/ui/workspace/replan-journal.js';
test('replan journal stores identifiers and fingerprint without private request text',async()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const request={objective:'PRIVATE_REQUEST',successCriteria:['PRIVATE_CRITERIA'],constraints:[],budgets:{}};
 const fingerprint=await replanRequestFingerprint(request);assert.equal(fingerprint,createHash('sha256').update(JSON.stringify({...request,authorization:{mode:'supervised',grants:['read_only']}})).digest('hex'));
 const journal=createReplanJournal(storage),record={followUpId:'followup:test',expectedRevision:2,requestFingerprint:fingerprint};journal.save(record);assert.deepEqual(createReplanJournal(storage).read(),record);assert.doesNotMatch([...data.values()].join(''),/PRIVATE/);
 assert.throws(()=>journal.save({...record,objective:'private'}));journal.clear();assert.equal(journal.read(),null);
 const unavailable=createReplanJournal(null);unavailable.save(record);assert.equal(unavailable.read(),null);
});
test('replan recovery preserves exact reviewed source version without source prose',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const journal=createReplanJournal(storage),record={followUpId:'followup:test',expectedRevision:2,requestFingerprint:'a'.repeat(64),expectedSourceHash:'b'.repeat(64)};
 journal.save(record);assert.deepEqual(journal.read(),record);assert.throws(()=>journal.save({...record,expectedSourceHash:'bad'}));
 assert.throws(()=>journal.save({...record,sourceText:'PRIVATE_SOURCE'}));
});

test('lost response recovery rejects a different source and unversioned legacy source journals',()=>{
 const pending={expectedRevision:2,requestFingerprint:'a'.repeat(64),expectedSourceHash:'b'.repeat(64)};
 const current={expectedRevision:2,requestFingerprint:'a'.repeat(64),missionId:'test',dependencyCurrent:true,sourceDependency:{required:true,boundSourceHash:'b'.repeat(64)}};
 assert.equal(replanRecoveryMatches(current,pending),true);
 assert.equal(replanRecoveryMatches({...current,sourceDependency:{required:true,boundSourceHash:'c'.repeat(64)}},pending),false);
 const {expectedSourceHash,...legacy}=pending;
 assert.equal(replanRecoveryMatches(current,legacy),false);
 assert.equal(replanRecoveryMatches({...current,sourceDependency:{required:false}},legacy),true);
 assert.equal(replanRecoveryMatches({...current,sourceDependency:{required:false}},pending),false);
});
