import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';
import {attachOwnedServiceShutdown} from '../packages/shared/src/owned-service-shutdown.js';
const tick=()=>new Promise(r=>setImmediate(r));
test('service private stdin closes once on exact stop line or owner EOF',async()=>{
 for(const eof of [false,true]){const input=new PassThrough();let closed=0,code=null;const detach=attachOwnedServiceShutdown({env:{JARVIS_WINDOWS_SERVICE:'1',JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1'},input,close:()=>{closed++;},exit:c=>{code=c;}});
 input.write('stop\nJARVIS_CORE_SERVICE_STOP_V1 extra\n');await tick();assert.equal(closed,0);
 if(eof)input.end();else input.write('JARVIS_CORE_SERVICE_STOP_V1\nJARVIS_CORE_SERVICE_STOP_V1\n');await tick();assert.equal(closed,1);assert.equal(code,0);detach();}
});
test('ordinary runtime stdin and detached service stdin cannot stop Core',async()=>{
 for(const env of [{},{JARVIS_WINDOWS_SERVICE:'1'},{JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1'}]){const input=new PassThrough();let closed=0;attachOwnedServiceShutdown({env,input,close:()=>{closed++;}});input.end('JARVIS_CORE_SERVICE_STOP_V1\n');await tick();assert.equal(closed,0);}
 const input=new PassThrough();let closed=0;const detach=attachOwnedServiceShutdown({env:{JARVIS_WINDOWS_SERVICE:'1',JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1'},input,close:()=>{closed++;}});detach();input.end();await tick();assert.equal(closed,0);
});
test('failed service close exits unsuccessfully and is not retried',async()=>{
 const input=new PassThrough();let closed=0,code=null;const detach=attachOwnedServiceShutdown({env:{JARVIS_WINDOWS_SERVICE:'1',JARVIS_CORE_SERVICE_STDIN_SHUTDOWN:'1'},input,close:()=>{closed++;throw Error('failed');},exit:c=>{code=c;}});input.end('JARVIS_CORE_SERVICE_STOP_V1\n');await tick();assert.equal(closed,1);assert.equal(code,1);detach();
});
