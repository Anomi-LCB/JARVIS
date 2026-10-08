import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readControlCenterUiPayload} from './control-center-ui-payload.js';
import {readControlCenterHostPayload} from './control-center-host-payload.js';

// Reviewed source namespaces only. Never include profiles, DBs, logs or account stores.
const sourceRoots=['apps/pc-agent/src','apps/runtime-compose/src','apps/policy-security/src',
 'apps/verification/src','apps/growth-memory/src','apps/bridge/src','packages/core/src','packages/shared/src','skill-center/registry'];
export function readPcAgentRuntimePayload({root=fileURLToPath(new URL('../../../../',import.meta.url)),daemonConfig,serviceManifest}={}){
 const files={};
 const add=path=>{
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw new Error('PC_RUNTIME_SOURCE_INVALID');
  const name=relative(root,path).replaceAll('\\','/');if(name.startsWith('../'))throw new Error('PC_RUNTIME_SOURCE_OUTSIDE_ROOT');
  files[`pc-agent-runtime/${name}`]=readFileSync(path);
 };
 const walk=(path,extensions)=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const next=resolve(path,entry.name);if(entry.isSymbolicLink())throw new Error('PC_RUNTIME_SOURCE_LINK_DENIED');
  if(entry.isDirectory())walk(next,extensions);else if(extensions.test(entry.name))add(next);
 }};
 for(const name of sourceRoots)walk(resolve(root,name),/\.(?:js|mjs)$/u);
 add(resolve(root,'scripts/pc-outbound-channel.mjs'));
 add(resolve(root,'scripts/core-service-runtime.mjs'));
 // Runtime defaults resolve these reviewed, immutable fixtures beside G's source.
 for(const name of ['learning-verifier-fixtures.json','ag-simulation-expanded-scenarios.json',
  'prompt-redteam-fixtures.json','regression-external-fixtures.json','policy-compliance-fixtures.json',
  'tool-poisoning-leak-fixtures.json','ag-simulation-scenarios.json','plan-verifier-fixtures.json',
  '12d-rubric.json'])add(resolve(root,'apps/verification/fixtures',name));
 add(resolve(root,'apps/pc-agent/src/adapters/excel/native-pdf.ps1'));
 add(resolve(root,'apps/pc-agent/src/adapters/excel/native-process-guard.cs'));
 add(resolve(root,'apps/pc-agent/src/adapters/pdf/extract-text.py'));
 add(resolve(root,'apps/pc-agent/src/adapters/word/verify_tables.py'));
 for(const name of ['native-create.ps1','native-process-guard.cs'])add(resolve(root,'apps/pc-agent/src/adapters/word',name));
 // Python helpers are not found by the JS-only namespace walk. Keep the
 // generator and its independent verifier together in installed packages.
 for(const name of ['create_cards.py','verify_card_pixels.py','runtime-requirements.json'])
  add(resolve(root,'apps/pc-agent/src/adapters/visual',name));
 for(const name of ['native-create.ps1','native-process-guard.cs','verify_presentation.py'])
  add(resolve(root,'apps/pc-agent/src/adapters/powerpoint',name));
 for(const name of ['hwpx-mcp-create.py','hwpx-content-verifier.py','native-pdf.ps1','native-process-guard.cs','raster-pdf.py','inspect-owned-dialog.ps1'])
  add(resolve(root,'apps/pc-agent/src/adapters/hwpx',name));
 add(resolve(root,'scripts/hwpx-mcp-smoke.py'));
 add(resolve(root,'config/hwpx-mcp-policy.json'));
 for(const name of ['pypdf-6.19.0-py3-none-any.whl','LICENSE','provenance.json'])add(resolve(root,'apps/pc-agent/vendor/pypdf',name));
 add(resolve(root,'apps/policy-security/policies/e/default-policy.json'));
 for(const payload of [readControlCenterUiPayload({root}),readControlCenterHostPayload({root})])for(const [name,bytes] of Object.entries(payload)){
  const stripped=name.replace(/^control-center-(?:ui|host)\//u,'');
  // Host metadata/launcher are generated for the outer package, not this module root.
  if(['package.json','launch.mjs','hosting.json'].includes(stripped))continue;
  files[`pc-agent-runtime/${stripped}`]=bytes;
 }
 // Service diagnostics import the existing packager; preserve its reviewed WebView assets.
 for(const name of ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll','WebView2Loader.dll','LICENSE.txt','provenance.json'])add(resolve(root,'apps/pc-agent/vendor/webview2',name));
 const mailRoot=resolve(root,'node_modules/nodemailer');
 const mailPackage=JSON.parse(readFileSync(resolve(mailRoot,'package.json'),'utf8'));
 if(mailPackage.name!=='nodemailer'||mailPackage.version!=='6.9.14')throw new Error('PC_RUNTIME_MAIL_DEPENDENCY_VERSION_INVALID');
 walk(resolve(mailRoot,'lib'),/\.(?:js|json)$/u);add(resolve(mailRoot,'package.json'));add(resolve(mailRoot,'LICENSE'));
 const xmlDependencies={saxes:'6.0.0',xmlchars:'2.2.0'};
 for(const [name,version] of Object.entries(xmlDependencies)){
  const dependencyRoot=resolve(root,'node_modules',name);
  const metadata=JSON.parse(readFileSync(resolve(dependencyRoot,'package.json'),'utf8'));
  if(metadata.name!==name||metadata.version!==version)throw new Error('PC_RUNTIME_XML_DEPENDENCY_VERSION_INVALID');
  walk(dependencyRoot,/\.(?:js|json)$/u);add(resolve(dependencyRoot,'README.md'));
  if(name==='saxes'){
   add(resolve(root,'apps/pc-agent/vendor/saxes/LICENSE'));add(resolve(root,'apps/pc-agent/vendor/saxes/provenance.json'));
   files['pc-agent-runtime/node_modules/saxes/LICENSE']=readFileSync(resolve(root,'apps/pc-agent/vendor/saxes/LICENSE'));
  }else add(resolve(dependencyRoot,'LICENSE'));
 }
 files['pc-agent-runtime/package.json']=JSON.stringify({private:true,type:'module',engines:{node:'>=24'},dependencies:{nodemailer:'6.9.14',...xmlDependencies}},null,2);
 files['pc-agent-runtime/apps/pc-agent/install/daemon-config.json']=JSON.stringify(daemonConfig,null,2);
 files['pc-agent-runtime/apps/pc-agent/install/windows-service-manifest.json']=JSON.stringify(serviceManifest,null,2);
 const required=Object.keys(files).sort();
 const requiredIntegrity=Object.fromEntries(required.map(name=>[name,createHash('sha256').update(files[name]).digest('hex')]));
 const verifiedBootstrap=`import {readFile,lstat,realpath,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const codeRoot=dirname(fileURLToPath(import.meta.url)),packageRoot=dirname(codeRoot);
if(Number(process.versions.node.split('.')[0])<24)throw new Error('PC_RUNTIME_NODE_24_REQUIRED');
const manifest=JSON.parse(await readFile(resolve(packageRoot,'package-manifest.json'),'utf8'));
if(manifest.packageId!=='jarvis-pc-agent-windows-service')throw new Error('PC_RUNTIME_MANIFEST_INVALID');
for(const [name,expectedSha256] of Object.entries(${JSON.stringify(requiredIntegrity)})){
 const path=resolve(packageRoot,name),info=await lstat(path),actual=await realpath(path);
 const same=process.platform==='win32'?actual.toLowerCase()===path.toLowerCase():actual===path;
 if(!same||info.isSymbolicLink()||!info.isFile()||info.size>8*1024*1024)throw new Error('PC_RUNTIME_FILE_INVALID');
 const bytes=await readFile(path);if(manifest.fileIntegrity?.[name]?.sha256!==expectedSha256||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw new Error('PC_RUNTIME_INTEGRITY_FAILED');
}
`;
 files['pc-agent-runtime/launch.mjs']=verifiedBootstrap+`
const stateRoot=process.env.JARVIS_PC_AGENT_STATE_ROOT??process.cwd();
if(!isAbsolute(stateRoot))throw new Error('PC_RUNTIME_STATE_ROOT_INVALID');
// Keep writable state outside installed code; existing installations retain their explicitly selected state path.
const stateRelative=relative(packageRoot,resolve(stateRoot));
if(!stateRelative||(!stateRelative.startsWith('..'+sep)&&stateRelative!=='..'&&!isAbsolute(stateRelative)))throw new Error('PC_RUNTIME_STATE_ROOT_IS_CODE');
await mkdir(stateRoot,{recursive:true});process.chdir(stateRoot);
process.env.JARVIS_PC_DAEMON_CONFIG_PATH=resolve(codeRoot,'apps/pc-agent/install/daemon-config.json');
process.env.JARVIS_PC_SERVICE_MANIFEST_PATH=resolve(codeRoot,'apps/pc-agent/install/windows-service-manifest.json');
const {startPcAgentServiceRuntime}=await import('./apps/pc-agent/src/main.mjs');
const {close}=await startPcAgentServiceRuntime();
const shutdown=()=>{void close().then(()=>process.exit(0),()=>process.exit(1));};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
`;
 files['pc-agent-runtime/core-launch.mjs']=verifiedBootstrap+`
const stateRoot=process.env.JARVIS_CORE_STATE_ROOT;
if(!stateRoot||!isAbsolute(stateRoot))throw new Error('CORE_RUNTIME_STATE_ROOT_REQUIRED');
if(process.env.JARVIS_CORE_ROOT&&resolve(process.env.JARVIS_CORE_ROOT)!==resolve(stateRoot))throw new Error('CORE_RUNTIME_ROOT_CONFLICT');
const canonicalPackage=await realpath(packageRoot);
const checkState=path=>{const rel=relative(canonicalPackage,path);if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('CORE_RUNTIME_STATE_ROOT_IS_CODE');};
// Check existing ancestors before mkdir, including Windows junctions.
let ancestor=resolve(stateRoot);
while(true){try{checkState(resolve(await realpath(ancestor),relative(ancestor,resolve(stateRoot))));break;}
 catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
await mkdir(stateRoot,{recursive:true});
const canonicalState=await realpath(stateRoot);checkState(canonicalState);
process.chdir(canonicalState);
process.env.JARVIS_CORE_ROOT=canonicalState;
// Local package execution does not implicitly open a remote administration port.
process.env.JARVIS_CORE_HOST='127.0.0.1';
const {startCoreServiceRuntime}=await import('./scripts/core-service-runtime.mjs');
const runtime=await startCoreServiceRuntime();
const shutdown=()=>{void runtime.close().then(()=>process.exit(0),()=>process.exit(1));};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
`;
 return files;
}
