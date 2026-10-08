import {Worker} from 'node:worker_threads';
let inFlight=0;
const unavailable=reason=>({applicable:true,passed:false,status:'unverified',reasons:[reason],checks:[]});
export function verifyFieldSummaryResultAsync(input,{timeoutMs=10000,beforeAccess}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw new TypeError('Invalid verifier timeout');
 if(beforeAccess!==undefined&&typeof beforeAccess!=='function')throw new TypeError('Invalid result access guard');
 if(inFlight>=2)return Promise.resolve(unavailable('field-summary-verifier-busy'));
 inFlight++;
 return new Promise(resolve=>{
  let worker,timer,finished=false,lastRequest=0,resultReceived=false;
  const state=beforeAccess?new Int32Array(new SharedArrayBuffer(4)):null,accesses=new Map();
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);if(state){Atomics.store(state,0,-1);Atomics.notify(state,0);}Promise.resolve(worker?.terminate()).catch(()=>{}).finally(()=>{inFlight--;resolve(result);});};
  const check=async access=>{
   const ref=await beforeAccess(access),key=JSON.stringify([access.kind,access.path]),prior=accesses.get(key);
   if(typeof ref!=='string'||!ref||ref.length>4096||(prior&&prior.ref!==ref))throw new Error('result-access-identity');
   accesses.set(key,{...access,ref});
  };
  try{
   const observations=(input.observations??[]).filter(o=>o.toolName==='workflow.execute').map(o=>({toolName:o.toolName,outcome:o.outcome,verification:{status:o.verification?.status},data:{workflow:o.data?.workflow}}));
   worker=new Worker(new URL('./field-summary-worker.js',import.meta.url),{workerData:{verifierKind:['health-report','financial-report'].includes(input.verifierKind)?input.verifierKind:'fields',objective:input.objective,statement:input.statement,allowedRoots:input.allowedRoots,observations,accessState:state?.buffer??null,accessTimeoutMs:timeoutMs},env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:64}});
   timer=setTimeout(()=>finish(unavailable('field-summary-verifier-timeout')),timeoutMs);
   worker.on('message',async message=>{
    if(finished)return;
    try{
     if(message?.type==='result-access'){
      if(!state||message.requestId!==lastRequest+1||message.requestId>20000||typeof message.path!=='string'||message.path.length>4096||!['read','inventory'].includes(message.kind))throw new Error('result-access-contract');
      lastRequest=message.requestId;await check({path:message.path,kind:message.kind});
      if(finished)return;Atomics.store(state,0,1);Atomics.notify(state,0);return;
     }
     if(message?.type!=='verification-result')throw new Error('result-verifier-contract');
     resultReceived=true;
     if(beforeAccess)for(const access of accesses.values()){await check(access);if(finished)return;}
     finish(message.result);
    }catch{finish(unavailable('result-read-permission-denied'));}
   });worker.once('error',()=>finish(unavailable('field-summary-verifier-error')));
   worker.once('exit',()=>{if(!resultReceived)finish(unavailable('field-summary-verifier-exit'));});
  }catch{finish(unavailable('field-summary-verifier-start-failed'));}
 });
}
export function verifyHealthReportResultAsync(input,options) { return verifyFieldSummaryResultAsync({...input,verifierKind:'health-report'},options); }

export function verifyFinancialReportResultAsync(input,options) { return verifyFieldSummaryResultAsync({...input,verifierKind:'financial-report'},options); }
