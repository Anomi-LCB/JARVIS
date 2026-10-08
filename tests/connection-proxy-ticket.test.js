import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('managed UI proxy keeps the one-use credential ticket only on the exact completion route', async () => {
  const seen=[];
  const upstream=createServer(async(req,res)=>{
    for await(const chunk of req) { /* Drain test input. */ }
    seen.push({path:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie});
    res.setHeader('content-type','application/json');res.end('{}');
  });
  const core=await listenOnFetchSafePort(upstream);
  const reservation=createServer();const address=await listenOnFetchSafePort(reservation);
  await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['scripts/dev-server.mjs'],{
    cwd:new URL('../',import.meta.url),windowsHide:true,stdio:'ignore',
    env:{...process.env,PORT:String(address.port),HOST:'127.0.0.1',JARVIS_CORE_API_URL:`http://127.0.0.1:${core.port}`,JARVIS_CORE_ADMIN_TOKEN:'fixture-admin-token'}
  });
  const exit=once(child,'exit');
  try {
    const base=`http://127.0.0.1:${address.port}`;
    let ready=false;
    for(let i=0;i<60;i++) {
      try{if((await fetch(`${base}/health`,{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(ready,true,'isolated UI proxy must start');
    const completion='/integrations/handoffs/11111111-1111-1111-1111-111111111111/complete';
    for(const path of ['/integrations/handoffs',completion,`${completion}/unexpected`]) {
      await fetch(`${base}/api/core${path}`,{method:'POST',headers:{authorization:'Bearer fixture-single-use-ticket',cookie:'ignored=1','content-type':'application/json'},body:'{}'});
    }
    assert.deepEqual(seen.map(item=>item.authorization),['Bearer fixture-admin-token','Bearer fixture-single-use-ticket','Bearer fixture-admin-token']);
    assert.ok(seen.every(item=>item.cookie===undefined));
  } finally {child.kill();await exit;await new Promise(resolve=>upstream.close(resolve));}
});
