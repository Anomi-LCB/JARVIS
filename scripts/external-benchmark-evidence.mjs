import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const tasks=['click-test','click-button','enter-text'];
const seeds=[17,43,89];
const drivers=['scripted-positive-control','scripted-negative-control'];
const fail=code=>{throw new Error(code);};
/** Qualifies environment controls only. Scripted oracle controls cannot become
 * a JARVIS completion rate, model score, or leaderboard submission. */
export function qualifyBrowserGymControls(report){
 if(report?.schemaVersion!=='external-benchmark-controls-v1'||report.benchmark!=='BrowserGym/MiniWoB'
  ||report.taskCommit!=='7fd85d71a4b60325c6585396ec4f48377d049838'
  ||report.versions?.['browsergym-core']!=='0.14.3'||report.versions?.['browsergym-miniwob']!=='0.14.3'
  ||report.versions?.playwright!=='1.44.0'||typeof report.python!=='string'||typeof report.os!=='string'
  ||![report.chromeSha256,report.runnerSha256].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s))
  ||report.plannedSlots!==18||report.rows?.length!==18)fail('BENCHMARK_MANIFEST_INVALID');
 if(report.jarvisPerformance!==null||report.officialLeaderboardScore!==null||report.realLifeCompletionRate!==null)fail('CONTROL_SCORE_MISATTRIBUTED');
 const planned=new Set(tasks.flatMap(task=>seeds.flatMap(seed=>drivers.map(driver=>JSON.stringify([task,seed,driver])))));
 const counts=Object.fromEntries(drivers.map(driver=>[driver,{planned:9,completed:0,failed:0,blocked:0,errors:0}]));
 for(const row of report.rows){
  const key=JSON.stringify([row.taskId,row.seed,row.driver]);
  if(!planned.delete(key)||!['completed','failed','blocked'].includes(row.status)||row.jarvisAgentExecuted!==false
   ||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||!Array.isArray(row.actions)
   ||typeof row.terminated!=='boolean'||typeof row.truncated!=='boolean'
   ||!(row.actualCost===null||typeof row.actualCost==='number'&&Number.isFinite(row.actualCost)&&row.actualCost>=0)
   ||!(row.reward===null||typeof row.reward==='number'&&Number.isFinite(row.reward)))fail('BENCHMARK_ROW_INVALID');
  if(row.status==='completed'&&(row.reward!==1||!row.terminated||row.truncated||row.error!==null||row.actions.length===0))fail('BENCHMARK_COMPLETION_UNPROVEN');
  counts[row.driver][row.status]++;if(row.error!==null)counts[row.driver].errors++;
 }
 if(planned.size)fail('BENCHMARK_SLOTS_MISSING');
 return {schemaVersion:'external-benchmark-qualification-v1',benchmark:report.benchmark,
  evidenceDigest:createHash('sha256').update(JSON.stringify(report)).digest('hex'),counts,
  environmentControlsPassed:counts[drivers[0]].completed===9&&counts[drivers[1]].failed===9
   &&Object.values(counts).every(c=>c.errors===0),
  jarvisPerformance:null,officialLeaderboardScore:null,realLifeCompletionRate:null,
  cost:Object.values(report.rows).every(r=>r.actualCost!==null)?report.rows.reduce((a,r)=>a+r.actualCost,0):null,
  limitation:'Scripted environment controls only; no JARVIS agent evaluation or full-suite performance claim.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,output]=process.argv.slice(2);if(!input||!output)fail('INPUT_AND_EXCLUSIVE_OUTPUT_REQUIRED');
 const result=qualifyBrowserGymControls(JSON.parse(await readFile(input,'utf8')));
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}
