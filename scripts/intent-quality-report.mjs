import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ActionType } from '../packages/shared/src/types.js';
import {
  ApprovedIntentLogStore,
  createIntentActionDriftTrend,
  createIntentParserProductGate,
  createSemanticProviderTelemetryDashboard,
  evaluateApprovedIntentDrift
} from '../packages/core/src/intent/intent-learning-log.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { LocalSemanticIntentAdapter, PolicyGatedSemanticIntentAdapter } from '../packages/core/src/intent/semantic-intent-adapter.js';

export async function runIntentQualityReport({
  jsonPath = 'dist/intent-quality-report.json',
  markdownPath = 'dist/intent-quality-report.md',
  csvPath = 'dist/intent-quality-report.csv',
  approvedLogPath = 'dist/intent-quality-approved-log.jsonl',
  createdAt = '2026-06-28T00:00:00.000Z'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await mkdir(dirname(approvedLogPath), { recursive: true });
  await rm(approvedLogPath, { force: true });

  const ruleParser = new IntentParser();
  const localAdapter = new LocalSemanticIntentAdapter({ parser: ruleParser });
  const externalAdapter = createFixtureExternalSemanticProvider(localAdapter);
  const gatedAdapter = new PolicyGatedSemanticIntentAdapter({
    localAdapter,
    externalAdapter,
    externalEnabled: true,
    minLocalConfidence: 0.99
  });
  const store = new ApprovedIntentLogStore({
    filePath: approvedLogPath,
    clock: () => new Date(createdAt)
  });

  const fixtures = await loadApprovedIntentQualityFixtures();
  for (const fixture of fixtures) {
    store.record({
      command: fixture.command,
      expected: fixture.expected,
      approvedForLearning: true,
      approvalId: `intent_quality_${fixture.id}`,
      taskId: `task_${fixture.id}`,
      source: fixture.source ?? 'quality-approved-command',
      metadata: {
        qualityRun: 'a-03-intent-quality-report-v1',
        fixtureId: fixture.id
      }
    });
  }

  const driftReport = evaluateApprovedIntentDrift({
    store,
    ruleParser,
    semanticAdapter: gatedAdapter,
    externalAdapter,
    createdAt
  });
  const actionDriftTrend = createIntentActionDriftTrend({
    currentReport: driftReport,
    previousReports: [driftReport]
  });
  const providerTelemetryDashboard = createSemanticProviderTelemetryDashboard({
    report: driftReport,
    providers: [
      {
        providerId: externalAdapter.adapterId,
        providerKind: 'external-shadow',
        enabled: true,
        shadowMode: true,
        p95LatencyMs: 220,
        avgLatencyMs: 132,
        estimatedCostUsd: 0.024,
        regressionDelta: 0,
        rawPromptsStored: false
      }
    ]
  });
  const productGate = createIntentParserProductGate({
    driftReport,
    actionDriftTrend,
    providerTelemetryDashboard
  });
  const report = {
    reportVersion: 'a-03-intent-quality-report-v1',
    generatedAt: new Date().toISOString(),
    status: productGate.status,
    fixtureCount: fixtures.length,
    rawCommandsStored: false,
    artifacts: { jsonPath, markdownPath, csvPath, approvedLogPath },
    driftReport,
    actionDriftTrend,
    providerTelemetryDashboard,
    productGate
  };

  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderIntentQualityMarkdown(report), 'utf8');
  await writeFile(csvPath, renderIntentQualityCsv(report), 'utf8');
  return report;
}

export function renderIntentQualityMarkdown(report) {
  const lines = [
    '# JARVIS A-03 Intent Quality',
    '',
    `Status: ${report.status}`,
    `Report: ${report.reportVersion}`,
    `Fixtures: ${report.fixtureCount}`,
    `Raw commands stored: ${report.rawCommandsStored}`,
    '',
    '## Drift Calibration',
    `- Report: ${report.driftReport.reportVersion}`,
    `- Passed: ${report.driftReport.passed}`,
    `- Corpus: ${report.driftReport.corpusVersion}`,
    `- Redacted fixtures: ${report.driftReport.privacy.redactedFixtureCount}`,
    '',
    '## Action Drift Trend',
    `- Trend: ${report.actionDriftTrend.trendVersion}`,
    `- Status: ${report.actionDriftTrend.status}`,
    ...report.actionDriftTrend.items.map((item) => `- ${item.actionType}: semantic ${item.semanticPassRate}, regression ${item.semanticRegressionDelta}`),
    '',
    '## Provider Telemetry Dashboard',
    `- Dashboard: ${report.providerTelemetryDashboard.dashboardVersion}`,
    `- Status: ${report.providerTelemetryDashboard.status}`,
    ...report.providerTelemetryDashboard.providers.map((provider) => `- ${provider.providerId}: p95 ${provider.p95LatencyMs}ms, cost $${provider.estimatedCostUsd}, status ${provider.status}`),
    '',
    '## Product Gate',
    `- Gate: ${report.productGate.productGateVersion}`,
    `- Status: ${report.productGate.status}`,
    `- Release dossier: ${report.productGate.releaseDossier.dossierVersion}`,
    `- Artifact manifest: ${report.productGate.releaseDossier.artifactManifest.artifactManifestVersion}`,
    `- CI/nightly gate plan: ${report.productGate.releaseDossier.ciNightlyGatePlan.planVersion}`,
    `- Operational handoff: ${report.productGate.releaseDossier.operationalHandoffManifest.manifestVersion} / ${report.productGate.releaseDossier.operationalHandoffManifest.status}`,
    `- WORM promotion package: ${report.productGate.releaseDossier.externalWormPromotionPackage.packageVersion}`,
    ...report.productGate.checks.map((check) => `- ${check.checkId}: ${check.passed ? 'passed' : 'failed'}`)
  ];
  return `${lines.join('\n')}\n`;
}

export function renderIntentQualityCsv(report) {
  const rows = [['domain', 'id', 'passed', 'expected', 'actual']]
    .concat(report.actionDriftTrend.items.map((item) => [
      'intent_action_drift',
      item.actionType,
      item.status === 'passed',
      `semantic>=${report.actionDriftTrend.thresholds.minActionPassRate}`,
      item.semanticPassRate
    ]))
    .concat(report.providerTelemetryDashboard.providers.map((provider) => [
      'semantic_provider_telemetry',
      provider.providerId,
      provider.status === 'passed',
      `p95<=${report.providerTelemetryDashboard.thresholds.maxP95LatencyMs}`,
      provider.p95LatencyMs
    ]))
    .concat(report.productGate.checks.map((check) => [
      'intent_parser_product_gate',
      check.checkId,
      check.passed,
      'passed',
      check.passed ? 'passed' : 'failed'
    ]));
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

async function loadApprovedIntentQualityFixtures() {
  const [standardCorpus, semanticCorpus] = await Promise.all([
    readJson('packages/core/fixtures/intent-command-corpus.json'),
    readJson('packages/core/fixtures/intent-semantic-command-corpus.json')
  ]);
  const selected = [
    ...standardCorpus.fixtures.filter((fixture) => [
      ActionType.CREATE_FILE,
      ActionType.LIST_FILES,
      ActionType.UPLOAD_FILE,
      ActionType.MOVE_FILE
    ].includes(fixture.expected?.actionType)).slice(0, 6),
    ...semanticCorpus.fixtures.slice(0, 6)
  ];
  return selected.map((fixture, index) => ({
    ...fixture,
    id: fixture.id ?? `intent_quality_${index}`,
    source: index % 2 === 0 ? 'mobile-approved-command' : 'pc-approved-command'
  }));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function createFixtureExternalSemanticProvider(localAdapter) {
  return {
    adapterId: 'a-03-fixture-external-semantic-provider-v1',
    parse(rawText, options = {}) {
      const parsed = localAdapter.parse(rawText, options);
      return {
        ...parsed,
        confidence: Math.min(0.99, Number(parsed.confidence ?? 0) + 0.06),
        semantic: {
          ...(parsed.semantic ?? {}),
          adapterId: 'a-03-fixture-external-semantic-provider-v1',
          provider: 'shadow-fixture',
          rawPromptStored: false
        }
      };
    }
  };
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runIntentQualityReport();
  console.log(`# JARVIS A-03 Intent Quality`);
  console.log(`Status: ${report.status}`);
  console.log(`Fixtures: ${report.fixtureCount}`);
  console.log(`Action drift trend: ${report.actionDriftTrend.status}`);
  console.log(`Provider telemetry dashboard: ${report.providerTelemetryDashboard.status}`);
  console.log(`Product gate: ${report.productGate.status}`);
  console.log(`Report: ${resolve(report.artifacts.jsonPath)}`);
}
