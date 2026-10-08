import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildWorkflowEvaluationArtifact} from '../packages/core/src/capabilities/workflow-artifact-builder.js';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
test('real workflow evaluation gives each independent case a fresh workspace and adapter',async t=>{
 const artifact=await buildWorkflowEvaluationArtifact({projectRoot:process.cwd(),esbuildPath:'artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js',mode:'runtime'});
 const cases=['first','second'].map(id=>({id,method:'execute',packet:{},args:{spec:{schemaVersion:'jarvis-local-workflow-v1',workflowId:id,
  nodes:[{id:'write',op:'write.text',args:{path:'result.txt',text:id}}]}},expected:{status:'success',nodeCount:1,receiptCount:1,
   files:[{name:'result.txt',text:id,sha256:sha(id),size:Buffer.byteLength(id)}]}}));
 const evaluate=createContainerCapabilityPackageEvaluator({resultContract:'local-workflow-files-v1',timeoutMs:20000,
  casesForPackage:async()=>({suiteId:'independent-file-cases-v1',cases})});
 const result=await evaluate({artifactSource:artifact.artifactSource,artifactSha256:artifact.artifactSha256,packageDigest:sha('workspace-isolation'),
  manifest:{packageId:'test.independent-workspaces',version:'1'},toolName:'workflow.execute'});
 t.diagnostic(JSON.stringify({status:result.status,caseResults:result.receipt.caseResults,restrictions:result.receipt.restrictions}));
 assert.equal(result.status,'passed');assert.equal(result.receipt.passedCount,2);
});
