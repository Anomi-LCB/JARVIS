import {NativeHancomPdfRenderer} from '../apps/pc-agent/src/adapters/hwpx/native-pdf-renderer.js';
import {normalizeDocBlocks,expectedDocContentItems} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const suffix=process.argv[2]??'';if(suffix&&!/^[a-z0-9-]+$/u.test(suffix))throw Error('suffix invalid');
const root=resolve('artifacts/hancom-native-render-20261007'+(suffix?'-'+suffix:''));await mkdir(root,{recursive:true});
const renderer=new NativeHancomPdfRenderer({allowedRoots:[resolve('artifacts')],timeoutMs:45000});
for(const [format,pilotPath] of [['hwp','artifacts/hwp-owned-publication-20261007/pilot.json'],['hwpx','artifacts/hwpx-content-20261007/pilot.json']]){
 const pilot=JSON.parse(await readFile(pilotPath,'utf8')),doc=normalizeDocBlocks(pilot.args),started=Date.now();
 try{
  const result=await renderer.render({inputPath:pilot.result.outputPaths[0],expectedSha256:pilot.result.sha256,expectedText:expectedDocContentItems(doc),expectedTableCount:doc.tableCount,expectedDocument:doc,outputDirectory:resolve(root,format)});
  await writeFile(resolve(root,format+'-result.json'),JSON.stringify({observedAt:new Date().toISOString(),durationMs:Date.now()-started,result},null,2),{flag:'wx'});console.log(JSON.stringify({format,status:result.status,pageCount:result.pageCount}));
 }catch(error){await writeFile(resolve(root,format+'-failure.json'),JSON.stringify({observedAt:new Date().toISOString(),durationMs:Date.now()-started,code:error.code,message:error.message,nativeDiagnostic:error.nativeDiagnostic,nativePhases:error.nativePhases},null,2),{flag:'wx'});throw error;}
}
