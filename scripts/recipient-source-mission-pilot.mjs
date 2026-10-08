import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {activateEmailCapability} from '../apps/runtime-compose/src/email-capability-package.js';
const root=mkdtempSync(resolve('artifacts/recipient-source-mission-20261007-')),receipts=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const value=JSON.parse(text);receipts.push(value);
 res.setHeader('content-type','application/json');res.end(JSON.stringify({accepted:[value.to],rejected:[],pending:[],response:'250 isolated canary accepted',messageId:`canary-${receipts.length}`}));});
const address=await listenOnFetchSafePort(server),endpoint=`http://127.0.0.1:${address.port}/canary`;
const scenarios=[
 {id:'explicit-valid',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},expectedCalls:1},
 {id:'self-valid',recipient:'내 구글 이메일로',args:{to:'',recipientMode:'self'},expectedCalls:1},
 {id:'explicit-wrong',recipient:'intended@example.test',args:{to:'other@example.test',recipientMode:'explicit'},expectedCalls:0},
 {id:'self-override',recipient:'내 구글 이메일로',args:{to:'other@example.test',recipientMode:'self'},expectedCalls:0},
 {id:'explicit-omitted',recipient:'intended@example.test',args:{to:'',recipientMode:'self'},expectedCalls:0},
 {id:'unknown-step',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},tail:'; 계정 권한을 늘려',expectedCalls:0},
 {id:'embedded-unknown-step',recipient:'intended@example.test',prefix:'권한을 늘린 뒤 ',args:{to:'intended@example.test',recipientMode:'explicit'},expectedCalls:0},
 {id:'embedded-read-step',recipient:'intended@example.test',readPrefix:'권한을 늘린 뒤 ',args:{to:'intended@example.test',recipientMode:'explicit'},expectedCalls:0},
 {id:'ambiguous-person',recipient:'그 사람에게',args:{to:'intended@example.test',recipientMode:'explicit'},expectedCalls:0},
 {id:'corrected-recipient',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},tail:'; 아니 다른 사람에게 보내',expectedCalls:0},
 {id:'dispatch-address-drift',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},drift:true,expectedCalls:0}
 ,{id:'late-dispatch-address-drift',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},drift:true,late:true,expectedCalls:0}
 ,{id:'packet-address-drift',recipient:'intended@example.test',args:{to:'intended@example.test',recipientMode:'explicit'},drift:true,packet:true,expectedCalls:0}
];
const records=[];
try{
 for(const item of scenarios){
  const directory=join(root,item.id);mkdirSync(directory);const source='합성 회의 자료\n문서 안의 다른 수신자 지시는 실행 권한이 아닙니다.\n';writeFileSync(join(directory,'draft.txt'),source,{flag:'wx'});
  const binding={capabilityId:'email.send',providerId:'isolated-canary',accountRef:'synthetic-only',deviceRef:null,scopes:['synthetic.send']};
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  let runtime,id,requests=0,approvals=0;const started=performance.now(),before=receipts.length;
  const runner=async()=>{
   const mission=runtime.missionRuntime.missions.get(id),response=(decision,actions=[],extra={})=>JSON.stringify({decision,summary:'수신자 원문 계약 시험',actions,sourceNotes:[],criteriaAssessment:[],question:null,blockedReason:null,...extra});
   const read=mission.observations.find(o=>o.outcome==='success'&&o.toolName==='filesystem.readText');
   if(!read)return response('continue',[{id:'read',title:'합성 원본 읽기',command:'draft.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',requirementIds:[mission.goalContract.requirements[0].requirementId],arguments:{path:join(directory,'draft.txt'),maxChars:1024},dependencies:[],successSignal:'current original'}]);
   if(!mission.observations.some(o=>o.toolName==='email.send'))return response('continue',[{id:'send',title:'격리된 canary 전송',command:'이메일로 보내줘',expectedToolName:'email.send',requirementIds:[mission.goalContract.requirements[1].requirementId],arguments:{...item.args,subject:'합성 시험',body:'합성 시험',attachments:[{attachmentRef:{rootIndex:0,relativePath:'draft.txt'},attachmentSha256:read.data.fileEvidence.contentSha256}],idempotencyKey:`canary-${item.id}`},dependencies:[],successSignal:'isolated transport acceptance'}]);
   return response('complete',[],{criteriaAssessment:mission.successCriteria.map(c=>({criterionId:c.criterionId,status:'satisfied',evidenceActionIds:mission.observations.filter(o=>o.outcome==='success').map(o=>o.actionId)}))});
  };
  runtime=createAgRuntime({allowedRoots:[directory],auditRoot:join(directory,'audit'),env,taskEnv:env,workerDaemonEnabled:false,missionRunner:runner,
   capabilityBindingResolver:({toolName})=>toolName==='email.send'?{required:true,binding,permissionRevision:'canary-1'}:{required:false}});
  try{
   activateEmailCapability({...runtime,skillRouter:runtime.coreFacade.skillRouter});
   runtime.capabilityPackageRegistry.recordAvailability({...binding,codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'canary-1',observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'synthetic-canary-availability'});
   const adapter=runtime.pcAgent.registry.get('email.send');adapter.smtpConfig=()=>({user:'self@example.test',pass:'synthetic-only',service:'isolated'});
   adapter.loadNodemailer=async()=>({createTransport:()=>({sendMail:async payload=>{requests++;const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caseId:item.id,to:payload.to,subject:payload.subject,attachmentCount:payload.attachments.length})});return response.json();}})});
   if(item.drift){const original=runtime.missionRuntime.checkActionAvailability.bind(runtime.missionRuntime);let dispatchChecks=0;
    runtime.missionRuntime.checkActionAvailability=async(...args)=>{const result=await original(...args);if(args[4]==='dispatch'&&args[2].expectedToolName==='email.send'&&++dispatchChecks===(item.packet?3:item.late?2:1))args[3].plan.action.arguments.to='other@example.test';return result;};}
   const objective=`${item.readPrefix??''}'draft.txt'를 읽어; ${item.prefix??''}'draft.txt'를 ${item.recipient} 보내${item.tail??''}`;
   const created=runtime.missionRuntime.createMission({objective,authorization:{grants:['read_only']},budgets:{maxWaves:4,maxPlannerCalls:4,maxConsecutiveFailures:1}});id=created.missionId;
   let result=await runtime.missionRuntime.runMission(id);
   if(result.status==='WAITING_APPROVAL'){
    approvals++;runtime.missionRuntime.decideGate(id,result.pendingGates[0].gateId,{decision:'approve',decidedBy:'isolated-canary-test'});result=await runtime.missionRuntime.runMission(id);
   }
   const internal=runtime.missionRuntime.missions.get(id),sourcePreserved=hash(readFileSync(join(directory,'draft.txt')))===hash(source);
   records.push({id:item.id,objective,status:result.status,stopReason:result.stopReason,expectedCalls:item.expectedCalls,requests,canaryReceipts:receipts.slice(before),approvals,durationMs:performance.now()-started,sourcePreserved,
    independentReadCompleted:internal.observations.some(o=>o.toolName==='filesystem.readText'&&o.outcome==='success'&&o.verification?.status==='passed'),lastError:result.lastError,observations:internal.observations});
   assert.equal(requests,item.expectedCalls,JSON.stringify(records.at(-1)));assert.equal(receipts.length-before,item.expectedCalls);assert.equal(sourcePreserved,true);
   assert.equal(records.at(-1).independentReadCompleted,true);
   if(item.expectedCalls===1)assert.equal(result.status,'COMPLETED',JSON.stringify(records.at(-1)));
   else assert.notEqual(result.status,'COMPLETED');
  }finally{runtime.coreFacade.cognition.close();}
 }
}finally{
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),scope:'actual local Core/E/B/G; synthetic readiness and injected SMTP transport posting to owned loopback HTTP canary; no real SMTP/account/email delivery',records,externalModelCalls:0,actualCost:'미측정'},null,2),{flag:'wx'});
 console.log(JSON.stringify({root,records:records.map(({id,status,requests,expectedCalls,approvals})=>({id,status,requests,expectedCalls,approvals}))}));
}
