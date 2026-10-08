import {normalizeMicrosoftCollection,collectionDigest,MICROSOFT_COLLECTION_TOOL} from './microsoft-collection-capability-package.js';
/** Host-installed reader, inbox and policy. Model JSON cannot supply any of them. */
export function createMicrosoftCollectionAccess({reader,inbox,readTrustedTask,authorizeConnection,effectContextFor=null}={}){
 if(typeof reader?.page!=='function'||typeof reader?.commitPage!=='function'||typeof reader?.verifyCommittedPage!=='function'||typeof inbox?.verifyPage!=='function'||typeof readTrustedTask!=='function'||typeof authorizeConnection!=='function')throw Error('A_MICROSOFT_COLLECTION_CONFIGURATION_REQUIRED');
 if(effectContextFor!==null&&typeof effectContextFor!=='function')throw Error('A_MICROSOFT_EFFECT_CONFIGURATION_REQUIRED');
 const receipts=new Map();let closed=false;
 const authorized=request=>!closed&&authorizeConnection(request)===true;
 const access={
  authorizeRequest(request,packet){
   try{const task=readTrustedTask(packet?.taskId);return ['APPROVED','EXECUTING','VERIFYING'].includes(task?.status)&&task.plan?.action?.toolName===MICROSOFT_COLLECTION_TOOL&&collectionDigest(normalizeMicrosoftCollection(task.plan.action.arguments))===collectionDigest(request)&&authorized(request);}catch{return false;}
  },
  authorizeVerification:(request,task)=>access.authorizeRequest(request,{taskId:task?.taskId}),
  async collect(request,{checkCurrent,taskId}={}){
   request=normalizeMicrosoftCollection(request);
   if(typeof checkCurrent!=='function')throw Error('A_MICROSOFT_COLLECTION_POLICY_REQUIRED');
   const check=()=>checkCurrent()===true&&authorized(request);
   if(!check())throw Error('A_MICROSOFT_COLLECTION_DENIED');
   const effect=effectContextFor?.(taskId,request);
   if(effectContextFor&&!effect?.ledger)throw Error('A_MICROSOFT_EFFECT_BINDING_REQUIRED');
   const checkEffect=()=>{if(effect){const current=effectContextFor(taskId,request);if(current?.ledger!==effect.ledger||collectionDigest(current.binding)!==collectionDigest(effect.binding))throw Error('A_MICROSOFT_EFFECT_BINDING_CHANGED');}return true;};
   checkEffect();
   const claim=effect?.ledger.claim(effect.binding,request);
   if(claim?.replayed){check();checkEffect();const receipt=claim.receipt;receipts.set(collectionDigest(receipt),{effect,request,check:()=>checkEffect()&&access.authorizeRequest(request,{taskId})});return receipt;}
   try{
   // Keep the current execution/mandate fence through every provider request
   // and atomic commit. After commit G uses its own mandate fence; a consumed
   // B packet must not be reused as verification permission.
   let committedPhase=false;
   const providerPolicy=()=>checkEffect()&&access.authorizeRequest(request,{taskId})&&(committedPhase||check());
   const page=await reader.page(request,{authorize:providerPolicy});
   if(effect?.validatePage&&effect.validatePage(page)!==true)throw Error('A_MICROSOFT_COLLECTION_PAGE_CHAIN_INVALID');
   const committed=reader.commitPage(page,inbox,{authorize:()=>checkEffect()&&check(),onCommit:effect?verification=>{
     const {contentImported,...publicPage}=page;
     effect.ledger.commit(effect.binding,request,{version:'microsoft-collection-receipt-v1',request,page:publicPage,verification});
   }:undefined});
   committedPhase=true;
   // Keep the reader's contentImported guard private. Generic evidence redaction
   // treats all content* keys as sensitive; public metadata never contains body.
   const {contentImported,...publicPage}=page;
   const receipt={version:'microsoft-collection-receipt-v1',request,page:publicPage,verification:committed.verification};
   // Keep private provider-page provenance outside evidence/model JSON.
   const key=collectionDigest(receipt);
   if(receipts.size>=128)receipts.delete(receipts.keys().next().value);
   receipts.set(key,{page,request,check:providerPolicy});
   return receipt;
   }catch(error){if(effect)effect.ledger.uncertain(effect.binding);throw error;}
  },
  verifyCollectedPage(receipt){
   const original=receipts.get(collectionDigest(receipt));
   if(!original||!authorized(original.request))throw Error('A_MICROSOFT_COLLECTION_PROOF_REQUIRED');
   if(original.effect){if(original.check()!==true)throw Error('A_MICROSOFT_EFFECT_BINDING_CHANGED');return original.effect.ledger.recover(original.effect.binding,original.request).verification;}
   return reader.verifyCommittedPage(original.page,inbox,{authorize:original.check});
  },
  verifyCollectionPages:pages=>inbox.verifyCollection(pages),
  readOperationReceipt(taskId,request,{historical=false}={}){
   request=normalizeMicrosoftCollection(request);
   if(!authorized(request))throw Error('A_MICROSOFT_EFFECT_RESULT_DENIED');
   const effect=effectContextFor?.(taskId,request);
   if(!effect?.ledger)throw Error('A_MICROSOFT_EFFECT_PROOF_REQUIRED');
   return effect.ledger.recover(effect.binding,request,{historical});
  },
  readCommittedReceipt(taskId,request,{recoveredTask=null,historical=false}={}){
   request=normalizeMicrosoftCollection(request);
   const task=readTrustedTask(taskId)??recoveredTask;
   if(!authorized(request)||task?.status!=='COMPLETED'||task.plan?.action?.toolName!==MICROSOFT_COLLECTION_TOOL
    ||collectionDigest(normalizeMicrosoftCollection(task.plan.action.arguments))!==collectionDigest(request))throw Error('A_MICROSOFT_EFFECT_RESULT_DENIED');
   return access.readOperationReceipt(taskId,request,{historical});
  },
  close(){closed=true;receipts.clear();}
 };
 return access;
}
