import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {IntegrationConnectorRegistry,IntegrationCredentialVault} from '../../packages/core/src/personal-operations/integration-security.js';
import {DUFFEL_CONNECTOR_ID,DUFFEL_READ_SCOPE,DUFFEL_READ_CAPABILITY} from '../../packages/core/src/personal-operations/duffel-quote-broker.js';
import {startDuffelCredentialBroker} from '../../packages/core/src/personal-operations/duffel-broker-host.js';
import {BrokerRevocationStore} from '../../packages/core/src/personal-operations/broker-revocation-store.js';

const pem=name=>readFileSync(new URL(`./google-broker-tls/${name}.pem`,import.meta.url));
const peer=new X509Certificate(pem('core')).fingerprint256.replaceAll(':','');
const encryptedVault=process.argv[3]?new IntegrationCredentialVault({path:process.argv[3]}):null;
const row=encryptedVault?.list()[0]??{connectionId:'process-duffel',connectorId:DUFFEL_CONNECTOR_ID,authMethod:'api-key',
  scopes:[DUFFEL_READ_SCOPE],grants:[DUFFEL_READ_CAPABILITY],status:'credentials-stored-unverified',updatedAt:'revision-one'};
let reads=0,calls=0;
const token='duffel_test_process_synthetic_private_key';
const vault={list:()=>encryptedVault?encryptedVault.list():[structuredClone(row)],async withCredentials(id,operation){reads++;return encryptedVault?encryptedVault.withCredentials(id,operation):operation({apiKey:token},structuredClone(row));}};
const fetchImpl=async(url,options)=>{
    calls++;
    if(options.headers.authorization!==`Bearer ${token}`)throw new Error('unexpected authorization');
    return new Response(JSON.stringify({data:{id:'off_process',live_mode:false,partial:false,total_amount:'45000',total_currency:'KRW',
      expires_at:'2026-10-03T00:30:00Z',updated_at:'2026-10-03T00:00:00Z',conditions:{refund_before_departure:null},
      passengers:[{id:'pas_process'}],slices:[{origin:{iata_code:'ICN'},destination:{iata_code:'NRT'}}],available_services:[]}}),
      {headers:{'content-type':'application/json'}});
  };
const revocationStore=process.argv[2]?new BrokerRevocationStore({path:process.argv[2]}):null;
const endpoint=await startDuffelCredentialBroker({registry:new IntegrationConnectorRegistry(),vault,fetchImpl,
  clock:()=>new Date('2026-10-03T00:00:00Z'),tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca'),
    allowedClientFingerprints:[peer],clientConnectionScopes:{[peer]:[row.connectionId]},revocationStore}});
process.send({type:'ready',pid:process.pid,address:endpoint.address,metadata:[structuredClone(row)]});
process.on('message',message=>{
  if(message.action==='stats')process.send({type:'stats',credentialReads:reads,providerCalls:calls});
  if(message.action==='revoke-connection'){if(encryptedVault)encryptedVault.remove(row.connectionId);else row.status='revoked';process.send({type:'revoked-connection'});}
  if(message.action==='revoke-client'){endpoint.revokeClient(peer);process.send({type:'revoked-client'});}
});
process.on('disconnect',async()=>{
  await endpoint.close();revocationStore?.close();process.exit(0);
});
