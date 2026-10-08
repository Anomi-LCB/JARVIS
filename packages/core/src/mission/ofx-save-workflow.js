import {buildOfxFinancialReport} from '../../../shared/src/ofx-financial-report.js';
import {validateWorkflowSpec} from './workflow-ir.js';
/** Prepare fixed output names; execution still requires the existing E/B/G path. */
export function createOfxSaveWorkflow(input,{operationId}={}){
 if(!/^[a-f0-9]{32}$/u.test(operationId??''))throw new TypeError('Server operation ID required');
 if(!input||Object.keys(input).some(k=>!['xml','currencyExponents','classifications','receipts','budgets'].includes(k)))throw new TypeError('Invalid financial input keys');
 buildOfxFinancialReport(input);
 const bundle=structuredClone(input),inputPath=`financial-input-${operationId}.json`,reportPath=`financial-report-${operationId}.md`;
 const ref=(nodeId,pointer,expectedType)=>({$ref:{nodeId,pointer,expectedType}});
 const spec=validateWorkflowSpec({schemaVersion:'jarvis-local-workflow-v1',workflowId:'ofx-save-'+operationId,nodes:[
 {id:'save-input',op:'write.json',args:{path:inputPath,value:bundle}},
 {id:'read-input',op:'data.readJson',dependsOn:['save-input'],args:{path:inputPath}},
 {id:'report',op:'financial.ofxReport',dependsOn:['read-input'],args:{input:ref('read-input','/value','object')}},
 {id:'save-report',op:'write.text',dependsOn:['report'],args:{path:reportPath,text:ref('report','/reportMarkdown','string')}},
 {id:'read-report',op:'text.read',dependsOn:['save-report'],args:{path:reportPath}}
 ],outputs:[{nodeId:'save-input',path:inputPath,mediaType:'application/json'},{nodeId:'save-report',path:reportPath,mediaType:'text/plain'}]});
 return {spec,inputPath,reportPath,allowOverwrite:false};
}
