const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const elapsed=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const stages=new Set(['catalog-request','catalog-response','generation-request','generation-response','output-validation']);
const reasons=new Set(['stop','length','load','unload']);
const transportCodes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ABORT_ERR','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
export function localModelUsage(value){
 const inputTokens=count(value?.inputTokens),outputTokens=count(value?.outputTokens);
 if(inputTokens===null&&outputTokens===null)return null;
 return {...(inputTokens===null?{}:{inputTokens}),...(outputTokens===null?{}:{outputTokens}),
  ...(inputTokens!==null&&outputTokens!==null&&Number.isSafeInteger(inputTokens+outputTokens)?{totalTokens:inputTokens+outputTokens}:{})};
}
/** No source, generated text, prompt, credentials, provider prose or arbitrary fields. */
export function localModelFailureObservation(value){
 if(value?.version!=='local-model-failure-v1')return null;
 return {version:'local-model-failure-v1',stage:stages.has(value.stage)?value.stage:null,
  providerCalls:count(value.providerCalls),latencyMs:elapsed(value.latencyMs),usage:localModelUsage(value.usage),
  doneReason:reasons.has(value.doneReason)?value.doneReason:null,
  httpStatus:Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null,
  ...(transportCodes.has(value.transportCode)?{transportCode:value.transportCode}:{}),
  costUsd:null,costMeasurement:'unmeasured',executionAuthorized:false};
}
export function summarizeLocalAttempts(attempts){
 const allCounts=attempts.map(a=>count(a.providerCalls)),allTimes=attempts.map(a=>elapsed(a.latencyMs));
 const usages=attempts.map(a=>localModelUsage(a.usage));
 const totalInput=usages.reduce((n,u)=>n+(u?.inputTokens??0),0),totalOutput=usages.reduce((n,u)=>n+(u?.outputTokens??0),0);
 const totalTime=allTimes.reduce((n,t)=>n+t,0);
 return {providerCalls:allCounts.every(c=>c!==null)&&Number.isSafeInteger(allCounts.reduce((n,c)=>n+c,0))?allCounts.reduce((n,c)=>n+c,0):null,
  latencyMs:allTimes.every(t=>t!==null)&&Number.isFinite(totalTime)?totalTime:null,
  usage:usages.every(u=>u&&count(u.inputTokens)!==null&&count(u.outputTokens)!==null)
   &&Number.isSafeInteger(totalInput+totalOutput)?{inputTokens:totalInput,outputTokens:totalOutput,totalTokens:totalInput+totalOutput}:null};
}

/** Ollama reports durations in nanoseconds; absent/invalid is unknown, never zero. */
export function localModelRuntimeTiming(value) {
 const duration=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0?value[key]/1000000:null;
 const totalMs=duration('total_duration'),loadMs=duration('load_duration');
 const promptEvalMs=duration('prompt_eval_duration'),generationMs=duration('eval_duration');
 const generated=count(value?.eval_count);
 return {version:'ollama-runtime-timing-v1',basis:'provider-reported',totalMs,loadMs,promptEvalMs,generationMs,
  outputTokensPerSecond:generated!==null&&generationMs!==null&&generationMs>0?generated*1000/generationMs:null};
}
