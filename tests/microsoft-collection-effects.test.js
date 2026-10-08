import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {MicrosoftCollectionEffects} from '../packages/core/src/personal-operations/microsoft-collection-effects.js';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createMicrosoftSourceReader,microsoftSourceContracts} from '../packages/core/src/personal-operations/microsoft-source-reader.js';
import {createMicrosoftCollectionAccess} from '../apps/runtime-compose/src/microsoft-collection-access.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SqliteMissionStore} from '../packages/core/src/mission/sqlite-mission-store.js';
const sign=text=>createHmac('sha256','synthetic-only-effect-test-key').update(text).digest('hex');
const signer={keyId:'synthetic-test',sign,verify:(text,signature)=>signature===sign(text)};
for(const provider of ['outlook','teams-chat'])for(const mode of ['ready','response-lost','sign-failure','provider-failure','revoked','tampered','changed-sql','different-binding'])test('durable Microsoft SQL '+provider+' '+mode,async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-effects-')),dbPath=join(root,'db.sqlite');let store=new PersonalOperationsStore({dbPath}),inbox=new PersonalSourceInbox(store),allowed=true,calls=0,access;
 t.after(async()=>{access?.close();store.close();await rm(root,{recursive:true,force:true});});
 const request={provider,connectionId:'synthetic',...(provider==='teams-chat'?{chatId:'19:synthetic@thread.v2'}:{})},contract=microsoftSourceContracts[provider];
 const record={connectionId:'synthetic',connectorId:contract.connectorId,authMethod:'oauth2',status:'credentials-stored-unverified',scopes:[contract.scope]};
 const reader=createMicrosoftSourceReader({registry:new IntegrationConnectorRegistry(),vault:{list:()=>[record],credentialRevision:()=> 'synthetic',withCredentials:async(id,run)=>run({tenantId:provider==='outlook'?'common':'organizations',clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},record)},fetchImpl:async url=>{
  calls++;if(String(url).includes('login.microsoftonline.com'))return Response.json({access_token:'synthetic.token',expires_in:3600,scope:contract.scope});
  if(mode==='provider-failure')throw Error('synthetic transport loss');
  return Response.json({value:[{id:'one',subject:'합성 메타데이터'}]});
 }});
 const binding={operationId:'operation-one',missionId:'mission-one',actionId:'action-one',taskId:'task-one',goalRevision:1,authorizationRevision:1};
 const task={taskId:'task-one',status:'EXECUTING',plan:{action:{toolName:'source.collectMicrosoftMetadata',arguments:request}}};
 let ledger=new MicrosoftCollectionEffects({store,inbox,signer:mode==='sign-failure'?{...signer,sign(){throw Error('synthetic signer failure');}}:signer});
 let once=mode==='response-lost';
 const transport={...reader,commitPage(...args){const result=reader.commitPage(...args);if(once){once=false;throw Error('synthetic lost commit response');}return result;}};
 const make=()=>createMicrosoftCollectionAccess({reader:transport,inbox,readTrustedTask:()=>task,authorizeConnection:()=>allowed,effectContextFor:()=>({ledger,binding})});
 access=make();
 const run=()=>access.collect(request,{taskId:'task-one',checkCurrent:()=>allowed});
 if(['sign-failure','provider-failure'].includes(mode)){
  await assert.rejects(run);assert.equal(inbox.list().length,0);
  assert.equal(store.db.prepare('SELECT state FROM microsoft_collection_effects').get().state,'uncertain');
  const before=calls;await assert.rejects(run,/RECONCILIATION_REQUIRED/);assert.equal(calls,before);
  assert.throws(()=>ledger.claim({...binding,operationId:'operation-two'},request),/RECONCILIATION_REQUIRED/);
  return;
 }
 if(mode==='response-lost')await assert.rejects(run,/lost commit response/);else await run();
 assert.equal(inbox.list().length,1);assert.equal(store.db.prepare('SELECT state FROM microsoft_collection_effects').get().state,'committed');
 access.close();store.close();store=new PersonalOperationsStore({dbPath});inbox=new PersonalSourceInbox(store);ledger=new MicrosoftCollectionEffects({store,inbox,signer});access=make();
 const before=calls;
 if(mode==='revoked')allowed=false;
 if(mode==='tampered')store.db.prepare("UPDATE microsoft_collection_effects SET signature='tampered'").run();
 if(mode==='changed-sql')store.db.prepare('DELETE FROM personal_source_items').run();
 if(mode==='different-binding')binding.authorizationRevision=2;
 if(['ready','response-lost'].includes(mode)){
  const receipt=await run();assert.equal(access.verifyCollectedPage(receipt).status,'passed');assert.equal(receipt.page.items[0].title,'합성 메타데이터');
  const input=join(root,'reopen.json');await writeFile(input,JSON.stringify({dbPath,binding,request}));
  const result=await promisify(execFile)(process.execPath,['tests/fixtures/microsoft-effects-reopen.mjs',input],{windowsHide:true,timeout:15000});
  const proof=JSON.parse(result.stdout);assert.notEqual(proof.pid,process.pid);assert.equal(proof.verified,'passed');assert.equal(proof.rows,1);assert.equal(proof.providerCalls,0);
  t.diagnostic(JSON.stringify({provider,mode,separateProcessSqlReconciliation:true,providerCallsAfterCommit:0}));
 }
 else await assert.rejects(run);
 assert.equal(calls,before,'reconciliation must not make another token or Graph request');
});
test('unresolved Microsoft SQL effects block normal Core authority and allow explicit recovery-only',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ms-effect-authority-')),store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const ledger=new MicrosoftCollectionEffects({store,inbox,signer}),sql=new SqliteMissionStore({operationsStore:store});
 const binding={operationId:'one',missionId:'one',actionId:'one',taskId:'one',goalRevision:1,authorizationRevision:1};
 ledger.claim(binding,{provider:'outlook',connectionId:'synthetic'});
 assert.throws(()=>sql.acquireCoreAuthority({ownerId:'new',expectedToken:0}),/EFFECT_RECONCILIATION_REQUIRED/);
 const recovery=sql.acquireCoreAuthority({ownerId:'recovery',expectedToken:0,recoveryOnly:true});
 assert.equal(recovery.ownerId,'recovery');assert.equal(recovery.token,1);
 assert.throws(()=>sql.releaseCoreAuthority(recovery),/EFFECT_RECONCILIATION_REQUIRED/);
});
