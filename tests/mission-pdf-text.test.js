import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PdfReadToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {normalizeVerificationSpec,verifyTypedCriterion,compareTypedCriterionContent} from '../packages/core/src/mission/criteria-evidence.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
// Expected text is fixed before executing the candidate, not copied from its result.
const base={version:1,kind:'pdf.text',path:'report.pdf',firstPage:1,totalPages:1,equals:[{pageNumber:1,text:'월 매출\n1월 10\n2월 20\n0\n5\n10\n15\n20\n25\n1월 2월\n실적\n매출'}]};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-pdf-criterion-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'report.pdf');await writeFile(path,await readFile('artifacts/workbook-native-pdf-20261003-mission-fenced/report.pdf'));
 const adapter=new PdfReadToolAdapter({allowedRoots:[root]}),shadow=await adapter.shadow({path}),executionResult=await adapter.execute({path});
 const checks=await new ExecutionResultVerifier().verify({executionResult,evidence:{shadow}});
 const proof=checks.find(c=>c.checkId==='pdf_text_current_source_verified');assert.equal(proof.status,'passed');
 const bytes=await readFile(path),observation={actionId:'read',toolName:'document.readPdf',outcome:'success',verification:{status:'passed'},
  artifacts:[],data:{pdfRead:executionResult.pdfRead,pdfReadProof:proof.evidence,
   fileEvidence:{rootIndex:0,relativePath:'report.pdf',pathHash:hash(path),contentSha256:hash(bytes)}}};
 const verify=(spec=base,observations=[observation])=>verifyTypedCriterion({criterion:{artifactRole:'input',verificationSpec:spec},observations,evidenceActionIds:['read'],allowedRoots:[root]});
 return {root,path,bytes,observation,verify};
}
test('declarative PDF contract rejects executable, ambiguous and unbounded expectations',()=>{
 assert.deepEqual(normalizeVerificationSpec(base),base);
 for(const changes of [{firstPage:0},{totalPages:501},{equals:[]},{equals:[{pageNumber:2,text:'wrong'}]},
  {equals:[{pageNumber:1,text:'',script:'run()'}]},{equals:[{pageNumber:1,text:42}]},{run:'shell'}]){
  assert.throws(()=>normalizeVerificationSpec({...base,...changes}),{code:'A_MISSION_CRITERION_INVALID'});
 }
 assert.equal(compareTypedCriterionContent({spec:base,bytes:Buffer.from('%PDF-')}).status,'unverified');
});
test('exact page text is checked only with current G-bound source and read receipt',async t=>{
 const {verify,observation}=await fixture(t);const passed=verify();assert.equal(passed.status,'passed');assert.equal(passed.checks[0].wholeTextLayerChecked,true);
 assert.equal(passed.checks[0].semanticEquivalenceVerified,false);
 assert.equal(verify({...base,equals:[{pageNumber:1,text:'월 매출 999'}]}).status,'failed');
 assert.equal(verify(base,[{...observation,data:{...observation.data,pdfReadProof:null}}]).status,'unverified');
 const forged=structuredClone(observation);forged.data.pdfRead.pages[0].text='invented';
 assert.equal(verify(base,[forged]).status,'unverified');
 const forgedCount=structuredClone(observation);forgedCount.data.pdfRead.totalPages=2;
 assert.equal(verify(base,[forgedCount]).status,'unverified');
 assert.equal(verify(base,[]).status,'unverified');
});
test('fresh content hash cannot substitute for missing PDF proof; changed original is rejected',async t=>{
 const {path,verify,observation}=await fixture(t);await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('\nchanged')]));
 assert.equal(verify().status,'failed');
 const changed=structuredClone(observation);changed.data.fileEvidence.contentSha256=hash(await readFile(path));
 assert.equal(verify(base,[changed]).status,'unverified');
});
test('real Mission PDF read completes only for the independent fixed expected text',async t=>{
 for(const correct of [true,false]){
  const root=await mkdtemp(join(tmpdir(),'jarvis-pdf-mission-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'report.pdf');await writeFile(path,await readFile('artifacts/workbook-native-pdf-20261003-mission-fenced/report.pdf'));
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_MISSION_EXECUTIVE:'0'};
  const planner={async planNextWave({mission}){return {decision:'continue',summary:'고정 PDF 원문 읽기',criteriaAssessment:[],actions:[{
   id:'pdf-read',title:'PDF 내용 읽기',command:'report.pdf 내용을 읽어줘',expectedToolName:'document.readPdf',
   requirementIds:mission.goalContract.requirements.filter(r=>r.interpretation.status==='recognized'&&r.interpretation.action==='read'&&r.interpretation.target==='report.pdf').map(r=>r.requirementId),
   arguments:{path,firstPage:1,maxPages:10},dependencies:[],successSignal:'실제 페이지와 고정 요구 내용 대조'}]};}};
  const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,missionPlanner:planner,workerDaemonEnabled:false});
  t.after(()=>runtime.coreFacade.cognition.close());const owner=runtime.personalOwnerSession.activate({requestedBy:'pdf-text-test',durationMinutes:5});
  const created=runtime.missionRuntime.createMission({objective:'report.pdf 내용을 읽어줘',
   successCriteria:[{criterionId:'pdf-text',statement:'PDF의 고정 페이지 문구와 값을 재확인한다.',artifactRole:'input',verificationSpec:correct?base:{...base,equals:[{pageNumber:1,text:'invented 999'}]}}],
   budgets:{maxPlannerCalls:1,maxWaves:2,maxActions:1},authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY]}});
  assert.equal(created.success,true,JSON.stringify(created));const completed=await runtime.missionRuntime.runMission(created.missionId);
  assert.equal(completed.observations[0]?.verification?.status,'passed',JSON.stringify(completed));
  assert.equal(completed.observations[0]?.data?.pdfReadProof?.passed,true,JSON.stringify(completed));
  if(correct){assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));assert.equal(completed.completion.criteria[0].deterministicChecks.find(c=>c.checkId==='typed_pdf_text')?.passed,true);}
  else assert.notEqual(completed.status,'COMPLETED');
  console.log(JSON.stringify({pdfTextMission:{correct,status:completed.status,producerGPassed:true,fixedPlanner:true,externalModelUsed:false,semanticEquivalenceVerified:false}}));
 }
});
