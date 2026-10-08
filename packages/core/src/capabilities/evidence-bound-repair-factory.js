import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
/** Reviewed host recipes, not a generic model-written patch executor. Actual
 * improvement still requires the unchanged independent isolation/comparison gate. */
export function createEvidenceBoundRepairFactory(recipes) {
 if(!Array.isArray(recipes)||!recipes.length)fail('A_IMPROVEMENT_REPAIR_CONFIG_INVALID');
 const keys=new Set(),diagnoses=new WeakMap();
 const configured=recipes.map(recipe=>{
  const {toolName,failureCode,executionCodeVersion,sourceUrls,reproducerEvidenceSha256,buildCandidate}=recipe;
  if(typeof toolName!=='string'||typeof failureCode!=='string'||!hex(executionCodeVersion)||!hex(reproducerEvidenceSha256)
   ||!Array.isArray(sourceUrls)||!sourceUrls.length||new Set(sourceUrls).size!==sourceUrls.length
   ||sourceUrls.some(url=>{try {const u=new URL(url);return u.protocol!=='https:'||u.username||u.password||u.search||u.hash;}catch{return true;}})
   ||typeof buildCandidate!=='function')fail('A_IMPROVEMENT_REPAIR_CONFIG_INVALID');
  const key=JSON.stringify([toolName,failureCode,executionCodeVersion]);
  if(keys.has(key))fail('A_IMPROVEMENT_REPAIR_AMBIGUOUS');keys.add(key);
  return Object.freeze({toolName,failureCode,executionCodeVersion,sourceUrls:Object.freeze([...sourceUrls]),reproducerEvidenceSha256,buildCandidate});
 });
 const factory=async(input,{signal}={})=>{
  signal?.throwIfAborted();
  const recipe=configured.find(r=>r.toolName===input.toolName&&r.failureCode===input.failureCode&&r.executionCodeVersion===input.executionCodeVersion);
  if(!recipe||input.failureObservationVersion!==2||!Number.isSafeInteger(input.failureCount)||input.failureCount<2)fail('A_IMPROVEMENT_REPAIR_NOT_IDENTIFIED');
  if(!Array.isArray(input.sources)||recipe.sourceUrls.some(url=>!input.sources.some(s=>s.url===url&&hex(s.contentSha256)
    &&typeof s.content==='string'&&createHash('sha256').update(s.content).digest('hex')===s.contentSha256
    &&typeof s.observedAt==='string'&&Number.isFinite(Date.parse(s.observedAt))&&s.instructionAuthority===false&&s.trustBoundary==='externalContent')))
   fail('A_IMPROVEMENT_REPAIR_SOURCE_MISSING');
  const definition=await recipe.buildCandidate();signal?.throwIfAborted();
  if(definition?.skill?.toolName!==recipe.toolName||!hex(definition.artifactSha256))fail('A_IMPROVEMENT_REPAIR_ARTIFACT_INVALID');
  const diagnosis=Object.freeze({schemaVersion:'a-evidence-bound-repair-v1',toolName:recipe.toolName,failureCode:recipe.failureCode,
   baselinePackageDigest:recipe.executionCodeVersion,reproducerEvidenceSha256:recipe.reproducerEvidenceSha256,
   candidateArtifactSha256:definition.artifactSha256,sources:recipe.sourceUrls.map(url=>{
    const s=input.sources.find(s=>s.url===url);return {url,contentSha256:s.contentSha256,observedAt:s.observedAt};}),
   trustedHostRecipe:true,independentlyImproved:false,executionAuthority:false});
  diagnoses.set(definition,diagnosis);return definition;
 };
 Object.defineProperty(factory,'diagnosisFor',{value:definition=>{const d=diagnoses.get(definition);return d?structuredClone(d):null;}});
 return factory;
}
