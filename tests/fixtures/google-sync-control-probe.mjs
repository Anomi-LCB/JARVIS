import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
import {GoogleInboxSync} from '../../packages/core/src/personal-operations/google-sync.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';

const store=new PersonalOperationsStore({dbPath:process.argv[2]}),inbox=new PersonalSourceInbox(store);
let calls=0;const client={configured:()=>true,connectionRequirements:()=>({requiredScopes:['gmail.readonly','calendar.readonly']}),account:async()=>{calls++;return 'isolated@example.test';},page:async()=>{calls++;return {items:[],nextCursor:null};}};
const sync=new GoogleInboxSync({inbox,client,intervalMs:10});
const server=createCoreServer(undefined,{adminToken:'isolated-restart-control-admin',personalInbox:inbox,googleSync:sync});
try{
 sync.start();await sync.run();const a=await listenOnFetchSafePort(server),url=`http://127.0.0.1:${a.port}/personal-inbox`;
 const unauthenticated=(await fetch(url)).status;
 const response=await fetch(url,{headers:{authorization:'Bearer isolated-restart-control-admin'}});
 const body=await response.json();
 console.log(JSON.stringify({pid:process.pid,unauthenticated,httpStatus:response.status,body,calls,itemCount:inbox.list().length,syntheticProvider:true,externalCalls:0}));
}finally{await sync.stop();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}
