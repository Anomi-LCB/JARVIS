import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {NativeWorkbookPdfRenderer} from '../apps/pc-agent/src/adapters/excel/native-pdf-renderer.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
import {renderNativeRecovery,taskEmptyResultMessage} from '../src/ui/task-result-guidance.js';

for(const native of [false,true])test(`Core failure receipt reaches authenticated API and product UI formatter, actualNative=${native}`,
 {skip:native&&(process.platform!=='win32'||process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'),timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-native-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inputPath=join(root,'saved.xlsx'),outputPath=join(root,'result.pdf');await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,columns:['Value'],rows:[[10]]});const original=await readFile(inputPath);
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false});t.after(()=>runtime.coreFacade.cognition.close());
 let nativeHostKilled=false;
 runtime.pcAgent.registry.get('excel.exportPdf').renderer=native?new NativeWorkbookPdfRenderer({spawnProcess(executable,args,options){
  const child=spawn(executable,args,options);let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;if(!nativeHostKilled&&/EXCEL_RENDER_OWNED_PROCESS=\d+:\d+/u.test(stdout)){nativeHostKilled=true;setImmediate(()=>child.kill('SIGKILL'));}});return child;
 }}):{async render(){throw Object.assign(Error('injected failure'),{code:'EXCEL_PDF_EXPORT_FAILED',nativeRecovery:{version:1,phase:'activation-unconfirmed',activationGapUnverified:true,cleanupConfirmed:false,autoRetryAllowed:false,executionAuthority:false,secret:'never-copy-injected-secret'}});}};
 const task=runtime.coreFacade.createTask(`"${inputPath}"를 "${outputPath}"로 변환해줘`);assert.equal(task.plan.action.toolName,'excel.exportPdf');
 const run=await runtime.orchestrationWorker.runTask(task.taskId);assert.equal(run.success,false);assert.equal(task.status,'FAILED');
 assert.ok(task.executionResult?.executionResult?.nativeRecovery,'failed B receipt must survive in the Task: '+JSON.stringify({receipt:task.executionResult,run:run.execution}));
 assert.equal(task.executionVerification,null);assert.equal(task.learningResult,null);
 if(native)assert.equal(nativeHostKilled,true);
 const server=createCoreServer(runtime.coreFacade,{adminToken:'synthetic-ui-delivery-token',adminTokens:[{token:'synthetic-wrong-scope-token',scopes:['core:worker-daemon:control']}],orchestrationWorker:runtime.orchestrationWorker});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const url=`http://127.0.0.1:${server.address().port}/tasks/${task.taskId}`;
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer synthetic-invalid-token'}})).status,401);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer synthetic-wrong-scope-token'}})).status,403);
 for(const suffix of ['','/resume','/plan-artifacts','/compensation/plan'])assert.equal((await fetch(url+suffix)).status,401);
 assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/tasks`)).status,401);
 const response=await fetch(url,{headers:{Authorization:'Bearer synthetic-ui-delivery-token'}});assert.equal(response.status,200);const detail=await response.json();
 const result=detail.executionResult?.executionResult;assert.equal(result.retryable,false);assert.equal(result.nativeRecovery.autoRetryAllowed,false);assert.equal(detail.status,'FAILED');
 const html=renderNativeRecovery(result);assert.match(html,/自动|자동 재시도 중지/);assert.doesNotMatch(taskEmptyResultMessage(result,detail),/완료된 작업/);assert.doesNotMatch(JSON.stringify(detail),/never-copy-injected-secret/);
 assert.deepEqual(await readFile(inputPath),original);await assert.rejects(stat(outputPath),{code:'ENOENT'});
 console.log(JSON.stringify({coreNativeRecoveryDelivery:{actualNative:native,taskFailed:true,authenticatedApiPreservedRecovery:true,unauthenticatedDenied:true,productFormatterHasRecovery:true,wholeBrowserRoundTrip:false,sourceUnchanged:true,pdfNotPublished:true}}));
});
