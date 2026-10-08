import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {randomBytes} from 'node:crypto';
const token=randomBytes(32).toString('hex'),server=createPcAgentServer({}, {apiGuard:new PcAgentApiGuard({apiToken:token})});
const address=await listenOnFetchSafePort(server);
try{
 const url=`http://127.0.0.1:${address.port}/diagnostics/device`;
 assert.equal((await fetch(url)).status,401);
 const reply=await fetch(url,{headers:{authorization:`Bearer ${token}`}});assert.equal(reply.status,200);
 const observation=await reply.json();assert.equal(observation.executionAuthority,false);assert.equal(observation.connection.executionReady,false);
 writeFileSync('artifacts/pc-device-observation-20261007-live.json',JSON.stringify({actualHost:true,actualHttp:true,observedAt:new Date().toISOString(),observation},null,2),{flag:'wx'});
 console.log(JSON.stringify({probeStatus:observation.probeStatus,platform:observation.os.platform,hardwareObserved:observation.hardware!==null,executionReady:false}));
}finally{await new Promise(resolve=>server.close(resolve));}
