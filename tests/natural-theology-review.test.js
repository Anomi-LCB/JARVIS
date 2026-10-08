import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';
import { reviewTheologyResearch } from '../packages/core/src/mission/theology-research-review.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import {verifyTheologyReviewResult} from '../packages/core/src/mission/mission-theology-review-result.js';
const objective = "'research.json' 신학 연구 자료의 분류·인용·본문·전제 연결만 검토해 'report.md'와 'review.json'에 저장하고 다시 읽어 확인해줘";
const source = () => ({ sources: [{ id:'s1', title:'합성 문헌', author:'시험 저자', locator:'시험 1쪽', text:'이것은 합성 견해 자료입니다.' }],
  passages: [{ id:'p1', reference:'시험 본문', version:'합성 시험용', text:'문맥을 검토한다.' }],
  claims: [
    { id:'c1', category:'fact', statement:'문맥이라는 표현이 있다.', sourceRefs:[], passageRefs:[{passageId:'p1',quote:'문맥'}], premiseIds:[] },
    { id:'c2', category:'scholarly-view', statement:'저자의 시험 견해이다.', perspective:'시험 견해', sourceRefs:[{sourceId:'s1',quote:'합성 견해'}], passageRefs:[], premiseIds:[] },
    { id:'c3', category:'inference', statement:'문맥 검토의 의미를 추론한다.', sourceRefs:[], passageRefs:[{passageId:'p1',quote:'검토한다'}], premiseIds:['c1'] },
    { id:'c4', category:'application', statement:'문맥을 먼저 보자.', sourceRefs:[], passageRefs:[{passageId:'p1',quote:'문맥'}], premiseIds:['c3'] }
  ] });
test('theology request compiles every requirement into read/review/two writes/two re-reads and preserves unsupported suffixes', () => {
  const result=compileNaturalWorkflowObjective(objective,{workspaceRoot:tmpdir()});
  assert.equal(result.status,'compiled',JSON.stringify(result));
  assert.deepEqual(result.spec.nodes.map(node=>node.op),['data.readJson','theology.review','write.text','write.json','text.read','data.readJson']);
  assert.equal(result.goalContract.requirements[0].nodeIds.length,6);
  for(const request of [objective+' 그리고 메일로 보내',objective.replace('report.md','research.json'),objective.replace('review.json','report.md'),objective.replace('report.md','../report.md')])
    assert.notEqual(compileNaturalWorkflowObjective(request,{workspaceRoot:tmpdir()}).status,'compiled');
});
for(const mode of ['valid','default-criterion','missing-evidence','invalid-category']) test(`actual Core/E/B/G natural theology review ${mode}`, async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-theology-mission-'));let runtime;
  try {
    const input=source();
    if(mode==='missing-evidence')input.claims[0].passageRefs[0].quote='존재하지 않는 인용';
    if(mode==='invalid-category')input.claims[0].category='verified-truth';
    const original=JSON.stringify(input);await writeFile(join(root,'research.json'),original);
    const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
    runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
    const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-theology-test',durationMinutes:5});
    const expected=mode==='invalid-category'?'must not publish':reviewTheologyResearch(input).report;
    const criterion=mode==='default-criterion'?{statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}:{statement:'지정 근거 검토 보고서를 실제 저장',verificationSpec:{version:1,kind:'text.equals',path:'report.md',equals:expected}};
    const mission=runtime.missionRuntime.createMission({objective,successCriteria:[criterion],
      authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
    const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
    if(mode==='invalid-category'){
      assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'report.md')), {code:'ENOENT'});await assert.rejects(readFile(join(root,'review.json')), {code:'ENOENT'});
    }else{
      assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,stopReason:result.stopReason,observations:result.observations}));
      assert.equal(await readFile(join(root,'report.md'),'utf8'),expected);
      const review=JSON.parse(await readFile(join(root,'review.json'),'utf8'));assert.equal(review.claims.length,4);
      assert.equal(review.completionEligible,false);assert.equal(review.executionAuthority,false);
      assert.ok(review.claims.every(claim=>!claim.truthVerified&&!claim.interpretationVerified&&!claim.consensusVerified));
      assert.equal(review.evidenceLinksMatched,mode!=='missing-evidence');
      if(mode==='missing-evidence')assert.ok(review.claims[3].issues.includes('premise-evidence-unresolved'));
      assert.equal(result.observations.find(o=>o.toolName==='workflow.execute').verification.status,'passed');
    }
    assert.equal(await readFile(join(root,'research.json'),'utf8'),original);
    if(mode==='default-criterion'){
      const args={objective,statement:criterion.statement,observations:result.observations,allowedRoots:[root]};
      const proof=verifyTheologyReviewResult(args);assert.equal(proof.passed,true);assert.equal(proof.checks[0].semanticAccuracyVerified,false);
      for(const path of ['report.md','review.json','research.json']){
        const saved=await readFile(join(root,path));await writeFile(join(root,path),'tampered');
        assert.equal(verifyTheologyReviewResult(args).passed,false,path);await writeFile(join(root,path),saved);
      }
      const changed=structuredClone(result.observations);changed.find(o=>o.toolName==='workflow.execute').data.workflow.receipts.pop();
      assert.equal(verifyTheologyReviewResult({...args,observations:changed}).passed,false);
      assert.equal(verifyTheologyReviewResult({...args,beforeAccess:()=>{throw new Error('revoked');}}).passed,false);
      await rm(join(root,'review.json'));assert.equal(verifyTheologyReviewResult(args).passed,false);
    }
  }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
