// Synthetic Linux role integration. Test IPC never appears in production APIs.
import { createConfiguredCoreServiceRuntime } from '../../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../../packages/shared/src/http.js';
const vault={list:()=>[],save(){throw Error('TEST_CORE_GOOGLE_CREDENTIAL_WRITE');},withCredentials(){throw Error('TEST_CORE_GOOGLE_CREDENTIAL_READ');}};
const runtime=await createConfiguredCoreServiceRuntime({env:process.env,integrationVault:vault});
const address=await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
process.send({type:'ready',uid:process.geteuid(),pid:process.pid,address});
process.on('disconnect',async()=>{await runtime.close();process.exit(0);});
