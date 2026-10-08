import {readFile,writeFile,mkdir,access} from 'node:fs/promises';import {resolve,sep} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
const root=resolve(process.argv[2]??'artifacts/microsoft-package-pilot-20261008'),outputDir=resolve(root,'package');
if(!root.startsWith(resolve('artifacts')+sep))throw Error('PILOT_ARTIFACT_ROOT_REQUIRED');
try{await access(root);throw Error('PILOT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(root);const nodeRoot=resolve('artifacts/bundled-node-runtime-20261003/package/runtime'),provenance=JSON.parse(await readFile(resolve(nodeRoot,'node-provenance.json'),'utf8'));
const config=await loadPcAgentInstallConfig({daemonConfigPath:'apps/pc-agent/install/daemon-config.json',serviceManifestPath:'apps/pc-agent/install/windows-service-manifest.json'});
const plan=await writeInstallerPackage({...config,outputDir,pcAgentStateRoot:resolve(root,'state'),bundledNodeRuntime:{executablePath:resolve(nodeRoot,'node.exe'),licensePath:resolve(nodeRoot,'Node-LICENSE.txt'),expectedSha256:provenance.sha256,version:provenance.version}});
const paths=['pc-agent-runtime/packages/core/src/personal-operations/microsoft-collection-effects.js','pc-agent-runtime/packages/core/src/mission/microsoft-collection-task-receipts.js','pc-agent-runtime/scripts/core-service-runtime.mjs','pc-agent-runtime/packages/core/src/main.mjs','control-center-ui/src/ui/connections/microsoft.html','control-center-ui/src/ui/connections/microsoft.js','control-center-ui/src/ui/connections/microsoft-mission-client.js','pc-agent-runtime/apps/pc-agent/src/install/desktop-features.js','pc-agent-runtime/core-launch.mjs','control-center-host/launch.mjs','runtime/node.exe'];
const files=await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(outputDir,path))).digest('hex')})));
for(const file of files)if(plan.manifest.fileIntegrity[file.path]?.sha256!==file.sha256)throw Error('PILOT_FILE_NOT_BOUND');
const binding={packageRoot:outputDir,stateRoot:resolve(root,'state'),launcherSha256:plan.manifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:provenance.sha256},authority={id:'service:'+randomUUID(),initialExpectedToken:0,ttlMs:30000};
await writeFile(resolve(root,'binding.json'),JSON.stringify(binding),{flag:'wx'});await writeFile(resolve(root,'authority.json'),JSON.stringify(authority),{flag:'wx'});
const core=await writeCoreServicePackage({outputDir:resolve(root,'core-service'),installedRuntime:binding,serviceAuthority:authority,logs:{workerDaemonAutostart:false}});
await writeFile(resolve(root,'summary.json'),JSON.stringify({observedAt:new Date().toISOString(),outputDir,corePackage:core.outputDir,nodeVersion:provenance.version,files,fileCount:Object.keys(plan.manifest.fileIntegrity).length,installed:false,nativeExecutablesCompiled:false,windowsSignatureVerified:false,externalProviderVerified:false,syntheticState:true},null,2),{flag:'wx'});
console.log(JSON.stringify({outputDir,corePackage:core.outputDir,fileCount:Object.keys(plan.manifest.fileIntegrity).length,installed:false}));
