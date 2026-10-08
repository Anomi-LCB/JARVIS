import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProductSupportBundle } from './product-support-bundle.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionDocuments = [
  { id: 'license', path: 'LICENSE', title: '배포 라이선스', weight: 4 },
  { id: 'privacy', path: 'PRIVACY.md', title: '개인정보 처리방침', weight: 3 },
  { id: 'eula', path: 'EULA.md', title: '최종 사용자 사용권 계약', weight: 2 },
  { id: 'changelog', path: 'CHANGELOG.md', title: '변경 이력', weight: 1 }
];

async function inspectDocument(workspaceRoot, definition) {
  try {
    const [metadata, content] = await Promise.all([
      stat(join(workspaceRoot, definition.path)),
      readFile(join(workspaceRoot, definition.path), 'utf8')
    ]);
    return {
      ...definition,
      present: metadata.isFile() && content.trim().length >= 40,
      placeholder: /\bTODO\b|작성 필요|확정 필요|PLACEHOLDER|YOUR COMPANY/i.test(content),
      approved: definition.id === 'changelog' || /^Legal-Review-Status:\s*approved\s*$/im.test(content)
    };
  } catch {
    return { ...definition, present: false, placeholder: false, approved: false };
  }
}

function passedStatus(value, accepted = ['passed']) {
  return accepted.includes(String(value ?? 'not-generated'));
}

function productionSignatureVerified(value) {
  return ['authenticode-verified', 'signed-and-verified'].includes(String(value ?? 'not-generated'));
}

function check(id, title, weight, passed, detail, remediation, category = 'technical') {
  return { id, title, weight, passed: passed === true, category, detail, remediation };
}

export function evaluateCommercialReadiness({ supportBundle, packageManifest, documents, clock = () => new Date() }) {
  const evidence = supportBundle.evidence;
  const documentById = new Map((documents ?? []).map((document) => [document.id, document]));
  const resolvedDocuments = distributionDocuments.map((definition) => ({
    ...definition,
    present: false,
    placeholder: false,
    approved: definition.id === 'changelog',
    ...(documentById.get(definition.id) ?? {})
  }));
  const checks = [
    check('runtime:identity', '모든 로컬 서비스가 올바른 JARVIS 정체성으로 응답한다.', 11,
      supportBundle.runtime.status === 'ready' && supportBundle.runtime.healthyCount === supportBundle.runtime.serviceCount,
      `${supportBundle.runtime.healthyCount}/${supportBundle.runtime.serviceCount}`,
      'npm start 후 npm run product:status를 실행해 모든 서비스 정체성을 검증합니다.'),
    check('verification:tests', '결정론적 전체 테스트가 통과했다.', 11,
      passedStatus(evidence.deterministicTests.status), evidence.deterministicTests.status,
      'npm test를 실행하고 실패한 회귀 테스트를 해결합니다.'),
    check('verification:integrity', '시스템 무결성 감사가 통과했다.', 9,
      passedStatus(evidence.systemIntegrity.status), evidence.systemIntegrity.status,
      'npm run ops:integrity-audit를 실행하고 차단 항목을 해결합니다.'),
    check('package:core', 'Core Windows 서비스 배포 패키지가 검증되었다.', 4,
      passedStatus(evidence.coreInstaller.status), evidence.coreInstaller.status,
      'npm run core:service-release를 실행해 설치·복구 증거를 갱신합니다.'),
    check('signing:core-windows', 'Core Windows 실행 파일의 Authenticode 서명이 검증되었다.', 3,
      productionSignatureVerified(evidence.coreInstaller.signatureStatus), evidence.coreInstaller.signatureStatus,
      '코드 서명 인증서로 Core 실행 파일에 Authenticode 서명과 타임스탬프를 적용한 뒤 배포 증거를 갱신합니다.'),
    check('package:pc-agent', 'PC Agent 배포 패키지가 검증되었다.', 4,
      passedStatus(evidence.pcInstaller.status), evidence.pcInstaller.status,
      'npm run pc-agent:install-release를 실행해 설치·복구 증거를 갱신합니다.'),
    check('signing:pc-agent-windows', 'PC Agent Windows 실행 파일의 Authenticode 서명이 검증되었다.', 3,
      productionSignatureVerified(evidence.pcInstaller.signatureStatus), evidence.pcInstaller.signatureStatus,
      '코드 서명 인증서로 PC Agent 실행 파일에 Authenticode 서명과 타임스탬프를 적용한 뒤 배포 증거를 갱신합니다.'),
    check('release:final-gate', '최종 출시 게이트가 통과했다.', 13,
      passedStatus(evidence.finalRelease.status), evidence.finalRelease.status,
      'npm run ops:final-gate의 모든 외부 검증을 완료합니다.'),
    check('release:mobile', '모바일 프로덕션 서명과 배포 사전 검증이 통과했다.', 9,
      passedStatus(evidence.mobileRelease.status), evidence.mobileRelease.status,
      '프로덕션 키스토어와 EAS 자격 증명을 설정한 뒤 npm run mobile:release-preflight를 실행합니다.'),
    check('release:wearable-field', '대상 AI 안경에서 디스플레이·음성·브리지 현장 검증이 통과했다.', 9,
      passedStatus(evidence.wearableField.status, ['passed', 'verified']), evidence.wearableField.status,
      '실제 AI 안경으로 npm run wearable:physical-gate를 완료합니다.'),
    check('provider:llm-live', '실제 LLM 공급자 호출이 검증되었다.', 7,
      evidence.llm.liveVerified === true, evidence.llm.status,
      '유효한 공급자 인증을 설정하고 npm run llm:diagnose -- --live를 실행합니다.'),
    check('support:privacy-safe-bundle', '비밀정보를 제외한 고객 지원 진단 번들이 준비되었다.', 7,
      Object.values(supportBundle.privacy).every((value) => value === false), supportBundle.reportVersion,
      'npm run product:support를 실행하고 개인정보 제외 정책을 확인합니다.'),
    ...resolvedDocuments.map((document) => check(
      `distribution:${document.id}`,
      `${document.title} 문서가 확정되어 있다.`,
      document.weight,
      document.present
        && !document.placeholder
        && document.approved
        && (document.id !== 'license' || packageManifest?.license !== 'UNLICENSED'),
      document.present
        ? document.placeholder
          ? 'placeholder'
          : !document.approved
            ? 'legal-review-not-approved'
            : document.id === 'license'
              ? packageManifest?.license ?? 'present'
              : 'present'
        : 'missing',
      `${document.path}를 제품 소유자와 법률 검토자가 확정합니다.`,
      'distribution'
    ))
  ];
  const score = checks.reduce((total, item) => total + (item.passed ? item.weight : 0), 0);
  const foundationalIds = new Set(['runtime:identity', 'verification:tests', 'verification:integrity', 'package:core', 'package:pc-agent']);
  const technicalChecks = checks.filter((item) => item.category === 'technical');
  const foundationalReady = checks.filter((item) => foundationalIds.has(item.id)).every((item) => item.passed);
  const technicalReady = technicalChecks.every((item) => item.passed);
  const commercialReady = checks.every((item) => item.passed);
  const status = commercialReady
    ? 'commercial-ready'
    : technicalReady
      ? 'release-candidate'
      : foundationalReady
        ? 'internal-beta'
        : 'development';
  const blockers = checks.filter((item) => !item.passed).map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    remediation: item.remediation
  }));

  return {
    reportVersion: 'jarvis-commercial-readiness-audit-v1',
    generatedAt: clock().toISOString(),
    status,
    score,
    commercialReady,
    claims: {
      paidDistributionReady: commercialReady,
      internalPilotReady: foundationalReady,
      technicalReleaseCandidate: technicalReady
    },
    summary: {
      passedChecks: checks.filter((item) => item.passed).length,
      totalChecks: checks.length,
      blockerCount: blockers.length,
      technicalBlockerCount: blockers.filter((item) => item.category === 'technical').length,
      distributionBlockerCount: blockers.filter((item) => item.category === 'distribution').length
    },
    checks,
    blockers,
    truthPolicy: {
      missingEvidenceFailsClosed: true,
      externalValidationCannotBeSimulated: true,
      legalDocumentsCannotBeAutoApproved: true,
      paidDistributionClaimRequiresEveryCheck: true
    }
  };
}

export async function createCommercialReadinessAudit({
  workspaceRoot = repositoryRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  supportBundle = null
} = {}) {
  const [resolvedSupportBundle, packageManifest, documents] = await Promise.all([
    supportBundle ?? createProductSupportBundle({
      workspaceRoot,
      env,
      fetchImpl,
      clock,
      refreshWindowsSigning: true
    }),
    readFile(join(workspaceRoot, 'package.json'), 'utf8').then(JSON.parse),
    Promise.all(distributionDocuments.map((definition) => inspectDocument(workspaceRoot, definition)))
  ]);
  return evaluateCommercialReadiness({ supportBundle: resolvedSupportBundle, packageManifest, documents, clock });
}

export function commercialReadinessMarkdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.passed ? '통과' : '차단'} | ${item.title} | ${item.detail} | ${item.weight} |`)
    .join('\n');
  const blockers = report.blockers.length > 0
    ? report.blockers.map((item) => `- ${item.title}: ${item.remediation}`).join('\n')
    : '- 없음';
  return `# JARVIS 상용 출시 감사\n\n- 판정: ${report.status}\n- 점수: ${report.score}/100\n- 유료 배포 가능: ${report.commercialReady ? '예' : '아니오'}\n- 생성 시각: ${report.generatedAt}\n\n## 검증\n\n| 결과 | 기준 | 증거 | 배점 |\n| --- | --- | --- | --- |\n${rows}\n\n## 차단 항목\n\n${blockers}\n\n모든 검증이 통과하기 전에는 유료 상용 배포 완료를 주장하지 않습니다.\n`;
}

export async function writeCommercialReadinessAudit(report, {
  jsonPath = resolve('dist', 'commercial-readiness-audit.json'),
  markdownPath = resolve('dist', 'commercial-readiness-audit.md')
} = {}) {
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, commercialReadinessMarkdown(report), 'utf8')
  ]);
  return { jsonPath, markdownPath };
}

async function runCli() {
  const report = await createCommercialReadinessAudit();
  const artifacts = await writeCommercialReadinessAudit(report);
  console.log(JSON.stringify({
    status: report.status,
    score: report.score,
    commercialReady: report.commercialReady,
    blockerCount: report.blockers.length,
    artifacts
  }, null, 2));
  process.exitCode = report.commercialReady ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS commercial readiness audit failed: ${error.message}`);
    process.exit(1);
  });
}
