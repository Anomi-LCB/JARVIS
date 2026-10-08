import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { activateEmailCapability } from './email-capability-package.js';

const services = new Set(['gmail','outlook','hotmail','yahoo']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Existing local SMTP configuration only. DTOs never accept/return credentials. */
export class EmailConnectionController {
  #signature = null; #key = randomBytes(32); #revision = randomUUID(); #generation = 0;
  #binding = null; #enabled = false; #state = 'not-configured'; #checkedAt = null; #observation = null;
  #active = null;
  constructor({pcAgent,capabilityPackageRegistry,skillRouter,clock=()=>new Date(),timeoutMs=4000}={}) {
    this.pcAgent=pcAgent;this.registry=capabilityPackageRegistry;this.skillRouter=skillRouter;
    this.clock=clock;this.timeoutMs=timeoutMs;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>4500)fail('A_EMAIL_TIMEOUT_INVALID');
  }
  #digest(config) { return createHmac('sha256',this.#key).update(JSON.stringify(config)).digest('hex'); }
  #configuration() {
    const config=this.pcAgent.registry.get('email.send')?.smtpConfig?.();
    if (!config || typeof config.user!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.user)
      || typeof config.pass!=='string' || !config.pass || !services.has(config.service?.toLowerCase())) return null;
    return {user:config.user,pass:config.pass,service:config.service.toLowerCase()};
  }
  #refresh() {
    const config=this.#configuration(),signature=config?this.#digest(config):null;
    if(signature!==this.#signature) {
      this.#signature=signature;this.#generation++;this.#revision=randomUUID();this.#enabled=false;
      this.#state=config?'unverified':'not-configured';this.#checkedAt=null;this.#observation=null;
      try{this.#active?.close?.();}catch{}
      this.#binding=config?{capabilityId:'email.send',providerId:`smtp-${config.service}`,
        accountRef:`smtp-${createHash('sha256').update(`${config.service}\0${config.user.toLowerCase()}`).digest('hex')}`,
        deviceRef:null,scopes:['smtp:authenticated']}:null;
    }
    return config;
  }
  resolve({toolName}) {
    if(toolName!=='email.send')return {required:false};
    this.#refresh();
    return {required:true,binding:this.#enabled?structuredClone(this.#binding):null,permissionRevision:this.#revision};
  }
  status() {
    const config=this.#refresh();
    const availability=this.#binding?this.registry.availabilityFor(this.#binding,{minimumVerification:'live-probe',permissionRevision:this.#revision}):null;
    const available=this.#enabled && availability?.available===true;
    return {version:'a-email-connection-v1',configured:Boolean(config),status:available?'verified':this.#state==='verified'?'stale':this.#state,
      available,providerVerified:available,checkedAt:this.#checkedAt,mailSent:false,executionAuthorized:false,
      credentialLocation:'existing-local-executor',verificationScope:'smtp-connection-tls-authentication-only',
      nextAction:available?null:config?'메일 연결 확인을 실행하세요. 연결 확인은 메일을 발송하지 않습니다.':'기존 로컬 메일 설정을 준비하세요. 비밀번호를 대화에 입력하지 마세요.'};
  }
  assertConfigurationCurrent(config) {
    const current=this.#refresh();
    if(!this.#enabled || !current || this.#digest(current)!==this.#digest(config))fail('A_EMAIL_CONNECTION_CHANGED');
  }
  observation() {this.#refresh();if(!this.#enabled||!this.#observation)fail('A_EMAIL_CHECK_REQUIRED');return structuredClone(this.#observation);}
  readiness() {
    const status=this.status(),resolved=this.resolve({toolName:'email.send'});
    return {version:'b-email-readiness-v1',toolName:'email.send',available:status.available===true,
      executionAuthorized:false,binding:status.available?resolved.binding:null,
      permissionRevision:resolved.permissionRevision,observation:status.available?this.observation():null};
  }
  disconnect() {
    this.#refresh();this.#generation++;this.#revision=randomUUID();this.#enabled=false;this.#state='paused';this.#checkedAt=null;
    this.#observation=null;try{this.#active?.close?.();}catch{}
    return {...this.status(),localExecutionPaused:true,credentialsDeleted:false,providerCredentialRevoked:false};
  }
  async probe() {
    const config=this.#refresh();if(!config)fail('A_EMAIL_CONFIGURATION_REQUIRED');
    if(this.#state==='checking')fail('A_EMAIL_CHECK_IN_PROGRESS');
    const generation=this.#generation,revision=this.#revision,binding=structuredClone(this.#binding);
    this.#enabled=false;this.#state='checking';
    let transporter,timer;
    try {
      activateEmailCapability({pcAgent:this.pcAgent,capabilityPackageRegistry:this.registry,skillRouter:this.skillRouter});
      const deadline=new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error('A_EMAIL_CHECK_TIMEOUT'),{code:'A_EMAIL_CHECK_TIMEOUT'})),this.timeoutMs);
      });
      const adapter=this.pcAgent.registry.get('email.send'),mailer=await Promise.race([adapter.loadNodemailer(),deadline]);
      this.#refresh();if(generation!==this.#generation)fail('A_EMAIL_CONNECTION_CHANGED');
      if(!mailer?.createTransport)fail('A_EMAIL_TRANSPORT_UNAVAILABLE');
      transporter=mailer.createTransport({service:config.service,auth:{user:config.user,pass:config.pass},
        requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,debug:false,
        connectionTimeout:this.timeoutMs,greetingTimeout:this.timeoutMs,socketTimeout:this.timeoutMs,dnsTimeout:this.timeoutMs});
      this.#active=transporter;
      if(typeof transporter.verify!=='function')fail('A_EMAIL_VERIFY_UNAVAILABLE');
      const verified=await Promise.race([transporter.verify(),deadline]);
      this.#refresh();if(generation!==this.#generation || revision!==this.#revision)fail('A_EMAIL_CONNECTION_CHANGED');
      if(verified!==true)fail('A_EMAIL_AUTH_NOT_VERIFIED');
      const observedAt=this.clock().toISOString();
      const observation={...binding,codeVersion:this.registry.availabilityFor(binding).codeVersion,
        permissionRevision:revision,observedAt,accountStatus:'connected',observedAccountRef:binding.accountRef,
        deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:`smtp-check-${randomUUID()}`};
      this.registry.recordAvailability(observation);this.#observation=observation;
      this.#checkedAt=observedAt;this.#state='verified';this.#enabled=true;
      adapter.assertConnectionConfiguration=config=>this.assertConfigurationCurrent(config);
      return this.status();
    } catch(error) {
      if(generation===this.#generation) {this.#enabled=false;this.#state='failed';this.#checkedAt=null;}
      const code=/^A_EMAIL_[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'A_EMAIL_CHECK_FAILED';
      fail(code); // Do not expose provider text, account or authentication material.
    } finally {clearTimeout(timer);try{transporter?.close?.();}catch{}if(this.#active===transporter)this.#active=null;}
  }
}
