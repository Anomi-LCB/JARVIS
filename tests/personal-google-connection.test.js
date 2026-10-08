import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {GoogleConnectionController} from '../packages/core/src/personal-operations/google-connection-controller.js';
function setup(t,onConnected=async()=>{},interactiveSession=true){const root=mkdtempSync(join(tmpdir(),'jarvis-connect-ui-')),path=join(root,'client.json');writeFileSync(path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'private-test'}}));const child=new EventEmitter();child.kill=()=>{child.killed=true;};let calls=0;const controller=new GoogleConnectionController({platform:'win32',interactiveSession,onConnected,launch:(executable,args,options)=>{calls++;assert.equal(executable,process.execPath);assert.match(args[0],/personal-google-connect.mjs$/);assert.equal(args[1],path);assert.equal(options.shell,false);assert.equal(options.stdio,'ignore');return child;}});t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});return {controller,child,path,calls:()=>calls};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('local disconnection cancels the pending helper without permanently disabling later connection',async t=>{
 let activations=0;const f=setup(t,async()=>{activations++;});f.controller.start({clientPath:f.path});f.controller.cancelPendingConnection();assert.equal(f.child.killed,true);f.child.emit('exit',0);await tick();assert.equal(activations,0);assert.equal(f.controller.status().status,'disconnected');assert.equal(f.controller.closed,false);
});
test('a cancelled activation completion cannot overwrite the disconnected state',async t=>{
 let finish;const pending=new Promise(r=>finish=r),f=setup(t,()=>pending);f.controller.start({clientPath:f.path});f.child.emit('exit',0);await tick();assert.equal(f.controller.status().status,'activating');f.controller.cancelPendingConnection();finish();await f.controller.activation;assert.equal(f.controller.status().status,'disconnected');
});
test('ordinary product consent uses operator configuration and rejects browser path overrides',t=>{
 const f=setup(t);assert.equal(f.controller.setupStatus().productAuthorizationConfigured,false);
 assert.throws(()=>f.controller.start({profile:'product'}),error=>error.code==='A_GOOGLE_PRODUCT_AUTH_NOT_CONFIGURED');assert.equal(f.calls(),0);
 f.controller.defaultClientPath=f.path;assert.deepEqual(f.controller.setupStatus(),{productAuthorizationConfigured:true,interactiveSession:true});
 assert.throws(()=>f.controller.start({profile:'product',clientPath:f.path}),error=>error.code==='A_GOOGLE_PRODUCT_INPUT_INVALID');
 assert.equal(f.controller.start({profile:'product'}).status,'awaiting-consent');assert.equal(f.calls(),1);
 assert.doesNotMatch(JSON.stringify(f.controller.setupStatus()),/client.json|private-test/);
});
test('fixed OAuth helper coalesces double start, redacts input and activates after success',async t=>{let activated=0;const f=setup(t,async()=>{activated++;});assert.equal(f.controller.start({clientPath:f.path}).status,'awaiting-consent');f.controller.start({clientPath:f.path});assert.equal(f.calls(),1);assert.doesNotMatch(JSON.stringify(f.controller.status()),/private|client.json/);f.child.emit('exit',0);await tick();assert.equal(activated,1);assert.equal(f.controller.status().status,'connected');});
test('consent failure never activates and server shutdown terminates only its helper',async t=>{let activated=0;const f=setup(t,async()=>{activated++;});f.controller.start({clientPath:f.path});f.child.emit('exit',1);await tick();assert.equal(activated,0);assert.equal(f.controller.status().status,'failed');f.controller.start({clientPath:f.path});f.controller.close();assert.equal(f.child.killed,true);assert.throws(()=>f.controller.start({clientPath:f.path}),/CLOSED/);});
test('invalid Desktop client is refused before launch and activation failure is not connection success',async t=>{const f=setup(t,async()=>{throw Error('private token');});assert.throws(()=>f.controller.start({clientPath:'bad.cmd'}));writeFileSync(f.path,'{}');assert.throws(()=>f.controller.start({clientPath:f.path}));assert.equal(f.calls(),0);writeFileSync(f.path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'secret'}}));f.controller.start({clientPath:f.path});f.child.emit('exit',0);await tick();assert.deepEqual(f.controller.status(),{status:'failed',code:'A_GOOGLE_ACTIVATION_FAILED'});});
test('helper spawn errors do not expose child error output',t=>{const f=setup(t);f.controller.start({clientPath:f.path});f.child.emit('error',Error('private details'));assert.deepEqual(f.controller.status(),{status:'failed',code:'A_GOOGLE_CONNECT_FAILED'});});
test('non-interactive Windows service refuses to claim an OAuth consent window started',t=>{const f=setup(t,async()=>{},false);assert.throws(()=>f.controller.start({clientPath:f.path}),error=>error.code==='A_GOOGLE_INTERACTIVE_SESSION_REQUIRED');assert.deepEqual(f.controller.status(),{status:'blocked',code:'A_GOOGLE_INTERACTIVE_SESSION_REQUIRED'});assert.equal(f.calls(),0);});
test('connection HTTP endpoint authenticates and returns progress without claiming completion',async t=>{const f=setup(t);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');const server=createCoreServer(undefined,{adminToken:'connect-test',googleConnection:f.controller});const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${address.port}/personal-google/connect`,headers={authorization:'Bearer connect-test','content-type':'application/json'},body=JSON.stringify({clientPath:f.path});assert.equal((await fetch(url,{method:'POST',body})).status,401);const response=await fetch(url,{method:'POST',body,headers});assert.equal(response.status,202);assert.equal((await response.json()).status,'awaiting-consent');assert.equal((await (await fetch(url,{headers})).json()).status,'awaiting-consent');});

test('Google connect endpoint reports service session block without spawning a hidden helper',async t=>{const f=setup(t,async()=>{},false);const {createCoreServer}=await import('../packages/core/src/main.mjs');const {listenOnFetchSafePort}=await import('../packages/shared/src/http.js');const server=createCoreServer(undefined,{adminToken:'connect-test',googleConnection:f.controller});const address=await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${address.port}/personal-google/connect`,headers={authorization:'Bearer connect-test','content-type':'application/json'},body=JSON.stringify({clientPath:f.path});const response=await fetch(url,{method:'POST',body,headers});assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:'A_GOOGLE_INTERACTIVE_SESSION_REQUIRED'}});assert.deepEqual(await (await fetch(url,{headers})).json(),{status:'blocked',code:'A_GOOGLE_INTERACTIVE_SESSION_REQUIRED'});assert.equal(f.calls(),0);});

test('shutdown waits for activation before dependent stores can be closed',async t=>{let finish;const pending=new Promise(resolve=>finish=resolve);const f=setup(t,()=>pending);f.controller.start({clientPath:f.path});f.child.emit('exit',0);await tick();let stopped=false;const closing=f.controller.close().then(()=>{stopped=true;});await tick();assert.equal(stopped,false);finish();await closing;assert.equal(stopped,true);assert.notEqual(f.controller.status().status,'connected');});

test('service-vault OAuth handoff sends a one-use ticket only through child stdin and cancels on failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-handoff-')),path=join(root,'client.json');writeFileSync(path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'private-test'}}));
 const child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};let stdin='';child.stdin.on('data',chunk=>stdin+=chunk);
 let issued,cancelled;const handoffs={issue:request=>{issued=request;return {handoffId:'12345678-1234-1234-1234-123456789012',ticket:'secret-ticket-only-on-stdin'};},cancel:id=>{cancelled=id;}};
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,helperEnv:{PATH:'C:\\Windows\\System32',JARVIS_CORE_ADMIN_TOKEN:'must-not-inherit'},launch:(executable,args,options)=>{assert.equal(args[1],path);assert.equal(args[2],'http://127.0.0.1:17776/integrations/handoffs/12345678-1234-1234-1234-123456789012/complete');assert.deepEqual(options.stdio,['pipe','ignore','pipe']);assert.equal(options.env.JARVIS_CORE_ADMIN_TOKEN,undefined);assert.equal(options.env.PATH,'C:\\Windows\\System32');assert.doesNotMatch(JSON.stringify(args),/secret-ticket-only-on-stdin/u);return child;}});
 t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});
 controller.start({clientPath:path,completionOrigin:'http://127.0.0.1:17776'});
 assert.deepEqual(issued,{connectorId:'jarvis-google-workspace',authMethod:'oauth2',scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.events.readonly'],ttlMs:360000});
 assert.equal(stdin,JSON.stringify({handoffId:'12345678-1234-1234-1234-123456789012',ticket:'secret-ticket-only-on-stdin'}));
 child.stderr.write('A_GOOGLE_HANDOFF_RESTARTED\n');child.emit('exit',1);assert.equal(cancelled,'12345678-1234-1234-1234-123456789012');assert.deepEqual(controller.status(),{status:'failed',code:'A_GOOGLE_HANDOFF_RESTARTED'});
});

test('service-vault helper failure output is allowlisted and private child details are discarded',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-handoff-error-')),path=join(root,'client.json');writeFileSync(path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'private-test'}}));
 const child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const handoffs={issue:()=>({handoffId:'12345678-1234-1234-1234-123456789012',ticket:'secret-ticket'}),cancel:()=>{}};
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,launch:()=>child});
 t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});controller.start({clientPath:path,completionOrigin:'http://127.0.0.1:17776'});
 child.stderr.write('provider response contained private token: xyz\nA_GOOGLE_HANDOFF_EXPIRED\n');child.emit('exit',1);
 assert.deepEqual(controller.status(),{status:'failed',code:'A_GOOGLE_HANDOFF_EXPIRED'});assert.doesNotMatch(JSON.stringify(controller.status()),/private|xyz|token/u);
});

test('lost OAuth response reconciles a verified handoff instead of overwriting it as failed',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-response-lost-')),path=join(root,'client.json');writeFileSync(path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'private-test'}}));
 const child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const outcomes=new Map();let cancelled=false;
 const handoffs={issue:()=>({handoffId:'12345678-1234-1234-1234-123456789012',ticket:'secret-ticket'}),getOutcome:id=>outcomes.get(id)??null,cancel:()=>{cancelled=true;}};
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,launch:()=>child});
 t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});
 controller.start({clientPath:path,completionOrigin:'http://127.0.0.1:17776'});
 outcomes.set('12345678-1234-1234-1234-123456789012',{status:'provider-verified'});
 child.stderr.write('A_GOOGLE_CONNECT_FAILED\n');child.emit('exit',1);
 assert.deepEqual(controller.status(),{status:'connected'});
 assert.equal(cancelled,false);
});

test('lost OAuth response with saved but unverified credentials requests status refresh, not a second consent',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-google-unverified-response-lost-')),path=join(root,'client.json');writeFileSync(path,JSON.stringify({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'private-test'}}));
 const child=new EventEmitter();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};let cancelled=false;
 const handoffs={issue:()=>({handoffId:'12345678-1234-1234-1234-123456789012',ticket:'secret-ticket'}),getOutcome:()=>({status:'credentials-stored-unverified'}),cancel:()=>{cancelled=true;}};
 const controller=new GoogleConnectionController({platform:'win32',interactiveSession:true,handoffs,launch:()=>child});
 t.after(()=>{controller.close();rmSync(root,{recursive:true,force:true});});
 controller.start({clientPath:path,completionOrigin:'http://127.0.0.1:17776'});child.emit('exit',1);
 assert.deepEqual(controller.status(),{status:'verification-required',code:'A_GOOGLE_HANDOFF_STORED_UNVERIFIED'});
 assert.equal(cancelled,false);
});
