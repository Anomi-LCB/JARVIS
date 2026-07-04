import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function runSecurityRedteamCorpusReport({
  failBelow = 0.95,
  jsonPath = 'dist/security-redteam-corpus-report.json',
  markdownPath = 'dist/security-redteam-corpus-report.md',
  htmlPath = 'dist/security-redteam-corpus-report.html',
  csvPath = 'dist/security-redteam-corpus-report.csv'
} = {}) {
  const { policyRuntime } = createAgRuntime();
  const corpus = policyRuntime.securityRedteamCorpus();
  const report = policyRuntime.runSecurityRedteamCorpus({ corpus, failBelow });
  const trend = policyRuntime.securityRedteamTrend();
  const constitutionRegression = policyRuntime.constitutionHashRegression();
  const constitutionWorkflow = policyRuntime.constitutionWorkflowStatus();
  const constitutionReleaseDossier = policyRuntime.constitutionReleaseDossier();
  const approvalPolicyWorkflow = policyRuntime.runApprovalPolicyWorkflowRegression();
  const approvalPolicyProductGate = policyRuntime.approvalPolicyProductGate();
  const policyAsCode = policyRuntime.policyAsCodeProductGate();
  const policyAsCodeReleaseDossier = policyAsCode.releaseDossier;
  const auditApi = policyRuntime.auditApiProductGate();
  const auditApiReleaseDossier = policyRuntime.auditApiReleaseDossier();
  const capabilityLifecycle = policyRuntime.capabilities.productLifecycleGate();
  const capabilityLifecycleReleaseDossier = policyRuntime.capabilities.releaseDossier();
  const autonomyProductGate = policyRuntime.autonomyProductGate();
  const autonomyReleaseDossier = policyRuntime.autonomyReleaseDossier();
  const riskClassifierProductGate = policyRuntime.riskClassifierProductGate({ failBelow });
  const dataClassifierProductGate = policyRuntime.dataClassifierProductGate();
  const dataClassifierReleaseDossier = policyRuntime.dataClassifierReleaseDossier();
  const promptInjectionProductGate = policyRuntime.promptInjectionProductGate({ failBelow });
  const promptInjectionReleaseDossier = promptInjectionProductGate.releaseDossier;
  const toolPoisoningProductGate = policyRuntime.toolPoisoningProductGate({ failBelow });
  const toolPoisoningReleaseDossier = policyRuntime.toolPoisoningReleaseDossier({ failBelow });
  const dossier = {
    generatedAt: new Date().toISOString(),
    status: report.status === 'passed'
      && constitutionRegression.status === 'passed'
      && constitutionReleaseDossier.status === 'passed'
      && approvalPolicyWorkflow.status === 'passed'
      && approvalPolicyProductGate.status === 'passed'
      && policyAsCode.status === 'passed'
      && policyAsCodeReleaseDossier.status === 'passed'
      && auditApi.status === 'passed'
      && auditApiReleaseDossier.status === 'passed'
      && capabilityLifecycle.status === 'passed'
      && capabilityLifecycleReleaseDossier.status === 'passed'
      && autonomyProductGate.status === 'passed'
      && autonomyReleaseDossier.status === 'passed'
      && riskClassifierProductGate.status === 'passed'
      && dataClassifierProductGate.status === 'passed'
      && dataClassifierReleaseDossier.status === 'passed'
      && promptInjectionProductGate.status === 'passed'
      && promptInjectionReleaseDossier.status === 'passed'
      && toolPoisoningProductGate.status === 'passed'
      && toolPoisoningReleaseDossier.status === 'passed' ? 'passed' : 'failed',
    report,
    trend,
    policyAsCode,
    policyAsCodeReleaseDossier,
    auditApi,
    auditApiReleaseDossier,
    capabilityLifecycle,
    capabilityLifecycleReleaseDossier,
    autonomyProductGate,
    autonomyReleaseDossier,
    riskClassifierProductGate,
    dataClassifierProductGate,
    dataClassifierReleaseDossier,
    promptInjectionProductGate,
    promptInjectionReleaseDossier,
    toolPoisoningProductGate,
    toolPoisoningReleaseDossier,
    constitution: {
      regression: constitutionRegression,
      workflow: constitutionWorkflow,
      releaseDossier: constitutionReleaseDossier,
      signingKeyProvider: constitutionWorkflow.signingKeyProvider
    },
    approvalPolicy: {
      workflow: policyRuntime.approvalPolicyWorkflowStatus(),
      regression: approvalPolicyWorkflow,
      signedHistory: policyRuntime.approvalPolicySignedHistory(),
      rollbackDrill: approvalPolicyWorkflow.rollbackDrill,
      ciApprovalArtifact: approvalPolicyProductGate.ciApprovalArtifact,
      productGate: approvalPolicyProductGate
    },
    nextActions: report.status === 'passed'
      ? ['Keep appending production misses, anonymized operational risk calibration events, false positives, data precision/recall cases, tool-poisoning cases, constitution hash fixtures, approval-policy migration drills, policy-as-code drift fixtures, policy-as-code signed approval artifacts, policy-as-code hash-only release dossiers, SIEM audit fixtures, and capability lifecycle recovery drills to e-security-redteam-corpus-v1.']
      : ['Review failed fixtures, tune E policy-as-code, then rerun npm run security:redteam.']
  };
  dossier.artifacts = { jsonPath, markdownPath, htmlPath, csvPath };
  await writeSecurityRedteamArtifacts(dossier, { jsonPath, markdownPath, htmlPath, csvPath });
  return dossier;
}

export async function writeSecurityRedteamArtifacts(dossier, {
  jsonPath,
  markdownPath,
  htmlPath,
  csvPath
}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(dossier, null, 2), 'utf8');
  await writeFile(markdownPath, renderSecurityRedteamMarkdown(dossier), 'utf8');
  await writeFile(htmlPath, renderSecurityRedteamHtml(dossier), 'utf8');
  await writeFile(csvPath, renderSecurityRedteamCsv(dossier), 'utf8');
  return dossier.artifacts;
}

export function renderSecurityRedteamMarkdown(dossier) {
  const { report, trend, constitution, approvalPolicy, policyAsCode, policyAsCodeReleaseDossier, auditApi, auditApiReleaseDossier, capabilityLifecycle, capabilityLifecycleReleaseDossier, autonomyProductGate, autonomyReleaseDossier, riskClassifierProductGate, dataClassifierProductGate, dataClassifierReleaseDossier, promptInjectionProductGate, promptInjectionReleaseDossier, toolPoisoningProductGate, toolPoisoningReleaseDossier } = dossier;
  const lines = [
    '# JARVIS E Security Redteam Corpus',
    '',
    `Generated: ${dossier.generatedAt}`,
    `Status: ${dossier.status}`,
    `Corpus: ${report.corpusVersion}`,
    `Fixtures: ${report.fixtureCount}`,
    `Pass rate: ${report.passRate}`,
    `Trend: ${trend.trendVersion}`,
    `Policy-as-code product gate: ${policyAsCode.status}`,
    `Policy-as-code CI approval artifact: ${policyAsCode.ciApprovalArtifact.status}`,
    `Policy-as-code release dossier: ${policyAsCodeReleaseDossier.status}`,
    `Audit API product gate: ${auditApi.status}`,
    `Audit API release dossier: ${auditApiReleaseDossier.status}`,
    `Capability lifecycle product gate: ${capabilityLifecycle.status}`,
    `Capability lifecycle release dossier: ${capabilityLifecycleReleaseDossier.status}`,
    `Autonomy product gate: ${autonomyProductGate.status}`,
    `Autonomy release dossier: ${autonomyReleaseDossier.status}`,
    `Risk classifier product gate: ${riskClassifierProductGate.status}`,
    `Data classifier product gate: ${dataClassifierProductGate.status}`,
    `Data classifier release dossier: ${dataClassifierReleaseDossier.status}`,
    `Prompt injection product gate: ${promptInjectionProductGate.status}`,
    `Prompt injection release dossier: ${promptInjectionReleaseDossier.status}`,
    `Tool poisoning product gate: ${toolPoisoningProductGate.status}`,
    `Tool poisoning release dossier: ${toolPoisoningReleaseDossier.status}`,
    `Constitution regression: ${constitution.regression.status}`,
    `Constitution release dossier: ${constitution.releaseDossier.status}`,
    `Approval policy regression: ${approvalPolicy.regression.status}`,
    `Approval policy product gate: ${approvalPolicy.productGate.status}`,
    `Signing key provider: ${constitution.signingKeyProvider.provider}`,
    '',
    '## Coverage',
    `- Domains: ${report.coverage.domains.join(', ')}`,
    `- Prompt vectors: ${report.coverage.promptVectors.join(', ')}`,
    `- Tool source types: ${report.coverage.toolSourceTypes.join(', ')}`,
    `- Risk action types: ${report.coverage.riskActionTypes.join(', ')}`,
    '',
    '## Calibration',
    `- Risk mismatches: ${report.calibration.riskMismatches}`,
    `- Prompt false positives: ${report.calibration.promptFalsePositiveCount}`,
    `- Prompt false negatives: ${report.calibration.promptFalseNegativeCount}`,
    `- Tool command promotion blocked: ${report.calibration.toolCommandPromotionBlocked}`,
    `- Autonomy negative evidence blocked: ${report.calibration.autonomyNegativeEvidenceBlocked}`,
    '',
    '## Risk Classifier Product Gate',
    `- Product gate: ${riskClassifierProductGate.productGateVersion}`,
    `- Calibration report: ${riskClassifierProductGate.report.reportVersion}`,
    `- Review workflow: ${riskClassifierProductGate.seededReview.reviewVersion}`,
    `- Calibration dashboard: ${riskClassifierProductGate.dashboard.dashboardVersion}`,
    `- Operational corpus: ${riskClassifierProductGate.releaseDossier.operationalCorpus.corpusVersion}`,
    `- Policy drift trend: ${riskClassifierProductGate.releaseDossier.driftTrend.trendVersion}`,
    `- Release dossier: ${riskClassifierProductGate.releaseDossier.dossierVersion}`,
    `- Pass rate: ${riskClassifierProductGate.report.passRate}`,
    '',
    '## Data Classifier Product Gate',
    `- Product gate: ${dataClassifierProductGate.productGateVersion}`,
    `- Precision/recall trend: ${dataClassifierProductGate.trend.trendVersion}`,
    `- External NER contract: ${dataClassifierProductGate.externalProvider.contractVersion}`,
    `- Hot reload tuning gate: ${dataClassifierProductGate.hotReloadTuning.gateVersion}`,
    `- Release dossier: ${dataClassifierReleaseDossier.dossierVersion}`,
    `- Release hash: ${dataClassifierReleaseDossier.releaseHash}`,
    `- Raw sensitive fixtures stored: ${dataClassifierReleaseDossier.artifactManifest.rawSensitiveFixturesStored}`,
    `- Precision: ${dataClassifierProductGate.trend.precision}`,
    `- Recall: ${dataClassifierProductGate.trend.recall}`,
    '',
    '## Prompt Injection Product Gate',
    `- Product gate: ${promptInjectionProductGate.productGateVersion}`,
    `- Semantic adapter: ${promptInjectionProductGate.semanticAdapter.contractVersion}`,
    `- Semantic provider trend: ${promptInjectionProductGate.semanticTrend.trendVersion}`,
    `- Production miss corpus: ${promptInjectionProductGate.productionMissCorpus.corpusVersion}`,
    `- Release dossier: ${promptInjectionReleaseDossier.dossierVersion}`,
    `- Raw prompt content stored: ${promptInjectionReleaseDossier.artifactManifest.rawPromptContentStored}`,
    `- Prompt pass rate: ${promptInjectionProductGate.promptPassRate}`,
    '',
    '## Tool Poisoning Product Gate',
    `- Product gate: ${toolPoisoningProductGate.productGateVersion}`,
    `- Release dossier: ${toolPoisoningReleaseDossier.dossierVersion}`,
    `- Release hash: ${toolPoisoningReleaseDossier.releaseHash}`,
    `- Provenance retention: ${toolPoisoningProductGate.retention.dashboardVersion}`,
    `- Artifact diff: ${toolPoisoningProductGate.artifactDiff.diffVersion}`,
    `- Tool pass rate: ${toolPoisoningProductGate.toolPassRate}`,
    '',
    '## Immutable Constitution',
    `- Workflow: ${constitution.workflow.workflowVersion}`,
    `- Release dossier: ${constitution.releaseDossier.dossierVersion}`,
    `- Release hash: ${constitution.releaseDossier.releaseHash}`,
    `- Current hash: ${constitution.workflow.currentHash}`,
    `- Hash fixtures: ${constitution.regression.fixtureCount}`,
    `- Rotation supported: ${constitution.signingKeyProvider.rotationSupported}`,
    '',
    '## Approval Policy Workflow',
    `- Workflow: ${approvalPolicy.workflow.workflowVersion}`,
    `- Regression: ${approvalPolicy.regression.reportVersion}`,
    `- Signed history: ${approvalPolicy.signedHistory.historyVersion}`,
    `- Rollback drill: ${approvalPolicy.rollbackDrill?.status}`,
    '',
    '## Policy-as-Code Product Gate',
    `- Matrix: ${policyAsCode.matrixVersion}`,
    `- YAML loader: ${policyAsCode.yamlLoader.loaderVersion}`,
    `- External schema: ${policyAsCode.externalSchema.schemaVersion}`,
    `- Migration diff: ${policyAsCode.migrationDiff.diffVersion}`,
    `- CI drift gate: ${policyAsCode.driftGate.gateVersion}`,
    `- CI annotation: ${policyAsCode.ciAnnotation.annotationVersion}`,
    `- Signed approval artifact: ${policyAsCode.ciApprovalArtifact.artifactVersion}`,
    `- Release dossier: ${policyAsCodeReleaseDossier.dossierVersion}`,
    `- Release hash: ${policyAsCodeReleaseDossier.releaseHash}`,
    `- Raw policy manifest stored: ${policyAsCodeReleaseDossier.artifactManifest.rawPolicyManifestStored}`,
    `- WORM archive contract: ${policyAsCodeReleaseDossier.artifactManifest.wormArchive.archiveContractVersion}`,
    `- Operational handoff: ${policyAsCodeReleaseDossier.operationalHandoffManifest.manifestVersion}`,
    `- WORM promotion package: ${policyAsCodeReleaseDossier.externalWormPromotionPackage.packageVersion}`,
    '',
    '## Security Audit APIs',
    `- Product gate: ${auditApi.productGateVersion}`,
    `- Release dossier: ${auditApiReleaseDossier.dossierVersion}`,
    `- Release hash: ${auditApiReleaseDossier.releaseHash}`,
    `- Search DSL: ${auditApi.search.searchVersion}`,
    `- SIEM export: ${auditApi.siem.exportVersion}`,
    `- Retention scheduler: ${auditApi.retention.schedulerVersion}`,
    `- Immutable archive sync: ${auditApi.archiveSync.syncVersion}`,
    `- Operational handoff: ${auditApiReleaseDossier.operationalHandoffManifest.manifestVersion}`,
    `- WORM promotion package: ${auditApiReleaseDossier.externalWormPromotionPackage.packageVersion}`,
    '',
    '## Capability Token Lifecycle',
    `- Product gate: ${capabilityLifecycle.productGateVersion}`,
    `- Release dossier: ${capabilityLifecycleReleaseDossier.dossierVersion}`,
    `- Release hash: ${capabilityLifecycleReleaseDossier.releaseHash}`,
    `- Signing key provider: ${capabilityLifecycle.provider.providerVersion}`,
    `- Encrypted journal export: ${capabilityLifecycle.exportBundle.exportVersion}`,
    `- Import recovery: ${capabilityLifecycle.recovery.recoveryVersion}`,
    `- Rotation drill: ${capabilityLifecycle.rotationDrill.drillVersion}`,
    '',
    '## Autonomy Contract',
    `- Product gate: ${autonomyProductGate.productGateVersion}`,
    `- Release dossier: ${autonomyReleaseDossier.dossierVersion}`,
    `- Release hash: ${autonomyReleaseDossier.releaseHash}`,
    `- Ledger: ${autonomyProductGate.ledger.ledgerVersion}`,
    `- Trend: ${autonomyProductGate.trend.trendVersion}`,
    `- Review workflow: ${autonomyProductGate.reviewed.review.reviewVersion}`,
    '',
    '## Failed Fixtures'
  ];
  const failed = report.items.filter((item) => !item.passed);
  if (!failed.length) lines.push('- none');
  for (const item of failed) lines.push(`- ${item.fixtureId} (${item.domain})`);
  return `${lines.join('\n')}\n`;
}

export function renderSecurityRedteamHtml(dossier) {
  const rows = dossier.report.items.map((item) => `<tr><td>${htmlEscape(item.domain)}</td><td>${htmlEscape(item.fixtureId)}</td><td>${htmlEscape(item.passed ? 'passed' : 'failed')}</td><td>${htmlEscape(item.actualDecision ?? item.actualTier ?? '')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS E Security Redteam Corpus</title></head>
<body>
  <h1>JARVIS E Security Redteam Corpus</h1>
  <p>Status: ${htmlEscape(dossier.status)}</p>
  <p>Pass rate: ${htmlEscape(dossier.report.passRate)}</p>
  <p>Trend: ${htmlEscape(dossier.trend.trendVersion)}</p>
  <p>Policy-as-code product gate: ${htmlEscape(dossier.policyAsCode.status)}</p>
  <p>Policy-as-code CI approval artifact: ${htmlEscape(dossier.policyAsCode.ciApprovalArtifact.status)}</p>
  <p>Policy-as-code release dossier: ${htmlEscape(dossier.policyAsCodeReleaseDossier.dossierVersion)} (${htmlEscape(dossier.policyAsCodeReleaseDossier.status)})</p>
  <p>Audit API product gate: ${htmlEscape(dossier.auditApi.status)}</p>
  <p>Audit API release dossier: ${htmlEscape(dossier.auditApiReleaseDossier.dossierVersion)} (${htmlEscape(dossier.auditApiReleaseDossier.status)})</p>
  <p>Capability lifecycle product gate: ${htmlEscape(dossier.capabilityLifecycle.status)}</p>
  <p>Capability lifecycle release dossier: ${htmlEscape(dossier.capabilityLifecycleReleaseDossier.dossierVersion)} (${htmlEscape(dossier.capabilityLifecycleReleaseDossier.status)})</p>
  <p>Autonomy product gate: ${htmlEscape(dossier.autonomyProductGate.status)}</p>
  <p>Autonomy release dossier: ${htmlEscape(dossier.autonomyReleaseDossier.dossierVersion)} (${htmlEscape(dossier.autonomyReleaseDossier.status)})</p>
  <p>Risk classifier product gate: ${htmlEscape(dossier.riskClassifierProductGate.status)}</p>
  <p>Risk release dossier: ${htmlEscape(dossier.riskClassifierProductGate.releaseDossier.dossierVersion)} (${htmlEscape(dossier.riskClassifierProductGate.releaseDossier.status)})</p>
  <p>Data classifier product gate: ${htmlEscape(dossier.dataClassifierProductGate.status)}</p>
  <p>Data classifier release dossier: ${htmlEscape(dossier.dataClassifierReleaseDossier.dossierVersion)} (${htmlEscape(dossier.dataClassifierReleaseDossier.status)})</p>
  <p>Prompt injection product gate: ${htmlEscape(dossier.promptInjectionProductGate.status)}</p>
  <p>Prompt injection release dossier: ${htmlEscape(dossier.promptInjectionReleaseDossier.dossierVersion)} (${htmlEscape(dossier.promptInjectionReleaseDossier.status)})</p>
  <p>Tool poisoning product gate: ${htmlEscape(dossier.toolPoisoningProductGate.status)}</p>
  <p>Tool poisoning release dossier: ${htmlEscape(dossier.toolPoisoningReleaseDossier.dossierVersion)} (${htmlEscape(dossier.toolPoisoningReleaseDossier.status)})</p>
  <p>Constitution regression: ${htmlEscape(dossier.constitution.regression.status)}</p>
  <p>Constitution release dossier: ${htmlEscape(dossier.constitution.releaseDossier.dossierVersion)} (${htmlEscape(dossier.constitution.releaseDossier.status)})</p>
  <p>Approval policy regression: ${htmlEscape(dossier.approvalPolicy.regression.status)}</p>
  <p>Approval policy product gate: ${htmlEscape(dossier.approvalPolicy.productGate.status)}</p>
  <p>Signing key provider: ${htmlEscape(dossier.constitution.signingKeyProvider.provider)}</p>
  <table>
    <thead><tr><th>Domain</th><th>Fixture</th><th>Status</th><th>Actual</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <pre>${htmlEscape(JSON.stringify(dossier, null, 2))}</pre>
</body>
</html>
`;
}

export function renderSecurityRedteamCsv(dossier) {
  const rows = [['domain', 'fixtureId', 'passed', 'expected', 'actual']]
    .concat(dossier.report.items.map((item) => [
      item.domain,
      item.fixtureId,
      item.passed,
      item.expectedDecision ?? item.expectedTier ?? '',
      item.actualDecision ?? item.actualTier ?? ''
    ]))
    .concat(dossier.constitution.regression.fixtures.map((fixture) => [
      'constitution',
      fixture.fixtureId,
      fixture.passed,
      fixture.expected,
      fixture.actual
    ]))
    .concat(dossier.constitution.releaseDossier.checks.map((check) => [
      'constitution_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.approvalPolicy.regression.checks.map((check) => [
      'approval_policy',
      check.checkId,
      check.status === 'passed',
      'passed',
      check.status
    ]))
    .concat(dossier.approvalPolicy.productGate.checks.map((check) => [
      'approval_policy_product_gate',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.policyAsCode.items.map((item) => [
      'policy_as_code',
      item.fixtureId,
      item.passed,
      'passed',
      item.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.policyAsCode.checks.map((check) => [
      'policy_as_code_product_gate',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.policyAsCodeReleaseDossier.checks.map((check) => [
      'policy_as_code_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.auditApi.checks.map((check) => [
      'audit_api',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.auditApiReleaseDossier.checks.map((check) => [
      'audit_api_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.capabilityLifecycle.checks.map((check) => [
      'capability_lifecycle',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.capabilityLifecycleReleaseDossier.checks.map((check) => [
      'capability_lifecycle_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.autonomyProductGate.checks.map((check) => [
      'autonomy_contract',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.autonomyReleaseDossier.checks.map((check) => [
      'autonomy_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.riskClassifierProductGate.report.items.map((item) => [
      'risk_classifier_product_gate',
      item.fixtureId,
      item.passed,
      item.expectedTier,
      item.actualTier
    ]))
    .concat(dossier.dataClassifierProductGate.trend.items.map((item) => [
      'data_classifier_product_gate',
      item.caseId,
      item.passed,
      item.expectedFlags.join('|'),
      item.actualFlags.join('|')
    ]))
    .concat(dossier.riskClassifierProductGate.releaseDossier.checks.map((check) => [
      'risk_classifier_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.dataClassifierReleaseDossier.checks.map((check) => [
      'data_classifier_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.promptInjectionProductGate.checks.map((check) => [
      'prompt_injection_product_gate',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.promptInjectionReleaseDossier.checks.map((check) => [
      'prompt_injection_release_dossier',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]))
    .concat(dossier.toolPoisoningProductGate.checks.map((check) => [
      'tool_poisoning_product_gate',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]));
  rows.push(...dossier.toolPoisoningReleaseDossier.checks.map((check) => [
    'tool_poisoning_release_dossier',
    check.checkId,
    check.passed,
    'passed',
    check.passed ? 'passed' : 'failed'
  ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fail-below') options.failBelow = Number(argv[index + 1]);
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--html') options.htmlPath = argv[index + 1];
    if (arg === '--csv') options.csvPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dossier = await runSecurityRedteamCorpusReport(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS E Security Redteam Corpus');
  console.log(`Status: ${dossier.status}`);
  console.log(`Pass rate: ${dossier.report.passRate}`);
  console.log(`Fixtures: ${dossier.report.fixtureCount}`);
  console.log(`Policy-as-code release dossier: ${dossier.policyAsCodeReleaseDossier.status}`);
  console.log(`Audit API release dossier: ${dossier.auditApiReleaseDossier.status}`);
  console.log(`Risk classifier product gate: ${dossier.riskClassifierProductGate.status}`);
  console.log(`Capability lifecycle release dossier: ${dossier.capabilityLifecycleReleaseDossier.status}`);
  console.log(`Autonomy release dossier: ${dossier.autonomyReleaseDossier.status}`);
  console.log(`Data classifier product gate: ${dossier.dataClassifierProductGate.status}`);
  console.log(`Data classifier release dossier: ${dossier.dataClassifierReleaseDossier.status}`);
  console.log(`Prompt injection product gate: ${dossier.promptInjectionProductGate.status}`);
  console.log(`Prompt injection release dossier: ${dossier.promptInjectionReleaseDossier.status}`);
  console.log(`Tool poisoning product gate: ${dossier.toolPoisoningProductGate.status}`);
  console.log(`Tool poisoning release dossier: ${dossier.toolPoisoningReleaseDossier.status}`);
  console.log(`Constitution regression: ${dossier.constitution.regression.status}`);
  console.log(`Constitution release dossier: ${dossier.constitution.releaseDossier.status}`);
  console.log(`Approval policy product gate: ${dossier.approvalPolicy.productGate.status}`);
  console.log(`Reports: ${dossier.artifacts.jsonPath}, ${dossier.artifacts.markdownPath}, ${dossier.artifacts.htmlPath}, ${dossier.artifacts.csvPath}`);
  if (dossier.status !== 'passed') process.exitCode = 1;
}
