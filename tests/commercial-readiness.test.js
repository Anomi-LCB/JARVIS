import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommercialReadiness } from '../scripts/commercial-readiness-audit.mjs';

function readySupportBundle() {
  return {
    reportVersion: 'jarvis-product-support-bundle-v1',
    runtime: { status: 'ready', healthyCount: 4, serviceCount: 4 },
    evidence: {
      deterministicTests: { status: 'passed' },
      systemIntegrity: { status: 'passed' },
      coreInstaller: { status: 'passed', signatureStatus: 'authenticode-verified' },
      pcInstaller: { status: 'passed', signatureStatus: 'authenticode-verified' },
      finalRelease: { status: 'passed' },
      mobileRelease: { status: 'passed' },
      wearableField: { status: 'passed' },
      llm: { status: 'passed', liveVerified: true }
    },
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

const finalizedDocuments = [
  { id: 'license', present: true, placeholder: false, approved: true },
  { id: 'privacy', present: true, placeholder: false, approved: true },
  { id: 'eula', present: true, placeholder: false, approved: true },
  { id: 'changelog', present: true, placeholder: false, approved: true }
];

test('commercial audit never approves paid distribution when legal artifacts are missing', () => {
  const report = evaluateCommercialReadiness({
    supportBundle: readySupportBundle(),
    packageManifest: { version: '1.0.0', license: 'UNLICENSED' },
    documents: [],
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'release-candidate');
  assert.equal(report.score, 90);
  assert.equal(report.commercialReady, false);
  assert.equal(report.summary.distributionBlockerCount, 4);
  assert.equal(report.truthPolicy.legalDocumentsCannotBeAutoApproved, true);
});

test('commercial audit classifies external device and release blockers as internal beta', () => {
  const supportBundle = readySupportBundle();
  supportBundle.evidence.finalRelease.status = 'blocked-field-validation';
  supportBundle.evidence.mobileRelease.status = 'external-blocked';
  supportBundle.evidence.wearableField.status = 'blocked';
  supportBundle.evidence.llm = { status: 'ready-unverified', liveVerified: false };
  const report = evaluateCommercialReadiness({
    supportBundle,
    packageManifest: { version: '1.0.0', license: 'Commercial' },
    documents: finalizedDocuments,
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'internal-beta');
  assert.equal(report.claims.internalPilotReady, true);
  assert.equal(report.claims.technicalReleaseCandidate, false);
  assert.equal(report.commercialReady, false);
  assert.deepEqual(report.blockers.map((item) => item.id), [
    'release:final-gate',
    'release:mobile',
    'release:wearable-field',
    'provider:llm-live'
  ]);
});

test('commercial audit requires every technical and distribution check for approval', () => {
  const report = evaluateCommercialReadiness({
    supportBundle: readySupportBundle(),
    packageManifest: { version: '1.0.0', license: 'Commercial' },
    documents: finalizedDocuments,
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'commercial-ready');
  assert.equal(report.score, 100);
  assert.equal(report.commercialReady, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.checks.reduce((total, item) => total + item.weight, 0), 100);
});

test('commercial audit rejects unsigned Windows packages even when installers pass', () => {
  const supportBundle = readySupportBundle();
  supportBundle.evidence.coreInstaller.signatureStatus = 'unsigned-local-build';
  supportBundle.evidence.pcInstaller.signatureStatus = 'signed-local-dev-digest';
  const report = evaluateCommercialReadiness({
    supportBundle,
    packageManifest: { version: '1.0.0', license: 'Commercial' },
    documents: finalizedDocuments,
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'internal-beta');
  assert.equal(report.score, 94);
  assert.equal(report.commercialReady, false);
  assert.deepEqual(report.blockers.map((item) => item.id), [
    'signing:core-windows',
    'signing:pc-agent-windows'
  ]);
});
