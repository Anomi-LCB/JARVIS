import {join} from 'node:path';
import {PolicySecurityRuntime} from '../../policy-security/src/policy-runtime.js';
import {PcAgentRuntime} from '../../pc-agent/src/pc-agent-runtime.js';
import {RuntimeTrustKernel} from '../../../packages/core/src/security/runtime-trust-kernel.js';
import {CapabilityPackageRegistry} from '../../../packages/core/src/capabilities/capability-package-registry.js';
import {SkillRouter} from '../../../packages/core/src/routing/skill-router.js';
import {registerMissionArgumentSchema} from '../../../packages/core/src/planning/mission-action-arguments.js';
import {createLocalWorkflowCapabilityPackage} from './workflow-capability-package.js';
import {EmailConnectionController} from './email-connection-controller.js';
import {defaultSkillManifest} from '../../../packages/core/src/routing/default-skill-manifest.js';
import {assertBuiltWorkflowCapability} from '../../../packages/core/src/capabilities/workflow-artifact-builder.js';

/** The service and full composition activate the same reviewed package contract. */
export function activatePcWorkflowCapability({pcAgent,capabilityPackageRegistry,skillRouter,allowedRoots,clock,processRunner,workflowCapabilityDefinition}={}){
 const definition=workflowCapabilityDefinition ? assertBuiltWorkflowCapability(workflowCapabilityDefinition) : createLocalWorkflowCapabilityPackage();
 return capabilityPackageRegistry.activate(definition,{
  skillRouter,adapterRegistry:pcAgent.registry,evidenceSchemaRegistry:pcAgent.evidenceCollector.schemaRegistry,
  registerArgumentSchema:registerMissionArgumentSchema,adapterContext:{allowedRoots,undoJournal:pcAgent.undoJournal,clock,processRunner}
 });
}

/** Shared B construction: the service and full A–G composition use identical execution dependencies. */
export function createPcAgentExecutionComponents({options={},policyRuntime,trustKernel,allowedRoots=options.allowedRoots??['./workspace']}={}){
 return new PcAgentRuntime({
  policyRuntime,trustKernel,allowedRoots,auditRoot:options.auditRoot,
  undoJournalPath:options.undoJournalPath,rollbackTransactionPath:options.rollbackTransactionPath,
  packetJournalPath:options.packetJournalPath,packetQueuePath:options.packetQueuePath,
  tokenVaultPath:options.tokenVaultPath,tokenVaultKeyProvider:options.tokenVaultKeyProvider,
  emailLedgerPath:options.emailLedgerPath,browserDriver:options.browserDriver,
  newsClient:options.newsClient,publisherRssClient:options.publisherRssClient,
  publisherArticleReader:options.publisherArticleReader,desktopControlAdapter:options.desktopControlAdapter,clock:options.clock
 });
}

/** PC service needs its existing policy/trust/executor; it does not run Core planning or simulation suites. */
export function createPcExecutionRuntime(options={}){
 if(options.workflowCapabilityDefinition) assertBuiltWorkflowCapability(options.workflowCapabilityDefinition);
 const env=options.env??process.env,trustActorId=options.trustActorId??'pc-agent-runtime',trustRoot=options.trustRoot??options.auditRoot??null;
 const trustKernel=options.trustKernel??new RuntimeTrustKernel({actorId:trustActorId,clock:options.clock,
  statePath:options.trustStatePath??(trustRoot?join(trustRoot,'runtime-trust-state.json'):null),
  auditPath:options.trustAuditPath??(trustRoot?join(trustRoot,`runtime-trust-audit-${trustActorId}.jsonl`):null),
  keyPath:options.trustKeyPath??(trustRoot?join(trustRoot,'runtime-trust-key.json'):null),
  signingSecret:options.trustSigningSecret,testMode:process.env.JARVIS_TEST_MODE==='1'||env.JARVIS_TEST_MODE==='1'});
 const policyRuntime=new PolicySecurityRuntime({...options,trustKernel});
 const pcAgent=createPcAgentExecutionComponents({options,policyRuntime,trustKernel});
 const capabilityPackageRegistry=options.capabilityPackageRegistry??new CapabilityPackageRegistry({clock:options.clock});
 // Reviewed local tool contracts only; this router never creates a second Core planner.
 const pcWorkflowSkills=new SkillRouter({manifest:[structuredClone(defaultSkillManifest.find(skill=>skill.toolName==='email.send'))]});
 const localWorkflowActivation=activatePcWorkflowCapability({pcAgent,capabilityPackageRegistry,skillRouter:pcWorkflowSkills,
  allowedRoots:options.allowedRoots??['./workspace'],clock:options.clock,processRunner:options.localWorkflowProcessRunner,workflowCapabilityDefinition:options.workflowCapabilityDefinition});
 const emailConnection=new EmailConnectionController({pcAgent,capabilityPackageRegistry,skillRouter:pcWorkflowSkills,clock:options.clock,timeoutMs:options.emailConnectionTimeoutMs??4000});
 return {policyRuntime,trustKernel,pcAgent,capabilityPackageRegistry,localWorkflowActivation,pcWorkflowSkills,emailConnection};
}
