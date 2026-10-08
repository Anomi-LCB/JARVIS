import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';
import {createDuffelBrokerHttpsTransport} from '../packages/core/src/personal-operations/duffel-broker-https.js';
import {runConfiguredDuffelCredentialBroker} from '../scripts/duffel-credential-broker.mjs';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
import {createConfiguredDuffelBroker} from '../packages/core/src/personal-operations/configured-duffel-broker.js';

test('broker startup refuses missing/relative/aliased configuration before creating revocation database',async()=>{
 await assert.rejects(runConfiguredDuffelCredentialBroker({env:{}}),/WINDOWS_SECRET_STORE_REQUIRED|CONFIG_INCOMPLETE/u);
 if(process.platform!=='win32')return;
 const env=Object.fromEntries(['TLS_KEY','TLS_CERT','TLS_CA','VAULT','METADATA','REVOCATIONS'].map(n=>['JARVIS_DUFFEL_BROKER_'+n,join(tmpdir(),n)]));
 Object.assign(env,{JARVIS_DUFFEL_BROKER_PORT:'17443',JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT:'A'.repeat(64)});
 await assert.rejects(runConfiguredDuffelCredentialBroker({env:{...env,JARVIS_DUFFEL_BROKER_VAULT:'relative'}}),/CONFIG_INCOMPLETE/u);
 await assert.rejects(runConfiguredDuffelCredentialBroker({env:{...env,JARVIS_DUFFEL_BROKER_REVOCATIONS:env.JARVIS_DUFFEL_BROKER_VAULT.toUpperCase()}}),/PATHS_INVALID/u);
 await assert.rejects(runConfiguredDuffelCredentialBroker({env:{...env,JARVIS_DUFFEL_BROKER_PORT:'99999'}}),/LISTEN_CONFIG_INVALID/u);
});
test('configured startup opens only loopback with ephemeral evaluation PKI and scoped DPAPI metadata; repeated close and restart work',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-entry-positive-'));setFixturePrivateAcl(root);
 let host,transport,core;
 t.after(async()=>{core?.close();transport?.close();await host?.close();for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);});
 const generated=spawnSync('python',[fileURLToPath(new URL('./fixtures/ephemeral-broker-certificates.py',import.meta.url)),root],{windowsHide:true,encoding:'utf8',timeout:10000});
 assert.equal(generated.status,0,generated.stderr);
 const env=Object.fromEntries(['TLS_KEY','TLS_CERT','TLS_CA','VAULT','METADATA','REVOCATIONS'].map(n=>['JARVIS_DUFFEL_BROKER_'+n,join(root,n)]));
 saveDuffelTestCredential({apiKey:'duffel_test_ephemeral_evaluation_only',readConsent:true,vaultPath:env.JARVIS_DUFFEL_BROKER_VAULT,metadataPath:env.JARVIS_DUFFEL_BROKER_METADATA});
 env.JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT=new X509Certificate(readFileSync(join(root,'CLIENT_CERT'))).fingerprint256;
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));env.JARVIS_DUFFEL_BROKER_PORT=String(reservation.address().port);await new Promise(r=>reservation.close(r));
 const before=readFileSync(env.JARVIS_DUFFEL_BROKER_VAULT);
 const profilePath=join(root,'profile.json');
 writeFileSync(profilePath,JSON.stringify({schemaVersion:1,port:Number(env.JARVIS_DUFFEL_BROKER_PORT),
   vault:env.JARVIS_DUFFEL_BROKER_VAULT,metadata:env.JARVIS_DUFFEL_BROKER_METADATA,revocations:env.JARVIS_DUFFEL_BROKER_REVOCATIONS,
   serverTls:{key:env.JARVIS_DUFFEL_BROKER_TLS_KEY,cert:env.JARVIS_DUFFEL_BROKER_TLS_CERT,ca:env.JARVIS_DUFFEL_BROKER_TLS_CA},
   coreTls:{key:join(root,'CLIENT_KEY'),cert:join(root,'CLIENT_CERT'),ca:env.JARVIS_DUFFEL_BROKER_TLS_CA}}));
 const profileEnv={JARVIS_DUFFEL_CONNECTION_PROFILE:profilePath};
 const sidecar=env.JARVIS_DUFFEL_BROKER_REVOCATIONS+'-wal';writeFileSync(sidecar,'');setFixturePrivateAcl(sidecar,true);
 await assert.rejects(runConfiguredDuffelCredentialBroker({env}),/FILES_INVALID/u);
 assert.equal(existsSync(env.JARVIS_DUFFEL_BROKER_REVOCATIONS),false);unlinkSync(sidecar);
 host=await runConfiguredDuffelCredentialBroker({env:profileEnv});assert.equal(host.address.address,'127.0.0.1');
 core=createConfiguredDuffelBroker({env:profileEnv});assert.equal(core.status().credentialsConfigured,true);assert.equal(core.status().providerVerified,false);
 transport=createDuffelBrokerHttpsTransport({url:`https://127.0.0.1:${host.address.port}/v1/duffel/quote`,key:readFileSync(join(root,'CLIENT_KEY')),cert:readFileSync(join(root,'CLIENT_CERT')),ca:readFileSync(join(root,'TLS_CA'))});
 // Wrong connection is rejected before any provider request. No real Duffel call.
 await assert.rejects(transport.execute({connectionId:'unrelated-account',expectedRevision:'unused',offerId:'off_never_requested'}),/CLIENT_DENIED/u);
 const profileBytes=readFileSync(profilePath),savedMetadata=JSON.parse(readFileSync(env.JARVIS_DUFFEL_BROKER_METADATA));
 writeFileSync(profilePath,JSON.stringify({...JSON.parse(profileBytes),port:Number(env.JARVIS_DUFFEL_BROKER_PORT)+1}));
 assert.equal(core.status().credentialsConfigured,false);
 await assert.rejects(core.offer('off_never_requested'),/PROFILE_CHANGED/u);
 await assert.rejects(transport.execute({connectionId:savedMetadata.connectionId,expectedRevision:savedMetadata.revision,offerId:'off_never_requested'}),/OPERATION_FAILED/u);
 writeFileSync(profilePath,profileBytes);core.close();
 const closeStarted=performance.now();
 // Keep the client alive while checking bounded, idempotent shutdown. No prior latency defect is assumed.
 await Promise.all([host.close(),host.close()]);assert.ok(performance.now()-closeStarted<2000,'broker close must remain bounded');transport.close();
 host=await runConfiguredDuffelCredentialBroker({env:profileEnv});await host.close();
 assert.deepEqual(readFileSync(env.JARVIS_DUFFEL_BROKER_VAULT),before);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),entrypoint:'configured',pki:'ephemeral evaluation only',storage:'actual Windows DPAPI',providerCalls:0,restart:true}));
});
test('actual private Windows fixture certificates are rejected by production broker, without writes or secret output',{skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-entry-'));setFixturePrivateAcl(root);
 t.after(()=>{for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);});
 const env={JARVIS_DUFFEL_BROKER_PORT:'17443',JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT:'A'.repeat(64)};
 for(const [name,pem] of [['TLS_KEY','server-key'],['TLS_CERT','server'],['TLS_CA','ca']]){
   const path=join(root,name);writeFileSync(path,readFileSync(new URL('./fixtures/google-broker-tls/'+pem+'.pem',import.meta.url)));
   env['JARVIS_DUFFEL_BROKER_'+name]=path;
 }
 for(const name of ['VAULT','METADATA','REVOCATIONS'])env['JARVIS_DUFFEL_BROKER_'+name]=join(root,name);
 await assert.rejects(runConfiguredDuffelCredentialBroker({env}),/TEST_CERT_DENIED/u);
 assert.equal(existsSync(env.JARVIS_DUFFEL_BROKER_REVOCATIONS),false);
 const child=spawnSync(process.execPath,['scripts/duffel-credential-broker.mjs'],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...env},windowsHide:true,encoding:'utf8',timeout:20000});
 assert.equal(child.status,1);assert.equal(child.stdout,'');assert.match(child.stderr,/A_DUFFEL_BROKER_TEST_CERT_DENIED/u);
 assert.doesNotMatch(child.stderr,/BEGIN PRIVATE|duffel_test_|TLS_KEY/u);assert.equal(existsSync(env.JARVIS_DUFFEL_BROKER_REVOCATIONS),false);
});
