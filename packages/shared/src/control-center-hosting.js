export const DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS = Object.freeze([
  'https://jarvis-command-center.anomi-7.chatgpt.site'
]);

export const DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN = 'http://127.0.0.1:41730';

export function normalizeWebOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeHostedOriginList(values = []) {
  return [...new Set(values
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => normalizeWebOrigin(value))
    .filter((value) => value?.startsWith('https://')))];
}

export function isTrustedHostedControlOrigin(
  origin,
  allowedOrigins = DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS
) {
  const normalized = normalizeWebOrigin(origin);
  if (!normalized) return false;
  return normalizeHostedOriginList(allowedOrigins).includes(normalized);
}

export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname === '::1') return true;
    const octets = hostname.split('.').map(Number);
    return octets.length === 4
      && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      && octets[0] === 127;
  } catch {
    return false;
  }
}

export function resolveControlCenterNetwork({
  locationRef = globalThis.location,
  settingReader = () => null,
  allowedOrigins = DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS
} = {}) {
  const pageOrigin = normalizeWebOrigin(locationRef?.origin);
  const hosted = isTrustedHostedControlOrigin(pageOrigin, allowedOrigins);
  const configuredLocalOrigin = normalizeWebOrigin(settingReader('jarvis.localControlOrigin'));
  const localControlOrigin = configuredLocalOrigin && isLoopbackHttpUrl(configuredLocalOrigin)
    ? configuredLocalOrigin : DEFAULT_JARVIS_LOCAL_CONTROL_ORIGIN;
  const prefix = hosted ? localControlOrigin : '';

  return Object.freeze({
    mode: hosted ? 'hosted-local-bridge' : 'local',
    hosted,
    pageOrigin,
    localControlOrigin,
    coreBaseUrl: `${prefix}/api/core`,
    pcBaseUrl: `${prefix}/api/pc`,
    bridgeBaseUrl: `${prefix}/api/bridge`,
    localApiBaseUrl: prefix
  });
}

export function createHostedControlCorsHeaders(
  origin,
  allowedOrigins = DEFAULT_JARVIS_HOSTED_CONTROL_ORIGINS
) {
  if (!isTrustedHostedControlOrigin(origin, allowedOrigins)) return null;
  return {
    'access-control-allow-origin': normalizeWebOrigin(origin),
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'Origin'
  };
}
