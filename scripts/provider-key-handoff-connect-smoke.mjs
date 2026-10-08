import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredCoreServiceRuntime } from '../scripts/core-service-runtime.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureKeys = Object.freeze({
  xai: 'synthetic-xai-key-fixture-only',
  meta: 'synthetic-meta-key-fixture-only',
  gemini: 'synthetic-gemini-key-fixture-only',
  'openai-agents': 'synthetic-openai-agents-key-fixture-only'
});
const modelIds = Object.freeze({ xai: 'xai-plan-fixture', meta: 'meta-plan-fixture', gemini: 'gemini-plan-fixture', 'openai-agents': 'gpt-6-sol' });
const providerCatalogUrls = Object.freeze({
  xai: 'https://api.x.ai/v1/models',
  meta: 'https://api.meta.ai/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
  'openai-agents': 'https://api.openai.com/v1/models'
});
const state = { providers: [], modelRequests: [] };
const smokeArguments = process.argv.slice(2);
const agentsOnly = smokeArguments.includes('--agents-only');
if (smokeArguments.some(argument => argument !== '--agents-only')) throw new Error('A_PROVIDER_CONNECT_SMOKE_ARGUMENT_INVALID');

const temporaryRoot = mkdtempSync(join(tmpdir(), 'jarvis-model-provider-connect-'));
const resolvedTemp = resolve(tmpdir()) + sep;
const resolvedRoot = resolve(temporaryRoot);
if (!resolvedRoot.startsWith(resolvedTemp)) throw new Error('Temporary test root escaped the OS temp directory.');
const localAppData = join(temporaryRoot, 'localappdata');
const provisionHarness = join(temporaryRoot, 'provision-harness.ps1');
const connectHarness = join(temporaryRoot, 'provider-connect-harness.ps1');
const baseScript = join(root, 'scripts', 'configure-integration-handoff-token.ps1');
const connectScript = join(root, 'scripts', 'personal-model-provider-connect.ps1');
const windowsPowerShellModules = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
const quotePs = value => `'${value.replace(/'/gu, "''")}'`;

function runPowerShell(arguments_, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...arguments_], {
      cwd: root, env, windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ status: code ?? (signal ? 1 : 0), stdout, stderr, timedOut });
    });
  });
}

let address;
let runtime;
try {
  const env = { ...process.env, PSModulePath: windowsPowerShellModules };
  const warmSecurity = [
    "$warmSecure = Microsoft.PowerShell.Security\\ConvertTo-SecureString -String 'temporary-module-load-check' -AsPlainText -Force",
    '[void](Microsoft.PowerShell.Security\\ConvertFrom-SecureString -SecureString $warmSecure)',
    '$warmSecure.Dispose()'
  ].join('\r\n');
  writeFileSync(provisionHarness, `${warmSecurity}\r\n$env:LOCALAPPDATA = ${quotePs(localAppData)}\r\n& ${quotePs(baseScript)}\r\n`, { encoding: 'utf8', mode: 0o600 });
  const provision = await runPowerShell(['-File', provisionHarness], env);
  assert.equal(provision.status, 0, `isolated DPAPI token provisioning exits successfully (${(provision.stderr || '').split(/\r?\n/u)[0]})`);
  assert.match(provision.stdout, /DPAPI_CURRENT_USER_TOKEN_STORED=true/u);
  assert.match(provision.stdout, /JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256=[0-9a-f]{64}/u);
  assert.doesNotMatch(provision.stdout + provision.stderr, /^TOKEN=[A-Za-z0-9_-]{43}$/mu,
    'the raw broker token is never printed as a standalone value');

  const tokenHash = provision.stdout.match(/JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256=([0-9a-f]{64})/u)?.[1];
  assert.ok(tokenHash, 'provisioning emits the hash-only broker configuration value');
  const coreData = join(temporaryRoot, 'isolated-core');
  const integrationVault = new IntegrationCredentialVault({
    path: join(coreData, 'credentials.dpapi.json'), platform: 'win32'
  });
  const modelProviderFetch = async (url, init) => {
    const provider = Object.keys(providerCatalogUrls).find(name => providerCatalogUrls[name] === url);
    const headerName = provider === 'gemini' ? 'x-goog-api-key' : 'Authorization';
    const headerValue = provider === 'gemini' ? init?.headers?.[headerName] : init?.headers?.[headerName];
    const expectedValue = provider === 'gemini' ? fixtureKeys.gemini : `Bearer ${fixtureKeys[provider]}`;
    state.modelRequests.push({ provider, url, method: init?.method, bodyPresent: init?.body !== undefined,
      credentialsMode: init?.credentials, redirects: init?.redirect, authenticated: headerValue === expectedValue });
    if (!provider || headerValue !== expectedValue) return new Response('{}', { status: 401 });
    const body = provider === 'gemini'
      ? { models: [{ name: `models/${modelIds.gemini}`, baseModelId: modelIds.gemini }] }
      : { data: [{ id: modelIds[provider] }, { id: 'additional-fixture-model' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const coreEnv = {
    ...process.env,
    JARVIS_TEST_MODE: '1',
    JARVIS_CORE_ROOT: coreData,
    JARVIS_CORE_AUDIT_ROOT: join(coreData, 'audit'),
    JARVIS_CORE_ALLOWED_ROOTS: join(coreData, 'workspace'),
    JARVIS_CORE_INTEGRATION_VAULT: integrationVault.path,
    JARVIS_CORE_INTEGRATION_HANDOFF_TOKEN_SHA256: tokenHash,
    JARVIS_PERSONAL_IMPORT_ENABLED: '0',
    JARVIS_GOOGLE_SYNC_ENABLED: '0',
    JARVIS_CORE_WORKER_DAEMON_AUTOSTART: 'false',
    JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: 'false',
    LOCALAPPDATA: localAppData
  };
  runtime = await createConfiguredCoreServiceRuntime({ env: coreEnv, integrationVault, modelProviderFetch });
  address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });

  const utilityWarmup = "[void](Microsoft.PowerShell.Utility\\ConvertTo-Json @{warmup='ok'} -Compress)";
  for (const provider of (agentsOnly ? [] : ['xai', 'meta', 'gemini'])) {
    const fixtureKey = fixtureKeys[provider];
    const harnessText = [warmSecurity, utilityWarmup, `$env:LOCALAPPDATA = ${quotePs(localAppData)}`,
      `function global:Read-Host { param([string]$Prompt, [switch]$AsSecureString); Microsoft.PowerShell.Security\\ConvertTo-SecureString -String '${fixtureKey}' -AsPlainText -Force }`,
      `try { & ${quotePs(connectScript)} -Provider ${provider} -CorePort ${address.port} -Verify -ModelId ${modelIds[provider]} } catch { Write-Error $_; exit 1 }`
    ].join('\r\n');
    writeFileSync(connectHarness, harnessText, { encoding: 'utf8', mode: 0o600 });
    const connected = await runPowerShell(['-File', connectHarness], env);
    const safeOutput = `${String(connected.stdout).replaceAll(fixtureKey, '[REDACTED]')} ${String(connected.stderr || '').replaceAll(fixtureKey, '[REDACTED]')}`;
    assert.ok(connected.status === 0, `${provider} helper completes against the isolated Core runtime (status=${connected.status}; timedOut=${connected.timedOut}; ${safeOutput.slice(-1200)})`);
    assert.match(connected.stdout, new RegExp(`PROVIDER=${provider}`, 'u'));
    assert.match(connected.stdout, /CREDENTIAL_STATE=stored/u);
    assert.match(connected.stdout, /PROVIDER_VERIFIED=true/u);
    assert.match(connected.stdout, /PROVIDER_VERIFICATION_STATUS=verified/u);
    assert.match(connected.stdout, /REQUESTED_MODEL_AVAILABLE=true/u);
    assert.match(connected.stdout, /EXECUTION_AUTHORIZED=false/u);
    assert.doesNotMatch(connected.stdout + connected.stderr, new RegExp(fixtureKey, 'u'));
  }
  {
    const fixtureKey = fixtureKeys['openai-agents'];
    const harnessText = [warmSecurity, utilityWarmup, `$env:LOCALAPPDATA = ${quotePs(localAppData)}`,
      `function global:Read-Host { param([string]$Prompt, [switch]$AsSecureString); Microsoft.PowerShell.Security\\ConvertTo-SecureString -String '${fixtureKey}' -AsPlainText -Force }`,
      `try { & ${quotePs(connectScript)} -Provider openai-agents -CorePort ${address.port} -Verify -ModelId ${modelIds['openai-agents']} } catch { Write-Error $_; exit 1 }`
    ].join('\r\n');
    writeFileSync(connectHarness, harnessText, { encoding: 'utf8', mode: 0o600 });
    const connected = await runPowerShell(['-File', connectHarness], env);
    const safeOutput = `${String(connected.stdout).replaceAll(fixtureKey, '[REDACTED]')} ${String(connected.stderr || '').replaceAll(fixtureKey, '[REDACTED]')}`;
    assert.ok(connected.status === 0, `OpenAI Agents helper stores credentials in the isolated Core runtime (status=${connected.status}; timedOut=${connected.timedOut}; ${safeOutput.slice(-1200)})`);
    assert.match(connected.stdout, /PROVIDER=openai-agents/u);
    assert.match(connected.stdout, /CREDENTIAL_STATE=stored/u);
    assert.match(connected.stdout, /PROVIDER_VERIFIED=true/u);
    assert.match(connected.stdout, /REQUESTED_MODEL_AVAILABLE=true/u);
    assert.match(connected.stdout, /SCOPES=agents\.session\.create,agents\.session\.read,agents\.provider\.verify/u);
    assert.match(connected.stdout, /EXECUTION_AUTHORIZED=false/u);
    assert.doesNotMatch(connected.stdout + connected.stderr, new RegExp(fixtureKey, 'u'));
  }
  state.providers.push(...(agentsOnly ? ['openai-agents'] : ['xai', 'meta', 'gemini', 'openai-agents']));
  const connections = integrationVault.list();
  assert.equal(connections.length, agentsOnly ? 1 : 4, 'the actual Core runtime persisted the requested provider credential set');
  assert.deepEqual(connections.map(connection => connection.connectorId).sort(), agentsOnly ? ['jarvis-openai-agents'] :
    ['jarvis-model-gemini', 'jarvis-model-meta', 'jarvis-model-xai', 'jarvis-openai-agents']);
  const agentsConnection = connections.find(connection => connection.connectorId === 'jarvis-openai-agents');
  assert.equal(agentsConnection.status, 'credentials-stored-provider-verified');
  assert.deepEqual([...agentsConnection.scopes].sort(), ['agents.provider.verify', 'agents.session.create', 'agents.session.read']);
  assert.equal(agentsConnection.executionAuthorized, undefined);
  const readinessResponse = await fetch(`http://127.0.0.1:${address.port}/integrations`, {
    headers: { authorization: `Bearer ${runtime.options.adminToken}` }
  });
  assert.equal(readinessResponse.status, 200);
  const managedAgentReadiness = await readinessResponse.json();
  assert.deepEqual(managedAgentReadiness.managedAgentCredentials, {
    'provider.verify': true, 'session.create': true, 'session.read': true, 'session.message': false,
    'session.tool-result': false, 'session.cancel': false
  });
  assert.doesNotMatch(JSON.stringify(managedAgentReadiness), new RegExp(fixtureKeys['openai-agents'], 'u'));
  const modelConnections = connections.filter(connection => connection.connectorId.startsWith('jarvis-model-'));
  assert.ok(modelConnections.every(connection => connection.status === 'credentials-stored-provider-verified'
    && connection.verificationState === 'provider-verified'
    && connection.grants.length === 0 && connection.scopes.length === 1 && connection.scopes[0] === 'model.plan'));
  assert.ok(modelConnections.every(connection => connection.providerVerification?.providerVerified === true
    && connection.providerVerification?.requestedModelAvailable === true));
  const recoveredKeys = [];
  for (const provider of (agentsOnly ? ['openai-agents'] : Object.keys(fixtureKeys))) {
    const connection = connections.find(item => item.connectorId === (provider === 'openai-agents' ? 'jarvis-openai-agents' : `jarvis-model-${provider}`));
    recoveredKeys.push(await integrationVault.withCredentials(connection.connectionId,
      credentials => credentials.apiKey));
  }
  assert.deepEqual(recoveredKeys, agentsOnly ? [fixtureKeys['openai-agents']] : Object.values(fixtureKeys), 'the isolated Core DPAPI vault decrypts each test credential');
  const vaultFileText = readFileSync(integrationVault.path, 'utf8');
  const expectedFixtureKeys = agentsOnly ? [fixtureKeys['openai-agents']] : Object.values(fixtureKeys);
  assert.ok(expectedFixtureKeys.every(key => !vaultFileText.includes(key)),
    'raw fixture keys do not appear in the Core vault file');
  assert.equal(integrationVault.status().storesPlaintextCredentials, false);
  await runtime.close();
  runtime = null;
  const restartedVault = new IntegrationCredentialVault({ path: integrationVault.path, platform: 'win32' });
  runtime = await createConfiguredCoreServiceRuntime({ env: coreEnv, integrationVault: restartedVault });
  address = await listenOnFetchSafePort(runtime.server, { host: '127.0.0.1', port: 0 });
  const restartedConnections = restartedVault.list();
  assert.equal(restartedConnections.length, agentsOnly ? 1 : 4, 'provider credential records survive an isolated Core restart');
  assert.ok(restartedConnections.filter(connection => connection.connectorId.startsWith('jarvis-model-')).every(connection => connection.status === 'credentials-stored-provider-verified'
    && connection.verificationState === 'provider-verified' && connection.grants.length === 0),
  'provider verification state survives restart without adding JARVIS grants');
  const restartedAgents = restartedConnections.find(connection => connection.connectorId === 'jarvis-openai-agents');
  assert.equal(restartedAgents.status, 'credentials-stored-provider-verified');
  assert.deepEqual([...restartedAgents.scopes].sort(), ['agents.provider.verify', 'agents.session.create', 'agents.session.read']);
  const keysAfterRestart = [];
  for (const provider of (agentsOnly ? ['openai-agents'] : Object.keys(fixtureKeys))) {
    const connection = restartedConnections.find(item => item.connectorId === (provider === 'openai-agents' ? 'jarvis-openai-agents' : `jarvis-model-${provider}`));
    keysAfterRestart.push(await restartedVault.withCredentials(connection.connectionId,
      credentials => credentials.apiKey));
  }
  assert.deepEqual(keysAfterRestart, agentsOnly ? [fixtureKeys['openai-agents']] : Object.values(fixtureKeys), 'CurrentUser DPAPI decrypts credentials after isolated Core restart');
  assert.deepEqual(restartedConnections.filter(connection => connection.providerVerification)
    .map(connection => connection.providerVerification.modelId).sort(),
    agentsOnly ? [modelIds['openai-agents']] : Object.values(modelIds).sort(), 'provider catalog verification metadata survives isolated Core restart');
  assert.equal(state.modelRequests.length, agentsOnly ? 1 : 4);
  assert.ok(state.modelRequests.every(request => request.method === 'GET' && request.bodyPresent === false
    && request.credentialsMode === 'omit' && request.redirects === 'error' && request.authenticated));
  console.log(JSON.stringify({
    version: 'jarvis-model-provider-connect-smoke-v7',
    result: 'passed',
    providers: state.providers,
    requests: { handoffIssue: agentsOnly ? 1 : 4, handoffComplete: agentsOnly ? 1 : 4 },
    providerCatalogChecks: state.modelRequests.map(({ provider, url, method, bodyPresent, credentialsMode, redirects, authenticated }) =>
      ({ provider, url, method, bodyPresent, credentialsMode, redirects, authenticated })),
    assertions: [
      'DPAPI broker-token read', 'dedicated non-admin bearer',
      agentsOnly ? 'Agents key is stored under create/read/provider-verify scopes' : 'three model-provider scopes and isolated Agents create/read/provider-verify scopes',
      'secure prompt reaches each one-use ticket completion', 'fixture keys omitted from console output',
      agentsOnly ? 'encrypted CurrentUser DPAPI vault stores and recovers the Agents key after restart'
        : 'encrypted CurrentUser DPAPI Core vault stores and recovers three model keys and the Agents key',
      'fixed read-only provider catalog GET uses only an auth header and sends no user body',
      'model and Agents verification metadata survives isolated Core restart',
      'raw fixture keys absent from the vault file',
      'provider verification does not grant session execution or JARVIS grants'
    ],
    networkTarget: '127.0.0.1 isolated Core runtime plus injected fetch fixtures only',
    externalProviderRequests: 0,
    billingEvents: 0
  }, null, 2));
} catch (error) {
  const safeMessage = error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 3000) : 'A_MODEL_PROVIDER_CONNECT_SMOKE_FAILED';
  console.error(safeMessage);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
  if (resolvedRoot.startsWith(resolvedTemp)) rmSync(resolvedRoot, { recursive: true, force: true });
}
