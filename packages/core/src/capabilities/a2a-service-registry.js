import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assertSupportedSchema} from '../personal-operations/mcp-connections.js';

const fail=code=>Object.assign(new Error(code),{code});
const canonical=(x,depth=0)=>{if(depth>32)throw fail('A_A2A_CARD_INVALID');return Array.isArray(x)?`[${x.map(v=>canonical(v,depth+1)).join(',')}]`:x&&typeof x==='object'?`{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k],depth+1)}`).join(',')}}`:JSON.stringify(x);};
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const text=(s,max=128,multiline=false)=>{if(typeof s!=='string'||!s.trim()||s.length>max||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u:/[\u0000-\u001f]/u).test(s))throw fail('A_A2A_CARD_INVALID');return s;};
const modes=x=>{if(!Array.isArray(x)||!x.length||x.length>16||new Set(x).size!==x.length)throw fail('A_A2A_CARD_INVALID');return x.map(v=>{text(v);if(!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(v))throw fail('A_A2A_CARD_INVALID');return v;});};
function safeUrl(s,{source=false}={}){
 let url;try{url=new URL(s);}catch{throw fail('A_A2A_URL_INVALID');}
 if(typeof s!=='string'||s.length>2048||/[\u0000-\u001f]/u.test(s)||url.username||url.password||url.search||url.hash||(!source&&url.protocol!=='https:'&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port))||(source&&url.protocol!=='https:'))throw fail('A_A2A_URL_INVALID');
 return url.href;
}
function projectCard(card){
 if(!card||typeof card!=='object'||Array.isArray(card)||Buffer.byteLength(JSON.stringify(card))>65536)throw fail('A_A2A_CARD_INVALID');
 const interfaces=card.supportedInterfaces;
 if(!Array.isArray(interfaces)||!interfaces.length||interfaces.length>8)throw fail('A_A2A_PROTOCOL_UNSUPPORTED');
 const supportedInterfaces=interfaces.map(i=>{
  if(!i||typeof i!=='object'||Array.isArray(i))throw fail('A_A2A_CARD_INVALID');
  if(i.protocolVersion!=='1.0'||!['JSONRPC','HTTP+JSON','GRPC'].includes(i.protocolBinding))throw fail('A_A2A_PROTOCOL_UNSUPPORTED');
  return {url:safeUrl(i.url),protocolVersion:i.protocolVersion,protocolBinding:i.protocolBinding};
 });
 if(!card.capabilities||typeof card.capabilities!=='object'||Array.isArray(card.capabilities))throw fail('A_A2A_CARD_INVALID');
 if(!Array.isArray(card.skills)||!card.skills.length||card.skills.length>100)throw fail('A_A2A_CARD_INVALID');
 const ids=new Set(),skills=card.skills.map(s=>{
  if(!s||typeof s!=='object'||Array.isArray(s))throw fail('A_A2A_CARD_INVALID');
  text(s.id);if(ids.has(s.id))throw fail('A_A2A_CARD_INVALID');ids.add(s.id);
  return {id:s.id,name:text(s.name),description:text(s.description,2000,true),inputModes:modes(s.inputModes??card.defaultInputModes),outputModes:modes(s.outputModes??card.defaultOutputModes)};
 });
 return {name:text(card.name),description:text(card.description,4000,true),version:text(card.version),supportedInterfaces,
  defaultInputModes:modes(card.defaultInputModes),defaultOutputModes:modes(card.defaultOutputModes),skills,
  authenticationAdvertised:Boolean(card.securityRequirements?.length),signatureVerified:false,descriptionTrusted:false};
}

/** Agent Card declarations and reviewed local contracts are distinct. Neither grants execution. */
export class A2aServiceRegistry {
 constructor({storePath=null,clock=()=>new Date()}={}){this.storePath=storePath;this.clock=clock;}
 db(){if(!this.database){if(this.storePath)mkdirSync(dirname(this.storePath),{recursive:true});this.database=new DatabaseSync(this.storePath??':memory:');this.database.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS a2a_services(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS a2a_contracts(service_id TEXT NOT NULL,skill_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(service_id,skill_id));');}return this.database;}
 get(id){const row=this.db().prepare('SELECT value FROM a2a_services WHERE id=?').get(id);return row?JSON.parse(row.value):null;}
 register(input){
  if(!input||Object.keys(input).length!==3||Object.keys(input).some(k=>!['label','source','card'].includes(k)))throw fail('A_A2A_INPUT_INVALID');
  const label=text(input.label,80),source=safeUrl(input.source,{source:true}),card=projectCard(input.card);
  const db=this.db();db.exec('BEGIN IMMEDIATE');
  try{
   const rows=db.prepare('SELECT value FROM a2a_services').all();if(rows.length>=16)throw fail('A_A2A_SERVICE_LIMIT');
   if(rows.some(row=>JSON.parse(row.value).card.supportedInterfaces.some(i=>card.supportedInterfaces.some(c=>c.url===i.url))))throw fail('A_A2A_SERVICE_DUPLICATE');
   const item={id:randomUUID(),label,source,sourceVerified:false,card,cardHash:hash(input.card),revision:1,registeredAt:this.clock().toISOString()};
   db.prepare('INSERT INTO a2a_services VALUES(?,?)').run(item.id,JSON.stringify(item));db.exec('COMMIT');return this.status(item);
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 replaceCard(id,{card,expectedRevision}){
  const projection=projectCard(card),db=this.db();db.exec('BEGIN IMMEDIATE');
  try{const current=this.get(id);if(!current)throw fail('A_A2A_NOT_FOUND');if(current.revision!==expectedRevision)throw fail('A_A2A_REVISION_CONFLICT');
   if(db.prepare('SELECT id,value FROM a2a_services WHERE id<>?').all(id).some(row=>JSON.parse(row.value).card.supportedInterfaces.some(i=>projection.supportedInterfaces.some(p=>p.url===i.url))))throw fail('A_A2A_SERVICE_DUPLICATE');
   const item={...current,card:projection,cardHash:hash(card),revision:current.revision+1,updatedAt:this.clock().toISOString()};
   db.prepare('UPDATE a2a_services SET value=? WHERE id=?').run(JSON.stringify(item),id);db.exec('COMMIT');return this.status(item);
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 // Called by reviewed deployment code only. There is deliberately no remote review/grant endpoint.
 registerReviewedContract(id,input){
  const service=this.get(id);if(!service)throw fail('A_A2A_NOT_FOUND');
  const keys=['skillId','cardHash','agentVersion','version','inputSchema','outputSchema','effect','source','verifierId','verifierFingerprint'];
  if(!input||Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k))||!/^\d+\.\d+\.\d+$/.test(input.version??'')||!['read','write','external-effect'].includes(input.effect)||!/^[a-f0-9]{64}$/.test(input.verifierFingerprint??''))throw fail('A_A2A_CONTRACT_INVALID');
  text(input.verifierId);safeUrl(input.source,{source:true});
  if(!service.card.skills.some(s=>s.id===input.skillId)||input.cardHash!==service.cardHash||input.agentVersion!==service.card.version)throw fail('A_A2A_CONTRACT_CHANGED');
  try{assertSupportedSchema(input.inputSchema);assertSupportedSchema(input.outputSchema);}catch{throw fail('A_A2A_SCHEMA_UNSUPPORTED');}
  if(Buffer.byteLength(JSON.stringify(input))>32768)throw fail('A_A2A_CONTRACT_INVALID');
  this.db().prepare('INSERT OR REPLACE INTO a2a_contracts VALUES(?,?,?)').run(id,input.skillId,JSON.stringify({...input,reviewedAt:this.clock().toISOString()}));return this.status(service);
 }
 status(service){
  const contracts=this.db().prepare('SELECT value FROM a2a_contracts WHERE service_id=? ORDER BY skill_id').all(service.id).map(r=>JSON.parse(r.value));
  return {...service,registrationStatus:'card-registered',executionAuthorized:false,adapterInstalled:false,
   skills:service.card.skills.map(skill=>{const contract=contracts.find(c=>c.skillId===skill.id),current=Boolean(contract&&contract.cardHash===service.cardHash&&contract.agentVersion===service.card.version);
    return {skillId:skill.id,contract:contract??null,contractCurrent:current,status:!contract?'review-required':current?'reviewed-not-activated':'card-changed',executionAuthorized:false};})};
 }
 list(){return {services:this.db().prepare('SELECT value FROM a2a_services ORDER BY id').all().map(row=>this.status(JSON.parse(row.value))),executionAuthorized:false};}
 remove(id){const db=this.db();db.exec('BEGIN IMMEDIATE');try{const removed=db.prepare('DELETE FROM a2a_services WHERE id=?').run(id).changes===1;db.prepare('DELETE FROM a2a_contracts WHERE service_id=?').run(id);db.exec('COMMIT');return {removed,executionAuthorized:false};}catch(error){db.exec('ROLLBACK');throw error;}}
 close(){this.database?.close();this.database=null;}
}
