import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { activateEmailCapability, verifyEmailAcceptanceEvidence } from '../apps/runtime-compose/src/email-capability-package.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-email-package-')); let now = Date.now();
  const binding = { capabilityId:'email.send',providerId:'isolated-smtp',accountRef:'synthetic-account',deviceRef:null,scopes:['synthetic.send'] };
  const env = {JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  const runtime = createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
    clock:()=>new Date(now),capabilityBindingResolver:({toolName})=>toolName==='email.send'?{required:true,binding,permissionRevision:'email-1'}:{required:false}});
  t.after(async()=>{runtime.coreFacade.cognition?.close();await rm(root,{recursive:true,force:true});});
  const observe = () => runtime.capabilityPackageRegistry.recordAvailability({...binding,
    codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'email-1',
    observedAt:new Date(++now).toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,
    deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-email-package'});
  return {runtime,binding,observe};
}
test('email-specific code package retains the live adapter and executes through Core/E/B/G',async t=>{
  const f=await fixture(t),adapter=f.runtime.pcAgent.registry.get('email.send');let sends=0;
  const activation=activateEmailCapability({...f.runtime,skillRouter:f.runtime.coreFacade.skillRouter});
  assert.equal(activation.toolName,'email.send');assert.equal(activation.projections.verifier,true);
  assert.equal(f.runtime.pcAgent.registry.get('email.send'),adapter);
  assert.deepEqual(activateEmailCapability({...f.runtime,skillRouter:f.runtime.coreFacade.skillRouter}),activation);
  assert.equal(f.runtime.capabilityPackageRegistry.availabilityFor(f.binding).available,false,'code activation is not account connection');
  f.observe();assert.equal(f.runtime.capabilityPackageRegistry.availabilityFor(f.binding).available,true);
  adapter.smtpConfig=()=>({user:'sender@example.test',pass:'synthetic-only',service:'isolated'});
  adapter.loadNodemailer=async()=>({createTransport:()=>({sendMail:async()=>{sends++;return {accepted:['recipient@example.test'],rejected:[],pending:[],response:'250 accepted',messageId:'synthetic'};}})});
  const task=f.runtime.coreFacade.createTask('이메일로 보내줘');task.plan.action.arguments={to:'recipient@example.test',subject:'synthetic',body:'synthetic'};
  const run=await f.runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(run.success,true,JSON.stringify({error:run.error,verification:run.executionVerification,executionError:run.execution?.executionResult?.error}));assert.equal(run.executionVerification.status,'passed');assert.equal(sends,1);
  const evidence=run.execution.evidence;
  assert.equal(f.runtime.capabilityPackageRegistry.verify('email.send',evidence).valid,true,JSON.stringify({evidence,check:f.runtime.capabilityPackageRegistry.verify('email.send',evidence)}));
  for(const mutate of [e=>e.adapterEvidence.email.pendingRecipientCount=1,e=>e.changedItems[0].attachmentCount=3,
    e=>e.changedItems[0].providerMessageIdSha256='a'.repeat(64),e=>e.adapterEvidence.email.responseCode=550]){
    const altered=structuredClone(evidence);mutate(altered);assert.equal(verifyEmailAcceptanceEvidence(altered).valid,false);
  }
});
test('failed built-in package adoption preserves every existing route projection',async t=>{
  const f=await fixture(t),router=f.runtime.coreFacade.skillRouter,adapter=f.runtime.pcAgent.registry.get('email.send'),skill=router.skills.get('email_send_skill');
  const register=f.runtime.pcAgent.evidenceCollector.schemaRegistry.register.bind(f.runtime.pcAgent.evidenceCollector.schemaRegistry);
  f.runtime.pcAgent.evidenceCollector.schemaRegistry.register=(tool,...args)=>{if(tool==='email.send')throw new Error('synthetic activation fault');return register(tool,...args);};
  assert.throws(()=>activateEmailCapability({...f.runtime,skillRouter:router}),/synthetic activation fault/);
  assert.equal(f.runtime.pcAgent.registry.get('email.send'),adapter);assert.equal(router.skills.get('email_send_skill'),skill);
  assert.equal(f.runtime.capabilityPackageRegistry.activations.has('email.send'),false);
});
test('adoption cannot replace a user-customized permission contract with defaults',async t=>{
  const f=await fixture(t),router=f.runtime.coreFacade.skillRouter,skill=router.skills.get('email_send_skill');
  skill.capability={...skill.capability,maxRiskTier:4};
  assert.throws(()=>activateEmailCapability({...f.runtime,skillRouter:router}),/A_EMAIL_CUSTOM_SKILL_PRESERVED/);
  assert.equal(router.skills.get('email_send_skill'),skill);assert.equal(skill.capability.maxRiskTier,4);
  assert.equal(f.runtime.capabilityPackageRegistry.activations.has('email.send'),false);
});
