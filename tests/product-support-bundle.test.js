import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProductSupportBundle } from '../scripts/product-support-bundle.mjs';
import { productServiceDefinitions } from '../scripts/product-runtime.mjs';

async function writeJson(root, relativePath, payload) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function createEvidenceRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-support-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeJson(root, 'package.json', { name: 'jarvis-test', version: '1.2.3', license: 'Commercial' }),
    writeJson(root, join('dist', 'test-run-report.json'), { status: 'passed', generatedAt: '2026-08-20T00:00:00.000Z' }),
    writeJson(root, join('dist', 'system-integrity-audit-report.json'), { status: 'passed', generatedAt: '2026-08-20T00:00:00.000Z' }),
    writeJson(root, join('dist', 'core-service-release-dossier.json'), {
      status: 'passed',
      generatedAt: '2026-08-20T00:00:00.000Z',
      releaseDossier: { package: { signatureStatus: 'authenticode-verified' } }
    }),
    writeJson(root, join('dist', 'pc-agent-install-release-dossier.json'), {
      status: 'passed',
      generatedAt: '2026-08-20T00:00:00.000Z',
      releaseDossier: { package: { signatureStatus: 'authenticode-verified' } }
    }),
    writeJson(root, join('dist', 'windows-code-signing-audit.json'), {
      status: 'passed',
      generatedAt: '2026-08-20T00:00:00.000Z',
      groups: [
        { id: 'core-windows', status: 'passed' },
        { id: 'pc-agent-windows', status: 'passed' }
      ]
    }),
    writeJson(root, join('dist', 'final-release-gate.json'), {
      status: 'passed',
      generatedAt: '2026-08-20T00:00:00.000Z',
      summary: { externalValidationPending: 0 },
      checks: []
    }),
    writeJson(root, join('dist', 'mobile-release-preflight-report.json'), { status: 'passed', blockers: [] }),
    writeJson(root, join('dist', 'wearable-physical-field-gate.json'), { status: 'passed' }),
    writeJson(root, join('dist', 'product-completion-ledger.json'), { status: 'passed', score: 100 }),
    writeJson(root, join('dist', 'llm-provider-diagnostics.json'), {
      status: 'passed',
      readiness: { ready: true, providerOrder: ['openai-api'] },
      liveProbe: { passed: true, provider: 'openai-api', attemptedProviders: ['openai-api'] }
    })
  ]);
  return root;
}

function testEnvironment() {
  return {
    JARVIS_CORE_PORT: '24071',
    JARVIS_PC_AGENT_PORT: '24072',
    JARVIS_BRIDGE_PORT: '24073',
    JARVIS_UI_PORT: '24074',
    JARVIS_CORE_ADMIN_TOKEN: 'private-core-admin-token-for-support-tests',
    JARVIS_PC_AGENT_API_TOKEN: 'private-pc-agent-token-for-support-tests',
    JARVIS_OPENAI_API_KEY: 'sk-support-bundle-must-never-leak',
    JARVIS_ANDROID_KEYSTORE_PATH: 'private-keystore-path',
    JARVIS_ANDROID_KEYSTORE_PASSWORD: 'private-store-password',
    JARVIS_ANDROID_KEY_ALIAS: 'private-alias',
    JARVIS_ANDROID_KEY_PASSWORD: 'private-key-password',
    EXPO_TOKEN: 'private-expo-token',
    JARVIS_EAS_PROJECT_ID: 'private-project-id'
  };
}

function healthResponse(url, definitions, moduleOverride = null) {
  const port = new URL(String(url)).port;
  const definition = definitions.find((candidate) => new URL(candidate.healthUrl).port === port);
  const payload = {
    ...(definition?.healthIdentity ?? {})
  };
  if (moduleOverride !== null) payload.module = moduleOverride;
  return Promise.resolve({ ok: true, status: 200, json: async () => payload });
}

function healthyFetchFor(definitions) {
  return (url) => healthResponse(url, definitions);
}

test('support bundle reports product health without leaking credentials or user data', async (t) => {
  const workspaceRoot = await createEvidenceRoot(t);
  const env = { ...testEnvironment(), USERPROFILE: workspaceRoot, JARVIS_SMTP_USER: 'private-smtp-user', JARVIS_SMTP_PASS: 'private-smtp-password' };
  const definitions = productServiceDefinitions({ env, cwd: workspaceRoot, nodePath: 'node-test' });
  const bundle = await createProductSupportBundle({
    workspaceRoot,
    env,
    definitions,
    fetchImpl: healthyFetchFor(definitions),
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(bundle.status, 'ready');
  assert.equal(bundle.runtime.status, 'ready');
  assert.equal(bundle.runtime.healthyCount, 4);
  assert.equal(bundle.readiness.personalLocalUseReady, null);
  assert.equal(bundle.readiness.advancedAiReady, null);
  assert.equal(bundle.readiness.liveModelConnectionVerified, true);
  assert.equal(bundle.readiness.prerequisiteEvidenceProvesTaskOutcome, false);
  assert.equal(bundle.evidence.completionLedger.isAcceptanceProgress, false);
  assert.equal(bundle.acceptance.status, 'unavailable');
  assert.equal(bundle.readiness.paidDistributionReady, true);
  assert.equal(bundle.configuration.openAiApiConfigured, true);
  assert.equal(bundle.configuration.productionAndroidSigningConfigured, true);
  assert.equal(bundle.readiness.windowsSigningReady, true);
  assert.equal(bundle.evidence.coreInstaller.signatureStatus, 'authenticode-verified');
  assert.equal(bundle.evidence.pcInstaller.signatureStatus, 'authenticode-verified');
  assert.equal(bundle.configuration.smtpCredentialsConfigured, true);
  assert.equal(bundle.integrationReadiness.find((item) => item.id === 'smtp-email-send').credentialState, 'credential-configured');
  assert.equal(bundle.integrationReadiness.find((item) => item.id === 'smtp-email-send').liveVerification, 'not-verified');
  assert.equal(bundle.integrationReadiness.find((item) => item.id === 'google-workspace-read').credentialState, 'not-connected');
  assert.equal(bundle.integrationReadiness.find((item) => item.id === 'health-connect').implementation, 'not-integrated');
  assert.equal(bundle.integrationReadiness.find((item) => item.id === 'smart-home').implementation, 'not-integrated');
  assert.equal(bundle.privacy.secretsIncluded, false);

  const serialized = JSON.stringify(bundle);
  for (const secret of Object.values(env).filter((value) => String(value).startsWith('private-') || String(value).startsWith('sk-'))) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('127.0.0.1'), false);
  assert.equal(serialized.includes('rawText'), false);
});

test('support bundle fails closed when a healthy HTTP endpoint has the wrong product identity', async (t) => {
  const workspaceRoot = await createEvidenceRoot(t);
  const env = { ...testEnvironment(), USERPROFILE: workspaceRoot };
  const definitions = productServiceDefinitions({ env, cwd: workspaceRoot, nodePath: 'node-test' });
  const bundle = await createProductSupportBundle({
    workspaceRoot,
    env,
    definitions,
    fetchImpl: (url) => new URL(String(url)).port === '24074'
      ? healthResponse(url, definitions, 'UNRELATED_PRODUCT')
      : healthResponse(url, definitions),
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(bundle.status, 'attention-required');
  assert.equal(bundle.runtime.healthyCount, 3);
  assert.equal(bundle.readiness.foundationalReady, false);
  assert.equal(bundle.readiness.personalLocalUseReady, false);
  assert.equal(bundle.issues.some((issue) => issue.id === 'runtime:ui'), true);
});

test('support bundle trusts observed Authenticode evidence instead of package labels', async (t) => {
  const workspaceRoot = await createEvidenceRoot(t);
  await writeJson(workspaceRoot, join('dist', 'windows-code-signing-audit.json'), {
    status: 'blocked',
    groups: [
      { id: 'core-windows', status: 'blocked' },
      { id: 'pc-agent-windows', status: 'blocked' }
    ]
  });
  const env = { ...testEnvironment(), USERPROFILE: workspaceRoot };
  const definitions = productServiceDefinitions({ env, cwd: workspaceRoot, nodePath: 'node-test' });
  const bundle = await createProductSupportBundle({
    workspaceRoot,
    env,
    definitions,
    fetchImpl: healthyFetchFor(definitions),
    clock: () => new Date('2026-08-20T01:02:03.000Z')
  });

  assert.equal(bundle.readiness.windowsSigningReady, false);
  assert.equal(bundle.readiness.personalLocalUseReady, null);
  assert.equal(bundle.readiness.paidDistributionReady, false);
  assert.equal(bundle.evidence.coreInstaller.signatureStatus, 'authenticode-not-verified');
  assert.equal(bundle.evidence.pcInstaller.signatureStatus, 'authenticode-not-verified');
  assert.equal(bundle.issues.some((issue) => issue.id === 'signing:core-windows'), true);
  assert.equal(bundle.issues.some((issue) => issue.id === 'signing:pc-agent-windows'), true);
});
