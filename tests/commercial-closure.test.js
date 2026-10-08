import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateCommercialClosure,
  writeCommercialClosure
} from '../scripts/commercial-closure.mjs';

const blockedChecks = [
  ['signing:core-windows', 3],
  ['signing:pc-agent-windows', 3],
  ['release:final-gate', 13],
  ['release:mobile', 9],
  ['release:wearable-field', 9],
  ['distribution:license', 4],
  ['distribution:privacy', 3],
  ['distribution:eula', 2]
];

function commercialFixture({ ready = false } = {}) {
  return {
    score: ready ? 100 : 54,
    commercialReady: ready,
    checks: [
      ...blockedChecks.map(([id, weight]) => ({ id, weight, passed: ready })),
      { id: 'runtime:identity', weight: ready ? 54 : 0, passed: true }
    ]
  };
}

test('commercial closure accounts for every point from 54 to 100', () => {
  const report = evaluateCommercialClosure({
    commercialReadiness: commercialFixture(),
    windowsSigning: { status: 'blocked', summary: { verifiedArtifactCount: 0, expectedArtifactCount: 5 } },
    mobileRelease: { status: 'external-blocked', localStatus: 'passed', credentialStatus: 'external-blocked', deviceEvidenceStatus: 'passed' },
    wearableField: { status: 'blocked', evidence: { state: 'available' }, integrity: { passed: true, state: 'verified' }, privacy: {} },
    finalRelease: { status: 'blocked-field-validation', summary: { blockingCheckCount: 3, externalValidationPending: 1 } },
    legalPack: { status: 'owner-input-required', missingFields: [{ key: 'operatorName' }], approval: { confirmed: false } },
    clock: () => new Date('2026-08-30T00:00:00.000Z')
  });

  assert.equal(report.summary.currentScore, 54);
  assert.equal(report.summary.remainingPoints, 46);
  assert.equal(report.summary.scoreAccountingValid, true);
  assert.deepEqual(report.stages.map((stage) => stage.points), [6, 9, 9, 13, 9]);
  assert.equal(report.stages.find((stage) => stage.id === 'final-release-gate').status, 'dependency-blocked');
  assert.equal(report.externalInputs.filter((item) => item.required).length, 4);
  assert.equal(report.truthPolicy.credentialValuesStored, false);
  assert.equal(report.scorePath.at(-1).to, 100);
});

test('commercial closure reaches complete only when every commercial check passed', () => {
  const report = evaluateCommercialClosure({
    commercialReadiness: commercialFixture({ ready: true }),
    clock: () => new Date('2026-08-30T00:00:00.000Z')
  });

  assert.equal(report.status, 'commercial-100-complete');
  assert.equal(report.summary.remainingPoints, 0);
  assert.equal(report.stages.every((stage) => stage.status === 'completed'), true);
  assert.equal(report.nextActions.length, 0);
  assert.equal(report.externalInputs.some((item) => item.required), false);
});

test('commercial closure writes privacy-safe operator artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-commercial-closure-'));
  try {
    const report = evaluateCommercialClosure({
      commercialReadiness: commercialFixture(),
      clock: () => new Date('2026-08-30T00:00:00.000Z')
    });
    const artifacts = await writeCommercialClosure(report, { outputDir: dir });
    const json = JSON.parse(await readFile(artifacts.jsonPath, 'utf8'));
    const html = await readFile(artifacts.htmlPath, 'utf8');
    assert.equal(json.summary.scoreAccountingValid, true);
    assert.equal(json.truthPolicy.credentialValuesStored, false);
    assert.match(html, /상용 100점 폐쇄 계획/);
    assert.doesNotMatch(html, /JARVIS_ANDROID_KEYSTORE_PASSWORD=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('commercial closure refreshes downstream release evidence after the final gate', async () => {
  const source = await readFile(new URL('../scripts/commercial-closure.mjs', import.meta.url), 'utf8');
  const gateIndex = source.indexOf('await runFinalReleaseGate(');
  const signoffIndex = source.indexOf('await runFinalSignoffKit(');
  const verificationBundleIndex = source.indexOf('await runFinalReleaseVerificationBundle(');

  assert.ok(gateIndex >= 0);
  assert.ok(signoffIndex > gateIndex);
  assert.ok(verificationBundleIndex > signoffIndex);
});
