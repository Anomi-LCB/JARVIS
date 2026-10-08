import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { missionRequest } from '../src/ui/workspace/model.js';
import { verifyReadOnlyListing } from '../packages/core/src/mission/read-only-listing-proof.js';

const cases = Object.freeze([0,152,2505].map(count=>({id:`listing-${count}`,count,
  objective:'작업 폴더의 파일 목록을 보여줘. 파일을 생성하거나 수정하지 마.',
  expectedStatus:'COMPLETED',expectedActions:Math.max(1,Math.ceil(count/1000))})));
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');

export async function evaluateListingPagination({repetitions=3}={}) {
  if (!Number.isInteger(repetitions)||repetitions<1||repetitions>3) throw new Error('INVALID_REPETITIONS');
  const results=[];
  for(const c of cases) for(let repetition=1;repetition<=repetitions;repetition++) {
    const root=await mkdtemp(join(tmpdir(),'jarvis-listing-eval-')),workspace=join(root,'workspace');
    try {
      await mkdir(workspace);
      const names=Array.from({length:c.count},(_,i)=>`file-${String(i).padStart(5,'0')}.txt`);
      // Setup is excluded from request-to-result latency and never touches personal files.
      for(const name of names) await writeFile(join(workspace,name),'synthetic');
      let plannerCalls=0;
      const planner={async planNextWave(){plannerCalls++;return {decision:'continue',summary:'고정 시험 입력의 첫 조회',criteriaAssessment:[],
        actions:[{id:'initial',title:'목록 조회',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',dependencies:[],successSignal:'목록'}]};}};
      const runtime=createAgRuntime({allowedRoots:[workspace],auditRoot:join(root,'audit'),cwd:()=>workspace,env:{},missionPlanner:planner,workerDaemonEnabled:false});
      const started=performance.now();
      const created=runtime.missionRuntime.createMission(missionRequest(c.objective,{key:`eval_${c.id}_${repetition}`,conversationId:'isolated'}));
      const result=await runtime.missionRuntime.runMission(created.missionId);
      const elapsed=performance.now()-started;
      const mission=runtime.missionRuntime.missions.get(created.missionId);
      const proof=verifyReadOnlyListing({mission,allowedRoots:[workspace]});
      const actions=mission.waves.flatMap(w=>w.actions??[]);
      const listingObservations=result.observations.filter(o=>Array.isArray(o.data?.listingItems));
      // Parallel reads may finish out of order. Reassemble using verified offsets;
      // keep arrival order as evidence instead of assuming completion chronology.
      const items=[...listingObservations].sort((a,b)=>a.data.listingOffset-b.data.listingOffset).flatMap(o=>o.data.listingItems);
      const checks={completion:result.status===c.expectedStatus,independentEnumeration:proof.passed===true&&proof.itemCount===c.count,
        exactNames:items.length===names.length&&items.every((item,i)=>item.name===names[i]),
        noDuplicates:new Set(items.map(item=>item.name)).size===items.length,
        expectedCalls:actions.length===c.expectedActions&&plannerCalls===1,
        noWrites:actions.every(a=>a.actualToolName==='filesystem.listFiles'),
        allRequirements:proof.coveredRequirementIds?.length===2};
      results.push({id:c.id,repetition,status:result.status,passed:Object.values(checks).every(Boolean),checks,
        itemCount:proof.itemCount??null,pageArrivalOffsets:listingObservations.map(o=>o.data.listingOffset),actionCalls:actions.length,plannerCalls,modelCalls:0,externalCalls:0,retries:0,
        questions:(mission.gates??[]).filter(g=>g.kind==='question').length,approvals:(mission.gates??[]).filter(g=>g.kind==='approval').length,
        latencyMs:Number(elapsed.toFixed(3)),actualCost:null,costStatus:'unmeasured-local-resource-cost'});
    } finally {await rm(root,{recursive:true,force:true});}
  }
  const times=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  return {version:'listing-pagination-evaluation-v1',observedAt:new Date().toISOString(),
    scope:'fixed-synthetic-planner-real-local-core-e-b-g',productionActivation:false,repetitions,
    acceptanceSourceSha256:sha(await readFile('docs/universal-control-v3-acceptance.json')),
    corpusSha256:sha(JSON.stringify(cases)),cases,passed:results.every(r=>r.passed),runs:results.length,
    failedIds:[...new Set(results.filter(r=>!r.passed).map(r=>r.id))],
    p50LatencyMs:times[Math.ceil(times.length*.5)-1],p95LatencyMs:times[Math.ceil(times.length*.95)-1],
    actualCost:null,costStatus:'unmeasured-local-resource-cost',results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==4||process.argv[2]!=='--output') throw new Error('Usage: node scripts/listing-pagination-evaluation.mjs --output artifacts/report.json');
    const report=await evaluateListingPagination(),path=resolve(process.argv[3]);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({output:path,passed:report.passed,runs:report.runs,p50LatencyMs:report.p50LatencyMs,p95LatencyMs:report.p95LatencyMs}));
    if(!report.passed)process.exitCode=1;
  }catch(e){console.error(e.stack??e);process.exitCode=1;}
}
