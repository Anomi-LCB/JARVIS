import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGrowthMemoryOpenApiSpec } from '../apps/growth-memory/src/main.mjs';
import { createBridgeOpenApiSpec } from '../apps/bridge/src/request-validator.js';
import { createPcAgentOpenApiSpec } from '../apps/pc-agent/src/main.mjs';
import { createPolicySecurityOpenApiSpec } from '../apps/policy-security/src/main.mjs';
import { createVerificationOpenApiSpec } from '../apps/verification/src/main.mjs';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreOpenApiSpec } from '../packages/core/src/main.mjs';
import { ModuleId } from '../packages/shared/src/types.js';

export const federatedOpenApiContractGateVersion = 'a-federated-openapi-contract-gate-report-v1';

export async function runFederatedOpenApiContractGate({
  jsonPath = 'dist/federated-openapi-contract-gate-report.json',
  markdownPath = 'dist/federated-openapi-contract-gate-report.md',
  csvPath = 'dist/federated-openapi-contract-gate-report.csv',
  bundlePath = 'dist/federated-openapi-contract-bundle.json',
  generatedTypesPath = 'packages/core/src/client/generated/federated-openapi-types.d.ts',
  baselinePath = 'dist/federated-openapi-contract-baseline.json',
  writeBaseline = false,
  allowBreakingByModule = {},
  generatedAt = new Date().toISOString()
} = {}) {
  const { coreFacade } = createAgRuntime();
  const modules = createFederatedOpenApiModules({ coreFacade });
  const registry = coreFacade.contractRegistry;
  const currentBundle = registry.federatedOpenApiBundle({ modules, generatedAt });
  const generatedTypesText = registry.federatedOpenApiTypeDeclarations(currentBundle, { generatedAt });
  const baselineBundle = await readJsonIfExists(baselinePath) ?? currentBundle;
  const gate = registry.federatedOpenApiContractGate({
    baselineBundle,
    currentBundle,
    generatedTypesText,
    allowBreakingByModule,
    generatedAt
  });
  const releaseDossier = createReleaseDossier({
    gate,
    currentBundle,
    baselinePath,
    generatedTypesPath,
    writeBaseline,
    allowBreakingByModule
  });
  const checks = [
    { id: 'federated-openapi-bundle-created', passed: currentBundle.bundleVersion === 'a-federated-openapi-contract-bundle-v1' },
    { id: 'all-required-modules-covered', passed: hasRequiredModules(currentBundle) },
    { id: 'all-modules-openapi-31', passed: currentBundle.coverage.missingOpenApi.length === 0 },
    { id: 'federated-generated-types-current', passed: generatedTypesText.includes('a-federated-openapi-client-types-v1') && generatedTypesText.includes(currentBundle.snapshotHash) },
    { id: 'federated-contract-gate-passed', passed: gate.status === 'passed' },
    { id: 'federated-release-artifact-manifest-ready', passed: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-federated-openapi-release-artifact-manifest-v1' && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false },
    { id: 'federated-worm-promotion-package-ready', passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-federated-openapi-worm-promotion-package-v1' && releaseDossier.externalWormPromotionPackage?.status === 'ready' },
    { id: 'release-dossier-ready', passed: releaseDossier.dossierVersion === 'a-federated-openapi-release-dossier-v1' && releaseDossier.status !== 'blocked' }
  ];
  const report = {
    reportVersion: federatedOpenApiContractGateVersion,
    generatedAt,
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    baseline: {
      path: baselinePath,
      loaded: Boolean(await readJsonIfExists(baselinePath)),
      writeRequested: writeBaseline
    },
    generatedTypes: {
      path: generatedTypesPath,
      typeVersion: 'a-federated-openapi-client-types-v1',
      bundleHash: currentBundle.snapshotHash
    },
    currentBundle,
    gate,
    releaseDossier,
    checks
  };

  await writeArtifacts({
    report,
    generatedTypesText,
    currentBundle,
    jsonPath,
    markdownPath,
    csvPath,
    bundlePath,
    generatedTypesPath,
    baselinePath,
    writeBaseline
  });
  return report;
}

export function createFederatedOpenApiModules({ coreFacade } = {}) {
  return [
    { moduleId: ModuleId.CORE, name: 'A Core', spec: createCoreOpenApiSpec(coreFacade) },
    { moduleId: ModuleId.PC_AGENT, name: 'B PC Agent', spec: createPcAgentOpenApiSpec() },
    { moduleId: ModuleId.BRIDGE, name: 'D Bridge', spec: createBridgeOpenApiSpec() },
    { moduleId: ModuleId.POLICY_SECURITY, name: 'E Policy Security', spec: createPolicySecurityOpenApiSpec() },
    { moduleId: ModuleId.GROWTH_MEMORY, name: 'F Growth Memory', spec: createGrowthMemoryOpenApiSpec() },
    { moduleId: ModuleId.VERIFICATION, name: 'G Verification', spec: createVerificationOpenApiSpec() }
  ];
}

function createReleaseDossier({
  gate,
  currentBundle,
  baselinePath,
  generatedTypesPath,
  writeBaseline,
  allowBreakingByModule
}) {
  const blockedReasons = [];
  if (gate.status !== 'passed') blockedReasons.push('federated-contract-gate-failed');
  if (!hasRequiredModules(currentBundle)) blockedReasons.push('required-openapi-module-missing');
  if (currentBundle.coverage.missingOpenApi.length > 0) blockedReasons.push('openapi-31-missing');
  const artifactManifest = createFederatedReleaseArtifactManifest({
    gate,
    currentBundle,
    baselinePath,
    generatedTypesPath,
    writeBaseline
  });
  const ciNightlyGatePlan = createFederatedCiNightlyGatePlan({
    currentBundle,
    baselinePath,
    generatedTypesPath
  });
  const externalWormPromotionPackage = createFederatedExternalWormPromotionPackage({
    artifactManifest,
    ciNightlyGatePlan
  });
  if (artifactManifest.rawLeakCheck.rawLeakDetected) blockedReasons.push('federated-release-artifact-raw-leak-detected');
  if (externalWormPromotionPackage.status !== 'ready') blockedReasons.push('federated-worm-promotion-package-not-ready');
  return {
    dossierVersion: 'a-federated-openapi-release-dossier-v1',
    status: blockedReasons.length ? 'blocked' : 'passed',
    blockedReasons,
    ciContract: {
      recommendedCommand: 'npm run contracts:federated-gate',
      requiredForPullRequests: true,
      baselinePath,
      generatedTypesPath,
      writeBaselineCommand: 'npm run contracts:federated-gate -- --write-baseline'
    },
    approvalWorkflow: {
      breakingChangesRequireModuleApproval: true,
      allowedBreakingModules: Object.keys(allowBreakingByModule ?? {}),
      unapprovedBreakingCount: gate.unapprovedBreaking?.length ?? 0
    },
    releaseEvidence: {
      bundleHash: currentBundle.snapshotHash,
      routeCount: currentBundle.routeCount,
      moduleCount: currentBundle.moduleCount,
      modules: currentBundle.modules.map((module) => ({
        moduleId: module.moduleId,
        routeCount: module.routeCount,
        schemaCount: module.schemaCount,
        openapi: module.openapi
      })),
      baselineMode: writeBaseline ? 'baseline-written' : 'baseline-checked'
    },
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage
  };
}

function createFederatedReleaseArtifactManifest({
  gate,
  currentBundle,
  baselinePath,
  generatedTypesPath,
  writeBaseline
}) {
  const moduleContractManifest = {
    manifestVersion: 'a-federated-openapi-module-contract-manifest-v1',
    moduleCount: currentBundle.moduleCount,
    modules: currentBundle.modules.map((module) => ({
      moduleId: module.moduleId,
      routeCount: module.routeCount,
      schemaCount: module.schemaCount,
      openapi: module.openapi,
      moduleHash: sha256(JSON.stringify({
        moduleId: module.moduleId,
        routeCount: module.routeCount,
        schemaCount: module.schemaCount,
        openapi: module.openapi,
        routes: currentBundle.routes.filter((route) => route.moduleId === module.moduleId)
      }))
    }))
  };
  const manifestCore = {
    artifactManifestVersion: 'a-federated-openapi-release-artifact-manifest-v1',
    generatedAt: currentBundle.generatedAt,
    bundleVersion: currentBundle.bundleVersion,
    bundleHash: currentBundle.snapshotHash,
    gateVersion: gate.gateVersion,
    gateStatus: gate.status,
    gateHash: sha256(JSON.stringify({
      gateVersion: gate.gateVersion,
      status: gate.status,
      expectedHash: gate.expectedHash,
      generatedHash: gate.generatedHash,
      checks: gate.checks
    })),
    diffHash: sha256(JSON.stringify(gate.diff ?? null)),
    policyHash: sha256(JSON.stringify(gate.policy ?? null)),
    generatedTypesHash: sha256(gate.generatedHash ?? ''),
    baselinePathHash: sha256(baselinePath),
    generatedTypesPathHash: sha256(generatedTypesPath),
    baselineMode: writeBaseline ? 'baseline-written' : 'baseline-checked',
    moduleContractManifest,
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false,
    rawSecretsStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-federated-openapi-release-raw-leak-check-v1',
      checkedModuleCount: currentBundle.moduleCount,
      checkedRouteCount: currentBundle.routeCount,
      rawLeakDetected: containsContractSecret(JSON.stringify({
        modules: currentBundle.modules,
        routes: currentBundle.routes,
        checks: gate.checks
      }))
    }
  };
}

function createFederatedCiNightlyGatePlan({
  currentBundle,
  baselinePath,
  generatedTypesPath
}) {
  return {
    planVersion: 'a-federated-openapi-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run contracts:federated-gate',
    requiredForPullRequests: true,
    requiredForNightly: true,
    baselinePathHash: sha256(baselinePath),
    generatedTypesPathHash: sha256(generatedTypesPath),
    requiredModules: currentBundle.modules.map((module) => module.moduleId),
    requiredChecks: [
      'federated-openapi-bundle-created',
      'all-required-modules-covered',
      'all-modules-openapi-31',
      'federated-generated-types-current',
      'federated-contract-gate-passed',
      'federated-release-artifact-manifest-ready',
      'federated-worm-promotion-package-ready'
    ],
    artifactOutputs: [
      'dist/federated-openapi-contract-gate-report.json',
      'dist/federated-openapi-contract-gate-report.md',
      'dist/federated-openapi-contract-gate-report.csv',
      'dist/federated-openapi-contract-bundle.json',
      'packages/core/src/client/generated/federated-openapi-types.d.ts'
    ],
    rawOpenApiSpecStored: false,
    planHash: sha256(JSON.stringify({
      bundleHash: currentBundle.snapshotHash,
      moduleCount: currentBundle.moduleCount,
      routeCount: currentBundle.routeCount
    }))
  };
}

function createFederatedExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan
}) {
  return {
    packageVersion: 'a-federated-openapi-worm-promotion-package-v1',
    providerContractVersion: 'a-federated-openapi-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'a-federated-openapi-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && ciNightlyGatePlan?.planVersion === 'a-federated-openapi-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256(JSON.stringify(artifactManifest ?? null)),
    ciNightlyGatePlanHash: sha256(JSON.stringify(ciNightlyGatePlan ?? null)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false,
    rawSecretsStored: false
  };
}

function hasRequiredModules(bundle) {
  const required = new Set([
    ModuleId.CORE,
    ModuleId.PC_AGENT,
    ModuleId.BRIDGE,
    ModuleId.POLICY_SECURITY,
    ModuleId.GROWTH_MEMORY,
    ModuleId.VERIFICATION
  ]);
  for (const moduleId of bundle.modules.map((module) => module.moduleId)) {
    required.delete(moduleId);
  }
  return required.size === 0;
}

async function writeArtifacts({
  report,
  generatedTypesText,
  currentBundle,
  jsonPath,
  markdownPath,
  csvPath,
  bundlePath,
  generatedTypesPath,
  baselinePath,
  writeBaseline
}) {
  const writes = [
    [jsonPath, `${JSON.stringify(report, null, 2)}\n`],
    [markdownPath, renderMarkdown(report)],
    [csvPath, renderCsv(report)],
    [bundlePath, `${JSON.stringify(currentBundle, null, 2)}\n`],
    [generatedTypesPath, generatedTypesText]
  ];
  if (writeBaseline) {
    writes.push([baselinePath, `${JSON.stringify(currentBundle, null, 2)}\n`]);
  }
  for (const [targetPath, content] of writes) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  }
}

function renderMarkdown(report) {
  return [
    '# Federated OpenAPI Contract Gate',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Bundle: ${report.currentBundle.bundleVersion}`,
    `Bundle hash: ${report.currentBundle.snapshotHash}`,
    `Gate: ${report.gate.gateVersion} (${report.gate.status})`,
    `Release dossier: ${report.releaseDossier.dossierVersion} (${report.releaseDossier.status})`,
    `Artifact manifest: ${report.releaseDossier.artifactManifest.artifactManifestVersion}`,
    `CI/nightly gate plan: ${report.releaseDossier.ciNightlyGatePlan.planVersion}`,
    `WORM promotion package: ${report.releaseDossier.externalWormPromotionPackage.packageVersion} (${report.releaseDossier.externalWormPromotionPackage.status})`,
    '',
    '## Modules',
    '',
    ...report.currentBundle.modules.map((module) => `- ${module.moduleId}: routes=${module.routeCount}, schemas=${module.schemaCount}, openapi=${module.openapi}`),
    '',
    '## Checks',
    '',
    ...report.checks.map((check) => `- ${check.passed ? 'pass' : 'fail'}: ${check.id}`)
  ].join('\n') + '\n';
}

function renderCsv(report) {
  return [
    'kind,id,status,detail',
    `report,${report.reportVersion},${report.status},routes=${report.currentBundle.routeCount}`,
    `gate,${report.gate.gateVersion},${report.gate.status},breaking=${report.gate.unapprovedBreaking.length}`,
    `dossier,${report.releaseDossier.dossierVersion},${report.releaseDossier.status},bundle=${report.currentBundle.snapshotHash}`,
    ...report.currentBundle.modules.map((module) => `module,${module.moduleId},${module.openapi},routes=${module.routeCount}`),
    ...report.checks.map((check) => `check,${check.id},${check.passed ? 'passed' : 'failed'},`)
  ].join('\n') + '\n';
}

async function readJsonIfExists(filePath) {
  try {
    await access(filePath);
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function containsContractSecret(value) {
  const text = String(value ?? '');
  return /token=|secret=|password=|api[_-]?key=|Bearer\s+[A-Za-z0-9._~+/-]+=*/i.test(text);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readAllowBreakingByModule() {
  const value = readFlag('--allow-breaking-module');
  if (!value) return {};
  return Object.fromEntries(value.split(',').map((moduleId) => [moduleId.trim(), true]).filter(([moduleId]) => moduleId));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFederatedOpenApiContractGate({
    jsonPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/federated-openapi-contract-gate-report.json',
    markdownPath: readFlag('--markdown') ?? 'dist/federated-openapi-contract-gate-report.md',
    csvPath: readFlag('--csv') ?? 'dist/federated-openapi-contract-gate-report.csv',
    bundlePath: readFlag('--bundle') ?? 'dist/federated-openapi-contract-bundle.json',
    generatedTypesPath: readFlag('--types') ?? 'packages/core/src/client/generated/federated-openapi-types.d.ts',
    baselinePath: readFlag('--baseline') ?? 'dist/federated-openapi-contract-baseline.json',
    writeBaseline: process.argv.includes('--write-baseline'),
    allowBreakingByModule: readAllowBreakingByModule()
  });
  console.log(`Federated OpenAPI contract gate: ${report.status}`);
  console.log(`Report: ${readFlag('--output') ?? readFlag('--report') ?? 'dist/federated-openapi-contract-gate-report.json'}`);
}
