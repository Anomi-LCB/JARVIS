import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suite='tests/fixtures/archive-lookup-workload-v1.json',fixedHash='5a3378cd9356270b994ce810c3afa73c82595b8a9d228785039b63d825b8253d';
const files=[suite,'apps/growth-memory/src/selected-conversation-archive.js','apps/growth-memory/src/memory-relevance.js','scripts/archive-lookup-workload.mjs'];
const hashes=()=>files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const before=hashes(),bytes=readFileSync(suite);if(createHash('sha256').update(bytes).digest('hex')!==fixedHash)throw new Error('FIXED_WORKLOAD_CHANGED');
const workload=JSON.parse(bytes),output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
assertComparisonOutputPath(output,{suitePath:resolve(suite),sourcePaths:files.map(path=>resolve(path))});
const root=mkdtempSync(join(tmpdir(),'jarvis-archive-workload-')),store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runs=[];
try {
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 for(const count of workload.counts){
  const scope={userId:`synthetic-${count}`,workspaceRoot:root,conversationId:null};
  for(let start=0;start<count;start+=500){
   const messages=Array.from({length:Math.min(500,count-start)},(_,j)=>{
    const i=start+j,matching=i>=count-workload.matchingRows;
    return {id:`m${i}`,speaker:'user',text:matching?'자료 원문 대조':'오늘 일정 초안',spokenAt:matching?'2026-10-02T00:00:00Z':'2026-10-03T00:00:00Z'};
   });
   const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:`batch${start}`,messages}]};
   growth.importSelectedConversations({document,scope,selectedConversationIds:[`batch${start}`],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-workload'},{commit:true});
  }
  for(const item of workload.queries)for(let repetition=0;repetition<workload.repetitions;repetition++){
   const memoryBefore=process.memoryUsage(),started=performance.now(),items=growth.selectedConversationImports.query(item.query,{scope}),durationMs=performance.now()-started,memoryAfter=process.memoryUsage();
   const valid=items.length===item.expectedCount&&items.every(q=>q.text==='자료 원문 대조'&&q.provenance.executionAuthority===false&&Number(q.sourceMessageId.slice(1))>=count-workload.matchingRows);
   runs.push({count,caseId:item.id,repetition,durationMs,resultCount:items.length,passed:valid,memory:{heapBefore:memoryBefore.heapUsed,heapAfter:memoryAfter.heapUsed,rssBefore:memoryBefore.rss,rssAfter:memoryAfter.rss}});
  }
 }
}finally{store.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('TEMP_ROOT_INVALID');rmSync(root,{recursive:true,force:true});}
const summaries=[];
for(const count of workload.counts)for(const item of workload.queries){
 const timings=runs.filter(r=>r.count===count&&r.caseId===item.id).map(r=>r.durationMs).sort((a,b)=>a-b);
 summaries.push({count,caseId:item.id,observations:timings.length,p50Ms:timings[Math.ceil(timings.length*.5)-1],p95Ms:timings[Math.ceil(timings.length*.95)-1]});
}
const sourcesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
const report={observedAt:new Date().toISOString(),mode:'fixed-current-scoped-archive-lookup-workload',suiteSha256:fixedHash,sourceFiles:before,sourcesUnchanged,
 passed:sourcesUnchanged&&runs.every(r=>r.passed),runs,summaries,cost:{status:'unmeasured',amount:null},limits:[
 'Synthetic short messages and30 local lookup runs,not real user data or whole-request p95.',
 'Five observations per cell;not a statistical performance guarantee or a measured speedup over a baseline.',
 'Point heap/RSS samples are not peak memory or isolated SQLite allocation measurements.',
 'Setup/import costs excluded;automatic recall limit remains5 and scoped worst-case scanning/sorting remains.']};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,runs:runs.length,summaries}));if(!report.passed)process.exitCode=1;
