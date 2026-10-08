import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {NativeWorkbookPdfRenderer} from '../apps/pc-agent/src/adapters/excel/native-pdf-renderer.js';
import {ExcelWorkbookToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'jarvis-native-pdf-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,args:{outputPath:join(root,'report.xlsx'),pdfOutputPath:join(root,'report.pdf'),renderPdf:true,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20]],charts:[{type:'bar',title:'실적',range:'A1:B3'}]}};
}
test('native PDF request fails honestly while preserving generated XLSX and undo evidence',async t=>{
 const {root,args}=await fixture(t),journal=new UndoJournal();
 const worker=new ExcelWorkbookWorker({pdfRenderer:{async render(){throw Object.assign(new Error('missing'),{code:'EXCEL_PDF_EXPORT_FAILED'});}}});
 const adapter=new ExcelWorkbookToolAdapter({allowedRoots:[root],workbookWorker:worker,undoJournal:journal});
 const result=await adapter.execute(args,{taskId:'pdf-failed'});
 assert.equal(result.status,'failed');assert.equal(result.evidence.workbook.renderValidation.reason,'EXCEL_PDF_EXPORT_FAILED');
 assert.deepEqual(result.outputPaths,[args.outputPath]);assert.equal(journal.list().length,1);await stat(args.outputPath);
 await assert.rejects(stat(args.pdfOutputPath),{code:'ENOENT'});
 const checks=await new ExecutionResultVerifier().verify({executionResult:result,evidence:{shadow:{pdfOutputPath:args.pdfOutputPath}}});
 assert.equal(checks.find(c=>c.checkId==='excel_native_pdf_export_verified').status,'failed');
});
test('invalid paths or existing PDF are rejected before writing or rendering',async t=>{
 const {root,args}=await fixture(t);let calls=0;
 const worker=new ExcelWorkbookWorker({pdfRenderer:{async render(){calls++;throw Error('unexpected');}}});
 const adapter=new ExcelWorkbookToolAdapter({allowedRoots:[root],workbookWorker:worker});
 for(const next of [{...args,renderPdf:'true'},{...args,pdfOutputPath:undefined},{...args,renderPdf:false},{...args,pdfOutputPath:join(root,'..','outside.pdf')}]) await assert.rejects(adapter.execute(next));
 await writeFile(args.pdfOutputPath,'keep-me');assert.equal((await adapter.execute(args)).status,'blocked');
 assert.equal(await readFile(args.pdfOutputPath,'utf8'),'keep-me');assert.equal(calls,0);await assert.rejects(stat(args.outputPath),{code:'ENOENT'});
});
test('a narrower signed path grant cannot publish the PDF elsewhere inside global workspace',async t=>{
 const {root,args}=await fixture(t),granted=join(root,'granted');
 const {mkdir}=await import('node:fs/promises');await mkdir(granted);
 const adapter=new ExcelWorkbookToolAdapter({allowedRoots:[root]});
 await assert.rejects(adapter.execute({...args,outputPath:join(granted,'report.xlsx')},{capabilityToken:{scope:{allowedPaths:[granted]}}}));
 await assert.rejects(stat(join(granted,'report.xlsx')),{code:'ENOENT'});await assert.rejects(stat(args.pdfOutputPath),{code:'ENOENT'});
});
test('a trusted publication fence can stop PDF output after permission changes',async t=>{
 const {root,args}=await fixture(t);let inspected=false;
 const worker=new ExcelWorkbookWorker({pdfRenderer:{async render({beforePublish}){inspected=true;await beforePublish();throw Error('unreachable');}}});
 const adapter=new ExcelWorkbookToolAdapter({allowedRoots:[root],workbookWorker:worker});
 const result=await adapter.execute(args,{}, {beforePdfPublish(){throw Object.assign(Error('revoked'),{code:'TOKEN_REVOKED'});}});
 assert.equal(inspected,true);assert.equal(result.status,'failed');assert.equal(result.evidence.workbook.renderValidation.reason,'TOKEN_REVOKED');
 await stat(args.outputPath);await assert.rejects(stat(args.pdfOutputPath),{code:'ENOENT'});
});
test('timeout and cancellation stop owned child without inventing an Excel PID',async t=>{
 const {root,args}=await fixture(t);await new ExcelWorkbookWorker().writeWorkbook({...args,renderPdf:false,pdfOutputPath:undefined});
 const source=await readFile(args.outputPath),children=[];
 const renderer=new NativeWorkbookPdfRenderer({platform:'win32',timeoutMs:80,spawnProcess(){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true});children.push(child);return child;},async cleanupProcess(){throw Error('must-not-kill-unknown-process');}});
 await assert.rejects(renderer.render({inputPath:args.outputPath,outputPath:args.pdfOutputPath,expectedSha256:hash(source)}),{code:'EXCEL_PDF_TIMEOUT'});
 const controller=new AbortController();setTimeout(()=>controller.abort(),20);
 await assert.rejects(renderer.render({inputPath:args.outputPath,outputPath:args.pdfOutputPath,expectedSha256:hash(source),signal:controller.signal}),{code:'EXCEL_PDF_CANCELLED'});
 assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));assert.equal(hash(await readFile(args.outputPath)),hash(source));
 await assert.rejects(stat(args.pdfOutputPath),{code:'ENOENT'});
});
test('abort before the renderer listener is registered still cancels the owned child',async t=>{
 const {args}=await fixture(t);await new ExcelWorkbookWorker().writeWorkbook({...args,renderPdf:false,pdfOutputPath:undefined});
 const controller=new AbortController();let child;
 const renderer=new NativeWorkbookPdfRenderer({platform:'win32',timeoutMs:1000,spawnProcess(){
  child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  controller.abort();return child;
 },async cleanupProcess(){throw Error('must-not-kill-unknown-process');}});
 await assert.rejects(renderer.render({inputPath:args.outputPath,outputPath:args.pdfOutputPath,expectedSha256:hash(await readFile(args.outputPath)),signal:controller.signal}),{code:'EXCEL_PDF_CANCELLED'});
 assert.ok(child.exitCode!==null||child.signalCode!==null);await assert.rejects(stat(args.pdfOutputPath),{code:'ENOENT'});
});

test('actual isolated Excel PDF flows through product adapter and independent G hash reread',
 {skip:process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const {root,args}=await fixture(t),journal=new UndoJournal();
 const adapter=new ExcelWorkbookToolAdapter({allowedRoots:[root],undoJournal:journal});
 const shadow=await adapter.shadow(args),result=await adapter.execute(args,{taskId:'native-pdf-live'});
 assert.equal(result.status,'success',JSON.stringify(result));assert.deepEqual(result.outputPaths,[args.outputPath,args.pdfOutputPath]);assert.equal(journal.list().length,2);
 assert.equal(result.evidence.workbook.renderValidation.actualRenderingExecuted,true);assert.equal(result.evidence.workbook.renderValidation.visualQualityVerified,false);
 const verifier=new ExecutionResultVerifier(),checks=await verifier.verify({executionResult:result,evidence:{shadow}});
 assert.equal(checks.find(c=>c.checkId==='excel_native_pdf_export_verified').status,'passed');
 const pdf=await readFile(args.pdfOutputPath);await writeFile(args.pdfOutputPath,Buffer.concat([pdf,Buffer.from('changed')]));
 const corrupt=await verifier.verify({executionResult:result,evidence:{shadow}});
 assert.equal(corrupt.find(c=>c.checkId==='excel_native_pdf_export_verified').status,'failed');
 console.log(JSON.stringify({nativePdfProductEvidence:{actualRenderingExecuted:true,productAdapter:true,gRereadPassed:true,pdfMutationRejected:true,undoFiles:2,visualQualityVerified:false,render:result.evidence.workbook.renderValidation}}));
});
