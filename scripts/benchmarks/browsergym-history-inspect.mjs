import {readFileSync} from 'node:fs';
import {inspectBrowserGymEffect} from './browsergym-effect-journal.mjs';
const [path,keyPath,indexPath]=process.argv.slice(2),key=readFileSync(keyPath),index=JSON.parse(readFileSync(indexPath,'utf8'));
const results=index.map(item=>{const result=inspectBrowserGymEffect({path,key,...item,authorize:d=>d.authorizationHash===item.authorizationHash});return {taskId:item.taskId,status:result.status,currentStateVerified:result.currentStateVerified,executionAuthority:result.executionAuthority};});
console.log(JSON.stringify({pid:process.pid,results,completedMissions:0}));
if(results.some(r=>r.status!=='historical-matched'||r.currentStateVerified||r.executionAuthority))process.exitCode=1;
