import { Agent, createServer, request as httpsRequest } from 'node:https';

const protocolFor = family => {
  if (!['google', 'duffel'].includes(family)) throw new Error('A_CREDENTIAL_BROKER_PROTOCOL_INVALID');
  return { endpointPath: family === 'google' ? '/v1/google/read' : '/v1/duffel/quote',
    errorPrefix: family === 'google' ? 'A_GOOGLE_BROKER' : 'A_DUFFEL_BROKER' };
};
const maxRequestBytes = 8192, maxResponseBytes = 1048576;
const fingerprint = value => String(value).replaceAll(':', '').toUpperCase();
const validFingerprint = value => /^[A-F0-9]{64}$/u.test(fingerprint(value));
const googleSafeError = error => /^(?:A_GOOGLE_(?:BROKER_(?:REQUEST_INVALID|CONNECTION_REQUIRED|REVISION_CONFLICT|RESPONSE_DENIED|OPERATION_FAILED|CLIENT_DENIED|ROUTE_DENIED|CONTENT_DENIED|BUSY|REQUEST_TOO_LARGE|RESPONSE_TOO_LARGE|SECRET_STORE_AUTH_DENIED|SECRET_STORE_UNAVAILABLE|SECRET_STORE_RESPONSE_INVALID)|TOKEN_NETWORK|TOKEN_INVALID|TOKEN_HTTP_\d{3}|REAUTH_REQUIRED|API_NETWORK|API_HTTP_\d{3}|RESPONSE_INVALID|ACCOUNT_INVALID|PAGE_INVALID|MESSAGE_INVALID))$/u.test(error?.message ?? '')
  ? error.message : 'A_GOOGLE_BROKER_OPERATION_FAILED';
const safeError = (error, family) => {
  if (family === 'google') return googleSafeError(error);
  const message = error?.message ?? '';
  return /^(?:A_DUFFEL_(?:BROKER_(?:REQUEST_INVALID|CLIENT_DENIED|ROUTE_DENIED|CONTENT_DENIED|BUSY|REQUEST_TOO_LARGE|RESPONSE_TOO_LARGE|OPERATION_FAILED)|REQUEST_INVALID|CURRENCY_UNSUPPORTED|AMOUNT_INVALID|OFFER_INVALID|CLOCK_INVALID|OFFER_EXPIRED|OFFER_TIME_INVALID|CONNECTION_REQUIRED|REVISION_CONFLICT|TEST_TOKEN_REQUIRED|NETWORK|RESPONSE_INVALID|RESPONSE_TOO_LARGE|RESPONSE_DENIED|OPERATION_FAILED|HTTP_\d{3}))$/u.test(message)
    ? message : 'A_DUFFEL_BROKER_OPERATION_FAILED';
};
const send = (response, status, body) => {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'content-length': bytes.length, 'x-content-type-options': 'nosniff' });
  response.end(bytes);
};

/** HTTPS-only, CA-verified mTLS plus explicit client certificate allowlist.
 * Runtime process/user isolation and certificate provisioning are deployment responsibilities. */
export function createCredentialBrokerHttpsServer({ family = 'google', broker, key, cert, ca, allowedClientFingerprints, clientConnectionScopes, revocationStore = null, maxConcurrent = 4, operationTimeoutMs = 30000 } = {}) {
  const { endpointPath, errorPrefix } = protocolFor(family);
  if (!broker?.execute || !key || !cert || !ca || !Array.isArray(allowedClientFingerprints)
    || !allowedClientFingerprints.length || allowedClientFingerprints.some(value => !validFingerprint(value))
    || allowedClientFingerprints.some(value => !Array.isArray(clientConnectionScopes?.[fingerprint(value)])
      || !clientConnectionScopes[fingerprint(value)].length
      || clientConnectionScopes[fingerprint(value)].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(id)))
    || (revocationStore !== null && (typeof revocationStore.isRevoked !== 'function' || typeof revocationStore.revoke !== 'function'))
    || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16
    || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 100 || operationTimeoutMs > 60000) {
    throw new Error(`${errorPrefix}_TLS_CONFIG_INVALID`);
  }
  const allowed = new Set(allowedClientFingerprints.map(fingerprint));
  const connections = new Map([...allowed].map(peer => [peer, new Set(clientConnectionScopes[peer])]));
  let active = 0;
  const inFlight = new Map();
  const server = createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', maxHeaderSize: 8192, handshakeTimeout: 10000 }, async (request, response) => {
    const certificate = request.socket.getPeerCertificate();
    const peer = fingerprint(certificate?.fingerprint256);
    const authorized = () => {
      try { return request.socket.authorized && allowed.has(peer) && Date.parse(certificate.valid_to) > Date.now()
        && !revocationStore?.isRevoked(peer); } catch { return false; }
    };
    if (!authorized()) return send(response, 403, { error: `${errorPrefix}_CLIENT_DENIED` });
    if(request.method==='POST'&&request.url===`/v1/${family}/disconnect`){
      if(!revocationStore)return send(response,503,{error:`${errorPrefix}_OPERATION_FAILED`});
      if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])return send(response,415,{error:`${errorPrefix}_CONTENT_DENIED`});
      try{
        let body='',size=0;for await(const chunk of request){size+=chunk.length;if(size>1024)return send(response,413,{error:`${errorPrefix}_REQUEST_TOO_LARGE`});body+=chunk;}
        const input=JSON.parse(body);if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length)return send(response,400,{error:`${errorPrefix}_REQUEST_INVALID`});
        if(!authorized())return send(response,403,{error:`${errorPrefix}_CLIENT_DENIED`});
        revocationStore.revoke(peer);
        for(const [controller,client] of inFlight)if(client===peer)controller.abort();
        allowed.delete(peer);
        return send(response,200,{result:{brokerAccessRevoked:true,credentialsDeleted:false,providerGrantRevoked:false}});
      }catch{return send(response,400,{error:`${errorPrefix}_OPERATION_FAILED`});}
    }
    if (request.method !== 'POST' || request.url !== endpointPath) return send(response, 404, { error: `${errorPrefix}_ROUTE_DENIED` });
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
      return send(response, 415, { error: `${errorPrefix}_CONTENT_DENIED` });
    }
    if (active >= maxConcurrent) return send(response, 429, { error: `${errorPrefix}_BUSY` });
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxRequestBytes) return send(response, 413, { error: `${errorPrefix}_REQUEST_TOO_LARGE` });
    active++;
    const controller = new AbortController();
    inFlight.set(controller, peer);
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.on('close', disconnected);
    const deadline = setTimeout(() => { controller.abort(); response.destroy(); }, operationTimeoutMs);
    deadline.unref();
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequestBytes) { send(response, 413, { error: `${errorPrefix}_REQUEST_TOO_LARGE` }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(response, 400, { error: `${errorPrefix}_REQUEST_INVALID` }); }
      if (!authorized()) return send(response, 403, { error: `${errorPrefix}_CLIENT_DENIED` });
      if (!connections.get(peer)?.has(input?.connectionId)) return send(response, 403, { error: `${errorPrefix}_CLIENT_DENIED` });
      controller.signal.throwIfAborted();
      const output = await broker.execute(input, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!authorized()) return send(response, 403, { error: `${errorPrefix}_CLIENT_DENIED` });
      if (Buffer.byteLength(JSON.stringify(output)) > maxResponseBytes - 32) {
        return send(response, 502, { error: `${errorPrefix}_RESPONSE_TOO_LARGE` });
      }
      send(response, 200, { result: output });
    } catch (error) { send(response, 400, { error: safeError(error, family) }); }
    finally { clearTimeout(deadline); response.off('close', disconnected); inFlight.delete(controller); active--; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(30000, socket => socket.destroy());
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  return Object.freeze({ server, revokeClient: value => {
    revocationStore?.revoke(fingerprint(value)); // durable commit precedes acknowledgement/local cache mutation
    for (const [controller, peer] of inFlight) if (peer === fingerprint(value)) controller.abort();
    return allowed.delete(fingerprint(value));
  } });
}

/** Core transport retains only its mTLS identity. Google credentials stay at the broker. */
export function createCredentialBrokerHttpsTransport({ family = 'google', url, key, cert, ca, timeoutMs = 30000 } = {}) {
  const { endpointPath, errorPrefix } = protocolFor(family);
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search
    || target.pathname !== endpointPath || !key || !cert || !ca
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error(`${errorPrefix}_TLS_CONFIG_INVALID`);
  const agent = new Agent({ key, cert, ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    keepAlive: true, maxSockets: 4, maxCachedSessions: 0 });
  let closed = false;
  const activeRequests=new Set();
  return Object.freeze({
    execute(input,{revokeSelf=false}={}) {
      if(revokeSelf&&(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length))return Promise.reject(new Error(`${errorPrefix}_REQUEST_INVALID`));
      if (closed) return Promise.reject(new Error(`${errorPrefix}_TRANSPORT_CLOSED`));
      const body = Buffer.from(JSON.stringify(input));
      if (body.length > maxRequestBytes) return Promise.reject(new Error(`${errorPrefix}_REQUEST_TOO_LARGE`));
      const signal=AbortSignal.timeout(timeoutMs);
      const send=(fresh=false)=>new Promise((resolve, reject) => {
        const fail = code => reject(new Error(code));
        let responseStarted=false;
        const req = httpsRequest(revokeSelf?new URL(`/v1/${family}/disconnect`,target):target, { method: 'POST', agent:fresh?false:agent,signal,
          ...(fresh?{key,cert,ca,rejectUnauthorized:true,minVersion:'TLSv1.3'}:{}),
          headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
          responseStarted=true;
          let size = 0; const chunks = [];
          res.on('data', chunk => {
            size += chunk.length;
            if (size > maxResponseBytes) { fail(`${errorPrefix}_RESPONSE_TOO_LARGE`); res.destroy(); return; }
            chunks.push(chunk);
          });
          res.on('error', () => fail(`${errorPrefix}_NETWORK`));
          res.on('end', () => {
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return fail(`${errorPrefix}_RESPONSE_INVALID`); }
            if (res.statusCode !== 200) {
              return fail(safeError({ message: payload?.error }, family));
            }
            if (!payload || !Object.hasOwn(payload, 'result') || Object.keys(payload).length !== 1) return fail(`${errorPrefix}_RESPONSE_INVALID`);
            resolve(payload.result);
          });
        });
        activeRequests.add(req);req.once('close',()=>activeRequests.delete(req));
        req.on('error', error => {
          // Both fixed protocols perform provider reads only. Reconnect once only
          // for a reset idle pooled socket before response headers; never replay a
          // partial response, timeout, certificate failure or a closed transport.
          if(!revokeSelf&&!fresh&&!closed&&!signal.aborted&&!responseStarted&&req.reusedSocket&&error.code==='ECONNRESET')
            return send(true).then(resolve,reject);
          fail(`${errorPrefix}_NETWORK`);
        });
        req.end(body);
      });
      return send();
    },
    close() { closed = true; agent.destroy();for(const req of activeRequests)req.destroy(); }
  });
}

// Preserve existing Google callers; protocol cannot be overridden by options.
export const createGoogleBrokerHttpsServer = options => createCredentialBrokerHttpsServer({ ...options, family: 'google' });
export const createGoogleBrokerHttpsTransport = options => createCredentialBrokerHttpsTransport({ ...options, family: 'google' });
