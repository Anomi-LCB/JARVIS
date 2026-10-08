import { PcAgentRuntime } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';
import { createPcOutboundCommandTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundCommandDispatcher } from '../apps/pc-agent/src/outbound-command-dispatcher.js';
import { createPcOutboundNodeSupervisor } from '../apps/pc-agent/src/outbound-node-supervisor.js';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readPrivateFile } from '../packages/core/src/personal-operations/private-file.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { createPcOutboundTransport } from '../packages/core/src/client/pc-outbound-https.js';
import { createPcOutboundObserver } from '../apps/pc-agent/src/outbound-observer.js';
import { createOperationArtifactReader } from '../apps/pc-agent/src/operation-artifact-reader.js';
import {observePcDevice} from '../apps/pc-agent/src/device-observation.js';

/** Explicit opt-in PC outbound reader. Provisioned device identity and relay are prerequisites. */
export function createConfiguredPcOutboundObserver({ env = process.env, pcAgent = null, localTaskScope = null } = {}) {
  const names = ['JARVIS_PC_OUTBOUND_URL','JARVIS_PC_OUTBOUND_TLS_KEY','JARVIS_PC_OUTBOUND_TLS_CERT',
    'JARVIS_PC_OUTBOUND_TLS_CA','JARVIS_PC_OUTBOUND_LOCAL_URL','JARVIS_PC_OUTBOUND_TOKEN_FILE'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name])) throw new Error('A_PC_OUTBOUND_CONFIG_INCOMPLETE');
  const commandFlag=env.JARVIS_PC_OUTBOUND_COMMAND_ENABLED??'0';
  const deviceFlag=env.JARVIS_PC_OUTBOUND_DEVICE_OBSERVATION_ENABLED??'0';
  if(!['0','1'].includes(deviceFlag))throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if(!['0','1'].includes(commandFlag))throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  const commandEnabled=commandFlag==='1';
  const taskCatalog=localTaskScope?.catalogEnabled?localTaskScope:null;
  if(localTaskScope!==null&&(!(localTaskScope instanceof PcLocalTaskScope)||!commandEnabled))throw new Error('A_PC_OUTBOUND_LOCAL_SCOPE_INVALID');
  if(commandEnabled&&!(pcAgent instanceof PcAgentRuntime))throw new Error('A_PC_OUTBOUND_COMMAND_RUNTIME_REQUIRED');
  const cert = readFileSync(env.JARVIS_PC_OUTBOUND_TLS_CERT), ca = readFileSync(env.JARVIS_PC_OUTBOUND_TLS_CA);
  if ([cert, ca].some(bytes => /TEST ONLY/u.test(new X509Certificate(bytes).subject))) throw new Error('A_PC_OUTBOUND_TEST_CERT_DENIED');
  const pcClient = new PcAgentExecutionClient({ baseUrl: env.JARVIS_PC_OUTBOUND_LOCAL_URL,
    executionToken: readPrivateFile(env.JARVIS_PC_OUTBOUND_TOKEN_FILE).toString('utf8').trim() });
  if (!pcClient.supportsDurableMissionEffects()) throw new Error('A_PC_OUTBOUND_LOCAL_BOUNDARY_REQUIRED');
  let allowedTaskIds;
  try { allowedTaskIds = JSON.parse(env.JARVIS_PC_OUTBOUND_TASK_IDS ?? '[]'); }
  catch { throw new Error('A_PC_OUTBOUND_CONFIG_INVALID'); }
  if (!Array.isArray(allowedTaskIds) || allowedTaskIds.length > 1000
    || allowedTaskIds.some(value => typeof value !== 'string' || !/^[\p{L}\p{N}._-]{1,128}$/u.test(value))) throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  let artifactTasks, artifactRoots;
  try {
    artifactTasks = JSON.parse(env.JARVIS_PC_OUTBOUND_ARTIFACT_TASK_IDS ?? '[]');
    artifactRoots = JSON.parse(env.JARVIS_PC_OUTBOUND_ARTIFACT_ROOTS ?? '[]');
  } catch { throw new Error('A_PC_OUTBOUND_CONFIG_INVALID'); }
  if (!Array.isArray(artifactTasks) || artifactTasks.length > 1000
    || artifactTasks.some(task => !allowedTaskIds.includes(task)) || !Array.isArray(artifactRoots)
    || (!taskCatalog&&!artifactTasks.length && artifactRoots.length)) throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if(taskCatalog&&(allowedTaskIds.length||artifactTasks.length||!artifactRoots.length))throw new Error('A_PC_OUTBOUND_MANAGED_CATALOG_CONFIG_INVALID');
  const artifactReader = artifactTasks.length||taskCatalog ? createOperationArtifactReader({
    expectedRootScopeSha256: env.JARVIS_PC_OUTBOUND_ARTIFACT_ROOT_SCOPE_SHA256 ?? null,
    readOperation: input => pcClient.readOperation(input), allowedRoots: artifactRoots, allowedTaskIds: artifactTasks,taskCatalog }) : null;
  let commandTasks=[];
  try{commandTasks=JSON.parse(env.JARVIS_PC_OUTBOUND_COMMAND_TASK_IDS??'[]');}catch{throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');}
  if(!Array.isArray(commandTasks)||new Set(commandTasks).size!==commandTasks.length||commandTasks.length>1000
    ||commandTasks.some(task=>!allowedTaskIds.includes(task)||!artifactTasks.includes(task))
    ||commandEnabled&&!commandTasks.length&&!taskCatalog||!commandEnabled&&commandTasks.length||taskCatalog&&commandTasks.length)throw new Error('A_PC_OUTBOUND_COMMAND_SCOPE_INVALID');
  if(!taskCatalog&&localTaskScope?.snapshot().allowedTaskIds.some(task=>!commandTasks.includes(task)))throw new Error('A_PC_OUTBOUND_LOCAL_SCOPE_INVALID');
  const transport = createPcOutboundTransport({ url: env.JARVIS_PC_OUTBOUND_URL,
    key: readPrivateFile(env.JARVIS_PC_OUTBOUND_TLS_KEY), cert, ca });
  let commandTransport=null;
  try{
    if(commandEnabled){
      const url=new URL(env.JARVIS_PC_OUTBOUND_URL);url.pathname='/v1/pc/command';
      commandTransport=createPcOutboundCommandTransport({url:url.toString(),key:readPrivateFile(env.JARVIS_PC_OUTBOUND_TLS_KEY),cert,ca});
    }
    return {observer:createPcOutboundObserver({transport,pcClient,allowedTaskIds,artifactReader,taskCatalog,deviceReader:deviceFlag==='1'?observePcDevice:null}),
      dispatcher:commandTransport?createPcOutboundCommandDispatcher({transport:commandTransport,pcClient,pcAgent,taskScope:localTaskScope,allowedTaskIds:commandTasks}):null,
      close:()=>{transport.close();commandTransport?.close();}};
  }catch(error){transport.close();commandTransport?.close();throw error;}

}

/** Service-owned B runtime is required for final-fenced commands; standalone CLI stays read-only by default. */
export function createConfiguredPcOutboundNode({env=process.env,pcAgent=null,localTaskScope=null}={}){
  const channel=createConfiguredPcOutboundObserver({env,pcAgent,localTaskScope});
  try{return createPcOutboundNodeSupervisor({observer:channel.observer,dispatcher:channel.dispatcher,close:channel.close});}
  catch(error){channel.close();throw error;}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let channel;
  try {
    channel = createConfiguredPcOutboundObserver(); let stopping = false, timer;
    const tick = async () => {
      if (stopping) return;
      try { await channel.observer.tick(); }
      catch { console.error('PC 상태 연결을 확인할 수 없습니다. 연결·장치 인증·허용 기간을 확인하세요.'); }
      if (!stopping) timer = setTimeout(tick, 5000);
    };
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { stopping = true; clearTimeout(timer); channel.close(); });
    console.log('선택한 PC 상태·작업 결과의 외향 조회 연결을 시작합니다. 작업 실행 권한은 제공하지 않습니다.');
    void tick();
  } catch { channel?.close(); console.error('PC 외향 연결 준비가 완료되지 않았습니다.'); process.exitCode = 1; }
}
