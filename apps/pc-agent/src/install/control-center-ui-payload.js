import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Static product source only: no profiles, accounts, logs or runtime databases. */
export function readControlCenterUiPayload({root=fileURLToPath(new URL('../../../../',import.meta.url))}={}){
 const files={};
 const add=path=>{
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error('PC_UI_PAYLOAD_FILE_INVALID');
  const name=relative(root,path).replaceAll('\\','/');
  if(name.startsWith('../'))throw new Error('PC_UI_PAYLOAD_OUTSIDE_ROOT');
  files[`control-center-ui/${name}`]=readFileSync(path,'utf8');
 };
 const walk=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const next=resolve(path,entry.name);if(entry.isSymbolicLink())throw new Error('PC_UI_PAYLOAD_SYMLINK');
  if(entry.isDirectory())walk(next);else if(/\.(js|css|html)$/u.test(entry.name))add(next);
 }};
 add(resolve(root,'index.html'));walk(resolve(root,'src/ui'));walk(resolve(root,'src/domain'));
 for(const name of ['packages/shared/src/command-lane.js','packages/shared/src/control-center-hosting.js','packages/shared/src/pc-local-denial.js','packages/shared/src/workflow-failure-guidance.js','packages/shared/src/source-change-view.js','packages/core/src/runtime/korean-weekly-routine-command.js'])add(resolve(root,name));
 add(resolve(root,'packages/shared/src/chatgpt-export-conversion.js'));
 add(resolve(root,'packages/shared/src/chatgpt-export-file.js'));
 // Refuse incomplete JS graphs rather than quietly shipping missing modules.
 for(const [name,source] of Object.entries(files))if(name.endsWith('.js')){
  for(const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/gu)){
   const target=resolve(root,dirname(name.slice('control-center-ui/'.length)),match[2]);
   const key=`control-center-ui/${relative(root,target).replaceAll('\\','/')}`;
   if(!Object.hasOwn(files,key))throw new Error(`PC_UI_PAYLOAD_IMPORT_MISSING:${name}:${match[2]}`);
  }
 }
 files['control-center-ui/hosting.json']=JSON.stringify({version:3,staticPayloadIncluded:true,apiServerIncluded:true,automaticallyHosted:false,nativeOnDemandHosting:true,
  launcher:'control-center-host/launch.mjs',requires:'Node.js 24 or later; existing configured Core/PC/Bridge services and server-side credentials',
  nextAction:'Run node control-center-host/launch.mjs from this package; API routes retain separately configured authenticated services.'},null,2);
 return files;
}
