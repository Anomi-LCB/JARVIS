import {openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,constants} from 'node:fs';
import {isAbsolute,resolve,relative,basename} from 'node:path';
import {createHash} from 'node:crypto';
const maximumBytes=64*1024;
const inRoot=(path,root)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
function readScoped(path,roots){
 if(typeof path!=='string'||!isAbsolute(path))throw Error('unavailable');
 const canonical=realpathSync(path);
 if(canonical!==resolve(path)||!roots.some(root=>{try{return inRoot(canonical,realpathSync(resolve(root)));}catch{return false;}}))throw Error('unavailable');
 const fd=openSync(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=fstatSync(fd);if(!before.isFile()||before.size>maximumBytes)throw Error('unavailable');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('unavailable');offset+=n;}
  const after=fstatSync(fd);
  const current=lstatSync(canonical);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||realpathSync(path)!==canonical||!current.isFile()||current.ino!==after.ino||current.dev!==after.dev||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.ctimeMs!==after.ctimeMs)throw Error('unavailable');
  return {bytes,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }finally{closeSync(fd);}
}
export function observeSuccessfulTask(task,observedAt,roots){
 if(task?.status!=='COMPLETED'||task.executionVerification?.status!=='passed')return null;
 const result=task.executionResult?.executionResult;
 const allPaths=[...new Set((result?.outputPaths??[]).filter(path=>typeof path==='string'&&isAbsolute(path)))];
 const paths=allPaths.slice(0,20);
 const artifacts=paths.map(path=>{
  try{const file=readScoped(path,roots);return {path,size:file.size,sha256:file.sha256};}
  catch{return {path,size:null,sha256:null};}
 });
 return {version:1,taskId:task.taskId,status:'COMPLETED',observedAt,toolName:task.plan?.action?.toolName??null,verificationStatus:'passed',verificationId:task.executionVerification.verificationId??null,omittedArtifactCount:allPaths.length-paths.length,artifacts};
}
export function validateSuccessObservations(items){
 if(!Array.isArray(items)||items.length>500)throw Error('Invalid success observations');
 const ids=new Set();
 for(const item of items){
  if(!item||item.version!==1||item.status!=='COMPLETED'||item.verificationStatus!=='passed'||typeof item.taskId!=='string'||!item.taskId||item.taskId.length>512||/[\u0000-\u001f\u007f]/u.test(item.taskId)||ids.has(item.taskId)
   ||typeof item.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(item.observedAt)||!Number.isFinite(Date.parse(item.observedAt))
   ||(item.toolName!==null&&(typeof item.toolName!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/u.test(item.toolName)))
   ||(item.verificationId!==null&&(typeof item.verificationId!=='string'||!item.verificationId||item.verificationId.length>512))||!Number.isSafeInteger(item.omittedArtifactCount)||item.omittedArtifactCount<0
   ||Object.keys(item).some(key=>!['version','taskId','status','observedAt','toolName','verificationStatus','verificationId','omittedArtifactCount','artifacts'].includes(key))
   ||!Array.isArray(item.artifacts)||item.artifacts.length>20)throw Error('Invalid success observation');
  ids.add(item.taskId);const paths=new Set();
  for(const file of item.artifacts){
   if(!file||typeof file.path!=='string'||!isAbsolute(file.path)||file.path.length>32768||/[\u0000-\u001f\u007f]/u.test(file.path)||paths.has(file.path)||Object.keys(file).some(key=>!['path','size','sha256'].includes(key))
    ||!((file.size===null&&file.sha256===null)||(Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=maximumBytes&&typeof file.sha256==='string'&&/^[a-f0-9]{64}$/u.test(file.sha256))))throw Error('Invalid observed artifact');
   paths.add(file.path);
  }
 }
 return items;
}
export function archivedSuccessTask(item,roots){
 const artifacts=item.artifacts.map((file,index)=>{
  let state='unavailable';
  if(file.sha256){try{const current=readScoped(file.path,roots);state=current.sha256===file.sha256&&current.size===file.size?'unchanged':'changed';}catch{/* Includes missing, revoked root and unsafe link. */}}
  return {index,name:basename(file.path),state,byteComparisonOnly:true};
 });
 return {taskId:item.taskId,status:'COMPLETED',archivedObservation:true,observedAt:item.observedAt,historicalVerification:{status:'passed',currentSemanticVerification:false},artifactObservations:artifacts,omittedArtifactCount:item.omittedArtifactCount,
  plan:{title:'PC 작업 완료 기록',action:{toolName:item.toolName}},executionVerification:null,learningResult:null,executionResult:{status:'COMPLETED',executionResult:{status:'success'}}};
}
export function readArchivedTextArtifact(item,index,roots){
 if(!Number.isSafeInteger(index)||index<0||index>=item.artifacts.length)throw Error('unavailable');
 const file=item.artifacts[index];
 if(!/\.(txt|md|markdown)$/iu.test(file.path)||!file.sha256)throw Error('unavailable');
 const current=readScoped(file.path,roots);
 if(current.sha256!==file.sha256||current.size!==file.size)throw Error('changed');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(current.bytes);
 return {name:basename(file.path),text,byteComparisonOnly:true,currentSemanticVerification:false};
}
