import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleReadClient} from '../packages/core/src/personal-operations/google-client.js';
import {createGoogleVaultReadClient,GOOGLE_CONNECTOR_ID,GOOGLE_READ_SCOPES} from '../packages/core/src/personal-operations/google-vault-client.js';
import {createGoogleBrokerReadClient,createGoogleOperationBroker} from '../packages/core/src/personal-operations/google-operation-broker.js';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GoogleInboxSync} from '../packages/core/src/personal-operations/google-sync.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';

const valid={provider:'gmail',timeMin:'2026-10-01T00:00:00Z',timeMax:'2026-10-02T00:00:00Z',cursor:null};
function fixture(mode){
 const row={connectionId:'synthetic-connection',connectorId:GOOGLE_CONNECTOR_ID,authMethod:'oauth2',status:'credentials-stored-unverified',scopes:[...GOOGLE_READ_SCOPES],updatedAt:'synthetic-revision'};
 const credentials={clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'};
 let calls=0,reads=0,transports=0;const urls=[];
 const fetchImpl=async url=>{calls++;urls.push(String(url));return Response.json(String(url).includes('oauth2')?{access_token:'synthetic-access',expires_in:3600}:String(url).endsWith('/profile')?{emailAddress:'isolated@example.test'}:String(url).includes('/messages')?{messages:[]}:{items:[]});};
 const vault={list:()=>[{...row,scopes:[...row.scopes]}],async withCredentials(id,operation){reads++;return operation({...credentials},{...row});}};
 const registry=new IntegrationConnectorRegistry();
 const broker=createGoogleOperationBroker({registry,vault,fetchImpl});
 let client;if(mode==='direct')client=new GoogleReadClient({credentials,fetchImpl});
 else if(mode==='vault')client=createGoogleVaultReadClient({registry,vault,fetchImpl});
 else client=createGoogleBrokerReadClient({connectionMetadata:vault.list,execute:request=>{transports++;return broker.execute(request);}});
 return {client,broker,counts:()=>({calls,reads,transports}),urls};
}
const changes=[
 ['missing lower bound',j=>{delete j.timeMin;}],['missing upper bound',j=>{delete j.timeMax;}],
 ['invalid calendar date',j=>{j.timeMin='2026-02-30T00:00:00Z';}],
 ['relative date',j=>{j.timeMin='yesterday';}],['reversed window',j=>{j.timeMax=j.timeMin;}],
 ['excess Gmail range',j=>{j.timeMax='2026-12-01T00:00:00Z';}],
 ['excess Calendar range',j=>{j.provider='google-calendar';j.timeMax='2027-10-01T00:00:00Z';}],
 ['fractional precision',j=>{j.timeMin='2026-10-01T00:00:00.001Z';}],
 ['empty cursor',j=>{j.cursor='';}],['object cursor',j=>{j.cursor={value:'page'};}],
 ['oversize cursor',j=>{j.cursor='a'.repeat(2001);}],
 ['unsupported sync token',j=>{j.syncToken='synthetic-sync-token';}],
 ['unsupported history token',j=>{j.startHistoryId='12345';}]
];
for(const mode of ['direct','vault','broker'])for(const [name,change]of changes)test(`${mode} bounded page rejects ${name} before secret or transport access`,async()=>{
 const f=fixture(mode),job={...valid};change(job);
 await assert.rejects(async()=>f.client.page(job),/A_GOOGLE_(PAGE_INVALID|BROKER_REQUEST_INVALID)/);
 assert.deepEqual(f.counts(),{calls:0,reads:0,transports:0});
});

for(const mode of ['direct','vault','broker'])test(`${mode} page rejects getters without executing their code`,async()=>{
 const f=fixture(mode);let invoked=0;const job={...valid};Object.defineProperty(job,'timeMin',{enumerable:true,get(){invoked++;return valid.timeMin;}});
 await assert.rejects(async()=>f.client.page(job),/A_GOOGLE_(PAGE_INVALID|BROKER_REQUEST_INVALID)/);
 assert.equal(invoked,0);assert.deepEqual(f.counts(),{calls:0,reads:0,transports:0});
});

for(const mode of ['direct','vault','broker'])test(`${mode} bounded page preserves whole-second bounds, opaque cursor, account and worker metadata`,async()=>{
 const f=fixture(mode);await f.client.page({...valid,account:'isolated@example.test',cursor:'opaque/page+two=',windowId:'synthetic-window',scope:'direct:gmail:v1',observedAt:'2026-10-08T00:00:00Z',complete:false});
 const url=new URL(f.urls.find(x=>x.includes('/messages?')));
 assert.equal(url.searchParams.get('pageToken'),'opaque/page+two=');
 assert.equal(url.searchParams.get('q'),'after:1790812800 before:1790899200 -in:spam -in:trash');
 assert.ok(f.counts().calls>0);
});

test('broker wire rejects accessors before vault access',async()=>{
 const f=fixture('broker');let invoked=0;const job={...valid};Object.defineProperty(job,'timeMin',{enumerable:true,get(){invoked++;return valid.timeMin;}});
 await assert.rejects(f.broker.execute({connectionId:'synthetic-connection',expectedRevision:'synthetic-revision',operation:'page',job}),/A_GOOGLE_BROKER_REQUEST_INVALID/);
 assert.equal(invoked,0);assert.equal(f.counts().calls,0);assert.equal(f.counts().reads,0);
});

test('new worker windows round inward at provider precision while preserving the observation time',async t=>{
 const root=mkdtempSync(join(tmpdir(),'google-window-contract-')),store=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const f=fixture('direct'),now=new Date('2026-10-08T01:02:03.456Z'),jobs=[];
 const client={configured:()=>true,account:async()=> 'isolated@example.test',page:async job=>{jobs.push({...job});return f.client.page(job);}};
 const sync=new GoogleInboxSync({inbox:new PersonalSourceInbox(store),client,clock:()=>now});
 assert.equal((await sync.run()).status,'ready');assert.equal(jobs.length,2);
 for(const job of jobs){assert.equal(job.observedAt,now.toISOString());assert.equal(Date.parse(job.timeMin)%1000,0);assert.equal(Date.parse(job.timeMax)%1000,0);assert.ok(Date.parse(job.timeMin)>=now.getTime()-14*86400000);assert.ok(Date.parse(job.timeMax)<=now.getTime()+(job.provider==='gmail'?1000:90*86400000));}
});

test('an old fractional partial checkpoint is preserved and blocked rather than reused for a different query',async t=>{
 const root=mkdtempSync(join(tmpdir(),'google-old-window-')),store=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let calls=0;const client={configured:()=>true,account:async()=> 'isolated@example.test',page:async job=>{calls++;return {items:[],nextCursor:job.provider==='gmail'?'saved-page':null};}};
 await new GoogleInboxSync({inbox,client,clock:()=>new Date('2026-10-08T00:00:00Z')}).run();
 const row=store.db.prepare('SELECT id,body FROM personal_google_jobs').all().find(row=>JSON.parse(row.body).provider==='gmail');
 const job=JSON.parse(row.body);job.timeMin='2026-10-01T00:00:00.456Z';const before=JSON.stringify(job);store.db.prepare('UPDATE personal_google_jobs SET body=? WHERE id=?').run(before,row.id);
 const f=fixture('direct'),resumed={...f.client,configured:()=>true,account:async()=> 'isolated@example.test',page:j=>f.client.page(j)};
 const result=await new GoogleInboxSync({inbox,client:resumed,clock:()=>new Date('2026-10-08T00:00:00Z')}).run();
 assert.equal(result.providers.gmail.code,'A_GOOGLE_PAGE_INVALID');assert.match(result.providers.gmail.nextAction,/초기화하지/);
 assert.equal(store.db.prepare('SELECT body FROM personal_google_jobs WHERE id=?').get(row.id).body,before);
 assert.ok(!f.urls.some(url=>url.includes('/messages')));
 assert.ok(f.urls.some(url=>url.includes('/calendar/')));
});
