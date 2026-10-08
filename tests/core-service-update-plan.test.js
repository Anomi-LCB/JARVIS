import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoreServiceLifecyclePlan,verifyCoreServiceReadiness} from '../packages/core/src/install/core-service-planner.js';
import {createCoreServicePackagePlan,writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
test('legacy update plans and generated scripts cannot silently stop or overwrite a service',async()=>{
 const plan=createCoreServiceLifecyclePlan({action:'update'});
 assert.doesNotMatch(plan.commands.join('\n'),/Stop-Service|Start-Service|sc\.exe config|New-Service/);
 assert.match(plan.commands.join('\n'),/CORE_UPDATE_TRANSACTIONAL_PACKAGE_REQUIRED/);
 const readiness=await verifyCoreServiceReadiness({plan});assert.equal(readiness.status,'blocked');
 assert.equal(readiness.checks.find(c=>c.id==='transactional-update-entry').status,'fail');
 const pkg=createCoreServicePackagePlan();const update=pkg.files['update-service.ps1'];
 assert.match(update,/CORE_UPDATE_INSTALLED_RUNTIME_REQUIRED/);assert.doesNotMatch(update,/Stop-Service|Start-Service|sc\.exe config|build-service-host/);
});
test('bound update plan invokes the generated transaction instead of emitting raw SCM reconfiguration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-update-plan-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runtimeRoot=join(process.cwd(),'artifacts/core-installed-runtime-binding-20261003/pc-package');
 const manifest=JSON.parse(await readFile(join(runtimeRoot,'package-manifest.json'),'utf8'));
 const pkg=await writeCoreServicePackage({outputDir:join(root,'package'),installedRuntime:{packageRoot:runtimeRoot,stateRoot:join(root,'state'),
  launcherSha256:manifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:manifest.fileIntegrity['runtime/node.exe'].sha256}});
 const metadata=pkg.manifest;
 const plan=createCoreServiceLifecyclePlan({action:'update',cwd:metadata.installedRuntime.stateRoot,entryScript:metadata.entryPath,updatePackageRoot:pkg.outputDir});
 assert.equal(plan.commands.length,1);assert.match(plan.commands[0],/update-service\.ps1/);
 assert.doesNotMatch(plan.commands[0],/sc\.exe|Stop-Service/);
 const readiness=await verifyCoreServiceReadiness({plan});assert.equal(readiness.checks.find(c=>c.id==='transactional-update-entry').status,'pass');
});
