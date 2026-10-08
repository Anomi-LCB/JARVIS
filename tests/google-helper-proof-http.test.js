import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {IntegrationCredentialVault,IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {IntegrationCredentialHandoffs} from '../packages/core/src/personal-operations/integration-credential-handoffs.js';
import {registerGoogleWorkspaceConnector} from '../packages/core/src/personal-operations/google-vault-client.js';
import {GoogleConnectionController} from '../packages/core/src/personal-operations/google-connection-controller.js';

for(const mode of ['verified','stored','missing'])test(`actual child exit0 and Core HTTP/Windows DPAPI outcome ${mode}`,{skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-proof-http-')),clientPath=join(root,'client.json');
 writeFileSync(clientPath,JSON.stringify({installed:{client_id:'synthetic.apps.googleusercontent.com',client_secret:'synthetic-client-secret'}}));
 const registry=registerGoogleWorkspaceConnector(new IntegrationConnectorRegistry());
 const vault=new IntegrationCredentialVault({path:join(root,'vault.dpapi.json')});
 const handoffs=new IntegrationCredentialHandoffs({registry,vault});
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env:{JARVIS_TEST_MODE:'1',JARVIS_MISSION_PLANNER:'rule'}});
 let child,activations=0;
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,
  launch:(_executable,args,options)=>{child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/google-handoff-evidence-child.mjs',import.meta.url)),args[2],mode],options);return child;}});
 const server=createCoreServer(runtime.coreFacade,{adminToken:'synthetic-admin-token',integrationRegistry:registry,integrationVault:vault,integrationHandoffs:handoffs,googleConnection:controller,
  onIntegrationHandoffCompleted:async()=>{activations++;return mode==='verified'?{status:'verified',providerVerified:true}:{status:'stored',providerVerified:false};}});
 const {port}=await listenOnFetchSafePort(server);
 t.after(async()=>{await controller.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`,headers={authorization:'Bearer synthetic-admin-token','content-type':'application/json'};
 const started=await fetch(`${base}/personal-google/connect`,{method:'POST',headers,body:JSON.stringify({clientPath})});
 assert.equal(started.status,202);assert.equal((await started.json()).status,'awaiting-consent');
 const exit=await once(child,'exit');assert.equal(exit[0],0);assert.ok(child.pid!==process.pid);
 const status=await (await fetch(`${base}/personal-google/connect`,{headers})).json();
 assert.equal(status.status,mode==='verified'?'connected':mode==='stored'?'verification-required':'failed');
 assert.equal(activations,mode==='missing'?0:1);
 if(mode==='missing'){assert.equal(vault.list().length,0);assert.equal(status.code,'A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE');}
 else{
  const recovered=new IntegrationCredentialVault({path:vault.path});assert.equal(recovered.list().length,1);
  assert.deepEqual(recovered.list()[0].grants,[]);
  assert.equal(readFileSync(vault.path,'utf8').includes('synthetic-refresh-secret'),false);
  assert.equal(await recovered.withCredentials(recovered.list()[0].connectionId,c=>c.refreshToken),'synthetic-refresh-secret');
 }
 assert.doesNotMatch(JSON.stringify(status),/synthetic-|ticket|refresh|client.json/);
 console.log(JSON.stringify({googleHelperProof:{mode,actualChildExitCode:exit[0],actualChildPid:child.pid,coreHttp:true,windowsDpapi:mode!=='missing',syntheticProvider:true,status:status.status,externalCalls:0}}));
});
