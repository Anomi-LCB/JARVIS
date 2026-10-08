import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeWorkbookPdfRenderer} from '../../apps/pc-agent/src/adapters/excel/native-pdf-renderer.js';
const [inputPath,outputPath]=process.argv.slice(2);
const hash=createHash('sha256').update(await readFile(inputPath)).digest('hex');
let nativeChild;const controller=new AbortController();
process.stdin.on('data',data=>{const command=data.toString().trim();if(command==='kill-native'&&nativeChild)nativeChild.kill('SIGKILL');if(command==='cancel')controller.abort();});
const renderer=new NativeWorkbookPdfRenderer({spawnProcess(executable,args,options){
 const child=spawn(executable,args,options);
 nativeChild=child;
 console.log(JSON.stringify({nativeHostPid:child.pid,receiptDirectory:args[args.indexOf('-OutputDirectory')+1]}));
 return child;
}});
try{await renderer.render({inputPath,outputPath,expectedSha256:hash,signal:controller.signal});console.log('EXPORT_FINISHED');}
catch(error){console.log(JSON.stringify({nativeError:error.code??error.message,nativeRecovery:error.nativeRecovery??null}));process.exitCode=1;}
