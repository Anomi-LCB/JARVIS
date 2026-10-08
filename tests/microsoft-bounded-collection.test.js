import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createMicrosoftSourceReader,microsoftSourceContracts} from '../packages/core/src/personal-operations/microsoft-source-reader.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {createCoreServer} from '../packages/core/src/main.mjs';

function fixture(t,provider='outlook'){
 const root=mkdtempSync(join(tmpdir(),'jarvis-ms-collection-'));
 const store=new PersonalOperationsStore({dbPath:join(root,'inbox.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(()=>{store.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-ms-collection-'));rmSync(root,{recursive:true,force:true});});
 const contract=microsoftSourceContracts[provider],record={connectionId:'synthetic',connectorId:contract.connectorId,authMethod:'oauth2',status:'credentials-stored-unverified',scopes:[contract.scope]};
 const credentials={tenantId:provider==='outlook'?'common':'organizations',clientId:'synthetic',clientSecret:'secret-never-return',refreshToken:'refresh-never-return'};
 const vault={list:()=>[{...record,scopes:[...record.scopes]}],credentialRevision:()=>JSON.stringify([record,credentials]),withCredentials:async(id,fn)=>fn({...credentials},{...record}),
  rotateOAuthRefreshToken(id,{refreshToken}){credentials.refreshToken=refreshToken;return {...record};}};
 const job={provider,connectionId:'synthetic',...(provider==='teams-chat'?{chatId:'19:synthetic@thread.v2'}:{})};
 const cursor=n=>provider==='outlook'?`https://graph.microsoft.com/v1.0/me/messages?$select=id,subject,receivedDateTime&$skip=${n}`:`https://graph.microsoft.com/v1.0/chats/19:synthetic@thread.v2/messages?$skiptoken=${n}`;
 const calls=[];let graph=0,token=0,rotate=false,handler=(n)=>({value:n===2?[]:[{id:'item-'+n,subject:'合成 자료 '+n,body:{content:'private-body'}}],...(n<3?{'@odata.nextLink':cursor(n)}:{})});
 const reader=createMicrosoftSourceReader({registry:new IntegrationConnectorRegistry(),vault,fetchImpl:async(url,options)=>{
  assert.equal(options.redirect,'error');calls.push(String(url));
  if(String(url).startsWith('https://login.microsoftonline.com/'))return Response.json({access_token:'synthetic.token',expires_in:3600,scope:contract.scope,...(rotate?{refresh_token:'rotated-'+(++token)}:{})});
  const result=await handler(++graph,url);return result instanceof Response?result:Response.json(result);
 }});
 return {root,store,inbox,record,credentials,reader,job,cursor,calls,handler(fn){handler=fn;},rotate(){rotate=true;}};
}
for(const provider of ['outlook','teams-chat'])for(const rotate of [false,true])test(`bounded ${provider} traverses empty page, verifies SQLite chain; rotation=${rotate}`,async t=>{
 const f=fixture(t,provider);if(rotate)f.rotate();
 const result=await f.reader.collect(f.job,f.inbox);
 assert.equal(result.status,'completed');assert.equal(result.paginationComplete,true);assert.equal(result.snapshotVerified,false);
 assert.equal(result.pageCount,3);assert.equal(result.itemCount,2);assert.equal(result.verification.observedItemCount,2);
 assert.equal(f.inbox.list().length,2);assert.equal(f.calls.filter(x=>x.startsWith('https://graph.')).length,3);
 assert.equal(f.store.db.prepare('SELECT cursor FROM personal_source_streams').get().cursor,null);
 assert.doesNotMatch(JSON.stringify(result),/secret-never-return|refresh-never-return|private-body|synthetic.token/);
});
test('page limit is paused, preserves exact nextLink and supports explicit continuation',async t=>{
 const f=fixture(t),first=await f.reader.collect(f.job,f.inbox,{maxPages:1});
 assert.equal(first.status,'paused');assert.equal(first.paginationComplete,false);assert.equal(first.nextCursor,f.cursor(1));
 const second=await f.reader.collect({...f.job,cursor:first.nextCursor},f.inbox);
 assert.equal(second.status,'completed');assert.equal(second.pageCount,2);assert.equal(second.initialCursor,first.nextCursor);assert.equal(f.inbox.list().length,2);
});
for(const mode of ['cycle','overlap','foreign','rate-limit','revoked','cancelled','sql-loss'])test(`collection rejects ${mode} without false completion or second page commit`,async t=>{
 const f=fixture(t),abort=new AbortController();let allowed=true;
 f.handler(n=>{
  if(n===1)return {value:[{id:'one',subject:'first'}],'@odata.nextLink':f.cursor(1)};
  if(mode==='cycle')return {value:[], '@odata.nextLink':f.cursor(1)};
  if(mode==='overlap')return {value:[{id:'one',subject:'changed'}]};
  if(mode==='foreign')return {value:[],'@odata.nextLink':'https://attacker.test/steal'};
  if(mode==='rate-limit')return Response.json({error:'synthetic'},{status:429});
  if(mode==='revoked')allowed=false;
  if(mode==='cancelled')abort.abort();
  return {value:[{id:'two',subject:'second'}]};
 });
 if(mode==='sql-loss'){
  const verify=f.inbox.verifyCollection.bind(f.inbox);
  f.inbox.verifyCollection=pages=>{f.store.db.prepare("DELETE FROM personal_source_items WHERE provider_id='one'").run();return verify(pages);};
 }
 await assert.rejects(f.reader.collect(f.job,f.inbox,{authorize:()=>allowed,signal:abort.signal}),/A_(MICROSOFT|SOURCE)_/);
 assert.ok(!f.calls.some(url=>url.includes('attacker.test')));
 if(mode!=='sql-loss'){
  assert.equal(f.inbox.list().length,1);
  assert.equal(f.store.db.prepare('SELECT cursor FROM personal_source_streams').get().cursor,f.cursor(1));
 }
});
test('a partial provider failure leaves durable exact resume cursor across SQLite reopen',async t=>{
 const f=fixture(t);f.handler(n=>n===1?{value:[{id:'one'}],'@odata.nextLink':f.cursor(1)}:Response.json({}, {status:429}));
 await assert.rejects(f.reader.collect(f.job,f.inbox),/RATE_LIMITED/);
 const storedCursor=f.store.db.prepare('SELECT cursor FROM personal_source_streams').get().cursor;
 const reopened=new PersonalOperationsStore({dbPath:join(f.root,'inbox.sqlite')});
 try{
  const inbox=new PersonalSourceInbox(reopened);assert.equal(inbox.list().length,1);
  f.handler(()=>({value:[{id:'two'}]}));
  const resumed=await f.reader.collect({...f.job,cursor:storedCursor},inbox);
  assert.equal(resumed.status,'completed');assert.equal(inbox.list().length,2);
 }finally{reopened.close();}
});
test('collection excludes concurrent page reads and a competing collection',async t=>{
 const f=fixture(t);let release,started;const hold=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 f.handler(async()=>{started();await hold;return {value:[]};});
 const pending=f.reader.collect(f.job,f.inbox);await entered;
 try{await assert.rejects(f.reader.page(f.job),/CONNECTION_BUSY/);await assert.rejects(f.reader.collect(f.job,f.inbox),/CONNECTION_BUSY/);}
 finally{release();await pending;}
});
test('progress reads only the selected durable cursor, never infers completion, and rechecks authority',async t=>{
 const f=fixture(t);assert.equal(f.reader.progress(f.job,f.inbox).present,false);
 await f.reader.collect(f.job,f.inbox,{maxPages:1});const calls=f.calls.length;
 const progress=f.reader.progress(f.job,f.inbox);assert.equal(progress.nextCursor,f.cursor(1));assert.equal(progress.paginationComplete,null);assert.equal(f.calls.length,calls);
 assert.equal(f.reader.progress({...f.job,connectionId:'synthetic'},f.inbox).present,true);
 assert.throws(()=>f.reader.progress(f.job,f.inbox,{authorize:()=>false}),/AUTHORIZATION_DENIED/);
 f.record.status='revoked';assert.throws(()=>f.reader.progress(f.job,f.inbox),/CONNECTION_REQUIRED/);
});
test('invalid bounds and denied authority perform no provider calls',async t=>{
 const f=fixture(t);
 for(const maxPages of [0,101,-1,1.5,'20',null])await assert.rejects(f.reader.collect(f.job,f.inbox,{maxPages}),/PAGE_LIMIT_INVALID/);
 await assert.rejects(f.reader.collect(f.job,f.inbox,{authorize:()=>false}),/AUTHORIZATION_DENIED/);
 assert.equal(f.calls.length,0);
});
test('authenticated real HTTP route reports bounded progress and continuation without caches',async t=>{
 const f=fixture(t),server=createCoreServer(undefined,{adminToken:'synthetic-admin',personalInbox:f.inbox,microsoftSourceReader:f.reader});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/personal-inbox/microsoft/collect`;
 const post=(body,token='synthetic-admin')=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(f.job,'wrong')).status,401);assert.equal(f.calls.length,0);
 const first=await post({...f.job,maxPages:1});assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
 const progress=await first.json();assert.equal(progress.status,'paused');
 const saved=await fetch(url.replace('/collect','/progress'),{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(f.job)});
 assert.equal(saved.status,200);assert.equal(saved.headers.get('cache-control'),'no-store');assert.equal((await saved.json()).nextCursor,progress.nextCursor);
 const second=await post({...f.job,cursor:progress.nextCursor});assert.equal(second.status,200);assert.equal((await second.json()).status,'completed');
 assert.equal(f.inbox.list().length,2);
 console.log(JSON.stringify({http:true,provider:'synthetic Graph',pages:3,items:2,partialThenContinuation:true,externalWrites:0,realAccountVerified:false}));
});
test('HTTP collection checks current Core authority again before the local page commit',async t=>{
 const f=fixture(t);let active=true;
 const authority={assertActive(){if(!active)throw Error('A_CORE_AUTHORITY_NOT_ACTIVE');}};
 f.handler(()=>{active=false;return {value:[{id:'not-committed'}]};});
 const server=createCoreServer(undefined,{adminToken:'synthetic-admin',personalInbox:f.inbox,microsoftSourceReader:f.reader,missionRuntime:{executionAuthority:authority}});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const response=await fetch(`http://127.0.0.1:${server.address().port}/personal-inbox/microsoft/collect`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(f.job)});
 assert.equal(response.status,403);assert.equal((await response.json()).error.code,'A_MICROSOFT_AUTHORIZATION_DENIED');assert.equal(f.inbox.list().length,0);
});
