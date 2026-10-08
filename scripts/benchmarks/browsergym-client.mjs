import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {digest,normalizeBenchmarkAction} from './browsergym-capability.mjs';
export function createBrowserGymClient({python,worker,miniwob,chrome,stateFile,browsersPath,shutdownTimeoutMs=5000}){
 if(!Number.isSafeInteger(shutdownTimeoutMs)||shutdownTimeoutMs<20||shutdownTimeoutMs>10000)throw Error('BENCHMARK_SHUTDOWN_TIMEOUT_INVALID');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(k)));
 const child=spawn(python,['-u',worker,'--miniwob',miniwob,'--chrome',chrome,'--state',stateFile],{windowsHide:true,detached:process.platform!=='win32',env:{...env,PLAYWRIGHT_BROWSERS_PATH:browsersPath},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let serial=0,terminal=false,exited=false,uncertain=null,stepPending=false;const diagnostics=[];
 child.stderr.on('data',b=>{diagnostics.push(String(b).slice(0,2000));if(diagnostics.length>100)diagnostics.shift();});
 const failPending=(p,error)=>{clearTimeout(p.timer);if(p.op==='step'){uncertain=p.request;stepPending=false;}p.reject(error);};
 const finish=error=>{terminal=true;for(const p of pending.values())failPending(p,error);pending.clear();};
 child.on('error',finish);child.on('exit',code=>{exited=true;finish(Error('BENCHMARK_WORKER_EXIT:'+code));});
 child.stdin.on('error',finish);
 createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return finish(Error('BENCHMARK_PROTOCOL_INVALID'));}
  const p=pending.get(message.id);if(!p)return;pending.delete(message.id);
  if(message.error)return failPending(p,Error(message.error.code));
  clearTimeout(p.timer);if(p.op==='step')stepPending=false;p.resolve(message.result);
 });
 const send=(op,body,timeoutMs=30000)=>{
  if(terminal)return Promise.reject(Error('BENCHMARK_WORKER_UNAVAILABLE'));
  const id=++serial;return new Promise((resolve,reject)=>{
   const p={resolve,reject,op,request:body.request,timer:null};
   p.timer=setTimeout(()=>{pending.delete(id);failPending(p,Error('BENCHMARK_RESPONSE_UNCERTAIN'));},timeoutMs);
   pending.set(id,p);child.stdin.write(JSON.stringify({...body,id,op})+'\n');
  });
 };
 const call=async(op,body={},options={})=>{
  const timeoutMs=options.timeoutMs??30000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<20||timeoutMs>30000)throw Error('BENCHMARK_TIMEOUT_INVALID');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'id')||Object.hasOwn(body,'op'))throw Error('BENCHMARK_RPC_INVALID');
  if(op==='step'){
   if(uncertain||stepPending)throw Error('BENCHMARK_EFFECT_PENDING_OR_UNCERTAIN');
   if(Object.keys(body).length!==1||!Object.hasOwn(body,'request'))throw Error('BENCHMARK_RPC_INVALID');
   const request=normalizeBenchmarkAction(body.request);stepPending=true;
   return send(op,{request},timeoutMs);
  }
  if(op==='reset'){
   if(uncertain||stepPending)throw Error('BENCHMARK_EFFECT_PENDING_OR_UNCERTAIN');
   if(Object.keys(body).length!==2||!['click-test','click-button','enter-text'].includes(body.task)||![17,43,89].includes(body.seed))throw Error('BENCHMARK_RESET_INVALID');
   return send(op,{task:body.task,seed:body.seed},timeoutMs);
  }
  if(op==='observe'&&Object.keys(body).length===0)return send(op,{},timeoutMs);
  throw Error('BENCHMARK_OPERATION_UNSUPPORTED');
 };
 const lookupStepReceipt=async value=>{
  const request=normalizeBenchmarkAction(value);
  const result=await send('reconcile',{request});
  // Absence is not proof of non-execution. Never unlock or retry on a missing receipt.
  if(result?.status!=='matched')return {status:'unresolved',reason:result?.reason??'receipt-unavailable'};
  const receipt=result.receipt;
  if(receipt?.version!=='browsergym-action-receipt-v1'||digest(receipt.request)!==digest(request)
   ||receipt.postState?.episodeId!==request.episodeId||receipt.postState?.revision!==request.expectedRevision+1)throw Error('BENCHMARK_RECONCILIATION_RECEIPT_INVALID');
  const state=JSON.parse(readFileSync(stateFile,'utf8'));
  if(state?.version!=='browsergym-worker-state-v1'||digest(state.receipt)!==digest(receipt)||digest(state.public)!==digest(receipt.postState))throw Error('BENCHMARK_RECONCILIATION_SNAPSHOT_INVALID');
  return {status:'matched',receipt};
 };
 const reconcileStep=async value=>{
  const request=normalizeBenchmarkAction(value);
  if(!uncertain||stepPending||digest(request)!==digest(uncertain))throw Error('BENCHMARK_RECONCILIATION_BINDING_INVALID');
  const result=await lookupStepReceipt(request);
  if(result.status==='matched')uncertain=null;
  return result;
 };
 return {call,reconcileStep,lookupStepReceipt,readState:()=>JSON.parse(readFileSync(stateFile,'utf8')),diagnostics,pid:child.pid,
  async close(){
   if(exited||!child.pid)return;
   if(!child.stdin.destroyed)child.stdin.end(JSON.stringify({id:++serial,op:'close'})+'\n');
   const wait=()=>new Promise(resolve=>{if(exited)return resolve(true);const done=()=>{clearTimeout(timer);resolve(true);};const timer=setTimeout(()=>{child.off('exit',done);resolve(false);},shutdownTimeoutMs);child.once('exit',done);});
   if(await wait())return;
   // Kill only the isolated child tree created here, never an existing browser/service.
   if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});
   else process.kill(-child.pid,'SIGKILL');
   if(!await wait())throw Error('BENCHMARK_WORKER_CLEANUP_UNCONFIRMED');
  }};
}
