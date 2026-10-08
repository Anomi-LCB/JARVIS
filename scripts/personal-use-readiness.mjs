import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PersonalOwnerSessionManager } from '../packages/core/src/security/personal-owner-session.js';
import { createProductSupportBundle } from './product-support-bundle.mjs';

export function evaluatePersonalUseReadiness({ supportBundle, ownerSessionContractReady = true, clock = () => new Date() } = {}) {
  const evidence = supportBundle?.evidence ?? {};
  const now = clock();
  const checks = [
    check('runtime-identities-ready', supportBundle?.runtime?.status === 'ready', 'Core, PC Agent, Bridge, UI 서비스 정체성'),
    freshEvidenceCheck('deterministic-tests-passed', evidence.deterministicTests, '전체 자동 테스트', 7 * DAY_MS, now),
    freshEvidenceCheck('integrity-audit-passed', evidence.systemIntegrity, '시스템 무결성 감사', 14 * DAY_MS, now),
    freshEvidenceCheck('core-local-package-passed', evidence.coreInstaller, 'Core 로컬 설치 패키지', 90 * DAY_MS, now),
    freshEvidenceCheck('pc-agent-local-package-passed', evidence.pcInstaller, 'PC Agent 로컬 설치 패키지', 90 * DAY_MS, now),
    check('personal-owner-session-contract-ready', ownerSessionContractReady === true, '시간 제한 소유자 세션 계약')
  ];
  const blockers = checks.filter((item) => !item.passed);
  const distributionDeferrals = (supportBundle?.issues ?? [])
    .filter((issue) => issue.area === 'distribution')
    .map((issue) => ({ id: issue.id, message: issue.message }));
  const prerequisitesReady = blockers.length === 0;
  // Passing package/health/test checks does not observe a user's task outcome.
  // null is deliberately distinct from both an observed success and a blocker.
  const personalReady = prerequisitesReady ? null : false;
  const liveModelConnectionVerified = supportBundle?.evidence?.llm?.liveVerified === true;
  return {
    reportVersion: 'jarvis-personal-use-readiness-v2',
    generatedAt: now.toISOString(),
    status: prerequisitesReady ? 'local-prerequisites-ready' : 'personal-attention-required',
    prerequisitesReady,
    personalReady,
    advancedAiReady: prerequisitesReady && liveModelConnectionVerified ? null : false,
    liveModelConnectionVerified,
    assessmentScope: 'local-prerequisites-only',
    acceptance: supportBundle?.acceptance ?? null,
    commercialDistributionReady: supportBundle?.readiness?.paidDistributionReady === true,
    score: Math.round((checks.filter((item) => item.passed).length / checks.length) * 100),
    checks,
    blockers,
    capabilities: {
      localPcControl: null,
      localFileAndDocumentWork: null,
      boundedAutonomousMissions: null,
      highImpactOwnerSession: null,
      liveLlmPlanning: null
    },
    personalOwnerMode: {
      maximumDurationMinutes: 60,
      defaultDurationMinutes: 30,
      localOnly: true,
      restartRevokesSession: true,
      repeatedApprovalCovered: ['read_only', 'local_reversible', 'high_impact'],
      perActionApprovalStillRequired: ['external_transfer', 'irreversible_change', 'payment', 'secret_access', 'os_elevation']
    },
    distributionDeferrals,
    truthPolicy: {
      missingCommercialLegalDocumentsBlockPersonalLocalUse: false,
      missingProductionSignaturesBlockSourceBasedPersonalUse: false,
      lawOrThirdPartyTermsCanBeDisabledBySoftware: false,
      ownerModeBypassesOperatingSystemConsent: false,
      ownerModeBypassesExternalAccountPermissions: false,
      prerequisiteScoreIsAcceptanceProgress: false,
      providerProbeProvesMissionPlanning: false,
      capabilityNullMeans: 'not-assessed-by-this-diagnostic'
    }
  };
}

export function personalUseReadinessMarkdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.passed ? '통과' : '확인 필요'} | ${item.label} |`)
    .join('\n');
  const deferrals = report.distributionDeferrals.length > 0
    ? report.distributionDeferrals.map((item) => `- ${item.message} (${item.id})`).join('\n')
    : '- 없음';
  return `# JARVIS 개인 사용 준비도\n\n- 판정: ${report.status}\n- 로컬 사전 조건: ${report.prerequisitesReady ? '준비됨' : '확인 필요'}\n- 실사용 인수: ${report.personalReady === null ? '미검증' : '사전 조건 미충족'}\n- 모델 연결 관측: ${report.liveModelConnectionVerified ? '기존 실호출 증거 있음; 업무 계획 품질은 별도 검증' : '실호출 확인 필요'}\n- 유료 배포: ${report.commercialDistributionReady ? '준비됨' : '별도 검증 진행 중'}\n- 사전 조건 점수: ${report.score}/100 (전체 인수율이 아님)\n- 공식 인수 원장: ${report.acceptance?.status === 'available' ? `${report.acceptance.counts.verified}/${report.acceptance.total}; 원장 기록이며 독립 재검증이 아님` : '조회되지 않음'}\n\n## 필수 검증\n\n| 결과 | 기준 |\n| --- | --- |\n${rows}\n\n## 개인 사용과 분리된 배포 항목\n\n${deferrals}\n\n이 진단은 서비스·테스트·패키지 사전 조건을 검사합니다. PC 제어, 문서 품질, 장기 자율 운영과 모델 계획 능력은 실제 업무 결과로 별도 검증해야 합니다. null 능력 값은 이 진단에서 미평가라는 뜻입니다. 소유자 모드는 법률, 운영체제 동의, 타인 계정 권한을 우회하지 않습니다. 외부 전송과 되돌릴 수 없는 작업은 실제 위임 범위를 따릅니다.\n`;
}

export async function createPersonalUseReadinessAudit({
  workspaceRoot = resolve('.'),
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date()
} = {}) {
  const supportBundle = await createProductSupportBundle({ workspaceRoot, env, fetchImpl, clock });
  const ownerSessionStatus = new PersonalOwnerSessionManager({ clock }).status();
  return evaluatePersonalUseReadiness({
    supportBundle,
    ownerSessionContractReady: ownerSessionStatus.statusVersion === 'a-personal-owner-session-status-v1'
      && ownerSessionStatus.protections?.loopbackOnly === true,
    clock
  });
}

export async function writePersonalUseReadinessAudit(report, {
  jsonPath = resolve('dist', 'personal-use-readiness.json'),
  markdownPath = resolve('dist', 'personal-use-readiness.md')
} = {}) {
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, personalUseReadinessMarkdown(report), 'utf8')
  ]);
  return { jsonPath, markdownPath };
}

async function runCli() {
  const report = await createPersonalUseReadinessAudit();
  const artifacts = await writePersonalUseReadinessAudit(report);
  console.log(JSON.stringify({
    status: report.status,
    personalReady: report.personalReady,
    advancedAiReady: report.advancedAiReady,
    commercialDistributionReady: report.commercialDistributionReady,
    prerequisitesReady: report.prerequisitesReady,
    score: report.score,
    artifacts
  }, null, 2));
  process.exitCode = report.prerequisitesReady ? 0 : 1;
}

function check(id, passed, label) {
  return { id, passed: passed === true, label };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function freshEvidenceCheck(id, report, label, maxAgeMs, now) {
  const observedAt = typeof report?.generatedAt === 'string' ? report.generatedAt : null;
  const observedTime = observedAt ? Date.parse(observedAt) : NaN;
  const ageMs = Number.isFinite(observedTime) ? now.getTime() - observedTime : null;
  const fresh = ageMs !== null && ageMs >= 0 && ageMs <= maxAgeMs;
  return {
    ...check(id, report?.status === 'passed' && fresh, label),
    evidenceStatus: report?.status ?? 'not-generated',
    observedAt,
    evidenceFresh: fresh,
    ageMs,
    maxAgeMs
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS personal use readiness failed: ${error.message}`);
    process.exit(1);
  });
}
