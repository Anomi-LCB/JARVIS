import {queryPersonalRelationships,parseTypedMemoryEntity} from '../../../../apps/growth-memory/src/personal-relationship-query.js';
import {normalizeMemoryScope} from '../../../../apps/growth-memory/src/memory-provenance.js';
import {createHash} from 'node:crypto';

const hash=value=>typeof value==='string' && /^[a-f0-9]{64}$/u.test(value);
const date=value=>typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;

export function profileRelationshipItems(context,userId){
 const ownerHash=createHash('sha256').update('owner:'+userId).digest('hex');
 if(context?.provenance?.sourceKind!=='direct-user-statement' || context.provenance.usageScope?.ownerScopeRef!==ownerHash)return [];
 const entities=new Map([['profile-owner:'+ownerHash,'사람:사용자'],
  ...(context.goals??[]).map(item=>[item.id,'목표:'+item.title]),...(context.projects??[]).map(item=>[item.id,'프로젝트:'+item.title])]);
 const labels=[...entities.values()],ambiguous=new Set(labels.filter((label,index)=>labels.indexOf(label)!==index));
 return (context.relations??[]).flatMap(relation=>{
  const subject=entities.get(relation.from),value=entities.get(relation.to);
  if(!subject || !value || !parseTypedMemoryEntity(subject) || !parseTypedMemoryEntity(value))return [];
  const sourceEventId='profile-relation:'+createHash('sha256').update(JSON.stringify([context.profileRevision,relation])).digest('hex');
  return [{subject,value,predicate:relation.type,basis:'user-statement',
   status:ambiguous.has(subject)||ambiguous.has(value)?'conflict':'active',sourceEventId,
   observedAt:new Date(context.provenance.observedAt).toISOString(),validUntil:null,supersedesEventId:null}];
 });
}

// Cognition records are historical worker observations. This reader does not
// re-check the current file and never changes a user assertion into G evidence.
export function observedTaskRelations(evidence,taskLabel){
 const trace=evidence?.trace;
 if(!trace || !hash(trace.scopeRef) || !hash(trace.taskRef) || !Array.isArray(trace.decisions) || !Array.isArray(trace.outcomes))return [];
 const decisions=new Map(trace.decisions.filter(row=>hash(row.id) && row.scopeRef===trace.scopeRef && row.taskRef===trace.taskRef
   && hash(row.planRef) && date(row.recordedAt)).map(row=>[row.id,row]));
 const result=[],task='작업:'+taskLabel;
 const add=(subject,predicate,value,sourceRef,observedAt,relationId,status=null)=>result.push({subject,predicate,value,sourceRef,observedAt,relationId,
   basis:'historical-execution-observation',historicalVerificationStatus:status});
 for(const row of decisions.values()){
  const decision='결정:인지:'+row.id;
  add(task,'기록된 결정',decision,row.id,row.recordedAt,'task-decision');
  if(row.previousRef && decisions.has(row.previousRef))add('결정:인지:'+row.previousRef,'다음 결정',decision,row.id,row.recordedAt,'decision-lineage');
 }
 const goal=evidence.goal;
 if(goal && goal.scopeRef===trace.scopeRef && goal.taskRef===trace.taskRef && date(goal.createdAt))
  add('목표:인지:'+trace.taskRef,'수행 작업',task,trace.taskRef,goal.createdAt,'goal-task');
 for(const row of trace.outcomes){
  const decision=decisions.get(row.decisionRef);
  if(!decision || decision.kind==='reject' || row.scopeRef!==trace.scopeRef || row.taskRef!==trace.taskRef
    || row.planRef!==decision.planRef || row.requestRef!==decision.requestRef || row.approvalRef!==decision.approvalRef
    || !['passed','failed'].includes(row.outcome) || !date(row.recordedAt)
    || ['id','packetRef','verificationRef','evidenceRef','verificationContentRef','executionContentRef'].some(key=>!hash(row[key])))continue;
  const outcome='결과:인지:'+row.id;
  add('결정:인지:'+decision.id,'관측된 검증 결과',outcome,row.id,row.recordedAt,'decision-outcome',row.outcome);
  add(outcome,'검증 증거 참조','자료:검증:'+row.evidenceRef,row.id,row.recordedAt,'outcome-evidence',row.outcome);
 }
 return result;
}

export function queryOwnerRelationships({growth,cognition,personalContext,taskRequest,workspaceRoot,...query}){
 if(!growth?.personalKnowledge)throw Object.assign(new Error('Memory storage required.'),{code:'F_MEMORY_STORAGE_REQUIRED'});
 const scope=normalizeMemoryScope({userId:taskRequest?.userId,workspaceRoot,conversationId:taskRequest?.metadata?.conversationId??null});
 if(!scope || taskRequest.metadata?.longTermMemory===false || taskRequest.metadata?.doNotRemember===true)
  throw Object.assign(new Error('Memory scope unavailable.'),{code:'F_MEMORY_SCOPE_REQUIRED'});
 if(growth.ensureMemoryGeneration?.()===false || growth.memoryRecoveryState?.status==='restart_required')
  throw Object.assign(new Error('Memory unavailable.'),{code:'F_MEMORY_RESTORE_RELOAD_REQUIRED'});
 const generation=growth.memoryStore?.restoreGeneration?.();
 const items=[...growth.personalKnowledge({scope}),...profileRelationshipItems(personalContext,scope.userId)];
 // Check query before touching the cognition store. Do not run unrelated tasks.
 const initial=queryPersonalRelationships(items,query);
 const explicitRoot=parseTypedMemoryEntity(query.entity);
 const taskLabels=[...new Set([...initial.nodes.filter(node=>node.type==='task').map(node=>node.label),
  ...(explicitRoot?.type==='task'?[explicitRoot.label]:[])])];
 const observations=[];
 let evidenceQueryTruncated=false;
 for(const taskId of taskLabels){
  if(typeof cognition?.relationshipEvidence!=='function')continue;
  const evidence=cognition.relationshipEvidence({taskId,taskRequest,workspaceRoot});
  if(!evidence)throw Object.assign(new Error('Cognition evidence unavailable.'),{code:'A_COGNITION_STORAGE_FAILED'});
  evidenceQueryTruncated ||= evidence.trace?.truncated===true;
  observations.push(...observedTaskRelations(evidence,taskId));
 }
 const result=queryPersonalRelationships(items,query,observations);
 if(growth.memoryRecoveryState?.status==='restart_required' || generation!==growth.memoryStore?.restoreGeneration?.())
  throw Object.assign(new Error('Memory changed during relationship lookup.'),{code:'F_MEMORY_RESTORE_RELOAD_REQUIRED'});
 if(evidenceQueryTruncated){result.truncated=true;result.nextAction??='narrow-query-or-query-an-adjacent-entity';}
 return {...result,usageScope:scope,executionEvidenceStatus:taskLabels.length && !cognition?.relationshipEvidence?'not-configured':'checked',
  evidenceQueryTruncated};
}
