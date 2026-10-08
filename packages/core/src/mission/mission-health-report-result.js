import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {compileNaturalWorkflowObjective} from './natural-workflow-compiler.js';
import {readGuardedResultFile} from './mission-field-summary-result.js';
import {buildHealthRecordReport} from '../../../shared/src/health-record-summary.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function verifyHealthReportResult({objective,statement,observations,allowedRoots=[],includeReport=false,beforeAccess}) {
 if(statement!==`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`||!allowedRoots[0])return {applicable:false};
 const root=resolve(allowedRoots[0]),compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:root});
 const nodes=compiled.spec?.nodes;
 if(compiled.status!=='compiled'||compiled.clauseCount!==1||nodes?.map(n=>n.op).join(',')!=='data.readJson,health.report,write.text,text.read')return {applicable:false};
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
  const dates=[...output.matchAll(/^작성 시각: (.+)$/gmu)];if(dates.length!==1)throw new Error('report-clock');
  const now=dates[0][1],time=Date.parse(now);
  if(!Number.isFinite(time)||now!==receipts[1].healthReportGeneratedAt)throw new Error('report-clock');
  const expected=buildHealthRecordReport({records:source.records,startDate:nodes[1].args.startDate,endDate:nodes[1].args.endDate,now});
  if(output!==expected.reportMarkdown)throw new Error('report-content');
  return {applicable:true,passed:true,status:'passed',reasons:[],...(includeReport?{reportMarkdown:output,checkedAt:new Date().toISOString()}:{}),checks:[{checkId:'current-health-record-report',passed:true,sourceSha256:hash(sourceBytes),outputSha256:hash(outputBytes),sharedCalculator:true,clinicalInterpretationVerified:false,deviceConnectionVerified:false}]};
 }catch{return {applicable:true,passed:false,status:'unverified',reasons:['health-report-current-content-unverified'],checks:[]};}
}
