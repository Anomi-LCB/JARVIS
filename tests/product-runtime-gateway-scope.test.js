import test from 'node:test';
import assert from 'node:assert/strict';
import {selectProductRuntimeCliServices,startConnectedProductRuntime,productServiceDefinitions} from '../scripts/product-runtime.mjs';
import http from 'node:http';
import {once} from 'node:events';

const definitions=['core','pc-agent','bridge','ui'].map(id=>({id}));
const env={JARVIS_PRODUCT_RUNTIME_LOCK:'C:/synthetic/runtime.lock.json'};
test('gateway-only repairs select only the stateless proxy with a separate lock',()=>{
  const selected=selectProductRuntimeCliServices({definitions,env,argv:['--gateway-only']});
  assert.deepEqual(selected.definitions.map(item=>item.id),['bridge']);
  assert.equal(selected.scope,'gateway-only');
  assert.notEqual(selected.lockPath,selectProductRuntimeCliServices({definitions,env,argv:[]}).lockPath);
});
test('full and connection supervisors retain their existing shared lock',()=>{
  const full=selectProductRuntimeCliServices({definitions,env,argv:[]});
  const connections=selectProductRuntimeCliServices({definitions,env,argv:['--connections-only']});
  assert.deepEqual(full.definitions.map(item=>item.id),['core','pc-agent','bridge','ui']);
  assert.deepEqual(connections.definitions.map(item=>item.id),['core','pc-agent','ui']);
  assert.equal(full.lockPath,connections.lockPath);
});
test('conflicting scopes and missing gateway definitions do not fall back to another Core',()=>{
  assert.throws(()=>selectProductRuntimeCliServices({definitions,env,argv:['--gateway-only','--connections-only']}),{code:'JARVIS_PRODUCT_RUNTIME_SCOPE_CONFLICT'});
  assert.throws(()=>selectProductRuntimeCliServices({definitions:definitions.filter(item=>item.id!=='bridge'),env,argv:['--gateway-only']}),{code:'JARVIS_PRODUCT_RUNTIME_SCOPE_EMPTY'});
});

test('gateway-only starts a real proxy process and stops it without starting a broker or stopping upstream',async t=>{
  const syntheticEnv={JARVIS_CORE_ADMIN_TOKEN:'synthetic-core-token-long-enough-123456',JARVIS_PC_AGENT_API_TOKEN:'synthetic-pc-token-long-enough-123456'};
  let expected;
  const upstream=http.createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    if(request.url==='/mobile/health')response.end(JSON.stringify(expected));
    else if(request.url==='/health')response.end(JSON.stringify({sentinel:'upstream-alive'}));
    else {response.statusCode=401;response.end(JSON.stringify({error:{code:'SYNTHETIC_AUTH_REQUIRED'}}));}
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  const freePort=http.createServer();freePort.listen(0,'127.0.0.1');await once(freePort,'listening');
  const gatewayPort=freePort.address().port;await new Promise(resolve=>freePort.close(resolve));
  const defs=productServiceDefinitions({env:{...syntheticEnv,JARVIS_CORE_PORT:String(upstream.address().port),JARVIS_BRIDGE_PORT:String(gatewayPort)}});
  expected=defs.find(item=>item.id==='bridge').healthIdentity;
  const selected=selectProductRuntimeCliServices({definitions:defs,env:syntheticEnv,argv:['--gateway-only']});
  const runtime=await startConnectedProductRuntime({definitions:selected.definitions,
    env:{JARVIS_DUFFEL_CONNECTION_PROFILE:'deliberately-unavailable-profile'},
    logger:{log(){},error(){}},startupTimeoutMs:10000,probeIntervalMs:50,monitorIntervalMs:100});
  t.after(()=>runtime.stop());
  assert.deepEqual(runtime.connections(),{});
  assert.deepEqual(runtime.services().map(item=>item.id),['bridge']);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json(),expected);
  assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/tasks`)).status,401);
  await runtime.stop();
  assert.equal(upstream.listening,true);
  assert.equal((await (await fetch(`http://127.0.0.1:${upstream.address().port}/health`)).json()).sentinel,'upstream-alive');
  await assert.rejects(fetch(`http://127.0.0.1:${gatewayPort}/health`));
});
