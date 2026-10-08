import {IntegrationConnectorRegistry} from './integration-security.js';
import {createDuffelQuoteBroker} from './duffel-quote-broker.js';
import {createDuffelBrokerHttpsServer} from './duffel-broker-https.js';

/** Explicit startup in a separately supervised trusted process. No env/vault
 * auto-discovery, no public listen address, and no provider key returned. */
export async function startDuffelCredentialBroker({vault,tls,host='127.0.0.1',port=0,
  registry=new IntegrationConnectorRegistry(),fetchImpl=globalThis.fetch,clock}={}) {
  if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<0||port>65535)
    throw new Error('A_DUFFEL_BROKER_LISTEN_CONFIG_INVALID');
  const broker=createDuffelQuoteBroker({vault,registry,fetchImpl,clock});
  const {server,revokeClient}=createDuffelBrokerHttpsServer({...tls,broker});
  await new Promise((resolve,reject)=>{
    const failed=error=>reject(error);
    server.once('error',failed);
    server.listen(port,host,()=>{server.off('error',failed);resolve();});
  });
  let closing;
  return Object.freeze({address:server.address(),revokeClient,
    close(){
      closing??=new Promise((resolve,reject)=>{
        server.closeAllConnections();
        server.close(error=>error?reject(error):resolve());
      });
      return closing;
    }
  });
}
