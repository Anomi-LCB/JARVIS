import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const [role,mode,endpoint,rootScope='']=process.argv.slice(2);
const root='/tmp/isolated-mission';
mkdirSync(root,{recursive:true});
const child=fork(new URL('./remote-mission-effect-child.mjs',import.meta.url),[role,root,mode,endpoint,rootScope],
  {stdio:['ignore','ignore','inherit','ipc']});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
child.on('message',value=>emit(value.type==='ready'?{...value,uid:process.getuid(),capabilities:readFileSync('/proc/self/status','utf8').match(/^CapEff:\s*(\w+)/mu)?.[1],mountNamespace:readlinkSync('/proc/self/ns/mnt'),networkNamespace:readlinkSync('/proc/self/ns/net')}:value));
child.on('exit',code=>{if(role==='core')process.exit(code??1);});
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  try{
    const value=JSON.parse(line);
    if(value?.type==='probe'){
      const contents=Object.fromEntries(['source','report','table','card'].map(kind=>[kind,JSON.parse(readFileSync(join(root,'workspace',`${kind}.json`),'utf8'))]));
      const calls=readFileSync(join(root,'remote-adapter.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const reads=readFileSync(join(root,'pc-observer.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      emit({type:'probe',contents,calls,reads});
    }else child.send(value);
  }catch(error){emit({type:'error',message:error.message});}
});
