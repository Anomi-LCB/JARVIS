import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'
 ?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const fail=()=>{throw Object.assign(new Error('Workflow resume checkpoint invalid'),{code:'A_WORKFLOW_RESUME_CHECKPOINT_INVALID'});};
export function createWorkflowResumeCheckpoint(snapshot){
 const source=JSON.stringify(snapshot);
 if(typeof source!=='string'||Buffer.byteLength(source)>16*1024*1024)fail();
 return {resumeAuthorization:JSON.parse(source),resumeAuthorizationSource:source,resumeAuthorizationSha256:hash(source)};
}
export function readWorkflowResumeCheckpoint(operation){
 try{
  const saved=operation?.resumeAuthorization;
  if(!saved||typeof saved!=='object'||Array.isArray(saved))fail();
  const source=operation.resumeAuthorizationSource??JSON.stringify(saved);
  if(typeof source!=='string'||Buffer.byteLength(source)>16*1024*1024||hash(source)!==operation.resumeAuthorizationSha256)fail();
  const original=JSON.parse(source);
  if(canonical(original)!==canonical(JSON.parse(JSON.stringify(saved))))fail();
  return original;
 }catch{fail();}
}
