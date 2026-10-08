import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileDeviceEvidencePassed } from '../scripts/product-completion-ledger.mjs';

test('product ledger accepts current mobile device evidence', () => {
  assert.equal(mobileDeviceEvidencePassed({
    status: 'passed',
    actualDeviceVerified: true
  }), true);
});

test('product ledger accepts only integrity-verified retained mobile evidence', () => {
  const report = {
    status: 'passed-retained-evidence',
    actualDeviceVerified: true,
    evidenceSource: 'retained-last-passed',
    retainedEvidence: {
      status: 'valid',
      fingerprintMatches: true,
      screenshotIntegrity: { passed: true }
    }
  };

  assert.equal(mobileDeviceEvidencePassed(report), true);
  assert.equal(mobileDeviceEvidencePassed({
    ...report,
    retainedEvidence: { ...report.retainedEvidence, fingerprintMatches: false }
  }), false);
  assert.equal(mobileDeviceEvidencePassed({
    ...report,
    retainedEvidence: { ...report.retainedEvidence, screenshotIntegrity: { passed: false } }
  }), false);
  assert.equal(mobileDeviceEvidencePassed({ ...report, actualDeviceVerified: false }), false);
});
