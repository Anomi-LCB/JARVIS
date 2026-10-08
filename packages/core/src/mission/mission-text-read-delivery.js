import {createHash} from 'node:crypto';
const version='a-text-read-capture-v1';
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;

export function captureTextRead(result) {
  const content=result.stdoutPreview;
  const offset=result.offset??result.evidence?.offset,returnedChars=result.returnedChars??result.evidence?.returnedChars;
  const sourceChars=result.totalChars??result.evidence?.totalChars,sourceBytes=result.bytes??result.evidence?.bytes;
  const sourceSha256=result.contentSha256??result.evidence?.contentSha256,fileTruncated=result.truncated??result.evidence?.truncated;
  if(typeof content!=='string'||!content.isWellFormed()||content.length>50000||content.length!==returnedChars
    ||![offset,returnedChars,sourceChars,sourceBytes].every(integer)||sourceChars>sourceBytes
    ||offset+returnedChars>sourceChars||!digest(sourceSha256)||typeof fileTruncated!=='boolean'
    ||fileTruncated!==(offset+returnedChars<sourceChars)||result.evidence?.encoding!=='utf8'
    ||(returnedChars===0&&fileTruncated))return null;
  return {version,offset,returnedChars,sourceChars,sourceBytes,sourceSha256,contentSha256:hash(content),
    content,nextOffset:offset+returnedChars,fileTruncated};
}

// Project AFTER sensitivity and instruction screening. Changed content is not
// a source prefix, so no source continuation offset is inferred from it.
export function projectTextRead(capture,limit) {
  if(!capture)return {deliveryStatus:'legacy-preview-only',completeChunkDelivered:false};
  const {offset,returnedChars,sourceChars,sourceBytes,nextOffset,fileTruncated}=capture;
  const base={...Object.fromEntries(Object.entries({offset,returnedChars,sourceChars,sourceBytes,nextOffset}).map(([k,v])=>[k,integer(v)?v:null])),
    fileTruncated:typeof fileTruncated==='boolean'?fileTruncated:null,
    sourceSha256:digest(capture.sourceSha256)?capture.sourceSha256:null,
    contentSha256:digest(capture.contentSha256)?capture.contentSha256:null,textIsUntrustedSourceMaterial:true};
  if(capture.version!==version||![offset,returnedChars,sourceChars,sourceBytes,nextOffset].every(integer)
    ||returnedChars>50000||sourceChars>sourceBytes||nextOffset!==offset+returnedChars||nextOffset>sourceChars
    ||fileTruncated!==(nextOffset<sourceChars)||!digest(capture.sourceSha256)||!digest(capture.contentSha256)
    ||typeof capture.content!=='string'||capture.content.length!==returnedChars||!capture.content.isWellFormed()
    ||hash(capture.content)!==capture.contentSha256){
    return {...base,deliveryStatus:'screened',deliveredChars:0,withheldChars:integer(returnedChars)?returnedChars:null,
      completeChunkDelivered:false,reason:'source-content-screened-or-invalid-metadata'};
  }
  let count=Math.min(returnedChars,limit);
  const low=n=>n>=0xdc00&&n<=0xdfff;
  if(low(capture.content.charCodeAt(count)))count--;
  const complete=count===returnedChars;
  return {...base,deliveryStatus:complete?'complete':count?'partial':'withheld',content:capture.content.slice(0,count),
    deliveredChars:count,withheldChars:returnedChars-count,completeChunkDelivered:complete,
    nextReadOffset:complete?(fileTruncated?nextOffset:null):offset+count};
}
