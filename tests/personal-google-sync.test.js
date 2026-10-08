import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleReadClient } from '../packages/core/src/personal-operations/google-client.js';
import { GoogleInboxSync } from '../packages/core/src/personal-operations/google-sync.js';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalSourceInbox } from '../packages/core/src/personal-operations/source-inbox.js';
import { saveGoogleCredentials,loadGoogleCredentials } from '../packages/core/src/personal-operations/google-credentials.js';
const credentials={clientId:'test-client',clientSecret:'test-secret',refreshToken:'test-refresh'};

test('user pause is durable across runners and late pages cannot enter the inbox',async t=>{
 const f=fixture(t);let release,entered;const pageEntered=new Promise(r=>entered=r),held=new Promise(r=>release=r);let accounts=0,pages=0;
 const client={configured:()=>true,account:async()=>{accounts++;return 'test@example.com';},page:async()=>{pages++;entered();await held;return {items:[{id:'late',title:'must not store'}],nextCursor:null};}};
 const first=new GoogleInboxSync({...f,client}),second=new GoogleInboxSync({...f,client});
 const pending=first.run();await pageEntered;const paused=second.pauseCollection();assert.equal(paused.status,'collection-paused');assert.equal(paused.credentialsDeleted,false);assert.equal(paused.remoteGrantRevocationConfirmed,false);
 release();assert.equal((await pending).status,'collection-paused');assert.equal(f.inbox.list().length,0);assert.equal(pages,1);
 const restarted=new GoogleInboxSync({...f,client});restarted.start();await restarted.run();assert.equal(restarted.status().status,'collection-paused');assert.equal(accounts,1);assert.equal(restarted.timer,null);
});

test('pause then reconnection still rejects an old in-flight response by generation',async t=>{
 const f=fixture(t);let release,entered;const pageEntered=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 const client={configured:()=>true,account:async()=> 'test@example.com',page:async()=>{entered();await held;return {items:[{id:'stale',title:'old generation'}],nextCursor:null};}};
 const sync=new GoogleInboxSync({...f,client});const pending=sync.run();await pageEntered;sync.pauseCollection();sync.resumeAfterVerifiedConnection();release();
 assert.equal((await pending).status,'interrupted');assert.equal(f.inbox.list().length,0);
});

test('a late authentication error cannot replace an explicit user pause',async t=>{
 const f=fixture(t);let reject,entered;const enteredAccount=new Promise(r=>entered=r);
 const client={configured:()=>true,account:()=>{entered();return new Promise((_,r)=>reject=r);},page:async()=>({items:[],nextCursor:null})};
 const sync=new GoogleInboxSync({...f,client});const pending=sync.run();await enteredAccount;sync.pauseCollection();reject(new Error('A_GOOGLE_REAUTH_REQUIRED'));
 const result=await pending;assert.equal(result.status,'collection-paused');assert.equal(result.error,'A_GOOGLE_COLLECTION_PAUSED');
});

test('pause API requires administrator and reports paused collection without falsely deleting credentials',async t=>{
 const f=fixture(t);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');
 const sync=new GoogleInboxSync({...f,client:{configured:()=>true,account:async()=> 'test@example.com',page:async()=>({items:[],nextCursor:null})}});
 const server=createCoreServer(undefined,{adminToken:'pause-admin',googleSync:sync,personalInbox:f.inbox,googleConnection:{status:()=>({status:'connected',credentialLocation:'broker'})}});
 const address=await listenOnFetchSafePort(server);t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${address.port}`;
 assert.equal((await fetch(base+'/personal-google/pause',{method:'POST',body:'{}'})).status,401);
 const headers={authorization:'Bearer pause-admin','content-type':'application/json'};
 assert.equal((await fetch(base+'/personal-google/pause',{method:'POST',headers,body:'{"deleteCredentials":true}'})).status,409);
 const reply=await fetch(base+'/personal-google/pause',{method:'POST',headers,body:'{}'});assert.equal(reply.status,200);assert.equal((await reply.json()).status,'collection-paused');
 const inbox=await fetch(base+'/personal-inbox',{headers});const body=await inbox.json();assert.equal(body.connection.status,'collection-paused');assert.equal(body.connection.providerVerified,false);assert.equal(body.connection.credentialLocation,'broker');
});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-google-test-'));const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,inbox:new PersonalSourceInbox(store)};}
test('OAuth refresh is coalesced and token never goes to an arbitrary endpoint',async()=>{
  let refreshes=0;const client=new GoogleReadClient({credentials,fetchImpl:async(url,opts)=>{refreshes++;assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(opts.redirect,'error');return json({access_token:'access',expires_in:3600});}});
  assert.deepEqual(await Promise.all([client.accessToken(),client.accessToken()]),['access','access']);assert.equal(refreshes,1);
  await assert.rejects(()=>client.get('https://attacker.invalid/'),/ENDPOINT_DENIED/);assert.equal(refreshes,1);
});
test('401 refresh retry is bounded; revoked grant error omits sensitive upstream details',async()=>{
  let api=0,tokens=0;
  const client=new GoogleReadClient({credentials,fetchImpl:async url=>String(url).includes('oauth2')?(tokens++,json({access_token:'access',expires_in:3600})):(api++,json({},401))});
  await assert.rejects(()=>client.account(),/HTTP_401/);assert.equal(api,2);assert.equal(tokens,2);
  const revoked=new GoogleReadClient({credentials,fetchImpl:async()=>json({error_description:'test-refresh secret'},400)});
  await assert.rejects(()=>revoked.account(),{message:'A_GOOGLE_REAUTH_REQUIRED'});
});
test('real provider wire shapes map only minimal metadata and preserve all-day date',async()=>{
  const client=new GoogleReadClient({credentials,fetchImpl:async(url,opts)=>{
    const target=new URL(url);
    if(target.hostname==='oauth2.googleapis.com')return json({access_token:'access',expires_in:3600});
    assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');
    if(target.pathname.endsWith('/messages'))return json({messages:[{id:'message'}]});
    if(target.pathname.endsWith('/messages/message')){assert.equal(target.searchParams.get('format'),'metadata');return json({payload:{headers:[{name:'Subject',value:'Hello'}]},body:'do not save'});}
    return json({items:[{id:'event',summary:'All day',start:{date:'2026-09-20'},status:'cancelled'}]});
  }});
  const job={timeMin:'2026-09-01T00:00:00Z',timeMax:'2026-10-01T00:00:00Z',cursor:null};
  assert.deepEqual((await client.page({...job,provider:'gmail'})).items,[{id:'message',title:'Hello'}]);
  assert.deepEqual((await client.page({...job,provider:'google-calendar'})).items,[{id:'event',title:'All day',start:'2026-09-20',withdrawn:true}]);
});
test('failure keeps next page checkpoint, independent calendar succeeds, new runner resumes without duplicates',async t=>{
  const f=fixture(t);let fail=true;const seen=[];
  const client={configured:()=>true,account:async()=> 'test@example.com',page:async job=>{
    seen.push([job.provider,job.cursor]);
    if(job.provider==='google-calendar')return {items:[],nextCursor:null};
    if(!job.cursor)return {items:[{id:'1',title:'First'}],nextCursor:'next'};
    if(fail)throw new Error('A_GOOGLE_API_HTTP_429');
    return {items:[{id:'2',title:'Second'}],nextCursor:null};
  }};
  const first=await new GoogleInboxSync({...f,client}).run();assert.equal(first.status,'degraded');assert.equal(first.providers['google-calendar'].status,'window-complete');
  fail=false;seen.length=0;assert.equal((await new GoogleInboxSync({...f,client}).run()).status,'ready');assert.deepEqual(seen[0],['gmail','next']);assert.equal(f.inbox.list().length,2);
});
test('revoked Google grant pauses recurring sync, stops the sibling provider, and exposes only minimal reconnect scopes',async t=>{
  const f=fixture(t);let accountCalls=0,pageCalls=[];
  const client={configured:()=>true,connectionRequirements:()=>({requiredScopes:['gmail.readonly','calendar.readonly'],remoteGrantRevocationConfirmed:false}),
    account:async()=>{accountCalls++;return 'test@example.com';},page:async job=>{pageCalls.push(job.provider);throw new Error('A_GOOGLE_REAUTH_REQUIRED');}};
  const sync=new GoogleInboxSync({...f,client,intervalMs:10});t.after(()=>sync.stop());sync.start();await sync.pending;
  assert.equal(sync.status().status,'reauth-required');assert.equal(sync.status().running,false);assert.equal(sync.timer,null);
  assert.deepEqual(pageCalls,['gmail']);assert.equal(sync.status().requiredScopes.join(','),'gmail.readonly,calendar.readonly');
  assert.equal(sync.status().remoteGrantRevocationConfirmed,undefined);assert.match(sync.status().nextAction,/다시 승인/u);
  await sync.run();assert.equal(accountCalls,1);assert.deepEqual(pageCalls,['gmail']);
});
test('only a verified reconnection re-arms a Google sync paused for reauthentication',async t=>{
  const f=fixture(t);let revoked=true,accountCalls=0;
  const client={configured:()=>true,connectionRequirements:()=>({requiredScopes:['gmail.readonly']}),
    account:async()=>{accountCalls++;if(revoked)throw new Error('A_GOOGLE_REAUTH_REQUIRED');return 'test@example.com';},
    page:async()=>({items:[],nextCursor:null})};
  const sync=new GoogleInboxSync({...f,client,intervalMs:10});t.after(()=>sync.stop());sync.start();await sync.pending;
  assert.equal(sync.status().status,'reauth-required');
  const resumed=new GoogleInboxSync({...f,client,intervalMs:10});t.after(()=>resumed.stop());
  assert.equal(resumed.status().status,'reauth-required');resumed.start();assert.equal(accountCalls,1);
  revoked=false;resumed.resumeAfterVerifiedConnection();resumed.start();await resumed.pending;
  assert.equal(resumed.status().status,'ready');assert.equal(accountCalls,2);await sync.stop();await resumed.stop();
});
test('personal inbox reports reauthentication instead of a stale connected Google badge',async t=>{
  const f=fixture(t);const {createCoreServer}=await import('../packages/core/src/main.mjs');
  const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');
  const sync={status:()=>({configured:true,running:false,status:'reauth-required',error:'A_GOOGLE_REAUTH_REQUIRED',
    requiredScopes:['https://www.googleapis.com/auth/gmail.readonly'],nextAction:'Google 계정 연결을 다시 승인한 뒤 동기화를 재개하세요.'})};
  const server=createCoreServer(undefined,{adminToken:'google-sync-status-test',personalInbox:f.inbox,googleSync:sync,
    googleConnection:{status:()=>({status:'connected'})}});
  const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${address.port}/personal-inbox`,{headers:{authorization:'Bearer google-sync-status-test'}});
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.connection.status,'reauth-required');
  assert.deepEqual(body.connection.requiredScopes,['https://www.googleapis.com/auth/gmail.readonly']);
  assert.equal(body.google.status,'reauth-required');
});
test('durable lease prevents a second process from starting duplicate reads',async t=>{
  const f=fixture(t);let release;const hold=new Promise(resolve=>release=resolve);let calls=0;
  const client={configured:()=>true,account:async()=>{calls++;await hold;return 'test@example.com';},page:async()=>({items:[],nextCursor:null})};
  const a=new GoogleInboxSync({...f,client}),b=new GoogleInboxSync({...f,client});const pending=a.run();
  assert.equal((await b.run()).status,'busy');assert.equal(calls,1);release();await pending;
});
test('checkpoint write failure rolls back source items and no credentials means no network calls',async t=>{
  const f=fixture(t);assert.throws(()=>f.inbox.ingest({provider:'gmail',account:'test',scope:'test',observedAt:'2026-09-13T00:00:00Z',items:[{id:'1',title:'Test'}]},{onCommit:()=>{throw new Error('disk failure');}}));assert.equal(f.inbox.list().length,0);
  const client=new GoogleReadClient({credentials:{},fetchImpl:()=>{throw new Error('must not fetch');}});const result=await new GoogleInboxSync({...f,client}).run();assert.equal(result.status,'connection-required');
});
test('Windows DPAPI credential round trip stores no plaintext and test mode never loads live secrets',{skip:process.platform!=='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-google-dpapi-')),path=join(root,'google.json');t.after(()=>rmSync(root,{recursive:true,force:true}));
  saveGoogleCredentials(credentials,{path});
  assert.equal(readFileSync(path,'utf8').includes('test-refresh'),false);assert.deepEqual(loadGoogleCredentials({},{path}),credentials);
  assert.deepEqual(loadGoogleCredentials({JARVIS_TEST_MODE:'1'},{path}),{});
  assert.equal(loadGoogleCredentials({},{path,unprotect:()=>{throw new Error('private details');}}).configurationError,'A_GOOGLE_CREDENTIAL_STORE_UNREADABLE');
});
