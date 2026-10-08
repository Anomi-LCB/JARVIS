import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
const [mode,root]=process.argv.slice(2),from=join(root,'source.txt'),to=join(root,'delivered.txt');
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),undoJournalPath:join(root,'undo.jsonl'),env:{},workerDaemonEnabled:false});
try{
 let result;
 if(mode==='write'){writeFileSync(from,'original');result=await runtime.pcAgent.registry.get('filesystem.moveFiles').execute({moves:[{from,to}]},{taskId:'move-pid'});}
 else{if(mode==='changed')writeFileSync(to,'user edit');result=await runtime.pcAgent.rollbackTask('move-pid');}
 console.log(JSON.stringify({pid:process.pid,status:result.status,success:result.success,source:existsSync(from)?readFileSync(from,'utf8'):null,delivered:existsSync(to)?readFileSync(to,'utf8'):null,chain:runtime.pcAgent.undoJournal.verifyChain().status}));
}finally{runtime.coreFacade.cognition.close();}
