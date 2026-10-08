import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
import {extractLiteralSourceFields} from './literal-source-fields.js';
import {extractQuestionBoundSourceSummary} from './source-question-binding.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,path)=>{const rel=relative(root,path);return rel!== '..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
function safe(root,path){
 const absolute=resolve(path);if(!inside(root,absolute))throw new Error('outside-root');
 let current=root;if(lstatSync(current).isSymbolicLink())throw new Error('link');
 for(const part of relative(root,absolute).split(sep).filter(Boolean)){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('link');}
 if(realpathSync(absolute)!==absolute)throw new Error('canonical-path');return absolute;
}
function bytes(root,path,beforeAccess){beforeAccess?.({path,kind:'read'});const p=safe(root,path),info=lstatSync(p);if(!info.isFile()||info.size>1000000)throw new Error('file-limit');beforeAccess?.({path:p,kind:'read'});const result=readFileSync(p);beforeAccess?.({path:p,kind:'read'});return result;}
export {bytes as readGuardedResultFile};
function find(root,directory,name,beforeAccess){
 beforeAccess?.({path:directory,kind:'inventory'});
 const queue=[safe(root,directory)],matches=[];let count=0;
 while(queue.length){const dir=queue.shift();beforeAccess?.({path:dir,kind:'inventory'});const entries=readdirSync(dir,{withFileTypes:true});beforeAccess?.({path:dir,kind:'inventory'});for(const entry of entries){
  if(++count>10000)throw new Error('listing-limit');const candidate=join(dir,entry.name);beforeAccess?.({path:candidate,kind:'inventory'});const path=safe(root,candidate);beforeAccess?.({path,kind:'inventory'});
  if(entry.isDirectory())queue.push(path);else if(entry.isFile()&&entry.name===name)matches.push(path);
 }}if(matches.length!==1)throw new Error('source-not-unique');return matches[0];
}
/** Current content comparison for the exact UI default criterion. Shared typed
 * extractor is deterministic, not an independent semantic or real-world oracle. */
export function verifyFieldSummaryResult({objective,statement,observations,allowedRoots=[],beforeAccess}){
 const absent={applicable:false};
 if(statement!==`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`)return absent;
 const root=allowedRoots[0]&&resolve(allowedRoots[0]);if(!root)return absent;
 const compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:root});
 const nodes=compiled.spec?.nodes;
 const signature=nodes?.map(n=>n.op).join(',');
 if(compiled.status!=='compiled'||compiled.clauseCount!==1||!['text.read,text.extractFields,write.json,data.readJson','fs.inventory,data.filter,assert.count,text.read,text.extractFields,write.json,data.readJson'].includes(signature))return absent;
 try{
  const observation=observations.find(o=>o.toolName==='workflow.execute'&&o.outcome==='success'&&o.verification?.status==='passed'&&o.data?.workflow?.specSha256===hash(JSON.stringify(compiled.spec)));
  const workflow=observation?.data?.workflow;if(!workflow||workflow.workflowId!==compiled.spec.workflowId||workflow.nodeCount!==nodes.length)throw new Error('receipt-binding');
  const receipt=n=>{const matches=workflow.receipts.filter(r=>r.nodeId===n.id&&r.op===n.op&&r.status==='success');if(matches.length!==1)throw new Error('receipt-missing');return matches[0];};nodes.forEach(receipt);
  const read=nodes.find(n=>n.op==='text.read'),extract=nodes.find(n=>n.op==='text.extractFields'),write=nodes.find(n=>n.op==='write.json'),reread=nodes.at(-1);
  const path=signature.startsWith('fs.inventory')?find(root,nodes[0].args.path,nodes[1].args.where.value,beforeAccess):read.args.path;
  if(resolve(receipt(read).source.path)!==resolve(path)||resolve(receipt(reread).source.path)!==resolve(write.args.path))throw new Error('path-binding');
  if(compiled.rediscoverOutput){
   const located=find(root,resolve(write.args.path,'..'),write.args.path.split(/[\\/]/u).at(-1),beforeAccess);
   if(resolve(located)!==resolve(write.args.path)||resolve(compiled.rediscoverOutput)!==resolve(write.args.path))throw new Error('output-discovery-mismatch');
  }
  const sourceBytes=bytes(root,path,beforeAccess),outputBytes=bytes(root,write.args.path,beforeAccess);
  if(hash(sourceBytes)!==receipt(read).source.sha256||hash(sourceBytes)!==receipt(extract).sourceSha256||hash(outputBytes)!==receipt(reread).source.sha256)throw new Error('current-hash');
  const source=new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes);if(source.length>20000)throw new Error('source-limit');
  const expected=extract.args.sourceFields===undefined?extractQuestionBoundSourceSummary({source,...extract.args}):extractLiteralSourceFields({source,...extract.args});
  if(!expected)throw new Error('source-declaration-unverified');
  const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(outputBytes));
  if(JSON.stringify(output.facts)!==JSON.stringify(expected.facts)||JSON.stringify(output.evidence)!==JSON.stringify(expected.evidence)||output.sourceSha256!==hash(sourceBytes))throw new Error('content-mismatch');
  return {applicable:true,passed:true,status:'passed',reasons:[],checkedAt:new Date().toISOString(),fields:Object.entries(extract.args.questions).map(([id,question])=>({id,label:extract.args.sourceFields?.[id]?.label??question,value:expected.facts[id],quote:expected.evidence[id],unit:extract.args.sourceFields?.[id]?.unit??null})),checks:[{checkId:'current-literal-source-result',passed:true,sourceSha256:hash(sourceBytes),outputSha256:hash(outputBytes),...(compiled.rediscoverOutput?{outputRediscovered:true}:{}),semanticAccuracyVerified:false,sharedExtractor:true}]};
 }catch{return {applicable:true,passed:false,status:'unverified',reasons:['literal-source-result-unverified'],checks:[]};}
}
