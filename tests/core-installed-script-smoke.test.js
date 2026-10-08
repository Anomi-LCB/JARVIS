import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {writeCoreServicePackage} from '../packages/core/src/install/core-service-packager.js';
const exec=promisify(execFile);
test('generated Windows smoke and soak scripts use real authenticated packaged Core',{skip:process.platform!=='win32',timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-core-script-한글-')),stateRoot=join(root,'state');let child;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await rm(root,{recursive:true,force:true});});
 const workspace=join(stateRoot,'workspace');await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'note.txt'),'isolated script test');
 const packageRoot=join(process.cwd(),'artifacts/packaged-core-runtime-20261003/package');
 const manifest=JSON.parse(await readFile(join(packageRoot,'package-manifest.json'),'utf8'));
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const serviceDir=join(root,'scripts');await writeCoreServicePackage({outputDir:serviceDir,port,
  installedRuntime:{packageRoot,stateRoot,launcherSha256:manifest.fileIntegrity['pc-agent-runtime/core-launch.mjs'].sha256,nodeSha256:manifest.fileIntegrity['runtime/node.exe'].sha256}});
 const token='isolated-installed-script-auth',env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
  JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',
  JARVIS_CORE_STATE_ROOT:stateRoot,JARVIS_CORE_AUDIT_ROOT:join(stateRoot,'audit'),JARVIS_TEST_AUDIT_ROOT:join(stateRoot,'test-audit'),
  JARVIS_CORE_ALLOWED_ROOTS:workspace,JARVIS_CORE_ADMIN_TOKEN:token,PORT:String(port),JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0'};
 child=spawn(join(packageRoot,'runtime/node.exe'),[join(packageRoot,'pc-agent-runtime/core-launch.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('Readiness timeout '+output+errors)),45000);
  child.stdout.on('data',data=>{output+=data;if(output.includes('listening at')){clearTimeout(timer);resolve();}});child.stderr.on('data',data=>{errors+=data;});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Core exit ${code}: ${errors}`));});});
 assert.equal((await fetch(`http://127.0.0.1:${port}/tasks`)).status,401);
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(serviceDir,'run-installed-service-smoke.ps1')],{windowsHide:true,env,timeout:20000});
 const smoke=JSON.parse((await readFile(join(serviceDir,'installed-service-smoke.json'),'utf8')).replace(/^\uFEFF/u,''));
 assert.equal(smoke.status,'passed');assert.equal(smoke.taskStatus,'COMPLETED');
 await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(serviceDir,'run-installed-service-soak.ps1'),'-TaskCount','3'],{windowsHide:true,env,timeout:30000});
 const soak=JSON.parse((await readFile(join(serviceDir,'installed-service-soak.json'),'utf8')).replace(/^\uFEFF/u,''));
 assert.equal(soak.status,'passed');assert.equal(soak.taskCount,3);assert.equal(soak.completedCount,3);assert.equal(soak.verifiedCount,3);
 assert.doesNotMatch(JSON.stringify({smoke,soak}),new RegExp(token));
 console.log(JSON.stringify({generatedPowerShellActualExecution:true,authRequired:true,smokePassed:true,soakCompleted:3,packagedNodeAndCore:true,scmServiceInstalled:false}));
});
