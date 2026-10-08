import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {PcAgentExecutionClient} from '../packages/core/src/client/pc-agent-execution-client.js';
import {CapabilityTokenService} from '../apps/policy-security/src/policy-runtime.js';
import {ActionType} from '../packages/shared/src/types.js';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
test('installed PC source starts from separate empty state directory, authenticates and executes a signed local packet',{timeout:process.env.JARVIS_NATIVE_EXCEL_TEST==='1'?90000:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-pc-standalone-')),packageDir=join(root,'package'),state=join(root,'state'),workspace=join(state,'workspace');let child;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await rm(root,{recursive:true,force:true});});
 await mkdir(workspace,{recursive:true});
 const packagePlan=await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageDir,pcAgentStateRoot:state});
 for(const relativePath of ['scripts/hwpx-mcp-smoke.py','config/hwpx-mcp-policy.json',...['hwpx-mcp-create.py','hwpx-content-verifier.py','native-pdf.ps1','native-process-guard.cs','raster-pdf.py','inspect-owned-dialog.ps1'].map(name=>'apps/pc-agent/src/adapters/hwpx/'+name)]){
  assert.deepEqual(await readFile(join(packageDir,'pc-agent-runtime',relativePath)),await readFile(fileURLToPath(new URL('../'+relativePath,import.meta.url))));
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/'+relativePath]);
 }
 const packagedOffice=pathToFileURL(join(packageDir,'pc-agent-runtime/apps/verification/src/office-document-render-verifier.js')).href;
 const officeFixture=fileURLToPath(new URL('../artifacts/office-current-render-20261007/docx-pilot.json',import.meta.url));
 const packagedProof=await promisify(execFile)(process.execPath,['--input-type=module','-e',`
  const {readFile}=await import('node:fs/promises');const {dirname}=await import('node:path');
  const {verifyOfficeDocumentRenderingCurrent}=await import(${JSON.stringify(packagedOffice)});
  const fixture=JSON.parse(await readFile(${JSON.stringify(officeFixture)},'utf8'));
  const proof=await verifyOfficeDocumentRenderingCurrent({executionResult:fixture.result,allowedRoots:[dirname(fixture.result.targetPath)]});
  if(!proof.passed)throw Error(JSON.stringify(proof));console.log(JSON.stringify(proof));
 `],{cwd:state,windowsHide:true,timeout:30000,maxBuffer:65536});
 assert.match(packagedProof.stdout,/"savedStructureVerified":true/);
 assert.equal(packagePlan.manifest.runtimeState.mode,'explicit');
 for(const file of ['native-pdf.ps1','native-process-guard.cs']){
  const relativePath='apps/pc-agent/src/adapters/excel/'+file;
  assert.deepEqual(await readFile(join(packageDir,'pc-agent-runtime',relativePath)),await readFile(fileURLToPath(new URL('../'+relativePath,import.meta.url))));
 }
 assert.match(await readFile(join(packageDir,'service-host.cs'),'utf8'),/Path.Combine\(packageRoot,"pc-agent-runtime","launch.mjs"\)/);
 const graph=await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./fixtures/package-source-graph.mjs',import.meta.url)),join(packageDir,'pc-agent-runtime')],{windowsHide:true,maxBuffer:1024*1024});
 const closure=JSON.parse(graph.stdout);assert.ok(closure.modules>200);assert.deepEqual(closure.missing,[]);
 for(const name of ['create_cards.py','verify_card_pixels.py','runtime-requirements.json']){
  const relativePath='apps/pc-agent/src/adapters/visual/'+name;
  assert.deepEqual(await readFile(join(packageDir,'pc-agent-runtime',relativePath)),await readFile(fileURLToPath(new URL('../'+relativePath,import.meta.url))));
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/'+relativePath]);
 }
 for(const name of ['native-create.ps1','native-process-guard.cs','verify_presentation.py']){
  const relativePath='apps/pc-agent/src/adapters/powerpoint/'+name;
  assert.deepEqual(await readFile(join(packageDir,'pc-agent-runtime',relativePath)),await readFile(fileURLToPath(new URL('../'+relativePath,import.meta.url))));
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/'+relativePath]);
 }
 for(const name of ['native-create.ps1','native-process-guard.cs','verify_tables.py']){
  const relativePath='apps/pc-agent/src/adapters/word/'+name;
  assert.deepEqual(await readFile(join(packageDir,'pc-agent-runtime',relativePath)),await readFile(fileURLToPath(new URL('../'+relativePath,import.meta.url))));
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/'+relativePath]);
 }
 const packagedCards=pathToFileURL(join(packageDir,'pc-agent-runtime/apps/pc-agent/src/pc-agent-runtime.js')).href;
 if(process.platform==='win32'){
 const cardRun=await promisify(execFile)(process.execPath,['--input-type=module','-e',`
  const {VisualCreateCardsToolAdapter,UndoJournal}=await import(${JSON.stringify(packagedCards)});
  const root=${JSON.stringify(workspace)};
  const result=await new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:root+'/card-undo.jsonl'})}).execute({outputDirectory:root,cards:[{title:'설치 패키지 검증',body:['전체 문구 확인'],fileName:'packaged-card.png'}]},{taskId:'packaged-card'});
  if(result.status!=='success'||result.cards[0].pixelVerification.status!=='verified')throw Error(JSON.stringify(result));
  console.log(JSON.stringify({packagedCard:result.cards[0],pythonDependencies:'host-provided-not-bundled'}));
 `],{cwd:state,windowsHide:true,maxBuffer:1024*1024});
 assert.match(cardRun.stdout,/literal-truetype-glyph-pixels/);
 }
 const packagedOfx=pathToFileURL(join(packageDir,'pc-agent-runtime/packages/shared/src/ofx-bank-statement-import.js')).href;
 const xmlImport=await promisify(execFile)(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(packagedOfx)});if(m.parseOfxAmountMinor('1,25',2)!==125)throw Error('PACKAGED_OFX_AMOUNT_INVALID');console.log('packaged XML dependencies resolved');`],{cwd:state,windowsHide:true});
 assert.match(xmlImport.stdout,/packaged XML dependencies resolved/);
 const secret='isolated-standalone-capability-secret-with-entropy';
 child=spawn(process.execPath,[join(packageDir,'pc-agent-runtime/launch.mjs')],{cwd:state,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,PORT:'0',JARVIS_PC_AGENT_STATE_ROOT:state,JARVIS_PC_AGENT_API_TOKEN:'isolated-standalone-admin',JARVIS_PC_AGENT_EXECUTION_TOKEN:'isolated-standalone-executor',JARVIS_CAPABILITY_TOKEN_SECRET:secret,JARVIS_QUEUE_DRAIN_ENABLED:'0',JARVIS_WORKER_DAEMON_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 const base=await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('Standalone readiness timeout:'+errors)),15000);child.stderr.on('data',d=>{errors+=d;});child.stdout.on('data',d=>{output+=d;const match=output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Standalone startup exit '+code+':'+errors));});});
 const health=await fetch(base+'/health').then(r=>r.json());assert.equal(health.module,'B_PC_AGENT');
 const emailStatus=await fetch(base+'/email/connection',{headers:{authorization:'Bearer isolated-standalone-admin'}});
 assert.equal(emailStatus.status,200);const emailReadiness=await emailStatus.json();assert.equal(emailReadiness.configured,false);assert.equal(emailReadiness.available,false);
 assert.equal((await fetch(base+'/email/connection',{headers:{authorization:'Bearer isolated-standalone-executor'}})).status,401);
 const client=new PcAgentExecutionClient({baseUrl:base,executionToken:'isolated-standalone-executor'});
 const taskId='standalone-pc-file',action={actionType:ActionType.CREATE_FILE,toolName:'filesystem.createTextFile',arguments:{path:join(workspace,'result.txt'),content:'Installed PC runtime verified without source repository'}};
 const issuer=new CapabilityTokenService({signingSecret:secret});
 const pdfPath=join(workspace,'known-report.pdf');
 await writeFile(pdfPath,await readFile(fileURLToPath(new URL('../artifacts/workbook-native-pdf-20261003-mission-fenced/report.pdf',import.meta.url))));
 const pdfAction={actionType:ActionType.SEARCH_FILES,toolName:'document.readPdf',arguments:{path:pdfPath,firstPage:1,maxPages:10}};
 const pdfToken=issuer.issue({taskId:'standalone-pdf-read',planId:'pdf-read-plan',approvalId:'pdf-read-approval',action:pdfAction,allowedPaths:[workspace]});
 const pdfPacket={packetId:'standalone-pdf-read-packet',taskId:'standalone-pdf-read',planId:'pdf-read-plan',action:pdfAction,capabilityToken:pdfToken,requestedMode:'execute',userConfirmation:{approvalId:'pdf-read-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const pdfResult=await client.receiveExecutionPacket(pdfPacket);assert.equal(pdfResult.status,'COMPLETED',JSON.stringify(pdfResult));
 assert.equal(pdfResult.executionResult.pdfRead.parserVersion,'6.19.0');assert.match(pdfResult.executionResult.stdoutPreview,/매출/);
 for(const name of ['src/adapters/pdf/extract-text.py','vendor/pypdf/pypdf-6.19.0-py3-none-any.whl'])assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/apps/pc-agent/'+name]);
 assert.equal((await client.receiveExecutionPacket(pdfPacket)).status,'COMPLETED');
 console.log(JSON.stringify({standalonePdfReadEvidence:{signedPacketCompleted:true,vendoredParserVersion:'6.19.0',noRepositoryRuntime:true,productionTestModeFlagAbsent:true,koreanTextObserved:true,duplicateReadCompleted:true,ocrPerformed:false}}));
 const capabilityToken=issuer.issue({taskId,planId:'standalone-plan',approvalId:'standalone-approval',action,allowedPaths:[workspace]});
 const packet={packetId:'standalone-packet',taskId,planId:'standalone-plan',action,capabilityToken,requestedMode:'execute',userConfirmation:{approvalId:'standalone-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const result=await client.receiveExecutionPacket(packet);assert.equal(result.status,'COMPLETED');assert.equal(await readFile(action.arguments.path,'utf8'),action.arguments.content);
 const receipt=await client.taskResult(taskId);assert.equal(receipt.status,'COMPLETED');
 const beforeRepeat=await stat(action.arguments.path);
 const chartAction={actionType:ActionType.CREATE_FILE,toolName:'excel.createWorkbook',arguments:{outputPath:join(workspace,'chart.xlsx'),sheetName:'실적',columns:['제외','월','매출','이익'],rows:[['x','1월',100,10],['y','2월',120,-5],['z','3월',90,12]],charts:[{type:'bar',range:'B1:D3'}]}};
 if(process.env.JARVIS_NATIVE_EXCEL_TEST==='1') {chartAction.arguments.renderPdf=true;chartAction.arguments.pdfOutputPath=join(workspace,'chart.pdf');}
 const chartToken=issuer.issue({taskId:'standalone-chart',planId:'chart-plan',approvalId:'chart-approval',action:chartAction,allowedPaths:[workspace]});
 const chartPacket={packetId:'standalone-chart-packet',taskId:'standalone-chart',planId:'chart-plan',action:chartAction,capabilityToken:chartToken,requestedMode:'execute',userConfirmation:{approvalId:'chart-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const chartResult=await client.receiveExecutionPacket(chartPacket);assert.equal(chartResult.status,'COMPLETED',JSON.stringify(chartResult));
 if(chartAction.arguments.renderPdf) {
  const render=chartResult.executionResult.evidence.workbook.renderValidation;
  assert.equal(render.status,'passed');assert.equal(render.actualRenderingExecuted,true);assert.equal(render.visualQualityVerified,false);
  assert.equal((await readFile(chartAction.arguments.pdfOutputPath)).subarray(0,5).toString(),'%PDF-');
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/apps/pc-agent/src/adapters/excel/native-pdf.ps1']);
  assert.ok(packagePlan.manifest.fileIntegrity['pc-agent-runtime/apps/pc-agent/src/adapters/excel/native-process-guard.cs']);
  assert.equal(render.processGuard.jobAssigned,true);assert.equal(render.processGuard.parentWatchEnabled,true);
  console.log(JSON.stringify({standaloneNativePdfEvidence:{packagedFixedScript:true,noRepositoryRuntime:true,actualRenderingExecuted:true,pdfExists:true,render}}));
 }
 const chartObserved=JSON.parse((await promisify(execFile)('python',[fileURLToPath(new URL('./fixtures/inspect-workbook-chart.py',import.meta.url)),chartAction.arguments.outputPath],{windowsHide:true})).stdout);
 assert.deepEqual(chartObserved.charts[0].series.map(s=>s.values),[[100,120],[10,-5]]);assert.deepEqual(chartObserved.charts[0].series.map(s=>s.numericCache),[[100,120],[10,-5]]);
 const packagedVerifier=pathToFileURL(join(packageDir,'pc-agent-runtime/packages/core/src/mission/criteria-evidence.js')).href;
 const cellSpec={version:1,kind:'xlsx.cells',path:'chart.xlsx',sheetName:'실적',equals:{B2:'1월',C2:100,D2:10,C3:120,D3:-5}};
 const cellCheck=JSON.parse((await promisify(execFile)(process.execPath,['--input-type=module','-e',"import{readFileSync}from'node:fs';const{compareTypedCriterionContent}=await import(process.argv[1]);console.log(JSON.stringify(compareTypedCriterionContent({spec:JSON.parse(process.argv[3]),bytes:readFileSync(process.argv[2])})));",packagedVerifier,chartAction.arguments.outputPath,JSON.stringify(cellSpec)],{cwd:state,windowsHide:true})).stdout);
 assert.equal(cellCheck.status,'passed');assert.equal(cellCheck.checks[0].checkedCellCount,5);assert.equal(cellCheck.checks[0].actualRenderingVerified,false);
 const chartSpec={version:1,kind:'xlsx.charts',path:'chart.xlsx',sheetName:'실적',equals:[{type:'bar',title:'Chart 1',series:[
  {name:'매출',categoryFormula:"'실적'!$B$2:$B$3",valueFormula:"'실적'!$C$2:$C$3",categories:['1월','2월'],values:[100,120]},
  {name:'이익',categoryFormula:"'실적'!$B$2:$B$3",valueFormula:"'실적'!$D$2:$D$3",categories:['1월','2월'],values:[10,-5]}
 ]}]};
 const chartCheck=JSON.parse((await promisify(execFile)(process.execPath,['--input-type=module','-e',"import{readFileSync}from'node:fs';const{compareTypedCriterionContent}=await import(process.argv[1]);console.log(JSON.stringify(compareTypedCriterionContent({spec:JSON.parse(process.argv[3]),bytes:readFileSync(process.argv[2])})));",packagedVerifier,chartAction.arguments.outputPath,JSON.stringify(chartSpec)],{cwd:state,windowsHide:true})).stdout);
 assert.equal(chartCheck.status,'passed');assert.equal(chartCheck.checks[0].chartCachesMatchReferencedCells,true);assert.equal(chartCheck.checks[0].actualRenderingVerified,false);
 const chartBefore=await stat(chartAction.arguments.outputPath);assert.equal((await client.receiveExecutionPacket(chartPacket)).status,'COMPLETED');assert.equal((await stat(chartAction.arguments.outputPath)).mtimeMs,chartBefore.mtimeMs);
 const xlsxAction={actionType:ActionType.SEARCH_FILES,toolName:'excel.readWorkbook',arguments:{path:chartAction.arguments.outputPath,sheetName:'실적',range:'B1:D3'}};
 const xlsxToken=issuer.issue({taskId:'standalone-xlsx-read',planId:'xlsx-read-plan',approvalId:'xlsx-read-approval',action:xlsxAction,allowedPaths:[workspace]});
 const xlsxPacket={packetId:'standalone-xlsx-read-packet',taskId:'standalone-xlsx-read',planId:'xlsx-read-plan',action:xlsxAction,capabilityToken:xlsxToken,requestedMode:'execute',userConfirmation:{approvalId:'xlsx-read-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const xlsxResult=await client.receiveExecutionPacket(xlsxPacket);assert.equal(xlsxResult.status,'COMPLETED',JSON.stringify(xlsxResult));
 assert.equal(xlsxResult.executionResult.xlsxRead.cells.C2,100);assert.equal(xlsxResult.executionResult.xlsxRead.cells.D3,-5);
 assert.equal((await client.receiveExecutionPacket(xlsxPacket)).status,'COMPLETED');assert.equal((await stat(chartAction.arguments.outputPath)).mtimeMs,chartBefore.mtimeMs);
 console.log(JSON.stringify({standaloneXlsxRead:{signedPacketCompleted:true,noRepositoryRuntime:true,productionTestModeFlagAbsent:true,originalUnchanged:true,partialRegion:true,formulaRecalculationVerified:false}}));
 if(process.env.JARVIS_NATIVE_EXCEL_TEST==='1'){
  const exportAction={actionType:ActionType.CREATE_FILE,toolName:'excel.exportPdf',arguments:{inputPath:chartAction.arguments.outputPath,outputPath:join(workspace,'recovered.pdf')}};
  const exportToken=issuer.issue({taskId:'standalone-export',planId:'export-plan',approvalId:'export-approval',action:exportAction,allowedPaths:[workspace]});
  const exportPacket={packetId:'standalone-export-packet',taskId:'standalone-export',planId:'export-plan',action:exportAction,capabilityToken:exportToken,requestedMode:'execute',userConfirmation:{approvalId:'export-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
  const exported=await client.receiveExecutionPacket(exportPacket);assert.equal(exported.status,'COMPLETED',JSON.stringify(exported));
  assert.equal(exported.executionResult.pdfExport.render.actualRenderingExecuted,true);assert.equal((await stat(chartAction.arguments.outputPath)).mtimeMs,chartBefore.mtimeMs);
  const pdfBefore=await stat(exportAction.arguments.outputPath);assert.equal((await client.receiveExecutionPacket(exportPacket)).status,'COMPLETED');assert.equal((await stat(exportAction.arguments.outputPath)).mtimeMs,pdfBefore.mtimeMs);
  console.log(JSON.stringify({standaloneExistingPdfExport:{signedPacketCompleted:true,actualExcel:true,noRepositoryRuntime:true,sourceMtimeUnchanged:true,duplicateDidNotRewritePdf:true,visualQualityVerified:false}}));
 }
 console.log(JSON.stringify({standaloneChartEvidence:{completed:true,selectedSeriesPreserved:true,valuesIndependentlyReread:true,packagedCellOraclePassed:true,packagedChartOraclePassed:true,duplicateDidNotRewrite:true,actualRenderingVerified:false}}));
 const repeated=await client.receiveExecutionPacket(packet);assert.equal(repeated.status,'COMPLETED');
 assert.equal((await stat(action.arguments.path)).mtimeMs,beforeRepeat.mtimeMs);
 const deniedAction={...action,arguments:{...action.arguments,path:join(workspace,'unsigned.txt')}};
 await assert.rejects(client.receiveExecutionPacket({...packet,packetId:'standalone-unsigned',taskId:'standalone-unsigned',action:deniedAction,capabilityToken:null}),{code:'B_EXECUTION_PACKET_SCHEMA_INVALID'});
 await assert.rejects(stat(deniedAction.arguments.path),{code:'ENOENT'});
 assert.equal((await fetch(base+'/rollback/journal')).status,401);
 await writeFile(join(workspace,'comparison-source.txt'),'업체 주장: 개선율은 30%이다. 기존은 8초이다. 변경은 9초이다.');
 const compiled=compileNaturalWorkflowObjective("'comparison-source.txt' 텍스트를 '자료'로 읽어; '자료'에서 '업체'의 '개선율' 주장을 '%' 단위 숫자로 추출해 '주장'으로 만들어; '자료'에서 '기존'을 '초' 단위 숫자로 추출해 '전'으로 만들어; '자료'에서 '변경'을 '초' 단위 숫자로 추출해 '후'로 만들어; '전'과 '후'를 값 감소율로 비교해 '주장'과 허용오차 0 퍼센트포인트로 대조해 '대조'로 만들어; '대조'를 'comparison.json' JSON으로 저장해",{workspaceRoot:workspace});
 assert.equal(compiled.status,'compiled');
 const comparisonAction={actionType:ActionType.CREATE_FILE,toolName:'workflow.execute',arguments:{spec:compiled.spec,workspaceRoot:workspace}};
 const comparisonTaskId='standalone-comparison';
 const comparisonToken=issuer.issue({taskId:comparisonTaskId,planId:'standalone-comparison-plan',approvalId:'standalone-comparison-approval',action:comparisonAction,allowedPaths:[workspace]});
 const comparisonPacket={packetId:'standalone-comparison-packet',taskId:comparisonTaskId,planId:'standalone-comparison-plan',action:comparisonAction,capabilityToken:comparisonToken,requestedMode:'execute',userConfirmation:{approvalId:'standalone-comparison-approval',confirmed:true,confirmedAt:new Date().toISOString()}};
 const comparisonResult=await client.receiveExecutionPacket(comparisonPacket);assert.equal(comparisonResult.status,'COMPLETED',JSON.stringify(comparisonResult));
 const comparisonPath=join(workspace,'comparison.json'),comparison=JSON.parse(await readFile(comparisonPath,'utf8'));
 assert.equal(comparison.calculatedPercent.approximate,'-12.5');assert.equal(comparison.claimConsistentWithInputs,false);
 assert.equal(comparison.inputsIndependentlyVerified,false);assert.equal(comparison.executionAuthority,false);
 const comparisonBeforeRepeat=await stat(comparisonPath);
 assert.equal((await client.receiveExecutionPacket(comparisonPacket)).status,'COMPLETED');
 assert.equal((await stat(comparisonPath)).mtimeMs,comparisonBeforeRepeat.mtimeMs);
 const exited=once(child,'exit');child.kill('SIGTERM');await exited;
 await writeFile(join(packageDir,'pc-agent-runtime/apps/pc-agent/src/main.mjs'),'throw new Error("TAMPER_EXECUTED");');
 const damaged=await promisify(execFile)(process.execPath,[join(packageDir,'pc-agent-runtime/launch.mjs')],{cwd:state,windowsHide:true}).then(()=>null,error=>error);
 assert.ok(damaged);assert.match(damaged.stderr,/PC_RUNTIME_INTEGRITY_FAILED/);assert.doesNotMatch(damaged.stderr,/TAMPER_EXECUTED/);
  const forgedManifest=JSON.parse(await readFile(join(packageDir,'package-manifest.json'),'utf8'));
  const {createHash}=await import('node:crypto');
  forgedManifest.fileIntegrity['pc-agent-runtime/apps/pc-agent/src/main.mjs'].sha256=createHash('sha256').update('throw new Error("TAMPER_EXECUTED");').digest('hex');
  await writeFile(join(packageDir,'package-manifest.json'),JSON.stringify(forgedManifest));
  const forged=await promisify(execFile)(process.execPath,[join(packageDir,'pc-agent-runtime/launch.mjs')],{cwd:state,windowsHide:true}).then(()=>null,error=>error);
  assert.ok(forged);assert.match(forged.stderr,/PC_RUNTIME_INTEGRITY_FAILED/);assert.doesNotMatch(forged.stderr,/TAMPER_EXECUTED/);
 console.log(JSON.stringify({standalonePcEvidence:{moduleCount:closure.modules,noRepositoryRuntime:true,productionTestModeFlagAbsent:true,signedPacketCompleted:true,resultReread:true,duplicatePacketCompletedWithoutMtimeChange:true,unsignedPacketDidNotWrite:true,unauthenticatedReadDenied:true,tamperedRuntimeBlocked:true,forgedManifestWithTamperedRuntimeBlocked:true,sourceComparisonCompleted:true,sourceComparisonMismatchConfirmed:true,sourceComparisonInputsUnverified:true,sourceComparisonDuplicateDidNotRewrite:true}}));
});
