import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {X509Certificate} from 'node:crypto';
import {resolveDuffelConnectionEnvironment,assertDuffelProfileUnchanged} from '../packages/core/src/personal-operations/duffel-connection-profile.js';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';

test('absent profile preserves existing explicit configuration; unsupported role and relative profile fail',()=>{
 const env={JARVIS_CORE_DUFFEL_BROKER_URL:'existing-explicit'};
 assert.deepEqual(resolveDuffelConnectionEnvironment({env,role:'core'}),env);
 assert.throws(()=>resolveDuffelConnectionEnvironment({role:'admin'}),/ROLE_INVALID/u);
 assert.throws(()=>resolveDuffelConnectionEnvironment({env:{JARVIS_DUFFEL_CONNECTION_PROFILE:'relative'},role:'core'}),/PROFILE_INVALID/u);
});
test('protected profile supplies consistent independent Core/broker projections and rejects authority/path/ACL changes',{skip:process.platform!=='win32'},t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-profile-'));setFixturePrivateAcl(root);
 t.after(()=>{for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);});
 const path=join(root,'profile.json'),client=join(root,'client-cert');
 writeFileSync(client,readFileSync(new URL('./fixtures/google-broker-tls/core.pem',import.meta.url)));
 const p={schemaVersion:1,port:17443,vault:join(root,'vault'),metadata:join(root,'metadata'),revocations:join(root,'revocations'),
  serverTls:{key:join(root,'server-key'),cert:join(root,'server-cert'),ca:join(root,'ca')},coreTls:{key:join(root,'client-key'),cert:client,ca:join(root,'ca')}};
 const env={JARVIS_DUFFEL_CONNECTION_PROFILE:path};
 const save=value=>writeFileSync(path,JSON.stringify(value));save(p);
 const core=resolveDuffelConnectionEnvironment({env:{...env,JARVIS_DUFFEL_BROKER_VAULT:'must-not-propagate'},role:'core'});
 const broker=resolveDuffelConnectionEnvironment({env:{...env,JARVIS_CORE_DUFFEL_BROKER_TLS_KEY:'must-not-propagate'},role:'broker'});
 assert.equal(core.JARVIS_CORE_DUFFEL_BROKER_URL,'https://127.0.0.1:17443/v1/duffel/quote');
 assert.equal(core.JARVIS_CORE_DUFFEL_BROKER_METADATA,broker.JARVIS_DUFFEL_BROKER_METADATA);
 assert.equal(core.JARVIS_DUFFEL_BROKER_VAULT,undefined);assert.equal(broker.JARVIS_CORE_DUFFEL_BROKER_TLS_KEY,undefined);
 assert.equal(broker.JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT,new X509Certificate(readFileSync(client)).fingerprint256);
 assertDuffelProfileUnchanged(core);save({...p,port:17444});assert.throws(()=>assertDuffelProfileUnchanged(core),/PROFILE_CHANGED/u);save(p);
 assert.throws(()=>resolveDuffelConnectionEnvironment({env:{...env,JARVIS_CORE_DUFFEL_BROKER_URL:'http://wrong'},role:'core'}),/CONFIG_CONFLICT/u);
 for(const value of [{...p,apiKey:'never-accept'},{...p,port:80},{...p,vault:join(root,'nested','..','client-key')},
  {...p,coreTls:{...p.coreTls,ca:join(root,'other-ca')}},{...p,metadata:p.vault}]){
  save(value);assert.throws(()=>resolveDuffelConnectionEnvironment({env,role:'core'}),/PROFILE_INVALID/u);
 }
 save(p);setFixturePrivateAcl(path,true);
 assert.throws(()=>assertDuffelProfileUnchanged(core),/PROFILE_CHANGED/u);
 assert.throws(()=>resolveDuffelConnectionEnvironment({env,role:'core'}),/PROFILE_INVALID/u);
});
