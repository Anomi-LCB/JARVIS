// Isolated browser audit: actual Core and mTLS child; synthetic provider only.
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createConfiguredDuffelBroker} from '../../packages/core/src/personal-operations/configured-duffel-broker.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {setFixturePrivateAcl} from './windows-private-acl.mjs';
import {createDuffelSetupController} from '../../scripts/duffel-setup-controller.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const child=fork(new URL('./duffel-broker-process.mjs',import.meta.url),process.env.JARVIS_TEST_DUFFEL_REVOCATIONS?[process.env.JARVIS_TEST_DUFFEL_REVOCATIONS]:[],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
const ready=await new Promise((r,j)=>{child.once('message',r);child.once('exit',()=>j(Error('fixture exit')));});
const root=mkdtempSync(join(tmpdir(),'jarvis-duffel-ui-')),key=join(root,'core-key.pem'),metadata=join(root,'metadata.json');
const pem=n=>fileURLToPath(new URL(`./google-broker-tls/${n}.pem`,import.meta.url));
writeFileSync(key,readFileSync(pem('core-key')),{mode:0o600});
if(process.platform==='win32'){setFixturePrivateAcl(root);setFixturePrivateAcl(key);}
const row={schemaVersion:1,connectionId:'process-duffel',revision:'revision-one'};
writeFileSync(metadata,JSON.stringify(row));
const brokerEnv={JARVIS_CORE_DUFFEL_BROKER_URL:`https://127.0.0.1:${ready.address.port}/v1/duffel/quote`,JARVIS_CORE_DUFFEL_BROKER_TLS_KEY:key,
  JARVIS_CORE_DUFFEL_BROKER_TLS_CERT:pem('core'),JARVIS_CORE_DUFFEL_BROKER_TLS_CA:pem('ca'),JARVIS_CORE_DUFFEL_BROKER_METADATA:metadata};
const makeBroker=()=>createConfiguredDuffelBroker({clock:()=>new Date('2026-10-03T00:00:00Z'),env:brokerEnv});
let broker=makeBroker();
const admin='synthetic-duffel-browser-admin';let core=createCoreServer(undefined,{adminToken:admin,duffelBroker:broker});
await new Promise(r=>core.listen(0,'127.0.0.1',r));
const uiRoot=resolve('src/ui'),requests=[];
let launches=0;
const setup=createDuffelSetupController({platform:'win32',env:{JARVIS_DUFFEL_SETUP_ENABLED:'1',JARVIS_DUFFEL_SETUP_VAULT:'synthetic-vault',JARVIS_DUFFEL_SETUP_METADATA:'synthetic-metadata'},spawnImpl:()=>{
  const helper=new EventEmitter();Object.assign(helper,{pid:123456,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  const run=++launches;
  setTimeout(()=>{helper.exitCode=run===1?1:0;
    if(run===1)helper.stderr.write('A_DUFFEL_SETUP_CANCELLED');else helper.stdout.write(JSON.stringify({metadata:row,credentialsStored:true,providerVerified:false,executionAuthorized:false,bookingAvailable:false}));
    helper.emit('close',helper.exitCode);},800);
  return helper;
}});
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/api/local/capabilities'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({credentialsExposed:false,coreAdminProxyConfigured:true}));}
    if(path==='/api/local/duffel-setup'){
      requests.push({method:req.method,path});res.setHeader('content-type','application/json');
      if(req.method==='GET')return res.end(JSON.stringify(setup.read()));
      let body='';for await(const bytes of req)body+=bytes;
      try{res.statusCode=202;res.end(JSON.stringify(setup.start(JSON.parse(body),req.headers['x-jarvis-setup-nonce'])));}
      catch{res.statusCode=409;res.end('{}');}return;
    }
    if(path.startsWith('/api/core/')){
      const target=path.slice('/api/core'.length);requests.push({method:req.method,path:target});
      let body='';for await(const bytes of req)body+=bytes;
      const reply=await fetch(`http://127.0.0.1:${core.address().port}${target}`,{method:req.method,headers:{authorization:`Bearer ${admin}`,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{})});
      res.statusCode=reply.status;res.setHeader('content-type','application/json');return res.end(await reply.text());
    }
    const shared=['control-center-hosting','source-change-view','pc-local-denial','workflow-failure-guidance'].some(name=>path===`/packages/shared/src/${name}.js`);
    if(!path.startsWith('/src/ui/')&&!shared){res.statusCode=404;return res.end();}
    const file=resolve(path.slice(1));if(!shared&&!file.startsWith(uiRoot+sep)){res.statusCode=404;return res.end();}
    res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(file));
  }catch{res.statusCode=500;res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/src/ui/connections/travel.html`,corePid:process.pid,brokerPid:ready.pid,synthetic:true}));
process.stdin.setEncoding('utf8');process.stdin.on('data',async data=>{
  if(data.trim()==='restart-core'){
    const port=core.address().port;core.closeAllConnections();await new Promise(r=>core.close(r));broker.close();
    broker=makeBroker();core=createCoreServer(undefined,{adminToken:admin,duffelBroker:broker});await new Promise(r=>core.listen(port,'127.0.0.1',r));console.log(JSON.stringify({restarted:true}));
  }
  if(data.trim()==='invalidate'){writeFileSync(metadata,'{}');console.log('metadata invalidated');}
  if(data.trim()==='stop'){
    writeFileSync(process.env.JARVIS_TEST_DUFFEL_REQUEST_LOG??'artifacts/duffel-launch-20261004-browser-requests.json',JSON.stringify({observedAt:new Date().toISOString(),requests,corePid:process.pid,brokerPid:ready.pid,actualProviderCalls:0,externalWrites:0},null,2),{flag:'wx'});
    server.closeAllConnections();await new Promise(r=>server.close(r));core.closeAllConnections();await new Promise(r=>core.close(r));broker.close();
    const ended=new Promise(r=>child.once('exit',r));child.disconnect();await ended;process.exit(0);
  }
});
