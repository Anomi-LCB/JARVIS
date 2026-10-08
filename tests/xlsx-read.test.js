import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {XlsxRegionReader} from '../apps/pc-agent/src/adapters/excel/xlsx-reader.js';
import {XlsxReadToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {IntentParser} from '../packages/core/src/intent/intent-parser.js';
import {SkillRouter} from '../packages/core/src/routing/skill-router.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {screenMissionObservationsForPlanning} from '../packages/core/src/mission/mission-planner.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-xlsx-read-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'report.xlsx');
 await new ExcelWorkbookWorker().writeWorkbook({outputPath:path,sheetName:'보고서',columns:['월','매출'],rows:[['1월',10],['2월',20],['합계',30]]});return {root,path};}
const checkAllowedPath=async p=>p;
test('quoted report sheet read is not a workbook creation, and create commands retain their route',()=>{
 const parser=new IntentParser(),router=new SkillRouter();
 const intent=parser.parse("report.xlsx의 '보고서' 시트 A1:B3 내용을 읽어줘");
 assert.equal(router.route(intent).skill.toolName,'excel.readWorkbook');assert.equal(intent.slots.sheetName,'보고서');assert.equal(intent.slots.range,'A1:B3');
 assert.equal(router.route(parser.parse('report.xlsx 엑셀 보고서를 만들어줘')).skill.toolName,'excel.createWorkbook');
 assert.notEqual(router.route(parser.parse('report.xlsx 파일을 찾아줘')).skill.toolName,'excel.readWorkbook');
 assert.equal(router.route(parser.parse("report.pdf '보고서' 내용을 읽어줘")).skill.toolName,'document.readPdf');
 for(const range of ['A0:B1','A1','XFE1:XFE2'])assert.equal(parser.parse(`report.xlsx ${range} 내용을 읽어줘`).slots.range,range);
 assert.equal(parser.parse('A1.xlsx 내용을 읽어줘').slots.range,undefined);
});
test('Mission reads an existing workbook and checks fixed cells without creating an output',async t=>{
 const {root,path}=await fixture(t);
 const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
 const planner={async planNextWave({mission}){return {decision:'continue',summary:'고정 셀 읽기',criteriaAssessment:[],actions:[{
  id:'xlsx-read',title:'엑셀 내용 읽기',command:"report.xlsx의 '보고서' 시트 A1:B4 내용을 읽어줘",expectedToolName:'excel.readWorkbook',
  requirementIds:mission.goalContract.requirements.filter(r=>r.interpretation.status==='recognized'&&r.interpretation.action==='read'&&r.interpretation.target==='report.xlsx').map(r=>r.requirementId),
  arguments:{path,sheetName:'보고서',range:'A1:B4'},dependencies:[],successSignal:'원본의 고정 셀과 대조'}]};}};
 const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});
 t.after(()=>runtime.coreFacade.cognition.close());const owner=runtime.personalOwnerSession.activate({requestedBy:'xlsx-read-test',durationMinutes:5});
 const created=runtime.missionRuntime.createMission({objective:'report.xlsx 내용을 읽어줘',successCriteria:[{
  criterionId:'cells',statement:'기존 원본의 고정 값을 읽어 확인한다.',artifactRole:'input',verificationSpec:{version:1,kind:'xlsx.cells',path:'report.xlsx',sheetName:'보고서',equals:{A1:'월',B2:10,B4:30}}}],
  budgets:{maxPlannerCalls:1,maxWaves:2,maxActions:1},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY]}});
 assert.equal(created.success,true,JSON.stringify(created));const completed=await runtime.missionRuntime.runMission(created.missionId);
 assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));
 assert.equal(completed.observations[0].trustBoundary,'LOCAL_FILE_CONTENT');assert.equal(completed.observations[0].untrusted,true);
 assert.equal(JSON.parse(completed.observations[0].data.xlsxRead.cellsJson).B4,30);
 console.log(JSON.stringify({xlsxReadMission:{status:completed.status,fixedPlanner:true,syntheticInput:true,externalModelUsed:false}}));
});
test('literal XLSX values, sparse nulls and partial range are explicit and original remains intact',async t=>{
 const {path}=await fixture(t),before=await readFile(path),reader=new XlsxRegionReader();
 const partial=await reader.read({path,range:'A1:B3',checkAllowedPath});assert.equal(partial.cells.B3,20);assert.equal(partial.hasCellsOutsideRange,true);
 assert.equal(partial.formulaRecalculationVerified,false);assert.equal(partial.formattedValuesVerified,false);
 const full=await reader.read({path,range:'A1:C4',expectedSha256:partial.sourceSha256,checkAllowedPath});assert.equal(full.hasCellsOutsideRange,false);
 assert.equal(full.cells.C4,undefined);assert.equal(full.missingCellsAreNull,true);assert.equal(full.selectedCellCount,12);
 assert.deepEqual(await readFile(path),before);
});
test('G compares actual sheet/range and literal values rather than producer claims',async t=>{
 const {root,path}=await fixture(t),adapter=new XlsxReadToolAdapter({allowedRoots:[root]});
 const args={path,sheetName:'보고서',range:'A1:B4'},shadow=await adapter.shadow(args),result=await adapter.execute(args);
 assert.equal(result.status,'success');const verifier=new ExecutionResultVerifier();
 const verify=async next=>(await verifier.verify({executionResult:next,evidence:{shadow}})).find(c=>c.checkId==='xlsx_region_current_source_verified').status;
 assert.equal(await verify(result),'passed');assert.equal(await verify({...result,xlsxRead:{...result.xlsxRead,cells:{...result.xlsxRead.cells,B4:999}}}),'failed');
 assert.equal(await verify({...result,xlsxRead:undefined,executedBy:{toolName:'excel.readWorkbook'}}),'failed');
 await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('changed')]));assert.equal(await verify(result),'failed');
});
test('actual natural command runs Core/E/PC/G with exact sheet and selected range',async t=>{
 const {root,path}=await fixture(t),runtime=createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});t.after(()=>runtime.coreFacade.cognition.close());
 const task=runtime.coreFacade.createTask(`"${path}"의 '보고서' 시트 A1:B4 내용을 읽어줘`);
 assert.equal(task.plan.action.toolName,'excel.readWorkbook');assert.equal(task.plan.action.arguments.sheetName,'보고서');assert.equal(task.plan.action.arguments.range,'A1:B4');
 const result=await runtime.orchestrationWorker.runTask(task.taskId);assert.equal(result.success,true,JSON.stringify(result));
 console.log(JSON.stringify({xlsxNaturalRead:{corePolicyPcG:true,externalModelUsed:false,syntheticSource:true,formulaRecalculationVerified:false}}));
});
test('invalid or oversized ranges, missing sheet and selected formulas fail honestly',async t=>{
 const {root,path}=await fixture(t),reader=new XlsxRegionReader();
 for(const range of ['A1:XFD1048576','B3:A1','A0:B1','A1','XFE1:XFE2','A1:Z100'])await assert.rejects(reader.read({path,range,checkAllowedPath}),/XLSX_READ_RANGE_INVALID/);
 await assert.rejects(reader.read({path,sheetName:'없는 시트',checkAllowedPath}),/XLSX_READ_SHEET_NOT_FOUND/);
 const formula=join(root,'formula.xlsx');execFileSync('python',['-I','-c',`import sys,zipfile,re
with zipfile.ZipFile(sys.argv[1]) as z: entries={n:z.read(n) for n in z.namelist()}
name='xl/worksheets/sheet1.xml'
text=entries[name].decode('utf-8')
text,count=re.subn(r'<c r="B4"[^>]*><v>30</v></c>','<c r="B4"><f>SUM(B2:B3)</f><v>30</v></c>',text)
assert count==1
entries[name]=text.encode('utf-8')
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for n,b in entries.items(): z.writestr(n,b)
`,path,formula],{windowsHide:true});
 const result=await new XlsxReadToolAdapter({allowedRoots:[root]}).execute({path:formula,range:'A1:B4'});assert.equal(result.status,'blocked');assert.ok(result.warnings.includes('XLSX_FORMULA_UNVERIFIED'));
});
test('narrow signed path grant and source races cannot return a verified workbook',async t=>{
 const {root,path}=await fixture(t);const limited=join(root,'limited');await mkdir(limited);
 const result=await new XlsxReadToolAdapter({allowedRoots:[root]}).execute({path},{capabilityToken:{scope:{allowedPaths:[limited]}}});assert.equal(result.status,'blocked');
 let checks=0;await assert.rejects(new XlsxRegionReader().read({path,checkAllowedPath:async p=>{if(++checks===4)await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('changed')]));return p;}}),/XLSX_SOURCE_CHANGED/);
});
test('numeric local cells enter external sensitivity screening as serialized source data',()=>{
 const cellJson=JSON.stringify({A1:1234567890123});
 const screened=screenMissionObservationsForPlanning([{toolName:'excel.readWorkbook',trustBoundary:'LOCAL_FILE_CONTENT',untrusted:true,data:{xlsxRead:{cellsJson:cellJson}}}],{
  externalEgress:true,dataClassifier:{classify:()=>({dataClass:'D3'})}});
 assert.doesNotMatch(screened[0].data.xlsxRead.cellsJson,/1234567890123/);
});
