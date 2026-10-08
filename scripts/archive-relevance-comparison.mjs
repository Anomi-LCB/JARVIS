import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {GrowthRuntime} from '../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../apps/growth-memory/src/db/sqlite-store.js';
import {selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';
import {normalizeMemoryScope} from '../apps/growth-memory/src/memory-provenance.js';
import {assertComparisonOutputPath} from './recovery-comparison.mjs';
const suite='tests/fixtures/archive-relevance-v1.json',fixedHash='099624b577476d9ede51c919486e79891331bb4585eaa1a71636dba8ac967f2f';
const files=[suite,'apps/growth-memory/src/selected-conversation-archive.js','apps/growth-memory/src/memory-relevance.js','scripts/archive-relevance-comparison.mjs'];
const hashes=()=>files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
const before=hashes(),bytes=readFileSync(suite);if(createHash('sha256').update(bytes).digest('hex')!==fixedHash)throw new Error('FIXED_ORACLE_CHANGED');
const output=process.argv[2];if(!output)throw new Error('OUTPUT_REQUIRED');
assertComparisonOutputPath(output,{suitePath:resolve(suite),sourcePaths:files.map(resolvePath=>resolve(resolvePath))});
const root=mkdtempSync(join(tmpdir(),'jarvis-archive-comparison-')),store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const runs=[];
try {
 const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
 for(const c of JSON.parse(bytes).cases){
  const scope={userId:`synthetic-${c.id}`,workspaceRoot:root,conversationId:null}, document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[{id:'chosen',messages:[{id:'m',speaker:'user',text:c.text,spokenAt:'2026-10-03T00:00:00Z'}]}]};
  growth.importSelectedConversations({document,scope,selectedConversationIds:['chosen'],expectedDocumentHash:selectedConversationDocumentHash(document),sourceRef:'synthetic-snapshot'},{commit:true});
  const started=performance.now();
  const old=store.db.prepare('SELECT * FROM selected_conversation_messages WHERE scope_key=? AND withdrawn=0 AND instr(text,?)>0 ORDER BY spoken_at DESC,id LIMIT 5').all(JSON.stringify(normalizeMemoryScope(scope)),c.query.trim().split(/\s+/u)[0].slice(0,100));
  const oldMs=performance.now()-started,currentStarted=performance.now(),current=growth.selectedConversationImports.query(c.query,{scope});
  runs.push({caseId:c.id,holdout:c.id.startsWith('holdout-'),expected:c.expected,oldFound:old.length>0,currentFound:current.length>0,oldPassed:(old.length>0)===c.expected,currentPassed:(current.length>0)===c.expected,oldMs,currentMs:performance.now()-currentStarted,
   sourceSliceValid:current.every(item=>item.text===c.text.slice(item.sourceTextStart,item.sourceTextEnd)&&item.provenance.executionAuthority===false)});
 }
}finally{store.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('TEMP_ROOT_INVALID');rmSync(root,{recursive:true,force:true});}
const sourcesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
const report={observedAt:new Date().toISOString(),mode:'fixed-actual-sqlite-archive-lexical-comparison',suiteSha256:fixedHash,sourceFiles:before,sourcesUnchanged,total:runs.length,oldPassed:runs.filter(r=>r.oldPassed).length,currentPassed:runs.filter(r=>r.currentPassed).length,
 holdout:{total:runs.filter(r=>r.holdout).length,oldPassed:runs.filter(r=>r.holdout&&r.oldPassed).length,currentPassed:runs.filter(r=>r.holdout&&r.currentPassed).length},runs,
 passed:sourcesUnchanged&&runs.every(r=>r.currentPassed&&r.sourceSliceValid),cost:{status:'unmeasured',amount:null},
 limits:['Fixed synthetic lexical cases and labelled holdouts,not blind semantic expert evaluation.','Single-run lookup timings,not whole product p95 or a speed improvement claim.','No real accounts,external model or production DB.','Automatic recall stays bounded at five archival quotes;worst-case scoped archive scanning is linear.']};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,total:report.total,oldPassed:report.oldPassed,currentPassed:report.currentPassed,holdout:report.holdout}));if(!report.passed)process.exitCode=1;
