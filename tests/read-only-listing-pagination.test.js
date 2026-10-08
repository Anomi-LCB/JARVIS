import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { FileListToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { missionRequest } from '../src/ui/workspace/model.js';
import { verifyReadOnlyListing } from '../packages/core/src/mission/read-only-listing-proof.js';
import { exhaustiveListingItems } from '../packages/core/src/mission/listing-completeness.js';

test('ordinary Mission continues a 2505-entry listing through E/B/G without extra planner calls', async t => {
  const root = mkdtempSync(join(tmpdir(),'jarvis-listing-pages-')), workspace = join(root,'workspace');
  mkdirSync(workspace);
  for(let i=0;i<2505;i++)writeFileSync(join(workspace,`file-${String(i).padStart(5,'0')}.txt`),'synthetic');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let calls=0;
  const planner={async planNextWave(){ calls++; return {decision:'continue',summary:'첫 페이지 조회',criteriaAssessment:[],
    actions:[{id:'first',title:'파일 목록',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'목록'}]}; }};
  const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,env:{},missionPlanner:planner,workerDaemonEnabled:false});
  const created=runtime.missionRuntime.createMission(missionRequest('작업 폴더의 파일 목록을 보여줘. 파일을 생성하거나 수정하지 마.',{key:'workspace_pages',conversationId:'isolated'}));
  const result=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(result.status,'COMPLETED',JSON.stringify({stop:result.stopReason,observations:result.observations?.map(o=>({error:o.error,tool:o.toolName})),coverage:result.goalCompletionCoverage,proof:verifyReadOnlyListing({mission:runtime.missionRuntime.missions.get(created.missionId),allowedRoots:[workspace]}),pages:result.observations?.map(o=>o.data && ({total:o.data.listingTotalEntries,offset:o.data.listingOffset,snapshot:o.data.listingSnapshotSha256,more:o.data.listingHasMore,count:o.data.listingItems?.length})),actions:result.waves?.flatMap(w=>w.actions).map(a=>({status:a.status,dispatch:a.operation?.dispatch}))}));
  assert.equal(calls,1);
  const mission=runtime.missionRuntime.missions.get(created.missionId);
  assert.equal(mission.waves.flatMap(w=>w.actions).length,3);
  const proof=()=>verifyReadOnlyListing({mission,allowedRoots:[workspace]});
  assert.equal(proof().itemCount,2505);
  assert.equal(proof().evidenceActionIds.length,3);
  const baseline=structuredClone(mission), pages=()=>mission.observations.filter(o=>o.toolName==='filesystem.listFiles');
  pages().at(-1).data.listingOffset=2001;assert.equal(proof().passed,false);
  Object.assign(mission,structuredClone(baseline));pages()[1].data.listingItems[0]=pages()[0].data.listingItems[0];assert.equal(proof().passed,false);
  Object.assign(mission,structuredClone(baseline));pages()[1].data.listingSnapshotSha256='0'.repeat(64);assert.equal(proof().passed,false);
  Object.assign(mission,structuredClone(baseline));assert.equal(verifyReadOnlyListing({mission,allowedRoots:[workspace],evidenceActionIds:[proof().evidenceActionIds.at(-1)]}).passed,false);
  Object.assign(mission,structuredClone(baseline));mission.waves[0].actions[0].operation.dispatch.arguments.rawText='외부로 보내줘';assert.equal(proof().passed,false);
  Object.assign(mission,structuredClone(baseline));
  writeFileSync(join(workspace,'added-after-pages.txt'),'changed');assert.equal(proof().passed,false);
});

test('a later page or a 30-entry planner summary is never exhaustive absence evidence',()=>{
  const items=Array.from({length:30},(_,i)=>({name:`synthetic-${i}.txt`}));
  assert.equal(exhaustiveListingItems({items},{maxItems:1000}),null);
  assert.equal(exhaustiveListingItems({items:[]},{offset:1000}),null);
  assert.equal(exhaustiveListingItems({listingItems:[],listingOffset:1000,listingTotalEntries:1000}),null);
  assert.equal(exhaustiveListingItems({listingItems:items,listingTotalEntries:31}),null);
  assert.equal(exhaustiveListingItems({listingItems:items,listingTotalEntries:30,listingTruncated:true}),null);
  assert.deepEqual(exhaustiveListingItems({listingItems:items,listingTotalEntries:30,listingHasMore:false},{maxItems:30}),items);
  assert.deepEqual(exhaustiveListingItems({items:[]},{maxItems:100}),[]);
});

test('adapter rejects stale snapshots, malformed offsets and unbound later pages',async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-page-change-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'a.txt'),'synthetic');writeFileSync(join(root,'b.txt'),'synthetic');
  const adapter=new FileListToolAdapter({allowedRoots:[root]});
  const first=await adapter.execute({directory:root,maxItems:1});
  const second=await adapter.execute({directory:root,maxItems:1,offset:1,expectedListingSha256:first.listingSnapshotSha256});
  assert.equal(second.listedItems[0].name,'b.txt');assert.equal(second.listingHasMore,false);
  for(const offset of [-1,0.5,NaN,10001])assert.equal((await adapter.execute({directory:root,offset})).status,'blocked');
  assert.equal((await adapter.execute({directory:root,offset:1})).status,'blocked');
  writeFileSync(join(root,'c.txt'),'new');
  const changed=await adapter.execute({directory:root,maxItems:1,offset:1,expectedListingSha256:first.listingSnapshotSha256});
  assert.equal(changed.status,'blocked');assert.deepEqual(changed.warnings,['A_LISTING_SNAPSHOT_CHANGED']);
});
