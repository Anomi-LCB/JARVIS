import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {missionRequest} from '../src/ui/workspace/model.js';
import {verifyReadOnlyListing} from '../packages/core/src/mission/read-only-listing-proof.js';
import {buildMissionPlanningPrompt} from '../packages/core/src/mission/mission-planner.js';

test('workspace request finishes from independent enumeration and exclusive read trace; extra demands stay unsupported',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-listing-proof-')),workspace=join(root,'workspace');
 const {mkdirSync}=await import('node:fs');mkdirSync(workspace);mkdirSync(join(workspace,'nested'));writeFileSync(join(workspace,'alpha.txt'),'synthetic');
 for(let i=0;i<150;i++)writeFileSync(join(workspace,`item-${i}.txt`),'synthetic');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const planner={async planNextWave(c){if(c.observations.filter(o=>o.outcome==='success').length>=2)return {decision:'complete',summary:'관측 완료',actions:[],criteriaAssessment:c.mission.successCriteria.map(r=>({criterionId:r.criterionId,status:'satisfied',evidenceActionIds:[c.observations.filter(o=>o.outcome==='success').at(-1).actionId]}))};return {decision:'continue',summary:'파일 목록',actions:[{id:'list-first',title:'목록 조회',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'목록 조회'},{id:'list-again',title:'목록 재조회',command:'작업 폴더 파일 목록 확인해줘',expectedToolName:'filesystem.listFiles',dependencies:['list-first'],successSignal:'목록 재조회'}],criteriaAssessment:[]};}};
 const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,env:{},missionPlanner:planner,workerDaemonEnabled:false});
 const objective='작업 폴더의 파일 목록을 보여줘. 파일을 생성하거나 수정하지 마.';
 const created=runtime.missionRuntime.createMission(missionRequest(objective,{key:'workspace_listing_proof',conversationId:'isolated'}));
 const result=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(result.status,'COMPLETED',JSON.stringify({reason:result.stopReason,summary:result.verificationSummary,contract:result.goalContract}));
 assert.equal(result.verificationStatus,'passed');assert.equal(result.goalCompletionCoverage.sourceBindingVerified,true);
 const mission=runtime.missionRuntime.missions.get(created.missionId),proof=()=>verifyReadOnlyListing({mission,allowedRoots:[workspace]});assert.equal(proof().passed,true);assert.equal(mission.waves.flatMap(w=>w.actions).length,2);
 const baseline=structuredClone(mission);
 assert.equal(verifyReadOnlyListing({mission,allowedRoots:[workspace],evidenceActionIds:[mission.waves[0].actions[0].actionId]}).passed,false);
 mission.waves[0].actions[0].status='failed';assert.equal(proof().passed,false);Object.assign(mission,structuredClone(baseline));
 const promptObservations=structuredClone(mission.observations);promptObservations.find(o=>o.toolName==='filesystem.listFiles').data.listingItems.push({name:'PROOF_ONLY_DO_NOT_SEND.txt',type:'file'});
 assert.doesNotMatch(buildMissionPlanningPrompt({mission,capabilities:[],observations:promptObservations,today:new Date().toISOString()}),/PROOF_ONLY_DO_NOT_SEND/);
 assert.equal(mission.observations.find(o=>o.toolName==='filesystem.listFiles').data.items.length,30);
 assert.equal(mission.observations.find(o=>o.toolName==='filesystem.listFiles').data.listingItems.length,152);
 mission.observations.filter(o=>o.toolName==='filesystem.listFiles').at(-1).data.listingItems[0].name='forged.txt';assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));mission.observations.at(-1).data.listingTruncated=true;assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));mission.waves[0].actions[0].operation.dispatch.arguments.directory=root;assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));mission.constraints.push({statement:'메일도 보내라'});assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));mission.waves[0].actions.push({...mission.waves[0].actions[0],actualToolName:'filesystem.createTextFile'});assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));writeFileSync(join(workspace,'changed.txt'),'new');assert.equal(proof().passed,false);
 Object.assign(mission,structuredClone(baseline));mission.objective+=' 메일로 보내줘.';assert.equal(proof().applicable,false);
});


test('listing adapter bounds requests and exposes incomplete enumeration',async t=>{
 const {FileListToolAdapter}=await import('../apps/pc-agent/src/pc-agent-runtime.js');
 const root=mkdtempSync(join(tmpdir(),'jarvis-listing-limit-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(let i=0;i<1001;i++)writeFileSync(join(root,`entry-${i}.txt`),'synthetic');
 const adapter=new FileListToolAdapter({allowedRoots:[root]});
 const limited=await adapter.execute({directory:root,maxItems:100});
 assert.equal(limited.listedItems.length,100);assert.equal(limited.listingTotalEntries,1001);assert.equal(limited.listingTruncated,true);
 const excessive=await adapter.execute({directory:root,maxItems:1000000});
 assert.equal(excessive.listedItems.length,1000);assert.equal(excessive.listingTruncated,true);
 const view=(await import('../src/ui/workspace/model.js')).taskView({status:'PAUSED',observations:[{toolName:'filesystem.listFiles',outcome:'success',verification:{status:'passed'},data:{listingItems:limited.listedItems,listingTotalEntries:limited.listingTotalEntries,listingTruncated:limited.listingTruncated}}]});
 assert.equal(view.fileListings[0].truncated,true);assert.equal(view.fileListings[0].total,1001);
});
