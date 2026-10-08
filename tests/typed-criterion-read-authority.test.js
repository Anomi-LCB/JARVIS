import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyTypedCriterion,verifyArtifactConsistencyCriterion} from '../packages/core/src/mission/criteria-evidence.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'jarvis-typed-read-authority-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'result.txt'),content='synthetic public result';
  await writeFile(path,content);
  const evidence={rootIndex:0,relativePath:'result.txt',pathHash:hash(path),contentSha256:hash(content),outsideAllowedRoots:false};
  const observation={actionId:'a',outcome:'success',verification:{status:'passed'},artifacts:[evidence],data:{fileEvidence:evidence}};
  return {root,path,observation,criterion:{statement:'정확한 내용',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:content}}};
}
for(const role of ['input','output'])for(const mode of ['allowed','revoked','revoked-after-read']){
  test(`typed current file ${role}: ${mode}`,async t=>{
    const f=await fixture(t);let calls=0;
    const beforeAccess=access=>{
      calls++;assert.equal(access.path,f.path);assert.equal(access.kind,'read');
      if(mode==='revoked'||mode==='revoked-after-read'&&calls===2)throw Error('revoked');
    };
    const proof=verifyTypedCriterion({criterion:{...f.criterion,artifactRole:role},observations:[f.observation],
      evidenceActionIds:['a'],allowedRoots:[f.root],beforeAccess});
    assert.equal(proof.passed,mode==='allowed');
    assert.equal(calls,mode==='revoked'?1:2);
    if(mode!=='allowed')assert.ok(proof.reasons.includes('criterion-result-read-permission-unavailable'));
  });
}
test('denied typed verifier does not reveal whether a G-bound file still exists',async t=>{
  const f=await fixture(t);
  const verify=()=>verifyTypedCriterion({criterion:f.criterion,observations:[f.observation],evidenceActionIds:['a'],
    allowedRoots:[f.root],beforeAccess:()=>{throw Error('denied');}});
  const present=verify();await rm(f.path);
  assert.deepEqual(verify(),present);
  assert.deepEqual(present.reasons,['criterion-result-read-permission-unavailable']);
});
for(const mode of ['allowed','revoked','guard-unavailable'])test(`Core typed criterion honors Mission read authority: ${mode}`,async t=>{
  const f=await fixture(t);
  const env={JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
  const runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),env,taskEnv:env,workerDaemonEnabled:false});
  t.after(()=>{runtime.pcAgent.remoteOperationStore?.close();runtime.coreFacade.cognition.close();});
  let calls=0;
  runtime.missionRuntime.executionBudget=mode==='guard-unavailable'?null:{beforeResultRead(mission,access){
    calls++;assert.equal(mission.executionMandateId,'synthetic-mandate');assert.equal(access.path,f.path);
    if(mode==='revoked')throw Error('revoked');
  }};
  const proof=runtime.missionRuntime.verifyCriterionEvidence({executionMandateId:'synthetic-mandate',
    objective:'현재 결과 확인',observations:[f.observation],waves:[]},f.criterion,['a']);
  assert.equal(proof.passed,mode==='allowed');
  assert.equal(calls,mode==='allowed'?2:mode==='revoked'?1:0);
  if(mode!=='allowed')assert.ok(proof.reasons.includes('criterion-result-read-permission-unavailable'));
});

for(const spec of [
  {version:1,kind:'artifact.consistency',sourcePath:'source.json',reportPath:'report.json',tablePath:'table.json',cardPath:'card.json'},
  {version:1,kind:'research.sourceTrace',path:'trace.json',reportPath:'report.md',minimumSources:1}
])test(`${spec.kind} forwards current read authority`,async t=>{
  const f=await fixture(t);let calls=0;
  const proof=verifyTypedCriterion({criterion:{verificationSpec:spec},observations:[],evidenceActionIds:[],allowedRoots:[f.root],
    beforeAccess:()=>{calls++;throw Error('revoked');}});
  assert.equal(calls,1);assert.equal(proof.passed,false);
  assert.deepEqual(proof.reasons,['criterion-result-read-permission-unavailable']);
});

test('multi-file comparison rechecks every file authority after collecting bytes',async t=>{
  const f=await fixture(t),otherPath=join(f.root,'other.txt');await writeFile(otherPath,'second');
  f.observation.artifacts.push({rootIndex:0,relativePath:'other.txt',pathHash:hash(otherPath),contentSha256:hash('second')});
  let calls=0,compared=0;
  const proof=verifyArtifactConsistencyCriterion({spec:{},observations:[f.observation],evidenceActionIds:['a'],roots:[f.root],
    filePaths:{first:f.path,last:otherPath},compare:()=>{compared++;return {passed:true,status:'passed'};},
    beforeAccess:access=>{calls++;if(calls===3){assert.equal(access.path,f.path);throw Error('source grant revoked while collecting later file');}}});
  assert.equal(compared,0);assert.equal(calls,3);assert.equal(proof.passed,false);
  assert.deepEqual(proof.reasons,['criterion-result-read-permission-unavailable']);
});
