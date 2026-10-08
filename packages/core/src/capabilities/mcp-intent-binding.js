import {createHash} from 'node:crypto';
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});

/** Local reviewed parser only; an MCP tool description cannot provide this code. */
export function createMcpIntentBinding({manager,connectionId,tool,resolver,fingerprint}) {
 if(typeof resolver!=='function'||!/^[a-f0-9]{64}$/.test(fingerprint??''))throw fail('A_MCP_INTENT_RESOLVER_REQUIRED');
 const initial=manager.capabilityReadiness(connectionId,tool);
 if(!initial.contractCurrent)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
 const bound=hash(initial.contract),toolName=`mcp.${connectionId}.${tool}`;
 function resolve(objective){
  if(typeof objective!=='string'||!objective.trim()||objective.length>16000)throw fail('A_MCP_INTENT_INPUT_INVALID');
  const current=manager.capabilityReadiness(connectionId,tool);
  if(!current.contractCurrent||hash(current.contract)!==bound)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
  const parsed=resolver(objective);
  if(parsed===null)return null;
  if(!parsed||typeof parsed!=='object'||Object.keys(parsed).some(key=>!['arguments','expectedText'].includes(key))
   ||typeof parsed.then==='function'||!parsed.arguments||Array.isArray(parsed.arguments)||typeof parsed.arguments!=='object'
   ||typeof parsed.expectedText!=='string'||!parsed.expectedText.trim()||parsed.expectedText.length>1000)throw fail('A_MCP_INTENT_RESOLUTION_INVALID');
  const args=structuredClone(parsed.arguments);
  if(Buffer.byteLength(JSON.stringify(args))>24000)throw fail('A_MCP_INTENT_RESOLUTION_INVALID');
  manager.validateToolArguments(connectionId,tool,args);
  return {version:'mcp-intent-binding-v1',objectiveHash:hash(objective),toolName,arguments:args,expectedText:parsed.expectedText,
   bindingHash:bound,resolverFingerprint:fingerprint,sourceCoverage:'reviewed-local-parser',executionAuthorized:false};
 }
 return Object.freeze({fingerprint,toolName,resolve,verify(input){
  try{const expected=resolve(input?.objective);return Boolean(expected&&input.toolName===toolName
   &&hash(input.arguments)===hash(expected.arguments)&&input.expectedText===expected.expectedText);}
  catch{return false;}
 }});
}
