import {openSync,closeSync,fstatSync,lstatSync,readSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createRemoteArtifactBinding,remoteArtifactDigest} from '../mission/remote-artifact-contract.js';
import {PcOutboundExecutionClient} from './pc-outbound-execution-client.js';

const fail=code=>{throw Object.assign(new Error(`A_PC_OUTBOUND_EXECUTOR_${code}`),{code:`A_PC_OUTBOUND_EXECUTOR_${code}`});};
/** Public binding, never credentials or a substitute for enrollment/permission. */
export function readPcOutboundExecutionConfiguration(env={}){
  const enabled=env.JARVIS_CORE_PC_OUTBOUND_EXECUTION_ENABLED,path=env.JARVIS_CORE_PC_OUTBOUND_EXECUTION_BINDING_PATH;
  if(!['0','1',undefined].includes(enabled))fail('CONFIG_INVALID');
  if(enabled!=='1'){if(path)fail('DISABLED_BINDING_PRESENT');return null;}
  if(typeof path!=='string'||!isAbsolute(path)||/[\u0000-\u001f]/u.test(path))fail('BINDING_PATH_INVALID');
  let fd;
  try{
    if(lstatSync(path).isSymbolicLink())fail('BINDING_FILE_INVALID');
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const info=fstatSync(fd);if(!info.isFile()||info.size<2||info.size>16384)fail('BINDING_FILE_INVALID');
    // Bound the actual read as well as stat: a file may grow between the calls.
    const buffer=Buffer.alloc(16385);let length=0;
    while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(count===0)break;length+=count;}
    if(length>16384)fail('BINDING_FILE_INVALID');
    const bytes=buffer.subarray(0,length);
    const value=JSON.parse(bytes.toString('utf8'));
    if(value?.version!=='remote-artifact-binding-v2')fail('BINDING_INVALID');
    const {version,...input}=value,binding=createRemoteArtifactBinding(input);
    if(remoteArtifactDigest(binding)!==remoteArtifactDigest(value))fail('BINDING_INVALID');
    Object.freeze(binding.allowedRoots);return Object.freeze(binding);
  }catch(error){if(error?.code?.startsWith('A_PC_OUTBOUND_EXECUTOR_'))throw error;fail('BINDING_INVALID');}
  finally{if(fd!==undefined)closeSync(fd);}
}

export function createConfiguredPcOutboundExecutor({binding,service}={}){
  if(!binding)return null;
  if(!service?.commandMailbox?.executionFenceRequired||typeof service.createReceiptClient!=='function')fail('FENCED_SERVICE_REQUIRED');
  const client=service.createReceiptClient(binding.deviceId,{timeoutMs:5000,pollIntervalMs:25});
  const executor=new PcOutboundExecutionClient({commands:service.commandMailbox,deviceId:binding.deviceId,receiptClient:client,
    artifactBinding:binding,requireMutationFence:true,timeoutMs:5000,pollIntervalMs:25});
  return {executor,recovery:{client,binding}};
}
