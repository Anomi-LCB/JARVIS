import {createHash} from 'node:crypto';
import {mcpReceiptVerifierVersion} from '../capabilities/mcp-capability-package.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Read-only projection. Registration and installation never grant execution authority.
export function projectMcpRuntimeReadiness(connections,{packageRegistry,adapterRegistry}={}){
 const activations=packageRegistry?.status?.().activations??[];
 return connections.map(connection=>({...connection,capabilityReadiness:(connection.capabilityReadiness??[]).map(readiness=>{
  const name=`mcp.${connection.id}.${readiness.tool}`,contract=readiness.contract;
  const adapter=adapterRegistry?.contractFor?.(name);
  const intent=adapter?.intentBinding;
  const expected=contract?hash({version:mcpReceiptVerifierVersion,bindingHash:hash(contract),intentFingerprint:intent?.fingerprint??null}):null;
  const active=activations.find(a=>a.toolName===name);
  const installed=Boolean(readiness.contractCurrent&&active?.status==='active'&&active.packageId===contract?.packageId
   &&active.version===contract?.version&&active.verifierId===`${contract?.verifierId}.receipt`
   &&active.verifierFingerprint===expected&&Object.values(active.projections??{}).length===5&&Object.values(active.projections).every(v=>v===true)
   &&adapter?.effectScope==='external'&&adapter.readOnly===true);
  return {...readiness,packageInstalled:installed,intentBindingInstalled:installed&&typeof intent?.resolve==='function'&&typeof intent?.verify==='function',
   status:installed?'installed-policy-required':readiness.status,
   autonomousExecutionAuthorized:false,businessOutcomeVerified:false,
   requiredNext:installed?['mission-policy-check','independent-result-verification']:readiness.requiredNext};
 })}));
}
