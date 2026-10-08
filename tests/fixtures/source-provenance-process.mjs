import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {FailureImprovementPipeline} from '../../packages/core/src/capabilities/failure-improvement-pipeline.js';
import {sourceTestManager} from './improvement-policy-fixture.mjs';
const [mode,dbPath]=process.argv.slice(2),store=new PersonalOperationsStore({dbPath});
let candidateCalls=0,executionCalls=0;
const p=new FailureImprovementPipeline({store,promotionManager:sourceTestManager({stage(){executionCalls++;throw Error('must not execute');}}),
 sourcesForTool:new Map([['workflow.execute',['https://nodejs.org/api/fs.html','https://nodejs.org/api/worker_threads.html']]]),
 fetchSource:async()=>{if(mode!=='write')throw Error('read must not fetch');return new Response('identical fixture source bytes');},
 createCandidate:()=>{candidateCalls++;throw Object.assign(Error('stop before admission'),{code:'FIXTURE_STOP'});}});
try{
 if(mode==='write'){
  const records=['one','two'].map(taskId=>({version:1,taskId,status:'FAILED',observedAt:new Date().toISOString(),toolName:'workflow.execute',nativeRecovery:null}));
  const [item]=p.enqueue(records);try{await p.process(item.id);}catch(e){if(e.code!=='FIXTURE_STOP')throw e;}
 }
 const [item]=p.list(),sources=item.sources,snapshots=sources.map(s=>p.sourceSnapshot(s.contentSha256,s.url,s.observedAt));
 let ambiguous=false;try{p.sourceSnapshot(sources[0].contentSha256);}catch(e){if(e.code!=='A_IMPROVEMENT_SOURCE_SNAPSHOT_AMBIGUOUS')throw e;ambiguous=true;}
 process.stdout.write(JSON.stringify({pid:process.pid,sources,snapshots,ambiguous,candidateCalls,executionCalls}));
}finally{store.close();}
