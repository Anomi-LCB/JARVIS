import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoogleConnectionController} from '../packages/core/src/personal-operations/google-connection-controller.js';

function fixture(t,{outcome=null,handoff=true}={}){
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-helper-proof-')),clientPath=join(root,'client.json');
 writeFileSync(clientPath,JSON.stringify({installed:{client_id:'synthetic.apps.googleusercontent.com',client_secret:'synthetic-client-secret'}}));
 const child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const launches=[],cancelled=[];
 const handoffs=handoff?{issue:()=>({handoffId:'12345678-1234-1234-1234-123456789012',ticket:'synthetic-ticket'}),cancel:id=>cancelled.push(id),getOutcome:()=>outcome}:null;
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,onConnected:async()=>{},
  helperEnv:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,LOCALAPPDATA:root,JARVIS_CORE_ADMIN_TOKEN:'synthetic-admin-secret',OPENAI_API_KEY:'synthetic-model-secret',JARVIS_GOOGLE_REFRESH_TOKEN:'synthetic-refresh-secret'},
  launch:(executable,args,options)=>{launches.push({executable,args,options});return child;}});
 t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});
 return {controller,child,clientPath,launches,cancelled};
}

for(const code of [0,1])for(const state of ['provider-verified','credentials-stored-unverified','missing'])test(`helper exit ${code} requires server evidence ${state}`,t=>{
 const f=fixture(t,{outcome:state==='missing'?null:{status:state}});
 f.controller.start({clientPath:f.clientPath,completionOrigin:'http://127.0.0.1:17776'});f.child.emit('exit',code);
 if(state==='provider-verified')assert.deepEqual(f.controller.status(),{status:'connected'});
 else if(state==='credentials-stored-unverified')assert.deepEqual(f.controller.status(),{status:'verification-required',code:'A_GOOGLE_HANDOFF_STORED_UNVERIFIED'});
 else{assert.equal(f.controller.status().status,'failed');if(code===0)assert.equal(f.controller.status().code,'A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE');}
 assert.equal(f.cancelled.length,state==='missing'?1:0);
 assert.doesNotMatch(JSON.stringify(f.controller.status()),/synthetic-|client.json/);
});

for(const handoff of [false,true])test(`OAuth helper receives only required OS environment with handoff=${handoff}`,t=>{
 const f=fixture(t,{handoff});f.controller.start({clientPath:f.clientPath,...(handoff?{completionOrigin:'http://127.0.0.1:17776'}:{})});
 const env=f.launches[0].options.env;
 assert.ok(env);assert.equal(env.PATH,process.env.PATH);
 for(const name of ['JARVIS_CORE_ADMIN_TOKEN','OPENAI_API_KEY','JARVIS_GOOGLE_REFRESH_TOKEN'])assert.equal(env[name],undefined);
 assert.equal(f.launches[0].options.shell,false);assert.equal(f.launches[0].options.windowsHide,true);
});
