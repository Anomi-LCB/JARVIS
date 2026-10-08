import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IntegrationCredentialVault,IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createGoogleVaultReadClient,GOOGLE_CONNECTOR_ID,GOOGLE_READ_SCOPES} from '../packages/core/src/personal-operations/google-vault-client.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-vault-metadata-')),path=join(root,'vault.json');let reads=0,now=new Date('2026-10-08T00:00:00Z');
 const options={path,platform:'win32',protect:x=>x,unprotect:x=>{reads++;return x;},harden:()=>{},clock:()=>now};
 const vault=new IntegrationCredentialVault(options),input={connectorId:GOOGLE_CONNECTOR_ID,providerAccountId:'isolated@example.test',authMethod:'oauth2',scopes:[...GOOGLE_READ_SCOPES],credentials:{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-old'}};
 const record=vault.save(input);t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {vault,record,input,path,options,reads:()=>reads,setNow:x=>now=new Date(x),reset:()=>reads=0};
}
test('unchanged encrypted bytes reuse only public metadata and opaque revision, not credential reads',async t=>{
 const f=fixture(t);f.reset();for(let i=0;i<20;i++){f.vault.list();assert.ok(f.vault.credentialRevision(f.record.connectionId));}assert.equal(f.reads(),0);
 for(let i=0;i<3;i++)await f.vault.withCredentials(f.record.connectionId,x=>assert.equal(x.refreshToken,'synthetic-old'));assert.equal(f.reads(),3);
 assert.doesNotMatch(JSON.stringify(f.vault.list()),/synthetic-secret|synthetic-old|indexKey|accountRef/);
});
test('same size and restored mtime credential replacement invalidates revision immediately',t=>{
 const f=fixture(t),before=f.vault.credentialRevision(f.record.connectionId),stat=statSync(f.path),envelope=JSON.parse(readFileSync(f.path)),payload=JSON.parse(Buffer.from(envelope.encrypted,'base64'));
 payload.connections[0].credentials.refreshToken='synthetic-new';envelope.encrypted=Buffer.from(JSON.stringify(payload)).toString('base64');writeFileSync(f.path,JSON.stringify(envelope));utimesSync(f.path,stat.atime,stat.mtime);
 assert.equal(statSync(f.path).size,stat.size);assert.notEqual(f.vault.credentialRevision(f.record.connectionId),before);
});
test('second vault instance replacement and deletion invalidate cached public metadata',t=>{
 const f=fixture(t),other=new IntegrationCredentialVault(f.options),before=f.vault.credentialRevision(f.record.connectionId);other.save({...f.input,credentials:{...f.input.credentials,refreshToken:'synthetic-new'}});assert.notEqual(f.vault.credentialRevision(f.record.connectionId),before);
 other.remove(f.record.connectionId);assert.deepEqual(f.vault.list(),[]);assert.throws(()=>f.vault.credentialRevision(f.record.connectionId),/NOT_FOUND/);
 rmSync(f.path);assert.deepEqual(f.vault.list(),[]);
});
test('expiry is recomputed on every access even when encrypted bytes are unchanged',t=>{
 const f=fixture(t);f.vault.save({...f.input,expiresAt:'2026-10-08T00:00:02Z'});f.setNow('2026-10-08T00:00:03Z');assert.equal(f.vault.list()[0].status,'expired');assert.throws(()=>f.vault.credentialRevision(f.record.connectionId),/NOT_FOUND/);
});
test('caller mutation cannot alter cached scopes, verification or revision',t=>{
 const f=fixture(t);f.vault.recordProviderVerification(f.record.connectionId,{status:'verified',providerVerified:true,checkedAt:'2026-10-08T00:00:00Z'});const before=f.vault.credentialRevision(f.record.connectionId),list=f.vault.list();list[0].scopes.length=0;list[0].providerVerification.status='bad';list[0].label='mutated';
 assert.deepEqual(f.vault.list()[0].scopes,[...GOOGLE_READ_SCOPES]);assert.equal(f.vault.list()[0].providerVerification.status,'verified');assert.equal(f.vault.credentialRevision(f.record.connectionId),before);
});
test('corrupt or unreadable changed bytes never fall back to a previously valid snapshot',t=>{
 const f=fixture(t);f.vault.list();writeFileSync(f.path,'not-json');assert.throws(()=>f.vault.list(),/UNREADABLE/);assert.throws(()=>f.vault.credentialRevision(f.record.connectionId),/UNREADABLE/);
 rmSync(f.path);writeFileSync(f.path,'{}');assert.throws(()=>f.vault.list(),/UNREADABLE/);
});
for(const change of ['credentials','remove','scopes'])test(`real vault ${change} during OAuth response blocks provider dispatch using cached revision`,async t=>{
 const f=fixture(t),calls=[],other=new IntegrationCredentialVault(f.options);const client=createGoogleVaultReadClient({vault:f.vault,registry:new IntegrationConnectorRegistry(),fetchImpl:async url=>{calls.push(String(url));if(change==='remove')other.remove(f.record.connectionId);else other.save({...f.input,scopes:change==='scopes'?[]:f.input.scopes,credentials:{...f.input.credentials,refreshToken:'synthetic-new'}});return Response.json({access_token:'synthetic-access',expires_in:3600});}});
 await assert.rejects(client.account(),/A_GOOGLE_CONNECTION_(CHANGED|REQUIRED)/);assert.equal(calls.length,1);
});
test('many provider currentness checks require one fresh scoped credential read per operation',async t=>{
 const f=fixture(t);f.reset();const calls=[];const client=createGoogleVaultReadClient({vault:f.vault,registry:new IntegrationConnectorRegistry(),fetchImpl:async url=>{calls.push(String(url));return String(url).includes('oauth2')?Response.json({access_token:'synthetic-access',expires_in:3600}):Response.json({emailAddress:'isolated@example.test'});}});
 assert.equal(await client.account(),'isolated@example.test');assert.equal(f.reads(),1);assert.equal(calls.length,2);
 assert.equal(await client.account(),'isolated@example.test');assert.equal(f.reads(),2);assert.equal(calls.length,3);
});
