import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runNewSessionMemoryComparison} from './new-session-memory-comparison.mjs';
import {executeRememberedArtifact} from './lib/new-session-artifact-adapter.mjs';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suitePath=resolve('tests/fixtures/new-session-memory-v1.json');
const paths=['scripts/new-session-artifact-comparison.mjs','scripts/lib/new-session-artifact-adapter.mjs','scripts/new-session-memory-comparison.mjs','packages/core/src/mission/mission-runtime.js','apps/runtime-compose/src/create-runtime.js','apps/pc-agent/src/pc-agent-runtime.js','apps/verification/src/verification-runtime.js'].map(p=>resolve(p));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export async function runArtifactComparison({repeat=3}={}){
 const sources=Object.fromEntries(paths.map(p=>[p,hash(p)]));
 const report=await runNewSessionMemoryComparison({repeat,executeArtifact:executeRememberedArtifact});
 report.artifactSources=sources;report.sourceUnchanged=report.sourceUnchanged&&paths.every(p=>hash(p)===sources[p]);
 report.summary.forEach(s=>{const rows=report.rows.filter(r=>r.mode===s.mode);s.artifactMissionsCompleted=rows.filter(r=>r.execution.missionStatus==='COMPLETED').length;s.artifactMissionsBlocked=rows.filter(r=>r.execution.missionStatus==='BLOCKED').length;s.verifiedActions=rows.reduce((n,r)=>n+r.execution.verifiedActions,0);s.toolCalls=rows.reduce((n,r)=>n+r.toolCalls,0);s.executionMemoryRecallCalls=rows.reduce((n,r)=>n+r.execution.memoryRecallCalls,0);s.incorrectArtifacts=rows.filter(r=>r.incorrectSelection&&r.execution.fileExists).length;});
 report.limitations.push('실제 Core Mission→E/B 파일 생성→G JSON 형식 검증→별도 재읽기. 모델 계획 품질이나 내용 진실성의 독립 검증은 아니다.');
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),seen=new Set();let output,repeat=3;
 for(let i=0;i<args.length;i+=2){if(!['--output','--repeat'].includes(args[i])||seen.has(args[i])||!args[i+1])throw new Error('Invalid arguments');seen.add(args[i]);if(args[i]==='--output')output=args[i+1];else repeat=Number(args[i+1]);}
 if(!output)throw new Error('--output required');assertComparisonOutputPath(output,{suitePath,sourcePaths:paths,root:process.cwd()});
 const report=await runArtifactComparison({repeat});mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,sourceUnchanged:report.sourceUnchanged,summary:report.summary}));
}
