import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {memoryItemRelevant} from '../apps/growth-memory/src/memory-relevance.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suite='tests/fixtures/memory-relevance-v1.json';
const expectedHash='56c021b5b64c2dfc0ac1bc56c3d18d59f9e3c6f16497daeda66fcb14c4dd87b3';
const files=[suite,'apps/growth-memory/src/memory-relevance.js','apps/growth-memory/src/growth-runtime.js','scripts/memory-relevance-comparison.mjs'];
const hashes=()=>files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const bytes=readFileSync(suite);if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw new Error('FIXED_ORACLE_CHANGED');
const before=hashes();
const runs=JSON.parse(bytes).cases.map(item=>{
 const memory={statement:item.statement,userId:item.metadata,revision:item.metadata};
 const started=performance.now();const oldResult=JSON.stringify(memory).includes(String(item.query).split(' ')[0]);
 const oldMs=performance.now()-started;const currentStarted=performance.now();const currentResult=memoryItemRelevant(memory,item.query,{scope:{}});
 return {caseId:item.id,holdout:item.id.startsWith('holdout-'),expected:item.expected,oldResult,currentResult,oldPassed:oldResult===item.expected,currentPassed:currentResult===item.expected,
  oldMs,currentMs:performance.now()-currentStarted};
});
const sourcesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
const report={observedAt:new Date().toISOString(),mode:'fixed-lexical-relevance-component-comparison',suiteSha256:expectedHash,sourceFiles:before,sourcesUnchanged,
 total:runs.length,oldPassed:runs.filter(r=>r.oldPassed).length,currentPassed:runs.filter(r=>r.currentPassed).length,
 holdout:{total:runs.filter(r=>r.holdout).length,oldPassed:runs.filter(r=>r.holdout&&r.oldPassed).length,currentPassed:runs.filter(r=>r.holdout&&r.currentPassed).length},runs,
 passed:sourcesUnchanged&&runs.every(r=>r.currentPassed),cost:{status:'unmeasured',amount:null},
 limits:['Lexical content relevance only,not general semantic understanding or content generation quality.','Fixed synthetic cases and separately labelled wording holdouts,not blind expert evaluation.','No external model,real account or production memory.','Single-run component durations cannot establish product p95 or performance improvement.']};
const output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
assertComparisonOutputPath(output,{suitePath:resolve(suite),sourcePaths:files.map(path=>resolve(path))});
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,total:report.total,oldPassed:report.oldPassed,currentPassed:report.currentPassed,holdout:report.holdout}));if(!report.passed)process.exitCode=1;
