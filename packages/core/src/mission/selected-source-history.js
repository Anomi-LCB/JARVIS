import {createHash} from 'node:crypto';
import {normalizeSelectedSourceRequest} from '../personal-operations/selected-source-stream.js';
import {selectedSourceGoalBound} from './selected-source-result.js';

/** Historical state only: never implies current G verification or execution authority. */
export function selectedSourceHistory(missions,input){
 const request=normalizeSelectedSourceRequest(input);
 const items=[...missions.values()].filter(m=>selectedSourceGoalBound(m)&&m.selectedSource.provider===request.provider&&m.selectedSource.streamRef===request.streamRef)
  .map(m=>({missionId:m.missionId,status:m.status,createdAt:m.createdAt,updatedAt:m.updatedAt,currentResultVerified:false}))
  .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.missionId.localeCompare(b.missionId));
 const revision=createHash('sha256').update(JSON.stringify(items)).digest('hex');
 if(request.expectedRevision&&request.expectedRevision!==revision)throw new Error('A_SOURCE_HISTORY_REVISION_CHANGED');
 const page=items.slice(request.offset,request.offset+request.limit);
 return {provider:request.provider,streamRef:request.streamRef,revision,total:items.length,offset:request.offset,items:page,
  nextOffset:request.offset+page.length<items.length?request.offset+page.length:null,currentResultVerified:false,executionAuthority:false};
}
