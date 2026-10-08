import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {verifyHealthReportResult} from '../packages/core/src/mission/mission-health-report-result.js';
const objective="'records.json' 건강 기록을 '2026-02-20'부터 '2026-02-20'까지 요약해 'report.md'에 저장하고 다시 읽어 확인해줘";
const record={recordId:'one',metric:'heart_rate',value:70,unit:'bpm',observedAt:'2026-02-20T12:00:00Z',source:'synthetic-watch',sensorId:'A',dataOrigin:'test.app',recordingMethod:2};
const expected=['# 제공된 건강 기록 요약','','기간: 2026-02-20 ~ 2026-02-20 (UTC 날짜)','작성 시각: 2026-02-21T00:00:00.000Z','기록 1건 · 확인된 중복 0건 · ID 없는 기록 0건','','제공된 자료의 통계입니다. 기기·보정·측정의 비교 가능성은 검증하지 않았습니다. 의료 진단·치료 권고가 아닙니다.','날짜별 평균은 입력 표본의 평균이며 하루 전체의 건강 상태나 걸음 총합을 뜻하지 않습니다. 결측은 0으로 채우지 않습니다.','','## steps (steps)','자료 없는 UTC 날짜: 2026-02-20','','## heart_rate (bpm)','자료 없는 UTC 날짜: 없음','','출처: synthetic-watch · 앱: test.app · 센서: A · 기록 방식: 2','보정 상태(제공값): unknown · 보정 조건: null · 해당 출처 결측 0일','','| UTC 날짜 | 표본 수 | 평균 | 최솟값 | 최댓값 | 이전 기록과 간격(일) | 이전 기록 평균과 차이 |','| --- | --- | --- | --- | --- | --- | --- |','| 2026-02-20 | 1 | 70 | 70 | 70 | 없음 | 없음 |','','## sleep_duration (minutes)','자료 없는 UTC 날짜: 2026-02-20',''].join('\n')+'\n';
test('health request preserves original requirement and dependencies and never drops suffixes',()=>{
 const c=compileNaturalWorkflowObjective(objective,{workspaceRoot:tmpdir()});assert.equal(c.status,'compiled',JSON.stringify(c));
 assert.deepEqual(c.spec.nodes.map(n=>n.op),['data.readJson','health.report','write.text','text.read']);
 assert.equal(c.goalContract.requirements[0].nodeIds.length,4);
 for(const request of [objective+' 그리고 결과를 이메일로 보내',objective.replace('report.md','records.json'),objective.replace('report.md','../report.md')])assert.notEqual(compileNaturalWorkflowObjective(request,{workspaceRoot:tmpdir()}).status,'compiled');
});
for(const mode of ['valid','default-criterion','restart','conflicting','bad-calendar'])test('actual Core/E/B/G health report '+mode,async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-health-mission-'));let runtime;
 try{
  const records=['valid','default-criterion','restart'].includes(mode)?[record]:mode==='conflicting'?[record,{...record,value:90}]:[{...record,observedAt:'2026-02-30T12:00:00Z'}];
  const source=JSON.stringify({records});await writeFile(join(root,'records.json'),source);
  const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
  const options={allowedRoots:[root],auditRoot:join(root,'audit'),missionStorePath:join(root,'missions.json'),env,taskEnv:env,workerDaemonEnabled:false,clock:()=>new Date('2026-02-21T00:00:00Z'),missionRunner:async()=>{throw new Error('Model must not run');}};
  runtime=createAgRuntime(options);
  const owner=runtime.personalOwnerSession.activate({requestedBy:'synthetic-health-test',durationMinutes:5});
  const criterion=mode==='default-criterion'?{criterionId:'default',statement:`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`}:{criterionId:'exact-report',statement:'固定 원문/수치/날짜 보고서',verificationSpec:{version:1,kind:'text.equals',path:'report.md',equals:expected}};
  const mission=runtime.missionRuntime.createMission({objective,successCriteria:[criterion],authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
  const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:3});
  if(['valid','default-criterion','restart'].includes(mode)){
   assert.equal(result.status,'COMPLETED',JSON.stringify({status:result.status,stopReason:result.stopReason,observations:result.observations}));
   assert.equal(await readFile(join(root,'report.md'),'utf8'),expected);
   assert.equal(result.observations.find(o=>o.toolName==='workflow.execute').verification.status,'passed');
   if(mode==='restart'){
    const snapshot=await readFile(join(root,'missions.json'),'utf8');
    runtime.coreFacade.cognition.close();runtime=createAgRuntime(options);
    const preview=await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId);
    assert.equal(preview.status,'verified');assert.equal(preview.reportMarkdown,expected);
    assert.equal(await readFile(join(root,'missions.json'),'utf8'),snapshot,'Read-only recovery must not execute or rewrite effects');
    await writeFile(join(root,'records.json'),JSON.stringify({records:[{...record,value:90}]}));
    const changed=await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId);
    assert.equal(changed.status,'changed-or-unavailable');assert.equal(changed.reportMarkdown,undefined);
    await writeFile(join(root,'records.json'),source);
    await rm(join(root,'report.md'));
    assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).status,'changed-or-unavailable');
    assert.equal((await runtime.missionRuntime.getVerifiedHealthReport('missing')).error.code,'A_MISSION_NOT_FOUND');
   }
   if(mode==='default-criterion'){
    const input={objective,statement:criterion.statement,observations:result.observations,allowedRoots:[root]};
    assert.equal(verifyHealthReportResult(input).passed,true);
    assert.equal(verifyHealthReportResult(input).reportMarkdown,undefined);
    assert.equal((await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId)).reportMarkdown,expected);
    await writeFile(join(root,'report.md'),expected.replace('| 70 |','| 999 |'));
    assert.equal(verifyHealthReportResult(input).passed,false);
    const preview=await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId);assert.equal(preview.status,'changed-or-unavailable');assert.equal(preview.reportMarkdown,undefined);
    await writeFile(join(root,'report.md'),expected);
    const changed=structuredClone(input.observations);changed.find(o=>o.toolName==='workflow.execute').data.workflow.receipts.pop();
    assert.equal(verifyHealthReportResult({...input,observations:changed}).passed,false);
   }
  }else{assert.notEqual(result.status,'COMPLETED');await assert.rejects(readFile(join(root,'report.md')),{code:'ENOENT'});}
  assert.equal(await readFile(join(root,'records.json'),'utf8'),source);
 }finally{runtime?.coreFacade.cognition.close();await rm(root,{recursive:true,force:true});}
});
