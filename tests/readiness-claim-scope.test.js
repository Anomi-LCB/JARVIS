import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePersonalUseReadiness,personalUseReadinessMarkdown} from '../scripts/personal-use-readiness.mjs';
const now='2026-10-08T00:00:00.000Z';
function support(){return {runtime:{status:'ready'},evidence:Object.fromEntries(['deterministicTests','systemIntegrity','coreInstaller','pcInstaller'].map(k=>[k,{status:'passed',generatedAt:now}]).concat([['llm',{liveVerified:true}]])),readiness:{paidDistributionReady:false},issues:[]};}
test('green prerequisites cannot certify personal use or broad PC and model abilities',()=>{
 const report=evaluatePersonalUseReadiness({supportBundle:support(),clock:()=>new Date(now)});
 assert.equal(report.personalReady,null);
 assert.equal(report.prerequisitesReady,true);
 assert.equal(report.advancedAiReady,null);
 assert.equal(report.liveModelConnectionVerified,true);
 for(const id of ['localPcControl','localFileAndDocumentWork','boundedAutonomousMissions','liveLlmPlanning'])assert.equal(report.capabilities[id],null,id);
 assert.equal(report.status,'local-prerequisites-ready');
 assert.match(personalUseReadinessMarkdown(report),/실사용 인수: 미검증/);
});
test('missing prerequisites remain a definite blocker rather than unknown',()=>{
 const input=support();input.runtime.status='degraded';
 const report=evaluatePersonalUseReadiness({supportBundle:input,clock:()=>new Date(now)});
 assert.equal(report.personalReady,false);assert.equal(report.prerequisitesReady,false);
 assert.equal(report.advancedAiReady,false);
});
