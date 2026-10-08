import {readFileSync,statSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {GOOGLE_CONNECTOR_ID,GOOGLE_READ_SCOPES} from './google-vault-client.js';
import {GOOGLE_HANDOFF_FAILURE_CODES} from './google-handoff-errors.js';

/** Fixed OAuth helper only: never execute a browser-supplied command or return helper output. */
export class GoogleConnectionController {
  constructor({onConnected,launch=spawn,platform=process.platform,interactiveSession=false,handoffs=null,helperEnv=process.env,defaultClientPath=helperEnv.JARVIS_GOOGLE_DESKTOP_CLIENT_PATH}){this.onConnected=onConnected;this.launch=launch;this.platform=platform;this.interactiveSession=interactiveSession===true;this.handoffs=handoffs;this.helperEnv=helperEnv;this.defaultClientPath=defaultClientPath;this.child=null;this.state={status:'idle'};this.closed=false;this.handoffId=null;}
  status(){return {...this.state};}
  setupStatus(){return {productAuthorizationConfigured:typeof this.defaultClientPath==='string'&&Boolean(this.defaultClientPath.trim()),interactiveSession:this.interactiveSession};}
  start({clientPath,completionOrigin=null,profile=null}){
    if(profile==='product'){
      if(clientPath!==undefined)throw Object.assign(Error('A_GOOGLE_PRODUCT_INPUT_INVALID'),{code:'A_GOOGLE_PRODUCT_INPUT_INVALID'});
      if(!this.defaultClientPath)throw Object.assign(Error('A_GOOGLE_PRODUCT_AUTH_NOT_CONFIGURED'),{code:'A_GOOGLE_PRODUCT_AUTH_NOT_CONFIGURED'});
      clientPath=this.defaultClientPath;
    }else if(profile!==null)throw Object.assign(Error('A_GOOGLE_PRODUCT_INPUT_INVALID'),{code:'A_GOOGLE_PRODUCT_INPUT_INVALID'});
    if(this.closed)throw Error('A_GOOGLE_CONNECTION_CLOSED');
    if(this.child||this.state.status==='activating')return this.status();
    if(this.platform!=='win32')throw Error('A_GOOGLE_WINDOWS_REQUIRED');
    if(!this.interactiveSession){this.state={status:'blocked',code:'A_GOOGLE_INTERACTIVE_SESSION_REQUIRED'};const error=Error('A_GOOGLE_INTERACTIVE_SESSION_REQUIRED');error.code='A_GOOGLE_INTERACTIVE_SESSION_REQUIRED';throw error;}
    if(typeof clientPath!=='string'||!clientPath.trim()||clientPath.length>1000||/[\u0000-\u001f]/.test(clientPath)||!clientPath.toLowerCase().endsWith('.json'))throw Error('A_GOOGLE_CLIENT_FILE_REQUIRED');
    if(!isAbsolute(clientPath)||/^[\\/]{2}/.test(clientPath))throw Error('A_GOOGLE_LOCAL_CLIENT_FILE_REQUIRED');
    const path=resolve(clientPath);if(statSync(path).size>65536)throw Error('A_GOOGLE_CLIENT_FILE_INVALID');
    const client=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,'')).installed;
    if(typeof client?.client_id!=='string'||!client.client_id.endsWith('.apps.googleusercontent.com')||typeof client.client_secret!=='string'||!client.client_secret)throw Error('A_GOOGLE_DESKTOP_CLIENT_INVALID');
    const script=fileURLToPath(new URL('../../../../scripts/personal-google-connect.mjs',import.meta.url));
    this.state={status:'awaiting-consent'};
    try{
      let handoff=null;
      if(this.handoffs){validateCompletionOrigin(completionOrigin);handoff=this.handoffs.issue({connectorId:GOOGLE_CONNECTOR_ID,authMethod:'oauth2',scopes:[...GOOGLE_READ_SCOPES],ttlMs:360_000});this.handoffId=handoff.handoffId;}
      const args=handoff?[script,path,`${validateCompletionOrigin(completionOrigin)}/integrations/handoffs/${encodeURIComponent(handoff.handoffId)}/complete`]:[script,path];
      const activationHandledByHandoff=Boolean(handoff);
      const child=this.launch(process.execPath,args,{windowsHide:true,stdio:handoff?['pipe','ignore','pipe']:'ignore',shell:false,env:googleHelperEnvironment(this.helperEnv)});this.child=child;
      let helperError='';
      if(handoff&&child.stderr?.on)child.stderr.on('data',chunk=>{helperError=(helperError+String(chunk)).slice(-512);});
      if(handoff){if(!child.stdin){child.kill();throw new Error('A_GOOGLE_HANDOFF_CHANNEL_UNAVAILABLE');}child.stdin.end(JSON.stringify({handoffId:handoff.handoffId,ticket:handoff.ticket}));}
      child.once('error',()=>{if(this.child===child){this.child=null;this.#cancelHandoff();this.state={status:'failed',code:'A_GOOGLE_CONNECT_FAILED'};}});
      child.once('exit',code=>{if(this.child!==child)return;this.child=null;if(this.closed)return;
        if(code!==0||activationHandledByHandoff){
          let outcome=null;
          try{outcome=this.handoffId?this.handoffs?.getOutcome?.(this.handoffId):null;}catch{}
          if(outcome?.status==='provider-verified'){
            this.handoffId=null;this.state={status:'connected'};return;
          }
          if(outcome?.status==='credentials-stored-unverified'){
            this.handoffId=null;this.state={status:'verification-required',code:'A_GOOGLE_HANDOFF_STORED_UNVERIFIED'};return;
          }
          this.#cancelHandoff();this.state={status:'failed',code:code===0?'A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE':safeGoogleHelperError(helperError)};return;
        }
        this.state={status:'activating'};const generation=this.connectionGeneration??0;
        this.activation=Promise.resolve().then(()=>{if(!this.closed&&generation===(this.connectionGeneration??0))return this.onConnected();}).then(()=>{if(generation!==(this.connectionGeneration??0))return;this.handoffId=null;if(!this.closed)this.state={status:'connected'};},()=>{if(generation!==(this.connectionGeneration??0))return;this.handoffId=null;if(!this.closed)this.state={status:'failed',code:'A_GOOGLE_ACTIVATION_FAILED'};});
      });return this.status();
    }catch{this.child=null;this.#cancelHandoff();this.state={status:'failed',code:'A_GOOGLE_CONNECT_FAILED'};return this.status();}
  }
  cancelPendingConnection(){this.connectionGeneration=(this.connectionGeneration??0)+1;const child=this.child;this.child=null;child?.kill();this.#cancelHandoff();this.state={status:'disconnected'};}
  close(){this.closed=true;this.child?.kill();this.child=null;this.#cancelHandoff();return this.activation??Promise.resolve();}
  #cancelHandoff(){if(this.handoffId){try{this.handoffs?.cancel(this.handoffId);}catch{}this.handoffId=null;}}
}

function safeGoogleHelperError(value){
  const match=/(?:^|\r?\n)(A_GOOGLE_[A-Z0-9_]+)(?:\r?\n|$)/u.exec(value);
  return match&&GOOGLE_HANDOFF_FAILURE_CODES.has(match[1])?match[1]:'A_GOOGLE_CONSENT_NOT_COMPLETED';
}

function validateCompletionOrigin(value){
  let url;try{url=new URL(value);}catch{throw new Error('A_GOOGLE_HANDOFF_ORIGIN_INVALID');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('A_GOOGLE_HANDOFF_ORIGIN_INVALID');
  return url.origin;
}

/** Do not inherit unrelated service secrets into the browser-consent helper process. */
export function googleHelperEnvironment(env={}){
  const output={};
  for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH'])if(typeof env[key]==='string'&&env[key])output[key]=env[key];
  return output;
}
