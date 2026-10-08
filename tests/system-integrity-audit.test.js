import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateReleaseEvidenceConsistency, runSystemIntegrityAudit } from '../scripts/system-integrity-audit.mjs';

function report(status, generatedAt, summary = {}) {
  return { status, generatedAt, summary };
}

test('release evidence consistency rejects stale reports that contradict the final gate', () => {
  const finalGate = report('blocked-field-validation', '2026-07-21T12:00:00.000Z', {
    externalValidationPending: 2
  });
  const staleReadySummary = {
    finalReleaseGateStatus: 'passed',
    externalValidationPending: 0
  };
  const result = evaluateReleaseEvidenceConsistency({
    finalGate,
    completionLedger: report('ready', '2026-07-20T12:00:00.000Z', staleReadySummary),
    ciAnnotations: report('passed', '2026-07-20T12:00:00.000Z', staleReadySummary),
    releaseAttestation: report('attested-local-field-release', '2026-07-20T12:00:00.000Z', {
      finalReleaseGateStatus: 'passed'
    }),
    verificationBundle: report('passed', '2026-07-20T12:00:00.000Z', {
      ledgerStatus: 'ready',
      ciAnnotationStatus: 'passed',
      attestationStatus: 'attested-local-field-release'
    })
  });

  assert.equal(result.passed, false);
  assert.equal(result.issues.some((item) => item.issue === 'older-than-final-gate'), true);
  assert.equal(result.issues.some((item) => item.issue === 'release-state-contradiction'), true);
  assert.equal(result.issues.some((item) => item.issue === 'gate-status-mismatch'), true);
  assert.equal(result.issues.some((item) => item.issue === 'external-validation-count-mismatch'), true);
});

test('release evidence consistency accepts a synchronized blocked evidence chain', () => {
  const generatedAt = '2026-07-21T12:01:00.000Z';
  const result = evaluateReleaseEvidenceConsistency({
    finalGate: report('blocked-field-validation', '2026-07-21T12:00:00.000Z', {
      externalValidationPending: 2
    }),
    completionLedger: report('blocked', generatedAt, {
      finalReleaseGateStatus: 'blocked-field-validation',
      externalValidationPending: 2
    }),
    ciAnnotations: report('blocked', generatedAt, {
      finalReleaseGateStatus: 'blocked-field-validation',
      externalValidationPending: 2
    }),
    releaseAttestation: report('blocked', generatedAt, {
      finalReleaseGateStatus: 'blocked-field-validation'
    }),
    verificationBundle: report('blocked', generatedAt, {
      ledgerStatus: 'blocked',
      ciAnnotationStatus: 'blocked',
      attestationStatus: 'blocked'
    })
  });

  assert.equal(result.passed, true);
  assert.equal(result.issueCount, 0);
  assert.equal(result.reports.every((item) => item.stale === false), true);
});

test('system integrity audit understands Node test globs and web-root asset links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-integrity-fixture-'));
  try {
    await Promise.all([
      mkdir(join(root, 'apps/demo/src/public'), { recursive: true }),
      mkdir(join(root, 'apps/demo/tests'), { recursive: true }),
      mkdir(join(root, 'scripts'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'integrity-fixture',
        type: 'module',
        private: true,
        workspaces: ['apps/*'],
        scripts: {}
      })),
      writeFile(join(root, 'apps/demo/package.json'), JSON.stringify({
        name: '@fixture/demo',
        type: 'module',
        scripts: { test: 'node --test tests/*.test.js' }
      })),
      writeFile(join(root, 'apps/demo/tests/demo.test.js'), "import test from 'node:test';\ntest('fixture', () => {});\n"),
      writeFile(join(root, 'apps/demo/src/public/index.html'), '<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>'),
      writeFile(join(root, 'apps/demo/src/public/styles.css'), 'body { color: black; }\n'),
      writeFile(join(root, 'apps/demo/src/public/app.js'), 'export {};\n'),
      writeFile(join(root, 'apps/demo/src/helper.js'), 'export const helper = true;\n'),
      writeFile(join(root, 'apps/demo/src/import-fixture.js'), [
        "import { helper } from './helper.js';",
        "const quotedImport = \"import value from '../missing-quoted.js';\";",
        "const replacementFixture = source.replace(\"import value from '../missing-replacement.js';\", '');",
        "const importPattern = /import\\s+['\"]..\\/missing-regex.js['\"]/;",
        "// import value from '../missing-line-comment.js';",
        "/* export { value } from '../missing-block-comment.js'; */",
        "export async function loadHelper() { return import('./helper.js'); }",
        'export default helper;\n'
      ].join('\n')),
      writeFile(join(root, 'scripts/product-evidence.mjs'), [
        "const steps = [{ id: 'wearable-field-chaos' }, { id: 'runtime-trust-audit' }, { id: 'system-integrity-audit' },",
        "  { id: 'mobile-live-bridge-e2e' }, { id: 'final-release-verification-bundle' }];",
        'export default steps;\n'
      ].join('\n'))
    ]);

    const report = await runSystemIntegrityAudit({
      workspaceRoot: root,
      jsonPath: join(root, 'reports/integrity.json'),
      markdownPath: join(root, 'reports/integrity.md')
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.summary.blockingFailures, 0);
    assert.equal(report.checks.find((item) => item.checkId === 'npm_script_node_targets_exist')?.status, 'passed');
    assert.equal(report.checks.find((item) => item.checkId === 'relative_module_links_resolve')?.status, 'passed');
    assert.equal(report.checks.find((item) => item.checkId === 'relative_module_links_resolve')?.detail.importCount, 2);
    assert.equal(report.checks.find((item) => item.checkId === 'html_and_css_asset_links_resolve')?.status, 'passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
