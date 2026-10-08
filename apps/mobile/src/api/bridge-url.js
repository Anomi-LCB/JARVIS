const defaultBridgeUrl = 'http://127.0.0.1:17777';

export function normalizeBridgeUrlForPlatform(input, { platform = 'unknown' } = {}) {
  const raw = String(input || defaultBridgeUrl).trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (platform === 'android' && url.hostname === 'adb.localhost') {
      url.hostname = '127.0.0.1';
    } else if (platform === 'android' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      url.hostname = '10.0.2.2';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}
