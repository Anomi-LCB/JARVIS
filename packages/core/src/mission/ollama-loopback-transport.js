import {request as httpRequest} from 'node:http';
const origin='http://127.0.0.1:11434',maxBytes=2*1024*1024;
const fail=code=>Object.assign(new Error(code),{code});

// Dedicated local transport: the caller's AbortSignal owns the entire request.
// No shared fetch headers/body deadline, redirects, proxies or credential headers.
export function createOllamaLoopbackFetch({requestImpl=httpRequest}={}){
 if(typeof requestImpl!=='function')throw fail('A_LOCAL_MODEL_CONFIG_INVALID');
 return async(url,init={})=>{
  const method=init.method,path=url===origin+'/api/tags'?'/api/tags':url===origin+'/api/generate'?'/api/generate':null;
  if(!path||(path==='/api/tags'?method!=='GET':method!=='POST')||init.redirect!=='error'||init.credentials!=='omit'
   ||init.cache!=='no-store'||init.body!==undefined&&(typeof init.body!=='string'||Buffer.byteLength(init.body)>maxBytes))throw fail('A_LOCAL_MODEL_TRANSPORT_SCOPE_INVALID');
  const headers={};
  for(const [key,value] of Object.entries(init.headers??{})){
   if(!['accept','content-type'].includes(key.toLowerCase())||value!=='application/json')throw fail('A_LOCAL_MODEL_TRANSPORT_SCOPE_INVALID');
   headers[key]=value;
  }
  if(init.signal?.aborted)throw fail('ABORT_ERR');
  return new Promise((resolve,reject)=>{
   let responseReturned=false,bodyReject=null;
   const req=requestImpl(url,{method,headers,agent:false,signal:init.signal},res=>{
    responseReturned=true;
    const status=res.statusCode??0;
    if(status<200||status>=300){res.on('error',()=>{});res.destroy();resolve({ok:false,status,text:async()=>''});return;}
    let size=0,finished=false;const chunks=[];
    const body=new Promise((resolveBody,rejectBody)=>{
     bodyReject=rejectBody;
     res.on('data',chunk=>{
      if(finished)return;
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
      if(size>maxBytes){finished=true;rejectBody(fail('A_LOCAL_MODEL_RESPONSE_TOO_LARGE'));res.destroy();req.destroy();return;}
      chunks.push(bytes);
     });
     res.on('end',()=>{if(!finished){finished=true;resolveBody(Buffer.concat(chunks,size).toString('utf8'));}});
     res.on('error',error=>{if(!finished){finished=true;rejectBody(error);}});
     res.on('aborted',()=>{if(!finished){finished=true;rejectBody(fail('ECONNRESET'));}});
    });
    // A status consumer can reject without calling text(); keep body rejection handled.
    body.catch(()=>{});
    resolve({ok:true,status,text:()=>body});
   });
   req.on('error',error=>{if(responseReturned)bodyReject?.(error);else reject(error);});
   req.end(init.body);
  });
 };
}
export const fetchOllamaLoopback=createOllamaLoopbackFetch();
