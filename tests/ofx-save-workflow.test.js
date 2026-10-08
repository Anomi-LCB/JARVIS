import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOfxSaveWorkflow} from '../packages/core/src/mission/ofx-save-workflow.js';import {LocalWorkflowToolAdapter} from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
import {verifyOfxSaveResult} from '../packages/core/src/mission/ofx-save-result.js';
import {writeFile} from 'node:fs/promises';
test('fixed OFX save workflow executes through existing B staging and rejects overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ofx-save-'));try{
 const xml='<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>KRW</CURDEF><BANKACCTFROM><BANKID>test</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
 const input={xml,currencyExponents:{KRW:0},classifications:[],receipts:[],budgets:[]};const workflow=createOfxSaveWorkflow(input,{operationId:'a'.repeat(32)});const adapter=new LocalWorkflowToolAdapter({allowedRoots:[root]});
 const args={spec:workflow.spec,workspaceRoot:root,allowOverwrite:false};const result=await adapter.execute(args);assert.equal(result.status,'success',JSON.stringify(result));assert.deepEqual(JSON.parse(await readFile(join(root,workflow.inputPath),'utf8')),input);const report=await readFile(join(root,workflow.reportPath),'utf8');assert.match(report,/총 가져온 거래 0건/);
 const proof={input,operationId:'a'.repeat(32),workspaceRoot:root,workflow:result.evidence.workflow,includeReport:true};
 assert.equal(verifyOfxSaveResult(proof).reportMarkdown,report);
 for(const change of [w=>w.receipts.pop(),w=>w.receipts.push(w.receipts[0]),w=>w.specSha256='0'.repeat(64),w=>w.receipts[1].source.path=join(root,'wrong.json')]) {
  const altered=structuredClone(proof);change(altered.workflow);assert.equal(verifyOfxSaveResult(altered).passed,false);
 }
 await writeFile(join(root,workflow.reportPath),'PRIVATE_CHANGED');const rejected=verifyOfxSaveResult(proof);assert.equal(rejected.passed,false);assert.equal(JSON.stringify(rejected).includes('PRIVATE_CHANGED'),false);await writeFile(join(root,workflow.reportPath),report);
 const original=await readFile(join(root,workflow.inputPath));await writeFile(join(root,workflow.inputPath),Buffer.concat([original,Buffer.from(' ')]));assert.equal(verifyOfxSaveResult(proof).passed,false);await writeFile(join(root,workflow.inputPath),original);
 const repeat=await adapter.execute(args);assert.equal(repeat.status,'success');const conflict=createOfxSaveWorkflow({...input,budgets:[{id:'b',category:'자료',currency:'KRW',limitMinor:100}]},{operationId:'a'.repeat(32)});assert.equal((await adapter.execute({...args,spec:conflict.spec})).status,'failed');assert.equal(await readFile(join(root,workflow.reportPath),'utf8'),report);
 assert.throws(()=>createOfxSaveWorkflow(input,{operationId:'../unsafe'}));
 }finally{await rm(root,{recursive:true,force:true});}
});
