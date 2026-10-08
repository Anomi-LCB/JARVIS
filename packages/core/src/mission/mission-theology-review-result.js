import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
import {readGuardedResultFile} from './mission-field-summary-result.js';
import {reviewTheologyResearch} from './theology-research-review.js';
const hash=value=>createHash('sha256').update(value).digest('hex');

export function verifyTheologyReviewResult({objective,statement,observations,allowedRoots=[],beforeAccess}) {
  if(statement!==`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`||!allowedRoots[0])return {applicable:false};
  const root=resolve(allowedRoots[0]),compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:root});
  const nodes=compiled.spec?.nodes;
  if(compiled.status!=='compiled'||compiled.clauseCount!==1||nodes?.map(n=>n.op).join(',')!=='data.readJson,theology.review,write.text,write.json,text.read,data.readJson')return {applicable:false};
  try {
    const workflow=observations.find(o=>o.toolName==='workflow.execute'&&o.outcome==='success'&&o.verification?.status==='passed'&&o.data?.workflow?.specSha256===hash(JSON.stringify(compiled.spec)))?.data?.workflow;
    if(!workflow||workflow.workflowId!==compiled.spec.workflowId||workflow.nodeCount!==6)throw new Error('workflow-binding');
    const receipts=nodes.map(node=>{
      const matches=workflow.receipts.filter(r=>r.nodeId===node.id&&r.op===node.op&&r.status==='success');
      if(matches.length!==1)throw new Error('receipt-binding');return matches[0];
    });
    const bindings=[[0,0],[4,2],[5,3]];
    const bytes=bindings.map(([receipt,node])=>{
      if(resolve(receipts[receipt].source.path)!==resolve(nodes[node].args.path))throw new Error('path-binding');
      const value=readGuardedResultFile(root,nodes[node].args.path,beforeAccess);
      if(hash(value)!==receipts[receipt].source.sha256)throw new Error('current-hash');return value;
    });
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const expected=reviewTheologyResearch(JSON.parse(decoder.decode(bytes[0])));
    if(decoder.decode(bytes[1])!==expected.report||!isDeepStrictEqual(JSON.parse(decoder.decode(bytes[2])),expected))throw new Error('content-binding');
    return {applicable:true,passed:true,status:'passed',reasons:[],checks:[{
      checkId:'current-theology-review-files',passed:true,sourceSha256:hash(bytes[0]),reportSha256:hash(bytes[1]),manifestSha256:hash(bytes[2]),
      sharedCalculator:true,semanticAccuracyVerified:false,sourceAuthenticityVerified:false,expertEvaluation:false
    }]};
  }catch{return {applicable:true,passed:false,status:'unverified',reasons:['theology-review-current-content-unverified'],checks:[]};}
}
