import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';

const versions = new Set(['2026-07-28', '2025-11-25']);
const fail = code => Object.assign(new Error(code), { code });
export function validateMcpEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('A_MCP_ENDPOINT_INVALID'); }
  // No DNS lookup, arbitrary public/private network access, credentials or query secrets.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) {
    throw fail('A_MCP_LOCAL_ENDPOINT_REQUIRED');
  }
  return url.href;
}

export class McpConnectionManager {
  constructor({ storePath = resolve(process.env.LOCALAPPDATA || resolve(homedir(), '.jarvis'), 'JARVIS/integrations/mcp.sqlite'), fetchImpl = fetch, resultClock = Date.now } = {}) {
    this.storePath = storePath; this.fetchImpl = fetchImpl; this.busy = new Set();
    this.verifiedResults = new Map(); this.resultClock = resultClock;
  }
  db() {
    if (!this.database) {
      mkdirSync(dirname(this.storePath), { recursive: true });
      this.database = new DatabaseSync(this.storePath);
      this.database.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, value TEXT NOT NULL);');
      this.database.exec(`CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS mcp_calls_connection_time ON mcp_calls(connection_id,json_extract(value,'$.observedAt'),id); CREATE INDEX IF NOT EXISTS mcp_calls_endpoint_time ON mcp_calls(json_extract(value,'$.endpointHash'),json_extract(value,'$.observedAt'),id);`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS mcp_unresolved_connection ON mcp_calls(connection_id,json_extract(value,'$.tool')) WHERE json_extract(value,'$.status') IN ('in-flight','outcome-unknown'); CREATE INDEX IF NOT EXISTS mcp_unresolved_endpoint ON mcp_calls(json_extract(value,'$.endpointHash'),json_extract(value,'$.tool')) WHERE json_extract(value,'$.status') IN ('in-flight','outcome-unknown');`);
      this.database.exec('CREATE TABLE IF NOT EXISTS mcp_verifications(request_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, value TEXT NOT NULL);');
    }
    return this.database;
  }
  callHistory(id,{limit=20,before=null}={}){
    const entry=this.get(id);if(!entry)throw fail('A_MCP_NOT_FOUND');
    if(!Number.isInteger(limit)||limit<1||limit>100)throw fail('A_MCP_HISTORY_LIMIT_INVALID');
    const endpointHash=digest(entry.endpoint);let cursor;
    if(before!==null){try{
      if(typeof before!=='string'||before.length>1024||!/^[a-zA-Z0-9_-]+$/.test(before))throw Error();
      cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));
      if(Object.keys(cursor).length!==3||cursor.endpointHash!==endpointHash||typeof cursor.id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(cursor.id)||typeof cursor.at!=='string'||new Date(cursor.at).toISOString()!==cursor.at)throw Error();
    }catch{throw fail('A_MCP_HISTORY_CURSOR_INVALID');}}
    const rows=this.db().prepare(`SELECT id,value FROM mcp_calls WHERE (connection_id=? OR json_extract(value,'$.endpointHash')=?) ${cursor?"AND (json_extract(value,'$.observedAt')<? OR (json_extract(value,'$.observedAt')=? AND id<?))":''} ORDER BY json_extract(value,'$.observedAt') DESC,id DESC LIMIT ?`).all(id,endpointHash,...(cursor?[cursor.at,cursor.at,cursor.id]:[]),limit+1);
    const more=rows.length>limit,items=rows.slice(0,limit).map(row=>({...JSON.parse(row.value),historicalRecord:true,verificationReceipt:this.verificationReceipt(id,row.id)})),last=items.at(-1);
    return {items,nextCursor:more?Buffer.from(JSON.stringify({endpointHash,at:last.observedAt,id:last.requestId})).toString('base64url'):null,observedAt:new Date().toISOString(),businessOutcomeVerified:false,automaticRetryAllowed:false};
  }
  list() {
    return this.db().prepare('SELECT value FROM mcp_connections ORDER BY id').all().map(row=>{
      const entry=JSON.parse(row.value),endpointHash=digest(entry.endpoint);
      entry.blockedTools=this.db().prepare(`SELECT DISTINCT json_extract(value,'$.tool') AS tool FROM mcp_calls WHERE (connection_id=? OR json_extract(value,'$.endpointHash')=?) AND json_extract(value,'$.status') IN ('in-flight','outcome-unknown')`).all(entry.id,endpointHash).map(row=>row.tool);
      const page=this.callHistory(entry.id);entry.recentCalls=page.items;entry.callHistoryNextCursor=page.nextCursor;
      entry.capabilityReadiness=entry.tools.map(tool=>this.capabilityReadiness(entry.id,tool.name));
      return entry;
    });
  }
  get(id) { const row = this.db().prepare('SELECT value FROM mcp_connections WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  add(input) {
    if (!input || Object.keys(input).some(key => !['label', 'endpoint', 'protocolVersion'].includes(key))
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\u0000-\u001f]/u.test(input.label)
      || !versions.has(input.protocolVersion)) throw fail('A_MCP_PROFILE_INVALID');
    if (this.list().length >= 16) throw fail('A_MCP_PROFILE_LIMIT');
    const endpoint = validateMcpEndpoint(input.endpoint);
    if (this.list().some(item => item.endpoint === endpoint)) throw fail('A_MCP_ENDPOINT_DUPLICATE');
    const entry = { id: randomUUID(), label: input.label.trim(), endpoint, protocolVersion: input.protocolVersion,
      status: 'registered-unverified', checkedAt: null, tools: [], executionAuthorized: false };
    this.db().prepare('INSERT INTO mcp_connections VALUES (?,?)').run(entry.id, JSON.stringify(entry));
    return entry;
  }
  remove(id) { return { removed: this.db().prepare('DELETE FROM mcp_connections WHERE id=?').run(id).changes === 1 }; }
  async probe(id) {
    const entry = this.get(id); if (!entry) throw fail('A_MCP_NOT_FOUND');
    if (this.busy.has(id)) throw fail('A_MCP_PROBE_BUSY');
    this.busy.add(id);
    const rpc = this.rpc(entry);
    try {
      await this.initializeRpc(entry, rpc);
      const result = await rpc('tools/list', {}, 'tools-list');
      if (!Array.isArray(result.tools) || result.tools.length > 100 || result.nextCursor) throw fail('A_MCP_TOOL_LIST_INCOMPLETE');
      const names = new Set();
      entry.tools = result.tools.map(tool => {
        if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || names.has(tool.name)
          || !tool.inputSchema || tool.inputSchema.type !== 'object') throw fail('A_MCP_TOOL_INVALID');
        names.add(tool.name);
        return { name: tool.name, description: String(tool.description ?? '').slice(0, 500),
          inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          contractHash: digest(tool) };
      });
      entry.allowedTools = (entry.allowedTools ?? []).filter(grant => entry.tools.some(tool => tool.name === grant.name && tool.contractHash === grant.contractHash));
      entry.executionAuthorized = entry.allowedTools.length > 0;
      entry.status = 'tools-listed'; entry.errorCode = null;
    } catch (error) {
      entry.status = 'probe-failed'; entry.tools = []; entry.allowedTools = []; entry.executionAuthorized = false;
      entry.errorCode = /^A_MCP_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'A_MCP_PROBE_FAILED';
    } finally { this.busy.delete(id); }
    entry.checkedAt = new Date().toISOString();
    // A probe must not resurrect a connection removed while the request was in flight.
    const db=this.db();db.exec('BEGIN IMMEDIATE');
    try{
      const current=this.get(id);if(!current)throw fail('A_MCP_REMOVED_DURING_PROBE');
      // A different manager may revoke permissions while HTTP discovery waits.
      // Merge only grants still present in the authoritative current record.
      entry.allowedTools=(current.allowedTools??[]).filter(grant=>entry.tools.some(tool=>tool.name===grant.name&&tool.contractHash===grant.contractHash));
      entry.capabilityContracts=current.capabilityContracts??{};
      entry.permissionRevision=digest(entry.allowedTools)!==digest(current.allowedTools??[])?randomUUID():(current.permissionRevision??null);
      entry.executionAuthorized=entry.status==='tools-listed'&&entry.allowedTools.length>0;
      db.prepare('UPDATE mcp_connections SET value=? WHERE id=?').run(JSON.stringify(entry),id);db.exec('COMMIT');return entry;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  setAllowedTools(id, input) {
    const entry = this.get(id); if (!entry) throw fail('A_MCP_NOT_FOUND');
    if (this.busy.has(id)) throw fail('A_MCP_PROBE_BUSY');
    if (!input || Object.keys(input).some(key => key !== 'tools') || !Array.isArray(input.tools)
      || input.tools.length > 100 || new Set(input.tools).size !== input.tools.length) throw fail('A_MCP_GRANT_INVALID');
    const previousGrants=entry.allowedTools??[];
    entry.allowedTools = input.tools.map(name => {
      const tool = entry.tools.find(tool => tool.name === name);
      if (!tool || entry.status !== 'tools-listed') throw fail('A_MCP_TOOL_NOT_VERIFIED');
      assertSupportedSchema(tool.inputSchema);
      if (tool.outputSchema) assertSupportedSchema(tool.outputSchema);
      return { name, contractHash: tool.contractHash };
    });
    // Compare sets: saving the same permissions is not a new authorization.
    const canonical=grants=>grants.map(g=>`${g.name}:${g.contractHash}`).sort();
    if(digest(canonical(previousGrants))!==digest(canonical(entry.allowedTools)))entry.permissionRevision=randomUUID();
    entry.executionAuthorized = entry.allowedTools.length > 0;
    this.db().prepare('UPDATE mcp_connections SET value=? WHERE id=?').run(JSON.stringify(entry), id);
    return entry;
  }
  registerCapabilityContract(id, input) {
    const entry=this.get(id); if(!entry)throw fail('A_MCP_NOT_FOUND');
    const keys=['tool','contractHash','packageId','version','source','effect','verifierId','verifierFingerprint'];
    if(!input||Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key))
      ||typeof input.source!=='string'||typeof input.tool!=='string'||!input.tool||!/^\d+\.\d+\.\d+$/.test(input.version??'')
      ||!/^[-a-zA-Z0-9_.]{1,128}$/.test(input.packageId??'')
      ||!/^[-a-zA-Z0-9_.]{1,128}$/.test(input.verifierId??'')
      ||!/^([a-f0-9]{64})$/.test(input.verifierFingerprint??'')
      ||!['read','write','external-effect'].includes(input.effect))throw fail('A_MCP_CAPABILITY_CONTRACT_INVALID');
    let source;try{source=new URL(input.source);}catch{throw fail('A_MCP_CAPABILITY_SOURCE_INVALID');}
    if(source.protocol!=='https:'||source.username||source.password||source.hash||source.search||input.source.length>2048)throw fail('A_MCP_CAPABILITY_SOURCE_INVALID');
    const tool=entry.tools.find(t=>t.name===input.tool);
    if(entry.status!=='tools-listed'||!tool||tool.contractHash!==input.contractHash)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
    assertSupportedSchema(tool.inputSchema);if(tool.outputSchema)assertSupportedSchema(tool.outputSchema);
    entry.capabilityContracts={...(entry.capabilityContracts??{}),[input.tool]:{...input,endpointHash:digest(entry.endpoint),registeredAt:new Date().toISOString()}};
    this.db().prepare('UPDATE mcp_connections SET value=? WHERE id=?').run(JSON.stringify(entry),id);
    return this.capabilityReadiness(id,input.tool);
  }
  capabilityReadiness(id,toolName) {
    const entry=this.get(id);if(!entry)throw fail('A_MCP_NOT_FOUND');
    const tool=entry.tools.find(t=>t.name===toolName),contract=entry.capabilityContracts?.[toolName];
    const current=Boolean(contract&&entry.status==='tools-listed'&&tool?.contractHash===contract.contractHash&&contract.endpointHash===digest(entry.endpoint));
    return {tool:toolName,contract:contract??null,contractCurrent:current,
      permissionRevision:entry.permissionRevision??null,
      toolAuthorized:Boolean(tool&&entry.allowedTools?.some(grant=>grant.name===toolName&&grant.contractHash===tool.contractHash)),
      status:!contract?'contract-missing':!current?'contract-changed':'registered-not-activated',
      inputSchema:tool?.inputSchema??null,outputSchema:tool?.outputSchema??null,
      autonomousExecutionAuthorized:false,businessOutcomeVerified:false,
      requiredNext:current?['trusted-verifier-installation','capability-package-activation','mission-policy-check','independent-result-verification']:['review-current-tool-contract']};
  }
  validateToolArguments(id,toolName,args) {
    const entry=this.get(id);if(!entry)throw fail('A_MCP_NOT_FOUND');
    const tool=entry.tools.find(item=>item.name===toolName);
    if(entry.status!=='tools-listed'||!tool)throw fail('A_MCP_TOOL_NOT_VERIFIED');
    assertSupportedSchema(tool.inputSchema);validateValue(tool.inputSchema,args);return true;
  }
  verificationReceipt(id,requestId) {
    if(!this.get(id))throw fail('A_MCP_NOT_FOUND');
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))throw fail('A_MCP_REQUEST_INVALID');
    const row=this.db().prepare('SELECT value FROM mcp_verifications WHERE request_id=? AND connection_id=?').get(requestId,id);
    return row?{...JSON.parse(row.value),historicalReceipt:true,executionAuthorized:false}:null;
  }
  async callVerifiedCapability(id,input,authorize,{verifiers=new Map()}={}) {
    input=snapshotCallInput(input);
    const policyEntry=this.get(id);
    const before=this.capabilityReadiness(id,input?.tool);
    if(!before.contractCurrent)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
    const verifier=verifiers.get(before.contract.verifierId);
    if(!verifier||typeof verifier.verify!=='function'||verifier.fingerprint!==before.contract.verifierFingerprint)throw fail('A_MCP_CAPABILITY_VERIFIER_REQUIRED');
    const bound=digest(before.contract);
    const result=await this.call(id,input,authorize);
    const after=this.capabilityReadiness(id,input.tool);
    if(!after.contractCurrent||digest(after.contract)!==bound)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
    if(result.status!=='expectation-matched')return {...result,businessOutcomeVerified:false,verification:{status:'not-verified',reason:'call-not-matched'}};
    const assertPermission=()=>{
      const current=this.capabilityReadiness(id,input.tool);
      if(!current.toolAuthorized||current.permissionRevision!==before.permissionRevision)throw fail('A_MCP_PERMISSION_CHANGED');
    };
    assertPermission();
    let verification;
    try{verification=await verifier.verify({arguments:structuredClone(input.arguments),result:structuredClone(result.result),contract:structuredClone(before.contract)});}
    catch{throw fail('A_MCP_CAPABILITY_VERIFICATION_FAILED');}
    const final=this.capabilityReadiness(id,input.tool);
    assertPermission();
    if(!final.contractCurrent||digest(final.contract)!==bound)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
    if(!verification||verification.valid!==true||typeof verification.evidenceRef!=='string'||!verification.evidenceRef.trim()||verification.evidenceRef.length>2048)throw fail('A_MCP_CAPABILITY_VERIFICATION_FAILED');
    assertDeliveryPolicy(authorize,deliveryPolicyRequest(policyEntry,input,'mcp-verified-result-delivery'));
    assertPermission();
    const receipt={requestId:input.requestId,connectionId:id,tool:input.tool,contractHash:before.contract.contractHash,
      bindingHash:bound,permissionRevision:before.permissionRevision,verifierId:before.contract.verifierId,verifierFingerprint:verifier.fingerprint,
      evidenceRefHash:digest(verification.evidenceRef),inputHash:result.inputHash,outputHash:result.outputHash,
      verifiedAt:new Date().toISOString(),status:'verified',scope:'tool-verifier-contract'};
    const db=this.db();db.exec('BEGIN IMMEDIATE');
    try{
      const current=this.capabilityReadiness(id,input.tool);
      assertPermission();
      if(!current.contractCurrent||digest(current.contract)!==bound)throw fail('A_MCP_CAPABILITY_CONTRACT_CHANGED');
      const call=db.prepare('SELECT value FROM mcp_calls WHERE id=? AND connection_id=?').get(input.requestId,id);
      if(!call||JSON.parse(call.value).status!=='expectation-matched')throw fail('A_MCP_CAPABILITY_VERIFICATION_FAILED');
      db.prepare('INSERT INTO mcp_verifications VALUES (?,?,?)').run(input.requestId,id,JSON.stringify(receipt));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    // Keep call observation and historical verifier receipt separate.
    // Sensitive content is bounded and ephemeral, outside persistent call/evidence journals.
    const now=this.resultClock();
    for(const [key,value] of this.verifiedResults)if(value.expiresAt<=now)this.verifiedResults.delete(key);
    while(this.verifiedResults.size>=16)this.verifiedResults.delete(this.verifiedResults.keys().next().value);
    this.verifiedResults.set(input.requestId,{connectionId:id,bindingHash:bound,outputHash:result.outputHash,expiresAt:now+600000,result:structuredClone(result.result),authorize,policyRequest:deliveryPolicyRequest(policyEntry,input,'mcp-cached-result-delivery')});
    return {...result,businessOutcomeVerified:true,verification:{status:'verified',verifierId:before.contract.verifierId,verifierFingerprint:verifier.fingerprint,evidenceRef:verification.evidenceRef},autonomousExecutionAuthorized:false,verificationReceipt:this.verificationReceipt(id,input.requestId)};
  }
  readVerifiedResult(id,requestId,{authorize=null}={}) {
    const receipt=this.verificationReceipt(id,requestId), cached=this.verifiedResults.get(requestId);
    if(!receipt||!cached||cached.connectionId!==id||cached.expiresAt<=this.resultClock()){
      if(cached?.expiresAt<=this.resultClock())this.verifiedResults.delete(requestId);
      throw fail('A_MCP_VERIFIED_RESULT_UNAVAILABLE');
    }
    const current=this.capabilityReadiness(id,receipt.tool),entry=this.get(id);
    if(!current.contractCurrent||digest(current.contract)!==receipt.bindingHash
      ||current.permissionRevision!==(receipt.permissionRevision??null)
      ||!entry.allowedTools?.some(grant=>grant.name===receipt.tool&&grant.contractHash===receipt.contractHash))throw fail('A_MCP_VERIFIED_RESULT_ACCESS_REVOKED');
    if(receipt.status!=='verified'||cached.bindingHash!==receipt.bindingHash||cached.outputHash!==receipt.outputHash||digest(cached.result)!==receipt.outputHash)throw fail('A_MCP_VERIFIED_RESULT_INVALID');
    assertDeliveryPolicy(authorize??cached.authorize,cached.policyRequest);
    const last=this.capabilityReadiness(id,receipt.tool);
    if(!last.contractCurrent||digest(last.contract)!==receipt.bindingHash||last.permissionRevision!==(receipt.permissionRevision??null)||!last.toolAuthorized)throw fail('A_MCP_VERIFIED_RESULT_ACCESS_REVOKED');
    return {requestId,connectionId:id,verifiedAt:receipt.verifiedAt,availableUntil:new Date(cached.expiresAt).toISOString(),
      verificationScope:receipt.scope,businessOutcomeVerified:true,historicalResult:true,currentSourceRechecked:false,persisted:false,result:structuredClone(cached.result),executionAuthorized:false};
  }
  async call(id, input, authorize) {
    // Keep the caller's mutable object out of async discovery and policy hooks.
    input = snapshotCallInput(input);
    if (!input || Object.keys(input).some(key => !['tool','arguments','requestId','expectedText'].includes(key))
      || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId ?? '')
      || typeof input.expectedText !== 'string' || !input.expectedText.trim() || input.expectedText.length > 1000
      || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw fail('A_MCP_CALL_INVALID');
    if (typeof authorize !== 'function') throw fail('A_MCP_POLICY_REQUIRED');
    const previous = this.db().prepare('SELECT value FROM mcp_calls WHERE id=?').get(input.requestId);
    if (previous) throw fail('A_MCP_REQUEST_ALREADY_USED');
    const registered = this.get(id); if (!registered) throw fail('A_MCP_NOT_FOUND');
    const endpointHash = digest(registered.endpoint);
    const hasUnresolved = () => Boolean(this.db().prepare(`SELECT 1 FROM mcp_calls WHERE (connection_id=? OR json_extract(value,'$.endpointHash')=?) AND json_extract(value,'$.tool')=? AND json_extract(value,'$.status') IN ('in-flight','outcome-unknown') LIMIT 1`).get(id,endpointHash,input.tool));
    if (hasUnresolved()) throw fail('A_MCP_UNRESOLVED_OUTCOME');
    const entry = await this.probe(id); // Re-fetch the contract before each execution; a changed contract loses its grant.
    const tool = entry.tools.find(tool => tool.name === input.tool);
    if (!tool || !entry.allowedTools?.some(grant => grant.name === input.tool && grant.contractHash === tool.contractHash)) throw fail('A_MCP_TOOL_NOT_AUTHORIZED');
    if((entry.permissionRevision??null)!==(registered.permissionRevision??null))throw fail('A_MCP_PERMISSION_CHANGED');
    validateValue(tool.inputSchema, input.arguments);
    const policyRequest = source => ({ action: { toolName: `mcp.${id}.${tool.name}`, arguments: input.arguments,
      context: { purpose: 'explicit-mcp-tool-call', destinationType: 'local-mcp-endpoint', requestId: input.requestId,
        endpointHash, argumentsSha256: digest(input.arguments) },
      capability: { externalTransfer: true, reversible: false } }, source });
    const decision = evaluateCallPolicy(authorize,policyRequest('mcp-manual-call'));
    if (decision?.allowed !== true) throw fail('A_MCP_POLICY_DENIED');
    if (hasUnresolved()) throw fail('A_MCP_UNRESOLVED_OUTCOME');
    const observation = { requestId: input.requestId, connectionId: id, tool: tool.name,
      status: 'in-flight', observedAt: new Date().toISOString(), inputHash: digest(input.arguments),
      contractHash: tool.contractHash, permissionRevision:entry.permissionRevision??null, endpointHash: digest(entry.endpoint), businessOutcomeVerified: false };
    // Persist the attempt BEFORE dispatch. Crash/restart/response loss must not duplicate a side effect.
    const db=this.db();db.exec('BEGIN IMMEDIATE');
    try{if(hasUnresolved())throw fail('A_MCP_UNRESOLVED_OUTCOME');if(db.prepare('SELECT 1 FROM mcp_calls WHERE id=?').get(input.requestId))throw fail('A_MCP_REQUEST_ALREADY_USED');db.prepare('INSERT INTO mcp_calls VALUES (?,?,?)').run(input.requestId,id,JSON.stringify(observation));db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    let result, dispatched = false, providerResponseReceived = false;
    try {
      // Final synchronous policy and grant check, after any session setup and immediately before dispatch.
      const rpc = this.rpc(entry); await this.initializeRpc(entry, rpc);
      // Bind execution to the manifest in this exact execution session, rather
      // than trusting a list observed in the preceding probe session.
      const manifest=await rpc('tools/list',{},'dispatch-tools-list');
      const matches=Array.isArray(manifest.tools)?manifest.tools.filter(candidate=>candidate.name===tool.name):[];
      if(manifest.nextCursor||!Array.isArray(manifest.tools)||manifest.tools.length>100||matches.length!==1||digest(matches[0])!==tool.contractHash){
        const current=this.get(id);
        if(current){current.allowedTools=(current.allowedTools??[]).filter(grant=>grant.name!==tool.name);current.permissionRevision=randomUUID();current.executionAuthorized=current.allowedTools.length>0;this.db().prepare('UPDATE mcp_connections SET value=? WHERE id=?').run(JSON.stringify(current),id);}
        throw fail('A_MCP_DISPATCH_CONTRACT_CHANGED');
      }
      const finalDecision=evaluateCallPolicy(authorize,policyRequest('mcp-manual-dispatch'));
      // The local policy hook may itself change permissions; read the record last.
      const finalEntry=this.get(id);
      if ((finalEntry?.permissionRevision??null)!==(entry.permissionRevision??null))throw fail('A_MCP_PERMISSION_CHANGED');
      if (!finalEntry?.allowedTools?.some(grant => grant.name === tool.name && grant.contractHash === tool.contractHash)
        || finalDecision?.allowed !== true) throw fail('A_MCP_POLICY_DENIED');
      dispatched = true;
      result = await rpc('tools/call', { name: tool.name, arguments: input.arguments }, input.requestId);
      if (result.resultType && result.resultType !== 'complete') throw fail('A_MCP_RESULT_REQUIRES_HANDOFF');
      if (result.isError !== undefined && typeof result.isError !== 'boolean') throw fail('A_MCP_RESULT_UNSUPPORTED');
      if (!Array.isArray(result.content) || result.content.some(item => item.type !== 'text' || typeof item.text !== 'string')) throw fail('A_MCP_RESULT_UNSUPPORTED');
      if (tool.outputSchema) validateValue(tool.outputSchema, result.structuredContent);
      observation.status = result.isError === true ? 'tool-error' : result.content.some(item => item.text.includes(input.expectedText)) ? 'expectation-matched' : 'expectation-failed';
      observation.outputHash = digest(result);
      providerResponseReceived = true;
      // Receiving bytes is not permission to disclose them. Recheck after all
      // asynchronous provider reads, and read the grant last after the hook.
      let deliveryDecision;
      try { deliveryDecision = evaluateCallPolicy(authorize,policyRequest('mcp-result-delivery')); }
      catch { throw fail('A_MCP_RESULT_POLICY_DENIED'); }
      const deliveryEntry = this.get(id);
      if ((deliveryEntry?.permissionRevision ?? null) !== (entry.permissionRevision ?? null)
        || deliveryEntry?.endpoint !== entry.endpoint
        || !deliveryEntry?.allowedTools?.some(grant => grant.name === tool.name && grant.contractHash === tool.contractHash)) throw fail('A_MCP_RESULT_PERMISSION_CHANGED');
      if (deliveryDecision?.allowed !== true) throw fail('A_MCP_RESULT_POLICY_DENIED');
    } catch (error) {
      observation.status = providerResponseReceived ? 'result-withheld' : dispatched ? 'outcome-unknown' : 'not-dispatched';
      if (providerResponseReceived) observation.providerResponseReceived = true;
      observation.errorCode = /^A_MCP_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'A_MCP_CALL_RESPONSE_LOST';
      result = undefined;
    }
    observation.finishedAt = new Date().toISOString();
    this.db().prepare('UPDATE mcp_calls SET value=? WHERE id=?').run(JSON.stringify(observation), input.requestId);
    return { ...observation, ...(result ? { result } : {}), automaticRetryAllowed: false };
  }
  rpc(entry) {
    let session;
    const signal = AbortSignal.timeout(8000);
    const rpc = async (method, params, requestId) => {
      const response = await this.fetchImpl(validateMcpEndpoint(entry.endpoint), { method: 'POST', redirect: 'error', credentials: 'omit', signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': entry.protocolVersion, 'Mcp-Method': method,
          ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(requestId ? { id: requestId } : {}), method,
          params: { ...params, ...(entry.protocolVersion === '2026-07-28' ? { _meta: {
            'io.modelcontextprotocol/protocolVersion': entry.protocolVersion,
            'io.modelcontextprotocol/clientInfo': { name: 'JARVIS-connection-inspector', version: '1.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          } } : {}) } }) });
      if (!response.ok) { await response.body?.cancel(); throw fail(`A_MCP_HTTP_${response.status}`); }
      if (method === 'initialize') {
        session = response.headers.get('mcp-session-id');
        if (session && !/^[\x21-\x7e]{1,256}$/.test(session)) throw fail('A_MCP_SESSION_INVALID');
      }
      if (!requestId) { await response.body?.cancel(); return null; }
      const reader = response.body?.getReader(); if (!reader) throw fail('A_MCP_RESPONSE_INVALID');
      const decoder = new TextDecoder(); let text = '', bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 256 * 1024) throw fail('A_MCP_RESPONSE_TOO_LARGE');
          text += decoder.decode(part.value, { stream: true });
          if (response.headers.get('content-type')?.includes('text/event-stream')) {
            for (const block of text.split(/\r?\n\r?\n/).slice(0, -1)) {
              const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) { const payload = JSON.parse(data); if (payload.id === requestId) return validateResponse(payload, requestId); }
            }
          }
        }
        return validateResponse(JSON.parse(text), requestId);
      } finally { await reader.cancel().catch(() => {}); }
    };
    return rpc;
  }
  async initializeRpc(entry, rpc) {
      if (entry.protocolVersion === '2025-11-25') {
        const initialization = await rpc('initialize', { protocolVersion: entry.protocolVersion, capabilities: {}, clientInfo: { name: 'JARVIS', version: '1.0' } }, 'initialize');
        if (initialization.protocolVersion !== entry.protocolVersion) throw fail('A_MCP_PROTOCOL_MISMATCH');
        await rpc('notifications/initialized', {}, null);
      }
  }
  close() { this.verifiedResults.clear(); this.database?.close(); this.database = null; }
}

function deliveryPolicyRequest(entry,input,source){
  return snapshotCallInput({source,action:{toolName:`mcp.${entry?.id}.${input.tool}`,arguments:input.arguments,
    context:{purpose:'explicit-mcp-tool-call',destinationType:'local-mcp-endpoint',requestId:input.requestId,endpointHash:digest(entry?.endpoint),argumentsSha256:digest(input.arguments)},
    capability:{externalTransfer:true,reversible:false}}});
}
function assertDeliveryPolicy(authorize,request){
  try{if(typeof authorize!=='function'||evaluateCallPolicy(authorize,request)?.allowed!==true)throw Error();}
  catch{throw fail('A_MCP_RESULT_POLICY_DENIED');}
}
function evaluateCallPolicy(authorize,request){
  // Arguments were already frozen. Bind the surrounding purpose, destination,
  // request ID and hashes too; hooks must not reinterpret their own input.
  // Clone on every evaluation so retained callback references cannot change a
  // later policy check or the cached result's authorization context.
  const snapshot=snapshotCallInput(request);
  try{return authorize(snapshot);}
  catch(error){
    if(/^A_MCP_[A-Z0-9_]+$/.test(error?.code??''))throw error;
    throw fail('A_MCP_POLICY_EVALUATION_FAILED');
  }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Bounded supported subset, fail CLOSED on advanced JSON Schema rather than pretending to validate it.
export function assertSupportedSchema(schema, depth = 0) {
  const keys = ['type','properties','required','additionalProperties','items','enum','minLength','maxLength','minimum','maximum','minItems','maxItems','description','title','default','$schema'];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12
    || Object.keys(schema).some(key => !keys.includes(key))
    || !['object','array','string','integer','number','boolean','null'].includes(schema.type)) throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  if (schema.enum && !Array.isArray(schema.enum)) throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  for (const key of ['minLength','maxLength','minimum','maximum','minItems','maxItems']) if (schema[key] !== undefined && !Number.isFinite(schema[key])) throw fail('A_MCP_SCHEMA_UNSUPPORTED');
  for (const child of Object.values(schema.properties ?? {})) assertSupportedSchema(child, depth + 1);
  if (schema.type === 'array') { if (!schema.items) throw fail('A_MCP_SCHEMA_UNSUPPORTED'); assertSupportedSchema(schema.items, depth + 1); }
}
function validateValue(schema, value, depth = 0) {
  assertSupportedSchema(schema);
  if (depth > 12) throw fail('A_MCP_ARGUMENT_INVALID');
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type === 'integer' ? !Number.isSafeInteger(value) : schema.type !== type) throw fail('A_MCP_ARGUMENT_INVALID');
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw fail('A_MCP_ARGUMENT_INVALID');
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw fail('A_MCP_ARGUMENT_INVALID');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateValue(schema.properties[key], item, depth + 1);
      else if (schema.additionalProperties === false) throw fail('A_MCP_ARGUMENT_INVALID');
    }
  }
  if (type === 'array') { if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 1000)) throw fail('A_MCP_ARGUMENT_INVALID'); for (const item of value) validateValue(schema.items, item, depth + 1); }
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 32768))) throw fail('A_MCP_ARGUMENT_INVALID');
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw fail('A_MCP_ARGUMENT_INVALID');
}
function validateResponse(payload, id) {
  if (payload?.jsonrpc !== '2.0' || payload.id !== id || payload.error || !payload.result || typeof payload.result !== 'object') throw fail('A_MCP_RESPONSE_INVALID');
  return payload.result;
}

function snapshotCallInput(input) {
  const ancestors = new Set(); let nodes = 0;
  const inspect = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 32) throw fail('A_MCP_CALL_INVALID');
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || ancestors.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw fail('A_MCP_CALL_INVALID');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail('A_MCP_CALL_INVALID');
      if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) throw fail('A_MCP_CALL_INVALID');
      inspect(descriptor.value, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw fail('A_MCP_CALL_INVALID');
    ancestors.delete(value);
  };
  inspect(input);
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 32768) throw fail('A_MCP_CALL_INVALID');
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(JSON.parse(serialized));
}
