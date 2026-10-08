import {PcLocalTaskScope} from './pc-local-task-scope.js';
import {validPcReadiness} from '../../../packages/shared/src/pc-readiness-contract.js';
import {projectPcDeviceObservation} from '../../../packages/shared/src/pc-device-observation-contract.js';
/** PC-side adapter. No inbound PC port, arbitrary URL, shell, or execution packet is exposed. */
export function createPcOutboundObserver({ transport, pcClient, allowedTaskIds = [], taskCatalog=null, artifactReader = null, deviceReader=null, clock = Date.now } = {}) {
  if (!transport?.exchange || !pcClient?.health || !Array.isArray(allowedTaskIds)) throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if (artifactReader !== null && typeof artifactReader !== 'function') throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if(deviceReader!==null&&typeof deviceReader!=='function')throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if(taskCatalog!==null&&(!(taskCatalog instanceof PcLocalTaskScope)||!taskCatalog.catalogEnabled||allowedTaskIds.length))throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  const tasks = new Set(allowedTaskIds); let pending = null, running = false;
  let fences=[];
  const assertScopes=()=>{for(const item of fences){taskCatalog.assertCatalogCurrent(item.taskId,'read',item.lease);
    if(item.readiness&&JSON.stringify(taskCatalog.commandReadiness(item.taskId))!==JSON.stringify(item.readiness))throw new Error('A_PC_OUTBOUND_READ_DENIED');}};
  const selected=id=>{if(!taskCatalog)return tasks.has(id);if(!taskCatalog.catalog().allowedTaskIds.includes(id))return false;fences.push({taskId:id,lease:taskCatalog.captureCatalog(id,'read')});return true;};
  return {
    async tick() {
      if (running) return { status: 'busy' };
      running = true;
      try {
        // A lost acknowledgement is retried as the same observation, never as a new action.
        if (pending) {
          try{assertScopes();}catch{pending=null;fences=[];return {status:'scope-changed'};}
          try { await transport.exchange('submit', pending); pending = null; }
          catch (error) { if (['A_PC_OUTBOUND_STALE_LEASE','A_PC_OUTBOUND_AUTHORITY_CHANGED'].includes(error.message)) pending = null; throw error; }
        }
        const packet = await transport.exchange('pull', {});
        fences=[];
        if (!packet) return { status: 'idle' };
        let result;
        if (!Number.isSafeInteger(packet.expiresAt) || packet.expiresAt <= clock()) throw new Error('A_PC_OUTBOUND_STALE_LEASE');
        const { operation, taskId } = packet.request ?? {};
        try {
          let value;
          if (operation === 'health' && taskId === null) {
            const health = await pcClient.health();
            // Local health also contains disk paths and security diagnostics; do not replicate those.
            value = { status: health.status, module: health.module, version: health.version };
          }
          else if(operation==='device-observation'&&taskId===null&&deviceReader)value=projectPcDeviceObservation(await deviceReader());
          else if(operation==='task-catalog'&&taskId===null&&Array.isArray(packet.request.taskIds)&&packet.request.taskIds.length<=100
            &&new Set(packet.request.taskIds).size===packet.request.taskIds.length&&Number.isSafeInteger(packet.request.offset)&&Number.isSafeInteger(packet.request.totalEntries)){
            const ids=packet.request.taskIds.filter(selected);
            const batch=ids.length?await pcClient.taskSummaries(ids):{items:[],executionAuthority:false,verifiedCompletion:false};
            if(batch?.executionAuthority!==false||batch.verifiedCompletion!==false||!Array.isArray(batch.items)||batch.items.length!==ids.length
              ||batch.items.some((item,i)=>item?.taskId!==ids[i]))throw new Error('A_PC_OUTBOUND_READ_DENIED');
            const summaries=new Map(batch.items.map(item=>[item.taskId,item]));
            const items=packet.request.taskIds.map(id=>{
              if(!ids.includes(id))return {taskId:id,title:'PC 쪽 조회 허용 필요',status:'UNKNOWN',available:false,dryRun:null};
              const item=summaries.get(id);return {taskId:id,title:item.title,status:item.status,available:item.available,dryRun:item.dryRun};
            });
            value={items,offset:packet.request.offset,totalEntries:packet.request.totalEntries,hasMore:packet.request.offset+items.length<packet.request.totalEntries,executionAuthority:false,verifiedCompletion:false};
          }
          else if(operation==='task-readiness'&&taskCatalog&&selected(taskId)){
            value=taskCatalog.commandReadiness(taskId);if(!validPcReadiness(value,taskId))throw new Error('A_PC_OUTBOUND_READ_DENIED');
            fences[fences.length-1].readiness=value;
          }
          else if (operation === 'task-result' && selected(taskId)) value = await pcClient.taskResult(taskId);
          else if (operation === 'task-publication' && selected(taskId)) value = await pcClient.taskPublication(taskId);
          else if (operation === 'operation-artifact' && selected(taskId) && artifactReader) {
            value = await artifactReader({ operationId: packet.request.operationId, taskId, action: packet.request.action });
          }
          else if (operation === 'operation-receipt' && selected(taskId)
            && /^mission_op_[a-f0-9]{32}$/u.test(packet.request.operationId??'')
            && packet.request.action?.toolName==='filesystem.createTextFile'
            && typeof packet.request.action.arguments?.path==='string'
            && typeof (packet.request.action.arguments?.content??'')==='string') {
            const record=await pcClient.readOperation({operationId:packet.request.operationId,taskId,action:packet.request.action});
            // Prepared tickets and arbitrary provider metadata must not leave the PC.
            value=record?{operationId:record.operationId,taskId:record.taskId,fingerprint:record.fingerprint,
              state:record.state,receipt:record.state==='succeeded'?record.receipt:null,executionAuthority:false}:null;
          }
          else throw new Error('A_PC_OUTBOUND_READ_DENIED');
          assertScopes();result = { status: 'observed', value, observedAt: new Date(clock()).toISOString() };
        } catch { fences=[];result = { status: 'unavailable', reason: '선택한 PC 자료를 조회할 수 없습니다.', observedAt: new Date(clock()).toISOString() }; }
        pending = { requestId: packet.requestId, generation: packet.generation, lease: packet.lease, result };
        try { await transport.exchange('submit', pending); pending = null; }
        catch (error) { if (['A_PC_OUTBOUND_STALE_LEASE','A_PC_OUTBOUND_AUTHORITY_CHANGED'].includes(error.message)) pending = null; throw error; }
        return { status: 'observed' };
      } finally { running = false; }
    }
  };
}
