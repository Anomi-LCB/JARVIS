import {createHash} from 'node:crypto';
export function normalizeMicrosoftCollection(args){
 const fail=()=>{throw Error('A_MICROSOFT_COLLECTION_REQUEST_INVALID');};
 if(!args||typeof args!=='object'||Array.isArray(args)||![Object.prototype,null].includes(Object.getPrototypeOf(args)))fail();
 const copy={};
 for(const key of Reflect.ownKeys(args)){
  if(typeof key!=='string'||!['provider','connectionId','chatId','cursor','rawText'].includes(key))fail();
  const property=Object.getOwnPropertyDescriptor(args,key);
  if(!property?.enumerable||!Object.hasOwn(property,'value'))fail();
  copy[key]=property.value;
 }
 const {rawText,...job}=copy;
 if(rawText!==undefined&&typeof rawText!=='string')fail();
 if(!['outlook','teams-chat'].includes(job.provider)||typeof job.connectionId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(job.connectionId))fail();
 if(job.provider==='outlook'&&job.chatId!==undefined||job.provider==='teams-chat'&&(typeof job.chatId!=='string'||!/^[A-Za-z0-9:@._-]{1,500}$/u.test(job.chatId)))fail();
 if(job.cursor!==undefined&&job.cursor!==null&&(typeof job.cursor!=='string'||job.cursor.length>2000))fail();
 return Object.freeze(job);
}
/** One connection and selected chat; not permission for bodies, attachments or writes to the provider. */
export function microsoftCollectionMandateRef(args){
 const job=normalizeMicrosoftCollection(args);
 const target=createHash('sha256').update(JSON.stringify([job.provider,job.connectionId,job.chatId??null])).digest('hex');
 return 'microsoft-metadata:'+target;
}
