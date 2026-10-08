import { Agent, createServer, request } from 'node:https';
import { PcOutboundCommandMailbox } from './pc-outbound-command-mailbox.js';

const path = '/v1/pc/observe';
const limit = 270336;
const commandPath='/v1/pc/command';
const commandLimit=1_048_576+8192;
const send = (res, status, payload) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const safe = error => /^A_PC_(?:OUTBOUND|COMMAND)_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'A_PC_OUTBOUND_UNAVAILABLE';

/** Runs on the authority node; the PC initiates every TLS connection. */
export function createPcOutboundServer({ mailbox, commandMailbox=null, key, cert, ca } = {}) {
  if (!mailbox?.pull || !mailbox?.submit || !key || !cert || !ca) throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  if(commandMailbox!==null&&(!(commandMailbox instanceof PcOutboundCommandMailbox)||commandMailbox.mailbox!==mailbox))throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  let active = 0;
  const server = createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', handshakeTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    if (!req.socket.authorized) return send(res, 403, { error: 'A_PC_OUTBOUND_DEVICE_DENIED' });
    const certificate = req.socket.getPeerCertificate();
    if (Date.parse(certificate?.valid_to) <= Date.now()) return send(res, 403, { error: 'A_PC_OUTBOUND_DEVICE_DENIED' });
    const peer = certificate?.fingerprint256;
    const commands=req.url===commandPath&&commandMailbox!==null;
    const payloadLimit=commands?commandLimit:limit;
    if (req.method !== 'POST' || (req.url !== path&&!commands)) return send(res, 404, { error: 'A_PC_OUTBOUND_ROUTE_DENIED' });
    if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) return send(res, 415, { error: 'A_PC_OUTBOUND_CONTENT_DENIED' });
    if (active >= 4) return send(res, 429, { error: 'A_PC_OUTBOUND_BUSY' });
    active++;
    try {
      mailbox.device(peer);
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > payloadLimit) return send(res, 413, { error: 'A_PC_OUTBOUND_TOO_LARGE' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key => !['operation','body'].includes(key))) throw new Error('A_PC_OUTBOUND_REQUEST_INVALID');
      if(commands&&(!input.body||typeof input.body!=='object'||Array.isArray(input.body)))throw new Error('A_PC_OUTBOUND_REQUEST_INVALID');
      let output;
      const channel=commands?commandMailbox:mailbox;
      if (input.operation === 'pull' && input.body && !Object.keys(input.body).length) output = channel.pull(peer);
      else if (input.operation === 'submit' && (!commands||(input.body&&Object.keys(input.body).length===3&&['requestId','lease','result'].every(key=>Object.hasOwn(input.body,key))))) output = channel.submit(peer, input.body);
      else if(commands&&input.operation==='validate'&&input.body&&Object.keys(input.body).length===2&&['requestId','lease'].every(key=>Object.hasOwn(input.body,key)))output=channel.validate(peer,input.body);
      else throw new Error('A_PC_OUTBOUND_REQUEST_INVALID');
      send(res, 200, { result: output });
    } catch (error) { send(res, 400, { error: safe(error) }); }
    finally { active--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxConnections = 16; server.maxRequestsPerSocket = 100;
  return server;
}

/** The caller loads the private key through the existing private-file guard. */
export function createPcOutboundTransport(options={}) { return createTransport(options,path,limit); }
export function createPcOutboundCommandTransport(options={}) { return createTransport(options,commandPath,commandLimit); }
function createTransport({ url, key, cert, ca, timeoutMs = 10000 } = {},expectedPath,payloadLimit) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.pathname !== expectedPath || target.search || target.hash || target.username || target.password
    || !key || !cert || !ca || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('A_PC_OUTBOUND_CONFIG_INVALID');
  const agent = new Agent({ key, cert, ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    keepAlive: true, maxSockets: 1, maxCachedSessions: 0 });
  let closed = false;
  return {
    exchange(operation, body) {
      if (closed) return Promise.reject(new Error('A_PC_OUTBOUND_CLOSED'));
      const bytes = Buffer.from(JSON.stringify({ operation, body }));
      if (bytes.length > payloadLimit) return Promise.reject(new Error('A_PC_OUTBOUND_TOO_LARGE'));
      return new Promise((resolve, reject) => {
        const req = request(target, { method: 'POST', agent, signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > payloadLimit) { reject(new Error('A_PC_OUTBOUND_TOO_LARGE')); res.destroy(); return; }
            chunks.push(chunk);
          });
          res.on('error', () => reject(new Error('A_PC_OUTBOUND_NETWORK')));
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200) throw new Error(safe({ message: value?.error }));
              if (!value || !Object.hasOwn(value, 'result') || Object.keys(value).length !== 1) throw new Error('A_PC_OUTBOUND_RESPONSE_INVALID');
              resolve(value.result);
            } catch (error) { reject(new Error(safe(error))); }
          });
        });
        req.on('error', () => reject(new Error('A_PC_OUTBOUND_NETWORK'))); req.end(bytes);
      });
    },
    close() { closed = true; agent.destroy(); }
  };
}
