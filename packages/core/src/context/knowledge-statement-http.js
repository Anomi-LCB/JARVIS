import {createHash} from 'node:crypto';
import {readJsonBody,sendJson} from '../../../shared/src/http.js';
import {parsePersonalKnowledgeStatement} from '../../../../apps/growth-memory/src/personal-knowledge-projection.js';

// ADMIN authentication is enforced by the calling router. Scope and provenance
// come from the existing task, never from caller supplied trust flags.
export async function handleKnowledgeStatement(request,response,{coreFacade}){
 const fail=(status,code)=>sendJson(response,status,{error:{code}});
 if(request.method!=='POST')return fail(405,'A_MEMORY_METHOD_NOT_ALLOWED');
 if(!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type']??''))return fail(415,'A_MEMORY_JSON_REQUIRED');
 let body;try{body=await readJsonBody(request,{maximumBytes:32768});}catch{return fail(400,'A_MEMORY_BODY_INVALID');}
 if(!body || typeof body!=='object' || Array.isArray(body)
   || Object.keys(body).some(k=>!['taskId','statement','requestId','supersedesEventId','expectedObservedAt','validUntil'].includes(k))
   || typeof body.taskId!=='string' || body.taskId.length>200
   || typeof body.requestId!=='string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(body.requestId))return fail(400,'A_MEMORY_INPUT_INVALID');
 const knowledge=parsePersonalKnowledgeStatement(body.statement);
 if(!knowledge || Object.values(knowledge).some(value=>typeof value!=='string' || !value.trim() || value.length>2000))return fail(400,'A_MEMORY_STATEMENT_UNRECOGNIZED');
 if(body.validUntil!==undefined){
  if(typeof body.validUntil!=='string' || !Number.isFinite(Date.parse(body.validUntil))
    || new Date(body.validUntil).toISOString()!==body.validUntil)return fail(400,'A_MEMORY_EXPIRY_INVALID');
  knowledge.validUntil=body.validUntil;
 }
 const task=coreFacade.tasks.get(body.taskId);
 if(!task || task.request?.userId!=='local_user' || task.request.metadata?.longTermMemory===false)return fail(404,'A_MEMORY_TASK_UNAVAILABLE');
 const growth=coreFacade.memoryStore;
 if(!growth?.ingest || !growth?.personalKnowledge)return fail(503,'F_MEMORY_STORAGE_REQUIRED');
 try{
  if(growth.ensureMemoryGeneration?.()===false || growth.memoryRecoveryState?.status==='restart_required')return fail(503,'F_MEMORY_RESTORE_RELOAD_REQUIRED');
  const scope={userId:'local_user',workspaceRoot:coreFacade.workspaceRoot,conversationId:task.request.metadata?.conversationId??null};
  if(growth.ingestor?.all().some(event=>event.taskId===body.taskId && event.eventType==='feedback.do_not_remember'
    && event.learningFlags?.doNotRemember))return fail(409,'F_MEMORY_SOURCE_RETRACTED');
  const eventId='owner-knowledge-'+createHash('sha256').update(JSON.stringify([scope,body.taskId,body.requestId])).digest('hex');
  const existing=growth.ingestor?.events.get(eventId);
  if(existing && (existing.payload?.rawText!==body.statement || (existing.payload?.knowledge?.supersedesEventId??null)!==(body.supersedesEventId??null) || (existing.payload?.knowledge?.validUntil??null)!==(body.validUntil??null)))return fail(409,'A_MEMORY_REQUEST_CONFLICT');
  if(existing){
   const item=growth.personalKnowledge({scope}).find(x=>x.sourceEventId===eventId);
   if(!item)return fail(409,'F_MEMORY_SOURCE_RETRACTED');
   return sendJson(response,200,{stored:true,replayed:true,item,conversationId:scope.conversationId,executionAuthority:false});
  }
  let expectedKnowledgeSource=null;
  if(body.supersedesEventId!==undefined || body.expectedObservedAt!==undefined){
   if(typeof body.supersedesEventId!=='string' || body.supersedesEventId.length>200 || typeof body.expectedObservedAt!=='string')return fail(400,'A_MEMORY_CORRECTION_INVALID');
   const previous=growth.personalKnowledge({scope}).find(x=>x.sourceEventId===body.supersedesEventId);
   if(!previous || !['active','conflict'].includes(previous.status) || previous.observedAt!==body.expectedObservedAt
     || ['kind','subject','predicate'].some(key=>previous[key]!==knowledge[key]))return fail(409,'F_KNOWLEDGE_REVISION_CONFLICT');
   if(growth.clock().getTime()<=Date.parse(previous.observedAt))return fail(409,'F_KNOWLEDGE_CORRECTION_CLOCK_CONFLICT');
   knowledge.supersedesEventId=previous.sourceEventId;
   expectedKnowledgeSource={eventId:previous.sourceEventId,observedAt:previous.observedAt};
  }
  const result=growth.ingest({eventId,taskId:body.taskId,eventType:'task.created',source:{module:'CORE',memoryScope:scope},
   payload:{rawText:body.statement,knowledge},learningFlags:{canBeUsedForWorkflow:true,canBeUsedForAutonomy:false},
   trustBoundary:{userProvided:true,externalContent:false,systemGenerated:false}},{expectedKnowledgeSource});
  if(result.success===false || result.stored!==true)return fail(503,'F_MEMORY_STATEMENT_NOT_STORED');
  const item=growth.personalKnowledge({scope}).find(x=>x.sourceEventId===eventId);
  if(!item)return fail(503,'F_MEMORY_STATEMENT_NOT_VERIFIED');
  return sendJson(response,201,{stored:true,replayed:false,item,conversationId:scope.conversationId,executionAuthority:false});
 }catch(error){return fail(error?.code==='F_KNOWLEDGE_REVISION_CONFLICT'?409:503,error?.code==='F_KNOWLEDGE_REVISION_CONFLICT'?error.code:'F_MEMORY_KNOWLEDGE_UNAVAILABLE');}
}

// History is explicit administrative inspection, not an automatic planning hint.
export function handleKnowledgeHistory(request,response,{coreFacade}){
 const fail=(status,code)=>sendJson(response,status,{error:{code}});
 if(request.method!=='GET')return fail(405,'A_MEMORY_METHOD_NOT_ALLOWED');
 const params=new URL(request.url,'http://localhost').searchParams;
 if([...params.keys()].some(key=>!['taskId','sourceEventId'].includes(key))
   || ['taskId','sourceEventId'].some(key=>params.getAll(key).length!==1 || !params.get(key).trim() || params.get(key).length>200))
   return fail(400,'A_MEMORY_INPUT_INVALID');
 const task=coreFacade.tasks.get(params.get('taskId'));
 if(!task || task.request?.userId!=='local_user' || task.request.metadata?.longTermMemory===false)return fail(404,'A_MEMORY_TASK_UNAVAILABLE');
 const growth=coreFacade.memoryStore;
 if(!growth?.personalKnowledgeHistory)return fail(503,'F_MEMORY_STORAGE_REQUIRED');
 try{
  if(growth.ensureMemoryGeneration?.()===false || growth.memoryRecoveryState?.status==='restart_required')return fail(503,'F_MEMORY_RESTORE_RELOAD_REQUIRED');
  const result=growth.personalKnowledgeHistory({sourceEventId:params.get('sourceEventId'),
   scope:{userId:'local_user',workspaceRoot:coreFacade.workspaceRoot,conversationId:task.request.metadata?.conversationId??null}});
  if(!result.found)return fail(404,'F_MEMORY_HISTORY_UNAVAILABLE');
  return sendJson(response,200,result);
 }catch{return fail(503,'F_MEMORY_KNOWLEDGE_UNAVAILABLE');}
}
