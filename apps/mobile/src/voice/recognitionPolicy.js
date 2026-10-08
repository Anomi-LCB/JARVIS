const fallbackPriority = [
  'com.google.android.tts',
  'com.google.android.as',
  'com.samsung.android.bixby.agent'
];

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function normalizedServices(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )];
}

/**
 * @param {{ availableServices?: unknown[], defaultService?: unknown }} [options]
 * @returns {string[]}
 */
export function buildRecognitionServiceOrder({ availableServices = [], defaultService = '' } = {}) {
  const available = normalizedServices(availableServices);
  const systemDefault = String(defaultService ?? '').trim();
  const ordered = [];
  const add = (service) => {
    if (service && !ordered.includes(service)) ordered.push(service);
  };

  if (systemDefault && available.includes(systemDefault)) add(systemDefault);
  if (systemDefault && !available.includes(systemDefault)) add('platform-default');
  for (const service of fallbackPriority) {
    if (available.includes(service)) add(service);
  }
  for (const service of available) add(service);
  add('platform-default');
  return ordered;
}

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isRecoverableRecognitionStartError(code) {
  return !new Set([
    'aborted',
    'not-allowed',
    'permission-denied',
    'insufficient-permissions'
  ]).has(String(code ?? '').trim().toLowerCase());
}

export const recognitionStartupTimeoutMs = 5000;
