import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ExcelPdfExportToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {IntentParser} from '../packages/core/src/intent/intent-parser.js';
import {SkillRouter} from '../packages/core/src/routing/skill-router.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-export-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inputPath=join(root,'saved.xlsx'),outputPath=join(root,'result.pdf');await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20]]});return {root,inputPath,outputPath};}
test('natural existing XLSX to PDF export has its own tool instead of rewriting a workbook',()=>{
 const intent=new IntentParser().parse("'saved.xlsx'를 'result.pdf'로 변환해줘");assert.equal(intent.slots.workflow,'export-existing-xlsx-pdf');
 assert.equal(new SkillRouter().route(intent).skill.toolName,'excel.exportPdf');
});
test('failed PDF recovery keeps the existing source bytes and modification time',async t=>{
 const {root,inputPath,outputPath}=await fixture(t),before=await readFile(inputPath),mtime=(await stat(inputPath)).mtimeMs;let calls=0;
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render(){calls++;throw Object.assign(Error('missing'),{code:'EXCEL_PDF_EXPORT_FAILED'});}}});
 assert.equal((await adapter.execute({inputPath,outputPath})).status,'blocked');assert.equal(calls,1);assert.deepEqual(await readFile(inputPath),before);assert.equal((await stat(inputPath)).mtimeMs,mtime);await assert.rejects(stat(outputPath),{code:'ENOENT'});
 await writeFile(outputPath,'keep');assert.equal((await adapter.execute({inputPath,outputPath})).status,'blocked');assert.equal(await readFile(outputPath,'utf8'),'keep');assert.equal(calls,1);
});
test('hash mismatch, narrower grants and changed publication authority prevent export',async t=>{
 const {root,inputPath,outputPath}=await fixture(t);let calls=0;const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render({beforePublish}){calls++;await beforePublish();throw Error('unreachable');}}});
 assert.equal((await adapter.execute({inputPath,outputPath,expectedSha256:'0'.repeat(64)})).status,'blocked');assert.equal(calls,0);
 const narrow=join(root,'narrow');await mkdir(narrow);assert.equal((await adapter.execute({inputPath,outputPath},{capabilityToken:{scope:{allowedPaths:[narrow]}}})).status,'blocked');assert.equal(calls,0);
 assert.equal((await adapter.execute({inputPath,outputPath},{},{beforePdfPublish(){throw Object.assign(Error('revoked'),{code:'TOKEN_REVOKED'});}})).warnings[0],'TOKEN_REVOKED');await assert.rejects(stat(outputPath),{code:'ENOENT'});
});
test('authority revoked during export shadow cannot create the destination directory or enter renderer',async t=>{
 const {root,inputPath}=await fixture(t),outputPath=join(root,'not-created','result.pdf');let revoked=false,calls=0;
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render(){calls++;throw Error('must-not-render');}}});
 const shadow=adapter.shadow.bind(adapter);adapter.shadow=async(...args)=>{const result=await shadow(...args);revoked=true;return result;};
 const before=await readFile(inputPath);
 const result=await adapter.execute({inputPath,outputPath},{},{assertAccess(){if(revoked)throw Object.assign(Error('stale-authority'),{code:'STALE_AUTHORITY'});}});
 assert.equal(result.status,'blocked');assert.deepEqual(result.warnings,['STALE_AUTHORITY']);assert.equal(calls,0);
 await assert.rejects(stat(join(root,'not-created')),{code:'ENOENT'});assert.deepEqual(await readFile(inputPath),before);
});

test('export rechecks authority after source reread immediately before PDF publication',async t=>{
 const {root,inputPath,outputPath}=await fixture(t);let revoked=false,published=false;
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render({beforePublish}){
  revoked=true;await beforePublish();published=true;throw Error('must-not-publish');
 }}});
 const result=await adapter.execute({inputPath,outputPath},{},{assertAccess(){if(revoked)throw Object.assign(Error('stale-authority'),{code:'STALE_AUTHORITY'});}});
 assert.equal(result.status,'blocked');assert.deepEqual(result.warnings,['STALE_AUTHORITY']);assert.equal(published,false);
 await assert.rejects(stat(outputPath),{code:'ENOENT'});
});

test('trusted cancellation signal reaches renderer and produces no PDF',async t=>{
 const {root,inputPath,outputPath}=await fixture(t),controller=new AbortController();controller.abort();
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render({signal}){assert.equal(signal,controller.signal);assert.equal(signal.aborted,true);throw Object.assign(Error('cancel'),{code:'EXCEL_PDF_CANCELLED'});}}});
 assert.equal((await adapter.execute({inputPath,outputPath},{},{signal:controller.signal})).warnings[0],'EXCEL_PDF_CANCELLED');await assert.rejects(stat(outputPath),{code:'ENOENT'});
});
test('a file appearing during a failed publication remains unknown and is never deleted or retried',async t=>{
 const {root,inputPath,outputPath}=await fixture(t),journal=new UndoJournal();
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],undoJournal:journal,renderer:{async render(){await writeFile(outputPath,'unknown-file');throw Error('response-lost');}}});
 const result=await adapter.execute({inputPath,outputPath});assert.equal(result.status,'failed');assert.equal(result.retryable,false);
 assert.equal(result.warnings[0],'XLSX_PDF_EFFECT_UNCERTAIN');assert.equal(journal.list().length,0);assert.equal(await readFile(outputPath,'utf8'),'unknown-file');
});
test('active parts and hidden formula caches never reach native renderer',async t=>{
 const {root,inputPath,outputPath}=await fixture(t);let calls=0;
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],renderer:{async render(){calls++;throw Error('must-not-open');}}});
 for(const mode of ['active','formula','external']){
  const malicious=join(root,mode+'.xlsx');execFileSync('python',['-I','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: entries={n:z.read(n) for n in z.namelist()}
mode=sys.argv[3]
if mode=='active': entries['xl/embeddings/payload.bin']=b'blocked'
if mode=='formula': entries['xl/worksheets/sheet1.xml']=entries['xl/worksheets/sheet1.xml'].replace(b'<v>10</v>',b'<f>WEBSERVICE("https://untrusted.invalid")</f><v>10</v>')
if mode=='external': entries['xl/_rels/workbook.xml.rels']=entries['xl/_rels/workbook.xml.rels'].replace(b'</Relationships>',b'<Relationship Id="external" Type="custom" Target="https://untrusted.invalid" TargetMode="External"/></Relationships>')
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for n,b in entries.items(): z.writestr(n,b)
`,inputPath,malicious,mode],{windowsHide:true});
  assert.equal((await adapter.execute({inputPath:malicious,outputPath})).status,'blocked');
 }assert.equal(calls,0);
});
test('real native recovery exports only PDF, preserves original and runs G',
 {skip:process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const {root,inputPath,outputPath}=await fixture(t),before=await readFile(inputPath),mtime=(await stat(inputPath)).mtimeMs,journal=new UndoJournal();
 const adapter=new ExcelPdfExportToolAdapter({allowedRoots:[root],undoJournal:journal}),args={inputPath,outputPath,expectedSha256:hash(before)},shadow=await adapter.shadow(args),result=await adapter.execute(args,{taskId:'actual-retry'});
 assert.equal(result.status,'success',JSON.stringify(result));assert.deepEqual(await readFile(inputPath),before);assert.equal((await stat(inputPath)).mtimeMs,mtime);assert.equal(journal.list().length,1);assert.equal(journal.list()[0].path,outputPath);
 const verify=async r=>(await new ExecutionResultVerifier().verify({executionResult:r,evidence:{shadow}})).find(c=>c.checkId==='excel_existing_pdf_export_verified').status;
 assert.equal(await verify(result),'passed');assert.equal(await verify({...result,pdfExport:{...result.pdfExport,inputPath:outputPath}}),'failed');
 await writeFile(outputPath,Buffer.concat([await readFile(outputPath),Buffer.from('changed')]));assert.equal(await verify(result),'failed');
 console.log(JSON.stringify({nativeExistingExport:{sourceUnchanged:true,sourceMtimeUnchanged:true,pdfOnlyUndo:true,actualExcel:true,visualQualityVerified:false}}));
});
test('native Mission recovers PDF from an existing XLSX through Core E PC G',
 {skip:process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const {root,inputPath,outputPath}=await fixture(t),before=await readFile(inputPath);
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
 const planner={async planNextWave({mission}){return {decision:'continue',summary:'보존된 원본 PDF 출력',criteriaAssessment:[],actions:[{
  id:'recover',title:'PDF만 출력',command:`"${inputPath}"를 "${outputPath}"로 변환해줘`,expectedToolName:'excel.exportPdf',arguments:{inputPath,outputPath,expectedSha256:hash(before)},
  requirementIds:mission.goalContract.requirements.map(r=>r.requirementId),dependencies:[],successSignal:'원본 보존·PDF 현재 해시'}]};}};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});t.after(()=>runtime.coreFacade.cognition.close());
 const owner=runtime.personalOwnerSession.activate({requestedBy:'export-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:"'result.pdf' 파일을 저장해",successCriteria:[{criterionId:'pdf',statement:'요청한 PDF가 실제로 저장되었다.',verificationSpec:{version:1,kind:'file.exists',path:'result.pdf'}}],
 budgets:{maxPlannerCalls:1,maxWaves:2,maxActions:1},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
 assert.equal(created.success,true,JSON.stringify(created));const result=await runtime.missionRuntime.runMission(created.missionId);assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,reasons:result.goalCompletionCoverage,waves:result.waves,observations:result.observations}));
 assert.deepEqual(await readFile(inputPath),before);console.log(JSON.stringify({nativeExistingExportMission:{status:result.status,fixedPlanner:true,actualExcel:true,externalModelUsed:false}}));
});
