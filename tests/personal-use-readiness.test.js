import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePersonalUseReadiness } from '../scripts/personal-use-readiness.mjs';

test('personal readiness stays independent from commercial signing and legal release gates', () => {
  const report = evaluatePersonalUseReadiness({
    supportBundle: supportFixture({ paidDistributionReady: false, llmLiveVerified: true }),
    ownerSessionContractReady: true,
    clock: () => new Date('2026-08-21T00:00:00.000Z')
  });
  assert.equal(report.status, 'local-prerequisites-ready');
  assert.equal(report.prerequisitesReady, true);
  assert.equal(report.personalReady, null);
  assert.equal(report.advancedAiReady, null);
  assert.equal(report.liveModelConnectionVerified, true);
  assert.equal(report.commercialDistributionReady, false);
  assert.equal(report.truthPolicy.missingCommercialLegalDocumentsBlockPersonalLocalUse, false);
  assert.equal(report.truthPolicy.lawOrThirdPartyTermsCanBeDisabledBySoftware, false);
  assert.equal(report.personalOwnerMode.perActionApprovalStillRequired.includes('external_transfer'), true);
  assert.equal(report.checks.every((item) => item.evidenceFresh !== false), true);
});

test('personal readiness fails closed when a local runtime or integrity prerequisite is missing', () => {
  const supportBundle = supportFixture({ paidDistributionReady: false, llmLiveVerified: false });
  supportBundle.runtime.status = 'degraded';
  supportBundle.evidence.systemIntegrity.status = 'failed';
  const report = evaluatePersonalUseReadiness({
    supportBundle,
    ownerSessionContractReady: true,
    clock: () => new Date('2026-08-21T00:00:00.000Z')
  });
  assert.equal(report.status, 'personal-attention-required');
  assert.equal(report.personalReady, false);
  assert.equal(report.advancedAiReady, false);
  assert.deepEqual(report.blockers.map((item) => item.id), [
    'runtime-identities-ready',
    'integrity-audit-passed'
  ]);
});

test('personal readiness rejects stale test, integrity, and installer evidence', () => {
  const now = new Date('2026-09-27T00:00:00.000Z');
  const supportBundle = supportFixture({ paidDistributionReady: false, llmLiveVerified: true });
  supportBundle.evidence.deterministicTests.generatedAt = '2026-09-18T00:00:00.000Z';
  supportBundle.evidence.systemIntegrity.generatedAt = '2026-09-02T00:00:00.000Z';
  supportBundle.evidence.coreInstaller.generatedAt = '2026-05-01T00:00:00.000Z';
  supportBundle.evidence.pcInstaller.generatedAt = '2026-05-01T00:00:00.000Z';
  const report = evaluatePersonalUseReadiness({
    supportBundle,
    ownerSessionContractReady: true,
    clock: () => now
  });
  assert.equal(report.personalReady, false);
  assert.deepEqual(report.blockers.map((item) => item.id), [
    'deterministic-tests-passed',
    'integrity-audit-passed',
    'core-local-package-passed',
    'pc-agent-local-package-passed'
  ]);
});

function supportFixture({ paidDistributionReady, llmLiveVerified }) {
  const generatedAt = '2026-08-20T12:00:00.000Z';
  return {
    runtime: { status: 'ready' },
    evidence: {
      deterministicTests: { status: 'passed', generatedAt },
      systemIntegrity: { status: 'passed', generatedAt },
      coreInstaller: { status: 'passed', generatedAt },
      pcInstaller: { status: 'passed', generatedAt },
      llm: { liveVerified: llmLiveVerified }
    },
    readiness: { paidDistributionReady },
    issues: [
      { id: 'signing:core-windows', area: 'distribution', message: 'Windows 배포 서명 필요' },
      { id: 'release:mobile', area: 'distribution', message: '모바일 배포 서명 필요' }
    ]
  };
}
