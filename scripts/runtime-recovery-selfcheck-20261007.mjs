import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const prefix='artifacts/runtime-recovery-20261007',name='runtime-recovery-self-check-20261007.txt',file=resolve('workspace',name);
const content='JARVIS local runtime diagnostic. Synthetic text only. No account data.';
writeFileSync(file,content,{flag:'wx'});
const call=async(path,body)=>{const r=await fetch('http://127.0.0.1:41730/api/core'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const data=await r.json();assert.ok(r.ok,JSON.stringify({http:r.status,code:data.error?.code}));return data;};
const objective=`내가 승인하면 '${name}'를 읽어`;
const created=await call('/missions',{objective,authorization:{grants:['read_only']},metadata:{longTermMemory:false,origin:'operator-local-runtime-diagnostic'}});
writeFileSync(`${prefix}-mission-created.json`,JSON.stringify(created,null,2)+'\n',{flag:'wx'});
const waiting=await call(`/missions/${created.missionId}/run`,{});
writeFileSync(`${prefix}-mission-waiting.json`,JSON.stringify(waiting,null,2)+'\n',{flag:'wx'});
assert.equal(waiting.status,'WAITING_APPROVAL');assert.equal(waiting.metrics.plannerCalls,0);
assert.equal(waiting.pendingGates.length,1);assert.equal(waiting.waves.length,0);
// This is an operator's functional test answer, not evidence of human approval.
const completed=await call(`/missions/${created.missionId}/gates/${waiting.pendingGates[0].gateId}/decision`,{decision:'approve',answers:['승인']});
writeFileSync(`${prefix}-mission-after-answer.json`,JSON.stringify(completed,null,2)+'\n',{flag:'wx'});
assert.equal(completed.status,'COMPLETED',JSON.stringify({status:completed.status,reason:completed.stopReason,error:completed.lastError,verification:completed.verificationSummary}));
assert.equal(completed.goalContract.revision,2);assert.deepEqual(completed.authorization.grants,['read_only']);
assert.equal(readFileSync(file,'utf8'),content);
const saved=await call(`/missions/${created.missionId}`);assert.equal(saved.status,'COMPLETED');
writeFileSync(`${prefix}-mission-reloaded.json`,JSON.stringify(saved,null,2)+'\n',{flag:'wx'});
const result={observedAt:new Date().toISOString(),missionId:created.missionId,status:saved.status,sourceSha256:createHash('sha256').update(content).digest('hex'),sourceBytes:Buffer.byteLength(content),originalSourcePreserved:true,
  sameMissionRevision:2,conditionQuestions:1,authorizationUnchanged:true,humanApprovalObserved:false,answerKind:'operator-functional-test',longTermMemory:false,installedExeTested:false};
writeFileSync(`${prefix}-selfcheck.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
