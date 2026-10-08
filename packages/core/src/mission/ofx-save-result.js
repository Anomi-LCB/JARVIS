import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createOfxSaveWorkflow} from './ofx-save-workflow.js';
import {buildOfxFinancialReport} from '../../../shared/src/ofx-financial-report.js';
import {readGuardedResultFile} from './mission-field-summary-result.js';
import {isDeepStrictEqual} from 'node:util';
const hash=value=>createHash('sha256').update(value).digest('hex');

// Prepared saves are separate from natural-language compilation. Only a caller
// holding the original validated request may supply this verification contract.
export function verifyOfxSaveResult({input,operationId,workspaceRoot,workflow,includeReport=false,beforeAccess}) {
 try {
  const prepared=createOfxSaveWorkflow(input,{operationId});
  if(!workspaceRoot||workflow?.workflowId!==prepared.spec.workflowId
   ||workflow.specSha256!==hash(JSON.stringify(prepared.spec))||workflow.nodeCount!==5)throw Error('binding');
  const receipts=prepared.spec.nodes.map(node=>{
   const matches=workflow.receipts.filter(r=>r.nodeId===node.id&&r.op===node.op&&r.status==='success');
   if(matches.length!==1)throw Error('receipt');return matches[0];
  });
  const root=resolve(workspaceRoot);
  const sourceBytes=readGuardedResultFile(root,resolve(root,prepared.inputPath),beforeAccess);
  const outputBytes=readGuardedResultFile(root,resolve(root,prepared.reportPath),beforeAccess);
  for(const [receipt,path,bytes] of [[receipts[1],prepared.inputPath,sourceBytes],[receipts[4],prepared.reportPath,outputBytes]]) {
   if(resolve(receipt.source.path)!==resolve(root,path)||receipt.source.sha256!==hash(bytes))throw Error('current');
  }
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const source=JSON.parse(decoder.decode(sourceBytes));
  if(!isDeepStrictEqual(source,input))throw Error('request');
  const report=decoder.decode(outputBytes);
  if(report!==buildOfxFinancialReport(source).reportMarkdown)throw Error('content');
  return {passed:true,status:'passed',sourceAuthenticated:false,executionAuthority:false,sharedCalculator:true,
   sourceSha256:hash(sourceBytes),outputSha256:hash(outputBytes),
   ...(includeReport?{reportMarkdown:report,checkedAt:new Date().toISOString()}: {})};
 }catch{return {passed:false,status:'unverified',reason:'ofx-save-current-content-unverified'};}
}
