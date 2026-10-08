import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildWorkflowEvaluationArtifact, verifyWorkflowEvaluationSources} from '../scripts/build-workflow-evaluation-artifact.mjs';
import {createContainerCapabilityPackageEvaluator} from '../packages/core/src/capabilities/container-capability-package-evaluator.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const options={projectRoot:process.cwd(), esbuildPath:'artifacts/evaluation-build-tools-20261006/node_modules/esbuild/lib/main.js'};
let artifact;
test('actual adapter and XML dependency bytes form a repeatable standalone artifact',async()=>{
 artifact=await buildWorkflowEvaluationArtifact(options);
 assert.equal(await verifyWorkflowEvaluationSources(artifact,process.cwd()),true);
 assert.ok(artifact.sourceManifest.some(f=>f.path.includes('node_modules/saxes/')));
 assert.ok(artifact.sourceManifest.some(f=>f.path.includes('node_modules/xmlchars/')));
 const again=await buildWorkflowEvaluationArtifact(options);
 assert.equal(artifact.artifactSha256,again.artifactSha256);
 assert.equal(artifact.sourceManifestSha256,again.sourceManifestSha256);
 await assert.rejects(verifyWorkflowEvaluationSources({...artifact,artifactSource:artifact.artifactSource+'\n'},process.cwd()),{code:'WORKFLOW_BUILD_MANIFEST_MISMATCH'});
 const altered=structuredClone(artifact);altered.sourceManifest[0].sha256='0'.repeat(64);altered.sourceManifestSha256=sha(JSON.stringify(altered.sourceManifest));
 await assert.rejects(verifyWorkflowEvaluationSources(altered,process.cwd()),{code:'WORKFLOW_BUILD_SOURCE_CHANGED'});
 for(const sourceManifest of [[],[artifact.sourceManifest[0],artifact.sourceManifest[0]],[{path:'invalid',size:-1,sha256:'bad'}]]) {
  await assert.rejects(verifyWorkflowEvaluationSources({...artifact,sourceManifest},process.cwd()),{code:'WORKFLOW_BUILD_MANIFEST_INVALID'});
 }
});
test('actual pinned offline container writes and re-reads UTF-8 files and rejects traversal through real workflow adapter',async t=>{
 artifact??=await buildWorkflowEvaluationArtifact(options);
 const text='실제 워크플로 파일 검증\n';
 const spec={schemaVersion:'jarvis-local-workflow-v1',workflowId:'real-artifact',nodes:[{id:'write',op:'write.text',args:{path:'out/result.txt',text}}]};
 const evaluator=createContainerCapabilityPackageEvaluator({maxEvaluations:1,casesForPackage:async()=>({suiteId:'real-workflow-artifact-original',cases:[
  {id:'write-read',method:'execute',args:{spec},packet:{taskId:'evaluation-only'},expected:{status:'success',nodeCount:1,receiptCount:1,files:[{name:'out/result.txt',text,sha256:sha(text),size:Buffer.byteLength(text)}]}},
  {id:'traversal',method:'execute',args:{spec:{...spec,workflowId:'traversal',nodes:[{id:'write',op:'write.text',args:{path:'../escape.txt',text:'forbidden'}}]}},packet:{},expected:{status:'blocked',errorCode:'WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT'}}
 ]})});
 const result=await evaluator({stageId:'actual-workflow-artifact',toolName:'workflow.execute',packageDigest:sha(artifact.sourceManifestSha256),artifactSource:artifact.artifactSource,artifactSha256:artifact.artifactSha256,manifest:{packageId:'actual.workflow.evaluation',version:'1'}});
 t.diagnostic(JSON.stringify({result,sourceManifest:artifact.sourceManifest,scope:artifact.scope}));
 assert.equal(result.actualIsolatedExecution,true);
 assert.equal(result.status,'passed');
});
