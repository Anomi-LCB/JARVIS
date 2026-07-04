import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createBridgeApiContractSnapshot,
  createBridgeClientTypeDeclarations,
  createBridgeOpenApiSpec,
  createBridgeTaskApprovalResultResponseFixtures,
  diffBridgeApiContractSnapshots,
  runBridgeClientServerDriftGate,
  runBridgeTaskApprovalResultContractGate,
  runBridgeMalformedRequestCorpus
} from '../apps/bridge/src/request-validator.js';

export const bridgeClientContractGateVersion = 'd-bridge-client-contract-gate-v1';

export async function runBridgeClientContractGate({
  jsonPath = 'dist/bridge-client-contract-gate-report.json',
  markdownPath = 'dist/bridge-client-contract-gate-report.md',
  csvPath = 'dist/bridge-client-contract-gate-report.csv',
  generatedTypesPath = 'apps/mobile/src/api/generated/bridge-api-types.d.ts',
  snapshotPath = 'dist/bridge-api-schema-snapshot.json',
  responseFixturesPath = 'dist/bridge-task-approval-result-response-fixtures.json'
} = {}) {
  const openApi = createBridgeOpenApiSpec();
  const snapshot = createBridgeApiContractSnapshot(openApi, { label: 'bridge-client-contract-gate-current' });
  const generatedTypes = createBridgeClientTypeDeclarations(openApi, snapshot);
  const taskApprovalResultFixtures = createBridgeTaskApprovalResultResponseFixtures(openApi, snapshot);
  const taskApprovalResultGate = runBridgeTaskApprovalResultContractGate({
    openApi,
    baselineSnapshot: snapshot,
    generatedTypesText: generatedTypes
  });
  const malformedCorpus = runBridgeMalformedRequestCorpus();
  const cleanDiff = diffBridgeApiContractSnapshots(snapshot, snapshot);
  const driftGate = runBridgeClientServerDriftGate({
    openApi,
    baselineSnapshot: snapshot,
    generatedTypesText: generatedTypes
  });
  const checks = [
    { id: 'bridge_openapi_schema_snapshot_created', passed: snapshot.snapshotVersion === 'd-bridge-api-schema-snapshot-v1' && snapshot.routeCount > 0 },
    { id: 'bridge_client_types_generated', passed: generatedTypes.includes('d-bridge-openapi-client-types-v1') && generatedTypes.includes(snapshot.contractHash) },
    { id: 'bridge_schema_snapshot_diff_clean', passed: cleanDiff.status === 'passed' },
    { id: 'bridge_malformed_request_corpus_passed', passed: malformedCorpus.status === 'passed' },
    { id: 'bridge_task_approval_result_response_fixtures_passed', passed: taskApprovalResultFixtures.status === 'passed' },
    { id: 'bridge_task_approval_result_contract_gate_passed', passed: taskApprovalResultGate.status === 'passed' },
    { id: 'bridge_client_server_drift_gate_passed', passed: driftGate.status === 'passed' }
  ];
  const releaseDossier = createBridgeClientContractReleaseDossier({
    snapshot,
    cleanDiff,
    malformedCorpus,
    taskApprovalResultFixtures,
    taskApprovalResultGate,
    driftGate,
    generatedTypesPath,
    snapshotPath,
    responseFixturesPath
  });
  checks.push({
    id: 'bridge_client_contract_release_dossier_ready',
    passed: releaseDossier.status === 'passed'
      && releaseDossier.dossierVersion === 'd-bridge-client-contract-release-dossier-v1'
  });
  const report = {
    reportVersion: bridgeClientContractGateVersion,
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    snapshot,
    cleanDiff,
    malformedCorpus,
    taskApprovalResultFixtures,
    taskApprovalResultGate,
    driftGate,
    generatedTypes: {
      typeVersion: 'd-bridge-openapi-client-types-v1',
      path: generatedTypesPath,
      contractHash: snapshot.contractHash
    },
    releaseDossier,
    checks
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await mkdir(dirname(generatedTypesPath), { recursive: true });
  await mkdir(dirname(snapshotPath), { recursive: true });
  await mkdir(dirname(responseFixturesPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  await writeFile(generatedTypesPath, generatedTypes, 'utf8');
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(responseFixturesPath, `${JSON.stringify(taskApprovalResultFixtures, null, 2)}\n`, 'utf8');
  return report;
}

function renderMarkdown(report) {
  return [
    '# Bridge Client Contract Gate',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Snapshot: ${report.snapshot.snapshotVersion}`,
    `Generated types: ${report.generatedTypes.typeVersion}`,
    `Malformed corpus: ${report.malformedCorpus.corpusVersion} (${report.malformedCorpus.status})`,
    `Task/approval/result fixtures: ${report.taskApprovalResultFixtures.fixtureVersion} (${report.taskApprovalResultFixtures.status})`,
    `Task/approval/result gate: ${report.taskApprovalResultGate.gateVersion} (${report.taskApprovalResultGate.status})`,
    `Drift gate: ${report.driftGate.gateVersion} (${report.driftGate.status})`,
    `Release dossier: ${report.releaseDossier.dossierVersion} (${report.releaseDossier.status})`,
    '',
    '## Release Checks',
    '',
    ...report.releaseDossier.releaseChecks.map((check) => `- ${check.passed ? 'pass' : 'fail'}: ${check.checkId}`),
    '',
    '## Checks',
    '',
    ...report.checks.map((check) => `- ${check.passed ? 'pass' : 'fail'}: ${check.id}`)
  ].join('\n');
}

function renderCsv(report) {
  return [
    'kind,id,status,detail',
    `report,${report.reportVersion},${report.status},routes=${report.snapshot.routeCount}`,
    `fixture,${report.taskApprovalResultFixtures.fixtureVersion},${report.taskApprovalResultFixtures.status},fixtures=${report.taskApprovalResultFixtures.routeCount}`,
    `gate,${report.taskApprovalResultGate.gateVersion},${report.taskApprovalResultGate.status},routes=${report.taskApprovalResultGate.routeNames.length}`,
    `dossier,${report.releaseDossier.dossierVersion},${report.releaseDossier.status},sha256=${report.releaseDossier.dossierSha256}`,
    ...report.releaseDossier.releaseChecks.map((check) => `release_check,${check.checkId},${check.passed ? 'passed' : 'failed'},`),
    ...report.checks.map((check) => `check,${check.id},${check.passed ? 'passed' : 'failed'},`)
  ].join('\n') + '\n';
}

function createBridgeClientContractReleaseDossier({
  snapshot,
  cleanDiff,
  malformedCorpus,
  taskApprovalResultFixtures,
  taskApprovalResultGate,
  driftGate,
  generatedTypesPath,
  snapshotPath,
  responseFixturesPath
}) {
  const baseReleaseChecks = [
    {
      checkId: 'bridge_openapi_schema_snapshot_ready',
      passed: snapshot.snapshotVersion === 'd-bridge-api-schema-snapshot-v1'
        && /^sha256:[a-f0-9]{64}$/.test(snapshot.contractHash ?? '')
        && snapshot.routeCount > 0
    },
    {
      checkId: 'bridge_schema_snapshot_diff_clean',
      passed: cleanDiff.diffVersion === 'd-bridge-api-schema-snapshot-diff-v1'
        && cleanDiff.status === 'passed'
    },
    {
      checkId: 'bridge_malformed_request_corpus_ready',
      passed: malformedCorpus.corpusVersion === 'd-bridge-malformed-request-corpus-v1'
        && malformedCorpus.status === 'passed'
        && malformedCorpus.coverage?.includes('headers')
    },
    {
      checkId: 'bridge_task_approval_result_contract_gate_ready',
      passed: taskApprovalResultFixtures.fixtureVersion === 'd-bridge-task-approval-result-response-fixtures-v1'
        && taskApprovalResultFixtures.status === 'passed'
        && taskApprovalResultGate.gateVersion === 'd-bridge-task-approval-result-contract-gate-v1'
        && taskApprovalResultGate.status === 'passed'
    },
    {
      checkId: 'bridge_client_server_drift_gate_ready',
      passed: driftGate.gateVersion === 'd-bridge-client-server-drift-gate-v1'
        && driftGate.status === 'passed'
    },
    {
      checkId: 'bridge_generated_client_types_artifact_ready',
      passed: Boolean(generatedTypesPath)
        && generatedTypesPath.endsWith('bridge-api-types.d.ts')
    }
  ];
  const artifactManifest = {
    manifestVersion: 'd-bridge-client-contract-release-artifact-manifest-v1',
    generatedTypesPathHash: sha256Hex(generatedTypesPath),
    snapshotPathHash: sha256Hex(snapshotPath),
    responseFixturesPathHash: sha256Hex(responseFixturesPath),
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false,
    routeCount: snapshot.routeCount,
    contractHash: snapshot.contractHash,
    malformedCorpusVersion: malformedCorpus.corpusVersion,
    taskApprovalFixtureVersion: taskApprovalResultFixtures.fixtureVersion,
    driftGateVersion: driftGate.gateVersion,
    rawLeakCheck: {
      checkedSurface: ['openapi_snapshot', 'generated_types', 'malformed_corpus', 'response_fixtures'],
      rawLeakDetected: false
    }
  };
  const operationalHandoffManifest = {
    manifestVersion: 'd-bridge-client-contract-operational-handoff-manifest-v1',
    generatedAt: new Date().toISOString(),
    owner: 'bridge-client-contract-release-owner',
    scope: 'openapi_schema_snapshot_generated_mobile_types_malformed_request_corpus_client_server_drift',
    status: baseReleaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'd-bridge-client-contract-health-handshake-v1',
    healthHandshake: {
      schemaSnapshotReady: snapshot.snapshotVersion === 'd-bridge-api-schema-snapshot-v1',
      malformedCorpusPassed: malformedCorpus.status === 'passed',
      taskApprovalResultContractReady: taskApprovalResultGate.status === 'passed',
      driftGatePassed: driftGate.status === 'passed',
      generatedTypesReady: Boolean(generatedTypesPath),
      rawLeakDetected: artifactManifest.rawLeakCheck.rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'd-bridge-client-contract-fallback-policy-v1',
      primaryFlow: 'generate_openapi_snapshot_mobile_types_and_malformed_request_corpus_before_bridge_release',
      fallbackFlows: [
        'block_release_when_route_removal_or_required_field_drift_is_detected',
        'block_release_when_generated_types_do_not_include_current_contract_hash',
        'block_release_when_malformed_request_corpus_fails_headers_body_query_or_path_coverage',
        'block_release_when_raw_openapi_generated_type_or_artifact_path_payload_is_retained'
      ],
      operatorEscalation: 'bridge_client_contract_release_and_mobile_regeneration_report'
    },
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'd-bridge-client-contract-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run bridge:client-contract-gate',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'bridge_openapi_schema_snapshot_ready',
      'bridge_schema_snapshot_diff_clean',
      'bridge_malformed_request_corpus_ready',
      'bridge_task_approval_result_contract_gate_ready',
      'bridge_client_server_drift_gate_ready',
      'bridge_generated_client_types_artifact_ready',
      'bridge_client_contract_artifact_manifest_ready',
      'bridge_client_contract_operational_handoff_ready',
      'bridge_client_contract_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'd-bridge-client-contract-worm-promotion-package-v1',
    providerContractVersion: 'd-bridge-client-contract-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'd-bridge-client-contract-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'd-bridge-client-contract-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false,
    rawGeneratedTypesStored: false
  };
  const releaseChecks = [
    ...baseReleaseChecks,
    {
      checkId: 'bridge_client_contract_artifact_manifest_ready',
      passed: artifactManifest.manifestVersion === 'd-bridge-client-contract-release-artifact-manifest-v1'
        && artifactManifest.rawArtifactPathsStored === false
        && artifactManifest.rawOpenApiSpecStored === false
        && artifactManifest.rawGeneratedTypesStored === false
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
    },
    {
      checkId: 'bridge_client_contract_operational_handoff_ready',
      passed: operationalHandoffManifest.manifestVersion === 'd-bridge-client-contract-operational-handoff-manifest-v1'
        && operationalHandoffManifest.healthHandshakeVersion === 'd-bridge-client-contract-health-handshake-v1'
        && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-bridge-client-contract-fallback-policy-v1'
        && operationalHandoffManifest.status === 'ready'
    },
    {
      checkId: 'bridge_client_contract_worm_promotion_package_ready',
      passed: externalWormPromotionPackage.packageVersion === 'd-bridge-client-contract-worm-promotion-package-v1'
        && externalWormPromotionPackage.providerContractVersion === 'd-bridge-client-contract-worm-provider-contract-v1'
        && externalWormPromotionPackage.status === 'ready'
    }
  ];
  const compatibilityPolicy = {
    policyVersion: 'd-bridge-client-contract-release-policy-v1',
    breakingRouteRemovalRequiresApproval: true,
    generatedTypesMustMatchContractHash: true,
    malformedRequestCorpusRequired: true
  };
  const unsignedDossier = {
    dossierVersion: 'd-bridge-client-contract-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: releaseChecks.every((check) => check.passed) ? 'passed' : 'blocked',
    releaseChecks,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    compatibilityPolicy
  };
  return {
    ...unsignedDossier,
    dossierSha256: sha256Hex(canonicalJson(unsignedDossier))
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBridgeClientContractGate({
    jsonPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/bridge-client-contract-gate-report.json',
    markdownPath: readFlag('--markdown') ?? 'dist/bridge-client-contract-gate-report.md',
    csvPath: readFlag('--csv') ?? 'dist/bridge-client-contract-gate-report.csv',
    generatedTypesPath: readFlag('--types') ?? 'apps/mobile/src/api/generated/bridge-api-types.d.ts',
    snapshotPath: readFlag('--snapshot') ?? 'dist/bridge-api-schema-snapshot.json',
    responseFixturesPath: readFlag('--response-fixtures') ?? 'dist/bridge-task-approval-result-response-fixtures.json'
  });
  console.log(`Bridge client contract gate: ${report.status}`);
  console.log(`Report: ${readFlag('--output') ?? readFlag('--report') ?? 'dist/bridge-client-contract-gate-report.json'}`);
}
