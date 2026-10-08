import {verifyFinancialReportResult} from './mission-financial-report-result.js';
import {parentPort,workerData} from 'node:worker_threads';
import {verifyFieldSummaryResult} from './mission-field-summary-result.js';
import {verifyHealthReportResult} from './mission-health-report-result.js';
// Fixed read-only verifier. No environment credentials, dynamic code or model tools.
let requestId=0;
const state=workerData.accessState?new Int32Array(workerData.accessState):null;
const beforeAccess=state?({path,kind})=>{
 Atomics.store(state,0,0);parentPort.postMessage({type:'result-access',requestId:++requestId,path,kind});
 if(Atomics.wait(state,0,0,workerData.accessTimeoutMs)==='timed-out'||Atomics.load(state,0)!==1)throw new Error('result-access-denied');
}:undefined;
const input={...workerData,beforeAccess};
parentPort.postMessage({type:'verification-result',result:workerData.verifierKind==='financial-report'?verifyFinancialReportResult({...input,includeReport:true}):workerData.verifierKind==='health-report'?verifyHealthReportResult({...input,includeReport:true}):verifyFieldSummaryResult(input)});
