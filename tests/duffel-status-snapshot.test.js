import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';
const production=new URL('../packages/core/src/personal-operations/configured-duffel-broker.js',import.meta.url);
const baseline=new URL('../artifacts/duffel-status-20261004-before.mjs',import.meta.url);
async function instrument(source){
 source=source.replace("import {readFileSync,lstatSync} from 'node:fs';","import {readFileSync as actualRead,lstatSync} from 'node:fs';let reads=0;const readFileSync=(...args)=>{reads++;return actualRead(...args);};export const observedReads=()=>reads;");
 source=source.replaceAll(/from '(\.\/[^']+)'/gu,(_,p)=>`from '${new URL(p,production).href}'`);
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
test('readiness uses one fresh metadata snapshot; previous three reads return the same fields under stable input',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-status-snapshot-'));setFixturePrivateAcl(root);
 t.after(()=>{for(const name of readdirSync(root))unlinkSync(join(root,name));rmdirSync(root);});
 const pem=n=>readFileSync(new URL('./fixtures/google-broker-tls/'+n+'.pem',import.meta.url));
 for(const [name,value] of [['key',pem('core-key')],['cert',pem('core')],['ca',pem('ca')]])writeFileSync(join(root,name),value);
 const metadata=join(root,'metadata');writeFileSync(metadata,JSON.stringify({schemaVersion:1,connectionId:'synthetic-status',revision:'revision-one'}));
 const profile=join(root,'profile');writeFileSync(profile,JSON.stringify({schemaVersion:1,port:17443,vault:join(root,'unused-vault'),metadata,revocations:join(root,'revocations'),
  serverTls:{key:join(root,'unused-server-key'),cert:join(root,'unused-server-cert'),ca:join(root,'ca')},coreTls:{key:join(root,'key'),cert:join(root,'cert'),ca:join(root,'ca')}}));
 const sources={before:readFileSync(baseline,'utf8'),after:readFileSync(production,'utf8')},observations={};
 for(const [name,source] of Object.entries(sources)){
  const module=await instrument(source),client=module.createConfiguredDuffelBroker({env:{JARVIS_DUFFEL_CONNECTION_PROFILE:profile}});t.after(()=>client.close());
  const reads=module.observedReads(),times=[],statuses=[];
  for(let i=0;i<5;i++){const start=performance.now();statuses.push(client.status());times.push(performance.now()-start);}
  observations[name]={timesMs:times,metadataReads:module.observedReads()-reads,statuses,sourceSha256:createHash('sha256').update(source).digest('hex')};
  assert.equal(observations[name].metadataReads,name==='before'?15:5);
  client.close();assert.equal(client.status().credentialsConfigured,false);
 }
 assert.deepEqual(observations.before.statuses,observations.after.statuses);
 writeFileSync(new URL('../artifacts/duffel-status-20261004-comparison.json',import.meta.url),JSON.stringify({observedAt:new Date().toISOString(),method:'controlled module copies with metadata-read counter; actual Windows private profile ACL; no network',observations,providerCalls:0,externalWrites:0,qualityScope:'stable readiness fields and closed state; general model quality not evaluated',sampleSizePerVariant:5},null,2),{flag:'wx'});
});
