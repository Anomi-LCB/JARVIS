import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {planDuffelUserStorage,prepareDuffelUserStorage} from './duffel-setup-storage.mjs';

/** Interactive UI host only. Browser supplies no paths, key, args or grants. */
export function createDuffelSetupController({env=process.env,platform=process.platform,spawnImpl=spawn}={}) {
  env={...env}; // Installed path/permission contract cannot change mid-dialog.
  let autoStorage=null;
  if(!env.JARVIS_DUFFEL_SETUP_VAULT&&!env.JARVIS_DUFFEL_SETUP_METADATA){
    autoStorage=planDuffelUserStorage(env);
    if(autoStorage)Object.assign(env,{JARVIS_DUFFEL_SETUP_VAULT:autoStorage.vaultPath,JARVIS_DUFFEL_SETUP_METADATA:autoStorage.metadataPath});
  }
  const configured=platform==='win32'&&env.JARVIS_DUFFEL_SETUP_ENABLED==='1'&&env.JARVIS_WINDOWS_SERVICE!=='1'
    &&Boolean(env.JARVIS_DUFFEL_SETUP_VAULT&&env.JARVIS_DUFFEL_SETUP_METADATA);
  let nonce=randomBytes(32).toString('base64url'),state='idle',child=null,closed=false;
  const status=()=>({available:configured&&!closed,state,providerVerified:false,executionAuthorized:false,
    reason:configured?'interactive-helper':'setup-not-configured'});
  return Object.freeze({status,read:()=>({...status(),...(configured&&!closed?{nonce}:{})}),
    start(input,token){
      const a=Buffer.from(String(token??'')),b=Buffer.from(nonce);
      if(a.length!==b.length||!timingSafeEqual(a,b))throw new Error('JARVIS_DUFFEL_SETUP_AUTH_REQUIRED');
      if(!input||typeof input!=='object'||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).length)throw new Error('JARVIS_DUFFEL_SETUP_INPUT_INVALID');
      if(!configured||closed)throw new Error('JARVIS_DUFFEL_SETUP_UNAVAILABLE');
      if(child||['outcome-unknown','metadata-pending'].includes(state))throw new Error('JARVIS_DUFFEL_SETUP_BUSY');
      if(autoStorage)prepareDuffelUserStorage(autoStorage);
      nonce=randomBytes(32).toString('base64url'); // Consume before launching; replay never opens another dialog.
      state='waiting-user';
      const childEnv=Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].filter(name=>env[name]).map(name=>[name,env[name]]));
      Object.assign(childEnv,{JARVIS_DUFFEL_SETUP_VAULT:env.JARVIS_DUFFEL_SETUP_VAULT,JARVIS_DUFFEL_SETUP_METADATA:env.JARVIS_DUFFEL_SETUP_METADATA});
      try{child=spawnImpl(process.execPath,[fileURLToPath(new URL('./personal-duffel-connect.mjs',import.meta.url))],
        {env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});}
      catch{state='failed';throw new Error('JARVIS_DUFFEL_SETUP_LAUNCH_FAILED');}
      const launched=child;let stdout='',stderr='',oversized=false,finished=false;
      const finish=(code)=>{
        if(finished)return;finished=true;child=null;
        if(oversized||closed){state='outcome-unknown';return;}
        if(code===0){
          try{const value=JSON.parse(stdout);
            if(value.credentialsStored!==true||value.providerVerified!==false||value.executionAuthorized!==false||value.bookingAvailable!==false
              ||Object.keys(value).sort().join(',')!=='bookingAvailable,credentialsStored,executionAuthorized,metadata,providerVerified'
              ||Object.keys(value.metadata??{}).sort().join(',')!=='connectionId,revision,schemaVersion'
              ||value.metadata.schemaVersion!==1||typeof value.metadata.connectionId!=='string'||typeof value.metadata.revision!=='string')throw new Error();
            state='stored-unverified';
          }catch{state='outcome-unknown';}
        }else state=stderr.trim()==='A_DUFFEL_SETUP_CANCELLED'?'cancelled':stderr.trim()==='A_DUFFEL_SETUP_METADATA_PENDING'?'metadata-pending':'failed';
        stdout='';stderr='';
      };
      launched.stdout?.on('data',bytes=>{if(Buffer.byteLength(stdout)+bytes.length>4096){oversized=true;stdout='';}else if(!oversized)stdout+=bytes;});
      launched.stderr?.on('data',bytes=>{if(Buffer.byteLength(stderr)+bytes.length>1024){oversized=true;stderr='';}else if(!oversized)stderr+=bytes;});
      launched.once('error',()=>finish(-1));launched.once('close',finish);
      return status();
    },
    close(){closed=true;if(child&&child.exitCode===null&&child.signalCode===null&&Number.isInteger(child.pid)&&child.pid>0){state='outcome-unknown';
      // Kill only the owned helper tree, never a name-based process inventory.
      if(platform==='win32')spawnImpl('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
      else child.kill();}}
  });
}
