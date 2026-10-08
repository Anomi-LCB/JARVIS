import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';

for (const [amount, expectedReason] of [['0.5원 이하', 'goal-amount-unresolved'],
  ['1억 2,500만원 이하', 'goal-amount-effect-unverified'],
  ['USD 12.34 이하','goal-amount-effect-unverified'],
  ['$12.34 이하','goal-amount-unresolved'],
  ['JPY 0.5 이하','goal-amount-unresolved']]) {
  test(`real PC/G local preparation and persisted money guard: ${amount}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-money-runtime-'));
    const source = '격리 시험의 원자료';
    const output = '격리 시험의 준비 문서';
    const hash = createHash('sha256').update(output).digest('hex');
    await writeFile(join(root,'source.txt'), source);
    const calls = [];
    const planner = {async planNextWave(context) {
      const ids = context.mission.goalContract.requirements.map(r => r.requirementId);
      return {decision: 'continue', actions: [
        {id:'read', title:'원자료 읽기', command:'source.txt 내용을 읽어줘',
          expectedToolName:'filesystem.readText', arguments:{path:join(root,'source.txt')}, requirementIds:[ids[0]], dependencies:[]},
        {id:'save', title:'준비 문서 저장', command:'draft.txt 텍스트 파일을 만들어줘',
          expectedToolName:'filesystem.createTextFile', arguments:{path:join(root,'draft.txt'),content:output}, requirementIds:[ids[1]], dependencies:['read']},
        {id:'send', title:'발송 계획 검증', command:'이메일로 보내줘', expectedToolName:'email.send',
          arguments:{recipientMode:'self',subject:'격리 시험',body:'격리 시험',attachments:[
            {attachmentRef:{rootIndex:0,relativePath:'draft.txt'},attachmentSha256:hash}]}, requirementIds:[ids[2]],dependencies:['save']}
      ], criteriaAssessment:[]};
    }};
    const env = {JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',
      JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0'};
    const runtime = createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env,taskEnv:env,
      missionStorePath:join(root,'missions.json'),missionPlanner:planner,workerDaemonEnabled:false});
    t.after(async () => {
      runtime.coreFacade.cognition.close();
      assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
      await rm(root,{recursive:true,force:true});
    });
    // Synthetic readiness isolates the guard from missing credentials. The
    // external worker remains forbidden even if the guard regresses.
    runtime.missionRuntime.capabilityAvailabilityGuard.assess = async () => ({required:false});
    const original = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask = async (taskId, ...rest) => {
      const tool = runtime.coreFacade.getTask(taskId).plan.action.toolName;
      calls.push(tool);
      if (tool === 'email.send') throw new Error('ISOLATED_TEST_NO_EXTERNAL_DISPATCH');
      return original(taskId,...rest);
    };
    const created = runtime.missionRuntime.createMission({
      objective:`'source.txt'를 읽어; 'draft.txt'를 저장해; ${amount} 'draft.txt'를 보내`,
      authorization:{grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]},
      successCriteria:[{criterionId:'draft',statement:'준비 문서 실제 내용',verificationSpec:{version:1,kind:'text.equals',path:'draft.txt',equals:output}}]});
    const result = await runtime.missionRuntime.runMission(created.missionId);
    const mission = runtime.missionRuntime.getMission(created.missionId);
    assert.equal(result.status,'PAUSED',JSON.stringify({status:result.status,reason:result.stopReason,calls}));
    assert.deepEqual(calls,['filesystem.readText','filesystem.createTextFile']);
    assert.equal(await readFile(join(root,'draft.txt'),'utf8'),output);
    const actions = mission.waves.flatMap(w => w.actions);
    const send = actions.find(a => a.expectedToolName === 'email.send');
    assert.equal(send.attempts,0);
    assert.ok(send.requirementCoverage.reasons.some(r => r.code === expectedReason),JSON.stringify(send));
    assert.equal(mission.observations.filter(o => o.verification?.status === 'passed').length,2);
    const persisted = JSON.parse(await readFile(join(root,'missions.json'),'utf8'));
    assert.ok(JSON.stringify(persisted).includes(expectedReason));
    const observation = {observedAt:new Date().toISOString(),amount,expectedReason,status:mission.status,calls,
      amounts:mission.goalContract.amounts,sendAttempts:send.attempts,
      gResults:mission.observations.map(o => ({toolName:o.toolName,status:o.verification?.status})),
      outputSha256:hash,actualPcAndG:true,readiness:'synthetic',externalCalls:0,cost:'unmeasured'};
    console.log(JSON.stringify({moneyRuntimeEvidence:observation}));
    if (process.env.JARVIS_MONEY_EVIDENCE_PREFIX) await writeFile(
      `${process.env.JARVIS_MONEY_EVIDENCE_PREFIX}-${createHash('sha256').update(amount).digest('hex').slice(0,12)}.json`,
      JSON.stringify(observation,null,2)+'\n',{flag:'wx'});
  });
}
