import {MacroStore} from '../../packages/core/src/macro-store.js';
const [path,boundary]=process.argv.slice(2),store=new MacroStore({path});let checks=0,snapshots=0;
const stop=()=>{process.send({type:'boundary',pid:process.pid,boundary});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(boundary==='published'){const snapshot=store.snapshot.bind(store);store.snapshot=()=>{if(++snapshots===3)stop();return snapshot();};}
process.send({type:'ready',pid:process.pid});
process.once('message',()=>{const result=store.save('pending','pending command',{assertAccess(){checks++;if((boundary==='lock'&&checks===2)||(boundary==='stage'&&checks===3))stop();}});process.send({type:'result',result});process.disconnect();});
