import {readFileSync} from 'node:fs';
import {createConfiguredDuffelBroker} from '../../packages/core/src/personal-operations/configured-duffel-broker.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
const broker=createConfiguredDuffelBroker({env:JSON.parse(readFileSync(process.argv[2],'utf8')),clock:()=>new Date('2026-10-03T00:00:00Z')});
const core=createCoreServer(undefined,{adminToken:'synthetic-hold-admin',duffelBroker:broker});
await new Promise(r=>core.listen(0,'127.0.0.1',r));
process.send({pid:process.pid,port:core.address().port});
process.on('disconnect',async()=>{core.closeAllConnections();await new Promise(r=>core.close(r));broker.close();process.exit(0);});
