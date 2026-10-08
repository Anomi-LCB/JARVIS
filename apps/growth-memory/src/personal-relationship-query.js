import {createHash} from 'node:crypto';

// Types must be explicitly supplied by the owner. Never infer that a file name
// is a person, or that a declared result is an independently verified outcome.
const types={사람:'person',목표:'goal',프로젝트:'project',자료:'material',결정:'decision',작업:'task',결과:'result'};
export function parseTypedMemoryEntity(value){
 if(typeof value!=='string' || value.length>2000 || /[\u0000-\u001f\u007f]/u.test(value))return null;
 const match=value.match(/^(사람|목표|프로젝트|자료|결정|작업|결과):(.+)$/u);
 if(!match || !match[2].trim())return null;
 const label=match[2].trim(),type=types[match[1]];
 return {id:'entity:'+createHash('sha256').update(JSON.stringify([type,label])).digest('hex'),type,label};
}

export function parseMemoryRelationshipQuestion(value){
 if(typeof value!=='string')return null;
 const match=value.trim().match(/^'([^'\r\n]+)'의 연결 관계를 ([1-8])단계까지 보여줘[.!]?$/u);
 return match && parseTypedMemoryEntity(match[1]) ? {entity:match[1],depth:Number(match[2]),direction:'both',limit:9} : null;
}

export function queryPersonalRelationships(items,{entity,depth=2,direction='both',limit=200}={},observations=[]){
 const root=parseTypedMemoryEntity(entity);
 if(!root || !Number.isInteger(depth) || depth<1 || depth>8 || !['both','outgoing','incoming'].includes(direction)
   || !Number.isInteger(limit) || limit<1 || limit>200)
  throw Object.assign(new Error('Invalid relationship query.'),{code:'F_MEMORY_RELATION_QUERY_INVALID'});
 const nodes=new Map(),edges=[],adjacency=new Map(),issues=[];
 for(const item of items){
  if(item.basis!=='user-statement')continue;
  if(['conflict','correction-unresolved'].includes(item.status)){
   const subject=parseTypedMemoryEntity(item.subject);
   if(subject){nodes.set(subject.id,subject);issues.push({subject:subject.id,relation:item.predicate,
    sourceEventId:item.sourceEventId,observedAt:item.observedAt,status:item.status});}
   continue;
  }
  if(item.status!=='active')continue;
  const from=parseTypedMemoryEntity(item.subject),to=parseTypedMemoryEntity(item.value);
  if(!from || !to)continue;
  nodes.set(from.id,from);nodes.set(to.id,to);
  const edge={id:'relation:'+item.sourceEventId,from:from.id,to:to.id,relation:item.predicate,
   ...(item.reason?{reason:item.reason}:{}),sourceEventId:item.sourceEventId,observedAt:item.observedAt,
   validUntil:item.validUntil,supersedesEventId:item.supersedesEventId??null,
   basis:'user-statement',executionAuthority:false,currentArtifactVerified:false};
  edges.push(edge);
 }
 // These entries are supplied only by the Core's scoped cognition reader.
 // F's public personalRelationships path does not accept caller observations.
 for(const item of observations){
  const from=parseTypedMemoryEntity(item.subject),to=parseTypedMemoryEntity(item.value);
  if(!from || !to || item.basis!=='historical-execution-observation')continue;
  nodes.set(from.id,from);nodes.set(to.id,to);
  edges.push({id:'observed-relation:'+item.sourceRef+':'+item.relationId,from:from.id,to:to.id,relation:item.predicate,
   sourceEventId:'cognition:'+item.sourceRef,observedAt:item.observedAt,validUntil:null,supersedesEventId:null,
   basis:item.basis,historicalVerificationStatus:item.historicalVerificationStatus??null,
   executionAuthority:false,currentArtifactVerified:false});
 }
 edges.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 for(const edge of edges){
  for(const nodeId of new Set([edge.from,edge.to])){
   const adjacent=adjacency.get(nodeId)??[];adjacent.push(edge);adjacency.set(nodeId,adjacent);
  }
 }
 const found=nodes.has(root.id),selected=new Map(),seen=new Map(found?[[root.id,0]]:[]),queue=found?[root.id]:[];
 let truncated=false;
 for(let index=0;index<queue.length;index++){
  const id=queue[index],distance=seen.get(id);if(distance>=depth)continue;
  for(const edge of adjacency.get(id)??[]){
   if(direction==='outgoing' && edge.from!==id || direction==='incoming' && edge.to!==id)continue;
   if(selected.has(edge.id))continue;
   if(selected.size===limit){truncated=true;continue;}
   selected.set(edge.id,edge);
   const next=edge.from===id?edge.to:edge.from;
   if(!seen.has(next)){seen.set(next,distance+1);queue.push(next);}
  }
 }
 const visibleIssues=issues.filter(issue=>seen.has(issue.subject)).sort((a,b)=>a.sourceEventId.localeCompare(b.sourceEventId,'en'));
 return {found,root:found?root:null,nodes:[...seen.keys()].map(id=>({...nodes.get(id),distance:seen.get(id)})),
  edges:[...selected.values()],depth,direction,limit,truncated,
  issues:visibleIssues,requiresUserResolution:visibleIssues.length>0,
  nextAction:visibleIssues.length?'resolve-conflicting-or-unresolved-memory':truncated?'narrow-query-or-query-an-adjacent-entity':null,
  basis:observations.length?'mixed-source-relations':'user-statement',executionAuthority:false,currentArtifactVerified:false};
}

export function relationshipMemoryReferences(graph,scope){
 const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
 const references=graph.edges.map(edge=>({memoryId:edge.id,memoryType:'personal_relationship',
  text:[nodes.get(edge.from).label,edge.relation,nodes.get(edge.to).label,edge.reason??''].filter(Boolean).join(' · '),
  provenance:{memoryKind:edge.basis==='historical-execution-observation'?'execution_observation':'user_statement',sourceEventIds:[edge.sourceEventId],observedAt:[edge.observedAt],usageScopes:[scope],
   validity:{validUntil:edge.validUntil??null,basis:edge.validUntil?'declared-expiry':'unspecified'},
   revisionReference:{revision:null,supersedesEventId:edge.supersedesEventId},revisionHistory:[],executionAuthority:false,independentlyVerifiedOutcome:false}}));
 if(graph.truncated)references.push({memoryId:'relationship-query-truncated',memoryType:'personal_relationship_notice',
  text:'연결 관계 일부만 조회했습니다. 대상을 좁히거나 인접 항목에서 다시 조회해야 합니다.',requiresUserResolution:true});
 if(graph.requiresUserResolution)references.push({memoryId:'relationship-query-unresolved',memoryType:'personal_relationship_notice',
  text:'연결 관계의 기억이 충돌하거나 정정 출처가 부족합니다. 해당 기억을 확인해야 합니다.',requiresUserResolution:true});
 return references;
}
