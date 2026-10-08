import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate,randomBytes} from 'node:crypto';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {startPcOutboundNodeService} from '../packages/core/src/client/pc-outbound-service.js';
import {createPcOutboundTransport} from '../packages/core/src/client/pc-outbound-https.js';
import {createPcOutboundObserver} from '../apps/pc-agent/src/outbound-observer.js';
import {observePcDevice} from '../apps/pc-agent/src/device-observation.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const root=mkdtempSync(join(tmpdir(),'jarvis-live-pc-node-device-')),token=randomBytes(32).toString('hex');
const pem=name=>readFileSync(new URL(`../tests/fixtures/google-broker-tls/${name}.pem`,import.meta.url));
let service,server,transport;
try{
 service=await startPcOutboundNodeService({dbPath:join(root,'observations.sqlite'),authorityGuard:()=>({token:1}),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca')}});
 server=createCoreServer({}, {adminToken:token,pcOutboundNodes:service.controller});await listenOnFetchSafePort(server);
 const api=(path,method='GET',body,authorized=true)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{...(authorized?{authorization:`Bearer ${token}`} :{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await api('/pc-nodes','GET',undefined,false)).status,401);
 assert.equal((await api('/pc-nodes','POST',{deviceId:'isolated-current-pc',certificateFingerprint:new X509Certificate(pem('core')).fingerprint256,expiresAt:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/u,'Z'),expectedGeneration:0,allowedTaskIds:[]})).status,201);
 assert.equal((await api('/pc-nodes/isolated-current-pc/observations','POST',{requestId:'actual-device',operation:'device-observation',taskId:null})).status,202);
 transport=createPcOutboundTransport({url:`https://127.0.0.1:${service.address.port}/v1/pc/observe`,key:pem('core-key'),cert:pem('core'),ca:pem('ca')});
 await createPcOutboundObserver({transport,pcClient:{health:async()=>({})},deviceReader:observePcDevice}).tick();
 const result=await (await api('/pc-nodes/observations/actual-device')).json();
 assert.equal(result.observationCurrent,true);assert.equal(result.observation.value.probeStatus,'observed');assert.equal(result.observation.value.os.platform,'win32');assert.ok(result.observation.value.hardware.model);
 assert.equal(result.executionAuthority,false);assert.equal(result.observation.value.hardwareAttested,false);
 assert.equal((await api('/pc-nodes/isolated-current-pc/revoke','POST',{expectedGeneration:1})).status,200);
 const historical=await (await api('/pc-nodes/observations/actual-device')).json();assert.equal(historical.observationCurrent,false);assert.deepEqual(historical.observation,result.observation);
 writeFileSync('artifacts/pc-node-device-20261007-live.json',JSON.stringify({observedAt:new Date().toISOString(),actualWindowsCim:true,actualCoreHttp:true,actualMutualTls:true,isolatedTestCertificates:true,productionServiceChanged:false,result,afterRevocationCurrent:historical.observationCurrent},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({actualWindowsCim:true,actualCoreHttp:true,actualMutualTls:true,afterRevocationCurrent:false,executionAuthority:false}));
}finally{
 transport?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await service?.close();rmSync(root,{recursive:true,force:true});
}
