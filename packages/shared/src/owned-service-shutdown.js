import {createInterface} from 'node:readline';

// Private parent-owned stdin, never an HTTP endpoint or a task argument.
export function attachOwnedServiceShutdown({env=process.env,input=process.stdin,close,exit=code=>process.exit(code)}={}){
 if(env.JARVIS_WINDOWS_SERVICE!=='1'||env.JARVIS_CORE_SERVICE_STDIN_SHUTDOWN!=='1')return ()=>{};
 const reader=createInterface({input,crlfDelay:Infinity});let disposed=false,stopping=false;
 const shutdown=()=>{if(disposed||stopping)return;stopping=true;Promise.resolve().then(close).then(()=>exit(0),()=>exit(1));};
 reader.on('line',line=>{if(line==='JARVIS_CORE_SERVICE_STOP_V1')shutdown();});
 reader.on('close',shutdown);
 return ()=>{disposed=true;reader.close();input.pause();};
}
