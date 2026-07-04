import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/ci-verification-annotations.json';
const defaultMarkdownPath = 'dist/ci-verification-annotations.md';

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function countAnnotations(annotations, level) {
  return annotations.filter((item) => item.level === level).length;
}

function addAnnotation(annotations, level, checkId, title, message, detail = {}) {
  annotations.push({
    level,
    checkId,
    title,
    message,
    detail
  });
}

function passedCheck(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    level: passed ? 'notice' : 'error',
    detail
  };
}

function warningCheck(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    level: passed ? 'notice' : 'warning',
    detail
  };
}

function githubEscape(value) {
  return String(value ?? '')
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function emitGithubAnnotation(annotation) {
  const command = annotation.level === 'error'
    ? 'error'
    : annotation.level === 'warning'
      ? 'warning'
      : 'notice';
  const title = githubEscape(`JARVIS ${annotation.checkId}: ${annotation.title}`);
  const message = githubEscape(annotation.message);
  console.log(`::${command} title=${title}::${message}`);
}

function finalGatePassed(finalGate) {
  return finalGate?.status === 'passed' && (finalGate?.summary?.blockingCheckCount ?? 0) === 0;
}

function signoffReady(signoff) {
  return signoff?.status === 'ready-for-final-signoff';
}

function ledgerReady(ledger) {
  return ledger?.status === 'ready'
    && ledger?.summary?.blockedDomainCount === 0
    && ledger?.summary?.warningDomainCount === 0;
}

function ledgerUsable(ledger) {
  return ['ready', 'ready-with-warnings'].includes(ledger?.status)
    && ledger?.summary?.blockedDomainCount === 0;
}

function productReadinessTargetMet(ledger, productGate) {
  const strictScore = ledger?.summary?.strictScore ?? productGate?.overall?.strictScore ?? null;
  const readinessScore = ledger?.summary?.productReadinessScore ?? productGate?.overall?.productReadinessScore ?? null;
  return Number(strictScore) === 100 && Number(readinessScore) >= 95;
}

function externalValidationClosed(ledger, finalGate, handoff) {
  const pending = ledger?.summary?.externalValidationPending
    ?? finalGate?.summary?.externalValidationPending
    ?? handoff?.summary?.externalValidationPending
    ?? null;
  return pending === 0;
}

function buildChecks({ ledger, finalGate, signoff, productGate, handoff }) {
  return [
    passedCheck('final-release-gate-passed', finalGatePassed(finalGate), {
      status: finalGate?.status ?? 'missing',
      blockingCheckCount: finalGate?.summary?.blockingCheckCount ?? null
    }),
    passedCheck('final-signoff-ready', signoffReady(signoff), {
      status: signoff?.status ?? 'missing'
    }),
    passedCheck('product-completion-ledger-present', Boolean(ledger), {
      status: ledger?.status ?? 'missing'
    }),
    warningCheck('product-completion-ledger-clean', ledgerReady(ledger), {
      status: ledger?.status ?? 'missing',
      blockedDomainCount: ledger?.summary?.blockedDomainCount ?? null,
      warningDomainCount: ledger?.summary?.warningDomainCount ?? null
    }),
    passedCheck('product-readiness-target-met', productReadinessTargetMet(ledger, productGate), {
      strictScore: ledger?.summary?.strictScore ?? productGate?.overall?.strictScore ?? null,
      productReadinessScore: ledger?.summary?.productReadinessScore ?? productGate?.overall?.productReadinessScore ?? null
    }),
    passedCheck('external-validation-closed', externalValidationClosed(ledger, finalGate, handoff), {
      pending: ledger?.summary?.externalValidationPending
        ?? finalGate?.summary?.externalValidationPending
        ?? handoff?.summary?.externalValidationPending
        ?? null
    }),
    passedCheck('domain-blockers-clear', (ledger?.summary?.blockedDomainCount ?? 1) === 0, {
      blockedDomainCount: ledger?.summary?.blockedDomainCount ?? null
    })
  ];
}

function buildAnnotations({ ledger, finalGate, signoff, productGate, handoff, checks }) {
  const annotations = [];

  for (const check of checks) {
    if (check.passed) continue;
    addAnnotation(
      annotations,
      check.level,
      check.checkId,
      check.level === 'warning' ? 'Warning evidence remains' : 'Required evidence is not complete',
      `${check.checkId} did not pass. ${JSON.stringify(check.detail)}`,
      check.detail
    );
  }

  if (ledger && !ledgerUsable(ledger)) {
    addAnnotation(
      annotations,
      'error',
      'product-completion-ledger-blocked',
      'Product completion ledger is blocked',
      `Ledger status is ${ledger.status}; blocked domains: ${ledger.summary?.blockedDomainCount ?? 'unknown'}.`,
      {
        status: ledger.status,
        blockedDomainCount: ledger.summary?.blockedDomainCount ?? null
      }
    );
  }

  for (const domain of ledger?.domains ?? []) {
    if (domain.status === 'ready') continue;
    const isBlocked = domain.blockingFailures?.length > 0 || domain.status === 'blocked';
    addAnnotation(
      annotations,
      isBlocked ? 'error' : 'warning',
      `domain-${domain.domainId}`,
      `${domain.title} is ${domain.status}`,
      `${domain.title} has ${domain.blockingFailures?.length ?? 0} blocking failures and ${domain.warnings?.length ?? 0} warnings.`,
      {
        domainId: domain.domainId,
        status: domain.status,
        blockingFailures: domain.blockingFailures?.map((item) => item.checkId) ?? [],
        warnings: domain.warnings?.map((item) => item.checkId) ?? []
      }
    );
  }

  for (const item of finalGate?.blockingItems ?? []) {
    addAnnotation(
      annotations,
      'error',
      `final-gate-${item.id}`,
      'Final release gate blocking item',
      `${item.type ?? 'blocking'}:${item.id} remains unresolved.`,
      item
    );
  }

  for (const item of signoff?.operatorActions ?? []) {
    addAnnotation(
      annotations,
      'warning',
      `signoff-action-${item.actionId}`,
      item.title ?? 'Operator action required',
      item.command ? `Run: ${item.command}` : 'Operator action remains before signoff.',
      item
    );
  }

  if (!productGate) {
    addAnnotation(
      annotations,
      'error',
      'product-readiness-gate-missing',
      'Product readiness gate report is missing',
      'Run npm run ag:product-gate before publishing CI verification annotations.'
    );
  }

  if (!handoff) {
    addAnnotation(
      annotations,
      'warning',
      'operator-handoff-missing',
      'Operator handoff report is missing',
      'Run npm run ag:handoff so CI can publish external validation status.'
    );
  }

  return annotations;
}

function deriveStatus(annotations) {
  if (countAnnotations(annotations, 'error') > 0) return 'blocked';
  if (countAnnotations(annotations, 'warning') > 0) return 'passed-with-warnings';
  return 'passed';
}

export async function runCiVerificationAnnotations({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY,
  emitAnnotations = process.env.GITHUB_ACTIONS === 'true'
} = {}) {
  const [ledger, finalGate, signoff, productGate, handoff] = await Promise.all([
    readJson(workspacePath(workspaceRoot, 'dist/product-completion-ledger.json')),
    readJson(workspacePath(workspaceRoot, 'dist/final-release-gate.json')),
    readJson(workspacePath(workspaceRoot, 'dist/final-signoff-kit-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ag-product-readiness-gate.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ag-operator-handoff.json'))
  ]);

  const checks = buildChecks({ ledger, finalGate, signoff, productGate, handoff });
  const annotations = buildAnnotations({ ledger, finalGate, signoff, productGate, handoff, checks });
  const status = deriveStatus(annotations);
  const report = {
    reportVersion: 'jarvis-ci-verification-annotations-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      ledgerStatus: ledger?.status ?? 'missing',
      completionScore: ledger?.score ?? null,
      strictScore: ledger?.summary?.strictScore ?? productGate?.overall?.strictScore ?? null,
      productReadinessScore: ledger?.summary?.productReadinessScore ?? productGate?.overall?.productReadinessScore ?? null,
      finalReleaseGateStatus: finalGate?.status ?? 'missing',
      finalSignoffStatus: signoff?.status ?? 'missing',
      blockedDomainCount: ledger?.summary?.blockedDomainCount ?? null,
      warningDomainCount: ledger?.summary?.warningDomainCount ?? null,
      externalValidationPending: ledger?.summary?.externalValidationPending
        ?? finalGate?.summary?.externalValidationPending
        ?? handoff?.summary?.externalValidationPending
        ?? null,
      annotationCount: annotations.length,
      errorCount: countAnnotations(annotations, 'error'),
      warningCount: countAnnotations(annotations, 'warning'),
      noticeCount: countAnnotations(annotations, 'notice')
    },
    checks,
    annotations,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      stepSummaryPath: stepSummaryPath ? resolve(stepSummaryPath) : null
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const markdown = renderMarkdown(report);
  await writeFile(markdownPath, markdown, 'utf8');
  if (stepSummaryPath) {
    await mkdir(dirname(stepSummaryPath), { recursive: true });
    await appendFile(stepSummaryPath, `\n${markdown}\n`, 'utf8');
  }
  if (emitAnnotations) {
    if (annotations.length === 0) {
      emitGithubAnnotation({
        level: 'notice',
        checkId: 'jarvis-ci-verification-passed',
        title: 'JARVIS A-G verification passed',
        message: 'Final gate, signoff kit, completion ledger, and external validation are clean.'
      });
    } else {
      annotations.forEach(emitGithubAnnotation);
    }
  }

  return report;
}

function renderMarkdown(report) {
  return [
    '# JARVIS CI Verification',
    '',
    `Status: **${report.status}**`,
    `Completion score: ${report.summary.completionScore ?? 'n/a'}`,
    `Strict implementation: ${report.summary.strictScore ?? 'n/a'}`,
    `Product readiness: ${report.summary.productReadinessScore ?? 'n/a'}`,
    `Final release gate: ${report.summary.finalReleaseGateStatus}`,
    `Final signoff: ${report.summary.finalSignoffStatus}`,
    `Pending external validation: ${report.summary.externalValidationPending ?? 'n/a'}`,
    `Annotations: ${report.summary.errorCount} errors / ${report.summary.warningCount} warnings`,
    '',
    '## Checks',
    '',
    '| Check | Passed | Level |',
    '| --- | --- | --- |',
    ...report.checks.map((item) => `| ${escapeMd(item.checkId)} | ${item.passed ? 'yes' : 'no'} | ${item.level} |`),
    '',
    '## Annotations',
    '',
    ...(report.annotations.length > 0
      ? report.annotations.map((item) => `- ${item.level}: ${escapeMd(item.checkId)} - ${escapeMd(item.message)}`)
      : ['- none']),
    ''
  ].join('\n');
}

function escapeMd(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--summary') args.stepSummaryPath = argv[++index];
    else if (arg === '--no-summary') args.stepSummaryPath = null;
    else if (arg === '--emit') args.emitAnnotations = true;
    else if (arg === '--no-emit') args.emitAnnotations = false;
    else if (arg === '--fail-on-blocking') args.failOnBlocking = true;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCiVerificationAnnotations(args);
  console.log('# JARVIS CI Verification');
  console.log(`Status: ${report.status}`);
  console.log(`Errors: ${report.summary.errorCount}`);
  console.log(`Warnings: ${report.summary.warningCount}`);
  console.log('Reports: dist/ci-verification-annotations.json, dist/ci-verification-annotations.md');
  if (args.failOnBlocking && report.status === 'blocked') process.exitCode = 1;
}
