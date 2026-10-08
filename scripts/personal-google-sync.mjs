import { homedir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { GoogleReadClient } from '../packages/core/src/personal-operations/google-client.js';
import { createManagedGoogleSync } from '../packages/core/src/personal-operations/google-sync-service.js';
import { loadGoogleCredentials } from '../packages/core/src/personal-operations/google-credentials.js';
let store;
try {
  const command=process.argv[2]??'status';if(!['status','sync'].includes(command)||process.argv.length>3)throw new Error('Use: node scripts/personal-google-sync.mjs <status|sync>');
  const client=new GoogleReadClient({credentials:loadGoogleCredentials(process.env)});
  if(command==='status'||!client.configured())console.log(JSON.stringify({configured:client.configured(),status:client.configured()?'configured-not-verified':'connection-required',requiredSettings:['JARVIS_GOOGLE_CLIENT_ID','JARVIS_GOOGLE_CLIENT_SECRET','JARVIS_GOOGLE_REFRESH_TOKEN']}));
  else {
    store=new PersonalOperationsStore({dbPath:process.env.JARVIS_PERSONAL_OPERATIONS_DB??join(homedir(),'.jarvis','personal-operations.sqlite')});
    const sync=createManagedGoogleSync({store,client});const result=await sync.run();console.log(JSON.stringify(result,null,2));if(['error','degraded'].includes(result.status))process.exitCode=1;
  }
}catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
