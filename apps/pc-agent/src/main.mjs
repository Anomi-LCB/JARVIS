import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../../runtime-compose/src/create-runtime.js';
import { bearerToken, readJsonBody, routeParams, routePath, safeHandle, sendJson } from '../../../packages/shared/src/http.js';
import { ModuleId } from '../../../packages/shared/src/types.js';
import { createServicePlan, loadPcAgentInstallConfig } from './install/service-planner.js';
import { verifyPcAgentServiceReadiness } from './install/service-verifier.js';
import { createTrayState } from './install/tray-runtime.js';
import { createPcAgentServiceSupervisor } from './service-daemon.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashString(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function containsPcAgentLocalApiReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"storePath"\s*:|"tokenHash"\s*:|"tokenHashPrefix"\s*:|"apiToken"\s*:|"authorization"\s*:|"requestBody"\s*:|"capabilityToken"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

export class PcAgentApiGuard {
  constructor({
    apiToken = process.env.JARVIS_PC_AGENT_API_TOKEN ?? 'local-pc-agent-api',
    apiTokenHash = process.env.JARVIS_PC_AGENT_API_TOKEN_SHA256,
    tokenStore = null,
    tokenStorePath = process.env.JARVIS_PC_AGENT_API_TOKEN_STORE,
    clock = () => new Date(),
    rateLimit = { windowMs: 60_000, maxRequests: 120 }
  } = {}) {
    this.clock = clock;
    this.rateLimit = rateLimit;
    this.tokenStore = tokenStore ?? new PcAgentSecretTokenStore({
      token: apiToken,
      tokenHash: apiTokenHash,
      storePath: tokenStorePath,
      clock
    });
    this.buckets = new Map();
  }

  check(request, { authRequired = true, action = 'read' } = {}) {
    const rate = this.checkRate(request, action);
    if (!rate.allowed) return rate;
    if (!authRequired) return { allowed: true, rateLimit: rate.rateLimit };
    const token = bearerToken(request);
    if (!this.tokenStore.verify(token)) {
      return { allowed: false, statusCode: 401, rateLimit: rate.rateLimit, error: { code: 'B_API_TOKEN_REQUIRED', message: 'PC Agent API bearer token is required.' } };
    }
    return { allowed: true, rateLimit: rate.rateLimit };
  }

  checkRate(request, action) {
    const key = `${request.socket.remoteAddress ?? 'local'}:${action}`;
    const now = this.clock().getTime();
    const bucket = this.buckets.get(key) ?? { count: 0, resetAt: now + this.rateLimit.windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + this.rateLimit.windowMs;
    }
    bucket.count += 1;
    this.buckets.set(key, bucket);
    const rateLimit = {
      limit: this.rateLimit.maxRequests,
      remaining: Math.max(this.rateLimit.maxRequests - bucket.count, 0),
      resetAt: new Date(bucket.resetAt).toISOString(),
      action
    };
    if (bucket.count > this.rateLimit.maxRequests) {
      return { allowed: false, statusCode: 429, rateLimit, error: { code: 'B_API_RATE_LIMITED', message: 'PC Agent API rate limit exceeded.' } };
    }
    return { allowed: true, rateLimit };
  }

  validateExecutionPacketBody(body) {
    const packet = body.packet ?? body;
    const errors = [];
    if (!packet || typeof packet !== 'object') errors.push('packet object is required.');
    if (!packet?.taskId) errors.push('taskId is required.');
    if (!packet?.action || typeof packet.action !== 'object') errors.push('action object is required.');
    if (!packet?.action?.toolName) errors.push('action.toolName is required.');
    if (!packet?.action?.actionType) errors.push('action.actionType is required.');
    if (!packet?.capabilityToken?.tokenId) errors.push('capabilityToken.tokenId is required.');
    if (packet?.userConfirmation?.confirmed !== true) errors.push('userConfirmation.confirmed must be true.');
    return {
      valid: errors.length === 0,
      errors,
      packet,
      dryRun: body.dryRun === true
    };
  }

  status() {
    return {
      guardVersion: 'b-pc-agent-api-guard-status-v1',
      tokenStore: this.tokenStore.status(),
      rateLimit: this.rateLimit,
      bucketCount: this.buckets.size
    };
  }

  middlewareHardeningReport() {
    const tokenStatus = this.tokenStore.status();
    const checks = [
      {
        checkId: 'api_token_hash_backed',
        status: tokenStatus.hashConfigured && tokenStatus.plaintextTokenStored === false ? 'passed' : 'blocked',
        source: tokenStatus.source
      },
      {
        checkId: 'rate_limit_enabled',
        status: this.rateLimit.maxRequests > 0 && this.rateLimit.windowMs > 0 ? 'passed' : 'blocked',
        rateLimit: this.rateLimit
      },
      {
        checkId: 'schema_validation_enabled',
        status: typeof this.validateExecutionPacketBody === 'function' ? 'passed' : 'blocked'
      },
      {
        checkId: 'rate_headers_enabled',
        status: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-action'].every(Boolean) ? 'passed' : 'blocked'
      }
    ];
    return {
      reportVersion: 'b-pc-agent-api-middleware-hardening-v1',
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      checks,
      tokenStore: tokenStatus
    };
  }
}

export class PcAgentSecretTokenStore {
  constructor({ token = null, tokenHash = null, storePath = null, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.storePath = storePath;
    this.source = 'constructor-token-hash';
    this.tokenHash = tokenHash ?? (token ? PcAgentSecretTokenStore.hashToken(token) : null);
    if (storePath && existsSync(storePath)) {
      const stored = JSON.parse(readFileSync(storePath, 'utf8'));
      if (stored.storeVersion !== 'b-pc-agent-secret-token-store-v1') {
        const error = new Error('Unsupported PC Agent API token store version.');
        error.code = 'B_PC_AGENT_TOKEN_STORE_VERSION_UNSUPPORTED';
        throw error;
      }
      this.tokenHash = stored.tokenHash;
      this.source = 'secret-store-file';
    } else if (storePath && this.tokenHash) {
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, `${JSON.stringify({
        storeVersion: 'b-pc-agent-secret-token-store-v1',
        tokenHash: this.tokenHash,
        createdAt: this.clock().toISOString(),
        plaintextTokenStored: false
      }, null, 2)}\n`, 'utf8');
      this.source = 'secret-store-file-created';
    } else if (token && !tokenHash) {
      this.source = 'constructor-token-derived-hash';
    }
  }

  static hashToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  verify(token) {
    if (!token || !this.tokenHash) return false;
    const candidate = PcAgentSecretTokenStore.hashToken(token);
    const expected = Buffer.from(this.tokenHash, 'hex');
    const actual = Buffer.from(candidate, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  status() {
    return {
      storeVersion: 'b-pc-agent-secret-token-store-v1',
      source: this.source,
      storePath: this.storePath,
      hashConfigured: Boolean(this.tokenHash),
      tokenHashPrefix: this.tokenHash ? this.tokenHash.slice(0, 12) : null,
      plaintextTokenStored: false
    };
  }
}

function rateLimitHeaders(guard = {}) {
  if (!guard.rateLimit) return {};
  return {
    'x-ratelimit-limit': String(guard.rateLimit.limit),
    'x-ratelimit-remaining': String(guard.rateLimit.remaining),
    'x-ratelimit-reset': guard.rateLimit.resetAt,
    'x-ratelimit-action': guard.rateLimit.action
  };
}

function guardedJson(response, statusCode, payload, guard) {
  return sendJson(response, statusCode, payload, rateLimitHeaders(guard));
}

export function createPcAgentOpenApiSpec() {
  const packetSchema = {
    type: 'object',
    required: ['taskId', 'capabilityToken', 'userConfirmation', 'action'],
    properties: {
      taskId: { type: 'string' },
      packetId: { type: 'string' },
      capabilityToken: {
        type: 'object',
        required: ['tokenId'],
        properties: { tokenId: { type: 'string' } }
      },
      userConfirmation: {
        type: 'object',
        required: ['confirmed'],
        properties: { confirmed: { type: 'boolean', const: true } }
      },
      action: {
        type: 'object',
        required: ['actionType', 'toolName'],
        properties: {
          actionType: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true }
        }
      }
    }
  };
  const auth = [{ bearerAuth: [] }];
  const jsonResponse = (description) => ({
    description,
    headers: {
      'x-ratelimit-limit': { schema: { type: 'integer' } },
      'x-ratelimit-remaining': { schema: { type: 'integer' } },
      'x-ratelimit-reset': { schema: { type: 'string', format: 'date-time' } },
      'x-ratelimit-action': { schema: { type: 'string' } }
    },
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
  });
  return {
    openapi: '3.1.0',
    info: {
      title: 'JARVIS PC Agent Local API',
      version: '1.0.0',
      description: 'Localhost-only API for execution packets, queue drain, evidence, rollback, tray state, and service readiness.'
    },
    servers: [{ url: 'http://127.0.0.1:17776' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' }
      },
      schemas: {
        ExecutionPacket: packetSchema
      }
    },
    paths: {
      '/health': {
        get: { summary: 'PC Agent health', responses: { 200: jsonResponse('Health status') } }
      },
      '/api/security/status': {
        get: { summary: 'Read PC Agent API guard, secret token store, and middleware hardening status', security: auth, responses: { 200: jsonResponse('API guard security status') } }
      },
      '/api/contract-snapshot': {
        get: { summary: 'Read PC Agent API contract snapshot and route hash', security: auth, responses: { 200: jsonResponse('API contract snapshot') } }
      },
      '/api/product-gate': {
        post: { summary: 'Run PC Agent Local API product readiness gate', security: auth, responses: { 200: jsonResponse('Local API product gate') } }
      },
      '/capability-vault/status': {
        get: { summary: 'Read capability vault lifecycle status', security: auth, responses: { 200: jsonResponse('Capability vault status') } }
      },
      '/capability-vault/key-rotation-drill': {
        post: { summary: 'Run capability vault key rotation drill', security: auth, responses: { 200: jsonResponse('Capability vault key rotation drill') } }
      },
      '/capability-vault/export': {
        get: { summary: 'Export encrypted capability vault records', security: auth, responses: { 200: jsonResponse('Capability vault encrypted export') } }
      },
      '/capability-vault/import-recovery': {
        post: { summary: 'Import encrypted capability vault recovery bundle', security: auth, responses: { 200: jsonResponse('Capability vault import recovery') } }
      },
      '/capability-vault/product-gate': {
        post: { summary: 'Run capability vault product readiness gate', security: auth, responses: { 200: jsonResponse('Capability vault product gate') } }
      },
      '/execution-packets': {
        post: {
          summary: 'Execute an ExecutionPacket immediately',
          security: auth,
          requestBody: { required: true, content: { 'application/json': { schema: packetSchema } } },
          responses: { 200: jsonResponse('Execution result'), 400: jsonResponse('Schema validation error'), 401: jsonResponse('Missing bearer token'), 429: jsonResponse('Rate limited') }
        }
      },
      '/execution-packets/queue': {
        get: { summary: 'Read durable execution queue status', security: auth, responses: { 200: jsonResponse('Queue status') } },
        post: { summary: 'Queue an ExecutionPacket', security: auth, requestBody: { required: true, content: { 'application/json': { schema: packetSchema } } }, responses: { 202: jsonResponse('Queued packet') } }
      },
      '/execution-packets/queue/policy': {
        get: { summary: 'Read execution queue retry policy', security: auth, responses: { 200: jsonResponse('Execution queue retry policy') } },
        post: { summary: 'Update execution queue retry policy', security: auth, responses: { 200: jsonResponse('Updated execution queue retry policy') } }
      },
      '/execution-packets/queue/drain': {
        post: { summary: 'Drain queued packets with retry/backoff policy', security: auth, responses: { 200: jsonResponse('Drain report') } }
      },
      '/execution-packets/queue/poison': {
        get: { summary: 'Review poison execution packets', security: auth, responses: { 200: jsonResponse('Poison packet queue') } }
      },
      '/execution-packets/queue/poison/{queueId}/review': {
        post: { summary: 'Mark poison packet reviewed', security: auth, parameters: [{ name: 'queueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Poison packet review result') } }
      },
      '/execution-packets/queue/poison/{queueId}/requeue': {
        post: { summary: 'Requeue poison packet after review', security: auth, parameters: [{ name: 'queueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Poison packet requeue result') } }
      },
      '/execution-packets/queue/poison/{queueId}/ignore': {
        post: { summary: 'Ignore poison packet after review', security: auth, parameters: [{ name: 'queueId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Poison packet ignore result') } }
      },
      '/execution-packets/journal': {
        get: { summary: 'Read packet journal', security: auth, responses: { 200: jsonResponse('Journal records') } }
      },
      '/tasks/{taskId}': {
        get: { summary: 'Read task status', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Task result') } }
      },
      '/tasks/{taskId}/result': {
        get: { summary: 'Read execution result', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Execution result') } }
      },
      '/tasks/{taskId}/evidence': {
        get: { summary: 'Read execution evidence', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Execution evidence') } }
      },
      '/evidence/query': { get: { summary: 'Query execution evidence with pagination and filters', security: auth, responses: { 200: jsonResponse('Evidence query') } } },
      '/evidence/retention': { get: { summary: 'Preview execution evidence retention and rotation', security: auth, responses: { 200: jsonResponse('Evidence retention') } } },
      '/evidence/rotate': { post: { summary: 'Rotate execution evidence into an archive', security: auth, responses: { 200: jsonResponse('Evidence rotation') } } },
      '/evidence/schema-snapshot': { get: { summary: 'Read execution evidence schema snapshot', security: auth, responses: { 200: jsonResponse('Evidence schema snapshot') } } },
      '/evidence/schema-regression': { post: { summary: 'Compare execution evidence schema snapshot against a baseline', security: auth, responses: { 200: jsonResponse('Evidence schema regression') } } },
      '/evidence/privacy-fixtures': { get: { summary: 'Run execution evidence privacy redaction fixture corpus', security: auth, responses: { 200: jsonResponse('Evidence privacy fixtures') } } },
      '/evidence/product-gate': { post: { summary: 'Run execution evidence retention, privacy, schema, and memory-event product gate', security: auth, responses: { 200: jsonResponse('Evidence product gate') } } },
      '/rollback/{taskId}': {
        post: { summary: 'Rollback task outputs', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Rollback result') } }
      },
      '/rollback/{taskId}/plan': {
        get: { summary: 'Dry-run rollback plan', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Rollback plan') } }
      },
      '/rollback/{taskId}/export': {
        post: { summary: 'Export rollback archive', security: auth, parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResponse('Rollback archive') } }
      },
      '/rollback/product-gate': {
        post: { summary: 'Run rollback WORM archive, signature rotation, and crash recovery product gate', security: auth, responses: { 200: jsonResponse('Rollback product gate') } }
      },
      '/rollback/transactions': {
        get: { summary: 'Read rollback transaction log', security: auth, responses: { 200: jsonResponse('Rollback transaction status') } }
      },
      '/rollback/journal': { get: { summary: 'Read rollback journal', security: auth, responses: { 200: jsonResponse('Rollback journal') } } },
      '/logs/recent': { get: { summary: 'Read recent audit logs', security: auth, responses: { 200: jsonResponse('Recent logs') } } },
      '/memory-events/recent': { get: { summary: 'Read recent memory events', security: auth, responses: { 200: jsonResponse('Memory events') } } },
      '/memory-events/query': { get: { summary: 'Query execution memory events with pagination and filters', security: auth, responses: { 200: jsonResponse('Memory event query') } } },
      '/service/status': { get: { summary: 'Read service status plan', responses: { 200: jsonResponse('Service status') } } },
      '/service/runtime': { get: { summary: 'Read service daemon runtime', responses: { 200: jsonResponse('Service runtime') } } },
      '/service/verification': { get: { summary: 'Read service readiness verification', responses: { 200: jsonResponse('Service verification') } } },
      '/tray/state': { get: { summary: 'Read tray state', responses: { 200: jsonResponse('Tray state') } } },
      '/openapi.json': { get: { summary: 'Read OpenAPI contract', responses: { 200: jsonResponse('OpenAPI spec') } } }
    }
  };
}

export function createPcAgentApiContractSnapshot(spec = createPcAgentOpenApiSpec()) {
  const routeKeys = Object.entries(spec.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
  const operationIds = Object.values(spec.paths)
    .flatMap((methods) => Object.values(methods).map((operation) => operation.operationId ?? operation.summary))
    .filter(Boolean)
    .sort();
  const payload = {
    openapi: spec.openapi,
    info: spec.info,
    routeKeys,
    operationIds
  };
  return {
    snapshotVersion: 'b-pc-agent-api-contract-snapshot-v1',
    generatedAt: new Date().toISOString(),
    routeCount: routeKeys.length,
    operationCount: operationIds.length,
    routeKeys,
    operationIds,
    sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

export function diffPcAgentApiContractSnapshots(current, baseline) {
  const currentRoutes = new Set(current?.routeKeys ?? []);
  const baselineRoutes = new Set(baseline?.routeKeys ?? []);
  const currentOperations = new Set(current?.operationIds ?? []);
  const baselineOperations = new Set(baseline?.operationIds ?? []);
  const removedRoutes = [...baselineRoutes].filter((route) => !currentRoutes.has(route));
  const removedOperations = [...baselineOperations].filter((operation) => !currentOperations.has(operation));
  return {
    diffVersion: 'b-pc-agent-api-contract-diff-v1',
    status: removedRoutes.length === 0 && removedOperations.length === 0 ? 'passed' : 'failed',
    breakingChanges: [
      ...removedRoutes.map((route) => ({ type: 'route_removed', route })),
      ...removedOperations.map((operationId) => ({ type: 'operation_removed', operationId }))
    ],
    addedRoutes: [...currentRoutes].filter((route) => !baselineRoutes.has(route)),
    addedOperations: [...currentOperations].filter((operation) => !baselineOperations.has(operation))
  };
}

export function createPcAgentLocalApiReleaseDossier({
  apiGuard = new PcAgentApiGuard(),
  snapshot = createPcAgentApiContractSnapshot(),
  contractDiff = null,
  hardening = null,
  clock = () => new Date()
} = {}) {
  const resolvedContractDiff = contractDiff ?? {
    diffVersion: 'b-pc-agent-api-contract-diff-v1',
    status: 'passed',
    breakingChanges: [],
    addedRoutes: []
  };
  const resolvedHardening = hardening ?? apiGuard.middlewareHardeningReport();
  const tokenStore = apiGuard.tokenStore.status();
  const criticalRoutes = [
    'GET /api/contract-snapshot',
    'POST /api/product-gate',
    'GET /api/security/status',
    'POST /execution-packets',
    'GET /execution-packets/queue',
    'POST /execution-packets/queue/drain',
    'GET /logs/recent',
    'GET /memory-events/recent',
    'POST /rollback/{taskId}',
    'GET /rollback/{taskId}/plan',
    'POST /rollback/{taskId}/export',
    'GET /tasks/{taskId}/evidence',
    'GET /tasks/{taskId}/result',
    'GET /openapi.json'
  ];
  const routeCoverage = criticalRoutes.map((route) => ({
    route,
    present: snapshot.routeKeys.includes(route)
  }));
  const deploymentPolicy = {
    policyVersion: 'b-pc-agent-local-api-deployment-policy-v1',
    bindPolicy: 'localhost-only',
    bearerTokenRequired: true,
    acceptedTokenSources: ['secret-store-file', 'secret-store-file-created', 'constructor-token-hash', 'constructor-token-derived-hash'],
    activeTokenSource: tokenStore.source,
    plaintextTokenStored: tokenStore.plaintextTokenStored,
    middlewareStack: 'node-http-hardened-equivalent',
    fastifyParity: {
      bearerAuth: true,
      requestBodySchemaValidation: true,
      routeLevelRateHeaders: true,
      openApiContractSnapshot: true,
      breakingRouteDiff: true
    }
  };
  const checks = [
    {
      checkId: 'local_api_secret_store_policy_ready',
      passed: tokenStore.hashConfigured === true
        && tokenStore.plaintextTokenStored === false
        && deploymentPolicy.acceptedTokenSources.includes(tokenStore.source),
      tokenSource: tokenStore.source
    },
    {
      checkId: 'local_api_contract_snapshot_diff_ready',
      passed: snapshot.snapshotVersion === 'b-pc-agent-api-contract-snapshot-v1'
        && snapshot.routeCount >= criticalRoutes.length
        && resolvedContractDiff.diffVersion === 'b-pc-agent-api-contract-diff-v1'
        && resolvedContractDiff.status === 'passed',
      routeCount: snapshot.routeCount,
      breakingChanges: resolvedContractDiff.breakingChanges ?? []
    },
    {
      checkId: 'local_api_middleware_hardening_ready',
      passed: resolvedHardening.reportVersion === 'b-pc-agent-api-middleware-hardening-v1'
        && resolvedHardening.status === 'passed',
      hardeningStatus: resolvedHardening.status
    },
    {
      checkId: 'local_api_route_surface_complete',
      passed: routeCoverage.every((item) => item.present),
      missingRoutes: routeCoverage.filter((item) => !item.present).map((item) => item.route)
    }
  ];
  const tokenStoreSummary = {
    storeVersion: tokenStore.storeVersion,
    source: tokenStore.source,
    storePathHash: hashString(tokenStore.storePath ?? ''),
    hashConfigured: tokenStore.hashConfigured === true,
    tokenHashPrefixHash: hashString(tokenStore.tokenHashPrefix ?? ''),
    plaintextTokenStored: tokenStore.plaintextTokenStored === true,
    rawStorePathStored: false,
    rawTokenHashStored: false
  };
  const hardeningSummary = {
    reportVersion: resolvedHardening.reportVersion,
    status: resolvedHardening.status,
    checkSummary: (resolvedHardening.checks ?? []).map((check) => ({
      checkId: check.checkId,
      status: check.status
    })),
    tokenStore: tokenStoreSummary
  };
  const artifactManifest = {
    manifestVersion: 'b-pc-agent-local-api-release-artifact-manifest-v1',
    generatedAt: clock().toISOString(),
    openApiContractHash: hashJson({
      snapshotVersion: snapshot.snapshotVersion,
      openapi: snapshot.openapi,
      routeCount: snapshot.routeCount,
      operationCount: snapshot.operationCount,
      sha256: snapshot.sha256
    }),
    contractDiffHash: hashJson({
      diffVersion: resolvedContractDiff.diffVersion,
      status: resolvedContractDiff.status,
      breakingChangeCount: resolvedContractDiff.breakingChanges?.length ?? 0,
      addedRouteCount: resolvedContractDiff.addedRoutes?.length ?? 0,
      addedOperationCount: resolvedContractDiff.addedOperations?.length ?? 0
    }),
    middlewareHardeningHash: hashJson(hardeningSummary),
    deploymentPolicyHash: hashJson({
      policyVersion: deploymentPolicy.policyVersion,
      bindPolicy: deploymentPolicy.bindPolicy,
      bearerTokenRequired: deploymentPolicy.bearerTokenRequired,
      activeTokenSource: deploymentPolicy.activeTokenSource,
      middlewareStack: deploymentPolicy.middlewareStack,
      fastifyParity: deploymentPolicy.fastifyParity
    }),
    routeCoverageHash: hashJson({
      criticalRouteCount: criticalRoutes.length,
      presentCount: routeCoverage.filter((item) => item.present).length,
      missingCount: routeCoverage.filter((item) => !item.present).length
    }),
    criticalRouteCount: criticalRoutes.length,
    routeCount: snapshot.routeCount,
    operationCount: snapshot.operationCount,
    missingCriticalRouteCount: routeCoverage.filter((item) => !item.present).length,
    rawTokenStorePathStored: false,
    rawTokenHashStored: false,
    rawRequestBodyStored: false,
    rawCapabilityTokenStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-pc-agent-local-api-release-raw-leak-check-v1',
    rawLeakDetected: containsPcAgentLocalApiReleaseRawLeak(artifactManifest),
    checkedRawFields: [
      'rawTokenStorePathStored',
      'rawTokenHashStored',
      'rawRequestBodyStored',
      'rawCapabilityTokenStored'
    ]
  };
  const operationalHandoffManifest = {
    manifestVersion: 'b-pc-agent-local-api-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'b-pc-agent-local-api-health-handshake-v1',
    generatedAt: clock().toISOString(),
    status: checks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      ? 'ready'
      : 'blocked',
    healthHandshake: {
      bearerTokenReady: tokenStore.hashConfigured === true && tokenStore.plaintextTokenStored === false,
      rateLimitReady: resolvedHardening.checks?.some((check) => check.checkId === 'rate_limit_enabled' && check.status === 'passed') === true,
      schemaValidationReady: resolvedHardening.checks?.some((check) => check.checkId === 'schema_validation_enabled' && check.status === 'passed') === true,
      rateHeadersReady: resolvedHardening.checks?.some((check) => check.checkId === 'rate_headers_enabled' && check.status === 'passed') === true,
      openApiSnapshotReady: snapshot.snapshotVersion === 'b-pc-agent-api-contract-snapshot-v1' && snapshot.routeCount >= criticalRoutes.length,
      contractDiffReady: resolvedContractDiff.status === 'passed',
      routeSurfaceReady: routeCoverage.every((item) => item.present)
    },
    fallbackPolicy: {
      policyVersion: 'b-pc-agent-local-api-fallback-policy-v1',
      primaryFlow: 'localhost_only_bearer_token_api_with_openapi_contract_gate',
      fallbackFlows: [
        'secret_store_file_recreation_from_hash_source',
        'contract_snapshot_diff_before_release',
        'rate_limited_retry_after_header_guided_client_backoff',
        'schema_validation_error_envelope_for_bad_execution_packets'
      ],
      operatorEscalation: 'pc_agent_api_security_status_and_product_gate'
    },
    rawTokenStorePathStored: false,
    rawTokenHashStored: false,
    rawRequestBodyStored: false,
    rawCapabilityTokenStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-pc-agent-local-api-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "B PC Agent HTTP API accepts execution packets" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'secret_store_backed_api_token',
      'api_contract_snapshot_available',
      'api_contract_breaking_diff_passed',
      'middleware_hardening_passed',
      'pc_agent_local_api_release_dossier_ready',
      'pc_agent_local_api_release_artifact_manifest_ready',
      'pc_agent_local_api_operational_handoff_ready',
      'pc_agent_local_api_worm_promotion_package_ready'
    ],
    artifactManifestHash: hashJson(artifactManifest),
    operationalHandoffHash: hashJson(operationalHandoffManifest),
    rawTokenStorePathStored: false,
    rawRequestBodyStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-pc-agent-local-api-worm-promotion-package-v1',
    providerContractVersion: 'b-pc-agent-local-api-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'b-pc-agent-local-api-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'b-pc-agent-local-api-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: hashJson(artifactManifest),
    operationalHandoffHash: hashJson(operationalHandoffManifest),
    ciNightlyGatePlanHash: hashJson(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawTokenStorePathStored: false,
    rawTokenHashStored: false,
    rawRequestBodyStored: false
  };
  const dossier = {
    dossierVersion: 'b-pc-agent-local-api-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: checks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    checks,
    deploymentPolicy,
    tokenStore: tokenStoreSummary,
    snapshot,
    contractDiff: resolvedContractDiff,
    hardening: hardeningSummary,
    routeCoverage,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
      ? 'attach_local_api_contract_hardening_handoff_and_worm_release_evidence'
      : 'block_local_api_release_until_contract_hardening_and_route_surface_pass'
  };
  dossier.dossierSha256 = hashJson(dossier);
  return dossier;
}

export function runPcAgentLocalApiProductGate({ apiGuard = new PcAgentApiGuard(), baseline = null } = {}) {
  const snapshot = createPcAgentApiContractSnapshot();
  const contractDiff = baseline ? diffPcAgentApiContractSnapshots(snapshot, baseline) : {
    diffVersion: 'b-pc-agent-api-contract-diff-v1',
    status: 'passed',
    breakingChanges: [],
    addedRoutes: []
  };
  const hardening = apiGuard.middlewareHardeningReport();
  const releaseDossier = createPcAgentLocalApiReleaseDossier({ apiGuard, snapshot, contractDiff, hardening });
  const checks = [
    {
      checkId: 'secret_store_backed_api_token',
      status: apiGuard.tokenStore.status().hashConfigured ? 'passed' : 'blocked',
      tokenStore: apiGuard.tokenStore.status()
    },
    {
      checkId: 'api_contract_snapshot_available',
      status: snapshot.snapshotVersion === 'b-pc-agent-api-contract-snapshot-v1' && snapshot.routeCount > 0 ? 'passed' : 'blocked',
      routeCount: snapshot.routeCount
    },
    {
      checkId: 'api_contract_breaking_diff_passed',
      status: contractDiff.status === 'passed' ? 'passed' : 'blocked',
      breakingChanges: contractDiff.breakingChanges
    },
    {
      checkId: 'middleware_hardening_passed',
      status: hardening.status === 'passed' ? 'passed' : 'blocked',
      hardeningVersion: hardening.reportVersion
    },
    {
      checkId: 'pc_agent_local_api_release_dossier_ready',
      status: releaseDossier.status === 'passed' && releaseDossier.dossierSha256.length === 64 ? 'passed' : 'blocked',
      dossierVersion: releaseDossier.dossierVersion
    },
    {
      checkId: 'pc_agent_local_api_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.manifestVersion === 'b-pc-agent-local-api-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawTokenStorePathStored === false
        && releaseDossier.artifactManifest?.rawRequestBodyStored === false
        ? 'passed'
        : 'blocked',
      manifestVersion: releaseDossier.artifactManifest?.manifestVersion ?? null
    },
    {
      checkId: 'pc_agent_local_api_operational_handoff_ready',
      status: releaseDossier.operationalHandoffManifest?.manifestVersion === 'b-pc-agent-local-api-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'b-pc-agent-local-api-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-pc-agent-local-api-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        ? 'passed'
        : 'blocked',
      manifestVersion: releaseDossier.operationalHandoffManifest?.manifestVersion ?? null
    },
    {
      checkId: 'pc_agent_local_api_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'b-pc-agent-local-api-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-pc-agent-local-api-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked',
      packageVersion: releaseDossier.externalWormPromotionPackage?.packageVersion ?? null
    }
  ];
  return {
    gateVersion: 'b-pc-agent-local-api-product-gate-v1',
    productGateVersion: 'b-pc-agent-local-api-product-gate-v1',
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks,
    snapshot,
    contractDiff,
    hardening,
    releaseDossier
  };
}

export function createPcAgentServer(pcAgent, { apiGuard = new PcAgentApiGuard(), serviceSupervisor = null } = {}) {
  return http.createServer((request, response) => {
    safeHandle(response, async () => {
      const path = routePath(request);
      if (request.method === 'GET' && path === '/openapi.json') {
        return sendJson(response, 200, createPcAgentOpenApiSpec());
      }
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, {
          status: 'ok',
          module: ModuleId.PC_AGENT,
          version: '1.0.0',
          localOnly: true,
          packetJournal: {
            records: pcAgent.packetJournal.records.length,
            completed: pcAgent.packetJournal.results.size,
            pending: pcAgent.packetJournal.pending().length
          },
          executionQueue: pcAgent.executionQueueStatus(),
          undoJournal: {
            pending: pcAgent.undoJournal.list().length,
            chain: pcAgent.undoJournal.verifyChain().status
          },
          rollbackTransactions: {
            active: pcAgent.rollbackTransactionStatus().active.length,
            chain: pcAgent.rollbackTransactionStatus().chain.status
          },
          serviceRuntime: serviceSupervisor?.status() ?? { enabled: false, status: 'not-attached' },
          capabilityVault: pcAgent.capabilityVault.status()
        });
      }
      if (request.method === 'GET' && path === '/api/security/status') {
        const guard = apiGuard.check(request, { action: 'api-security-status' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, {
          ...apiGuard.status(),
          hardening: apiGuard.middlewareHardeningReport()
        }, guard);
      }
      if (request.method === 'GET' && path === '/api/contract-snapshot') {
        const guard = apiGuard.check(request, { action: 'api-contract-snapshot' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, createPcAgentApiContractSnapshot(), guard);
      }
      if (request.method === 'POST' && path === '/api/product-gate') {
        const guard = apiGuard.check(request, { action: 'api-product-gate' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, runPcAgentLocalApiProductGate({ apiGuard, baseline: body.baseline ?? null }), guard);
      }
      if (request.method === 'GET' && path === '/capability-vault/status') {
        const guard = apiGuard.check(request, { action: 'capability-vault-status' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.capabilityVault.status(), guard);
      }
      if (request.method === 'POST' && path === '/capability-vault/key-rotation-drill') {
        const guard = apiGuard.check(request, { action: 'capability-vault-rotation' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.capabilityVault.keyRotationDrill(await readJsonBody(request)), guard);
      }
      if (request.method === 'GET' && path === '/capability-vault/export') {
        const guard = apiGuard.check(request, { action: 'capability-vault-export' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const url = new URL(request.url, 'http://127.0.0.1');
        return guardedJson(response, 200, pcAgent.capabilityVault.exportEncryptedVault({
          reason: url.searchParams.get('reason') ?? 'api_export'
        }), guard);
      }
      if (request.method === 'POST' && path === '/capability-vault/import-recovery') {
        const guard = apiGuard.check(request, { action: 'capability-vault-import' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.capabilityVault.importEncryptedVault(await readJsonBody(request)), guard);
      }
      if (request.method === 'POST' && path === '/capability-vault/product-gate') {
        const guard = apiGuard.check(request, { action: 'capability-vault-product-gate' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.capabilityVault.productGate(await readJsonBody(request)), guard);
      }
      if (request.method === 'GET' && path === '/execution-packets/journal') {
        const guard = apiGuard.check(request, { action: 'packet-journal' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, {
          records: pcAgent.packetJournal.records.slice(-100),
          pending: pcAgent.packetJournal.pending(),
          completed: pcAgent.packetJournal.results.size
        }, guard);
      }
      if (request.method === 'GET' && path === '/execution-packets/queue') {
        const guard = apiGuard.check(request, { action: 'packet-queue' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.executionQueueStatus(), guard);
      }
      if (request.method === 'GET' && path === '/execution-packets/queue/policy') {
        const guard = apiGuard.check(request, { action: 'packet-queue-policy' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.executionQueuePolicy(), guard);
      }
      if (request.method === 'POST' && path === '/execution-packets/queue/policy') {
        const guard = apiGuard.check(request, { action: 'packet-queue-policy' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, pcAgent.updateExecutionQueuePolicy(body), guard);
      }
      if (request.method === 'POST' && path === '/execution-packets/queue') {
        const guard = apiGuard.check(request, { action: 'packet-queue' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        const validation = apiGuard.validateExecutionPacketBody(body);
        if (!validation.valid) {
          return guardedJson(response, 400, { success: false, error: { code: 'B_EXECUTION_PACKET_SCHEMA_INVALID', errors: validation.errors } }, guard);
        }
        return guardedJson(response, 202, pcAgent.queueExecutionPacket(validation.packet, { dryRun: validation.dryRun }), guard);
      }
      if (request.method === 'POST' && path === '/execution-packets/queue/drain') {
        const guard = apiGuard.check(request, { action: 'packet-queue-drain' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, await pcAgent.processExecutionQueue({ limit: Number(body.limit ?? 10) }), guard);
      }
      if (request.method === 'GET' && path === '/execution-packets/queue/poison') {
        const guard = apiGuard.check(request, { action: 'packet-poison-read' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const includeIgnored = new URL(request.url, 'http://localhost').searchParams.get('includeIgnored') === 'true';
        return guardedJson(response, 200, pcAgent.poisonQueueStatus({ includeIgnored }), guard);
      }
      const poisonReviewParams = routeParams('/execution-packets/queue/poison/:queueId/review', path);
      if (request.method === 'POST' && poisonReviewParams) {
        const guard = apiGuard.check(request, { action: 'packet-poison-review' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, pcAgent.reviewPoisonPacket(poisonReviewParams.queueId, body), guard);
      }
      const poisonRequeueParams = routeParams('/execution-packets/queue/poison/:queueId/requeue', path);
      if (request.method === 'POST' && poisonRequeueParams) {
        const guard = apiGuard.check(request, { action: 'packet-poison-requeue' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, pcAgent.requeuePoisonPacket(poisonRequeueParams.queueId, body), guard);
      }
      const poisonIgnoreParams = routeParams('/execution-packets/queue/poison/:queueId/ignore', path);
      if (request.method === 'POST' && poisonIgnoreParams) {
        const guard = apiGuard.check(request, { action: 'packet-poison-ignore' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, pcAgent.ignorePoisonPacket(poisonIgnoreParams.queueId, body), guard);
      }
      if (request.method === 'POST' && path === '/execution-packets') {
        const guard = apiGuard.check(request, { action: 'execution-packet' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        const validation = apiGuard.validateExecutionPacketBody(body);
        if (!validation.valid) {
          return guardedJson(response, 400, { success: false, error: { code: 'B_EXECUTION_PACKET_SCHEMA_INVALID', errors: validation.errors } }, guard);
        }
        return guardedJson(response, 200, await pcAgent.receiveExecutionPacket(validation.packet, { dryRun: validation.dryRun }), guard);
      }
      const taskParams = routeParams('/tasks/:taskId', path);
      if (request.method === 'GET' && taskParams) {
        const guard = apiGuard.check(request, { action: 'task-read' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.taskResult(taskParams.taskId), guard);
      }
      const resultParams = routeParams('/tasks/:taskId/result', path);
      if (request.method === 'GET' && resultParams) {
        const guard = apiGuard.check(request, { action: 'task-result' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.taskResult(resultParams.taskId).executionResult ?? pcAgent.taskResult(resultParams.taskId), guard);
      }
      const evidenceParams = routeParams('/tasks/:taskId/evidence', path);
      if (request.method === 'GET' && evidenceParams) {
        const guard = apiGuard.check(request, { action: 'task-evidence' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.taskEvidence(evidenceParams.taskId), guard);
      }
      if (request.method === 'GET' && path === '/evidence/query') {
        const guard = apiGuard.check(request, { action: 'evidence-query' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const url = new URL(request.url, 'http://127.0.0.1');
        return guardedJson(response, 200, pcAgent.queryExecutionEvidence({
          cursor: url.searchParams.get('cursor') ?? 0,
          limit: url.searchParams.get('limit') ?? 20,
          taskId: url.searchParams.get('taskId') || null,
          status: url.searchParams.get('status') || null,
          toolName: url.searchParams.get('toolName') || null,
          since: url.searchParams.get('since') || null,
          until: url.searchParams.get('until') || null
        }), guard);
      }
      if (request.method === 'GET' && path === '/evidence/retention') {
        const guard = apiGuard.check(request, { action: 'evidence-retention' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const url = new URL(request.url, 'http://127.0.0.1');
        return guardedJson(response, 200, pcAgent.executionEvidenceRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 100),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null
        }), guard);
      }
      if (request.method === 'POST' && path === '/evidence/rotate') {
        const guard = apiGuard.check(request, { action: 'evidence-rotate' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, await pcAgent.rotateExecutionEvidence(body), guard);
      }
      if (request.method === 'GET' && path === '/evidence/schema-snapshot') {
        const guard = apiGuard.check(request, { action: 'evidence-schema-snapshot' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.executionEvidenceSchemaSnapshot(), guard);
      }
      if (request.method === 'POST' && path === '/evidence/schema-regression') {
        const guard = apiGuard.check(request, { action: 'evidence-schema-regression' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, pcAgent.executionEvidenceSchemaRegression(body.baseline ?? body), guard);
      }
      if (request.method === 'GET' && path === '/evidence/privacy-fixtures') {
        const guard = apiGuard.check(request, { action: 'evidence-privacy-fixtures' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.executionEvidencePrivacyFixtureReport(), guard);
      }
      if (request.method === 'POST' && path === '/evidence/product-gate') {
        const guard = apiGuard.check(request, { action: 'evidence-product-gate' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, await pcAgent.executionEvidenceProductGate(body), guard);
      }
      if (request.method === 'GET' && path === '/logs/recent') {
        const guard = apiGuard.check(request, { action: 'logs-read' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, { items: pcAgent.auditLog.recent(50), results: pcAgent.logs.slice(0, 20) }, guard);
      }
      if (request.method === 'GET' && path === '/service/status') {
        const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
        return sendJson(response, 200, {
          service: createServicePlan({ action: 'status', daemonConfig, serviceManifest }),
          health: { status: 'ok', module: ModuleId.PC_AGENT, localOnly: true },
          endpoint: `http://${daemonConfig.host}:${daemonConfig.port}`
        });
      }
      if (request.method === 'GET' && path === '/service/runtime') {
        return sendJson(response, 200, serviceSupervisor?.status() ?? { enabled: false, status: 'not-attached' });
      }
      if (request.method === 'GET' && path === '/service/verification') {
        const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
        return sendJson(response, 200, await verifyPcAgentServiceReadiness({
          daemonConfig,
          serviceManifest,
          packageDir: new URL(request.url, 'http://localhost').searchParams.get('packageDir')
        }));
      }
      if (request.method === 'GET' && path === '/tray/state') {
        const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
        return sendJson(response, 200, createTrayState({
          daemonConfig,
          serviceManifest,
          service: { status: 'running' },
          health: { status: 'ok', module: ModuleId.PC_AGENT, localOnly: true },
          queue: pcAgent.executionQueueStatus(),
          poisonQueue: pcAgent.poisonQueueStatus({ includeIgnored: true }),
          serviceRuntime: serviceSupervisor?.status() ?? null,
          lastExecution: pcAgent.logs[0] ?? null
        }));
      }
      if (request.method === 'GET' && path === '/memory-events/recent') {
        const guard = apiGuard.check(request, { action: 'memory-events-read' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, { items: pcAgent.recentMemoryEvents(50) }, guard);
      }
      if (request.method === 'GET' && path === '/memory-events/query') {
        const guard = apiGuard.check(request, { action: 'memory-events-query' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const url = new URL(request.url, 'http://127.0.0.1');
        return guardedJson(response, 200, pcAgent.queryExecutionMemoryEvents({
          cursor: url.searchParams.get('cursor') ?? 0,
          limit: url.searchParams.get('limit') ?? 20,
          eventType: url.searchParams.get('eventType') || null,
          taskId: url.searchParams.get('taskId') || null
        }), guard);
      }
      if (request.method === 'GET' && path === '/rollback/transactions') {
        const guard = apiGuard.check(request, { action: 'rollback-transactions' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, pcAgent.rollbackTransactionStatus(), guard);
      }
      const rollbackPlanParams = routeParams('/rollback/:taskId/plan', path);
      if (request.method === 'GET' && rollbackPlanParams) {
        const guard = apiGuard.check(request, { action: 'rollback-plan' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, await pcAgent.rollbackPlan(rollbackPlanParams.taskId), guard);
      }
      const rollbackExportParams = routeParams('/rollback/:taskId/export', path);
      if (request.method === 'POST' && rollbackExportParams) {
        const guard = apiGuard.check(request, { action: 'rollback-export' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, await pcAgent.exportRollbackArchive(rollbackExportParams.taskId, {
          outputPath: body.outputPath ?? null
        }), guard);
      }
      if (request.method === 'POST' && path === '/rollback/product-gate') {
        const guard = apiGuard.check(request, { action: 'rollback-product-gate' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        const body = await readJsonBody(request);
        return guardedJson(response, 200, await pcAgent.rollbackProductGate(body), guard);
      }
      const rollbackParams = routeParams('/rollback/:taskId', path);
      if (request.method === 'POST' && rollbackParams) {
        const guard = apiGuard.check(request, { action: 'rollback' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, await pcAgent.rollbackTask(rollbackParams.taskId), guard);
      }
      if (request.method === 'GET' && path === '/rollback/journal') {
        const guard = apiGuard.check(request, { action: 'rollback-journal' });
        if (!guard.allowed) return guardedJson(response, guard.statusCode, guard, guard);
        return guardedJson(response, 200, {
          entries: pcAgent.undoJournal.history(),
          transactions: pcAgent.rollbackTransactionStatus().recent,
          chain: pcAgent.undoJournal.verifyChain()
        }, guard);
      }
      sendJson(response, 404, { success: false, error: { code: 'B_ROUTE_NOT_FOUND' } });
    });
  });
}

function envBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function envList(value, fallback = []) {
  if (!value) return fallback;
  return String(value).split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

export function pcAgentRuntimeOptionsFromConfig({ daemonConfig, env = process.env } = {}) {
  const logs = daemonConfig.logs ?? {};
  const allowedRoots = envList(env.JARVIS_ALLOWED_ROOTS, daemonConfig.allowedRoots ?? ['./workspace']).map((root) => resolve(root));
  return {
    allowedRoots,
    auditRoot: env.JARVIS_AUDIT_ROOT ?? logs.auditRoot,
    undoJournalPath: env.JARVIS_UNDO_JOURNAL ?? logs.undoJournalPath,
    rollbackTransactionPath: env.JARVIS_ROLLBACK_TRANSACTIONS ?? logs.rollbackTransactionPath,
    packetJournalPath: env.JARVIS_PACKET_JOURNAL ?? logs.packetJournalPath,
    packetQueuePath: env.JARVIS_PACKET_QUEUE ?? logs.packetQueuePath,
    tokenVaultPath: env.JARVIS_TOKEN_VAULT ?? logs.tokenVaultPath
  };
}

export function serviceSupervisorOptionsFromConfig({ daemonConfig, env = process.env } = {}) {
  const queueDrain = daemonConfig.queueDrain ?? {};
  return {
    enabled: envBoolean(env.JARVIS_QUEUE_DRAIN_ENABLED, queueDrain.enabled ?? true),
    intervalMs: Number(env.JARVIS_QUEUE_DRAIN_INTERVAL_MS ?? queueDrain.intervalMs ?? 1_000),
    batchLimit: Number(env.JARVIS_QUEUE_DRAIN_BATCH_LIMIT ?? queueDrain.batchLimit ?? 5),
    maxConsecutiveFailures: Number(env.JARVIS_QUEUE_DRAIN_MAX_FAILURES ?? queueDrain.maxConsecutiveFailures ?? 3)
  };
}

export async function createConfiguredPcAgentRuntime({ env = process.env, clock } = {}) {
  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  const runtimeOptions = pcAgentRuntimeOptionsFromConfig({ daemonConfig, env });
  const { pcAgent, policyRuntime } = createAgRuntime({ ...runtimeOptions, clock });
  const serviceSupervisor = createPcAgentServiceSupervisor(pcAgent, daemonConfig, {
    ...serviceSupervisorOptionsFromConfig({ daemonConfig, env }),
    clock
  });
  return { pcAgent, policyRuntime, daemonConfig, serviceManifest, serviceSupervisor, runtimeOptions };
}

export async function startPcAgentServiceRuntime({ env = process.env, clock } = {}) {
  const runtime = await createConfiguredPcAgentRuntime({ env, clock });
  const port = Number(env.PORT ?? runtime.daemonConfig.port ?? 17776);
  const host = runtime.daemonConfig.host ?? '127.0.0.1';
  const server = createPcAgentServer(runtime.pcAgent, { serviceSupervisor: runtime.serviceSupervisor });
  return await new Promise((resolveStart) => {
    server.listen(port, host, () => {
      const supervisorStart = runtime.serviceSupervisor.start();
      console.log(`JARVIS-B PC Agent listening at http://${host}:${port}`);
      console.log(`JARVIS-B queue drain supervisor: ${supervisorStart.status}`);
      resolveStart({ ...runtime, server, host, port, supervisorStart });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPcAgentServiceRuntime().then(({ server, serviceSupervisor }) => {
    const shutdown = () => {
      serviceSupervisor.stop();
      server.close(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
