import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';

async function runChild(state,codeRoot,mode,mutation){
 const child=fork(new URL('./fixtures/lifecycle-case-restart-child.mjs',import.meta.url),[state,mode,mutation],{
  cwd:state,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
  env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,
   JARVIS_TEST_MODE:'0',JARVIS_TEST_CASE_PACKAGE_ROOT:codeRoot}});
 let result,output='';child.on('message',m=>{result=m;});child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 const timer=setTimeout(()=>child.kill(),90000);
 try{const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});assert.equal(code,0,JSON.stringify({result,output}));assert.equal(result?.ok,true,JSON.stringify({result,output}));return result;}
 finally{clearTimeout(timer);if(child.exitCode===null&&!child.killed)child.kill();}
}

test('current PC package local case Mission survives new PID and refuses changed evidence',{skip:process.platform!=='win32',timeout:180000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-packaged-case-')),packageDir=join(root,'package'),stateRoot=join(root,'state');
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-packaged-case-'));await rm(root,{recursive:true,force:true});});
 await mkdir(stateRoot,{recursive:true});
 const plan=await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir:packageDir,pcAgentStateRoot:stateRoot});
 for(const path of ['apps/runtime-compose/src/lifecycle-case-service-access.js','packages/core/src/mission/lifecycle-case-task-receipts.js','scripts/core-service-runtime.mjs','src/ui/workspace/lifecycle-case-mission-client.js']){
  const name='pc-agent-runtime/'+path,bytes=await readFile(join(packageDir,name));
  assert.deepEqual(bytes,await readFile(path));assert.equal(plan.manifest.fileIntegrity[name].sha256,createHash('sha256').update(bytes).digest('hex'));
 }
 for(const mutation of ['none','source-changed','signature','availability','mandate']){
  const state=join(stateRoot,mutation);await mkdir(join(state,'workspace'),{recursive:true});
  const created=await runChild(state,join(packageDir,'pc-agent-runtime'),'create','none');
  const recovered=await runChild(state,join(packageDir,'pc-agent-runtime'),'recover',mutation);
  assert.notEqual(created.pid,recovered.pid);assert.equal(recovered.verified,mutation==='none');
  t.diagnostic(JSON.stringify({packageSource:true,mutation,created,recovered}));
 }
});
