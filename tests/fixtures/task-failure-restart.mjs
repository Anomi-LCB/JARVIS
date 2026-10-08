import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {ExcelWorkbookWorker} from '../../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
import {spawn} from 'node:child_process';
import {NativeWorkbookPdfRenderer} from '../../apps/pc-agent/src/adapters/excel/native-pdf-renderer.js';
import {writeFile} from 'node:fs/promises';
const [mode,root,id]=process.argv.slice(2);
const runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerQueueStorePath:join(root,'queue.json'),workerDaemonEnabled:false});
try {
 if(mode==='write-workflow') {
  await writeFile(join(root,'input.json'),'[{"total":7}]');
  const digest=runtime.capabilityPackageRegistry.activations.get('workflow.execute').packageDigest;
  runtime.pcAgent.registry.get('workflow.execute').execute=async()=>({status:'failed',error:{code:'WORKFLOW_NUMBER_INVALID',message:'PRIVATE_WORKFLOW_FAILURE'},executionCodeVersion:'0'.repeat(64),outputPaths:[],changedItems:[],rollbackAvailable:false});
  const mission=runtime.missionRuntime.createMission({objective:"'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 1인지 검증하고; '원본'을 'output.json' JSON으로 저장해",authorization:{grants:['read_only','local_reversible']},successCriteria:[{statement:'합계7',verificationSpec:{version:1,kind:'json.value',path:'output.json',pointer:'/0/total',equals:7}}]});
  await runtime.missionRuntime.runMission(mission.missionId);
  const observed=[...runtime.orchestrationWorker.failureObservations.values()][0];
  console.log(JSON.stringify({taskId:observed.taskId,status:observed.status,success:false,executionCodeVersion:digest,pid:process.pid}));
 } else if(mode==='write'||mode==='write-native') {
  const inputPath=join(root,'saved.xlsx');await new ExcelWorkbookWorker().writeWorkbook({outputPath:inputPath,columns:['Value'],rows:[[10]]});
  runtime.pcAgent.registry.get('excel.exportPdf').renderer=mode==='write-native'?new NativeWorkbookPdfRenderer({spawnProcess(executable,args,options){const child=spawn(executable,args,options);let stdout='',stopped=false;child.stdout.on('data',chunk=>{stdout+=chunk;if(!stopped&&/EXCEL_RENDER_OWNED_PROCESS=\d+:\d+/u.test(stdout)){stopped=true;setImmediate(()=>child.kill('SIGKILL'));}});return child;}}):{async render(){throw Object.assign(Error('synthetic failure'),{code:'EXCEL_PDF_EXPORT_FAILED',nativeRecovery:{version:1,phase:'activation-unconfirmed',cleanupConfirmed:false,activationGapUnverified:true,autoRetryAllowed:false,executionAuthority:false,secret:'excluded-secret'}});}};
  const task=runtime.coreFacade.createTask(`"${inputPath}"를 "${join(root,'out.pdf')}"로 변환해줘`);
  const run=await runtime.orchestrationWorker.runTask(task.taskId);
  console.log(JSON.stringify({taskId:task.taskId,status:task.status,success:run.success}));
 } else {
  let executions=0;runtime.pcAgent.execute=async()=>{executions++;throw Error('Archived record must never execute');};
  const server=createCoreServer(runtime.coreFacade,{adminToken:'test-restart-admin',orchestrationWorker:runtime.orchestrationWorker});
  await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  try {
   const base=`http://127.0.0.1:${server.address().port}`;
   const headers={Authorization:'Bearer test-restart-admin'};
   const unauthorized=await fetch(`${base}/tasks/${id}`);
   const response=await fetch(`${base}/tasks/${id}`,{headers});const detail=await response.json();
   const list=await(await fetch(`${base}/tasks`,{headers})).json();
   const run=await fetch(`${base}/tasks/${id}/run`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});
   const drained=await runtime.orchestrationWorker.drain();
   console.log(JSON.stringify({status:response.status,unauthorized:unauthorized.status,detail,list,runStatus:run.status,processed:drained.processed,executions,liveTaskCount:runtime.coreFacade.tasks.size,pid:process.pid}));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
} finally {runtime.coreFacade.cognition.close();}
