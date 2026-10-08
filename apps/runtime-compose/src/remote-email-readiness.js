import {activateEmailCapability} from './email-capability-package.js';
const fail=()=>{throw Object.assign(new Error('Remote email readiness is invalid.'),{code:'A_PC_EMAIL_READINESS_INVALID'});};
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Authenticated B observations only; this never manages credentials or authorizes remote effects. */
export class RemoteEmailReadiness {
 #last=null;
 constructor({client,pcAgent,registry,skillRouter}={}){this.client=client;this.pcAgent=pcAgent;this.registry=registry;this.skillRouter=skillRouter;}
 async resolve(){
  try{return await this.#read();}
  catch(error){this.#forget();throw error;}
 }
 #forget(){if(this.#last){this.registry.forgetAvailability(this.#last.binding,{expectedEvidenceRef:this.#last.evidenceRef});this.#last=null;}}
 async #read(){
  const value=await this.client.emailReadiness();
  if(!keys(value,['version','toolName','available','executionAuthorized','binding','permissionRevision','observation'])
   ||value.version!=='b-email-readiness-v1'||value.toolName!=='email.send'||typeof value.available!=='boolean'
   ||value.executionAuthorized!==false||typeof value.permissionRevision!=='string'||!/^[-a-zA-Z0-9_:.]{1,200}$/u.test(value.permissionRevision))fail();
  if(!value.available){if(value.binding!==null||value.observation!==null)fail();this.#forget();return {required:true,binding:null,permissionRevision:value.permissionRevision};}
  const binding=value.binding,observation=value.observation;
  if(!keys(binding,['capabilityId','providerId','accountRef','deviceRef','scopes'])||binding.capabilityId!=='email.send'
   ||!/^smtp-(gmail|outlook|hotmail|yahoo)$/u.test(binding.providerId??'')||!/^smtp-[a-f0-9]{64}$/u.test(binding.accountRef??'')
   ||binding.deviceRef!==null||!same(binding.scopes,['smtp:authenticated'])
   ||!keys(observation,['capabilityId','providerId','accountRef','deviceRef','scopes','codeVersion','permissionRevision','observedAt','accountStatus','observedAccountRef','deviceStatus','grantedScopes','verificationLevel','evidenceRef'])
   ||['capabilityId','providerId','accountRef','deviceRef','scopes'].some(key=>!same(binding[key],observation[key]))
   ||observation.permissionRevision!==value.permissionRevision||observation.accountStatus!=='connected'
   ||observation.observedAccountRef!==binding.accountRef||observation.deviceStatus!=='not-required'
   ||!same(observation.grantedScopes,binding.scopes)||observation.verificationLevel!=='live-probe'
   ||!/^smtp-check-[a-f0-9-]{36}$/u.test(observation.evidenceRef??''))fail();
  activateEmailCapability({pcAgent:this.pcAgent,capabilityPackageRegistry:this.registry,skillRouter:this.skillRouter});
  if(this.registry.availabilityFor(binding).codeVersion!==observation.codeVersion)fail();
  if(this.#last&&!same(this.#last.binding,binding))this.#forget();
  this.registry.recordAvailability(observation);
  this.#last={binding:structuredClone(binding),evidenceRef:observation.evidenceRef};
  return {required:true,binding:structuredClone(binding),permissionRevision:value.permissionRevision};
 }
}
