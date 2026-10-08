import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { checkLoopbackHttpBoundary, isLoopbackHostname } from '../packages/shared/src/http.js';
import {
  DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS,
  createHostedControlCorsHeaders,
  normalizeHostedOriginList
} from '../packages/shared/src/control-center-hosting.js';
import { createPublicLlmProviderStatus } from './llm-provider-diagnostics.mjs';
import { createProductSupportBundle } from './product-support-bundle.mjs';
import { LocalExportStore } from '../packages/shared/src/local-export-store.js';
import { readJsonBody } from '../packages/shared/src/http.js';
import {createPackagedUiReader} from './packaged-ui-reader.mjs';
import {createDuffelSetupController} from './duffel-setup-controller.mjs';
const localExports = new LocalExportStore();

const port = Number(process.env.PORT ?? 41730);
const host = process.env.HOST ?? '127.0.0.1';
const root = process.cwd();
const packagedUi=process.env.JARVIS_UI_PACKAGE_DIR?await createPackagedUiReader(process.env.JARVIS_UI_PACKAGE_DIR):null;
const duffelSetup=createDuffelSetupController({env:{...process.env,JARVIS_DUFFEL_SETUP_ENABLED:process.env.JARVIS_DUFFEL_SETUP_ENABLED??(packagedUi?'1':'0')}});
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const hostedControlOrigins = normalizeHostedOriginList([
  ...DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS,
  process.env.JARVIS_CONTROL_CENTER_REMOTE_ORIGINS ?? ''
]);
const browserSecurityHeaders = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), microphone=(self), clipboard-write=(self)',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-xss-protection': '0'
});
const controlCenterContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "worker-src 'self' blob:"
].join('; ');
const proxyTargets = [
  {
    prefix: '/api/core',
    target: process.env.JARVIS_CORE_API_URL ?? 'http://127.0.0.1:4071',
    managedAuthentication: true,
    authorizationToken: process.env.JARVIS_CORE_ADMIN_TOKEN ?? null
  },
  {
    prefix: '/api/pc',
    target: process.env.JARVIS_PC_AGENT_API_URL ?? 'http://127.0.0.1:17776',
    managedAuthentication: true,
    authorizationToken: process.env.JARVIS_PC_AGENT_API_TOKEN ?? null
  },
  { prefix: '/api/bridge', target: process.env.JARVIS_BRIDGE_API_URL ?? 'http://127.0.0.1:17777' }
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

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...browserSecurityHeaders,
    ...(response.jarvisHostedCorsHeaders ?? {}),
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function hostedControlRequestHeaders(request) {
  const headers = createHostedControlCorsHeaders(request.headers?.origin, hostedControlOrigins);
  if (!headers) return null;
  const remoteAddress = String(request.socket?.remoteAddress ?? '').trim();
  if (!isLoopbackHostname(remoteAddress)) return null;
  try {
    const hostUrl = new URL(`http://${request.headers?.host ?? ''}`);
    if (!isLoopbackHostname(hostUrl.hostname)) return null;
  } catch {
    return null;
  }
  return headers;
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

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(join(root, path), 'utf8'));
  } catch {
    return null;
  }
}

async function localReleaseStatus() {
  const [gate, handoff] = await Promise.all([
    readJsonIfPresent(join('dist', 'final-release-gate.json')),
    readJsonIfPresent(join('dist', 'ag-operator-handoff.json'))
  ]);
  const pendingValidation = (handoff?.externalValidation ?? [])
    .filter((item) => item.status !== 'verified')
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      command: item.command
    }));
  const blockingChecks = (gate?.checks ?? [])
    .filter((item) => item.passed !== true)
    .map((item) => item.checkId);
  return {
    status: gate?.status ?? 'not-generated',
    releaseMode: gate?.releaseMode ?? 'unknown',
    generatedAt: gate?.generatedAt ?? null,
    handoffStatus: handoff?.status ?? 'not-generated',
    pendingValidation,
    pendingValidationCount: pendingValidation.length,
    blockingChecks,
    rawReportsExposed: false
  };
}

async function localLlmProviderStatus() {
  const report = await readJsonIfPresent(join('dist', 'llm-provider-diagnostics.json'));
  return createPublicLlmProviderStatus(report);
}

function proxyRequest(request, response, proxy, sourceUrl) {
  const upstreamPath = sourceUrl.pathname.slice(proxy.prefix.length) || '/';
  const upstreamUrl = new URL(upstreamPath, proxy.target);
  upstreamUrl.search = sourceUrl.search;
  const headers = { ...request.headers, host: upstreamUrl.host };
  delete headers.connection;
  delete headers['content-length'];
  delete headers.origin;
  delete headers.referer;
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  delete headers.forwarded;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  if (proxy.managedAuthentication) {
    // Completion uses a one-use ingress ticket, not the proxy's administrator token.
    const credentialTicket = proxy.prefix === '/api/core' && request.method === 'POST'
      && /^\/integrations\/handoffs\/[a-f0-9-]{36}\/complete$/.test(upstreamPath);
    if (!credentialTicket) delete headers.authorization;
    delete headers.cookie;
    if (!credentialTicket && proxy.authorizationToken) headers.authorization = `Bearer ${proxy.authorizationToken}`;
  }

  const upstream = httpRequest(upstreamUrl, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['access-control-allow-origin'];
    delete responseHeaders['access-control-allow-credentials'];
    responseHeaders['cache-control'] = 'no-store';
    Object.assign(responseHeaders, browserSecurityHeaders, response.jarvisHostedCorsHeaders ?? {});
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', () => {
    response.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...browserSecurityHeaders,
      ...(response.jarvisHostedCorsHeaders ?? {})
    });
    response.end(JSON.stringify({
      success: false,
      error: {
        code: 'JARVIS_DEV_PROXY_UNAVAILABLE',
        message: '요청한 로컬 런타임에 연결할 수 없습니다.'
      }
    }));
  });

  request.pipe(upstream);
}

createServer(async (request, response) => {
  const hostedCorsHeaders = hostedControlRequestHeaders(request);
  if (hostedCorsHeaders) response.jarvisHostedCorsHeaders = hostedCorsHeaders;
  const localBoundary = checkLoopbackHttpBoundary(request);
  if (!localBoundary.allowed && !hostedCorsHeaders) {
    sendJson(response, localBoundary.statusCode, localBoundary);
    return;
  }
  if (request.method === 'OPTIONS' && hostedCorsHeaders) {
    response.writeHead(204, {
      ...browserSecurityHeaders,
      ...hostedCorsHeaders
    });
    response.end();
    return;
  }
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
  if(pathname==='/api/local/duffel-setup'){
    const ownOrigin=`http://${request.headers.host}`;
    if(!localBoundary.allowed||hostedCorsHeaders||requestUrl.search||request.headers['sec-fetch-site']==='cross-site'
      ||request.headers.origin&&request.headers.origin!==ownOrigin){sendJson(response,403,{error:{code:'JARVIS_DUFFEL_SETUP_LOCAL_ONLY'}});return;}
    if(request.method==='GET'){sendJson(response,200,duffelSetup.read());return;}
    if(request.method!=='POST'){sendJson(response,405,{error:{code:'JARVIS_DUFFEL_SETUP_METHOD_INVALID'}});return;}
    if(request.headers.origin!==ownOrigin||request.headers['content-type']!=='application/json'||request.headers['content-encoding']){
      sendJson(response,403,{error:{code:'JARVIS_DUFFEL_SETUP_LOCAL_ONLY'}});return;
    }
    try{const body=await readJsonBody(request,{maximumBytes:1024});sendJson(response,202,duffelSetup.start(body,request.headers['x-jarvis-setup-nonce']));}
    catch(error){const code=/^JARVIS_DUFFEL_SETUP_[A-Z_]+$/u.test(error?.message??'')?error.message:'JARVIS_DUFFEL_SETUP_FAILED';
      sendJson(response,code.endsWith('AUTH_REQUIRED')?401:code.endsWith('INPUT_INVALID')?400:409,{error:{code}});}
    return;
  }
  if (pathname === '/health') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_UI_HEALTH_METHOD_NOT_ALLOWED' } });
      return;
    }
    sendJson(response, 200, {
      status: 'ok',
      module: 'JARVIS_CONTROL_CENTER',
      product: 'JARVIS',
      version: '1.0.0',
      localOnly: true
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
  if (pathname === '/api/local/exports') {
    if(request.method!=='POST')return sendJson(response,405,{error:{code:'JARVIS_EXPORT_METHOD'}});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??''))return sendJson(response,415,{error:{code:'JARVIS_EXPORT_JSON_REQUIRED'}});
    try { return sendJson(response,201,localExports.create(await readJsonBody(request,{maximumBytes:300*1024}))); }
    catch(error){return sendJson(response,error.statusCode??400,{error:{code:'JARVIS_EXPORT_UNAVAILABLE'}});}
  }
  if (/^\/api\/local\/exports\/[a-f0-9-]{36}$/.test(pathname)) {
    if(!['GET','HEAD'].includes(request.method))return sendJson(response,405,{error:{code:'JARVIS_EXPORT_METHOD'}});
    const item=localExports.get(pathname.split('/').at(-1));
    if(!item)return sendJson(response,410,{error:{code:'JARVIS_EXPORT_EXPIRED'}});
    response.writeHead(200,{...browserSecurityHeaders,'content-type':'text/plain; charset=utf-8','cache-control':'no-store','content-disposition':`attachment; filename="${item.filename}"`});
    response.end(request.method==='HEAD'?'':item.content);return;
  }
  if (pathname === '/api/local/release-status') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_LOCAL_RELEASE_STATUS_METHOD_NOT_ALLOWED' } });
      return;
    }
    sendJson(response, 200, await localReleaseStatus());
    return;
  }
  if (pathname === '/api/local/llm-status') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_LOCAL_LLM_STATUS_METHOD_NOT_ALLOWED' } });
      return;
    }
    sendJson(response, 200, await localLlmProviderStatus());
    return;
  }
  if (pathname === '/api/local/capabilities') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_LOCAL_CAPABILITIES_METHOD_NOT_ALLOWED' } });
      return;
    }
    sendJson(response, 200, {
      capabilitiesVersion: 'jarvis-control-center-local-capabilities-v1',
      coreAdminProxyConfigured: Boolean(proxyTargets.find(candidate => candidate.prefix === '/api/core')?.authorizationToken),
      pcAgentProxyConfigured: Boolean(proxyTargets.find(candidate => candidate.prefix === '/api/pc')?.authorizationToken),
      credentialsExposed: false
    });
    return;
  }
  if (pathname === '/api/local/support-bundle') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { success: false, error: { code: 'JARVIS_SUPPORT_BUNDLE_METHOD_NOT_ALLOWED' } });
      return;
    }
    try {
      const bundle = await createProductSupportBundle({
        workspaceRoot: root,
        refreshWindowsSigning: true
      });
      const download = requestUrl.searchParams.get('download') === '1';
      sendJson(response, 200, bundle, download
        ? { 'Content-Disposition': 'attachment; filename="jarvis-support-bundle.json"' }
        : {});
    } catch {
      sendJson(response, 500, {
        success: false,
        error: {
          code: 'JARVIS_SUPPORT_BUNDLE_FAILED',
          message: '지원 진단을 완료하지 못했습니다.'
        }
      });
    }
    return;
  }
  const proxy = matchProxy(pathname);
  if (proxy) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'authorization,content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        ...browserSecurityHeaders
      });
      response.end();
      return;
    }
    proxyRequest(request, response, proxy, requestUrl);
    return;
  }

  if(packagedUi){
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405,browserSecurityHeaders);return response.end();}
    try{
      const bytes=await packagedUi(pathname);response.writeHead(200,{'Content-Type':types[extname(pathname==='/'?'index.html':pathname)],'Cache-Control':'no-store',...browserSecurityHeaders,'Content-Security-Policy':controlCenterContentSecurityPolicy});
      return response.end(request.method==='HEAD'?undefined:bytes);
    }catch{response.writeHead(404,browserSecurityHeaders);return response.end('Not found');}
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
    response.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(browserSecurityHeaders)) response.setHeader(name, value);
    if (safePath === '' || safePath === 'index.html') {
      response.setHeader('Content-Security-Policy', controlCenterContentSecurityPolicy);
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, browserSecurityHeaders);
    response.end('Not found');
  }
}).on('close',()=>duffelSetup.close()).listen(port, host, () => console.log(`JARVIS executive console available at http://${host}:${port}`));
