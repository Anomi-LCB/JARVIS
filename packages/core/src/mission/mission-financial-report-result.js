import {buildOfxFinancialReport} from '../../../shared/src/ofx-financial-report.js';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
import {readGuardedResultFile} from './mission-field-summary-result.js';
import {buildFinancialRecordReport} from '../../../shared/src/financial-record-reconciliation.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function verifyFinancialReportResult({objective,statement,observations,allowedRoots=[],includeReport=false,beforeAccess}) {
 if(statement!==`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`||!allowedRoots[0])return {applicable:false};
 const root=resolve(allowedRoots[0]),compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:root});
 const nodes=compiled.spec?.nodes;
 if(compiled.status!=='compiled'||compiled.clauseCount!==1||!['data.readJson,financial.report,write.text,text.read','data.readJson,financial.ofxReport,write.text,text.read'].includes(nodes?.map(n=>n.op).join(',')))return {applicable:false};
 try {
  const workflow=observations.find(o=>o.toolName==='workflow.execute'&&o.outcome==='success'&&o.verification?.status==='passed'&&o.data?.workflow?.specSha256===hash(JSON.stringify(compiled.spec)))?.data?.workflow;
  if(!workflow||workflow.workflowId!==compiled.spec.workflowId||workflow.nodeCount!==4)throw new Error('workflow-binding');
  const receipts=nodes.map(node=>{
   const matches=workflow.receipts.filter(r=>r.nodeId===node.id&&r.op===node.op&&r.status==='success');
   if(matches.length!==1)throw new Error('receipt-binding');return matches[0];
  });
  if(resolve(receipts[0].source.path)!==resolve(nodes[0].args.path)||resolve(receipts[3].source.path)!==resolve(nodes[2].args.path))throw new Error('path-binding');
  const sourceBytes=readGuardedResultFile(root,nodes[0].args.path,beforeAccess),outputBytes=readGuardedResultFile(root,nodes[2].args.path,beforeAccess);
  if(hash(sourceBytes)!==receipts[0].source.sha256||hash(outputBytes)!==receipts[3].source.sha256)throw new Error('current-hash');
  const decoder=new TextDecoder('utf-8',{fatal:true}),source=JSON.parse(decoder.decode(sourceBytes)),output=decoder.decode(outputBytes);
  const expected=nodes[1].op==='financial.ofxReport'?buildOfxFinancialReport(source):buildFinancialRecordReport(source);
  if(output!==expected.reportMarkdown)throw new Error('report-content');
  return {applicable:true,passed:true,status:'passed',reasons:[],...(includeReport?{reportMarkdown:output,checkedAt:new Date().toISOString()}:{}),checks:[{checkId:'current-financial-record-report',passed:true,sourceSha256:hash(sourceBytes),outputSha256:hash(outputBytes),sharedCalculator:true,sourceAuthenticated:false,executionAuthority:false}]};
 }catch{return {applicable:true,passed:false,status:'unverified',reasons:['financial-report-current-content-unverified'],checks:[]};}
}
