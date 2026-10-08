import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IntegrationCredentialVault,IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createGoogleVaultReadClient,GOOGLE_CONNECTOR_ID,GOOGLE_READ_SCOPES} from '../packages/core/src/personal-operations/google-vault-client.js';
import {GoogleInboxSync} from '../packages/core/src/personal-operations/google-sync.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

test('actual DPAPI vault deletion through Core pauses collection and survives reopening', {skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'google-local-delete-')),path=join(root,'vault.dpapi.json'),store=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')});
 const vault=new IntegrationCredentialVault({path}),registry=new IntegrationConnectorRegistry();
 const saved=vault.save({connectorId:GOOGLE_CONNECTOR_ID,authMethod:'oauth2',providerAccountId:'isolated@example.test',label:'격리 Google',scopes:[...GOOGLE_READ_SCOPES],credentials:{clientId:'test-client',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh-token'}});
 assert.doesNotMatch(readFileSync(path,'utf8'),/synthetic-refresh-token/);
 let calls=0,cancelled=0;const refreshed=[];
 const client=createGoogleVaultReadClient({registry,vault,fetchImpl:async (url,options)=>{calls++;if(String(url).includes('oauth2'))refreshed.push(options.body.get('refresh_token'));return new Response(JSON.stringify(String(url).includes('oauth2')?{access_token:'test-access',expires_in:3600}:{emailAddress:'isolated@example.test'}));}});
 await client.account();assert.equal(calls,2);
 const sync=new GoogleInboxSync({inbox:new PersonalSourceInbox(store),client});
 const server=createCoreServer(undefined,{integrationVault:vault,integrationRegistry:registry,googleSync:sync,adminToken:'delete-test',googleConnection:{cancelPendingConnection(){cancelled++;}}});const a=await listenOnFetchSafePort(server),base=`http://127.0.0.1:${a.port}`;
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const url=base+'/integrations/connections/'+saved.connectionId;
 assert.equal((await fetch(url,{method:'DELETE'})).status,401);
 const response=await fetch(url,{method:'DELETE',headers:{authorization:'Bearer delete-test'}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.localCredentialsRemoved,true);assert.equal(result.collectionPaused,true);assert.equal(result.providerGrantRevoked,false);assert.equal(cancelled,1);
 assert.equal(new IntegrationCredentialVault({path}).list().length,0);assert.equal(client.configured(),false);await assert.rejects(()=>client.account(),/CONNECTION_REQUIRED/);await sync.run();assert.equal(calls,2);assert.equal(new GoogleInboxSync({inbox:new PersonalSourceInbox(store),client}).status().status,'collection-paused');
 vault.save({connectorId:GOOGLE_CONNECTOR_ID,authMethod:'oauth2',providerAccountId:'isolated@example.test',label:'재연결',scopes:[...GOOGLE_READ_SCOPES],credentials:{clientId:'test-client',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-new-refresh'}});
 assert.equal(client.configured(),true);await sync.run();assert.equal(calls,2);
 assert.equal((await client.verifyConnection()).verified,true);assert.equal(calls,4);
 assert.deepEqual(refreshed,['synthetic-refresh-token','synthetic-new-refresh']);
 assert.equal(sync.status().status,'collection-paused');
 assert.equal(sync.resumeAfterVerifiedConnection().status,'idle');
});

test('failed deletion retains the pause and absence of collection control fails closed',async t=>{
 let paused=0,removed=0;const vault={save(){throw Error('not-used');},list:()=>[{connectionId:'one',connectorId:GOOGLE_CONNECTOR_ID}],remove(){removed++;throw Error('A_INTEGRATION_CREDENTIAL_REMOVE_FAILED');}};
 const server=createCoreServer(undefined,{integrationVault:vault,googleSync:{pauseCollection(){paused++;}},adminToken:'fail-test'}),a=await listenOnFetchSafePort(server);t.after(()=>new Promise(r=>server.close(r)));
 assert.equal((await fetch(`http://127.0.0.1:${a.port}/integrations/connections/one`,{method:'DELETE',headers:{authorization:'Bearer fail-test'}})).status,409);assert.equal(paused,1);assert.equal(removed,1);
 const unavailable=createCoreServer(undefined,{integrationVault:vault,adminToken:'fail-test'}),b=await listenOnFetchSafePort(unavailable);t.after(()=>new Promise(r=>unavailable.close(r)));
 assert.equal((await fetch(`http://127.0.0.1:${b.port}/integrations/connections/one`,{method:'DELETE',headers:{authorization:'Bearer fail-test'}})).status,503);assert.equal(removed,1);
});
