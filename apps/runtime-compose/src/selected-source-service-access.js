import {createHash,randomBytes} from 'node:crypto';
import {SelectedSourceClient,normalizeSelectedSourceToolRequest,selectedSourceDigest} from '../../pc-agent/src/adapters/selected-source-client.js';
import {readSelectedSourceStream} from '../../../packages/core/src/personal-operations/selected-source-stream.js';
import {CoreAdminScope} from '../../../packages/core/src/security/core-admin-auth.js';
import {SelectedSourceTaskReceipts} from '../../../packages/core/src/mission/selected-source-task-receipts.js';

/** Host-owned service composition. No task can choose a token, host or SQL file. */
export function createSelectedSourceServiceAccess({inbox,adminAuth,getRuntime,getServer,clock=()=>new Date()}={}) {
 const tokenPrefix='source-worker-'+randomBytes(12).toString('hex');let closed=false;
 const bindingFor=request=>({capabilityId:'source.readSelectedInbox',providerId:'core-inbox',accountRef:request.streamRef,deviceRef:null,scopes:['selected.metadata.read']});
 const permissionRevision='stored-metadata-v1';
 let receiptStore;
 const receipts=()=>{
  if(receiptStore)return receiptStore;
  try{receiptStore=new SelectedSourceTaskReceipts({store:inbox.store,readCurrentSnapshot,
    signer:getRuntime().trustKernel.createPurposeBoundSigner({purpose:'core-selected-source-task-receipt-v1'})});return receiptStore;}catch{return null;}
 };
 const active=(readView=false)=>{if(closed)return false;try{
  const authority=getRuntime()?.missionRuntime?.executionAuthority;
  if(!authority)return true;
  if(!readView){authority.assertActive();return true;}
  // The selected SQL read already owns a transaction on this connection.
  // Observe the same lease without nesting BEGIN IMMEDIATE; full monotonic
  // assertions remain mandatory immediately outside the read transaction.
  const lease=authority.lease,status=authority.store.coreAuthorityStatus(),wall=clock().getTime();
  const floor=authority.store.db.prepare('SELECT clock_ms FROM mission_sqlite_meta WHERE id=1').get().clock_ms;
  return Number.isSafeInteger(wall)&&wall>=0&&!authority.recoveryOnly&&lease?.resourceKey==='mission-core-authority'
    &&lease.ownerId===status.ownerId&&lease.token===status.token&&status.expiresMs>Math.max(wall,floor,authority.store.observedClockMs??0);
 }catch{return false;}};
 const known=(request,readView=false)=>active(readView)&&inbox.selectedStreams().some(s=>s.provider===request.provider&&s.streamRef===request.streamRef);
 const readCurrentSnapshot=request=>{
  if(!known(request))throw new Error('A_SOURCE_SERVICE_SELECTION_DENIED');
  const result=readSelectedSourceStream(inbox,request,{checkAuthorized:()=>known(request,true)});
  if(!known(request))throw new Error('A_SOURCE_SERVICE_SELECTION_DENIED');
  return result;
 };
 const issue=request=>{
  if(!known(request))throw new Error('A_SOURCE_SERVICE_SELECTION_DENIED');
  const now=clock(),owned=r=>r.tokenId.startsWith(tokenPrefix);
  adminAuth.records=adminAuth.records.filter(r=>!owned(r)||Date.parse(r.expiresAt)>now.getTime());
  if(adminAuth.records.filter(owned).length>=64)throw new Error('A_SOURCE_SERVICE_CREDENTIAL_CAPACITY');
  const token=randomBytes(32).toString('hex');
  adminAuth.records.push(adminAuth.normalizeHashRecord({tokenHash:createHash('sha256').update(token).digest('hex'),
   tokenId:tokenPrefix+'-'+randomBytes(8).toString('hex'),role:'selected-source-worker',scopes:[CoreAdminScope.READ_SELECTED_SOURCE],
   selectedSourceBindings:[{provider:request.provider,streamRef:request.streamRef}],expiresAt:new Date(now.getTime()+60000).toISOString()}));
  return token;
 };
 const access={readCurrentSnapshot,
  archiveCompletedAction:(mission,action,task)=>receipts()?.record(mission,action,task)??false,
  readRecoveredTask:(mission,action)=>receipts()?.recover(mission,action)??null,
  revalidateReadBinding:request=>access.resolveBinding({action:{arguments:request}}),
  authorizeRequest(request,packet){
   if(!known(request))return false;
   const availability=getRuntime()?.capabilityPackageRegistry.availabilityFor(bindingFor(request));
   if(!availability?.codeReady||availability.accountStatus!=='connected'||availability.permissionRevision!==permissionRevision
     ||availability.reasons.some(reason=>reason.code!=='observation-stale'))return false;
   let task=getRuntime()?.coreFacade.getTask(packet?.taskId);
   if(!task)for(const mission of getRuntime()?.missionRuntime.missions.values()??[]){
    const actions=mission.waves.flatMap(w=>w.actions).filter(a=>a.taskId===packet?.taskId);
    if(actions.length===1){task=access.readRecoveredTask(mission,actions[0]);if(task)break;}
   }
   if(!task||!['APPROVED','EXECUTING','VERIFYING','COMPLETED'].includes(task.status)||task.plan?.action?.toolName!=='source.readSelectedInbox')return false;
   try{return selectedSourceDigest(normalizeSelectedSourceToolRequest(task.plan.action.arguments))===selectedSourceDigest(normalizeSelectedSourceToolRequest(request));}catch{return false;}
  },
  client:{async read(request,options){
   const server=getServer(),address=server?.address();
   if(!active()||!server?.listening||!address||typeof address==='string')throw new Error('A_SOURCE_SERVICE_NOT_LISTENING');
   const host=address.family==='IPv6'?'[::1]':'127.0.0.1';
   let issuedHash;
   try{return await new SelectedSourceClient({baseUrl:`http://${host}:${address.port}`,tokenProvider:selected=>{
    const token=issue(selected);issuedHash=createHash('sha256').update(token).digest('hex');return token;
   }}).read(request,options);}
   finally{if(issuedHash)adminAuth.records=adminAuth.records.filter(record=>!(record.tokenId.startsWith(tokenPrefix)&&record.tokenHash===issuedHash));}
  }},
  resolveBinding({action,task}){
   let request;try{request=normalizeSelectedSourceToolRequest(action?.arguments??task?.plan?.action?.arguments);}catch{return {required:true};}
   if(!known(request))return {required:true};
   // A successful local SQL read proves stored metadata access only, not OAuth
   // connectivity or provider freshness. The provider identity is core-inbox.
   readCurrentSnapshot({...request,offset:0,limit:1,expectedRevision:undefined});
   const runtime=getRuntime(),binding=bindingFor(request),prior=runtime.capabilityPackageRegistry.availabilityFor(binding);
   if(prior.observedAt&&(prior.accountStatus!=='connected'||prior.permissionRevision!==permissionRevision
     ||prior.reasons.some(reason=>reason.code!=='observation-stale')))
    return {required:true,binding,permissionRevision:prior.permissionRevision};
   runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:prior.codeVersion,
    permissionRevision,observedAt:clock().toISOString(),accountStatus:'connected',observedAccountRef:request.streamRef,
    deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'core-owned-stored-metadata-snapshot'});
   return {required:true,binding,permissionRevision};
  }
 };
 return {access,close(){closed=true;adminAuth.records=adminAuth.records.filter(r=>!r.tokenId.startsWith(tokenPrefix));}};
}
