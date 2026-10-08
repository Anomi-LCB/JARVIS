import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join,sep} from 'node:path';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';import {createInterface} from 'node:readline';
const root=await mkdtemp(join(tmpdir(),'jarvis-clarification-restart-'));
let worker,workerReady,ui,stopping=false;const history=[],failedTakeovers=[];
async function launch(phase,port=0,expectedToken=0){
 worker=spawn(process.execPath,['tests/fixtures/clarification-restart-core.mjs',root,phase,String(port),String(expectedToken)],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
 const current=worker,ready=await new Promise((done,reject)=>{current.once('message',done);current.once('exit',c=>reject(Error('CORE_EXIT:'+c)));});
 if(ready.type!=='ready'){if(current.exitCode===null)await new Promise(r=>current.once('exit',r));throw Error(ready.code??'CORE_NOT_READY');}
 workerReady=ready;history.push({pid:ready.pid,phase,token:ready.authority.token,keySha256:ready.keySha256,readyAt:new Date().toISOString()});return ready;
}
function observe(){const current=worker,requestId=crypto.randomUUID();return new Promise((done,reject)=>{
 const exited=c=>{current.off('message',receive);reject(Error('CORE_OBSERVE_EXIT:'+c));};
 const receive=m=>{if(m.requestId===requestId){current.off('message',receive);current.off('exit',exited);done(m);}};
 current.on('message',receive);current.once('exit',exited);current.send({type:'observe',requestId});});}
async function stopWorker(){const current=worker;if(current.exitCode!==null)return;await new Promise((done,reject)=>{current.once('exit',c=>c===0?done():reject(Error('CORE_STOP_EXIT:'+c)));current.send({type:'stop'});});}
await launch('seed');
const control=createServer(async(req,res)=>{try{
 if(req.method==='POST'&&['/restart','/crash'].includes(req.url)){const old=await observe(),port=workerReady.port;
  if(req.url==='/crash'){
   const current=worker;await new Promise(done=>{current.once('exit',done);current.kill();});
   let refused=false;try{await launch('restore',port,old.authority.token);}catch(error){if(!error.message.includes('A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE'))throw error;refused=true;failedTakeovers.push({code:error.message,beforeExpiry:Date.now()<old.authority.expiresMs,oldPid:old.pid,leaseExpiresAt:new Date(old.authority.expiresMs).toISOString(),refusedAt:new Date().toISOString()});}
   if(!refused)throw Error('EARLY_TAKEOVER_NOT_REFUSED');
   const remaining=old.authority.expiresMs-Date.now()+150;if(remaining>45000)throw Error('UNEXPECTED_LEASE_LENGTH');if(remaining>0)await new Promise(r=>setTimeout(r,remaining));
  }else await stopWorker();
  await launch('restore',port,old.authority.token);}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({...await observe(),history,failedTakeovers}));
}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}});await new Promise(r=>control.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const uiPort=reservation.address().port;await new Promise(r=>reservation.close(r));
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/iu.test(k)));
ui=spawn(process.execPath,['scripts/dev-server.mjs'],{cwd:process.cwd(),windowsHide:true,env:{...childEnv,PORT:String(uiPort),JARVIS_CORE_API_URL:`http://127.0.0.1:${workerReady.port}`,JARVIS_CORE_ADMIN_TOKEN:'synthetic-clarification-restart'},stdio:['ignore','pipe','inherit']});
await new Promise((done,reject)=>{ui.stdout.once('data',done);ui.once('exit',c=>reject(Error('UI_EXIT:'+c)));});
console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${uiPort}`,control:`http://127.0.0.1:${control.address().port}`,missionId:workerReady.missionId}));
async function stop(){if(stopping)return;stopping=true;ui.kill();await stopWorker();control.closeAllConnections();await new Promise(r=>control.close(r));
 const target=resolve(root);if(!target.startsWith(resolve(tmpdir())+sep)||!target.includes('jarvis-clarification-restart-'))throw Error('CLEANUP_BOUNDARY');await rm(target,{recursive:true,force:true});process.exit(0);}
createInterface({input:process.stdin}).once('line',stop);process.stdin.once('end',stop);
