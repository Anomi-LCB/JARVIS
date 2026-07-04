import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const proxyTargets = [
  { prefix: '/api/core', target: process.env.JARVIS_CORE_API_URL ?? 'http://127.0.0.1:4071' },
  { prefix: '/api/pc', target: process.env.JARVIS_PC_AGENT_API_URL ?? 'http://127.0.0.1:17776' },
  { prefix: '/api/bridge', target: process.env.JARVIS_BRIDGE_API_URL ?? 'http://127.0.0.1:8787' }
];
const packageTargets = [
  {
    id: 'core',
    label: 'Core Service',
    manifestPath: join('dist', 'core-service-package', 'package-manifest.json'),
    serviceHostPath: join('dist', 'core-service-package', 'service-host.cs')
  },
  {
    id: 'pc',
    label: 'PC Agent',
    manifestPath: join('dist', 'pc-agent-installer', 'package-manifest.json'),
    serviceHostPath: join('dist', 'pc-agent-installer', 'service-host.cs')
  }
];

function matchProxy(pathname) {
  return proxyTargets.find((candidate) => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));
}

function safeDecodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readPackageTarget(target) {
  const manifestFile = join(root, target.manifestPath);
  const serviceHostFile = join(root, target.serviceHostPath);
  try {
    const [manifestText, manifestStats, serviceHostText] = await Promise.all([
      readFile(manifestFile, 'utf8'),
      stat(manifestFile),
      readFile(serviceHostFile, 'utf8').catch(() => '')
    ]);
    const manifest = JSON.parse(manifestText);
    return {
      id: target.id,
      label: target.label,
      status: 'ready',
      packageId: manifest.packageId,
      version: manifest.version,
      generatedAt: manifest.generatedAt ?? null,
      manifestUpdatedAt: manifestStats.mtime.toISOString(),
      serviceHostRecoveryReady: serviceHostText.includes('child.Exited +=') && serviceHostText.includes('Environment.Exit(exitCode)'),
      endpoint: manifest.endpoint ?? null
    };
  } catch (error) {
    return {
      id: target.id,
      label: target.label,
      status: 'missing',
      error: error.message
    };
  }
}

async function localPackageStatus() {
  const entries = await Promise.all(packageTargets.map(readPackageTarget));
  return {
    status: entries.every((entry) => entry.status === 'ready' && entry.serviceHostRecoveryReady) ? 'ready' : 'warning',
    generatedAt: new Date().toISOString(),
    packages: Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  };
}

function proxyRequest(request, response, proxy, sourceUrl) {
  const upstreamPath = sourceUrl.pathname.slice(proxy.prefix.length) || '/';
  const upstreamUrl = new URL(upstreamPath, proxy.target);
  upstreamUrl.search = sourceUrl.search;
  const headers = { ...request.headers, host: upstreamUrl.host };
  delete headers.connection;
  delete headers['content-length'];

  const upstream = httpRequest(upstreamUrl, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders['transfer-encoding'];
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', (error) => {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      success: false,
      error: {
        code: 'JARVIS_DEV_PROXY_UNAVAILABLE',
        message: error.message,
        target: proxy.target
      }
    }));
  });

  request.pipe(upstream);
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${host}:${port}`);
  const pathname = safeDecodePathname(requestUrl.pathname);
  if (!pathname) {
    sendJson(response, 400, {
      success: false,
      error: {
        code: 'JARVIS_DEV_SERVER_BAD_PATH',
        message: 'Request path contains malformed percent encoding.'
      }
    });
    return;
  }
  if (pathname === '/api/local/package-status') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_LOCAL_STATUS_METHOD_NOT_ALLOWED' } });
      return;
    }
    sendJson(response, 200, await localPackageStatus());
    return;
  }
  const proxy = matchProxy(pathname);
  if (proxy) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      });
      response.end();
      return;
    }
    proxyRequest(request, response, proxy, requestUrl);
    return;
  }

  const normalizedPath = normalize(pathname).replace(/^([/\\])+/, '');
  const safePath = normalizedPath
    .split(sep)
    .filter((part) => part !== '..')
    .join(sep);
  const filePath = join(root, safePath === '' ? 'index.html' : safePath);
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error('Not a file');
    response.setHeader('Content-Type', types[extname(filePath)] ?? 'application/octet-stream');
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}).listen(port, host, () => console.log(`JARVIS executive console available at http://${host}:${port}`));
