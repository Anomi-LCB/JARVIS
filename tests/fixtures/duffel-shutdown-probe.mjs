import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {connect} from 'node:tls';
import {once} from 'node:events';
import {startDuffelCredentialBroker} from '../../packages/core/src/personal-operations/duffel-broker-host.js';
const pem=n=>readFileSync(new URL('./google-broker-tls/'+n+'.pem',import.meta.url));
const peer=new X509Certificate(pem('core')).fingerprint256.replaceAll(':','');
const host=await startDuffelCredentialBroker({vault:{list:()=>[],withCredentials:()=>{throw new Error('must not read');}},tls:{key:pem('server-key'),cert:pem('server'),ca:pem('ca'),allowedClientFingerprints:[peer],clientConnectionScopes:{[peer]:['allowed']}}});
// Exercise shutdown with an authenticated TLS client before its first HTTP request.
const client=connect({host:'127.0.0.1',port:host.address.port,key:pem('core-key'),cert:pem('core'),ca:pem('ca'),rejectUnauthorized:true,minVersion:'TLSv1.3'});
client.on('error',()=>{});await once(client,'secureConnect');
await new Promise(r=>setTimeout(r,30));
process.send({type:'closing'});const started=performance.now();
await host.close();client.destroy();process.send({type:'closed',elapsedMs:performance.now()-started});process.disconnect();
