import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflowEvaluationArtifact,loadBuiltWorkflowCapability,identifyBuiltWorkflowCapability,assertBuiltWorkflowCapability} from '../packages/core/src/capabilities/workflow-artifact-builder.js';
test('release identity preserves admitted executable and judge and cannot admit a cloned or forged definition',async()=>{
 const loaded=await loadBuiltWorkflowCapability(await buildWorkflowEvaluationArtifact({projectRoot:process.cwd(),esbuildPath:'artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js',mode:'runtime'}));
 const identity={packageId:'jarvis.reviewed-release',version:'1.14.0',skillId:'reviewed_release'};
 const revised=identifyBuiltWorkflowCapability(loaded,identity);
 assert.equal(assertBuiltWorkflowCapability(revised),revised);assert.equal(revised.createAdapter,loaded.createAdapter);
 assert.equal(revised.verifyEvidence,loaded.verifyEvidence);assert.equal(revised.artifactSha256,loaded.artifactSha256);
 assert.deepEqual(revised.skill.capability,loaded.skill.capability);assert.ok(Object.isFrozen(revised));assert.ok(Object.isFrozen(revised.skill));
 assert.throws(()=>identifyBuiltWorkflowCapability({...loaded},identity),{code:'WORKFLOW_RUNTIME_DEFINITION_NOT_ADMITTED'});
 assert.throws(()=>identifyBuiltWorkflowCapability(loaded,identity,{...loaded,verifyEvidence:()=>true}),{code:'WORKFLOW_RUNTIME_DEFINITION_NOT_ADMITTED'});
 assert.throws(()=>identifyBuiltWorkflowCapability(loaded,{...identity,version:'unlimited'}),{code:'WORKFLOW_RUNTIME_IDENTITY_INVALID'});
});
