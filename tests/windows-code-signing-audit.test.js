import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateWindowsCodeSigning,
  windowsSigningArtifacts
} from '../scripts/windows-code-signing-audit.mjs';

function verifiedObservation(definition) {
  return {
    id: definition.id,
    exists: true,
    authenticodeStatus: 'Valid',
    signerPresent: true,
    timestamped: true,
    selfSigned: false,
    codeSigningEku: true,
    chainTrusted: true,
    onlineRevocationChecked: true,
    publicKeyAlgorithm: 'RSA',
    publicKeySize: 3072,
    timestampChainTrusted: true,
    timestampRevocationChecked: true,
    sha256: 'a'.repeat(64),
    inspection: 'completed'
  };
}

function verifiedSigningRelease(definitions = windowsSigningArtifacts) {
  return {
    status: 'verification-pending',
    artifacts: definitions.map((definition) => ({
      id: definition.id,
      passed: true,
      sha256: 'a'.repeat(64),
      fileDigestAlgorithm: 'SHA256',
      timestampProtocol: 'RFC3161',
      timestampDigestAlgorithm: 'SHA256'
    }))
  };
}

test('Windows signing audit requires every production Authenticode property', () => {
  const report = evaluateWindowsCodeSigning({
    observations: windowsSigningArtifacts.map(verifiedObservation),
    signingRelease: verifiedSigningRelease(),
    platform: 'win32',
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.summary.verifiedArtifactCount, 5);
  assert.deepEqual(windowsSigningArtifacts.map((artifact) => artifact.id), [
    'core-service-host',
    'pc-agent-tray',
    'pc-agent-service-host',
    'pc-agent-runtime-integrity',
    'pc-agent-installer'
  ]);
  assert.equal(report.groups.find((group) => group.id === 'core-windows')?.status, 'passed');
  assert.equal(report.groups.find((group) => group.id === 'pc-agent-windows')?.status, 'passed');
  assert.deepEqual(report.privacy, {
    artifactPathsIncluded: false,
    certificateSubjectsIncluded: false,
    certificateThumbprintsIncluded: false,
    privateKeyMaterialIncluded: false
  });
});

test('Windows signing audit blocks self-signed, untimestamped, and missing artifacts', () => {
  const observations = windowsSigningArtifacts.map(verifiedObservation);
  observations[0].authenticodeStatus = 'NotSigned';
  observations[0].signerPresent = false;
  observations[1].selfSigned = true;
  observations[2].timestamped = false;
  const report = evaluateWindowsCodeSigning({
    observations,
    signingRelease: verifiedSigningRelease(),
    platform: 'win32',
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.summary.blockerCount, 3);
  assert.equal(report.groups.find((group) => group.id === 'core-windows')?.status, 'blocked');
  assert.equal(report.groups.find((group) => group.id === 'pc-agent-windows')?.status, 'blocked');
  assert.equal(report.groups[0].artifacts[0].blockers.includes('signature-invalid-or-missing'), true);
  assert.equal(report.groups[1].artifacts[0].blockers.includes('self-signed-certificate'), true);
  assert.equal(report.groups[1].artifacts[1].blockers.includes('trusted-timestamp-missing'), true);
});

test('Windows signing audit fails closed off Windows', () => {
  const report = evaluateWindowsCodeSigning({
    observations: windowsSigningArtifacts.map(verifiedObservation),
    signingRelease: verifiedSigningRelease(),
    platform: 'linux',
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.summary.verifiedArtifactCount, 0);
  assert.equal(report.groups.every((group) => group.artifacts.every((artifact) => artifact.blockers.includes('windows-host-required'))), true);
});

test('Windows signing audit blocks weak keys, missing online revocation, and stale signing provenance', () => {
  const observations = windowsSigningArtifacts.map(verifiedObservation);
  observations[0].publicKeySize = 1024;
  observations[1].onlineRevocationChecked = false;
  observations[2].timestampChainTrusted = false;
  const signingRelease = verifiedSigningRelease();
  signingRelease.artifacts[3].sha256 = 'b'.repeat(64);

  const report = evaluateWindowsCodeSigning({
    observations,
    signingRelease,
    platform: 'win32',
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.groups[0].artifacts[0].blockers.includes('unsupported-public-key-policy'), true);
  assert.equal(report.groups[1].artifacts[0].blockers.includes('online-revocation-check-missing'), true);
  assert.equal(report.groups[1].artifacts[1].blockers.includes('timestamp-chain-untrusted'), true);
  assert.equal(report.groups[1].artifacts[2].blockers.includes('rfc3161-signing-provenance-missing-or-mismatched'), true);
});
