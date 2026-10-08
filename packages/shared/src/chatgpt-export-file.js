/** Local-only reader. No archive entry is written to disk or sent to a server. */
export const exportFileLimits=Object.freeze({archiveBytes:64*1024*1024,jsonBytes:32*1024*1024,entries:10000,conversations:10000});
const fail=code=>{throw Object.assign(new Error(code),{code});};
const decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,'');
const crcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;});
export function exportCrc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^crcTable[(crc^byte)&255];return (crc^0xffffffff)>>>0;}
async function inflate(bytes,limit){
 let stream;
 try{stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));}catch{fail('F_CONVERSATION_ZIP_BROWSER_UNSUPPORTED');}
 const reader=stream.getReader(),parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail('F_CONVERSATION_IMPORT_TOO_LARGE');}parts.push(value);}}
 catch(error){if(error.code)throw error;fail('F_CONVERSATION_ZIP_INVALID');}
 finally{reader.releaseLock();}
 const result=new Uint8Array(size);let pos=0;for(const part of parts){result.set(part,pos);pos+=part.length;}return result;
}
function entries(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),size=bytes.length;
 let end=-1;for(let pos=size-22;pos>=Math.max(0,size-65557);pos--){if(view.getUint32(pos,true)===0x06054b50&&pos+22+view.getUint16(pos+20,true)===size){end=pos;break;}}
 if(end<0||view.getUint16(end+4,true)||view.getUint16(end+6,true))fail('F_CONVERSATION_ZIP_INVALID');
 const count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
 if(count===65535||count>exportFileLimits.entries||count!==view.getUint16(end+8,true)||start+centralSize!==end)fail('F_CONVERSATION_ZIP_INVALID');
 const result=[],names=new Set();let pos=start;
 for(let i=0;i<count;i++){
  if(pos+46>end||view.getUint32(pos,true)!==0x02014b50)fail('F_CONVERSATION_ZIP_INVALID');
  const flags=view.getUint16(pos+8,true),method=view.getUint16(pos+10,true),crc=view.getUint32(pos+16,true),compressed=view.getUint32(pos+20,true),expanded=view.getUint32(pos+24,true);
  const nameLength=view.getUint16(pos+28,true),extra=view.getUint16(pos+30,true),comment=view.getUint16(pos+32,true),local=view.getUint32(pos+42,true);
  if(pos+46+nameLength+extra+comment>end||view.getUint16(pos+34,true)||[compressed,expanded,local].includes(0xffffffff))fail('F_CONVERSATION_ZIP_INVALID');
  const nameBytes=bytes.subarray(pos+46,pos+46+nameLength),name=new TextDecoder().decode(nameBytes);
  if(!name||/[\\\u0000]/u.test(name)||name.startsWith('/')||name.split('/').includes('..')||names.has(name))fail('F_CONVERSATION_ZIP_INVALID');
  names.add(name);
  if(/^conversations(?:-\d+)?\.json$/u.test(name)){
   if(flags&0x41||! [0,8].includes(method))fail('F_CONVERSATION_ZIP_UNSUPPORTED');
   if(expanded>exportFileLimits.jsonBytes||local+30>start||view.getUint32(local,true)!==0x04034b50)fail('F_CONVERSATION_ZIP_INVALID');
   const localNameLength=view.getUint16(local+26,true),localExtra=view.getUint16(local+28,true),dataStart=local+30+localNameLength+localExtra;
   if(view.getUint16(local+6,true)!==flags||view.getUint16(local+8,true)!==method||localNameLength!==nameLength
     ||dataStart+compressed>start||!nameBytes.every((value,index)=>bytes[local+30+index]===value))fail('F_CONVERSATION_ZIP_INVALID');
   if(!(flags&8)&&(view.getUint32(local+14,true)!==crc||view.getUint32(local+18,true)!==compressed||view.getUint32(local+22,true)!==expanded))fail('F_CONVERSATION_ZIP_INVALID');
   result.push({name,method,crc,expanded,bytes:bytes.subarray(dataStart,dataStart+compressed),from:local,to:dataStart+compressed});
  }
  pos+=46+nameLength+extra+comment;
 }
 if(pos!==end||!result.length)fail('F_CONVERSATION_ZIP_CONVERSATIONS_REQUIRED');
 if(result.length>1&&result.some(e=>e.name==='conversations.json'))fail('F_CONVERSATION_ZIP_AMBIGUOUS');
 result.sort((a,b)=>a.from-b.from);for(let i=1;i<result.length;i++)if(result[i].from<result[i-1].to)fail('F_CONVERSATION_ZIP_INVALID');
 if(result.reduce((sum,e)=>sum+e.expanded,0)>exportFileLimits.jsonBytes)fail('F_CONVERSATION_IMPORT_TOO_LARGE');
 return result.sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
}
export function validateExportFileDocument(document){
 if(Array.isArray(document)){
  if(document.length>exportFileLimits.conversations||document.some(c=>!c||typeof c.id!=='string')||new Set(document.map(c=>c.id)).size!==document.length)fail('F_CONVERSATION_EXPORT_ID_INVALID');
 }else if(document?.format!=='jarvis-selected-conversations-v1'||document.provider!=='chatgpt'||!Array.isArray(document.conversations)
  ||document.conversations.length>500||document.conversations.some(c=>!c||typeof c.id!=='string'||!Array.isArray(c.messages)))fail('F_CONVERSATION_FORMAT_UNSUPPORTED');
 return document;
}
export async function readChatGptExportFile(input,{name='conversations.json'}={}){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes.length>exportFileLimits.archiveBytes)fail('F_CONVERSATION_IMPORT_TOO_LARGE');
 const isZip=/\.zip$/iu.test(name)||bytes[0]===0x50&&bytes[1]===0x4b;
 let document,entryNames=[];
 if(isZip){
  document=[];const selected=entries(bytes);
  for(const entry of selected){
   const content=entry.method===0?entry.bytes:await inflate(entry.bytes,Math.min(entry.expanded,exportFileLimits.jsonBytes));
   if(content.length!==entry.expanded||exportCrc32(content)!==entry.crc)fail('F_CONVERSATION_ZIP_INVALID');
   let part;try{part=JSON.parse(decode(content));}catch{fail('F_CONVERSATION_EXPORT_FORMAT_UNSUPPORTED');}
   if(!Array.isArray(part))fail('F_CONVERSATION_EXPORT_FORMAT_UNSUPPORTED');
   if(document.length+part.length>exportFileLimits.conversations)fail('F_CONVERSATION_IMPORT_TOO_LARGE');
   document.push(...part);entryNames.push(entry.name);
  }
 }else{
  if(bytes.length>exportFileLimits.jsonBytes)fail('F_CONVERSATION_IMPORT_TOO_LARGE');
  try{document=JSON.parse(decode(bytes));}catch{fail('F_CONVERSATION_EXPORT_FORMAT_UNSUPPORTED');}
 }
 validateExportFileDocument(document);
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
 return {document,sourceBytesHash:hash,entryNames,format:isZip?'zip':'json',executionAuthority:false};
}
