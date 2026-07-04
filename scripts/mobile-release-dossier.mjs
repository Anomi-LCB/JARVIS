import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMobileVerification } from './mobile-verify.mjs';

export async function runMobileReleaseDossier({
  jsonPath = 'dist/mobile-release-dossier.json',
  markdownPath = 'dist/mobile-release-dossier.md',
  csvPath = 'dist/mobile-release-dossier.csv',
  verificationJsonPath = 'dist/mobile-verification-report.json',
  verificationMarkdownPath = 'dist/mobile-verification-report.md',
  verificationHtmlPath = 'dist/mobile-verification-report.html'
} = {}) {
  const verificationReport = await runMobileVerification({
    jsonPath: verificationJsonPath,
    markdownPath: verificationMarkdownPath,
    htmlPath: verificationHtmlPath
  });
  const releaseDossier = createMobileReleaseDossier({
    verificationReport,
    verificationJsonPath,
    verificationMarkdownPath,
    verificationHtmlPath
  });
  const productGate = createMobileReleaseDossierProductGate({ releaseDossier });
  const report = {
    reportVersion: 'c-mobile-release-dossier-report-v1',
    generatedAt: new Date().toISOString(),
    status: productGate.status,
    releaseDossier,
    productGate,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      csvPath: resolve(csvPath),
      verificationJsonPath: resolve(verificationJsonPath),
      verificationMarkdownPath: resolve(verificationMarkdownPath),
      verificationHtmlPath: resolve(verificationHtmlPath)
    }
  };
  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await mkdir(dirname(resolve(markdownPath)), { recursive: true });
  await mkdir(dirname(resolve(csvPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

export function createMobileReleaseDossier({
  verificationReport,
  verificationJsonPath,
  verificationMarkdownPath,
  verificationHtmlPath
}) {
  const releasePreflight = verificationReport?.releasePreflight ?? {};
  const structureGate = verificationReport?.mobileAppStructureProductGate ?? {};
  const productMatrix = verificationReport?.productMatrix ?? {};
  const checks = [
    {
      checkId: 'mobile_app_structure_product_gate_passed',
      passed: structureGate.productGateVersion === 'c-mobile-app-structure-product-gate-v1'
        && structureGate.status === 'passed'
    },
    {
      checkId: 'mobile_native_and_screen_contracts_passed',
      passed: verificationReport?.nativeReadiness?.status === 'passed'
        && verificationReport?.screenReadiness?.status === 'passed',
      nativeStatus: verificationReport?.nativeReadiness?.status ?? null,
      screenStatus: verificationReport?.screenReadiness?.status ?? null
    },
    {
      checkId: 'mobile_release_preflight_local_contract_passed',
      passed: releasePreflight.preflightVersion === 'c-mobile-release-preflight-v1'
        && releasePreflight.localStatus === 'passed'
        && ['passed', 'external-blocked'].includes(releasePreflight.status),
      preflightStatus: releasePreflight.status ?? null,
      credentialStatus: releasePreflight.credentialStatus ?? null,
      deviceEvidenceStatus: releasePreflight.deviceEvidenceStatus ?? null
    },
    {
      checkId: 'mobile_product_artifact_manifest_ready',
      passed: (productMatrix.artifactManifest?.expectedReports ?? []).includes('dist/mobile-verification-report.json')
        && (productMatrix.artifactManifest?.expectedReports ?? []).includes('dist/mobile-release-preflight-report.json')
        && verificationReport?.deviceSmoke?.artifacts?.jsonPath,
      expectedReports: productMatrix.artifactManifest?.expectedReports ?? []
    },
    {
      checkId: 'mobile_device_evidence_gate_tracked',
      passed: verificationReport?.deviceProbe
        && verificationReport.checks?.some((item) => item.id === 'device:actual-device' && item.severity === 'product-readiness')
        && verificationReport.checks?.some((item) => item.id === 'device:install-launch-screen' && item.severity === 'product-readiness'),
      actualDeviceVerified: verificationReport?.deviceProbe?.actualDeviceVerified === true
    },
    {
      checkId: 'mobile_external_store_gate_tracked',
      passed: releasePreflight.preflightVersion === 'c-mobile-release-preflight-v1'
        && Array.isArray(releasePreflight.blockers)
        && releasePreflight.plan?.planVersion === 'c-mobile-release-preflight-plan-v1',
      blockerCount: releasePreflight.blockers?.length ?? 0
    }
  ];
  const dossier = {
    dossierVersion: 'c-mobile-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    mode: 'local-mobile-release-lab-with-external-store-and-device-evidence-tracking',
    physicalDeviceRequiredForFinalRelease: true,
    productionCredentialsRequiredForFinalRelease: true,
    project: verificationReport?.project ?? {},
    verification: {
      status: verificationReport?.status ?? null,
      score: verificationReport?.score ?? null,
      nativeStatus: verificationReport?.nativeReadiness?.status ?? null,
      screenStatus: verificationReport?.screenReadiness?.status ?? null,
      appStructureGateStatus: structureGate.status ?? null
    },
    releasePreflight: {
      status: releasePreflight.status ?? null,
      localStatus: releasePreflight.localStatus ?? null,
      credentialStatus: releasePreflight.credentialStatus ?? null,
      deviceEvidenceStatus: releasePreflight.deviceEvidenceStatus ?? null,
      blockerIds: (releasePreflight.blockers ?? []).map((item) => item.id)
    },
    deviceEvidence: {
      actualDeviceVerified: verificationReport?.deviceProbe?.actualDeviceVerified === true,
      deviceSmokeStatus: verificationReport?.deviceSmoke?.status ?? null,
      routeNavigation: verificationReport?.deviceSmoke?.routeNavigation ?? null
    },
    artifacts: {
      verificationJsonPath: resolve(verificationJsonPath),
      verificationMarkdownPath: resolve(verificationMarkdownPath),
      verificationHtmlPath: resolve(verificationHtmlPath),
      productManifestPath: resolve('dist/mobile-product-verification-manifest.json'),
      androidSetupPath: verificationReport?.androidSetup?.artifacts?.jsonPath ?? null,
      androidEmulatorPath: verificationReport?.androidEmulator?.artifacts?.jsonPath ?? null,
      androidInstallPath: verificationReport?.androidInstall?.artifacts?.jsonPath ?? null,
      releasePreflightPath: releasePreflight.artifacts?.jsonPath ?? null,
      deviceSmokePath: verificationReport?.deviceSmoke?.artifacts?.jsonPath ?? null
    },
    releaseChecks: checks,
    recommendedReleaseAction: checks.every((check) => check.passed)
      ? 'attach_physical_device_store_credential_evidence_and_rerun_mobile_release_dossier'
      : 'block_mobile_release_until_local_app_structure_and_preflight_contracts_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createMobileReleaseDossierProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'mobile_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'c-mobile-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'mobile_structure_and_native_contracts_ready',
      passed: releaseDossier?.releaseChecks?.filter((check) => [
        'mobile_app_structure_product_gate_passed',
        'mobile_native_and_screen_contracts_passed'
      ].includes(check.checkId)).every((check) => check.passed) === true
    },
    {
      checkId: 'mobile_release_preflight_and_external_gate_tracked',
      passed: releaseDossier?.releaseChecks?.filter((check) => [
        'mobile_release_preflight_local_contract_passed',
        'mobile_external_store_gate_tracked'
      ].includes(check.checkId)).every((check) => check.passed) === true
    },
    {
      checkId: 'mobile_device_evidence_tracking_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'mobile_device_evidence_gate_tracked' && check.passed) === true
    }
  ];
  return {
    productGateVersion: 'c-mobile-release-dossier-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function renderMarkdown(report) {
  return [
    '# Mobile Release Dossier',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Dossier: ${report.releaseDossier.dossierVersion}`,
    `Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`,
    `Verification: ${report.releaseDossier.verification.status}`,
    `Release preflight: ${report.releaseDossier.releasePreflight.status}`,
    `Actual device verified: ${report.releaseDossier.deviceEvidence.actualDeviceVerified}`,
    '',
    '## Release Checks',
    '',
    ...report.releaseDossier.releaseChecks.map((check) => `- ${check.checkId}: ${check.passed ? 'passed' : 'blocked'}`),
    '',
    '## Next',
    '',
    report.releaseDossier.recommendedReleaseAction
  ].join('\n');
}

function renderCsv(report) {
  const rows = [['domain', 'check_id', 'status', 'detail']]
    .concat(report.releaseDossier.releaseChecks.map((check) => [
      'release-dossier',
      check.checkId,
      check.passed ? 'passed' : 'blocked',
      report.releaseDossier.dossierVersion
    ]))
    .concat(report.productGate.checks.map((check) => [
      'product-gate',
      check.checkId,
      check.passed ? 'passed' : 'blocked',
      report.productGate.productGateVersion
    ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.jsonPath = argv[++index];
    else if (arg === '--md') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
    else if (arg === '--verification-json') args.verificationJsonPath = argv[++index];
    else if (arg === '--verification-md') args.verificationMarkdownPath = argv[++index];
    else if (arg === '--verification-html') args.verificationHtmlPath = argv[++index];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMobileReleaseDossier(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS C Mobile Release Dossier');
  console.log(`Status: ${report.status}`);
  console.log(`Product gate: ${report.productGate.productGateVersion} / ${report.productGate.status}`);
  console.log(`Report: ${report.artifacts.jsonPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
