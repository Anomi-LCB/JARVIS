import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legalDocumentBundleSha256 } from './legal-release-pack.mjs';

const artifactDefinitions = Object.freeze([
  { id: 'core-runtime-host', path: 'dist/core-service-package/JarvisCoreRuntimeHost.exe', required: true },
  { id: 'pc-agent-installer', path: 'dist/pc-agent-installer/JARVIS-PC-Agent-Setup.exe', required: true },
  { id: 'windows-signing-audit', path: 'dist/windows-code-signing-audit.json', required: true },
  { id: 'mobile-release-preflight', path: 'dist/mobile-release-preflight-report.json', required: true },
  { id: 'mobile-eas-production-build', path: 'dist/mobile-eas-production-build.json', required: true },
  { id: 'wearable-physical-field', path: 'dist/wearable-physical-field-gate.json', required: true },
  { id: 'final-release-gate', path: 'dist/final-release-gate.json', required: true },
  { id: 'commercial-readiness', path: 'dist/commercial-readiness-audit.json', required: true },
  { id: 'license', path: 'LICENSE', required: true },
  { id: 'privacy', path: 'PRIVACY.md', required: true },
  { id: 'eula', path: 'EULA.md', required: true },
  { id: 'legal-approval', path: 'dist/legal-release-pack/legal-release-approval.json', required: true }
]);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function artifactObservation(root, definition) {
  const absolutePath = resolve(root, definition.path);
  try {
    const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    return {
      id: definition.id,
      path: definition.path,
      required: definition.required,
      exists: true,
      bytes: metadata.size,
      sha256: createHash('sha256').update(content).digest('hex')
    };
  } catch {
    return { id: definition.id, path: definition.path, required: definition.required, exists: false, bytes: 0, sha256: null };
  }
}

function check(id, passed, detail = {}) {
  return { id, passed: passed === true, detail };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function legalBundleStatus(root, approval) {
  try {
    const documents = {
      license: await readFile(resolve(root, 'LICENSE'), 'utf8'),
      privacy: await readFile(resolve(root, 'PRIVACY.md'), 'utf8'),
      eula: await readFile(resolve(root, 'EULA.md'), 'utf8')
    };
    const actual = legalDocumentBundleSha256(documents);
    return {
      passed: approval?.receiptVersion === 'jarvis-legal-release-approval-receipt-v1'
        && approval?.explicitApprovalConfirmed === true
        && approval?.reviewBundleSha256 === actual,
      actualBundleSha256: actual,
      approvedBundleSha256: approval?.reviewBundleSha256 ?? null
    };
  } catch {
    return { passed: false, actualBundleSha256: null, approvedBundleSha256: approval?.reviewBundleSha256 ?? null };
  }
}

export async function createCommercialReleaseSeal({
  workspaceRoot = process.cwd(),
  clock = () => new Date()
} = {}) {
  const root = resolve(workspaceRoot);
  const [
    packageManifest,
    commercial,
    closure,
    windowsSigning,
    mobile,
    easBuild,
    wearable,
    finalGate,
    legalApproval,
    artifacts
  ] = await Promise.all([
    readJson(resolve(root, 'package.json')),
    readJson(resolve(root, 'dist/commercial-readiness-audit.json')),
    readJson(resolve(root, 'dist/commercial-closure/commercial-closure.json')),
    readJson(resolve(root, 'dist/windows-code-signing-audit.json')),
    readJson(resolve(root, 'dist/mobile-release-preflight-report.json')),
    readJson(resolve(root, 'dist/mobile-eas-production-build.json')),
    readJson(resolve(root, 'dist/wearable-physical-field-gate.json')),
    readJson(resolve(root, 'dist/final-release-gate.json')),
    readJson(resolve(root, 'dist/legal-release-pack/legal-release-approval.json')),
    Promise.all(artifactDefinitions.map((definition) => artifactObservation(root, definition)))
  ]);
  const legal = await legalBundleStatus(root, legalApproval);
  const checks = [
    check('commercial-audit-100', commercial?.status === 'commercial-ready'
      && commercial?.score === 100
      && commercial?.commercialReady === true, { status: commercial?.status ?? 'missing', score: commercial?.score ?? null }),
    check('closure-plan-complete', closure?.status === 'commercial-100-complete'
      && closure?.summary?.remainingPoints === 0, { status: closure?.status ?? 'missing', remainingPoints: closure?.summary?.remainingPoints ?? null }),
    check('windows-production-signing-verified', windowsSigning?.status === 'passed'
      && windowsSigning?.summary?.blockerCount === 0, { status: windowsSigning?.status ?? 'missing' }),
    check('mobile-production-release-verified', mobile?.status === 'passed'
      && mobile?.credentialVerification?.status === 'passed'
      && mobile?.easBuildEvidence?.passed === true, { status: mobile?.status ?? 'missing' }),
    check('eas-production-build-verified', easBuild?.status === 'passed', { status: easBuild?.status ?? 'missing' }),
    check('wearable-physical-field-verified', wearable?.status === 'passed'
      && wearable?.integrity?.passed === true, { status: wearable?.status ?? 'missing' }),
    check('final-release-gate-passed', finalGate?.status === 'passed'
      && finalGate?.summary?.blockingCheckCount === 0, { status: finalGate?.status ?? 'missing' }),
    check('legal-review-bundle-matches', legal.passed, legal),
    check('required-release-artifacts-present', artifacts.filter((item) => item.required).every((item) => item.exists), {
      missing: artifacts.filter((item) => item.required && !item.exists).map((item) => item.id)
    })
  ];
  const sealPayload = {
    sealVersion: 'jarvis-commercial-release-seal-v1',
    product: {
      name: packageManifest?.name ?? null,
      version: packageManifest?.version ?? null
    },
    checks,
    artifacts,
    rollback: {
      coreUninstallScript: 'dist/core-service-package/uninstall-service.ps1',
      pcAgentUninstallScript: 'dist/pc-agent-installer/uninstall-service.ps1',
      pcAgentInstaller: 'dist/pc-agent-installer/JARVIS-PC-Agent-Setup.exe',
      mobileRollbackPolicy: 'promote-the-last-known-good-store-build',
      configurationBackupContainsSecrets: false,
      destructiveRollbackAutoExecuted: false
    }
  };
  const failedChecks = checks.filter((item) => !item.passed);
  const status = failedChecks.length === 0 ? 'sealed-commercial-release' : 'blocked-not-sealed';
  return {
    reportVersion: 'jarvis-commercial-release-seal-v1',
    generatedAt: clock().toISOString(),
    status,
    releaseId: status === 'sealed-commercial-release' ? sha256Json(sealPayload) : null,
    summary: {
      passedChecks: checks.length - failedChecks.length,
      totalChecks: checks.length,
      blockerCount: failedChecks.length,
      artifactCount: artifacts.filter((item) => item.exists).length,
      requiredArtifactCount: artifacts.filter((item) => item.required).length
    },
    checks,
    blockers: failedChecks.map((item) => item.id),
    artifacts,
    rollback: sealPayload.rollback,
    privacy: {
      rawCredentialsStored: false,
      rawCommandsStored: false,
      userContentStored: false,
      certificateSubjectsStored: false
    }
  };
}

function renderMarkdown(report) {
  const rows = report.checks.map((item) => `| ${item.passed ? '통과' : '차단'} | ${item.id} |`).join('\n');
  return `# JARVIS 상용 릴리스 봉인\n\n- 상태: **${report.status}**\n- 릴리스 ID: **${report.releaseId ?? '미발급'}**\n- 검증: **${report.summary.passedChecks}/${report.summary.totalChecks}**\n\n| 결과 | 검사 |\n| --- | --- |\n${rows}\n\n100점과 모든 외부 증거가 확인되기 전에는 릴리스 ID를 발급하지 않습니다.\n`;
}

function renderRollback(report) {
  return `# JARVIS 롤백 자료\n\n- 릴리스 상태: ${report.status}\n- 릴리스 ID: ${report.releaseId ?? '미발급'}\n- Core 제거: \`${report.rollback.coreUninstallScript}\`\n- PC Agent 제거: \`${report.rollback.pcAgentUninstallScript}\`\n- PC Agent 재설치 기준 파일: \`${report.rollback.pcAgentInstaller}\`\n- 모바일: 마지막 정상 스토어 빌드를 다시 승격합니다.\n\n롤백은 자동 실행되지 않으며 대상과 영향 범위를 확인한 뒤 운영자가 명시적으로 수행합니다.\n`;
}

export async function writeCommercialReleaseSeal(report, {
  outputDir = resolve('dist', 'commercial-release')
} = {}) {
  const jsonPath = join(outputDir, 'commercial-release-seal.json');
  const markdownPath = join(outputDir, 'commercial-release-seal.md');
  const hashPath = join(outputDir, 'commercial-release-seal.sha256');
  const rollbackPath = join(outputDir, 'rollback-plan.md');
  await mkdir(outputDir, { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    writeFile(jsonPath, serialized, 'utf8'),
    writeFile(markdownPath, renderMarkdown(report), 'utf8'),
    writeFile(hashPath, `${createHash('sha256').update(serialized).digest('hex')}  commercial-release-seal.json\n`, 'utf8'),
    writeFile(rollbackPath, renderRollback(report), 'utf8')
  ]);
  return { jsonPath, markdownPath, hashPath, rollbackPath };
}

async function runCli() {
  const report = await createCommercialReleaseSeal();
  const artifacts = await writeCommercialReleaseSeal(report);
  console.log(JSON.stringify({
    status: report.status,
    releaseId: report.releaseId,
    blockerCount: report.summary.blockerCount,
    artifacts
  }, null, 2));
  if (report.status !== 'sealed-commercial-release') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS commercial release seal failed: ${error.message}`);
    process.exit(1);
  });
}
