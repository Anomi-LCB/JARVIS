import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
const root=resolve(process.argv[2]??'artifacts/lifecycle-case-package-pilot-20261008'),outputDir=resolve(root,'package');
if(!root.startsWith(resolve('artifacts')+sep))throw Error('PILOT_ARTIFACT_ROOT_REQUIRED');
try{await access(root);throw Error('PILOT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(root);
const nodeRoot=resolve('artifacts/bundled-node-runtime-20261003/package/runtime');
const provenance=JSON.parse(await readFile(resolve(nodeRoot,'node-provenance.json'),'utf8'));
const plan=await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir,pcAgentStateRoot:resolve(root,'state'),bundledNodeRuntime:{executablePath:resolve(nodeRoot,'node.exe'),licensePath:resolve(nodeRoot,'Node-LICENSE.txt'),expectedSha256:provenance.sha256,version:provenance.version}});
const paths=['pc-agent-runtime/apps/runtime-compose/src/lifecycle-case-service-access.js','pc-agent-runtime/packages/core/src/mission/lifecycle-case-task-receipts.js','pc-agent-runtime/scripts/core-service-runtime.mjs','control-center-ui/src/ui/workspace/lifecycle-case-mission-client.js','pc-agent-runtime/core-launch.mjs','runtime/node.exe'];
const files=await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(outputDir,path))).digest('hex')})));
for(const file of files)if(plan.manifest.fileIntegrity[file.path]?.sha256!==file.sha256)throw Error('PILOT_FILE_NOT_BOUND');
await writeFile(resolve(root,'summary.json'),JSON.stringify({observedAt:new Date().toISOString(),outputDir,nodeVersion:provenance.version,files,fileCount:Object.keys(plan.manifest.fileIntegrity).length,installed:false,nativeExecutablesCompiled:false,windowsSignatureVerified:false,externalProviderVerified:false},null,2),{flag:'wx'});
console.log(JSON.stringify({outputDir,fileCount:Object.keys(plan.manifest.fileIntegrity).length,installed:false}));
