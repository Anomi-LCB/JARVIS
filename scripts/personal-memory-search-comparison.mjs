import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {createLocalOllamaEmbeddingProvider} from '../apps/growth-memory/src/personal-memory-search.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';

const suitePath=resolve('tests/fixtures/personal-memory-search-v1.json');
const frozenHash='c5e851d6cc2a3c51569434b147a2886290e59014f88fb75497c4e65984dc1d9c';
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const sourcePaths=[suitePath,resolve('apps/growth-memory/src/personal-memory-search.js'),
 resolve('apps/growth-memory/src/growth-runtime.js'),resolve('apps/growth-memory/src/memory-relevance.js'),
 resolve('apps/growth-memory/src/personal-knowledge-projection.js'),resolve('apps/growth-memory/src/personal-relationship-query.js'),fileURLToPath(import.meta.url)];
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
export async function runPersonalMemorySearchComparison({repeat=3,embeddingProvider=null}={}){
 if(!Number.isInteger(repeat)||repeat<1||repeat>10)throw new Error('Invalid repetitions.');
 if(hash(suitePath)!==frozenHash)throw new Error('Frozen search corpus changed.');
 const before=Object.fromEntries(sourcePaths.map(path=>[path,hash(path)])),suite=JSON.parse(readFileSync(suitePath,'utf8'));
 const root=mkdtempSync(join(tmpdir(),'jarvis-search-comparison-')),clock=()=>new Date(suite.now);
 const store=new SqliteMemoryStore({dbPath:join(root,'f.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups'),clock});
 const runtime=new GrowthRuntime({memoryStore:store,auditRoot:root,clock});
 const scope={userId:'synthetic-owner',workspaceRoot:root,conversationId:'frozen-search'};
 const observations=[],modes=['baseline','keyword','semantic','time','relationship'],startedAt=new Date().toISOString();
 try{
  for(const record of suite.records){
   const saved=runtime.ingest({eventId:record.id,eventType:'feedback.good',taskId:record.id,createdAt:record.at,
    source:{memoryScope:record.otherOwner?{...scope,userId:'other-synthetic-owner'}:scope},
    payload:{knowledge:{kind:'fact',subject:record.subject,predicate:record.predicate,value:record.value,
     ...(record.validUntil?{validUntil:record.validUntil}:{})}},trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}});
   if(!saved.success)throw new Error('Synthetic source not stored.');
  }
  for(let repetition=0;repetition<repeat;repetition++)for(const item of suite.cases){
   const ordered=[...modes.slice(repetition%modes.length),...modes.slice(0,repetition%modes.length)];
   const eligible=new Set(runtime.personalKnowledge({scope}).filter(record=>record.status==='active'
    &&(!item.from||record.observedAt>=item.from)&&(!item.to||record.observedAt<=item.to)).map(record=>record.sourceEventId));
   for(const mode of ordered){
    const start=performance.now();let result,status='completed',reasonCode=null;
    try{
     if(mode==='baseline'){
      // Call the existing actual F search, then apply the SAME explicit window
      // and owner assertion eligibility as the new modes. The legacy max-10
      // selection remains visible, rather than rebuilding a fake baseline.
      result={items:runtime.query(item.query,{scope}).flatMap(record=>{
       const id=record.sourceEventId??record.provenance?.sourceEventIds?.[0];
       return eligible.has(id)?[{sourceEventId:id}]:[];
      }).slice(0,suite.limit),metrics:{calls:0,provider:null}};
     }else result=await runtime.searchPersonalKnowledge({scope,mode,query:item.query,limit:suite.limit,
      entity:item.entity,depth:item.depth??1,from:item.from??null,to:item.to??null,embeddingProvider});
     status=result.status??status;reasonCode=result.reasonCode??null;
    }catch(error){status='failed';reasonCode=error.code??'UNCLASSIFIED_SEARCH_ERROR';result={items:[],metrics:{calls:null}};}
    const ids=result.items.map(record=>record.sourceEventId),hits=ids.filter(id=>item.gold.includes(id)).length;
    observations.push({caseId:item.id,repetition:repetition+1,mode,status,reasonCode,ids,gold:item.gold,
     eligibleCount:eligible.size,recall:hits/item.gold.length,precision:ids.length?hits/ids.length:0,
     requiredItemsPreserved:status==='completed'&&item.gold.every(id=>ids.includes(id)),
     outsideScopeOrWindow:ids.filter(id=>!eligible.has(id)),durationMs:performance.now()-start,
     logicalEmbeddingCalls:result.metrics.calls,provider:result.metrics.provider??null,
     cost:{status:'unmeasured',amount:null},userQuestions:null,approvals:null,retries:0});
   }
  }
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
 const sourceUnchanged=sourcePaths.every(path=>before[path]===hash(path));
 const summary=Object.fromEntries(modes.map(mode=>{const rows=observations.filter(item=>item.mode===mode);return [mode,
  {total:rows.length,completed:rows.filter(row=>row.status==='completed').length,blocked:rows.filter(row=>row.status==='blocked').length,
   failed:rows.filter(row=>row.status==='failed').length,requiredItemsPreserved:rows.filter(row=>row.requiredItemsPreserved).length,
   meanRecall:rows.reduce((sum,row)=>sum+row.recall,0)/rows.length,meanPrecision:rows.reduce((sum,row)=>sum+row.precision,0)/rows.length,
   p50Ms:percentile(rows.map(row=>row.durationMs),.5),p95Ms:percentile(rows.map(row=>row.durationMs),.95),
   scopeOrWindowViolations:rows.reduce((sum,row)=>sum+row.outsideScopeOrWindow.length,0)}];}));
 return {version:suite.version,corpusSha256:frozenHash,startedAt,observedAt:new Date().toISOString(),repeat,
  sourceHashes:before,sourceUnchanged,summary,observations,
  limitations:[suite.limitations,'Not an end-to-end UI or production-memory benchmark; optional semantic provider is reported blocked when absent.',
   'Blank time-only query is unsupported by semantic mode and remains a failure in the denominator.',
   'No paid API used. Actual electricity/hardware cost unmeasured. Questions/approvals are unmeasured, not zero.',
   'Legacy search is capped at 10 before matched eligibility/window filtering; this selection limitation remains part of the actual baseline.',
   'Warm model reuse across repetitions; corpus/input caching is not implemented. No claim of general semantic superiority or whole-product p95.']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
 const output=value('--output');if(!args.includes('--output')||!output)throw new Error('--output required.');
 assertComparisonOutputPath(output,{suitePath,sourcePaths,root:process.cwd()});
 const target=resolve(output);
 const embeddingProvider=args.includes('--local-embeddings')?createLocalOllamaEmbeddingProvider({
  baseUrl:'http://127.0.0.1:11445',model:'embeddinggemma:300m',timeoutMs:120000}):null;
 const report=await runPersonalMemorySearchComparison({repeat:args.includes('--repeat')?Number(value('--repeat')):3,embeddingProvider});
 mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output:target,sourceUnchanged:report.sourceUnchanged,summary:report.summary}));
}
