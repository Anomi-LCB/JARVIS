import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createDuffelSetupController} from '../scripts/duffel-setup-controller.mjs';
import {renderTravelConnection} from '../src/ui/connections/travel.js';
import {escape} from '../src/ui/connections/connection-center.js';
const env={JARVIS_DUFFEL_SETUP_ENABLED:'1',JARVIS_DUFFEL_SETUP_VAULT:'synthetic-vault',JARVIS_DUFFEL_SETUP_METADATA:'synthetic-metadata',
  SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,JARVIS_CORE_ADMIN_TOKEN:'must-not-inherit',OPENAI_API_KEY:'must-not-inherit'};
const saved={metadata:{schemaVersion:1,connectionId:'synthetic-public-id',revision:'revision-1'},credentialsStored:true,providerVerified:false,executionAuthorized:false,bookingAvailable:false};
function fixture(overrides={}){
  const child=new EventEmitter();Object.assign(child,{pid:123456,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  const calls=[];
  const controller=createDuffelSetupController({env,platform:'win32',spawnImpl:(...args)=>{calls.push(args);return child;},...overrides});
  const finish=(code,output='',error='')=>{child.stdout.write(output);child.stderr.write(error);child.exitCode=code;child.emit('close',code);};
  return {controller,child,calls,finish};
}
test('explicit local setup requires opt-in, interactive host, nonce and empty request; no path or grant injection',()=>{
  for(const settings of [{env:{}},{platform:'linux'},{env:{...env,JARVIS_WINDOWS_SERVICE:'1'}}])assert.equal(fixture(settings).controller.status().available,false);
  const f=fixture(),nonce=f.controller.read().nonce;
  assert.throws(()=>f.controller.start({},'bad'),/AUTH_REQUIRED/u);
  assert.throws(()=>f.controller.start({path:'evil',apiKey:'do-not-send'},nonce),/INPUT_INVALID/u);
  assert.throws(()=>f.controller.start(true,nonce),/INPUT_INVALID/u);
  assert.equal(f.calls.length,0);
  assert.equal(f.controller.start({},nonce).state,'waiting-user');
  assert.throws(()=>f.controller.start({},nonce),/AUTH_REQUIRED/u);
  assert.throws(()=>f.controller.start({},f.controller.read().nonce),/BUSY/u);assert.equal(f.calls.length,1);
  const [node,args,options]=f.calls[0];assert.equal(node,process.execPath);assert.equal(args.length,1);assert.match(args[0],/personal-duffel-connect.mjs$/u);
  assert.equal(options.env.JARVIS_CORE_ADMIN_TOKEN,undefined);assert.equal(options.env.OPENAI_API_KEY,undefined);
  assert.doesNotMatch(JSON.stringify(f.controller.status()),/synthetic-vault|nonce|must-not-inherit/u);
  f.finish(0,JSON.stringify(saved));assert.equal(f.controller.status().state,'stored-unverified');assert.equal(f.controller.status().providerVerified,false);
});
test('cancelled dialog and unknown, oversized or privileged success output never imply an activated account',()=>{
  for(const [code,out,error,expected] of [[1,'','A_DUFFEL_SETUP_CANCELLED\n','cancelled'],[0,'{}','','outcome-unknown'],
    [0,JSON.stringify({...saved,executionAuthorized:true}),'','outcome-unknown'],[0,'x'.repeat(5000),'','outcome-unknown'],
    [1,'','A_DUFFEL_SETUP_METADATA_PENDING','metadata-pending'],[1,'','arbitrary secret exception','failed']]){
    const f=fixture();f.controller.start({},f.controller.read().nonce);f.finish(code,out,error);
    assert.equal(f.controller.status().state,expected);assert.equal(f.controller.status().executionAuthorized,false);
    if(['outcome-unknown','metadata-pending'].includes(expected))assert.throws(()=>f.controller.start({},f.controller.read().nonce),/BUSY/u);
  }
});
test('close stops only owned helper tree and leaves an unknown outcome',()=>{
  const f=fixture();f.controller.start({},f.controller.read().nonce);f.controller.close();
  assert.deepEqual(f.calls[1].slice(0,2),['taskkill.exe',['/PID','123456','/T','/F']]);
  f.finish(0,JSON.stringify(saved));assert.equal(f.controller.status().state,'outcome-unknown');assert.equal(f.controller.status().available,false);
});
test('travel UI offers a local helper independently of Core availability and blocks unresolved setup replay',()=>{
  const ready=renderTravelConnection({},null,{escape,enabled:false,setup:{available:true,state:'idle'}});
  assert.match(ready,/data-travel-setup >보호/u);
  for(const state of ['waiting-user','outcome-unknown','metadata-pending']){
    const html=renderTravelConnection({},null,{escape,setup:{available:true,state}});assert.match(html,/data-travel-setup disabled/u);
  }
});
