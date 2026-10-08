import {spawn} from 'node:child_process';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ucpCanonicalJson,parseUcpJson} from './ucp-checkout-read.js';
import {verifyUcpAp2CheckoutBinding} from './ucp-ap2-binding.js';
const fail=code=>{throw Object.assign(new Error(`A_AP2_${code}`),{code:`A_AP2_${code}`});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);

export function ap2SdkDigest(sdkRoot) {
  const root=resolve(sdkRoot),files=[];
  const walk=path=>{
    for(const name of readdirSync(path).sort()) {
      const file=join(path,name),stat=lstatSync(file);
      if(stat.isSymbolicLink())fail('SDK_SYMLINK');
      if(stat.isDirectory()) {if(name!=='__pycache__'&&!name.startsWith('.'))walk(file);}
      else if(name.endsWith('.py')) {
        if(stat.size>1024*1024||files.length>=200)fail('SDK_SIZE');
        files.push({path:relative(root,file).split(sep).join('/'),sha256:digest(readFileSync(file))});
      }
    }
  };
  walk(root);if(!files.length)fail('SDK_MISSING');
  return digest(ucpCanonicalJson(files));
}

/** Host transaction lookup supplies trust keys and expected consent; request
 * data cannot nominate its own trusted issuer, amount or authorization. */
export function createAp2TransactionVerifier({pythonPath,sdkRoot,sdkSha256,resolveTransaction=()=>null,clock=()=>new Date()}={}) {
  return createAp2EvidenceVerifier({pythonPath,sdkRoot,sdkSha256,resolveTransaction,clock},true);
}
export function createAp2AuthorizationVerifier(options={}) {
  return createAp2EvidenceVerifier(options,false);
}
function createAp2EvidenceVerifier({pythonPath,sdkRoot,sdkSha256,resolveTransaction=()=>null,clock=()=>new Date()},receiptsRequired) {
  const evidenceFields=['checkoutJwt','checkoutMandate','paymentMandate',...(receiptsRequired?['checkoutReceipt','paymentReceipt']:[])];
  const python=resolve(pythonPath),root=resolve(sdkRoot);
  try{const stat=lstatSync(python);if(!stat.isFile()||stat.isSymbolicLink())fail('RUNTIME_UNAVAILABLE');}
  catch{fail('RUNTIME_UNAVAILABLE');}
  const script=fileURLToPath(new URL('./ap2-sdk-verifier.py',import.meta.url));
  const assertSdk=()=>{if(typeof sdkSha256!=='string'||!/^[a-f0-9]{64}$/u.test(sdkSha256)||ap2SdkDigest(root)!==sdkSha256)fail('SDK_PIN_MISMATCH');};
  assertSdk();
  const lookup=async id=>{
    const transaction=await resolveTransaction(id);
    if(!object(transaction)||transaction.active!==true||typeof transaction.revision!=='string'||!transaction.revision
      ||!object(transaction.expected)||!object(transaction.keys)||transaction.expected.checkoutId!==id)fail('TRUSTED_TRANSACTION_REQUIRED');
    const copy=structuredClone(transaction);
    if(copy.profile!==undefined&&!['ap2-native-v1','ucp-full-v1'].includes(copy.profile))fail('PROFILE_UNSUPPORTED');
    if(copy.profile==='ucp-full-v1'&&(!object(copy.ucp?.checkout)||!object(copy.ucp?.profile)))fail('UCP_BINDING_REQUIRED');
    const e=copy.expected;
    if(!Number.isSafeInteger(e.totalMinor)||e.totalMinor<0||!/^[A-Z]{3}$/u.test(e.currency??'')
      ||['merchantId','merchantIssuer','pspIssuer','checkoutAudience','checkoutNonce','paymentAudience','paymentNonce','orderId'].some(k=>typeof e[k]!=='string'||!e[k]||e[k].length>512)
      ||!Array.isArray(e.lineItems)||!e.lineItems.length||e.lineItems.length>100
      ||e.lineItems.some(i=>typeof i.itemId!=='string'||!i.itemId||!Number.isSafeInteger(i.quantity)||i.quantity<1||!Number.isSafeInteger(i.unitPriceMinor)||i.unitPriceMinor<0))fail('EXPECTED_CONSENT_INVALID');
    if(Object.keys(copy.keys).length!==4||['checkoutIssuer','paymentIssuer','merchant','psp'].some(k=>!object(copy.keys[k])||copy.keys[k].d!==undefined))fail('TRUST_KEYS_INVALID');
    return copy;
  };
  const identity=row=>digest(ucpCanonicalJson(row));
  return Object.freeze({status:()=>({configured:true,sdkSha256,executionAuthority:false,orderAvailable:false}),
    async verify(input,{signal}={}) {
      signal?.throwIfAborted();
      if(!object(input)||Object.keys(input).length!==evidenceFields.length+1||typeof input.checkoutId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(input.checkoutId)
        ||Object.keys(input).some(k=>k!=='checkoutId'&&!evidenceFields.includes(k))
        ||evidenceFields.some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>262144))fail('REQUEST_INVALID');
      const {checkoutId,...evidence}=structuredClone(input);
      const transaction=await lookup(checkoutId),before=identity(transaction);
      const nesting=transaction.profile==='ucp-full-v1'
        ?verifyUcpAp2CheckoutBinding({checkoutJwt:evidence.checkoutJwt,...transaction.ucp,clock}):null;
      assertSdk();
      const now=Math.floor(clock().getTime()/1000);if(!Number.isSafeInteger(now))fail('CLOCK_INVALID');
      const bytes=Buffer.from(JSON.stringify({...(receiptsRequired?{}:{mode:'authorizations'}),evidence,expected:{...transaction.expected,now},keys:transaction.keys}));
      if(bytes.length>1048576)fail('REQUEST_TOO_LARGE');
      const output=await new Promise((resolveResult,reject)=>{
        const child=spawn(python,['-I',script,root],{windowsHide:true,stdio:['pipe','pipe','ignore'],
          env:Object.fromEntries(['SystemRoot','PATH','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
        const chunks=[];let size=0,done=false;
        const end=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolveResult(result);};
        const abort=()=>{child.kill();end(Object.assign(new Error('A_AP2_VERIFICATION_CANCELLED'),{code:'A_AP2_VERIFICATION_CANCELLED'}));};
        const timer=setTimeout(()=>{child.kill();end(Object.assign(new Error('A_AP2_VERIFIER_TIMEOUT'),{code:'A_AP2_VERIFIER_TIMEOUT'}));},10000);
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        child.on('error',()=>end(Object.assign(new Error('A_AP2_VERIFIER_UNAVAILABLE'),{code:'A_AP2_VERIFIER_UNAVAILABLE'})));
        child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536){child.kill();end(Object.assign(new Error('A_AP2_VERIFIER_OUTPUT_INVALID'),{code:'A_AP2_VERIFIER_OUTPUT_INVALID'}));}else chunks.push(chunk);});
        child.stdin.on('error',()=>{});
        child.on('close',code=>{
          if(code!==0)return end(Object.assign(new Error('A_AP2_TRANSACTION_EVIDENCE_INVALID'),{code:'A_AP2_TRANSACTION_EVIDENCE_INVALID'}));
          try{end(null,parseUcpJson(Buffer.concat(chunks)));}catch{end(Object.assign(new Error('A_AP2_VERIFIER_OUTPUT_INVALID'),{code:'A_AP2_VERIFIER_OUTPUT_INVALID'}));}
        });
        child.stdin.end(bytes);
      });
      signal?.throwIfAborted();assertSdk();
      if(identity(await lookup(checkoutId))!==before)fail('TRUSTED_TRANSACTION_CHANGED');
      const acceptedAt=clock(),acceptedUnix=Math.floor(acceptedAt.getTime()/1000);
      if(!Number.isSafeInteger(acceptedUnix)||acceptedUnix<now)fail('CLOCK_CHANGED');
      if(!Number.isSafeInteger(output.validUntilUnix)||output.validUntilUnix<=acceptedUnix||output.evaluatedAtUnix!==now)fail('EVIDENCE_EXPIRED');
      if(output.schemaVersion!==(receiptsRequired?'a-ap2-transaction-verification-v1':'a-ap2-authorization-verification-v1')||output.verified!==true||output.checkoutId!==checkoutId
        ||receiptsRequired&&output.orderId!==transaction.expected.orderId||output.currency!==transaction.expected.currency
        ||output.totalMinor!==transaction.expected.totalMinor||output.executionAuthority!==false||output.fundsSettlementObserved!==false)fail('VERIFIER_OUTPUT_INVALID');
      return {...output,checkedAt:acceptedAt.toISOString(),transactionRevision:transaction.revision,sdkSha256,
        ucpFullNestingVerified:nesting?.ucpFullNestingVerified===true,
        ...(nesting?{checkoutSourceSha256:nesting.checkoutSourceSha256}:{}),
        evidenceSha256:Object.fromEntries(evidenceFields.map(k=>[k,digest(evidence[k])])),instructionAuthority:false};
    }});
}
