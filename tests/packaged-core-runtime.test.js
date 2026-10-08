import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';

test('packaged Core executes and observes restart history without repository runtime',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-packaged-core-'));
 const packageDir=join(root,'package'),stateRoot=join(root,'state'),workspace=join(stateRoot,'workspace');
 const children=[];
 const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}};
 t.after(async()=>{for(const child of children)await stop(child);await rm(root,{recursive:true,force:true});});
 await mkdir(workspace,{recursive:true});
 await writeInstallerPackage({...await loadPcAgentInstallConfig(),cwd:process.cwd(),outputDir:packageDir});
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
  JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',
  JARVIS_TEST_AUDIT_ROOT:join(stateRoot,'test-audit'),JARVIS_CORE_AUDIT_ROOT:join(stateRoot,'audit'),
  JARVIS_CORE_STATE_ROOT:stateRoot,JARVIS_CORE_ALLOWED_ROOTS:workspace,
  JARVIS_CORE_ADMIN_TOKEN:'packaged-core-isolated-token',JARVIS_CORE_HOST:'0.0.0.0',PORT:'0',
  JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0'};
 const start=async()=>{
  const child=spawn(process.execPath,[join(packageDir,'pc-agent-runtime/core-launch.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
  return new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('Core readiness timeout: '+errors)),15000);
   child.stderr.on('data',data=>{errors+=data;});
   child.stdout.on('data',data=>{output+=data;const match=output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);if(match){clearTimeout(timer);resolve({child,base:match[1]});}});
   child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Core exit ${code}: ${errors}`));});
  });
 };
 const headers={Authorization:'Bearer packaged-core-isolated-token','Content-Type':'application/json'};
 const post=async(base,path,body)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const first=await start();
 assert.equal((await fetch(first.base+'/tasks')).status,401);
 const created=await post(first.base,'/tasks',{rawText:`"${join(workspace,'report.txt')}" 텍스트 파일을 만들어줘. 내용은 설치본 테스트`});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const run=await post(first.base,`/tasks/${created.body.taskId}/run`,{options:{userConfirmation:{confirmed:true}}});
 assert.equal(run.status,200);assert.equal(run.body.success,true,JSON.stringify(run.body));
 assert.equal(await readFile(join(workspace,'report.txt'),'utf8'),'설치본 테스트');
 await stop(first.child);
 const second=await start();
 const detail=await fetch(second.base+`/tasks/${created.body.taskId}`,{headers}).then(r=>r.json());
 assert.equal(detail.status,'COMPLETED');assert.equal(detail.archivedObservation,true);
 assert.equal(detail.historicalVerification.currentSemanticVerification,false);
 const preview=await fetch(second.base+`/tasks/${created.body.taskId}/record-artifacts/0`,{headers});
 assert.equal(preview.status,200);assert.equal((await preview.json()).text,'설치본 테스트');
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const uiPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const ui=spawn(process.execPath,[join(packageDir,'control-center-host/launch.mjs')],{cwd:root,
  env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,PORT:String(uiPort),JARVIS_CORE_API_URL:second.base,JARVIS_CORE_ADMIN_TOKEN:env.JARVIS_CORE_ADMIN_TOKEN},
  windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(ui);
 const uiBase=await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('UI readiness timeout: '+errors)),10000);
  ui.stderr.on('data',data=>{errors+=data;});ui.stdout.on('data',data=>{output+=data;const match=output.match(/available at (http:\/\/127\.0\.0\.1:\d+)/u);if(match){clearTimeout(timer);resolve(match[1]);}});
  ui.once('exit',code=>{clearTimeout(timer);reject(new Error(`UI exit ${code}: ${errors}`));});});
 const uiPreview=await fetch(uiBase+`/api/core/tasks/${created.body.taskId}/record-artifacts/0`);
 assert.equal(uiPreview.status,200);assert.equal((await uiPreview.json()).text,'설치본 테스트');
 const html=await fetch(uiBase+'/').then(r=>r.text());assert.equal(html,await readFile(join(packageDir,'control-center-ui/index.html'),'utf8'));
 assert.doesNotMatch(html,/packaged-core-isolated-token/);
 assert.equal((await post(second.base,`/tasks/${created.body.taskId}/run`,{})).status,404);
 await writeFile(join(workspace,'report.txt'),'変更された内容');
 assert.equal((await fetch(second.base+`/tasks/${created.body.taskId}/record-artifacts/0`,{headers})).status,409);
 assert.equal((await fetch(uiBase+`/api/core/tasks/${created.body.taskId}/record-artifacts/0`)).status,409);
 await stop(ui);
 await stop(second.child);
 const alias=join(root,'code-alias');await symlink(packageDir,alias,process.platform==='win32'?'junction':'dir');
 for(const [override,expected] of [[{JARVIS_CORE_STATE_ROOT:''},'CORE_RUNTIME_STATE_ROOT_REQUIRED'],
  [{JARVIS_CORE_STATE_ROOT:packageDir},'CORE_RUNTIME_STATE_ROOT_IS_CODE'],
  [{JARVIS_CORE_STATE_ROOT:join(alias,'forbidden-state')},'CORE_RUNTIME_STATE_ROOT_IS_CODE'],
  [{JARVIS_CORE_ROOT:join(root,'conflicting-state')},'CORE_RUNTIME_ROOT_CONFLICT']]){
  const invalid=spawn(process.execPath,[join(packageDir,'pc-agent-runtime/core-launch.mjs')],{cwd:root,env:{...env,...override},windowsHide:true,stdio:['ignore','ignore','pipe']});children.push(invalid);
  let errors='';invalid.stderr.on('data',data=>{errors+=data;});const [exitCode]=await once(invalid,'exit');
  assert.notEqual(exitCode,0);assert.ok(errors.includes(expected),errors);
 }
 await assert.rejects(access(join(packageDir,'forbidden-state')));
 // Integrity must fail before importing altered runtime code.
 await writeFile(join(packageDir,'pc-agent-runtime/scripts/core-service-runtime.mjs'),'throw new Error("TAMPER_EXECUTED");');
 const damaged=spawn(process.execPath,[join(packageDir,'pc-agent-runtime/core-launch.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});children.push(damaged);
 let stderr='';damaged.stderr.on('data',data=>{stderr+=data;});
 const [code]=await once(damaged,'exit');assert.notEqual(code,0);assert.match(stderr,/PC_RUNTIME_INTEGRITY_FAILED/);assert.doesNotMatch(stderr,/TAMPER_EXECUTED/);
});
