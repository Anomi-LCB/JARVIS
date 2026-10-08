import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve,sep,basename} from 'node:path';
async function child(root,mode,mutation){
 const instance=fork(new URL('./fixtures/lifecycle-case-restart-child.mjs',import.meta.url),[root,mode,mutation],{env:{...process.env,JARVIS_TEST_MODE:'0',JARVIS_TEST_TRUST_SECRET:'',JARVIS_TRUST_KERNEL_SECRET:'',JARVIS_CORE_ADMIN_TOKEN_SHA256:'',JARVIS_CORE_ADMIN_TOKEN:'',JARVIS_OPENAI_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',JARVIS_XAI_API_KEY:'',JARVIS_GEMINI_API_KEY:'',JARVIS_META_API_KEY:''},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 let output='',result;instance.stdout.on('data',b=>{output+=b;});instance.stderr.on('data',b=>{output+=b;});instance.on('message',m=>{result=m;});const timer=setTimeout(()=>instance.kill(),90000);
 try{const code=await new Promise((r,j)=>{instance.once('error',j);instance.once('exit',r);});assert.equal(code,0,JSON.stringify({result,output}));assert.equal(result?.ok,true,JSON.stringify({result,output}));return result;}finally{clearTimeout(timer);if(instance.exitCode===null&&!instance.killed)instance.kill();}
}
for(const mutation of ['none','source-changed','signature','missing','goal-changed','observation','grant','availability','cancelled-state','authority','mandate'])test('configured Core new PID local case receipt and fresh read authority: '+mutation,{skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-case-restart-'));t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-case-restart-'));rmSync(root,{recursive:true,force:true});});
 const created=await child(root,'create','none'),recovered=await child(root,'recover',mutation);assert.notEqual(created.pid,recovered.pid);t.diagnostic(JSON.stringify({created,recovered}));
});
