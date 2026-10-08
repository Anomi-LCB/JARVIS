import {createHash} from 'node:crypto';
export const lifecycleCaseDigest=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
const fail=code=>{throw Error(code);};
export function normalizeLifecycleCaseRead(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['caseId','expectedStoreId','expectedRevision','rawText'].includes(k)))fail('CASE_READ_REQUEST_INVALID');
 if(args.rawText!==undefined&&typeof args.rawText!=='string')fail('CASE_READ_REQUEST_INVALID');
 if(!/^[0-9a-f-]{36}$/u.test(args.caseId??'')||!/^[0-9a-f-]{36}$/u.test(args.expectedStoreId??'')||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1)fail('CASE_READ_REQUEST_INVALID');
 return {caseId:args.caseId,expectedStoreId:args.expectedStoreId,expectedRevision:args.expectedRevision};
}
export function readLifecycleCaseSnapshot(cases,args){
 const request=normalizeLifecycleCaseRead(args);if(cases.context().storeId!==request.expectedStoreId)fail('CASE_READ_STORE_CHANGED');
 const item=cases.get(request.caseId,{includeEvents:false});if(!item)fail('CASE_READ_NOT_FOUND');if(item.revision!==request.expectedRevision)fail('CASE_READ_REVISION_CHANGED');
 return {version:'lifecycle-case-snapshot-v1',storeId:request.expectedStoreId,caseId:item.id,revision:item.revision,kind:item.kind,provider:item.provider,accountRef:item.accountRef,providerRef:item.providerRef,title:item.title,dueAt:item.dueAt,deadlineState:item.deadlineState,observation:item.observation,cancellation:item.cancellation,handoff:item.handoff,readOnly:true,providerVerified:false,completionVerified:false,executionAuthority:false,containsUntrustedText:true};
}
export function validateLifecycleCaseSnapshot(snapshot,request){
 if(snapshot?.version!=='lifecycle-case-snapshot-v1'||snapshot.storeId!==request.expectedStoreId||snapshot.caseId!==request.caseId||snapshot.revision!==request.expectedRevision||snapshot.readOnly!==true||snapshot.providerVerified!==false||snapshot.completionVerified!==false||snapshot.executionAuthority!==false||snapshot.containsUntrustedText!==true)fail('CASE_READ_RESULT_INVALID');
}
export function lifecycleCaseMandateRef(args){const r=normalizeLifecycleCaseRead(args);return `lifecycle-case:${r.expectedStoreId}:${r.caseId}`;}
