import {createHash} from 'node:crypto';
import {createMcpCapabilityPackage} from './mcp-capability-package.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
/** Only locally reviewed executable definitions enter this catalog. No module paths from SQLite/MCP. */
export class McpPackageInstaller {
 constructor({manager,catalog=new Map(),targets,registry}){
  if(!(catalog instanceof Map))throw fail('A_MCP_INSTALL_CATALOG_INVALID');
  this.manager=manager;this.catalog=catalog;this.targets=targets;this.registry=registry;this.restoration=[];
  manager.db().exec('CREATE TABLE IF NOT EXISTS mcp_package_installations(connection_id TEXT NOT NULL,tool TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(connection_id,tool));');
 }
 entries(){return this.manager.db().prepare('SELECT value FROM mcp_package_installations ORDER BY connection_id,tool').all().map(r=>JSON.parse(r.value));}
 save(entry){this.manager.db().prepare('INSERT OR REPLACE INTO mcp_package_installations VALUES (?,?,?)').run(entry.connectionId,entry.tool,JSON.stringify(entry));}
 definition(entry){
  const reviewed=this.catalog.get(entry.catalogId);
  if(!reviewed||reviewed.fingerprint!==entry.catalogFingerprint||!/^[a-f0-9]{64}$/.test(reviewed.fingerprint??''))throw fail('A_MCP_INSTALL_REVIEWED_CODE_MISSING');
  const readiness=this.manager.capabilityReadiness(entry.connectionId,entry.tool);
  if(!readiness.contractCurrent||hash(readiness.contract)!==entry.bindingHash)throw fail('A_MCP_INSTALL_CONTRACT_CHANGED');
  if(reviewed.packageId!==readiness.contract.packageId||reviewed.version!==readiness.contract.version||reviewed.tool!==entry.tool)throw fail('A_MCP_INSTALL_CATALOG_MISMATCH');
  const intentBinding=reviewed.createIntentBinding?.({manager:this.manager,connectionId:entry.connectionId,tool:entry.tool})??null;
  return createMcpCapabilityPackage({manager:this.manager,connectionId:entry.connectionId,tool:entry.tool,verifiers:reviewed.verifiers,authorize:reviewed.authorize,intentBinding});
 }
 activate(entry){
  const definition=this.definition(entry);
  const activation=this.registry.activate(definition,this.targets);
  return {connectionId:entry.connectionId,tool:entry.tool,status:'installed',packageDigest:activation.packageDigest,autonomousExecutionAuthorized:false};
 }
 install(input){
  if(!input||Object.keys(input).length!==3||Object.keys(input).some(k=>!['connectionId','tool','catalogId'].includes(k))||Object.values(input).some(v=>typeof v!=='string'||!v))throw fail('A_MCP_INSTALL_INPUT_INVALID');
  const reviewed=this.catalog.get(input.catalogId);if(!reviewed)throw fail('A_MCP_INSTALL_REVIEWED_CODE_MISSING');
  const readiness=this.manager.capabilityReadiness(input.connectionId,input.tool);
  const entry={...input,catalogFingerprint:reviewed.fingerprint,bindingHash:hash(readiness.contract),selectedAt:new Date().toISOString()};
  // Validate before persisting; a failed durable selection must not install code.
  this.definition(entry);this.save(entry);
  this.restoration=this.restoration.filter(r=>r.connectionId!==entry.connectionId||r.tool!==entry.tool);
  try{const result=this.activate(entry);this.restoration.push(result);return result;}
  catch(error){this.restoration.push({connectionId:entry.connectionId,tool:entry.tool,status:'blocked',reasonCode:'A_MCP_INSTALL_ACTIVATION_FAILED',autonomousExecutionAuthorized:false});throw error;}
 }
 restore(){
  this.restoration=this.entries().map(entry=>{try{return this.activate(entry);}catch(error){return {connectionId:entry.connectionId,tool:entry.tool,status:'blocked',reasonCode:/^A_MCP_[A-Z0-9_]+$/.test(error.code??'')?error.code:'A_MCP_INSTALL_ACTIVATION_FAILED',autonomousExecutionAuthorized:false};}});
  return this.status();
 }
 async callTool(connectionId,input,authorize){
  const selection=this.entries().find(entry=>entry.connectionId===connectionId&&entry.tool===input?.tool);
  if(!selection)return this.manager.call(connectionId,input,authorize);
  // A selected reviewed package must never silently downgrade to a text-only manual call.
  this.definition(selection);
  if(!this.restoration.some(entry=>entry.connectionId===connectionId&&entry.tool===input.tool&&entry.status==='installed'))throw fail('A_MCP_INSTALL_ACTIVATION_FAILED');
  return this.manager.callVerifiedCapability(connectionId,input,authorize,{verifiers:this.catalog.get(selection.catalogId).verifiers});
 }
 status(){
  const selections=this.entries();
  const installations=this.restoration.map(result=>{
   const entry=selections.find(e=>e.connectionId===result.connectionId&&e.tool===result.tool);
   try{
    const reviewed=this.catalog.get(entry?.catalogId);
    if(!reviewed||reviewed.fingerprint!==entry.catalogFingerprint)throw fail('A_MCP_INSTALL_REVIEWED_CODE_MISSING');
    const readiness=this.manager.capabilityReadiness(entry.connectionId,entry.tool);
    if(!readiness.contractCurrent||hash(readiness.contract)!==entry.bindingHash)throw fail('A_MCP_INSTALL_CONTRACT_CHANGED');
    return {...result};
   }catch(error){return {...result,status:'blocked',reasonCode:/^A_MCP_[A-Z0-9_]+$/.test(error.code??'')?error.code:'A_MCP_INSTALL_ACTIVATION_FAILED'};}
  });
  return {installations,availableCatalog:[...this.catalog].map(([id,v])=>({id,packageId:v.packageId,version:v.version,tool:v.tool})),autonomousExecutionAuthorized:false};
 }
}
