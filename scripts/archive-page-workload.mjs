import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suite='tests/fixtures/archive-page-workload-v1.json',fixedHash='f3ae3cf7f22121f623e6119ce367860986f1f4e291810f8c3e9ba3c51432a773';
const files=[suite,'apps/growth-memory/src/selected-conversation-archive.js','apps/growth-memory/src/memory-relevance.js','scripts/archive-page-workload.mjs'];
const hashes=()=>files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const before=hashes(),bytes=readFileSync(suite);if(createHash('sha256').update(bytes).digest('hex')!==fixedHash)throw new Error('FIXTURE_CHANGED');
const spec=JSON.parse(bytes),output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
assertComparisonOutputPath(output,{suitePath:resolve(suite),sourcePaths:files.map(path=>resolve(path))});
const root=mkdtempSync(join(tmpdir(),'jarvis-page-workload-')),store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runs=[];
try {
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 for(const count of spec.counts){
  const scope={userId:`synthetic-${count}`,workspaceRoot:root,conversationId:null};
  for(let start=0;start<count;start+=500){
   const messages=Array.from({length:Math.min(500,count-start)},(_,j)=>{
    const i=start+j;return {id:`m${i}`,speaker:'user',text:i>=count-5?'資料 資料 희귀 자료 원문':i>=count-125?'자료 원문':'일정 초안',spokenAt:'2026-10-03T00:00:00Z'};
   });
   const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:`batch${start}`,messages}]};
   growth.importSelectedConversations({document,scope,selectedConversationIds:[`batch${start}`],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-page-workload'},{commit:true});
  }
  for(const item of spec.queries)for(let repetition=0;repetition<spec.repetitions;repetition++){
   const memoryBefore=process.memoryUsage(),started=performance.now(),all=[],pages=[];let cursor=null,hasMore;
   do {
    const pageStarted=performance.now(),page=growth.selectedConversationImports.queryPage(item.query,{scope,pageSize:spec.pageSize,cursor});
    pages.push({durationMs:performance.now()-pageStarted,count:page.items.length,hasMore:page.hasMore});
    all.push(...page.items);cursor=page.nextCursor;hasMore=page.hasMore;
    if(pages.length>4)throw new Error('UNBOUNDED_PAGES');
   }while(hasMore);
   const durationMs=performance.now()-started,memoryAfter=process.memoryUsage();
   const expected=new Set(Array.from({length:item.matchingRows},(_,i)=>`m${count-item.matchingRows+i}`));
   const valid=all.length===expected.size&&new Set(all.map(x=>x.sourceMessageId)).size===expected.size
    &&all.every(x=>expected.has(x.sourceMessageId)&&x.executionAuthority===false&&x.sourceTextStart===0&&x.sourceTextEnd===x.text.length)
    &&all.map(x=>x.memoryId).join(',')===[...all].sort((a,b)=>a.memoryId.localeCompare(b.memoryId)).map(x=>x.memoryId).join(',')
    &&pages.at(-1).hasMore===false&&cursor===null&&pages.every(p=>p.count<=spec.pageSize);
   runs.push({count,caseId:item.id,repetition,durationMs,resultCount:all.length,pages,passed:valid,memory:{heapBefore:memoryBefore.heapUsed,heapAfter:memoryAfter.heapUsed,rssBefore:memoryBefore.rss,rssAfter:memoryAfter.rss}});
  }
 }
}finally{store.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('TEMP_ROOT_INVALID');rmSync(root,{recursive:true,force:true});}
const summaries=[];
for(const count of spec.counts)for(const item of spec.queries){const times=runs.filter(r=>r.count===count&&r.caseId===item.id).map(r=>r.durationMs).sort((a,b)=>a-b);summaries.push({count,caseId:item.id,observations:times.length,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1]});}
const sourcesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
const report={observedAt:new Date().toISOString(),mode:'actual-isolated-sqlite-complete-page-traversal',suiteSha256:fixedHash,sourceFiles:before,sourcesUnchanged,passed:sourcesUnchanged&&runs.every(r=>r.passed),runs,summaries,cost:{status:'unmeasured',amount:null},limits:['Synthetic short messages and27 traversals;setup/import excluded.','Three observations per cell are not statistical p95 or product latency guarantees.','Process heap/RSS endpoints are not peak/native allocation measurements.','No actual accounts,external LLM,independent semantic quality or product activation.']};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,runs:runs.length,summaries}));if(!report.passed)process.exitCode=1;
