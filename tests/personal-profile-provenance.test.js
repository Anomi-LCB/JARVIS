import test from 'node:test';import assert from 'node:assert/strict';
import {projectPersonalContext} from '../packages/core/src/personal-operations/personal-profile.js';
import {normalizePersonalContext,personalContextFingerprint,personalContextPromptSection} from '../packages/core/src/planning/personal-context.js';
test('profile projection preserves bounded provenance without identity or encrypted history contents',()=>{
 const value={revision:'synthetic-revision-1',storedAt:'2026-09-14T01:01:00.000Z',profile:{ownerUserId:'local_user',
  source:{kind:'direct-user-statement',receivedAt:'2026-09-14T01:00:00.000Z'},identity:{name:'PRIVATE_SYNTHETIC_IDENTITY'},sourceDocument:'PRIVATE_SYNTHETIC_SOURCE',
  sections:[{id:'general',scope:'general',items:['결론 우선']},{id:'theology',scope:'theology',items:['원문 대조']},{id:'other',scope:'development',items:['UNRELATED_DEVELOPMENT']}],goals:[],projects:[]}};
 const projected=projectPersonalContext(value,{userId:'local_user',rawText:'설교 연구'});
 const context=normalizePersonalContext(projected);assert.ok(context);
 assert.equal(context.provenance.observedAt,value.profile.source.receivedAt);
 assert.deepEqual(context.provenance.revisionHistory,[{action:'store-profile-revision',at:value.storedAt}]);
 assert.deepEqual(context.provenance.validity,{validUntil:null,basis:'unspecified'});
 assert.deepEqual(context.provenance.usageScope.sectionIds,['general','theology']);
 assert.match(context.provenance.usageScope.ownerScopeRef,/^[a-f0-9]{64}$/);
 assert.equal(context.provenance.executionAuthority,false);assert.equal(context.provenance.independentlyVerifiedOutcome,false);
 const prompt=personalContextPromptSection(context).join('\n');
 assert.equal(prompt.includes('PRIVATE_SYNTHETIC'),false);assert.equal(prompt.includes('UNRELATED_DEVELOPMENT'),false);
 assert.equal(projectPersonalContext(value,{userId:'other',rawText:'설교 연구'}),null);
 const extra=structuredClone(projected);extra.provenance.privateHistory='PRIVATE_SYNTHETIC_OLD_PROFILE';extra.provenance.usageScope.sectionIds=['forged-other'];
 assert.deepEqual(normalizePersonalContext(extra),context);
 for(const mutate of [p=>p.executionAuthority=true,p=>p.observedAt='invalid',p=>p.profileRevision='stale',p=>p.validity.validUntil='2199-01-01T00:00:00Z',p=>p.usageScope.ownerScopeRef='local_user']){
  const forged=structuredClone(projected);mutate(forged.provenance);assert.equal(normalizePersonalContext(forged),null);
 }
 const newer={...value,revision:'synthetic-revision-2',storedAt:'2026-09-15T00:00:00.000Z'};
 assert.notEqual(personalContextFingerprint(context),personalContextFingerprint(projectPersonalContext(newer,{userId:'local_user',rawText:'설교 연구'})));
 const legacy={...projected};delete legacy.provenance;assert.ok(normalizePersonalContext(legacy),'no fabricated provenance for legacy providers');
});
