import {readFileSync,lstatSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Reviewed runtime closure, not a repository or dependency-directory copy.
const runtimeFiles=[
 'scripts/dev-server.mjs','scripts/packaged-ui-reader.mjs','scripts/llm-provider-diagnostics.mjs',
 'scripts/duffel-setup-controller.mjs','scripts/duffel-setup-storage.mjs','scripts/personal-duffel-connect.mjs',
 'packages/core/src/personal-operations/private-file.js',
 'packages/core/src/personal-operations/duffel-credential-setup.js','packages/core/src/personal-operations/duffel-quote-broker.js',
 'packages/core/src/personal-operations/integration-security.js',
 'scripts/product-support-bundle.mjs','scripts/product-runtime.mjs','scripts/windows-code-signing-audit.mjs',
 'scripts/acceptance-progress-summary.mjs',
 'scripts/duffel-broker-process.mjs','scripts/duffel-credential-broker.mjs',
 'packages/core/src/personal-operations/duffel-connection-profile.js',
 'packages/core/src/personal-operations/duffel-broker-host.js','packages/core/src/personal-operations/duffel-broker-https.js',
 'packages/core/src/personal-operations/google-broker-https.js','packages/core/src/personal-operations/broker-revocation-store.js',
 'packages/shared/src/http.js','packages/shared/src/control-center-hosting.js','packages/shared/src/types.js',
 'packages/shared/src/jsonl.js','packages/shared/src/product-runtime-secrets.js','packages/shared/src/product-runtime-lock.js',
 'packages/shared/src/local-export-store.js','packages/core/src/intent/claude-cli-intent-adapter.js',
 'packages/core/src/intent/intent-parser.js','packages/core/src/intent/semantic-intent-adapter.js',
 'packages/core/src/planning/search-directory-request.js',
 'packages/core/src/intent/openai-api-protocol.js','packages/core/src/routing/news-publisher-catalog.js'
];
export function readControlCenterHostPayload({root=fileURLToPath(new URL('../../../../',import.meta.url))}={}){
 const files={};
 for(const name of runtimeFiles){
  const path=resolve(root,name),info=lstatSync(path);
  if(info.isSymbolicLink()||!info.isFile())throw new Error('PC_UI_HOST_SOURCE_INVALID');
  files[`control-center-host/${name}`]=readFileSync(path,'utf8');
 }
 for(const [name,source] of Object.entries(files))for(const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/gu)){
  const target=resolve(root,dirname(name.slice('control-center-host/'.length)),match[2]);
  if(!Object.hasOwn(files,`control-center-host/${relative(root,target).replaceAll('\\','/')}`))throw new Error(`PC_UI_HOST_IMPORT_MISSING:${name}:${match[2]}`);
 }
 files['control-center-host/package.json']=JSON.stringify({private:true,type:'module',engines:{node:'>=24'}},null,2);
 files['control-center-host/launch.mjs']=`import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('PC_UI_HOST_NODE_24_REQUIRED');
const manifest=JSON.parse(await readFile(resolve(root,'package-manifest.json'),'utf8'));
if(manifest.packageId!=='jarvis-pc-agent-windows-service')throw new Error('PC_UI_HOST_MANIFEST_INVALID');
const expected=${JSON.stringify([...runtimeFiles.map(name=>'control-center-host/'+name),'control-center-host/package.json'])};
for(const name of expected){
 const path=resolve(root,name),info=await lstat(path),actual=await realpath(path);
 const same=process.platform==='win32'?actual.toLowerCase()===path.toLowerCase():actual===path;
 if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024||!same)throw new Error('PC_UI_HOST_FILE_INVALID');
 const content=await readFile(path),hash=createHash('sha256').update(content).digest('hex');
 if(hash!==manifest.fileIntegrity?.[name]?.sha256)throw new Error('PC_UI_HOST_INTEGRITY_FAILED');
}
// Local hashes detect damaged payloads; signed release verification remains a separate gate.
process.env.HOST='127.0.0.1';
process.env.JARVIS_UI_PACKAGE_DIR=root;
process.chdir(root);
await import('./scripts/dev-server.mjs');
`;
 return files;
}
