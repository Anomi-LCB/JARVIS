import {spawn} from 'node:child_process';
import {connect} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveDuffelConnectionEnvironment,assertDuffelProfileUnchanged} from '../packages/core/src/personal-operations/duffel-connection-profile.js';
import {readPrivateFile} from '../packages/core/src/personal-operations/private-file.js';

const entry=fileURLToPath(new URL('./duffel-credential-broker.mjs',import.meta.url));
const baseNames=['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'];
export function duffelChildEnvironment(env){
  return {...Object.fromEntries(Object.entries(env).filter(([key])=>baseNames.some(name=>name.toLowerCase()===key.toLowerCase()))),
    JARVIS_DUFFEL_CONNECTION_PROFILE:env.JARVIS_DUFFEL_CONNECTION_PROFILE};
}
/** Owns only its fixed child. Explicit restart; never adopts an occupied port or retries provider operations. */
export function createDuffelBrokerProcess({env=process.env,startupTimeoutMs=20000,stopTimeoutMs=4000}={}){
  if(!env.JARVIS_DUFFEL_CONNECTION_PROFILE)throw new Error('A_DUFFEL_PROCESS_PROFILE_REQUIRED');
  if(![startupTimeoutMs,stopTimeoutMs].every(v=>Number.isInteger(v)&&v>=100&&v<=60000))throw new Error('A_DUFFEL_PROCESS_TIMEOUT_INVALID');
  const supplied={...env};
  let child=null,state='stopped',starting=null,stopping=null;
  const snapshot=()=>({status:state,pid:child?.pid??null,providerVerified:false,bookingAvailable:false});
  async function stop(){
    if(stopping)return stopping;
    stopping=(async()=>{
      const owned=child;if(!owned)return;
      state='stopping';
      await new Promise(resolve=>{
        if(!owned.pid||owned.exitCode!==null||owned.signalCode!==null)return resolve();
        const timer=setTimeout(()=>{owned.kill();},stopTimeoutMs);
        owned.once('exit',()=>{clearTimeout(timer);resolve();});
        if(owned.connected)owned.send({type:'duffel-stop'},()=>{});else owned.kill();
      });
      if(child===owned)child=null;state='stopped';
    })().finally(()=>{stopping=null;});
    return stopping;
  }
  async function start(){
    if(stopping)await stopping;
    if(starting)return starting;
    if(state==='ready')return snapshot();
    starting=(async()=>{
      // Re-read on each explicit start. The child must see exactly this protected profile version.
      const core=resolveDuffelConnectionEnvironment({env:supplied,role:'core'});
      const broker=resolveDuffelConnectionEnvironment({env:supplied,role:'broker'});
      const prefix='JARVIS_CORE_DUFFEL_BROKER_';
      const tls={key:readPrivateFile(core[prefix+'TLS_KEY']),cert:readPrivateFile(core[prefix+'TLS_CERT']),ca:readPrivateFile(core[prefix+'TLS_CA'])};
      const expected=new X509Certificate(readPrivateFile(broker.JARVIS_DUFFEL_BROKER_TLS_CERT)).fingerprint256;
      const port=Number(broker.JARVIS_DUFFEL_BROKER_PORT);
      state='starting';
      const owned=spawn(process.execPath,[entry],{env:{...duffelChildEnvironment(supplied),JARVIS_DUFFEL_CONNECTION_PROFILE_SHA256:core.JARVIS_DUFFEL_CONNECTION_PROFILE_SHA256},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
      child=owned;
      owned.on('exit',()=>{if(child===owned){child=null;if(state!=='stopping')state='failed';}});
      try{
        await new Promise((resolve,reject)=>{
          let socket;
          const finish=error=>{clearTimeout(timer);owned.off('message',message);owned.off('exit',exit);owned.off('error',fail);socket?.destroy();error?reject(error):resolve();};
          const fail=()=>finish(new Error('A_DUFFEL_PROCESS_START_FAILED'));
          const exit=()=>fail();
          const message=value=>{
            if(value?.type!=='duffel-ready'||value.pid!==owned.pid||value.host!=='127.0.0.1'||value.port!==port)return;
            owned.off('message',message);
            socket=connect({host:'127.0.0.1',port,...tls,rejectUnauthorized:true},()=>{
              try{assertDuffelProfileUnchanged(core);if(!socket.authorized||socket.getPeerCertificate().fingerprint256!==expected)throw new Error();finish();}catch{fail();}
            });
            socket.once('error',fail);
          };
          const timer=setTimeout(()=>finish(new Error('A_DUFFEL_PROCESS_START_TIMEOUT')),startupTimeoutMs);
          owned.on('message',message);owned.once('exit',exit);owned.once('error',fail);
        });
        if(child!==owned)throw new Error('A_DUFFEL_PROCESS_START_FAILED');
        state='ready';return snapshot();
      }catch(error){await stop();state='failed';throw error;}
    })().finally(()=>{starting=null;});
    return starting;
  }
  return Object.freeze({start,stop,snapshot});
}
