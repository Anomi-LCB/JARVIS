import {createHash} from 'node:crypto';
import {normalizeMemoryScope} from './memory-provenance.js';
import {memoryItemRelevant} from './memory-relevance.js';
import {queryPersonalRelationships} from './personal-relationship-query.js';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const personalMemoryText=item=>[item.subject,item.predicate,item.value,item.reason??''].join(' · ');
const date=value=>typeof value==='string' && Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
function eligible(runtime,scope,from,to){
 return runtime.personalKnowledge({scope}).filter(item=>item.status==='active'
  && Number.isFinite(date(item.observedAt)) && date(item.observedAt)>=from && date(item.observedAt)<=to);
}
function cosine(a,b){
 let product=0,left=0,right=0;
 for(let i=0;i<a.length;i++){product+=a[i]*b[i];left+=a[i]**2;right+=b[i]**2;}
 return product/Math.sqrt(left*right);
}

// Read from the current F projection. No separate persistent vector index or
// private journal is created; async results are invalidated by any source edit.
export async function searchPersonalMemory(runtime,{scope,mode='keyword',query='',limit=10,
 from=null,to=null,entity,depth=2,direction='both',embeddingProvider=null}={}){
 scope=normalizeMemoryScope(scope);
 if(!scope)throw fail('F_MEMORY_SCOPE_REQUIRED','Explicit memory scope required.');
 if(!['keyword','semantic','time','relationship'].includes(mode)||typeof query!=='string'||query.length>4000
  ||!Number.isInteger(limit)||limit<1||limit>200 ||from!==null&&!Number.isFinite(date(from))
  ||to!==null&&!Number.isFinite(date(to)) ||from!==null&&to!==null&&date(from)>date(to))
  throw fail('F_MEMORY_SEARCH_INVALID','Invalid bounded memory query.');
 if(!runtime.ensureMemoryGeneration()||runtime.memoryRecoveryState?.status==='restart_required')
  throw fail('F_MEMORY_RESTORE_RELOAD_REQUIRED','Memory unavailable.');
 const start=performance.now(),generation=runtime.memoryGeneration;
 const lower=from===null?-Infinity:date(from),upper=to===null?Infinity:date(to);
 const items=eligible(runtime,scope,lower,upper),snapshot=digest(items);
 let ranked=[],calls=0,provider=null;
 if(mode==='keyword')ranked=items.filter(item=>memoryItemRelevant({text:personalMemoryText(item)},query,{scope})).map(item=>({item,score:null}));
 if(mode==='time')ranked=items.filter(item=>!query.trim()||memoryItemRelevant({text:personalMemoryText(item)},query,{scope}))
  .map(item=>({item,score:date(item.observedAt)}));
 if(mode==='relationship'){
  const graph=queryPersonalRelationships(items,{entity,depth,direction,limit:200});
  if(graph.truncated)throw fail('F_MEMORY_SEARCH_GRAPH_TRUNCATED','Narrow the relationship query.');
  const ids=new Set(graph.edges.map(edge=>edge.sourceEventId));
  ranked=items.filter(item=>ids.has(item.sourceEventId)).map(item=>({item,score:null}));
 }
 if(mode==='semantic'){
  if(!query.trim())throw fail('F_MEMORY_SEARCH_INVALID','Semantic query cannot be empty.');
  if(!embeddingProvider) return {status:'blocked',reasonCode:'F_MEMORY_EMBEDDING_NOT_CONFIGURED',
   nextAction:'configure-reviewed-local-embedding-provider',mode,items:[],usageScope:scope,executionAuthority:false,
   metrics:{durationMs:performance.now()-start,calls:0,cost:{status:'unmeasured',amount:null}}};
  if(items.length>200)throw fail('F_MEMORY_SEARCH_CANDIDATES_EXCEEDED','Narrow the date range before embedding.');
  if(items.length){
   const result=await embeddingProvider.embed([query,...items.map(personalMemoryText)]);calls=1;
   const vectors=result?.vectors;
   if(!Array.isArray(vectors)||vectors.length!==items.length+1||!Array.isArray(vectors[0])
    ||vectors[0].length<1||vectors[0].length>8192
    ||vectors.some(vector=>!Array.isArray(vector)||vector.length!==vectors[0].length
     ||vector.some(value=>typeof value!=='number'||!Number.isFinite(value))
     ||!(vector.reduce((sum,value)=>sum+value*value,0)>0)
     ||!Number.isFinite(vector.reduce((sum,value)=>sum+value*value,0))))
    throw fail('F_MEMORY_EMBEDDING_INVALID','Embedding cardinality, dimensions or values invalid.');
   ranked=items.map((item,index)=>({item,score:cosine(vectors[0],vectors[index+1])}));
   provider=result.provider??null;
  }
 }
 if(!runtime.ensureMemoryGeneration()||runtime.memoryGeneration!==generation
  ||digest(eligible(runtime,scope,lower,upper))!==snapshot)
  throw fail('F_MEMORY_SEARCH_SOURCE_CHANGED','Memory changed while searching; retry against current sources.');
 ranked.sort((a,b)=>(mode==='semantic'||mode==='time'?b.score-a.score:0)
  ||a.item.sourceEventId.localeCompare(b.item.sourceEventId,'en'));
 return {status:'completed',mode,items:ranked.slice(0,limit).map(({item,score})=>({...item,score,usageScope:scope,
  executionAuthority:false,currentArtifactVerified:false})),matchedCount:ranked.length,
  truncated:ranked.length>limit,usageScope:scope,executionAuthority:false,currentArtifactVerified:false,
  metrics:{durationMs:performance.now()-start,calls,provider,cost:{status:'unmeasured',amount:null}}};
}

export function createLocalOllamaEmbeddingProvider({baseUrl,model,timeoutMs=30000,fetchImpl=fetch}={}){
 const url=new URL(baseUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password
  ||url.pathname!=='/'||url.search||url.hash||typeof model!=='string'||!/^[-a-zA-Z0-9_.]+:[-a-zA-Z0-9_.]+$/.test(model)
  ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)
  throw fail('F_MEMORY_EMBEDDING_CONFIG_INVALID','Only an explicit local model endpoint is allowed.');
 async function request(path,body){
  const response=await fetchImpl(new URL(path,url),{method:body?'POST':'GET',redirect:'error',
   headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,
   signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw fail('F_MEMORY_EMBEDDING_HTTP_ERROR','Local embedding service failed.');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
   if(bytes>16*1024*1024)throw fail('F_MEMORY_EMBEDDING_INVALID','Embedding response too large.');chunks.push(part.value);}}
  finally{await reader.cancel();}
  const text=Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
 }
 return {async embed(input){
  if(!Array.isArray(input)||!input.length||input.length>201||input.some(text=>typeof text!=='string'||text.length>8000))
   throw fail('F_MEMORY_EMBEDDING_INPUT_INVALID','Embedding input exceeds the bounded batch.');
  // Do not route through Ollama's cloud model proxy, even on a loopback URL.
  const tags=await request('/api/tags'),local=tags.models?.find(item=>item.name===model);
  if(!local||!/^([a-f0-9]{64})$/.test(local.digest)||!local.size
   ||local.remote_host||local.remote_model||!local.capabilities?.includes('embedding'))
   throw fail('F_MEMORY_EMBEDDING_LOCAL_MODEL_REQUIRED','Installed local embedding model required.');
  // Google's published retrieval prompts differ for query and documents.
  // This adapter handles one query followed by documents, not arbitrary STS.
  const prompted=model.startsWith('embeddinggemma:')?input.map((text,index)=>
   index===0?'task: search result | query: '+text:'title: none | text: '+text):input;
  const result=await request('/api/embed',{model,input:prompted,truncate:false,keep_alive:'5m'});
  if(result.model!==model)throw fail('F_MEMORY_EMBEDDING_INVALID','Embedding model mismatch.');
  return {vectors:result.embeddings,provider:{kind:'local-ollama',model,digest:local.digest,
   promptEvalCount:result.prompt_eval_count??null,totalDurationNs:result.total_duration??null,requestCount:2,
   formatting:model.startsWith('embeddinggemma:')?'google-retrieval-query-document':'raw-text'}};
 }};
}
