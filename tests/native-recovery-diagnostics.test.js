import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeWorkbookPdfRenderer,nativeFailureRecovery} from '../apps/pc-agent/src/adapters/excel/native-pdf-renderer.js';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {ExcelPdfExportToolAdapter,ExcelWorkbookToolAdapter,classifyExecutionPacketOutcome} from '../apps/pc-agent/src/pc-agent-runtime.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-native-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const inputPath=join(root,'source.xlsx'),outputPath=join(root,'result.pdf');await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,columns:['Value'],rows:[[10]]});return {root,inputPath,outputPath,expectedSha256:hash(await readFile(inputPath))};}
for(const phase of ['activation-pending','owned-guarded','wrong-hash'])test(`failed native host reports bounded recovery diagnostics: ${phase}`,async t=>{
 const args=await fixture(t);let cleanupCalls=0;
 const renderer=new NativeWorkbookPdfRenderer({platform:'win32',async cleanupProcess(){cleanupCalls++;},spawnProcess(executable,argv){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  const output=argv[argv.indexOf('-OutputDirectory')+1];
  setImmediate(async()=>{await mkdir(output);await writeFile(join(output,'native-phase.json'),JSON.stringify({version:1,phase:phase==='wrong-hash'?'owned-guarded':phase,sourceSha256:phase==='wrong-hash'?'0'.repeat(64):args.expectedSha256,secret:'never-copy-raw-receipt'}));child.emit('close',1);});
  return child;
 }});
 await assert.rejects(renderer.render(args),e=>{assert.equal(e.code,'EXCEL_PDF_EXPORT_FAILED');assert.equal(e.nativeRecovery.autoRetryAllowed,false);assert.equal(e.nativeRecovery.executionAuthority,false);assert.equal(e.nativeRecovery.cleanupConfirmed,false);assert.equal(e.nativeRecovery.activationGapUnverified,phase!=='owned-guarded');assert.doesNotMatch(JSON.stringify(e.nativeRecovery),/never-copy|sourceSha|pid|path/);return true;});
 assert.equal(cleanupCalls,0,'disk receipt never grants process kill authority');await assert.rejects(stat(args.outputPath),{code:'ENOENT'});
});
test('generated workbook and existing export preserve explicit no-retry recovery status',async t=>{
 const args=await fixture(t),before=await readFile(args.inputPath);
 const failed=()=>Object.assign(Error('stop'),{code:'EXCEL_PDF_CANCELLED',nativeRecovery:{version:1,phase:'activation-unconfirmed',activationGapUnverified:true,cleanupConfirmed:false,secret:'never-expose'}});
 const renderer={async render(){throw failed();}};
 const result=await new ExcelPdfExportToolAdapter({allowedRoots:[args.root],renderer}).execute(args);
 assert.equal(result.status,'blocked');assert.equal(result.retryable,false);assert.equal(result.nativeRecovery.autoRetryAllowed,false);assert.match(result.nextAction,/자동 재시도/);assert.deepEqual(await readFile(args.inputPath),before);
 const created=await new ExcelWorkbookWorker({pdfRenderer:renderer}).writeWorkbook({outputPath:join(args.root,'generated.xlsx'),pdfOutputPath:args.outputPath,renderPdf:true,columns:['Value'],rows:[[20]]});
 assert.equal(created.renderValidation.retryable,false);assert.equal(created.renderValidation.nativeRecovery.activationGapUnverified,true);assert.match(created.renderValidation.nextAction,/자동 재시도/);assert.doesNotMatch(JSON.stringify([result,created]),/never-expose/);
 const adapterResult=await new ExcelWorkbookToolAdapter({allowedRoots:[args.root],workbookWorker:new ExcelWorkbookWorker({pdfRenderer:renderer})}).execute({outputPath:join(args.root,'adapter.xlsx'),pdfOutputPath:args.outputPath,renderPdf:true,columns:['Value'],rows:[[20]]});
 assert.equal(adapterResult.status,'failed');assert.equal(adapterResult.retryable,false);assert.equal(adapterResult.nativeRecovery.activationGapUnverified,true);assert.equal(adapterResult.changedItems.length,1);
 assert.equal(classifyExecutionPacketOutcome(adapterResult).outcome,'quarantine');assert.equal(classifyExecutionPacketOutcome(result).outcome,'terminal-blocked');
 assert.equal(nativeFailureRecovery({nativeRecovery:{version:1,phase:'forged'}}),null);
});
