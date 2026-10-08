/** Android's official ACTION_VIEW path. Launching a viewer proves no read/send/transaction. */
export function officialDocumentViewUri(input){
 if(typeof input!=='string'||input.length>4096||/[\u0000-\u001f\u007f]/u.test(input))return null;
 try{
  const url=new URL(input);
  if(url.username||url.password)return null;
  const credentialKeys=new Set(['access_token','refresh_token','client_secret','password','authorization','api_key','apikey','token','signature','sig','code']);
  if([...url.searchParams.keys(),...new URLSearchParams(url.hash.slice(1)).keys()].some(key=>credentialKeys.has(key.toLowerCase())))return null;
  if(url.protocol==='https:'&&url.hostname)return input;
  if(url.protocol==='content:'&&url.hostname&&url.pathname!=='/')return input;
  if(url.protocol==='file:'&&!url.hostname&&url.pathname.startsWith('/')&&url.pathname!=='/')return input;
 }catch{}
 return null;
}

export async function openOfficialDocument({uri,openURL}={}){
 const selected=officialDocumentViewUri(uri);
 if(!selected)return {status:'blocked',success:false,uri:null,error:{code:'C_DOCUMENT_VIEW_URI_DENIED'}};
 if(typeof openURL!=='function')return {status:'unavailable',success:false,uri:selected,error:{code:'C_DOCUMENT_VIEWER_UNAVAILABLE'}};
 try{await openURL(selected);return {status:'opened',success:true,uri:selected,verifiedContentRead:false};}
 catch{return {status:'failed',success:false,uri:selected,error:{code:'C_DOCUMENT_VIEWER_FAILED'}};}
}
