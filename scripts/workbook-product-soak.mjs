import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkbookProductCorpus } from '../apps/pc-agent/src/pc-agent-runtime.js';

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function runWorkbookProductSoakReport({
  fixturePath = 'apps/pc-agent/fixtures/workbook-product-corpus.json',
  outputRoot = 'dist/workbook-product-soak/workbooks',
  cycles = null,
  jsonPath = 'dist/workbook-product-soak-report.json',
  markdownPath = 'dist/workbook-product-soak-report.md',
  csvPath = 'dist/workbook-product-soak-report.csv'
} = {}) {
  const report = await runWorkbookProductCorpus({ fixturePath, outputRoot, cycles });
  const artifactManifest = createWorkbookProductReleaseArtifactManifest({
    report,
    fixturePath,
    outputRoot,
    jsonPath,
    markdownPath,
    csvPath
  });
  const operationalHandoffManifest = createWorkbookProductOperationalHandoffManifest({
    report,
    artifactManifest
  });
  const ciNightlyGatePlan = createWorkbookProductCiNightlyGatePlan({
    artifactManifest,
    operationalHandoffManifest
  });
  const externalWormPromotionPackage = createWorkbookProductWormPromotionPackage({
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan
  });
  const dossier = {
    dossierVersion: 'b-workbook-product-soak-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: report.status === 'passed' && externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
    report,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    artifacts: { jsonPath, markdownPath, csvPath, outputRoot }
  };
  dossier.dossierSha256 = sha256Json(dossier);
  dossier.productGate = createWorkbookProductGate(dossier);
  await writeWorkbookProductSoakArtifacts(dossier, { jsonPath, markdownPath, csvPath });
  return dossier;
}

export function createWorkbookProductGate(dossier) {
  const report = dossier.report;
  const checks = [
    {
      checkId: 'workbook_fixture_pack_report_passed',
      passed: report.reportVersion === 'b-workbook-product-soak-report-v1'
        && report.status === 'passed'
        && report.coverage.workbookFixtures > 0
    },
    {
      checkId: 'workbook_renderer_probe_ready',
      passed: report.rendererProbe?.probeVersion === 'b-workbook-renderer-probe-v1'
        && (report.rendererProbe.required ? report.rendererProbe.status === 'external-renderer-ready' : ['external-renderer-ready', 'contract-fallback'].includes(report.rendererProbe.status)),
      status: report.rendererProbe?.status ?? null,
      required: report.rendererProbe?.required === true,
      selectedRenderer: report.rendererProbe?.selectedRenderer ?? null
    },
    {
      checkId: 'workbook_template_migration_passed',
      passed: report.migrationReport?.reportVersion === 'b-workbook-template-migration-report-v1'
        && report.migrationReport.status === 'passed'
        && report.migrationReport.items.length > 0
    },
    {
      checkId: 'workbook_worker_pool_soak_passed',
      passed: report.workerPoolSoak?.soakVersion === 'b-workbook-worker-pool-soak-v1'
        && report.workerPoolSoak.status === 'passed'
        && report.workerPoolSoak.items.length > 0
    },
    {
      checkId: 'workbook_release_dossier_ready',
      passed: dossier.dossierVersion === 'b-workbook-product-soak-dossier-v1'
        && dossier.status === 'passed'
        && typeof dossier.dossierSha256 === 'string'
        && dossier.dossierSha256.length === 64
    },
    {
      checkId: 'workbook_release_artifact_manifest_ready',
      passed: dossier.artifactManifest?.artifactManifestVersion === 'b-workbook-release-artifact-manifest-v1'
        && dossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        && dossier.artifactManifest.rawWorkbookPathStored === false
        && dossier.artifactManifest.rawFixturePathStored === false
    },
    {
      checkId: 'workbook_operational_handoff_ready',
      passed: dossier.operationalHandoffManifest?.manifestVersion === 'b-workbook-operational-handoff-manifest-v1'
        && dossier.operationalHandoffManifest?.healthHandshakeVersion === 'b-workbook-health-handshake-v1'
        && dossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-workbook-fallback-policy-v1'
        && dossier.operationalHandoffManifest?.status === 'ready'
    },
    {
      checkId: 'workbook_worm_promotion_package_ready',
      passed: dossier.externalWormPromotionPackage?.packageVersion === 'b-workbook-worm-promotion-package-v1'
        && dossier.externalWormPromotionPackage?.providerContractVersion === 'b-workbook-worm-provider-contract-v1'
        && dossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-workbook-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: dossier.dossierVersion,
      status: dossier.status,
      dossierSha256: dossier.dossierSha256
    }
  };
}

export async function writeWorkbookProductSoakArtifacts(dossier, { jsonPath, markdownPath, csvPath }) {
  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await mkdir(dirname(resolve(csvPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(dossier, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderWorkbookProductSoakMarkdown(dossier), 'utf8');
  await writeFile(csvPath, renderWorkbookProductSoakCsv(dossier), 'utf8');
  return dossier.artifacts;
}

export function renderWorkbookProductSoakMarkdown(dossier) {
  const { report } = dossier;
  const lines = [
    '# JARVIS B Workbook Product Soak',
    '',
    `Status: ${dossier.status}`,
    `Fixture pack: ${report.fixturePackVersion}`,
    `Workbook fixtures: ${report.coverage.workbookFixtures}`,
    `Template migration fixtures: ${report.coverage.templateMigrationFixtures}`,
    `Worker pool: ${report.workerPoolSoak.workerPool.workerCount} workers`,
    `Renderer probe: ${report.rendererProbe.status}`,
    `Migration: ${report.migrationReport.status}`,
    `Worker soak: ${report.workerPoolSoak.status}`,
    `Operational handoff: ${dossier.operationalHandoffManifest.manifestVersion} / ${dossier.operationalHandoffManifest.status}`,
    `WORM promotion package: ${dossier.externalWormPromotionPackage.packageVersion} / ${dossier.externalWormPromotionPackage.status}`,
    `Product gate: ${dossier.productGate.productGateVersion} / ${dossier.productGate.status}`,
    '',
    '## Failed Items'
  ];
  const failed = [
    ...report.migrationReport.failures.map((item) => `migration:${item.fixtureId}`),
    ...report.workerPoolSoak.failures.map((item) => `workbook:${item.fixtureId}:cycle-${item.cycleIndex + 1}`)
  ];
  if (!failed.length) lines.push('- none');
  for (const item of failed) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

export function renderWorkbookProductSoakCsv(dossier) {
  const rows = [['domain', 'fixtureId', 'cycleIndex', 'status', 'detail']]
    .concat(dossier.report.migrationReport.items.map((item) => [
      'template-migration',
      item.fixtureId,
      '',
      item.status,
      item.steps.join('|')
    ]))
    .concat(dossier.report.workerPoolSoak.items.map((item) => [
      'workbook-render',
      item.fixtureId,
      item.cycleIndex,
      item.status,
      item.worker?.workerId
    ]))
    .concat(dossier.productGate.checks.map((check) => [
      'product-gate',
      check.checkId,
      '',
      check.passed ? 'passed' : 'blocked',
      dossier.productGate.productGateVersion
    ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createWorkbookProductReleaseArtifactManifest({
  report,
  fixturePath,
  outputRoot,
  jsonPath,
  markdownPath,
  csvPath
}) {
  const manifest = {
    artifactManifestVersion: 'b-workbook-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    reportVersion: report?.reportVersion ?? null,
    fixturePackVersion: report?.fixturePackVersion ?? null,
    reportHash: sha256Json({
      reportVersion: report?.reportVersion ?? null,
      status: report?.status ?? null,
      coverage: report?.coverage ?? null,
      rendererProbe: report?.rendererProbe ?? null,
      migrationStatus: report?.migrationReport?.status ?? null,
      workerPoolStatus: report?.workerPoolSoak?.status ?? null
    }),
    artifactPathHashes: {
      fixturePathHash: sha256Json(resolve(fixturePath)),
      outputRootHash: sha256Json(resolve(outputRoot)),
      jsonPathHash: sha256Json(resolve(jsonPath)),
      markdownPathHash: sha256Json(resolve(markdownPath)),
      csvPathHash: sha256Json(resolve(csvPath))
    },
    workbookFixtureHashes: (report?.workerPoolSoak?.items ?? []).slice(0, 50).map((item) => ({
      fixtureId: item.fixtureId,
      status: item.status,
      workbookHash: sha256Json({
        fixtureId: item.fixtureId,
        cycleIndex: item.cycleIndex,
        renderSmoke: item.renderSmoke?.status,
        workerId: item.worker?.workerId ?? null
      })
    })),
    rawWorkbookPathStored: false,
    rawFixturePathStored: false,
    rawWorkbookContentStored: false,
    rawRendererOutputStored: false
  };
  manifest.rawLeakCheck = {
    checkVersion: 'b-workbook-release-raw-leak-check-v1',
    rawLeakDetected: containsWorkbookReleaseRawLeak(manifest),
    checkedRawFields: [
      'rawWorkbookPathStored',
      'rawFixturePathStored',
      'rawWorkbookContentStored',
      'rawRendererOutputStored'
    ]
  };
  return manifest;
}

function createWorkbookProductOperationalHandoffManifest({ report, artifactManifest }) {
  const manifest = {
    manifestVersion: 'b-workbook-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'b-workbook-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: report?.status === 'passed' && artifactManifest?.rawLeakCheck?.rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshake: {
      reportVersion: report?.reportVersion ?? null,
      fixturePackVersion: report?.fixturePackVersion ?? null,
      rendererProbeStatus: report?.rendererProbe?.status ?? null,
      rendererRequired: report?.rendererProbe?.required === true,
      migrationStatus: report?.migrationReport?.status ?? null,
      workerPoolStatus: report?.workerPoolSoak?.status ?? null,
      workbookFixtures: report?.coverage?.workbookFixtures ?? 0
    },
    fallbackPolicy: {
      policyVersion: 'b-workbook-fallback-policy-v1',
      primaryFlow: 'external_excel_or_libreoffice_renderer_smoke',
      fallbackFlows: [
        'ooxml_contract_render_smoke',
        'template_migration_block_before_release',
        'worker_pool_soak_retry'
      ],
      operatorEscalation: 'pc_agent_workbook_product_soak_report'
    },
    artifactManifestHash: sha256Json(artifactManifest),
    rawWorkbookPathStored: false,
    rawFixturePathStored: false,
    rawWorkbookContentStored: false
  };
  return manifest;
}

function createWorkbookProductCiNightlyGatePlan({ artifactManifest, operationalHandoffManifest }) {
  return {
    planVersion: 'b-workbook-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run workbook:product-soak',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'workbook_fixture_pack_report_passed',
      'workbook_renderer_probe_ready',
      'workbook_template_migration_passed',
      'workbook_worker_pool_soak_passed',
      'workbook_release_artifact_manifest_ready',
      'workbook_operational_handoff_ready',
      'workbook_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    rawWorkbookPathStored: false
  };
}

function createWorkbookProductWormPromotionPackage({
  artifactManifest,
  operationalHandoffManifest,
  ciNightlyGatePlan
}) {
  return {
    packageVersion: 'b-workbook-worm-promotion-package-v1',
    providerContractVersion: 'b-workbook-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'b-workbook-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && operationalHandoffManifest?.status === 'ready'
      && ciNightlyGatePlan?.planVersion === 'b-workbook-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    operationalHandoffHash: sha256Json(operationalHandoffManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawWorkbookPathStored: false,
    rawWorkbookContentStored: false
  };
}

function containsWorkbookReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"outputRoot"\s*:|"fixturePath"\s*:|"workbookPath"\s*:|"outputPath"\s*:|"templateFile"\s*:|\.xlsx|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixtures') options.fixturePath = argv[index + 1];
    if (arg === '--output-root') options.outputRoot = argv[index + 1];
    if (arg === '--cycles') options.cycles = Number(argv[index + 1]);
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--csv') options.csvPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dossier = await runWorkbookProductSoakReport(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS B Workbook Product Soak');
  console.log(`Status: ${dossier.status}`);
  console.log(`Fixture pack: ${dossier.report.fixturePackVersion}`);
  console.log(`Renderer probe: ${dossier.report.rendererProbe.status}`);
  console.log(`Reports: ${dossier.artifacts.jsonPath}, ${dossier.artifacts.markdownPath}, ${dossier.artifacts.csvPath}`);
  if (dossier.status !== 'passed') process.exitCode = 1;
}
