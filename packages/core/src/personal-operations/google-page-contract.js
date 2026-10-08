import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';

const wireKeys=['provider','timeMin','timeMax','cursor','account'];
const workerKeys=['windowId','scope','observedAt','complete'];
const invalid=()=>{throw new Error('A_GOOGLE_PAGE_INVALID');};
const queryInstant=value=>{
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z$/u.test(value)
   ||normalizeStrictIsoInstant(value)===null)invalid();
 return Date.parse(value);
};

/** One bounded-poll contract for local, vault and broker paths. Incremental tokens require
 * a separate collection authorization; silently ignoring them would change request meaning. */
export function snapshotGooglePageJob(input,{workerMetadata=true}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)
   ||![Object.prototype,null].includes(Object.getPrototypeOf(input)))invalid();
 const allowed=workerMetadata?[...wireKeys,...workerKeys]:wireKeys,copy={};
 for(const key of Reflect.ownKeys(input)){
   const field=Object.getOwnPropertyDescriptor(input,key);
   if(typeof key!=='string'||!allowed.includes(key)||!field?.enumerable||!Object.hasOwn(field,'value'))invalid();
   if(field.value===undefined&&['cursor','account'].includes(key))continue;
   copy[key]=field.value;
 }
 if(!['gmail','google-calendar'].includes(copy.provider))throw new Error('A_GOOGLE_PROVIDER_INVALID');
 const from=queryInstant(copy.timeMin),until=queryInstant(copy.timeMax);
 if(until<=from||until-from>(copy.provider==='gmail'?31:120)*86400000)invalid();
 if(copy.cursor!=null&&(typeof copy.cursor!=='string'||copy.cursor.length<1||copy.cursor.length>2000||/[\u0000-\u001f]/u.test(copy.cursor)))invalid();
 if(copy.account!==undefined&&(typeof copy.account!=='string'||copy.account.length>320||!/^[^\s@]+@[^\s@]+$/u.test(copy.account)))invalid();
 for(const [key,max]of [['windowId',128],['scope',1000]])if(Object.hasOwn(copy,key)
   &&(typeof copy[key]!=='string'||!copy[key]||copy[key].length>max||/[\u0000-\u001f]/u.test(copy[key])))invalid();
 if(Object.hasOwn(copy,'observedAt')&&normalizeStrictIsoInstant(copy.observedAt)===null)invalid();
 if(Object.hasOwn(copy,'complete')&&typeof copy.complete!=='boolean')invalid();
 return Object.freeze(copy);
}

export function googlePageWireJob(input){
 const job=snapshotGooglePageJob(input);
 return Object.freeze(Object.fromEntries(wireKeys.filter(key=>Object.hasOwn(job,key)).map(key=>[key,job[key]])));
}
