import {SourceTextModule} from 'node:vm';
import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]);let modules=0;const missing=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 const path=resolve(dir,entry.name);if(entry.isDirectory())await walk(path);
 else if(/\.(?:js|mjs)$/u.test(entry.name)){
  const module=new SourceTextModule(await readFile(path,'utf8'));modules++;
  for(const spec of module.dependencySpecifiers)if(spec.startsWith('.')){
   const target=resolve(dirname(path),spec);try{if(!(await stat(target)).isFile())throw new Error();}catch{missing.push({file:relative(root,path),specifier:spec});}
  }else if(!spec.startsWith('node:')){
   if(!['saxes','xmlchars'].includes(spec))throw new Error('UNREVIEWED_STATIC_PACKAGE:'+spec);
   const target=createRequire(pathToFileURL(path)).resolve(spec);
   if(!target.startsWith(resolve(root,'node_modules')+'\\')&&!target.startsWith(resolve(root,'node_modules')+'/'))throw new Error('PACKAGE_ESCAPED_RUNTIME:'+spec);
  }
 }
}}
await walk(root);console.log(JSON.stringify({modules,missing}));if(missing.length)process.exitCode=1;
