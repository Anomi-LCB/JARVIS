import http from 'node:http';
import { LocalNetworkGuard } from './network-guard.js';
import { checkLoopbackHttpBoundary, sendJson } from '../../../packages/shared/src/http.js';

// Canonicalize before prefixing: an encoded '..' must never reach a Core route.
export function mobileGatewayPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//')
    || /[\\\r\n#]/u.test(rawPath)) throw new Error('D_GATEWAY_PATH_INVALID');
  const parsed = new URL(rawPath, 'http://bridge.invalid');
  if (parsed.origin !== 'http://bridge.invalid') throw new Error('D_GATEWAY_PATH_INVALID');
  return `/mobile${parsed.pathname}${parsed.search}`;
}

function filteredHeaders(headers, { upgrade = false } = {}) {
  const excluded = new Set(['host', 'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'forwarded']);
  for (const token of String(headers.connection ?? '').split(',')) excluded.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return !(lower.startsWith('x-forwarded-') || excluded.has(lower))
      || (upgrade && ['connection', 'upgrade'].includes(lower));
  }));
}

export function createCoreBridgeGateway({ coreUrl, networkGuard = new LocalNetworkGuard(), timeoutMs = 15_000 } = {}) {
  const upstream = new URL(coreUrl);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('D_GATEWAY_CORE_ORIGIN_INVALID');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('D_GATEWAY_TIMEOUT_INVALID');
  const sockets = new Set();
  const requests = new Set();
  let closed = false;
  const prepare = request => {
    if (closed) throw new Error('D_GATEWAY_CLOSED');
    if (!networkGuard.evaluate({ hostHeader: request.headers.host, remoteAddress: request.socket.remoteAddress,
      headers: request.headers }).allowed) throw new Error('D_PUBLIC_NETWORK_BLOCKED');
    return mobileGatewayPath(request.url);
  };
  const options = (request, path, upgrade = false) => ({ hostname: upstream.hostname.replace(/^\[|\]$/gu, ''),
    port: upstream.port || 80, method: request.method, path,
    headers: { ...filteredHeaders(request.headers, { upgrade }), host: upstream.host }, agent: false });
  const server = http.createServer((request, response) => {
    let path;
    try { path = prepare(request); }
    catch (error) { return sendJson(response, error.message === 'D_PUBLIC_NETWORK_BLOCKED' ? 403 : 400, { error: { code: error.message } }); }
    const outgoing = http.request(options(request, path));
    requests.add(outgoing);
    let timer = setTimeout(() => outgoing.destroy(new Error('D_GATEWAY_UPSTREAM_TIMEOUT')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); requests.delete(outgoing); };
    outgoing.once('response', incoming => {
      clearTimeout(timer); // SSE stays open; only the initial response has a deadline.
      response.writeHead(incoming.statusCode, filteredHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
      response.once('close', () => incoming.destroy());
    });
    outgoing.once('error', () => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 503, { error: { code: 'D_GATEWAY_CORE_UNAVAILABLE' }, executionRetried: false });
    });
    outgoing.once('close', cleanup);
    request.once('aborted', () => outgoing.destroy());
    response.once('close', () => outgoing.destroy());
    request.pipe(outgoing);
  });
  server.on('upgrade', (request, socket, head) => {
    let path;
    try { path = prepare(request); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const outgoing = http.request(options(request, path, true));
    requests.add(outgoing);
    const timer = setTimeout(() => outgoing.destroy(), timeoutMs);
    const cleanup = () => { clearTimeout(timer); requests.delete(outgoing); };
    outgoing.once('upgrade', (response, peer, peerHead) => {
      cleanup();
      sockets.add(socket); sockets.add(peer);
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`
        + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
      socket.once('close', () => { sockets.delete(socket); peer.destroy(); });
      peer.once('close', () => { sockets.delete(peer); socket.destroy(); });
      socket.pipe(peer).pipe(socket);
    });
    outgoing.once('response', response => {
      response.resume(); cleanup();
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
    });
    outgoing.once('error', () => { cleanup(); socket.destroy(); });
    socket.once('close', () => outgoing.destroy());
    outgoing.end();
  });
  server.closeGatewayConnections = () => {
    closed = true;
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
  };
  return server;
}

// A router without a second listener, task store or execution engine.
export function mountCoreMobileUpgrades(coreServer, mobileRouter) {
  const sockets = new Set();
  coreServer.on('upgrade', (request, socket, head) => {
    if (!checkLoopbackHttpBoundary(request).allowed || !request.url.startsWith('/mobile/')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    request.url = request.url.slice('/mobile'.length);
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    mobileRouter.emit('upgrade', request, socket, head);
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
