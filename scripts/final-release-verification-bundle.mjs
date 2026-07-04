import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCiVerificationAnnotations } from './ci-verification-annotations.mjs';
import { runFinalReleaseAttestation } from './final-release-attestation.mjs';
import { runProductCompletionLedger } from './product-completion-ledger.mjs';
import { runWearableHudVerification } from './wearable-hud-verify.mjs';

const defaultJsonPath = 'dist/final-release-verification-bundle.json';
const defaultMarkdownPath = 'dist/final-release-verification-bundle.md';

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

function check(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    detail
  };
}

export async function runFinalReleaseVerificationBundle({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  emitAnnotations = process.env.GITHUB_ACTIONS === 'true'
} = {}) {
  const wearableHud = await runWearableHudVerification({ workspaceRoot });
  const ledger = await runProductCompletionLedger({ workspaceRoot });
  const ciAnnotations = await runCiVerificationAnnotations({
    workspaceRoot,
    emitAnnotations
  });
  const attestation = await runFinalReleaseAttestation({ workspaceRoot });

  const checks = [
    check('completion_ledger_ready', ledger.status === 'ready', {
      status: ledger.status,
      score: ledger.score,
      blockedDomainCount: ledger.summary?.blockedDomainCount ?? null,
      warningDomainCount: ledger.summary?.warningDomainCount ?? null
    }),
    check('wearable_hud_verified', wearableHud.status === 'passed'
      && wearableHud.productGate?.status === 'passed'
      && wearableHud.fieldKit?.status === 'passed', {
      status: wearableHud.status,
      productGateStatus: wearableHud.productGate?.status ?? null,
      fieldKitStatus: wearableHud.fieldKit?.status ?? null,
      displayPalette: wearableHud.summary?.displayPalette ?? null,
      highRiskDirectApproveEnabled: wearableHud.summary?.highRiskDirectApproveEnabled ?? null
    }),
    check('ci_annotations_not_blocked', ciAnnotations.status !== 'blocked', {
      status: ciAnnotations.status,
      errorCount: ciAnnotations.summary?.errorCount ?? null,
      warningCount: ciAnnotations.summary?.warningCount ?? null
    }),
    check('release_attestation_not_blocked', attestation.status !== 'blocked', {
      status: attestation.status,
      distributionStatus: attestation.distributionReadiness?.status ?? null,
      blockingCheckCount: attestation.summary?.blockingCheckCount ?? null
    })
  ];
  const blockingChecks = checks.filter((item) => !item.passed);
  const warningCount = Number(ciAnnotations.summary?.warningCount ?? 0)
    + (attestation.distributionReadiness?.status === 'pending-production-infrastructure' ? 1 : 0);
  const status = blockingChecks.length > 0
    ? 'blocked'
    : warningCount > 0
      ? 'passed-with-operational-notes'
      : 'passed';

  const report = {
    reportVersion: 'jarvis-final-release-verification-bundle-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      ledgerStatus: ledger.status,
      ledgerScore: ledger.score,
      wearableHudStatus: wearableHud.status,
      wearableHudProductGateStatus: wearableHud.productGate?.status ?? null,
      wearableHudFieldKitStatus: wearableHud.fieldKit?.status ?? null,
      ciAnnotationStatus: ciAnnotations.status,
      ciErrorCount: ciAnnotations.summary?.errorCount ?? null,
      ciWarningCount: ciAnnotations.summary?.warningCount ?? null,
      attestationStatus: attestation.status,
      attestationSha256: attestation.attestationSha256,
      distributionStatus: attestation.distributionReadiness?.status ?? null,
      blockingCheckCount: blockingChecks.length,
      operationalNoteCount: warningCount
    },
    checks,
    blockingItems: blockingChecks.map((item) => ({
      checkId: item.checkId,
      detail: item.detail
    })),
    operationalNotes: buildOperationalNotes({ attestation, ciAnnotations }),
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      wearableHudVerificationPath: workspacePath(workspaceRoot, 'dist/wearable-hud-verification-report.json'),
      completionLedgerPath: workspacePath(workspaceRoot, 'dist/product-completion-ledger.json'),
      ciAnnotationsPath: workspacePath(workspaceRoot, 'dist/ci-verification-annotations.json'),
      releaseAttestationPath: workspacePath(workspaceRoot, 'dist/final-release-attestation.json')
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildOperationalNotes({ attestation, ciAnnotations }) {
  const notes = [];
  if ((ciAnnotations.summary?.warningCount ?? 0) > 0) {
    notes.push({
      noteId: 'ci-annotations-warning',
      message: `${ciAnnotations.summary.warningCount} CI warning annotations remain.`
    });
  }
  if (attestation.distributionReadiness?.status === 'pending-production-infrastructure') {
    notes.push({
      noteId: 'external-distribution-pending',
      message: 'Local/field release is attested, but public distribution still needs production signing and managed immutable storage.',
      nextActions: attestation.distributionReadiness.nextActions ?? []
    });
  }
  return notes;
}

function renderMarkdown(report) {
  return [
    '# JARVIS Final Release Verification Bundle',
    '',
    `Status: **${report.status}**`,
    `Completion ledger: ${report.summary.ledgerStatus} (${report.summary.ledgerScore ?? 'n/a'}%)`,
    `Wearable HUD: ${report.summary.wearableHudStatus} (${report.summary.wearableHudProductGateStatus ?? 'n/a'}, field kit ${report.summary.wearableHudFieldKitStatus ?? 'n/a'})`,
    `CI annotations: ${report.summary.ciAnnotationStatus}`,
    `Release attestation: ${report.summary.attestationStatus}`,
    `Distribution: ${report.summary.distributionStatus}`,
    `Attestation SHA-256: \`${report.summary.attestationSha256 ?? 'missing'}\``,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Blocking Items',
    '',
    ...(report.blockingItems.length > 0
      ? report.blockingItems.map((item) => `- ${item.checkId}`)
      : ['- none']),
    '',
    '## Operational Notes',
    '',
    ...(report.operationalNotes.length > 0
      ? report.operationalNotes.map((item) => `- ${item.noteId}: ${item.message}`)
      : ['- none']),
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--emit') args.emitAnnotations = true;
    else if (arg === '--no-emit') args.emitAnnotations = false;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFinalReleaseVerificationBundle(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Final Release Verification Bundle');
  console.log(`Status: ${report.status}`);
  console.log(`Ledger: ${report.summary.ledgerStatus}`);
  console.log(`CI annotations: ${report.summary.ciAnnotationStatus}`);
  console.log(`Attestation: ${report.summary.attestationStatus}`);
  console.log('Reports: dist/final-release-verification-bundle.json, dist/final-release-verification-bundle.md');
  if (report.status === 'blocked') process.exitCode = 1;
}
