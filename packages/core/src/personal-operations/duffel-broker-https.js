import {createCredentialBrokerHttpsServer,createCredentialBrokerHttpsTransport} from './google-broker-https.js';

// A fixed protocol; no runtime-loaded route, error policy or HTTP target.
export const createDuffelBrokerHttpsServer=options=>createCredentialBrokerHttpsServer({...options,family:'duffel'});
export const createDuffelBrokerHttpsTransport=options=>createCredentialBrokerHttpsTransport({...options,family:'duffel'});
