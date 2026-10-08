import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

const HANDOFF_ID='12345678-1234-1234-1234-123456789012';
const BROKER_TOKEN='synthetic-broker-token-for-isolated-test';
const TICKET='A'.repeat(43);
const READ_SCOPES=[
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly'
];
const shell=process.env.SystemRoot?join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe';

// The HTTP server runs in this process. A synchronous child wait would prevent
// it from answering and incorrectly classify every loopback request as unavailable.
function runNetworkChild(command,args,options){
  return new Promise(resolveResult=>{
    const {timeout=30000,...launchOptions}=options;
    const child=spawn(command,args,{...launchOptions,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',error;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',failure=>{error=failure;});
    const timer=setTimeout(()=>{error=Object.assign(new Error('Network child timed out'),{code:'ETIMEDOUT'});child.kill();},timeout);
    child.once('close',status=>{clearTimeout(timer);resolveResult({status,stdout,stderr,error});});
  });
}

test('real Windows PowerShell broker wrapper completes, reconciles restart, and contains lost-response errors without Google access',
  {skip:process.platform!=='win32'},async t=>{
    const root=mkdtempSync(join(tmpdir(),'jarvis-google-broker-e2e-'));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const credentialsDir=join(root,'profile','Jarvis','credentials');mkdirSync(credentialsDir,{recursive:true});
    const env={...process.env,LOCALAPPDATA:join(root,'profile'),OS:'Windows_NT',PSModulePath:[join(process.env.ProgramFiles??'C:\\Program Files','WindowsPowerShell','Modules'),join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')].join(';')};
    const provision=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',
      "Import-Module Microsoft.PowerShell.Security; $token=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $token -AsPlainText -Force; $path=[IO.Path]::Combine($env:LOCALAPPDATA,'Jarvis','credentials','integration-handoff-token.dpapi'); ConvertFrom-SecureString -SecureString $secure | Set-Content -NoNewline -LiteralPath $path; $secure.Dispose()"],
      {input:BROKER_TOKEN,cwd:process.cwd(),env,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(provision.error,undefined,provision.error?.message);
    assert.equal(provision.status,0,`${provision.stdout}\n${provision.stderr}`);

    const clientPath=join(root,'oauth-client.json');
    writeFileSync(clientPath,JSON.stringify({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'synthetic-client-secret'}}));
    const psScript=join(root,'personal-google-connect-service.ps1');
    const productionScript=readFileSync(resolve('scripts/personal-google-connect-service.ps1'),'utf8');
    writeFileSync(psScript,productionScript);
    const helperPath=join(root,'personal-google-connect.mjs');
    const handoffErrorsUrl=new URL('../packages/core/src/personal-operations/google-handoff-errors.js',import.meta.url).href;
    writeFileSync(helperPath,`import {googleHandoffFailureCode} from ${JSON.stringify(handoffErrorsUrl)};
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)process.exit(21);}
try{
  const handoff=JSON.parse(input);
  if(Object.keys(handoff).sort().join(',')!=='handoffId,ticket'||handoff.handoffId!=='${HANDOFF_ID}'||handoff.ticket!=='${TICKET}')throw new Error('A_GOOGLE_HANDOFF_INVALID');
  const response=await fetch(process.argv[3],{method:'POST',redirect:'error',headers:{authorization:'Bearer '+handoff.ticket,'content-type':'application/json'},body:JSON.stringify({providerAccountId:'fixture@example.test',credentials:{clientId:'fixture.apps.googleusercontent.com',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh-token'}})});
  const failure=await googleHandoffFailureCode(response);if(failure)throw new Error(failure);
  const result=await response.json();if(result.activation?.status!=='verified'||result.activation?.providerVerified!==true)throw new Error('A_GOOGLE_ACTIVATION_FAILED');
  console.log('GOOGLE_HANDOFF=completed');
}catch(error){console.error(/^A_GOOGLE_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'A_GOOGLE_CONNECT_FAILED');process.exitCode=1;}
`);

    for(const scenario of ['success','restarted','response-lost'])await t.test(scenario,async sub=>{
      const observations={issue:0,complete:0,cancel:0,authorization:[],requests:[],scopes:null,rawCredentials:null};
      const core=createServer(async(request,response)=>{
        observations.requests.push(`${request.method} ${request.url}`);
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        if(request.url==='/probe'){response.writeHead(200);response.end('probe-ok');return;}
        const raw=Buffer.concat(chunks).toString('utf8');let body={};try{body=raw?JSON.parse(raw):{};}catch{}
        observations.authorization.push(request.headers.authorization??'');
        if(request.method==='POST'&&request.url==='/integrations/handoffs'){
          observations.issue++;
          observations.scopes=body.scopes;
          response.writeHead(201,{'content-type':'application/json'});response.end(JSON.stringify({handoffId:HANDOFF_ID,ticket:TICKET,scopes:READ_SCOPES}));return;
        }
        if(request.method==='POST'&&request.url===`/integrations/handoffs/${HANDOFF_ID}/complete`){
          observations.complete++;observations.rawCredentials=body.credentials;
          assert.equal(request.headers.authorization,`Bearer ${TICKET}`);
          assert.equal(body.providerAccountId,'fixture@example.test');
          if(scenario==='response-lost'){response.socket.destroy();return;}
          if(scenario==='restarted'){response.writeHead(404,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'A_INTEGRATION_HANDOFF_NOT_FOUND'}}));return;}
          response.writeHead(202,{'content-type':'application/json'});response.end(JSON.stringify({providerVerified:false,executionAuthorized:false,activation:{status:'verified',providerVerified:true}}));return;
        }
        if(request.method==='DELETE'&&request.url===`/integrations/handoffs/${HANDOFF_ID}`){
          observations.cancel++;response.writeHead(200,{'content-type':'application/json'});response.end('{"cancelled":true}');return;
        }
        response.writeHead(404,{'content-type':'application/json'});response.end('{"error":{"code":"NOT_FOUND"}}');
      });
      const address=await listenOnFetchSafePort(core,{host:'127.0.0.1',port:0});
      const closeCore=()=>new Promise(resolveClose=>core.close(resolveClose));sub.after(closeCore);
      const probeScript=join(root,'http-probe.ps1');
      writeFileSync(probeScript,`param([int]$Port)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$handler=[System.Net.Http.HttpClientHandler]::new(); $handler.UseProxy=$false
$client=[System.Net.Http.HttpClient]::new($handler)
try { $client.Timeout=[TimeSpan]::FromSeconds(1); $response=$client.GetAsync("http://127.0.0.1:$Port/probe").GetAwaiter().GetResult(); Write-Output ([int]$response.StatusCode); $response.Dispose() }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
finally { $client.Dispose(); $handler.Dispose() }
`);
      const probe=await runNetworkChild(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',probeScript,'-Port',String(address.port)],{cwd:root,env,timeout:4000,windowsHide:true});
      assert.equal(probe.error,undefined,probe.error?.message);
      assert.equal(probe.status,0,probe.stderr);assert.match(probe.stdout,/200/u);assert.ok(observations.requests.includes('GET /probe'));
      const result=await runNetworkChild(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',psScript,'-ClientPath',clientPath,'-CorePort',String(address.port)],
        {cwd:root,env,encoding:'utf8',timeout:30000,windowsHide:true});
      assert.equal(result.error,undefined,result.error?.message);
      assert.equal(observations.issue,1,`issue request missing on port=${address.port}; requests=${JSON.stringify(observations.requests)}; status=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
      assert.deepEqual(observations.scopes,READ_SCOPES);
      assert.deepEqual(observations.authorization.slice(0,1),[`Bearer ${BROKER_TOKEN}`]);
      assert.equal(observations.complete,1);
      assert.deepEqual(observations.rawCredentials,{clientId:'fixture.apps.googleusercontent.com',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh-token'});
      assert.ok(observations.authorization.includes(`Bearer ${TICKET}`));
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,/synthetic-client-secret|synthetic-refresh-token|synthetic-broker-token/u);
      if(scenario==='success'){
        assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout,/GOOGLE_HANDOFF=completed/u);
        assert.equal(observations.cancel,0);
      }else{
        assert.notEqual(result.status,0);
        assert.doesNotMatch(result.stdout,/GOOGLE_HANDOFF=completed/u);
        assert.equal(observations.cancel,1);
        if(scenario==='restarted')assert.match(`${result.stdout}\n${result.stderr}`,/A_GOOGLE_HANDOFF_RESTARTED/u);
        if(scenario==='response-lost')assert.match(`${result.stdout}\n${result.stderr}`,/A_GOOGLE_CONNECT_FAILED/u);
      }
      if(scenario==='success')assert.deepEqual(observations.authorization,[`Bearer ${BROKER_TOKEN}`,`Bearer ${TICKET}`]);
      else assert.deepEqual(observations.authorization,[`Bearer ${BROKER_TOKEN}`,`Bearer ${TICKET}`,`Bearer ${BROKER_TOKEN}`]);
    });
  });
