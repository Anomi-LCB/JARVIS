import {sendJson} from '../../../shared/src/http.js';

// ADMIN is required by the router. The existing owner task determines scope.
export function handleKnowledgeRelations(request,response,{coreFacade}){
 const fail=(status,code)=>sendJson(response,status,{error:{code}});
 if(request.method!=='GET')return fail(405,'A_MEMORY_METHOD_NOT_ALLOWED');
 const params=new URL(request.url,'http://localhost').searchParams;
 if([...params.keys()].some(key=>!['taskId','entity','depth','direction','limit'].includes(key))
   || [...params.keys()].some(key=>params.getAll(key).length!==1)
   || !params.get('taskId')?.trim() || params.get('taskId').length>200)
  return fail(400,'A_MEMORY_INPUT_INVALID');
 const task=coreFacade.tasks.get(params.get('taskId'));
 if(!task || task.request?.userId!=='local_user' || task.request.metadata?.longTermMemory===false)return fail(404,'A_MEMORY_TASK_UNAVAILABLE');
 const growth=coreFacade.memoryStore;
 if(!growth?.personalRelationships)return fail(503,'F_MEMORY_STORAGE_REQUIRED');
 try{
  return sendJson(response,200,coreFacade.queryRelationships({taskRequest:task.request,entity:params.get('entity'),
   ...(params.has('depth')?{depth:/^[1-8]$/u.test(params.get('depth'))?Number(params.get('depth')):NaN}:{}),
   ...(params.has('direction')?{direction:params.get('direction')}:{}),
   ...(params.has('limit')?{limit:/^[1-9]\d{0,2}$/u.test(params.get('limit'))?Number(params.get('limit')):NaN}:{})}));
 }catch(error){return fail(error?.code==='F_MEMORY_RELATION_QUERY_INVALID'?400:503,
   error?.code==='F_MEMORY_RELATION_QUERY_INVALID'?error.code:'F_MEMORY_KNOWLEDGE_UNAVAILABLE');}
}
