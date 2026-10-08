import { createHash, randomUUID } from 'node:crypto';
import { PcOutboundMailbox } from './pc-outbound-mailbox.js';
import { executionPacketFingerprint } from '../../../shared/src/execution-packet-fingerprint.js';

const fail=code=>{throw Object.assign(new Error(`A_PC_COMMAND_${code}`),{code:`A_PC_COMMAND_${code}`});};
const id=value=>typeof value==='string'&&/^[\p{L}\p{N}._-]{1,128}$/u.test(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bounded=value=>{
  let text;try{text=JSON.stringify(value);}catch{fail('CONTRACT_INVALID');}
  if(typeof text!=='string'||Buffer.byteLength(text)>1_048_576)fail('CONTRACT_INVALID');
  const copy=JSON.parse(text);
  if(digest(copy)!==digest(value))fail('CONTRACT_INVALID');
  return copy;
};

/** Separate opt-in command transport. It never signs packets or grants B execution authority.
 * B must still enforce its signed capability, policy, journal ticket and operation fence.
 * Any leased request becomes uncertain on loss; it is NEVER automatically redelivered.
 */
export class PcOutboundCommandMailbox {
  #dispatchGuards=new Map();
  constructor({mailbox,executionFenceRequired=false}={}){
    if(!(mailbox instanceof PcOutboundMailbox)||!mailbox.authorityGuard)fail('AUTHORITY_REQUIRED');
    if(typeof executionFenceRequired!=='boolean')fail('CONFIG_INVALID');
    Object.defineProperty(this,'executionFenceRequired',{value:executionFenceRequired,enumerable:true});
    this.mailbox=mailbox;this.db=mailbox.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS pc_command_scopes(device TEXT PRIMARY KEY,generation INTEGER NOT NULL,tasks TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_commands(id TEXT PRIMARY KEY,device TEXT NOT NULL,device_generation INTEGER NOT NULL,authority INTEGER NOT NULL,
        task TEXT NOT NULL,operation TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,
        lease TEXT,expires INTEGER,result TEXT,result_digest TEXT);`);
    for(const [table,column] of [['pc_command_scopes','revision'],['pc_commands','scope_revision']]){
      if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(field=>field.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  grant({deviceId,expectedGeneration,allowedTaskIds,expiresAt,expectedRevision=null}={}){
    return this.mailbox.transaction(()=>{
      const device=this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(deviceId);
      if(!device||device.revoked||device.expires<=this.mailbox.now()||device.generation!==expectedGeneration)fail('DEVICE_SCOPE_INVALID');
      const selected=this.db.prepare('SELECT * FROM pc_outbound_scopes WHERE device=?').get(deviceId);
      if(!Array.isArray(allowedTaskIds)||allowedTaskIds.length>1000||new Set(allowedTaskIds).size!==allowedTaskIds.length
        ||allowedTaskIds.some(task=>!id(task)||!JSON.parse(selected?.tasks??'[]').includes(task))
        ||!Number.isSafeInteger(expiresAt)||expiresAt<=this.mailbox.now()||expiresAt>device.expires)fail('EXECUTION_SCOPE_INVALID');
      const currentRevision=this.db.prepare('SELECT revision FROM pc_command_scopes WHERE device=?').get(deviceId)?.revision??0;
      if(expectedRevision!==null&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==currentRevision))fail('SCOPE_REVISION_CONFLICT');
      const revision=currentRevision+1;
      this.db.prepare(`INSERT INTO pc_command_scopes(device,generation,tasks,expires,revision) VALUES(?,?,?,?,?) ON CONFLICT(device) DO UPDATE SET generation=excluded.generation,tasks=excluded.tasks,expires=excluded.expires,revision=excluded.revision`)
        .run(deviceId,expectedGeneration,JSON.stringify(allowedTaskIds),expiresAt,revision);
      this.db.prepare("UPDATE pc_commands SET state='invalidated' WHERE device=? AND state IN ('queued','leased')").run(deviceId);
      return {deviceId,generation:expectedGeneration,revision,taskCount:allowedTaskIds.length,executionAuthority:false};
    });
  }
  describeScope(deviceId){
    if(!id(deviceId))fail('DEVICE_SCOPE_INVALID');
    return this.mailbox.transaction(()=>{
      const device=this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(deviceId);
      if(!device)fail('DEVICE_SCOPE_INVALID');
      const scope=this.db.prepare('SELECT * FROM pc_command_scopes WHERE device=?').get(deviceId);
      const current=scope?.generation===device.generation&&scope.revision>0&&!device.revoked&&device.expires>this.mailbox.now()&&scope.expires>this.mailbox.now();
      return {deviceId,generation:device.generation,revision:scope?.revision??0,allowedTaskIds:current?JSON.parse(scope.tasks):[],
        expiresAt:scope?new Date(scope.expires).toISOString():null,status:current?'configured':scope?'inactive':'not_configured',
        executionAuthority:false,deviceConnectedVerified:false};
    });
  }
  scope(deviceId,taskId){
    const device=this.db.prepare('SELECT * FROM pc_outbound_devices WHERE id=?').get(deviceId),scope=this.db.prepare('SELECT * FROM pc_command_scopes WHERE device=?').get(deviceId);
    if(!device||device.revoked||device.expires<=this.mailbox.now()||!scope||scope.generation!==device.generation
      ||scope.revision<1||scope.expires<=this.mailbox.now()||!JSON.parse(scope.tasks).includes(taskId))fail('EXECUTION_SCOPE_DENIED');
    return {...device,commandScopeRevision:scope.revision};
  }
  enqueue({requestId,deviceId,kind,taskId,operationId,action,body,dispatchGuard=null}={}){
    if(!id(requestId)||!id(taskId)||!/^mission_op_[a-f0-9]{32}$/u.test(operationId??'')
      ||!['prepare','execute','cancel'].includes(kind)||action?.toolName!=='filesystem.createTextFile')fail('CONTRACT_INVALID');
    if(dispatchGuard!==null&&typeof dispatchGuard!=='function')fail('DISPATCH_GUARD_INVALID');
    body=bounded(body);action=bounded(action);
    const fields=kind==='prepare'?['packet']:kind==='execute'?['packet','ticket','generation',...(Object.hasOwn(body??{},'mutationFenceRequired')?['mutationFenceRequired']:[])]:['operationId','taskId','action'];
    if(kind==='execute'&&Object.hasOwn(body??{},'mutationFenceRequired')&&body.mutationFenceRequired!==true)fail('CONTRACT_INVALID');
    if(!body||Object.keys(body).length!==fields.length||fields.some(key=>!Object.hasOwn(body,key)))fail('CONTRACT_INVALID');
    if(kind==='cancel'){
      if(body.taskId!==taskId||body.operationId!==operationId||digest(body.action)!==digest(action))fail('BINDING_MISMATCH');
    }else{
      const packet=body.packet;
      if(packet?.taskId!==taskId||packet.idempotencyKey!==operationId||digest(packet.action)!==digest(action)
        ||!packet.capabilityToken||typeof packet.capabilityToken!=='object'||Array.isArray(packet.capabilityToken)
        ||typeof packet.capabilityToken.capabilityToken!=='string'||!packet.capabilityToken.capabilityToken||packet.capabilityToken.capabilityToken.length>32768)fail('BINDING_MISMATCH');
      if(kind==='execute'&&(typeof body.ticket!=='string'||!body.ticket||body.ticket.length>4096||!Number.isSafeInteger(body.generation)||body.generation<1))fail('CONTRACT_INVALID');
    }
    const binding=executionPacketFingerprint({taskId,action,requestedMode:'execute'}),hash=digest({deviceId,kind,taskId,operationId,binding,body});
    return this.mailbox.transaction(()=>{
      const device=this.scope(deviceId,taskId),authority=this.mailbox.authorityEpoch();
      const old=this.db.prepare('SELECT * FROM pc_commands WHERE id=?').get(requestId);
      if(old){if(old.digest!==hash||old.device_generation!==device.generation||old.authority!==authority||old.scope_revision!==device.commandScopeRevision)fail('REQUEST_CONFLICT');if(dispatchGuard)this.#dispatchGuards.set(requestId,dispatchGuard);return this.state(old);}
      if(this.db.prepare('SELECT id FROM pc_commands WHERE device=? AND operation=? AND kind=?').get(deviceId,operationId,kind))fail('OPERATION_ALREADY_QUEUED');
      this.db.prepare("INSERT INTO pc_commands(id,device,device_generation,authority,task,operation,kind,body,digest,state,scope_revision) VALUES(?,?,?,?,?,?,?,?,?,'queued',?)")
        .run(requestId,deviceId,device.generation,authority,taskId,operationId,kind,JSON.stringify(body),hash,device.commandScopeRevision);
      if(dispatchGuard)this.#dispatchGuards.set(requestId,dispatchGuard);
      return {requestId,state:'queued',executionAuthority:false};
    });
  }
  invalidate(){
    const now=this.mailbox.now(),authority=this.mailbox.authorityEpoch();
    this.db.prepare("UPDATE pc_commands SET state='uncertain' WHERE state='leased' AND expires<=?").run(now);
    this.db.prepare("UPDATE pc_commands SET state='invalidated' WHERE state IN ('queued','leased') AND authority<>?").run(authority);
  }
  pull(peer){
    return this.mailbox.transaction(()=>{
      const device=this.mailbox.device(peer);this.invalidate();
      const rows=this.db.prepare("SELECT * FROM pc_commands WHERE device=? AND state='queued' ORDER BY rowid").all(device.id);
      for(const row of rows){
        if(row.device_generation!==device.generation){this.db.prepare("UPDATE pc_commands SET state='invalidated' WHERE id=?").run(row.id);continue;}
        try{if(this.scope(device.id,row.task).commandScopeRevision!==row.scope_revision)throw new Error();}catch{this.db.prepare("UPDATE pc_commands SET state='invalidated' WHERE id=?").run(row.id);continue;}
        const lease=randomUUID(),expires=this.mailbox.now()+this.mailbox.leaseMs;
        this.db.prepare("UPDATE pc_commands SET state='leased',lease=?,expires=? WHERE id=?").run(lease,expires,row.id);
        return {requestId:row.id,kind:row.kind,taskId:row.task,operationId:row.operation,body:JSON.parse(row.body),lease,expiresAt:expires,
          deviceGeneration:device.generation,authorityToken:row.authority,executionAuthority:false};
      }
      return null;
    });
  }
  validate(peer,{requestId,lease}={}){
    return this.mailbox.transaction(()=>{
      const device=this.mailbox.device(peer);this.invalidate();
      const row=this.db.prepare('SELECT * FROM pc_commands WHERE id=?').get(requestId);
      if(!row||row.device!==device.id||row.device_generation!==device.generation||row.lease!==lease||row.state!=='leased'
        ||row.expires<=this.mailbox.now()||row.authority!==this.mailbox.authorityEpoch())fail('LEASE_INVALID');
      if(this.scope(device.id,row.task).commandScopeRevision!==row.scope_revision)fail('SCOPE_CHANGED');
      if(row.kind==='execute'&&this.executionFenceRequired){
        const guard=this.#dispatchGuards.get(requestId);if(!guard)fail('DISPATCH_FENCE_MISSING');
        try{const result=guard();if(result&&typeof result.then==='function'){result.catch?.(()=>{});fail('DISPATCH_FENCE_ASYNC');}}
        catch{fail('DISPATCH_FENCE_DENIED');}
      }
      return {allowed:true,requestId,kind:row.kind,taskId:row.task,operationId:row.operation,bodySha256:digest(JSON.parse(row.body)),expiresAt:row.expires,deviceGeneration:row.device_generation,authorityToken:row.authority,executionAuthority:false};
    });
  }
  submit(peer,{requestId,lease,result}={}){
    result=bounded(result);
    return this.mailbox.transaction(()=>{
      const device=this.mailbox.device(peer);this.invalidate();const row=this.db.prepare('SELECT * FROM pc_commands WHERE id=?').get(requestId);
      if(!row||row.device!==device.id||row.device_generation!==device.generation||row.lease!==lease)fail('LEASE_INVALID');
      if(this.scope(device.id,row.task).commandScopeRevision!==row.scope_revision)fail('SCOPE_CHANGED');
      if(row.authority!==this.mailbox.authorityEpoch())fail('AUTHORITY_CHANGED');
      if(row.state==='observed'){
        if(row.result_digest!==digest(result))fail('RESULT_CONFLICT');return this.state(row);
      }
      if(row.state!=='leased'||row.expires<=this.mailbox.now()||row.authority!==this.mailbox.authorityEpoch())fail('LEASE_INVALID');
      this.db.prepare("UPDATE pc_commands SET state='observed',result=?,result_digest=? WHERE id=?").run(JSON.stringify(result),digest(result),requestId);
      return {requestId,state:'observed',executionAuthority:false};
    });
  }
  status(requestId){return this.mailbox.transaction(()=>{this.invalidate();const row=this.db.prepare('SELECT * FROM pc_commands WHERE id=?').get(requestId);if(!row)return null;
    try{const device=this.scope(row.device,row.task);if(device.generation!==row.device_generation||device.commandScopeRevision!==row.scope_revision)throw new Error();}catch{return {requestId,state:'invalidated',executionAuthority:false};}
    if(row.authority!==this.mailbox.authorityEpoch())return {requestId,state:'invalidated',executionAuthority:false};
    return this.state(row);});}
  state(row){return {requestId:row.id,state:row.state,...(row.state==='observed'?{result:JSON.parse(row.result)}:{}),executionAuthority:false};}
}
