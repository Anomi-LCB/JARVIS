import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreClient } from '../packages/core/src/client/core-client.js';
import { IntegrationConnectorRegistry } from '../packages/core/src/personal-operations/integration-security.js';
import { CoreAdminAuthProvider, CoreAdminScope } from '../packages/core/src/security/core-admin-auth.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import { renderIntegrationReadiness } from '../src/ui/integration-readiness.js';

test('authenticated integration API distinguishes executable code from fresh observations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-availability-http-'));
  let now = Date.parse('2026-09-27T00:00:00Z');
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'),
    env: { JARVIS_TEST_MODE: '1', JARVIS_MISSION_PLANNER: 'rule' }, clock: () => new Date(now) });
  const registry = runtime.capabilityPackageRegistry;
  const server = createCoreServer(runtime.coreFacade, { adminToken: 'test-availability', capabilityPackageRegistry: registry,
    modelProviderStatus: runtime.modelProviderStatus });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.coreFacade.cognition?.close?.();
    rmSync(root, { recursive: true, force: true });
  });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new CoreClient({ baseUrl, adminToken: 'test-availability' });
  assert.equal((await fetch(`${baseUrl}/integrations`)).status, 401);
  const externalOffer = await client.evaluateExternalCapability({ offerId: 'gemini-spark-custom-apps', region: 'KR', language: 'ko-KR', direction: 'jarvis-calls-provider' });
  assert.equal(externalOffer.providerAvailability, 'unavailable');
  assert.equal(externalOffer.offer.direction, 'provider-calls-jarvis');
  assert.equal(externalOffer.offer.directionMismatch, true);
  assert.equal(externalOffer.executionAuthorized, false);
  assert.equal(externalOffer.externalCallPerformed, false);
  assert.equal(externalOffer.alternatives[0].toolName, 'workflow.execute');
  const externalPanel = renderIntegrationReadiness({ externalCapabilityEvaluation: externalOffer });
  assert.match(externalPanel, /현재 조건에서 지원되지 않음/);
  assert.match(externalPanel, /Gemini가 JARVIS를 호출하는 연결/);
  assert.match(externalPanel, /부분 보조/);
  assert.doesNotMatch(externalPanel, /test-availability/);
  const before = await client.integrationReadiness();
  assert.equal(before.modelProviders.connectionProbePerformed, false);
  assert.equal(before.modelProviders.configuration.length, 5);
  assert.ok(before.modelProviders.configuration.every(row => row.connectionStatus === 'unverified' && !row.executionAuthorized));
  const localModel = before.modelProviders.configuration.find(row => row.provider === 'ollama-local');
  assert.equal(localModel.credentialPresent, false);
  assert.equal(localModel.stage, 'setup-required');
  const modelBoundaries = Object.fromEntries(before.modelProviders.configuration.map(row => [row.provider, row]));
  assert.equal(modelBoundaries.xai.productAgentApiStatus, 'not-integrated');
  assert.equal(modelBoundaries.xai.surfaceLabel, 'xAI 모델 API');
  assert.match(modelBoundaries.xai.productBoundary, /Grok Bot 완제품/);
  assert.equal(modelBoundaries.meta.surfaceLabel, 'Meta Model API · Muse Spark 모델');
  assert.match(modelBoundaries.meta.productBoundary, /Muse 개인 에이전트 완제품/);
  assert.equal(modelBoundaries.gemini.surfaceLabel, 'Gemini 개발자 API');
  assert.match(modelBoundaries.gemini.productBoundary, /Gemini Spark 완제품/);
  const setupPanel = renderIntegrationReadiness(before);
  assert.match(setupPanel, /AI 모델 연결/);
  assert.match(setupPanel, /완제품 에이전트 앱\(Grok Bot·Muse·Gemini Spark\) 연동과 모델 API 연결은 별개/);
  assert.match(setupPanel, /설정 필요/);
  assert.match(setupPanel, /모델 미선택/);
  assert.match(setupPanel, /Ollama 로컬 모델/);
  assert.match(setupPanel, /API 키 불필요 · 로컬 런타임/);
  assert.match(setupPanel, /select-provider-and-pin-model/);
  assert.doesNotMatch(setupPanel, /test-availability|JARVIS_.*API_KEY/);
  assert.deepEqual(before.connectors, []);
  const unavailableProvider = await client.storeIntegrationCredentials({ connectorId: 'google-workspace', providerAccountId: 'user@example.test', authMethod: 'oauth2', scopes: [], credentials: { accessToken: 'not-a-real-token' } });
  assert.equal(unavailableProvider.statusCode, 404);
  assert.equal(before.capabilities.codeReadyCount, 1);
  assert.equal(before.capabilities.readyCountBasis, 'code-projections-only');
  assert.equal(before.capabilities.availability.liveAvailableCount, 0);
  assert.match(renderIntegrationReadiness(before), /최근 점검 기록이 없습니다/);
  const { toolName, packageDigest } = registry.status().activations[0];
  // A fixture observation exercises the wire contract; it is not a real provider probe.
  registry.recordAvailability({ capabilityId: toolName, providerId: 'local', scopes: [], codeVersion: packageDigest,
    observedAt: new Date(now).toISOString(), verificationLevel: 'live-probe', evidenceRef: 'fixture-probe' });
  const fresh = await client.integrationReadiness();
  assert.equal(fresh.capabilities.availability.liveAvailableCount, 1);
  assert.equal(fresh.capabilities.availability.liveExecutionVerifiedCount, 0);
  assert.equal(fresh.capabilities.availability.items[0].executionAuthorized, false);
  assert.match(renderIntegrationReadiness(fresh), /실행 증거가 있는 연결 0개 · 읽기 점검만 확인 1개/);
  const write = await fetch(`${baseUrl}/integrations`, { method: 'POST', headers: { authorization: 'Bearer test-availability', 'content-type': 'application/json' }, body: JSON.stringify({ verificationLevel: 'repeated-live' }) });
  assert.equal(write.status, 400);
  now += 60_001;
  const stale = await client.integrationReadiness();
  assert.equal(stale.capabilities.availability.liveAvailableCount, 0);
  assert.equal(stale.capabilities.availability.items[0].freshness, 'stale');
  assert.match(renderIntegrationReadiness(stale), /추가 확인 1개/);
});

test('readiness panel shows missing API evidence as unknown and escapes provider text', () => {
  assert.match(renderIntegrationReadiness(null), /아직 확인하지 못했습니다/);
  assert.doesNotMatch(renderIntegrationReadiness(null), /실행 증거가 있는 연결/);
  const markup = renderIntegrationReadiness({ capabilities: { codeReadyCount: 78, availability: { liveAvailableCount: 999, items: [
    { capabilityId: '<script>test</script>', available: false, status: 'blocked', nextAction: '<img src=x onerror=alert(1)>', verificationLevel: 'repeated-live' }
  ] } } });
  assert.match(markup, /실행 증거가 있는 연결 0개/);
  assert.match(markup, /등록된 실행 코드 78개/);
  assert.doesNotMatch(markup, /<script>|<img/);
  const externalMarkup = renderIntegrationReadiness({ externalCapabilityEvaluation: {
    providerAvailability: 'unavailable', offer: { provider: '<img src=x>', feature: 'custom app', direction: 'provider-calls-jarvis' },
    unsupportedReasons: ['region-not-supported'], missingRequirements: ['sparkAccess'], unmetRequirements: [],
    alternatives: [{ toolName: '<script>tool</script>', description: '<img src=x>', readiness: 'local-code-registered' }]
  } });
  assert.match(externalMarkup, /미지원|지원되지 않음/);
  assert.doesNotMatch(externalMarkup, /<img|<script>/);
  assert.match(externalMarkup, /미확인 조건: sparkAccess/);
});

test('model readiness labels incomplete credentials and escapes provider-controlled display fields', () => {
  const markup = renderIntegrationReadiness({ modelProviders: { configuration: [
    { provider: 'meta', surfaceLabel: 'Meta Model API · Muse Spark 모델', productBoundary: 'Muse 완제품 미연결', integrationScope: '텍스트 계획', stage: 'setup-required', selected: true, model: 'muse-spark-1.3', credentialPresent: false },
    { provider: 'xai', surfaceLabel: 'xAI 모델 API', productBoundary: '<img src=x>', integrationScope: '텍스트 계획', stage: 'configured-unverified', connectionStatus: 'unverified', model: '<img src=x>', credentialPresent: true },
    { provider: 'gemini-interactions', surfaceLabel: 'Gemini Interactions API', productBoundary: 'Gemini Spark 완제품 미연결', integrationScope: '상태 비저장 구조화 계획', stage: 'configured-unverified', connectionStatus: 'unverified', model: 'gemini-3.5-pro', credentialPresent: true },
    { provider: 'ollama-local', stage: 'configured-unverified', connectionStatus: 'unverified', model: 'gemma3:latest', credentialPresent: false, nextAction: 'verify-local-model-catalog' },
    { provider: '<script>', stage: 'configured-unverified', connectionStatus: 'verified', selected: true }
  ] } });
  assert.match(markup, /모델 선택됨 · API 키 필요/);
  assert.match(markup, /설정됨 · 서버 연결 미검증/);
  assert.match(markup, /런타임 키 설정 존재/);
  assert.match(markup, /xAI 모델 API/);
  assert.match(markup, /Meta Model API · Muse Spark 모델/);
  assert.match(markup, /Gemini Interactions API/);
  assert.match(markup, /상태 비저장 구조화 계획/);
  assert.match(markup, /Grok Bot·Muse·Gemini Spark/);
  const vaultMarkup = renderIntegrationReadiness({ modelProviders: { configuration: [
    { provider: 'meta', stage: 'configured-unverified', connectionStatus: 'unverified', credentialPresent: true, credentialSource: 'dpapi-vault' }
  ] } });
  assert.match(vaultMarkup, /DPAPI 보관소에 키 저장/);
  assert.doesNotMatch(markup, /<img|<script>/);
  assert.match(markup, /실제 계정 연결이나 모델 응답을 확인한 결과가 아닙니다/);
  assert.match(markup, /모델 선택됨 · 로컬 런타임\/모델 미검증/);
  assert.match(markup, /gemma3:latest · API 키 불필요 · 로컬 런타임 · 다음: verify-local-model-catalog/);
  assert.match(markup, /실제 계정 연결이나 모델 응답을 확인한 결과가 아닙니다\. Ollama는 이 PC의 로컬 런타임 상태를 별도로 확인해야 합니다/);
});

test('provider credential checks distinguish authentication and authorization failures without showing provider response bodies', () => {
  const markup = renderIntegrationReadiness({ connections: [
    { connectorId: 'jarvis-model-meta', providerVerification: { status: 'authentication-rejected', checkedAt: '2026-09-30T00:00:00.000Z', errorCode: 'A_MODEL_PROVIDER_AUTH_REJECTED' } },
    { connectorId: 'jarvis-openai-agents', providerVerification: { status: 'authorization-rejected', checkedAt: '2026-09-30T00:01:00.000Z', errorCode: 'A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED' } },
    { connectorId: 'jarvis-model-xai', providerVerification: { status: 'authorization-rejected', checkedAt: '2026-09-30T00:02:00.000Z', errorCode: '<script>must-escape</script>' } }
  ] });
  assert.match(markup, /인증 거부 · 키 만료·폐기 여부 확인/);
  assert.match(markup, /권한 거부 · 키 scope와 제공자 조직\/프로젝트 정책 확인/);
  assert.match(markup, /A_MODEL_PROVIDER_POLICY_OR_SCOPE_REJECTED/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /제공자 응답 본문이나 키는 화면에 표시하지 않습니다/);
  assert.match(markup, /403은 정책 또는 scope 거부 신호이며 구체 원인은 제공자 조직 설정에서 확인해야 합니다/);
  assert.match(markup, /미국 데이터 거주·no-ZDR/);
  assert.match(markup, /별도 모델\/도구\/호스팅 비용/);
});

test('provider credential verification is an explicit permission-gated read-only action', () => {
  const connections = [{ connectorId: 'jarvis-model-meta', status: 'credentials-stored-unverified' }];
  const unauthorized = renderIntegrationReadiness({ connections });
  assert.match(unauthorized, /아직 제공자 읽기 검증을 하지 않았습니다/);
  assert.match(unauthorized, /data-verify-model-provider="meta" disabled/);
  assert.match(unauthorized, /통합 관리 권한이 필요합니다/);

  const authorized = renderIntegrationReadiness({ connections, canManageIntegrations: true });
  assert.match(authorized, /data-verify-model-provider="meta"/);
  assert.doesNotMatch(authorized, /data-verify-model-provider="meta" disabled/);
  assert.match(authorized, /모델 목록 API에 읽기 요청/);

  const busy = renderIntegrationReadiness({ connections, canManageIntegrations: true, providerVerifyBusy: 'meta' });
  assert.match(busy, /data-verify-model-provider="meta" disabled/);
  assert.match(busy, /확인 중…/);
});

test('provider API-key setup renders only for a configured local handoff and never prepopulates secrets', () => {
  const disabled = renderIntegrationReadiness({ canManageIntegrations: true, canSetupProviderCredentials: false, connections: [] });
  assert.doesNotMatch(disabled, /data-provider-credential-setup|name="apiKey"/);

  const enabled = renderIntegrationReadiness({ canManageIntegrations: true, canSetupProviderCredentials: true, connections: [] });
  assert.match(enabled, /data-provider-credential-setup/);
  assert.match(enabled, /type="password" name="apiKey"/);
  assert.match(enabled, /채팅에 보내지 마세요/);
  assert.match(enabled, /OpenAI Agents 읽기 검증 전용/);
  assert.match(enabled, /저장만 하며 제공자 인증·모델 실행 권한은 부여되지 않습니다/);
  assert.match(enabled, /미국 데이터 거주만 지원하며 ZDR을 지원하지 않습니다/);
  assert.match(enabled, /모델·도구·호스팅 샌드박스 비용이 따로 발생할 수 있습니다/);
  assert.doesNotMatch(enabled, /<input[^>]*\bvalue="[^"]+"/);

  const busy = renderIntegrationReadiness({ canSetupProviderCredentials: true, providerSetupBusy: true, connections: [] });
  assert.match(busy, /보호 저장소에 전달 중…/);
  assert.match(busy, /name="apiKey"[^>]*disabled/);
});

test('integration credential management is limited to registered connector scopes and never claims verification', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-integration-write-http-'));
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'),
    env: { JARVIS_TEST_MODE: '1', JARVIS_MISSION_PLANNER: 'rule' } });
  const registry = new IntegrationConnectorRegistry();
  registry.register({ id: 'test-mail', displayName: 'Test Mail', authMethods: ['oauth2', 'api-key'], scopes: ['mail.read'], capabilities: [] });
  const writes = [];
  const removals = [];
  const vault = {
    save(input) {
      writes.push(input);
      return { connectionId: 'connection-1', connectorId: input.connectorId, scopes: [...input.scopes], status: 'credentials-stored-unverified', verificationState: 'unverified' };
    },
    list() { return writes.map(({ credentials, providerAccountId, ...item }) => ({ connectionId: 'connection-1', connectorId: item.connectorId, status: 'credentials-stored-unverified', verificationState: 'unverified' })); },
    status() { return { state: writes.length ? 'present-not-probed' : 'empty', verificationState: 'not-probed' }; },
    remove(id) { removals.push(id); return { removed: true, remoteGrantRevoked: false }; }
  };
  const server = createCoreServer(runtime.coreFacade, {
    adminAuth: new CoreAdminAuthProvider({ tokens: [
      { token: 'test-integration-write', scopes: [CoreAdminScope.ADMIN] },
      { token: 'integration-reader', scopes: [CoreAdminScope.READ_DIAGNOSTICS] }
    ] }), integrationRegistry: registry, integrationVault: vault
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.coreFacade.cognition?.close?.();
    rmSync(root, { recursive: true, force: true });
  });
  const address = await listenOnFetchSafePort(server, { host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new CoreClient({ baseUrl, adminToken: 'test-integration-write' });
  const secret = 'test-access-token-never-return-this';

  assert.equal((await fetch(`${baseUrl}/integrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const readerWrite = await fetch(`${baseUrl}/integrations`, { method: 'POST', headers: { authorization: 'Bearer integration-reader', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(readerWrite.status, 403);
  assert.equal((await fetch(`${baseUrl}/integrations`, { headers: { authorization: 'Bearer integration-reader' } })).status, 200);
  const missingConnector = await client.storeIntegrationCredentials({ connectorId: 'unregistered', providerAccountId: 'person@example.test', authMethod: 'oauth2', scopes: [], credentials: { accessToken: secret } });
  assert.equal(missingConnector.statusCode, 404);
  const excessiveScope = await client.storeIntegrationCredentials({ connectorId: 'test-mail', providerAccountId: 'person@example.test', authMethod: 'api-key', scopes: ['mail.send'], credentials: { apiKey: secret } });
  assert.equal(excessiveScope.statusCode, 409);
  const forgedGrant = await client.storeIntegrationCredentials({ connectorId: 'test-mail', providerAccountId: 'person@example.test', authMethod: 'api-key', scopes: ['mail.read'], grants: ['mail.read'], credentials: { apiKey: secret } });
  assert.equal(forgedGrant.statusCode, 400);
  assert.equal((await fetch(`${baseUrl}/integrations`, { method: 'POST', headers: { authorization: 'Bearer test-integration-write', 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const oversized = await fetch(`${baseUrl}/integrations`, { method: 'POST', headers: { authorization: 'Bearer test-integration-write', 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }) });
  assert.equal(oversized.status, 413);

  const stored = await client.storeIntegrationCredentials({ connectorId: 'test-mail', providerAccountId: 'person@example.test', authMethod: 'api-key', scopes: ['mail.read'], credentials: { apiKey: secret } });
  assert.equal(stored.providerVerified, false);
  assert.equal(stored.executionAuthorized, false);
  assert.equal(stored.connection.status, 'credentials-stored-unverified');
  assert.deepEqual(writes[0].grants, []);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  const listed = await client.integrationReadiness();
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(JSON.stringify(listed).includes('person@example.test'), false);

  const removed = await client.removeIntegrationCredentials('connection-1');
  assert.equal(removed.localCredentialsRemoved, true);
  assert.equal(removed.providerGrantRevoked, false);
  assert.deepEqual(removals, ['connection-1']);
  const openApi = await client.openApi();
  assert.equal(openApi.paths['/integrations'].post.operationId, 'storeIntegrationCredentials');
  assert.equal(openApi.paths['/integrations/connections/{connectionId}'].delete.operationId, 'removeIntegrationCredentials');
});
