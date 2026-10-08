import {readFileSync} from 'node:fs';
import {RemoteOperationStore} from '../../apps/pc-agent/src/remote-operation-store.js';
import {createBrowserGymEffectJournal} from '../../scripts/benchmarks/browsergym-effect-journal.mjs';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
const store=new RemoteOperationStore({path:c.path});
const journal=createBrowserGymEffectJournal({store,key:readFileSync(c.keyPath),authorize:()=>true,runStep:request=>new Promise((resolve,reject)=>{
 process.once('message',message=>{if(message.error)reject(Error(message.error));else process.exit(17);});
 process.send({request});
})});
await journal.execute(c.request,{taskId:c.taskId,authorizationHash:c.authorizationHash,assertAccess:()=>{}});
throw Error('EXPECTED_ABRUPT_EXIT_NOT_REACHED');
