import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { PcOutboundCommandMailbox } from './pc-outbound-command-mailbox.js';
import { PcOutboundMailbox } from './pc-outbound-mailbox.js';
import { PcOutboundReceiptClient } from './pc-outbound-receipt-client.js';
import { createPcOutboundServer } from './pc-outbound-https.js';
import { readPrivateFile } from '../personal-operations/private-file.js';
import { listenOnFetchSafePort } from '../../../shared/src/http.js';
import {validPcReadiness} from '../../../shared/src/pc-readiness-contract.js';
import {pcLocalDenialNextAction} from '../../../shared/src/pc-local-denial.js';

const fail = suffix => { throw new Error(`A_PC_OUTBOUND_${suffix}`); };
const object = (input, keys) => input && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(input, key));

/** Trusted authority-node administration. Observation never grants action execution. */
export class PcOutboundNodeController {
  constructor({ mailbox, authorityGuard, ca, commandMailbox=null } = {}) {
    if (!mailbox || typeof authorityGuard !== 'function') fail('AUTHORITY_REQUIRED');
    if(commandMailbox!==null&&(!(commandMailbox instanceof PcOutboundCommandMailbox)||commandMailbox.mailbox!==mailbox))fail('COMMAND_CONFIG_INVALID');
    this.commandMailbox=commandMailbox;
    this.mailbox = mailbox; this.authorityGuard = () => {
      try { return authorityGuard(); } catch { fail('AUTHORITY_LOST'); }
    };
    this.issuers = (Array.isArray(ca) ? ca : ca ? [ca] : []).flatMap(bytes =>
      String(bytes).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? []).map(pem => new X509Certificate(pem));
  }
  status() {
    let authorityActive = true, authorityToken = null;
    try { authorityToken=this.authorityGuard()?.token??null; } catch { authorityActive = false; }
    const status = this.mailbox.status();
    return { ...status, authorityActive, authorityToken,
      devices: status.devices.map(device => !authorityActive && device.status === 'connected' ? { ...device, status: 'paused' } : device) };
  }
  enroll(input) {
    const { label, allowedArtifactTaskIds, ...required } = input ?? {};
    if (!object(required, ['deviceId','certificateFingerprint','expiresAt','allowedTaskIds','expectedGeneration'])
      || typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(input.expiresAt)
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) fail('INPUT_INVALID');
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== input.expiresAt.replace('Z','.000Z')) fail('INPUT_INVALID');
    this.authorityGuard();
    return this.mailbox.enroll({ ...input, expiresAt });
  }
  revoke(deviceId, input) {
    if (!object(input, ['expectedGeneration']) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) fail('INPUT_INVALID');
    this.authorityGuard(); this.mailbox.revoke(deviceId, input);
    return { deviceId, status: 'revoked', executionAuthority: false };
  }
  enqueue(deviceId, input) {
    if (!object(input,input?.operation==='task-catalog'?['requestId','operation','taskId','offset','limit']: ['operation-receipt','operation-artifact'].includes(input?.operation)?['requestId','operation','taskId','operationId','action']:['requestId','operation','taskId'])) fail('INPUT_INVALID');
    this.authorityGuard(); return this.mailbox.enqueue({ ...input, deviceId });
  }
  result(requestId) {
    const result=this.mailbox.result(requestId);
    const row=this.mailbox.db.prepare('SELECT request FROM pc_outbound_reads WHERE id=?').get(requestId);
    const query=row?JSON.parse(row.request):null;
    if(!result||query?.operation!=='task-readiness')return result;
    const issues=[];const add=(code,nextAction)=>issues.push({code,nextAction});
    if(result.state!=='observed'||!result.observationCurrent||result.observation?.status!=='observed')add('PC_OBSERVATION_REQUIRED','같은 PC의 준비 상태를 다시 조회하세요. 연결과 PC 관리 목록 구성을 확인하세요.');
    else{
      const local=result.observation.value;
      if(!validPcReadiness(local,query.taskId))add('PC_OBSERVATION_INVALID','PC 준비 상태 응답을 확인할 수 없습니다. 현재 상태를 다시 조회하세요.');
      else{
        const scope=this.scope(result.deviceId),command=this.commandMailbox?.describeScope(result.deviceId);
        if(scope.generation!==result.deviceGeneration)add('PC_IDENTITY_CHANGED','PC 연결이 바뀌었습니다. 같은 장치를 다시 조회하세요.');
        if(!scope.allowedTaskIds.includes(query.taskId))add('CORE_READ_SCOPE_MISSING','PC·장치 연결에서 이 업무의 조회 범위를 확인하세요.');
        if(!scope.allowedArtifactTaskIds.includes(query.taskId))add('CORE_ARTIFACT_SCOPE_MISSING','PC·장치 연결에서 이 업무의 산출물 읽기 범위를 확인하세요.');
        if(command?.status!=='configured'||command.generation!==result.deviceGeneration||!command.allowedTaskIds.includes(query.taskId))add('CORE_COMMAND_SCOPE_MISSING','PC·장치 연결의 실행 범위 관리에서 이 업무와 허용 기간을 확인하세요.');
        if(!local.locallyReady)add(local.reason,pcLocalDenialNextAction(local.reason));
        else if(local.expiresAt<=this.mailbox.now())add('B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED',pcLocalDenialNextAction('B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED'));
      }
    }
    return {...result,configurationReadiness:{taskId:query.taskId,deviceId:result.deviceId,status:issues.length?'not-matched':'configuration-matched',issues,
      observedConfigurationOnly:true,executionAuthority:false,verifiedCompletion:false}};
  }
  scope(deviceId) { this.authorityGuard(); return this.mailbox.scope(deviceId); }
  commandScope(deviceId){this.authorityGuard();if(!this.commandMailbox)fail('COMMAND_NOT_CONFIGURED');return this.commandMailbox.describeScope(deviceId);}
  updateCommandScope(deviceId,input){
    this.authorityGuard();if(!this.commandMailbox)fail('COMMAND_NOT_CONFIGURED');
    if(!object(input,['expectedGeneration','expectedRevision','allowedTaskIds','expiresAt'])
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.expiresAt!=='string'
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(input.expiresAt))fail('INPUT_INVALID');
    const expiresAt=Date.parse(input.expiresAt),selected=this.mailbox.scope(deviceId);
    if(!Number.isSafeInteger(expiresAt)||new Date(expiresAt).toISOString()!==input.expiresAt.replace('Z','.000Z')
      ||!Array.isArray(input.allowedTaskIds)||input.allowedTaskIds.some(task=>!selected.allowedArtifactTaskIds.includes(task)))fail('COMMAND_SCOPE_INVALID');
    return this.commandMailbox.grant({deviceId,expectedGeneration:input.expectedGeneration,expectedRevision:input.expectedRevision,allowedTaskIds:input.allowedTaskIds,expiresAt});
  }
  previewCertificate(input) {
    this.authorityGuard();
    if (!object(input,['certificatePem']) || typeof input.certificatePem !== 'string' || Buffer.byteLength(input.certificatePem)>16384
      || !/^\s*-----BEGIN CERTIFICATE-----[a-zA-Z0-9+/=\s]+-----END CERTIFICATE-----\s*$/u.test(input.certificatePem)) fail('CERTIFICATE_INVALID');
    let certificate;
    try { certificate = new X509Certificate(input.certificatePem); } catch { fail('CERTIFICATE_INVALID'); }
    const now = this.mailbox.now();
    const issuer = this.issuers.find(candidate => candidate.ca && Date.parse(candidate.validFrom)<=now && Date.parse(candidate.validTo)>now
      && certificate.checkIssued(candidate) && certificate.verify(candidate.publicKey));
    if (!issuer || certificate.ca || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2')
      || Date.parse(certificate.validFrom)>now || Date.parse(certificate.validTo)<=now) fail('CERTIFICATE_DENIED');
    return { certificateFingerprint:certificate.fingerprint256,
      expiresAt:new Date(Math.min(Date.parse(issuer.validTo),Date.parse(certificate.validTo))).toISOString().replace('.000Z','Z'),
      status:'certificate-checked', deviceConnected:false, executionAuthority:false };
  }
}

/** The same lifecycle is used by production configuration and isolated transport tests. */
export async function startPcOutboundNodeService({ dbPath, authorityGuard, tls, host = '127.0.0.1', port = 0, clock = Date.now, commandTransport = false, commandExecutionFenceRequired = false } = {}) {
  if (typeof authorityGuard !== 'function') fail('AUTHORITY_REQUIRED');
  authorityGuard();
  if(typeof commandTransport!=='boolean'||typeof commandExecutionFenceRequired!=='boolean'||commandExecutionFenceRequired&&!commandTransport)fail('CONFIG_INVALID');
  const mailbox = new PcOutboundMailbox({ dbPath, authorityGuard, clock });
  let server,commandMailbox;
  try {
    commandMailbox=commandTransport?new PcOutboundCommandMailbox({mailbox,executionFenceRequired:commandExecutionFenceRequired}):null;
    server = createPcOutboundServer({ mailbox, commandMailbox, ...tls });
    await listenOnFetchSafePort(server, { host, port });
  } catch (error) { server?.close(); mailbox.close(); throw error; }
  const controller = new PcOutboundNodeController({ mailbox, authorityGuard, ca:tls.ca, commandMailbox });
  let closing;
  return { controller, commandMailbox, address: server.address(),
    createReceiptClient: (deviceId,options={}) => new PcOutboundReceiptClient({...options,controller,deviceId}),
    close: () => closing ??= (async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    mailbox.close();
  })() };
}

export async function createConfiguredPcOutboundNodeService({ env = process.env, authorityGuard } = {}) {
  if (!['0','1',undefined].includes(env.JARVIS_CORE_PC_OUTBOUND_ENABLED)) fail('CONFIG_INVALID');
  if(!['0','1',undefined].includes(env.JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED)||env.JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED==='1'&&env.JARVIS_CORE_PC_OUTBOUND_ENABLED!=='1')fail('COMMAND_CONFIG_INVALID');
  if (env.JARVIS_CORE_PC_OUTBOUND_ENABLED !== '1') return null;
  if (typeof authorityGuard !== 'function') fail('AUTHORITY_REQUIRED');
  authorityGuard();
  const names = ['JARVIS_CORE_PC_OUTBOUND_DB','JARVIS_CORE_PC_OUTBOUND_TLS_KEY','JARVIS_CORE_PC_OUTBOUND_TLS_CERT',
    'JARVIS_CORE_PC_OUTBOUND_TLS_CA','JARVIS_CORE_PC_OUTBOUND_PORT'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name])) fail('CONFIG_INCOMPLETE');
  const port = Number(env.JARVIS_CORE_PC_OUTBOUND_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('CONFIG_INVALID');
  const cert = readFileSync(env.JARVIS_CORE_PC_OUTBOUND_TLS_CERT), ca = readFileSync(env.JARVIS_CORE_PC_OUTBOUND_TLS_CA);
  if ([cert, ca].some(bytes => /TEST ONLY/u.test(new X509Certificate(bytes).subject))) fail('TEST_CERT_DENIED');
  return startPcOutboundNodeService({ dbPath: env.JARVIS_CORE_PC_OUTBOUND_DB, authorityGuard,
    host: env.JARVIS_CORE_PC_OUTBOUND_HOST ?? '127.0.0.1', port,commandTransport:env.JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED==='1',commandExecutionFenceRequired:env.JARVIS_CORE_PC_OUTBOUND_COMMAND_ENABLED==='1',
    tls: { key: readPrivateFile(env.JARVIS_CORE_PC_OUTBOUND_TLS_KEY), cert, ca } });
}
