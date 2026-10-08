import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicLlmProviderStatus } from './llm-provider-diagnostics.mjs';
import {readAcceptanceProgressSummary} from './acceptance-progress-summary.mjs';
import { probeProductServices, productServiceDefinitions } from './product-runtime.mjs';
import {
  createWindowsCodeSigningAudit,
  writeWindowsCodeSigningAudit
} from './windows-code-signing-audit.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function configured(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

async function readJsonIfPresent(workspaceRoot, relativePath) {
  try {
    return JSON.parse(await readFile(join(workspaceRoot, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

function reportStatus(report) {
  return typeof report?.status === 'string' ? report.status : 'not-generated';
}

function packageSignatureStatus(signingAudit, groupId) {
  const group = (signingAudit?.groups ?? []).find((candidate) => candidate.id === groupId);
  if (!group) return 'not-generated';
  return group.status === 'passed' ? 'authenticode-verified' : 'authenticode-not-verified';
}

function productionSignatureVerified(status) {
  return ['authenticode-verified', 'signed-and-verified'].includes(status);
}

function failedCheckIds(report) {
  return (report?.checks ?? [])
    .filter((check) => check?.passed === false)
    .map((check) => check.checkId ?? check.id)
    .filter(Boolean);
}

function serviceTransport(endpoint) {
  try {
    const url = new URL(endpoint);
    return {
      transport: ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ? 'loopback' : 'local-network',
      port: Number(url.port) || null
    };
  } catch {
    return { transport: 'unknown', port: null };
  }
}

function runtimeIssue(service) {
  return {
    id: `runtime:${service.id}`,
    area: 'runtime',
    severity: 'blocking',
    message: `${service.label} 서비스가 JARVIS 정체성 검증에 응답하지 않습니다.`
  };
}

function evidenceIssue(id, area, message, severity = 'blocking') {
  return { id, area, severity, message };
}

async function refreshedWindowsSigningAudit(workspaceRoot, clock) {
  const report = await createWindowsCodeSigningAudit({ workspaceRoot, clock });
  await writeWindowsCodeSigningAudit(report, {
    jsonPath: join(workspaceRoot, 'dist', 'windows-code-signing-audit.json'),
    markdownPath: join(workspaceRoot, 'dist', 'windows-code-signing-audit.md')
  });
  return report;
}

export async function createProductSupportBundle({
  workspaceRoot = repositoryRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  definitions = productServiceDefinitions({ env, cwd: workspaceRoot }),
  windowsSigningReport = undefined,
  refreshWindowsSigning = false
} = {}) {
  const generatedAt = clock().toISOString();
  const [
    packageManifest,
    runtime,
    finalRelease,
    mobileRelease,
    wearableField,
    wearableNonAcoustic,
    integrity,
    deterministicTests,
    coreInstaller,
    pcInstaller,
    llmReport,
    completionLedger,
    resolvedWindowsSigningReport
  ] = await Promise.all([
    readJsonIfPresent(workspaceRoot, 'package.json'),
    probeProductServices({ definitions, fetchImpl }),
    readJsonIfPresent(workspaceRoot, join('dist', 'final-release-gate.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'mobile-release-preflight-report.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'wearable-physical-field-gate.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'wearable-non-acoustic-audit.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'system-integrity-audit-report.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'test-run-report.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'core-service-release-dossier.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'pc-agent-install-release-dossier.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'llm-provider-diagnostics.json')),
    readJsonIfPresent(workspaceRoot, join('dist', 'product-completion-ledger.json')),
    windowsSigningReport !== undefined
      ? Promise.resolve(windowsSigningReport)
      : refreshWindowsSigning
        ? refreshedWindowsSigningAudit(workspaceRoot, clock)
        : readJsonIfPresent(workspaceRoot, join('dist', 'windows-code-signing-audit.json'))
  ]);

  const acceptance = await readAcceptanceProgressSummary(workspaceRoot);
  const llm = createPublicLlmProviderStatus(llmReport);
  const googleCredentialFilePresent = existsSync(join(env.USERPROFILE ?? env.HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '', '.jarvis', 'google-oauth.dpapi.json'));
  const googleConfigured = [env.JARVIS_GOOGLE_CLIENT_ID, env.JARVIS_GOOGLE_CLIENT_SECRET, env.JARVIS_GOOGLE_REFRESH_TOKEN].every(configured)
    || googleCredentialFilePresent;
  const smtpConfigured = configured(env.JARVIS_SMTP_USER) && configured(env.JARVIS_SMTP_PASS);
  const services = runtime.services.map((service) => ({
    id: service.id,
    label: service.label,
    healthy: service.healthy,
    identityVerified: service.identityVerified,
    ...serviceTransport(service.endpoint)
  }));
  const releaseBlockingChecks = failedCheckIds(finalRelease);
  const coreSignatureStatus = packageSignatureStatus(resolvedWindowsSigningReport, 'core-windows');
  const pcSignatureStatus = packageSignatureStatus(resolvedWindowsSigningReport, 'pc-agent-windows');
  const mobileBlockers = (mobileRelease?.blockers ?? []).map((blocker) => ({
    id: blocker.id,
    severity: blocker.severity ?? 'blocking'
  }));
  const issues = [
    ...services.filter((service) => !service.healthy || !service.identityVerified).map(runtimeIssue)
  ];

  if (reportStatus(deterministicTests) !== 'passed') {
    issues.push(evidenceIssue('verification:tests', 'verification', '전체 자동 테스트 통과 증거가 없습니다.'));
  }
  if (reportStatus(integrity) !== 'passed') {
    issues.push(evidenceIssue('verification:integrity', 'verification', '시스템 무결성 감사가 통과하지 않았습니다.'));
  }
  if (reportStatus(coreInstaller) !== 'passed') {
    issues.push(evidenceIssue('package:core', 'packaging', 'Core 서비스 배포 패키지 검증이 필요합니다.'));
  }
  if (reportStatus(pcInstaller) !== 'passed') {
    issues.push(evidenceIssue('package:pc-agent', 'packaging', 'PC Agent 배포 패키지 검증이 필요합니다.'));
  }
  if (!productionSignatureVerified(coreSignatureStatus)) {
    issues.push(evidenceIssue('signing:core-windows', 'distribution', 'Core Windows 실행 파일의 Authenticode 서명 검증이 필요합니다.'));
  }
  if (!productionSignatureVerified(pcSignatureStatus)) {
    issues.push(evidenceIssue('signing:pc-agent-windows', 'distribution', 'PC Agent Windows 실행 파일의 Authenticode 서명 검증이 필요합니다.'));
  }
  if (reportStatus(finalRelease) !== 'passed') {
    issues.push(evidenceIssue('release:final-gate', 'distribution', '최종 출시 게이트에 미완료 검증이 남아 있습니다.'));
  }
  if (reportStatus(mobileRelease) !== 'passed') {
    issues.push(evidenceIssue('release:mobile', 'distribution', '모바일 프로덕션 서명 또는 실기기 출시 검증이 남아 있습니다.'));
  }
  if (!['passed', 'verified'].includes(reportStatus(wearableField))) {
    issues.push(evidenceIssue('release:wearable-field', 'distribution', 'AI 안경 물리 장치 현장 검증이 남아 있습니다.'));
  }
  if (!llm.liveVerified) {
    issues.push(evidenceIssue('provider:llm-live', 'provider', '실제 LLM 공급자 호출이 아직 검증되지 않았습니다.', 'warning'));
  }

  const foundationalReady = runtime.status === 'ready'
    && reportStatus(deterministicTests) === 'passed'
    && reportStatus(integrity) === 'passed'
    && reportStatus(coreInstaller) === 'passed'
    && reportStatus(pcInstaller) === 'passed';
  const personalLocalUseReady = foundationalReady ? null : false;
  const advancedAiReady = foundationalReady && llm.liveVerified ? null : false;
  const windowsSigningReady = productionSignatureVerified(coreSignatureStatus)
    && productionSignatureVerified(pcSignatureStatus);
  const distributionReady = windowsSigningReady
    && reportStatus(finalRelease) === 'passed'
    && reportStatus(mobileRelease) === 'passed'
    && ['passed', 'verified'].includes(reportStatus(wearableField))
    && llm.liveVerified;
  const supportId = createHash('sha256')
    .update([generatedAt, packageManifest?.version ?? 'unknown', runtime.status, issues.map((issue) => issue.id).join('|')].join(':'))
    .digest('hex')
    .slice(0, 16);

  return {
    reportVersion: 'jarvis-product-support-bundle-v2',
    generatedAt,
    supportId,
    status: foundationalReady ? (issues.length === 0 ? 'ready' : 'ready-with-limitations') : 'attention-required',
    product: {
      name: 'JARVIS',
      packageName: packageManifest?.name ?? null,
      version: packageManifest?.version ?? null
    },
    system: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version
    },
    runtime: {
      status: runtime.status,
      serviceCount: services.length,
      healthyCount: services.filter((service) => service.healthy && service.identityVerified).length,
      services
    },
    configuration: {
      anthropicApiConfigured: configured(env.JARVIS_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY),
      openAiApiConfigured: configured(env.JARVIS_OPENAI_API_KEY ?? env.OPENAI_API_KEY),
      googleCredentialFilePresent,
      googleEnvironmentCredentialsConfigured: [env.JARVIS_GOOGLE_CLIENT_ID, env.JARVIS_GOOGLE_CLIENT_SECRET, env.JARVIS_GOOGLE_REFRESH_TOKEN].every(configured),
      smtpCredentialsConfigured: smtpConfigured,
      artemisEndpointConfigured: configured(env.JARVIS_ARTEMIS_BASE_URL),
      productionAndroidSigningConfigured: [
        env.JARVIS_ANDROID_KEYSTORE_PATH,
        env.JARVIS_ANDROID_KEYSTORE_PASSWORD,
        env.JARVIS_ANDROID_KEY_ALIAS,
        env.JARVIS_ANDROID_KEY_PASSWORD
      ].every(configured),
      easDistributionConfigured: configured(env.EXPO_TOKEN) && configured(env.JARVIS_EAS_PROJECT_ID),
      valuesIncluded: false
    },
    integrationReadiness: [
      {
        id: 'google-workspace-read',
        capability: 'Gmail and Google Calendar read-only sync',
        implementation: 'implemented',
        credentialState: googleConfigured ? 'credential-present' : 'not-connected',
        liveVerification: 'not-verified',
        writable: false,
        nextRequirement: googleConfigured ? 'Run a bounded live read-only sync and verify account identity, scope, and cursor.' : 'Provide a Desktop OAuth client file and complete local browser consent.'
      },
      {
        id: 'smtp-email-send',
        capability: 'Approval-gated outbound email',
        implementation: 'implemented',
        credentialState: smtpConfigured ? 'credential-configured' : 'not-configured',
        liveVerification: 'not-verified',
        writable: true,
        nextRequirement: smtpConfigured ? 'Use an explicitly authorized self-addressed test and verify provider acceptance.' : 'Configure a provider-supported SMTP credential in the local secret store.'
      },
      {
        id: 'android-artemis',
        capability: 'Android UI operation through ARTEMIS',
        implementation: 'adapter-and-diagnostics-implemented',
        credentialState: configured(env.JARVIS_ARTEMIS_BASE_URL) ? 'endpoint-configured' : 'local-endpoint-defaulted',
        liveVerification: 'not-verified',
        writable: true,
        nextRequirement: 'Start the isolated local ARTEMIS server, pair an explicitly selected Android device, and pass independent postcondition verification.'
      },
      {
        id: 'wearable-physical',
        capability: 'Physical wearable interaction',
        implementation: 'field-client-implemented',
        credentialState: 'device-dependent',
        liveVerification: ['passed', 'verified'].includes(reportStatus(wearableField)) ? 'field-evidence-present' : 'field-verification-blocked',
        writable: true,
        nextRequirement: ['passed', 'verified'].includes(reportStatus(wearableField)) ? 'Recheck field evidence freshness and source fingerprint.' : 'Run the field calibration workflow on the actual wearable and retain fresh evidence.'
      },
      {
        id: 'health-connect',
        capability: 'Health and wearable data import',
        implementation: 'not-integrated',
        credentialState: 'not-connected',
        liveVerification: 'not-available',
        writable: false,
        nextRequirement: 'Implement a scoped Health Connect adapter, obtain device-granted permissions, and verify a synthetic-to-live transition.'
      },
      {
        id: 'smart-home',
        capability: 'Smart-home device control',
        implementation: 'not-integrated',
        credentialState: 'not-connected',
        liveVerification: 'not-available',
        writable: false,
        nextRequirement: 'Select a supported local hub and implement per-device allowlists, state reconciliation, and explicit physical-action grants.'
      },
      {
        id: 'travel-shopping-finance',
        capability: 'Travel booking, purchases, and financial transactions',
        implementation: 'not-integrated',
        credentialState: 'not-connected',
        liveVerification: 'not-available',
        writable: false,
        nextRequirement: 'Choose each provider and country-specific authorized API; never collect bank passwords, card security codes, or one-time codes.'
      }
    ],
    acceptance,
    evidence: {
      deterministicTests: { status: reportStatus(deterministicTests), generatedAt: deterministicTests?.generatedAt ?? null },
      systemIntegrity: { status: reportStatus(integrity), generatedAt: integrity?.generatedAt ?? null },
      windowsCodeSigning: {
        status: reportStatus(resolvedWindowsSigningReport),
        generatedAt: resolvedWindowsSigningReport?.generatedAt ?? null
      },
      coreInstaller: {
        status: reportStatus(coreInstaller),
        signatureStatus: coreSignatureStatus,
        generatedAt: coreInstaller?.generatedAt ?? null
      },
      pcInstaller: {
        status: reportStatus(pcInstaller),
        signatureStatus: pcSignatureStatus,
        generatedAt: pcInstaller?.generatedAt ?? null
      },
      finalRelease: {
        status: reportStatus(finalRelease),
        generatedAt: finalRelease?.generatedAt ?? null,
        blockingChecks: releaseBlockingChecks,
        pendingExternalValidation: finalRelease?.summary?.externalValidationPending ?? null
      },
      mobileRelease: {
        status: reportStatus(mobileRelease),
        generatedAt: mobileRelease?.generatedAt ?? null,
        blockers: mobileBlockers
      },
      wearableField: { status: reportStatus(wearableField), generatedAt: wearableField?.generatedAt ?? null },
      wearableNonAcoustic: {
        status: reportStatus(wearableNonAcoustic),
        generatedAt: wearableNonAcoustic?.generatedAt ?? null,
        passedChecks: wearableNonAcoustic?.checks?.filter((check) => check.passed === true).length ?? 0,
        totalChecks: wearableNonAcoustic?.checks?.length ?? 0,
        pendingPhysicalChecks: wearableNonAcoustic?.pendingChecks?.length ?? null
      },
      completionLedger: {
        isAcceptanceProgress: false,
        status: reportStatus(completionLedger),
        score: Number.isFinite(completionLedger?.score) ? completionLedger.score : null,
        generatedAt: completionLedger?.generatedAt ?? null
      },
      llm
    },
    readiness: {
      foundationalReady,
      assessmentScope: 'local-prerequisites-and-distribution-only',
      prerequisiteEvidenceProvesTaskOutcome: false,
      liveModelConnectionVerified: llm.liveVerified,
      personalLocalUseReady,
      advancedAiReady,
      paidDistributionReady: foundationalReady && distributionReady,
      distributionReady,
      windowsSigningReady,
      legalArtifactsRequiredForPersonalLocalUse: false,
      legalOrThirdPartyRestrictionsBypassed: false
    },
    issues,
    privacy: {
      secretsIncluded: false,
      environmentValuesIncluded: false,
      rawCommandsIncluded: false,
      fileContentsIncluded: false,
      logPayloadsIncluded: false,
      usernamesOrHostnamesIncluded: false,
      exactNetworkAddressesIncluded: false
    }
  };
}

export function productSupportBundleMarkdown(bundle) {
  const serviceRows = bundle.runtime.services
    .map((service) => `| ${service.label} | ${service.healthy && service.identityVerified ? '정상' : '확인 필요'} | ${service.transport}:${service.port ?? '-'} |`)
    .join('\n');
  const issueRows = bundle.issues.length > 0
    ? bundle.issues.map((issue) => `- [${issue.severity}] ${issue.message} (${issue.id})`).join('\n')
    : '- 발견된 문제 없음';
  return `# JARVIS 제품 지원 진단\n\n- 지원 ID: ${bundle.supportId}\n- 생성 시각: ${bundle.generatedAt}\n- 실행 상태: ${bundle.status}\n- 로컬 사전 조건: ${bundle.readiness.foundationalReady ? '준비됨' : '확인 필요'}\n- 개인 실사용·AI 업무 능력: ${bundle.readiness.personalLocalUseReady === null ? '이 진단에서 미검증' : '사전 조건 미충족'}\n- 모델 연결 관측: ${bundle.readiness.liveModelConnectionVerified ? '기존 실호출 증거 있음; 계획 품질은 별도 검증' : '확인 필요'}\n- 공식 인수 원장: ${bundle.acceptance?.status === 'available' ? `${bundle.acceptance.counts.verified}/${bundle.acceptance.total}; 원장 기록이며 독립 재검증이 아님` : '조회되지 않음'}\n- 유료 배포 준비: ${bundle.readiness.paidDistributionReady ? '예' : '아니오'}\n\n## 실행 서비스\n\n| 서비스 | 상태 | 연결 |\n| --- | --- | --- |\n${serviceRows}\n\n## 확인 항목\n\n${issueRows}\n\n사전 조건과 과거 완료 장부 점수는 전체 인수율 또는 실제 업무 성공 증거가 아닙니다.\n\n## 개인정보 보호\n\n이 번들에는 비밀키, 환경변수 값, 사용자 명령, 파일 내용, 원시 로그, 사용자명, 호스트명, 정확한 네트워크 주소가 포함되지 않습니다.\n`;
}

export async function writeProductSupportBundle(bundle, {
  jsonPath = resolve('dist', 'support', 'jarvis-support-bundle.json'),
  markdownPath = resolve('dist', 'support', 'jarvis-support-bundle.md')
} = {}) {
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, productSupportBundleMarkdown(bundle), 'utf8')
  ]);
  return { jsonPath, markdownPath };
}

async function runCli() {
  const bundle = await createProductSupportBundle({ refreshWindowsSigning: true });
  const artifacts = await writeProductSupportBundle(bundle);
  console.log(JSON.stringify({
    status: bundle.status,
    supportId: bundle.supportId,
    runtime: bundle.runtime.status,
    personalLocalUseReady: bundle.readiness.personalLocalUseReady,
    paidDistributionReady: bundle.readiness.paidDistributionReady,
    issueCount: bundle.issues.length,
    artifacts
  }, null, 2));
  process.exitCode = bundle.status === 'attention-required' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS support diagnostic failed: ${error.message}`);
    process.exit(1);
  });
}
