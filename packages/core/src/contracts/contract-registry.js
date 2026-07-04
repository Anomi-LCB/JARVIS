import { createHash } from 'node:crypto';

export class ContractRegistry {
  constructor() {
    this.contracts = new Map();
  }

  register(name, contract) {
    if (!contract || typeof contract.validate !== 'function') {
      throw new Error(`Contract ${name} must expose validate(value)`);
    }
    this.contracts.set(name, contract);
  }

  validate(name, value) {
    const contract = this.contracts.get(name);
    if (!contract) {
      throw new Error(`Unknown contract: ${name}`);
    }
    return contract.validate(value);
  }

  assert(name, value) {
    const result = this.validate(name, value);
    if (!result.valid) {
      const error = new Error(`${name} contract failed: ${result.errors.join(' | ')}`);
      error.code = 'A_CONTRACT_INVALID';
      error.contract = name;
      error.errors = result.errors;
      throw error;
    }
    return value;
  }

  schema(name) {
    const contract = this.contracts.get(name);
    if (!contract) {
      throw new Error(`Unknown contract: ${name}`);
    }
    return contract.schema ?? null;
  }

  schemas() {
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://jarvis.local/schemas/a-core-contracts.schema.json',
      title: 'JARVIS A Core Contracts',
      definitions: Object.fromEntries(
        [...this.contracts.entries()]
          .filter(([, contract]) => contract.schema)
          .map(([name, contract]) => [name, contract.schema])
      )
    };
  }

  compatibilityReport(samples = {}) {
    const items = [...this.contracts.keys()].map((name) => {
      const sample = samples[name];
      const validation = sample ? this.validate(name, sample) : { valid: null, errors: ['sample-not-provided'] };
      return {
        name,
        hasJsonSchema: Boolean(this.schema(name)),
        sampleProvided: Boolean(sample),
        sampleValid: validation.valid,
        errors: validation.errors
      };
    });
    return {
      status: items.every((item) => item.hasJsonSchema && item.sampleValid !== false) ? 'passed' : 'needs_samples_or_schema',
      schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      items
    };
  }

  federatedOpenApiBundle({ modules = [], generatedAt = new Date().toISOString() } = {}) {
    const normalizedModules = modules.map((module) => normalizeOpenApiModule(module));
    const routes = normalizedModules.flatMap((module) => module.routes);
    const schemaSnapshot = this.schemaSnapshot({ generatedAt });
    const bundle = {
      bundleVersion: 'a-federated-openapi-contract-bundle-v1',
      generatedAt,
      schemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
      moduleCount: normalizedModules.length,
      routeCount: routes.length,
      schemaSnapshot,
      modules: normalizedModules,
      routes,
      coverage: {
        modulesWithOpenApi: normalizedModules.filter((module) => module.openapi === '3.1.0').map((module) => module.moduleId),
        missingOpenApi: normalizedModules.filter((module) => module.openapi !== '3.1.0').map((module) => module.moduleId),
        modulesWithSchemas: normalizedModules.filter((module) => module.schemaCount > 0).map((module) => module.moduleId)
      }
    };
    return {
      ...bundle,
      snapshotHash: `sha256:${sha256Hex(canonicalJson({
        modules: bundle.modules,
        routes: bundle.routes,
        schemas: bundle.schemaSnapshot.schemaNames
      }))}`
    };
  }

  federatedOpenApiTypeDeclarations(bundle, { generatedAt = new Date().toISOString() } = {}) {
    return createFederatedOpenApiTypeDeclarations(bundle, { generatedAt });
  }

  federatedOpenApiBreakingChangePolicy(bundle, options = {}) {
    return createFederatedOpenApiBreakingChangePolicy(bundle, options);
  }

  federatedOpenApiContractGate({ baselineBundle, currentBundle, generatedTypesText = null, allowBreakingByModule = {}, generatedAt = new Date().toISOString() } = {}) {
    return runFederatedOpenApiContractGate({
      baselineBundle,
      currentBundle,
      generatedTypesText,
      allowBreakingByModule,
      generatedAt
    });
  }

  schemaSnapshot({ generatedAt = new Date().toISOString() } = {}) {
    const schemas = this.schemas();
    const schemaNames = Object.keys(schemas.definitions).sort();
    return {
      snapshotVersion: 'a-contract-schema-snapshot-v1',
      generatedAt,
      schemaDialect: schemas.$schema,
      schemaCount: schemaNames.length,
      schemaNames,
      snapshotHash: `sha256:${sha256Hex(canonicalJson(schemaNames.map((name) => [name, schemas.definitions[name]])))}`
    };
  }
}

function normalizeOpenApiModule({ moduleId, name = moduleId, spec = null } = {}) {
  const paths = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {};
  const routes = Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods)
    .filter(([, operation]) => operation && typeof operation === 'object')
    .map(([method, operation]) => ({
      moduleId,
      path,
      method: method.toUpperCase(),
      operationId: operation.operationId ?? null,
      summary: operation.summary ?? null,
      requestBody: Boolean(operation.requestBody),
      responseCodes: Object.keys(operation.responses ?? {})
    })));
  const schemaCount = Object.keys(spec?.components?.schemas ?? {}).length;
  return {
    moduleId,
    name,
    title: spec?.info?.title ?? name,
    openapi: spec?.openapi ?? null,
    routeCount: routes.length,
    schemaCount,
    routes
  };
}

export function createFederatedOpenApiTypeDeclarations(bundle, { generatedAt = new Date().toISOString() } = {}) {
  const routes = [...(bundle?.routes ?? [])].sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
  const modules = [...new Set(routes.map((route) => route.moduleId))].sort();
  const moduleUnion = modules.map((moduleId) => `  | ${JSON.stringify(moduleId)}`).join('\n') || '  | never';
  const routeUnion = routes.map((route) => `  | ${JSON.stringify(routeKey(route))}`).join('\n') || '  | never';
  const operationMap = routes.map((route) => {
    const key = routeKey(route);
    return `  ${JSON.stringify(key)}: { moduleId: ${JSON.stringify(route.moduleId)}; method: ${JSON.stringify(route.method)}; path: ${JSON.stringify(route.path)}; operationId: ${JSON.stringify(route.operationId)}; responseCodes: ${JSON.stringify(route.responseCodes)}; };`;
  }).join('\n');
  return [
    '// Generated from ContractRegistry.federatedOpenApiBundle',
    '// a-federated-openapi-client-types-v1',
    `// generatedAt ${generatedAt}`,
    `export const federatedOpenApiBundleHash = ${JSON.stringify(bundle?.snapshotHash ?? null)};`,
    `export const federatedOpenApiBundleVersion = ${JSON.stringify(bundle?.bundleVersion ?? null)};`,
    'export type FederatedOpenApiModuleId =',
    `${moduleUnion};`,
    'export type FederatedOpenApiRouteKey =',
    `${routeUnion};`,
    'export interface FederatedOpenApiOperationMap {',
    operationMap,
    '}',
    'export type FederatedOpenApiOperation<Route extends FederatedOpenApiRouteKey> = FederatedOpenApiOperationMap[Route];',
    'export interface FederatedCoreClientContract {',
    '  readonly clientName: "CoreClient";',
    '  readonly bundleHash: typeof federatedOpenApiBundleHash;',
    '  request<Route extends FederatedOpenApiRouteKey>(route: Route): Promise<unknown>;',
    '}',
    ''
  ].join('\n');
}

export function createFederatedOpenApiBreakingChangePolicy(bundle, {
  strictModules = [],
  generatedAt = new Date().toISOString()
} = {}) {
  const strict = new Set(strictModules);
  const modules = (bundle?.modules ?? []).map((module) => ({
    moduleId: module.moduleId,
    routeCount: module.routeCount,
    schemaCount: module.schemaCount,
    breakingChangePolicy: strict.has(module.moduleId) ? 'approval_required_strict' : 'approval_required',
    removedRouteRequiresApproval: true,
    responseSchemaChangeRequiresApproval: true,
    securityChangeRequiresApproval: true,
    additiveRouteAllowed: true
  }));
  return {
    policyVersion: 'a-federated-openapi-module-breaking-policy-v1',
    generatedAt,
    bundleHash: bundle?.snapshotHash ?? null,
    moduleCount: modules.length,
    modules
  };
}

export function runFederatedOpenApiContractGate({
  baselineBundle,
  currentBundle,
  generatedTypesText = null,
  allowBreakingByModule = {},
  generatedAt = new Date().toISOString()
} = {}) {
  const diff = diffFederatedOpenApiBundles(baselineBundle, currentBundle, { generatedAt });
  const policy = createFederatedOpenApiBreakingChangePolicy(currentBundle, { generatedAt });
  const generatedHash = extractFederatedGeneratedHash(generatedTypesText);
  const expectedHash = currentBundle?.snapshotHash ?? null;
  const generatedTypesVersion = generatedTypesText?.includes('a-federated-openapi-client-types-v1')
    ? 'a-federated-openapi-client-types-v1'
    : null;
  const unapprovedBreaking = diff.breakingChanges.filter((change) => allowBreakingByModule[change.moduleId] !== true);
  const checks = [
    { checkId: 'federated_bundle_present', passed: currentBundle?.bundleVersion === 'a-federated-openapi-contract-bundle-v1' },
    { checkId: 'federated_generated_types_current', passed: generatedTypesVersion === 'a-federated-openapi-client-types-v1' && generatedHash === expectedHash },
    { checkId: 'federated_module_breaking_policy_present', passed: policy.policyVersion === 'a-federated-openapi-module-breaking-policy-v1' && policy.moduleCount === (currentBundle?.moduleCount ?? 0) },
    { checkId: 'federated_breaking_changes_approved', passed: unapprovedBreaking.length === 0 }
  ];
  return {
    gateVersion: 'a-federated-openapi-contract-gate-v1',
    generatedAt,
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    expectedHash,
    generatedHash,
    generatedTypesVersion,
    diff,
    policy,
    unapprovedBreaking,
    checks
  };
}

export function diffFederatedOpenApiBundles(previousBundle, nextBundle, { generatedAt = new Date().toISOString() } = {}) {
  const previousRoutes = new Map((previousBundle?.routes ?? []).map((route) => [routeKey(route), route]));
  const nextRoutes = new Map((nextBundle?.routes ?? []).map((route) => [routeKey(route), route]));
  const addedRoutes = [];
  const removedRoutes = [];
  for (const [key, route] of previousRoutes) {
    if (!nextRoutes.has(key)) removedRoutes.push({ key, ...route });
  }
  for (const [key, route] of nextRoutes) {
    if (!previousRoutes.has(key)) addedRoutes.push({ key, ...route });
  }
  const breakingChanges = removedRoutes.map((route) => ({
    type: 'route_removed',
    moduleId: route.moduleId,
    key: route.key,
    route
  }));
  return {
    diffVersion: 'a-federated-openapi-contract-diff-v1',
    generatedAt,
    status: breakingChanges.length ? 'breaking-change' : 'compatible',
    previousHash: previousBundle?.snapshotHash ?? null,
    nextHash: nextBundle?.snapshotHash ?? null,
    addedRoutes,
    removedRoutes,
    breakingChanges
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortDeep(item)])
  );
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function routeKey(route) {
  return `${route.moduleId}:${route.method}:${route.path}`;
}

function extractFederatedGeneratedHash(text) {
  const match = /federatedOpenApiBundleHash\s*=\s*["']([^"']+)["']/.exec(String(text ?? ''));
  return match?.[1] ?? null;
}
