import {createServer} from 'node:net';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {productServiceDefinitions,startProductRuntime} from '../../scripts/product-runtime.mjs';
const root=process.argv[2];
const workspace=join(root,'workspace');mkdirSync(workspace);
const names=['CORE','PC_AGENT','BRIDGE','UI'];
for(const name of names){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env['JARVIS_'+name+'_PORT']=String(server.address().port);await new Promise(r=>server.close(r));}
Object.assign(process.env,{JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_AUDIT_ROOT:join(root,'audit/core'),JARVIS_AUDIT_ROOT:join(root,'audit/pc'),JARVIS_TRUST_ROOT:join(root,'trust'),JARVIS_ALLOWED_ROOTS:workspace,
 JARVIS_BRIDGE_STATE_DIR:join(root,'bridge'),JARVIS_BRIDGE_REAL_EXECUTION:'0',JARVIS_BRIDGE_OPEN_OUTPUTS:'0',JARVIS_BROWSER_DRIVER:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',
 JARVIS_UNDO_JOURNAL:join(root,'audit/undo.jsonl'),JARVIS_ROLLBACK_TRANSACTIONS:join(root,'audit/rollback.jsonl'),JARVIS_PACKET_JOURNAL:join(root,'audit/packets.jsonl'),JARVIS_PACKET_QUEUE:join(root,'audit/queue.json'),JARVIS_TOKEN_VAULT:join(root,'audit/vault.json')});
const runtime=await startProductRuntime({definitions:productServiceDefinitions(),logger:{log(){},warn(){},error(){}},startupTimeoutMs:30000});
console.log(JSON.stringify({status:'ready',url:runtime.uiUrl,services:runtime.services().map(s=>({id:s.id,status:s.status}))}));
let closing=false;async function stop(){if(closing)return;closing=true;await runtime.stop();process.exit(0);}
process.stdin.on('data',()=>void stop());process.stdin.once('end',stop);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
