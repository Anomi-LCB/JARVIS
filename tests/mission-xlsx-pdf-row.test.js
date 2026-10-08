import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PdfReadToolAdapter,XlsxReadToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {normalizeVerificationSpec,verifyTypedCriterion} from '../packages/core/src/mission/criteria-evidence.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const base={version:1,kind:'xlsx.pdfRowText',sourcePath:'report.xlsx',pdfPath:'report.pdf',sheetName:'보고서',
 equals:{A1:'월',B1:'매출',A2:'1월',B2:10,A3:'2월',B3:20},
 rows:[{cells:['A1','B1'],pageNumber:1,lineNumber:1},{cells:['A2','B2'],pageNumber:1,lineNumber:2},{cells:['A3','B3'],pageNumber:1,lineNumber:3}]};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-pdf-row-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const binding=async name=>{const path=join(root,name);await writeFile(path,await readFile('artifacts/workbook-native-pdf-20261003-mission-fenced/'+name));return {rootIndex:0,relativePath:name,pathHash:hash(path),contentSha256:hash(await readFile(path))};};
 const source=await binding('report.xlsx');await binding('report.pdf');const path=join(root,'report.pdf');
 const adapter=new PdfReadToolAdapter({allowedRoots:[root]}),shadow=await adapter.shadow({path}),result=await adapter.execute({path});
 const g=(await new ExecutionResultVerifier().verify({executionResult:result,evidence:{shadow}})).find(check=>check.checkId==='pdf_text_current_source_verified');assert.equal(g.status,'passed');
 const observations=[{actionId:'source',outcome:'success',verification:{status:'passed'},artifacts:[source]},
  {actionId:'read',toolName:'document.readPdf',outcome:'success',verification:{status:'passed'},artifacts:[],data:{pdfRead:result.pdfRead,pdfReadProof:g.evidence,fileEvidence:{rootIndex:0,relativePath:'report.pdf',pathHash:hash(path),contentSha256:result.contentSha256}}}];
 const verify=(spec=base,items=observations)=>verifyTypedCriterion({criterion:{verificationSpec:spec},observations:items,evidenceActionIds:['source','read'],allowedRoots:[root]});
 return {root,path,verify,observations};
}
test('row mapping requires exact bounded cells, ordered contiguous columns and unique PDF positions',()=>{
 assert.deepEqual(normalizeVerificationSpec(base),base);
 for(const rows of [[],[{cells:['B1','A1'],pageNumber:1,lineNumber:1}],base.rows.map(row=>({...row,lineNumber:1})),[...base.rows].reverse(),[{cells:['A1','B2'],pageNumber:1,lineNumber:1}]]){
  assert.throws(()=>normalizeVerificationSpec({...base,rows}),{code:'A_MISSION_CRITERION_INVALID'});
 }
 assert.throws(()=>normalizeVerificationSpec({...base,equals:{...base.equals,B2:'10\n'}}),{code:'A_MISSION_CRITERION_INVALID'});
});
test('current XLSX cells and exact PDF row locations are compared instead of token presence',async t=>{
 const {verify}=await fixture(t);const proof=verify();assert.equal(proof.status,'passed',JSON.stringify(proof));
 assert.equal(proof.checks[0].checkedCellCount,6);assert.equal(proof.checks[0].columnGeometryVerified,false);
 // 10 occurs in the chart axis too, but that is not the requested row.
 assert.equal(verify({...base,rows:base.rows.map((row,i)=>i===1?{...row,lineNumber:6}:row)}).status,'unverified');
 assert.equal(verify({...base,rows:base.rows.map(row=>({...row,lineNumber:row.lineNumber+3}))}).status,'failed');
 assert.equal(verify({...base,equals:{...base.equals,B3:999}}).status,'failed');
 assert.equal(verify({...base,rows:base.rows.map(row=>({...row,pageNumber:2}))}).status,'failed');
});
test('missing G, altered source, and receipt tampering prevent multi-file completion',async t=>{
 const {root,verify,observations}=await fixture(t);
 assert.equal(verify(base,[observations[0]]).status,'unverified');
 const altered=structuredClone(observations);altered[1].data.pdfRead.pages[0].text='월 매출\n1월 10\n2월 999';assert.equal(verify(base,altered).status,'unverified');
 await writeFile(join(root,'report.xlsx'),'changed');assert.equal(verify().status,'failed');
});

for(const deniedAt of [1,3,5])test(`mapped XLSX/PDF current authority is retained at read phase ${deniedAt}`,async t=>{
 const {root,observations}=await fixture(t);let accesses=0;const paths=[];
 const proof=verifyTypedCriterion({criterion:{verificationSpec:base},observations,evidenceActionIds:['source','read'],allowedRoots:[root],
  beforeAccess:access=>{accesses++;paths.push(access.path);if(accesses===deniedAt)throw Error('revoked');}});
 assert.equal(proof.passed,false);assert.ok(proof.reasons.includes('criterion-result-read-permission-unavailable'));
 assert.equal(accesses,deniedAt);assert.equal(paths.at(-1),join(root,deniedAt===3?'report.pdf':'report.xlsx'));
});
test('existing workbook input requires its actual G read proof and coverage of every mapped cell',async t=>{
 const {root,observations}=await fixture(t),path=join(root,'report.xlsx');
 const adapter=new XlsxReadToolAdapter({allowedRoots:[root]}),args={path,sheetName:'보고서',range:'A1:B3'};
 const shadow=await adapter.shadow(args),read=await adapter.execute(args);
 const proof=(await new ExecutionResultVerifier().verify({executionResult:read,evidence:{shadow}})).find(c=>c.checkId==='xlsx_region_current_source_verified');
 assert.equal(proof.status,'passed');const {cells,...metadata}=read.xlsxRead;
 const input={actionId:'source',toolName:'excel.readWorkbook',outcome:'success',verification:{status:'passed'},artifacts:[],
  data:{fileEvidence:observations[0].artifacts[0],xlsxRead:{...metadata,cellsJson:JSON.stringify(cells)},xlsxReadProof:proof.evidence}};
 const verify=(source=input,spec=base)=>verifyTypedCriterion({criterion:{artifactRole:'input',verificationSpec:spec},observations:[source,observations[1]],evidenceActionIds:['source','read'],allowedRoots:[root]});
 assert.equal(verify().status,'passed');assert.equal(verify({...input,data:{...input.data,xlsxReadProof:null}}).status,'unverified');
 const forged=structuredClone(input);forged.data.xlsxRead.cellsJson='{}';assert.equal(verify(forged).status,'unverified');
 const narrowArgs={...args,range:'A1:B2'},narrowShadow=await adapter.shadow(narrowArgs),narrowRead=await adapter.execute(narrowArgs);
 const narrowProof=(await new ExecutionResultVerifier().verify({executionResult:narrowRead,evidence:{shadow:narrowShadow}})).find(c=>c.checkId==='xlsx_region_current_source_verified');
 const {cells:narrowCells,...narrowMetadata}=narrowRead.xlsxRead;
 assert.equal(verify({...input,data:{...input.data,xlsxRead:{...narrowMetadata,cellsJson:JSON.stringify(narrowCells)},xlsxReadProof:narrowProof.evidence}}).status,'unverified');
 assert.equal(verify(input,{...base,equals:{...base.equals,B3:999}}).status,'failed');
 await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('changed')]));assert.equal(verify().status,'failed');
});
test('read-only Mission compares existing XLSX and PDF with no new output or native export',async t=>{
 const {root}=await fixture(t);let call=0;
 const planner={async planNextWave({mission}){const xlsx=++call===1;return {decision:'continue',summary:'고정 기존 자료를 다시 읽어 비교',criteriaAssessment:[],actions:[{
  id:xlsx?'source':'pdf',title:xlsx?'원본 엑셀 읽기':'PDF 읽기',command:xlsx?'report.xlsx 내용을 읽어줘':'report.pdf 내용을 읽어줘',
  requirementIds:mission.goalContract.requirements.filter(r=>r.interpretation.status==='recognized'&&r.interpretation.action==='read'&&r.interpretation.target===(xlsx?'report.xlsx':'report.pdf')).map(r=>r.requirementId),
  expectedToolName:xlsx?'excel.readWorkbook':'document.readPdf',arguments:xlsx?{path:join(root,'report.xlsx'),sheetName:'보고서',range:'A1:B3'}:{path:join(root,'report.pdf'),firstPage:1,maxPages:10},
  dependencies:[],successSignal:'현재 입력과 고정 행 대조'}]};}};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});t.after(()=>runtime.coreFacade.cognition.close());
 const owner=runtime.personalOwnerSession.activate({requestedBy:'input-row-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:'report.xlsx 내용을 읽어줘; report.pdf 내용을 읽어줘',successCriteria:[{criterionId:'input-row',statement:'기존 원본 셀과 PDF 지정 행을 대조한다.',artifactRole:'input',verificationSpec:base}],
  budgets:{maxPlannerCalls:2,maxWaves:3,maxActions:2},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY]}});
 assert.equal(created.success,true,JSON.stringify(created));const mission=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(mission.status,'COMPLETED',JSON.stringify(mission));assert.equal(mission.observations.length,2);
 assert.equal(mission.observations[0].data.xlsxReadProof.passed,true);assert.equal(mission.observations.every(o=>o.artifacts.length===0),true);
 console.log(JSON.stringify({existingWorkbookPdfMission:{status:mission.status,readOnly:true,newOutputs:0,fixedPlanner:true,externalModelUsed:false,wholeDocumentEquivalenceVerified:false}}));
});
test('actual native Excel generation and PDF read complete a mapped-row Mission',
 {skip:process.env.JARVIS_NATIVE_EXCEL_TEST!=='1'||process.platform!=='win32',timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-pdf-row-mission-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let call=0;const planner={async planNextWave({mission}){call++;return {decision:'continue',summary:'고정 표의 생성과 현재 PDF 재읽기',criteriaAssessment:[],actions:[call===1?{
  id:'write',title:'표와 PDF 작성',command:'report.xlsx 엑셀 파일을 만들어줘',expectedToolName:'excel.createWorkbook',
  requirementIds:mission.goalContract.requirements.filter(requirement=>requirement.interpretation.status==='recognized'&&requirement.interpretation.action==='save'&&['report.xlsx','report.pdf'].includes(requirement.interpretation.target)).map(requirement=>requirement.requirementId),
  arguments:{outputPath:join(root,'report.xlsx'),pdfOutputPath:join(root,'report.pdf'),renderPdf:true,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20]],charts:[{type:'bar',title:'실적',range:'A1:B3'}]},dependencies:[],successSignal:'실제 XLSX와 PDF'}:{
  id:'read',title:'PDF 다시 읽기',command:'report.pdf 내용을 읽어줘',expectedToolName:'document.readPdf',arguments:{path:join(root,'report.pdf'),firstPage:1,maxPages:10},dependencies:[],successSignal:'현재 PDF 표 문구 대조'}]};}};
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
 const runtime=createAgRuntime({allowedRoots:[root],cwd:()=>root,auditRoot:join(root,'audit'),env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});t.after(()=>runtime.coreFacade.cognition.close());
 const owner=runtime.personalOwnerSession.activate({requestedBy:'pdf-row-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:"'report.xlsx' 파일을 저장해; 'report.pdf' 파일을 저장해.",successCriteria:[{criterionId:'row-text',statement:'원본 XLSX 셀과 PDF 첫 세 행의 텍스트가 일치한다.',verificationSpec:base}],
  budgets:{maxPlannerCalls:2,maxWaves:3,maxActions:2},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]}});
 assert.equal(created.success,true,JSON.stringify(created));const mission=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(mission.status,'COMPLETED',JSON.stringify(mission));assert.equal(mission.observations.length,2);
 assert.equal(mission.completion.criteria[0].deterministicChecks.find(check=>check.checkId==='typed_xlsx_pdf_row_text')?.passed,true);
 console.log(JSON.stringify({xlsxPdfRowMission:{status:mission.status,actualNativeExport:true,actualPdfRead:true,fixedPlanner:true,checkedCells:6,checkedRows:3,columnGeometryVerified:false,wholeDocumentEquivalenceVerified:false}}));
});
