import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('owned Python job kills a real descendant when its parent is terminated',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-hwpx-job-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const receipt=join(root,'receipt.json'),guard=resolve('apps/pc-agent/src/adapters/hwpx/process-job-guard.py');
 const script="import sys,importlib.util,subprocess,time,json,pathlib; spec=importlib.util.spec_from_file_location('guard',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); g=m.install_process_guard(); c=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); pathlib.Path(sys.argv[2]).write_text(json.dumps({'guard':g,'childPid':c.pid})); time.sleep(60)";
 const parent=spawn(process.env.JARVIS_HWPX_PYTHON??'python',['-c',script,guard,receipt],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let errors='';parent.stderr.on('data',b=>{errors+=b;});t.after(()=>{if(parent.exitCode===null)parent.kill();});
 const closed=new Promise(resolve=>parent.once('close',resolve));let state;
 for(let i=0;i<150;i++){try{state=JSON.parse(await readFile(receipt,'utf8'));break;}catch{}if(parent.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,40));}
 assert.ok(state,errors);assert.equal(state.guard.jobAssigned,true);assert.equal(state.guard.killOnClose,true);assert.equal(state.guard.processId,parent.pid);
 assert.doesNotThrow(()=>process.kill(state.childPid,0),'real descendant must exist before cancellation');
 parent.kill();await closed;
 let alive=true;for(let i=0;i<75;i++){try{process.kill(state.childPid,0);}catch(error){assert.equal(error.code,'ESRCH');alive=false;break;}await new Promise(resolve=>setTimeout(resolve,40));}
 assert.equal(alive,false,'owned descendant must not survive parent termination');
});
