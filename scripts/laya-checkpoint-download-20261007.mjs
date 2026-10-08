import {mkdirSync,createWriteStream,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {dirname,resolve} from 'node:path';
const repo='convaiinnovations/laya-multilingual',revision='1720e3e3357cfe1e281542e223f8273b0890ca34';
const files=['README.md','config.json','encoder/config.json','model.safetensors','rl_agent_config.json','tokenizer/tokenizer.json','tokenizer/tokenizer_config.json'];
const root=resolve('.runtime/laya-eval-20261007/model');mkdirSync(root,{recursive:true});
const manifest=[];
for(const file of files){
 const path=resolve(root,file);if(!path.startsWith(root+'\\')&&!path.startsWith(root+'/'))throw Error('path');
 mkdirSync(dirname(path),{recursive:true});
 if(existsSync(path))throw Error('Existing checkpoint file must be inspected before resuming: '+file);
 const url=`https://huggingface.co/${repo}/resolve/${revision}/${file}`;
 const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('HTTP '+response.status);
 await pipeline(Readable.fromWeb(response.body),createWriteStream(path,{flags:'wx'}));
 const bytes=readFileSync(path);manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 console.log(JSON.stringify(manifest.at(-1)));
}
writeFileSync('artifacts/laya-checkpoint-20261007.json',JSON.stringify({observedAt:new Date().toISOString(),repo,revision,files:manifest,downloadedOnly:true,inferenceVerified:false},null,2)+'\n',{flag:'wx'});
