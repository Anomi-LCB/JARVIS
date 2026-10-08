import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleReadClient} from '../packages/core/src/personal-operations/google-client.js';
import {snapshotGoogleCollectionPage} from '../packages/core/src/personal-operations/google-collection-page.js';
const base={provider:'google-calendar',account:'isolated@example.test',mode:'initial',syncToken:null,cursor:null,initialToken:null};
function fixture(route){let authorized=true,tokenCalls=0;const urls=[];
 const client=new GoogleReadClient({credentials:{clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},fetchImpl:async(input,options)=>{
  const url=new URL(input);if(url.origin==='https://oauth2.googleapis.com'){tokenCalls++;return Response.json({access_token:'synthetic-access',expires_in:3600});}
  urls.push(url);assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer synthetic-access');
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'isolated@example.test',historyId:'10000000000000000001'});
  return route(url,options);
 }});
 return {client,urls,tokenCalls:()=>tokenCalls,authorize:()=>authorized,revoke:()=>authorized=false};
}
test('Calendar initial and incremental queries use fixed metadata scope and keep final token separate',async()=>{
 const f=fixture(url=>{
  assert.equal(url.searchParams.get('showDeleted'),'true');assert.equal(url.searchParams.get('singleEvents'),'false');
  assert.equal(url.searchParams.has('timeMin'),false);assert.equal(url.searchParams.has('timeMax'),false);
  return Response.json(url.searchParams.get('syncToken')?{items:[{id:'cancelled',status:'cancelled'}],nextSyncToken:'next-sync-token'}:{items:[{id:'event-1',summary:'연구 모임',start:{date:'2026-10-09'}}],nextPageToken:'page-2'});
 });
 const page=await f.client.collectionPage(base,{authorize:f.authorize});assert.equal(page.nextCursor,'page-2');assert.equal(page.nextSyncToken,null);assert.equal(page.items[0].start,'2026-10-09');
 const next=await f.client.collectionPage({...base,mode:'incremental',syncToken:'previous-sync-token'},{authorize:f.authorize});assert.equal(next.nextCursor,null);assert.equal(next.nextSyncToken,'next-sync-token');assert.equal(next.items[0].withdrawn,true);
});
test('Gmail initial pagination carries the pre-list history watermark without adding a date filter',async()=>{
 const f=fixture(url=>{if(url.pathname.endsWith('/messages')){assert.equal(url.searchParams.get('includeSpamTrash'),'true');assert.equal(url.searchParams.has('q'),false);return Response.json(url.searchParams.has('pageToken')?{messages:[{id:'m2'}]}:{messages:[{id:'m1'}],nextPageToken:'page-2'});}const id=url.pathname.split('/').at(-1);assert.equal(url.searchParams.get('format'),'metadata');assert.equal(url.searchParams.get('metadataHeaders'),'Subject');return Response.json({id,payload:{headers:[{name:'Subject',value:'연구 메일'}]}});});
 const job={...base,provider:'gmail'},first=await f.client.collectionPage(job,{authorize:f.authorize});assert.equal(first.initialToken,'10000000000000000001');assert.equal(first.nextSyncToken,null);
 const second=await f.client.collectionPage({...job,cursor:first.nextCursor,initialToken:first.initialToken},{authorize:f.authorize});assert.equal(second.nextSyncToken,first.initialToken);assert.equal(second.initialToken,null);assert.equal(second.items[0].id,'m2');
});
test('Gmail history handles added, deleted and label changes once per ID and never fetches message body',async()=>{
 const f=fixture(url=>{if(url.pathname.endsWith('/history')){assert.equal(url.searchParams.get('startHistoryId'),'10000000000000000001');return Response.json({historyId:'10000000000000000003',history:[{id:'10000000000000000002',messagesAdded:[{message:{id:'added'}}],labelsAdded:[{message:{id:'added'}}],messagesDeleted:[{message:{id:'deleted'}}],labelsRemoved:[{message:{id:'changed'}}]}]});}
  const id=url.pathname.split('/').at(-1);assert.equal(url.searchParams.get('format'),'metadata');return id==='deleted'?new Response('',{status:404}):Response.json({id,payload:{headers:[{name:'Subject',value:id}]}});
 });
 const result=await f.client.collectionPage({...base,provider:'gmail',mode:'incremental',syncToken:'10000000000000000001'},{authorize:f.authorize});
 assert.equal(result.items.length,3);assert.equal(result.items.find(x=>x.id==='deleted').withdrawn,true);assert.equal(result.nextSyncToken,'10000000000000000003');assert.equal(f.urls.filter(x=>x.pathname.endsWith('/added')).length,1);
});
for(const [provider,status]of [['google-calendar',410],['gmail',404]])test(`${provider} expired change token requires explicit recovery without another full list`,async()=>{
 const f=fixture(()=>new Response('',{status}));await assert.rejects(f.client.collectionPage({...base,provider,mode:'incremental',syncToken:provider==='gmail'?'1':'expired-token'},{authorize:f.authorize}),/A_GOOGLE_COLLECTION_RESET_REQUIRED/);
 assert.equal(f.urls.filter(x=>!x.pathname.endsWith('/profile')).length,1);
});
for(const [name,change]of [
 ['date filter',x=>({...x,timeMin:'2026-10-08T00:00:00Z'})],['external URL',x=>({...x,url:'https://evil.test'})],['missing field',x=>{const {initialToken,...v}=x;return v;}],
 ['initial token on calendar',x=>({...x,initialToken:'1'})],['incremental without token',x=>({...x,mode:'incremental'})],['unknown mode',x=>({...x,mode:'full'})],
 ['Gmail page without baseline',x=>({...x,provider:'gmail',cursor:'next'})],['numeric historyId',x=>({...x,provider:'gmail',mode:'incremental',syncToken:1})],['control in cursor',x=>({...x,cursor:'bad\nvalue'})]
])test(`invalid collection page ${name} fails before credential access`,async()=>{
 const f=fixture(()=>{throw Error('Unexpected provider call');});await assert.rejects(f.client.collectionPage(change(base),{authorize:f.authorize}),/A_GOOGLE_COLLECTION_PAGE_INVALID/);assert.equal(f.tokenCalls(),0);assert.equal(f.urls.length,0);
});
test('unknown accessors are rejected before their getter or authentication can run',async()=>{
 let getter=0;const job={...base};Object.defineProperty(job,'cursor',{enumerable:true,get(){getter++;return null;}});assert.throws(()=>snapshotGoogleCollectionPage(job));assert.equal(getter,0);
});
test('collection reads require an explicit guard and ordinary get cannot access history',async()=>{
 const f=fixture(()=>Response.json({}));await assert.rejects(f.client.collectionPage(base),/AUTHORIZATION_REQUIRED/);assert.equal(f.tokenCalls(),0);
 await assert.rejects(f.client.get('https://gmail.googleapis.com/gmail/v1/users/me/history'),/ENDPOINT_DENIED/);assert.equal(f.tokenCalls(),0);
});
test('permission revocation during OAuth refresh prevents a provider request',async()=>{
 let allowed=true,calls=0;const client=new GoogleReadClient({credentials:{clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'},fetchImpl:async()=>{calls++;allowed=false;return Response.json({access_token:'synthetic',expires_in:3600});}});
 await assert.rejects(client.collectionPage(base,{authorize:()=>allowed}),/SCOPE_DENIED/);assert.equal(calls,1);
});
test('account switch after data retrieval cannot return a successful result',async()=>{
 let profiles=0;const f=fixture(()=>Response.json({items:[],nextSyncToken:'final'}));const normal=f.client.fetch;f.client.fetch=async(url,o)=>String(url).endsWith('/profile')?Response.json({emailAddress:++profiles===1?'isolated@example.test':'changed@example.test'}):normal(url,o);
 await assert.rejects(f.client.collectionPage(base,{authorize:f.authorize}),/ACCOUNT_MISMATCH/);
});
for(const response of [{items:[]},{items:[],nextPageToken:'p',nextSyncToken:'s'},{items:[{id:'same'},{id:'same'}],nextSyncToken:'s'},{items:[],nextPageToken:123}])test('invalid Calendar result cannot be promoted to a finished change window',async()=>{
 const f=fixture(()=>Response.json(response));await assert.rejects(f.client.collectionPage(base,{authorize:f.authorize}),/COLLECTION_PAGE_INVALID/);
});
test('Gmail history IDs use integer comparison without precision loss and reject regression',async()=>{
 const f=fixture(()=>Response.json({historyId:'10000000000000000000',history:[]}));await assert.rejects(f.client.collectionPage({...base,provider:'gmail',mode:'incremental',syncToken:'10000000000000000001'},{authorize:f.authorize}),/COLLECTION_PAGE_INVALID/);
});
