const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 992, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080
]);

export const DEFAULT_MAXIMUM_JSON_BODY_BYTES = 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export async function readJsonBody(request, options = {}) {
  const maximumBytes = normalizeMaximumBodyBytes(options);
  const declaredLength = readDeclaredContentLength(request.headers?.['content-length']);
  if (declaredLength > maximumBytes) {
    discardRequestBody(request);
    throw new HttpRequestError(413, 'REQUEST_BODY_TOO_LARGE', 'JSON request body exceeds the allowed size.');
  }

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maximumBytes) {
      discardRequestBody(request);
      throw new HttpRequestError(413, 'REQUEST_BODY_TOO_LARGE', 'JSON request body exceeds the allowed size.');
    }
    chunks.push(buffer);
  }

  let body;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpRequestError(400, 'INVALID_JSON_ENCODING', 'JSON request body must use valid UTF-8.');
  }
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpRequestError(400, 'INVALID_JSON', 'JSON request body is malformed.');
  }
}

export function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const protectedHeaders = new Set(['content-type', 'cache-control', 'x-content-type-options', 'content-length']);
  const additionalHeaders = Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !protectedHeaders.has(String(name).toLowerCase())));
  response.writeHead(statusCode, {
    ...additionalHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

export function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function routePath(request) {
  return new URL(request.url, 'http://127.0.0.1').pathname;
}

export function checkLoopbackHttpBoundary(request) {
  const remoteAddress = normalizeRemoteAddress(request.socket?.remoteAddress);
  if (!remoteAddress || !isLoopbackHostname(remoteAddress)) {
    return localBoundaryDenied('REMOTE_ADDRESS_NOT_LOOPBACK');
  }

  const hostAuthority = parseHeaderAuthority(request.headers?.host);
  const host = hostAuthority?.hostname ?? null;
  if (!hostAuthority || !isLoopbackHostname(host)) {
    return localBoundaryDenied('HOST_NOT_LOOPBACK');
  }

  const fetchSite = String(request.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return localBoundaryDenied('CROSS_SITE_BROWSER_REQUEST');
  }

  const origin = String(request.headers?.origin ?? '').trim();
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return localBoundaryDenied('ORIGIN_INVALID');
    }
    if (
      originUrl.protocol !== 'http:'
      || originUrl.username
      || originUrl.password
      || originUrl.pathname !== '/'
      || originUrl.search
      || originUrl.hash
      || !isLoopbackHostname(originUrl.hostname)
    ) {
      return localBoundaryDenied('ORIGIN_NOT_LOOPBACK');
    }
    if (originUrl.host.toLowerCase() !== hostAuthority.authority) {
      return localBoundaryDenied('ORIGIN_AUTHORITY_MISMATCH');
    }
  }

  return {
    allowed: true,
    boundaryVersion: 'jarvis-loopback-http-boundary-v1',
    remoteAddress,
    host,
    origin: origin || null,
    fetchSite: fetchSite || null
  };
}

export function isLoopbackHostname(value) {
  const hostname = String(value ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (hostname.startsWith('::ffff:')) return isLoopbackHostname(hostname.slice(7));
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

export function routeParams(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(':')) {
      try {
        const decoded = decodeURIComponent(pathPart);
        if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) return null;
        params[patternPart.slice(1)] = decoded;
      } catch {
        return null;
      }
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

export async function safeHandle(response, handler) {
  try {
    await handler();
  } catch (error) {
    if (response.headersSent || response.writableEnded) {
      if (!response.writableEnded) response.end();
      return;
    }
    const exposed = error?.expose === true
      && Number.isInteger(error?.statusCode)
      && error.statusCode >= 400
      && error.statusCode <= 499;
    sendJson(response, exposed ? error.statusCode : 500, {
      success: false,
      error: {
        code: exposed ? error.code : 'INTERNAL_ERROR',
        message: exposed ? error.message : 'The request could not be completed.'
      }
    });
  }
}

function normalizeMaximumBodyBytes(options) {
  const candidate = typeof options === 'number' ? options : options?.maximumBytes;
  const maximumBytes = candidate ?? DEFAULT_MAXIMUM_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('maximum_json_body_bytes_invalid');
  }
  return maximumBytes;
}

function readDeclaredContentLength(value) {
  if (value === undefined) return 0;
  const text = Array.isArray(value) ? value[0] : value;
  if (!/^\d+$/.test(String(text))) {
    throw new HttpRequestError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length must be a non-negative integer.');
  }
  const length = Number(text);
  if (!Number.isSafeInteger(length)) {
    throw new HttpRequestError(413, 'REQUEST_BODY_TOO_LARGE', 'JSON request body exceeds the allowed size.');
  }
  return length;
}

function discardRequestBody(request) {
  if (!request.complete && typeof request.resume === 'function') request.resume();
}

function normalizeRemoteAddress(value) {
  const address = String(value ?? '').trim();
  if (address.toLowerCase().startsWith('::ffff:')) return address.slice(7);
  return address;
}

function parseHeaderAuthority(value) {
  const host = Array.isArray(value) ? value[0] : value;
  if (!host) return null;
  const text = String(host);
  if (text !== text.trim() || text.length > 255 || /[\s\\/?#@,]/.test(text)) return null;
  try {
    const url = new URL(`http://${text}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return {
      hostname: url.hostname,
      authority: url.host.toLowerCase()
    };
  } catch {
    return null;
  }
}

function localBoundaryDenied(reason) {
  return {
    allowed: false,
    statusCode: 403,
    boundaryVersion: 'jarvis-loopback-http-boundary-v1',
    error: {
      code: 'LOCAL_HTTP_BOUNDARY_DENIED',
      message: 'This local API accepts requests only from a trusted loopback origin.'
    },
    reason
  };
}

export function isFetchSafePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 && !fetchForbiddenPorts.has(port);
}

export async function listenOnFetchSafePort(server, {
  host = '127.0.0.1',
  port = 0,
  maxAttempts = 32
} = {}) {
  const requestedPort = Number(port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new RangeError('fetch_safe_port_invalid');
  }
  if (requestedPort !== 0 && !isFetchSafePort(requestedPort)) {
    throw new RangeError('fetch_safe_port_blocked');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await listenOnce(server, requestedPort, host);
    const address = server.address();
    if (address && typeof address === 'object' && isFetchSafePort(address.port)) return address;
    await closeServer(server);
  }
  throw new Error('fetch_safe_port_unavailable');
}

function listenOnce(server, port, host) {
  return new Promise((resolveStart, rejectStart) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectStart(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveStart();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
