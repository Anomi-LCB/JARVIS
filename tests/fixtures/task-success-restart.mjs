import {join} from 'node:path';
import {createAgRuntime} from '../../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
const [mode,root,id]=process.argv.slice(2);
const runtime=createAgRuntime({allowedRoots:mode==='read-revoked'?[join(root,'other')]:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerQueueStorePath:join(root,'queue.json'),workerDaemonEnabled:false});
try{
 if(mode==='write'){
  const task=runtime.coreFacade.createTask(`"${join(root,'report.txt')}" 텍스트 파일을 만들어줘. 내용은 실행 검증 결과`);
  const run=await runtime.orchestrationWorker.runTask(task.taskId);
  console.log(JSON.stringify({taskId:task.taskId,success:run.success,status:task.status,outputPaths:task.executionResult?.executionResult?.outputPaths,archived:runtime.orchestrationWorker.archivedTask(task.taskId),verificationId:task.executionVerification?.verificationId}));
 }else{
  const server=createCoreServer(runtime.coreFacade,{adminToken:'success-restart-test',orchestrationWorker:runtime.orchestrationWorker});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
  try{
   const url=`http://127.0.0.1:${server.address().port}/tasks/${id}`,headers={Authorization:'Bearer success-restart-test'};
   const detail=await(await fetch(url,{headers})).json();
   const preview=await fetch(url+'/record-artifacts/0',{headers});const body=await preview.json();
   console.log(JSON.stringify({detail,previewStatus:preview.status,preview:body,unauthorized:(await fetch(url+'/record-artifacts/0')).status,runStatus:(await fetch(url+'/run',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,liveTaskCount:runtime.coreFacade.tasks.size}));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
}finally{runtime.coreFacade.cognition.close();}
