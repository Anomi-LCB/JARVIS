import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const productSecretStoreVersion = 'jarvis-product-runtime-secret-store-v1';
const WINDOWS_SECRET_OPERATION_TIMEOUT_MS = 20_000;

export function resolveProductRuntimeSecrets({
  env = process.env,
  platform = process.platform,
  storePath = defaultProductSecretStorePath(env),
  randomBytesImpl = randomBytes,
  protect = protectWithWindowsDpapi,
  unprotect = unprotectWithWindowsDpapi,
  hardenStore = hardenWindowsSecretFile,
  clock = () => new Date()
} = {}) {
  const configuredCoreToken = normalizeConfiguredToken(env.JARVIS_CORE_ADMIN_TOKEN, 'core');
  const configuredPcToken = normalizeConfiguredToken(env.JARVIS_PC_AGENT_API_TOKEN, 'pc-agent');
  const testMode = env.JARVIS_TEST_MODE === '1';

  let storedSecrets = null;
  let storeStatus = null;
  if (!configuredCoreToken || !configuredPcToken) {
    if (testMode) {
      storedSecrets = createSecretPayload(randomBytesImpl);
      storeStatus = {
        provider: 'test-ephemeral',
        protectedByOs: false,
        persistent: false,
        plaintextSecretsStored: false,
        source: 'generated'
      };
    } else if (platform === 'win32') {
      const resolved = loadOrCreateWindowsSecretStore({
        storePath,
        randomBytesImpl,
        protect,
        unprotect,
        hardenStore,
        clock
      });
      storedSecrets = resolved.secrets;
      storeStatus = resolved.status;
    } else {
      const error = new Error('Product runtime secrets require environment tokens or the Windows DPAPI provider.');
      error.code = 'JARVIS_PRODUCT_SECRET_PROVIDER_REQUIRED';
      throw error;
    }
  }

  const coreToken = configuredCoreToken ?? storedSecrets.coreToken;
  const pcAgentToken = configuredPcToken ?? storedSecrets.pcAgentToken;
  const coreTokenHash = sha256(coreToken);
  const pcAgentTokenHash = sha256(pcAgentToken);
  const bridgeDeviceTokenSecret = createHmac('sha256', coreToken)
    .update(`jarvis-bridge-device-token-v1\0${pcAgentToken}`)
    .digest('base64url');
  const pcAgentExecutionToken = createHmac('sha256', pcAgentToken)
    .update(`jarvis-core-pc-execution-v1\0${coreToken}`)
    .digest('base64url');
  const capabilityTokenSecret = createHmac('sha256', coreToken)
    .update(`jarvis-cross-process-capability-v1\0${pcAgentToken}`)
    .digest('base64url');
  const bridgeGrowthReviewToken = createHmac('sha256', coreToken)
    .update(`jarvis-bridge-growth-review-v1\0${pcAgentToken}`)
    .digest('base64url');
  const bridgeDeviceTokenKeyId = authKeyId(sha256(bridgeDeviceTokenSecret));
  assertConfiguredHashMatches(env.JARVIS_CORE_ADMIN_TOKEN_SHA256, coreTokenHash, 'core');
  assertConfiguredHashMatches(env.JARVIS_PC_AGENT_API_TOKEN_SHA256, pcAgentTokenHash, 'pc-agent');

  return {
    coreToken,
    pcAgentToken,
    coreTokenHash,
    pcAgentTokenHash,
    pcAgentExecutionToken,
    pcAgentExecutionTokenHash: sha256(pcAgentExecutionToken),
    pcAgentExecutionAuthKeyId: authKeyId(sha256(pcAgentExecutionToken)),
    capabilityTokenSecret,
    bridgeGrowthReviewToken,
    bridgeGrowthReviewTokenHash: sha256(bridgeGrowthReviewToken),
    bridgeGrowthReviewTokenKeyId: authKeyId(sha256(bridgeGrowthReviewToken)),
    capabilityTokenKeyId: authKeyId(sha256(capabilityTokenSecret)),
    bridgeDeviceTokenSecret,
    bridgeDeviceTokenKeyId,
    coreAuthKeyId: authKeyId(coreTokenHash),
    pcAgentAuthKeyId: authKeyId(pcAgentTokenHash),
    status: {
      secretStatusVersion: 'jarvis-product-runtime-secret-status-v1',
      provider: storeStatus?.provider ?? 'environment-secret',
      protectedByOs: storeStatus?.protectedByOs ?? false,
      persistent: storeStatus?.persistent ?? false,
      plaintextSecretsStored: false,
      source: configuredCoreToken && configuredPcToken ? 'environment' : storeStatus.source,
      coreConfigured: true,
      pcAgentConfigured: true,
      pcAgentExecutionDelegationConfigured: true,
      crossProcessCapabilityConfigured: true,
      bridgeDeviceTokenConfigured: true,
      bridgeGrowthReviewAuthorizationConfigured: true
    }
  };
}

export function defaultProductSecretStorePath(env = process.env) {
  if (env.JARVIS_PRODUCT_SECRET_STORE) return resolve(env.JARVIS_PRODUCT_SECRET_STORE);
  const userDataRoot = env.LOCALAPPDATA || env.APPDATA || join(homedir(), '.jarvis');
  return resolve(userDataRoot, 'JARVIS', 'secrets', 'product-runtime-secrets.json');
}

function loadOrCreateWindowsSecretStore({ storePath, randomBytesImpl, protect, unprotect, hardenStore, clock }) {
  mkdirSync(dirname(storePath), { recursive: true });
  if (existsSync(storePath)) {
    hardenStore(storePath);
    return readWindowsSecretStore({ storePath, unprotect });
  }

  const secrets = createSecretPayload(randomBytesImpl);
  const clearPayload = Buffer.from(JSON.stringify(secrets), 'utf8').toString('base64');
  const record = {
    secretStoreVersion: productSecretStoreVersion,
    provider: 'windows-dpapi-current-user',
    protectedByOs: true,
    protectedPayload: protect(clearPayload),
    createdAt: clock().toISOString(),
    plaintextSecretsStored: false
  };
  try {
    writeFileSync(storePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    hardenStore(storePath);
    return {
      secrets,
      status: {
        provider: record.provider,
        protectedByOs: true,
        persistent: true,
        plaintextSecretsStored: false,
        source: 'created'
      }
    };
  } catch (error) {
    if (error.code === 'EEXIST') {
      hardenStore(storePath);
      return readWindowsSecretStore({ storePath, unprotect });
    }
    throw error;
  }
}

function readWindowsSecretStore({ storePath, unprotect }) {
  let record;
  try {
    record = JSON.parse(readFileSync(storePath, 'utf8'));
  } catch (cause) {
    throw secretStoreError('JARVIS_PRODUCT_SECRET_STORE_INVALID', 'Product runtime secret store is unreadable.', cause);
  }
  if (
    record.secretStoreVersion !== productSecretStoreVersion
    || record.provider !== 'windows-dpapi-current-user'
    || typeof record.protectedPayload !== 'string'
    || record.plaintextSecretsStored !== false
  ) {
    throw secretStoreError('JARVIS_PRODUCT_SECRET_STORE_INVALID', 'Product runtime secret store metadata is invalid.');
  }
  let secrets;
  try {
    const clearBase64 = unprotect(record.protectedPayload);
    secrets = JSON.parse(Buffer.from(clearBase64, 'base64').toString('utf8'));
    validateSecretPayload(secrets);
  } catch (cause) {
    throw secretStoreError('JARVIS_PRODUCT_SECRET_STORE_DECRYPT_FAILED', 'Product runtime secrets could not be unsealed for this Windows user.', cause);
  }
  return {
    secrets,
    status: {
      provider: record.provider,
      protectedByOs: true,
      persistent: true,
      plaintextSecretsStored: false,
      source: 'loaded'
    }
  };
}

function createSecretPayload(randomBytesImpl) {
  const payload = {
    payloadVersion: 'jarvis-product-runtime-secret-payload-v1',
    coreToken: `jrv_core_${randomBytesImpl(32).toString('base64url')}`,
    pcAgentToken: `jrv_pc_${randomBytesImpl(32).toString('base64url')}`
  };
  validateSecretPayload(payload);
  return payload;
}

function validateSecretPayload(payload) {
  if (
    payload?.payloadVersion !== 'jarvis-product-runtime-secret-payload-v1'
    || !isStrongToken(payload.coreToken)
    || !isStrongToken(payload.pcAgentToken)
    || payload.coreToken === payload.pcAgentToken
  ) {
    throw secretStoreError('JARVIS_PRODUCT_SECRET_PAYLOAD_INVALID', 'Product runtime secret payload is invalid.');
  }
}

function normalizeConfiguredToken(value, label) {
  const token = String(value ?? '').trim();
  if (!token) return null;
  if (!isStrongToken(token)) {
    const error = new Error(`Configured ${label} product token must contain at least 24 URL-safe characters.`);
    error.code = 'JARVIS_PRODUCT_TOKEN_WEAK';
    throw error;
  }
  return token;
}

function isStrongToken(value) {
  return typeof value === 'string' && value.length >= 24 && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertConfiguredHashMatches(value, actualHash, label) {
  const configuredHash = normalizeSha256(value);
  if (!configuredHash) return;
  if (configuredHash !== actualHash) {
    const error = new Error(`Configured ${label} token does not match its SHA-256 hash.`);
    error.code = 'JARVIS_PRODUCT_TOKEN_HASH_MISMATCH';
    throw error;
  }
}

function normalizeSha256(value) {
  const normalized = String(value ?? '').replace(/^sha256:/, '').trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    const error = new Error('Configured product token hash must be a SHA-256 hex digest.');
    error.code = 'JARVIS_PRODUCT_TOKEN_HASH_INVALID';
    throw error;
  }
  return normalized;
}

export function protectWithWindowsDpapi(inputBase64) {
  return runWindowsDpapi(inputBase64, 'Protect');
}

export function unprotectWithWindowsDpapi(inputBase64) {
  return runWindowsDpapi(inputBase64, 'Unprotect');
}

function runWindowsDpapi(inputBase64, mode) {
  const method = mode === 'Protect' ? 'Protect' : 'Unprotect';
  const command = [
    'Add-Type -AssemblyName System.Security;',
    '$bytes=[Convert]::FromBase64String($env:JARVIS_PRODUCT_DPAPI_INPUT);',
    '$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    `$out=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,$scope);`,
    '[Convert]::ToBase64String($out)'
  ].join(' ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: WINDOWS_SECRET_OPERATION_TIMEOUT_MS,
    env: { ...process.env, JARVIS_PRODUCT_DPAPI_INPUT: inputBase64 }
  }).trim();
}

export function hardenWindowsSecretFile(storePath) {
  const command = [
    '$path=$env:JARVIS_PRODUCT_SECRET_PATH;',
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();',
    '$acl=[System.IO.File]::GetAccessControl($path);',
    '$acl.SetAccessRuleProtection($true,$false);',
    'foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)};',
    '$access=New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User,"FullControl","Allow");',
    '$acl.AddAccessRule($access);',
    '$acl.SetOwner($identity.User);',
    '[System.IO.File]::SetAccessControl($path,$acl)'
  ].join(' ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: WINDOWS_SECRET_OPERATION_TIMEOUT_MS,
    env: { ...process.env, JARVIS_PRODUCT_SECRET_PATH: storePath }
  });
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function authKeyId(hash) {
  return `sha256:${String(hash).slice(0, 12)}`;
}

function secretStoreError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
