import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalLifecycleCases} from '../../packages/core/src/personal-operations/lifecycle-cases.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
const root=await mkdtemp(join(tmpdir(),'jarvis-case-browser-')),store=new PersonalOperationsStore({dbPath:join(root,'ops.sqlite')}),cases=new PersonalLifecycleCases(store);
for(let i=0;i<21;i++)cases.create({requestId:'fixture-'+i,kind:'shipment',provider:'dhl',accountRef:'synthetic',providerRef:'fixture-'+i,title:'합성 배송 '+i,dueAt:null});
const core=createCoreServer(undefined,{adminToken:'synthetic-browser-admin',personalOperations:{store}});
await new Promise(r=>core.listen(0,'127.0.0.1',r));const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/iu.test(key)));
const ui=spawn(process.execPath,['scripts/dev-server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...env,PORT:String(port),JARVIS_CORE_API_URL:`http://127.0.0.1:${core.address().port}`,JARVIS_CORE_ADMIN_TOKEN:'synthetic-browser-admin'},stdio:['ignore','pipe','ignore']});
await new Promise((resolve,reject)=>{ui.stdout.once('data',resolve);ui.once('exit',code=>reject(Error('UI exit '+code)));});
console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${port}`}));let stopped=false;
async function stop(){if(stopped)return;stopped=true;ui.kill();await new Promise(r=>core.close(r));store.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.stdin.once('data',stop);process.stdin.once('end',stop);
