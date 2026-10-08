import {createVerifiedWordDocument} from '../../apps/pc-agent/src/adapters/word/native-authoring.js';
const controller=new AbortController();let host;
process.stdin.on('data',data=>{if(data.toString().trim()==='cancel')controller.abort();else if(data.toString().trim()==='kill-native')host?.kill();});
try{
 await createVerifiedWordDocument(process.argv[2],{signal:controller.signal,onNativeStart:child=>{host=child;console.log(JSON.stringify({hostPid:child.pid,parentPid:process.pid}));}});
 console.log(JSON.stringify({status:'complete'}));
}catch(error){console.log(JSON.stringify({status:'failed',code:error.code??error.name,message:error.message,nativeRecovery:error.nativeRecovery??null}));}
