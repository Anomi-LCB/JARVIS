import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ContextSnapshotBuilder,
  createWindowsDesktopContextProviderPack
} from '../packages/core/src/context/context-snapshot.js';

export const contextProviderSoakReportVersion = 'a-desktop-context-provider-soak-v1';

export async function runContextProviderSoakReport({
  jsonPath = 'dist/context-provider-soak-report.json',
  markdownPath = 'dist/context-provider-soak-report.md',
  csvPath = 'dist/context-provider-soak-report.csv',
  cycles = 6,
  enableNativeProbe = process.platform === 'win32',
  timeoutMs = 1200,
  ocrCommand = process.env.JARVIS_DESKTOP_OCR_COMMAND,
  eventCommand = process.env.JARVIS_DESKTOP_OS_EVENTS_COMMAND,
  clock = () => new Date()
} = {}) {
  const provider = createWindowsDesktopContextProviderPack({
    enableNativeProbe,
    timeoutMs,
    ocrCommand,
    eventCommand
  });
  const builder = new ContextSnapshotBuilder({ clock, desktopContextProvider: provider });
  const report = builder.runDesktopProviderSoak({
    cycles,
    includeFailureProbe: true,
    commandText: 'Windows desktop context provider soak'
  });

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

function renderMarkdown(report) {
  const adapters = report.providerContract.providerContract?.adapters ?? [];
  return [
    '# Context Provider Soak',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `Provider: ${report.providerContract.providerId}`,
    `Provider contract: ${report.providerContract.providerContract?.contractVersion ?? 'not-configured'}`,
    `Raw content stored: ${report.rawContentStored}`,
    `Expected failure captured: ${report.failureTelemetry.expectedFailureCaptured}`,
    `Product gate: ${report.productGate.status}`,
    `Release dossier: ${report.releaseDossier.dossierVersion}`,
    `Artifact manifest: ${report.releaseDossier.artifactManifest.artifactManifestVersion}`,
    `Operational handoff: ${report.releaseDossier.operationalHandoffManifest.manifestVersion}`,
    `CI/nightly gate plan: ${report.releaseDossier.ciNightlyGatePlan.planVersion}`,
    `WORM promotion package: ${report.releaseDossier.externalWormPromotionPackage.packageVersion}`,
    '',
    '## Adapter Contracts',
    '',
    ...adapters.map((adapter) => `- ${adapter.providerVersion}: ${adapter.purpose}`),
    '',
    '## Counts',
    '',
    `Provider statuses: ${JSON.stringify(report.providerStatusCounts)}`,
    `Adapter statuses: ${JSON.stringify(report.adapterStatusCounts)}`,
    `Permission UX states: ${JSON.stringify(report.permissionUxStates)}`,
    `Latency p95 ms: ${report.latency.p95Ms ?? 'n/a'}`,
    `Latency budget p95 ms: ${report.latency.budgetP95Ms ?? 'n/a'}`,
    `Latency budget samples: ${report.latency.budgetSampleCount ?? 'n/a'}`,
    '',
    '## Product Gate',
    '',
    ...report.productGate.checks.map((check) => `- ${check.checkId}: ${check.passed ? 'passed' : 'failed'}`)
  ].join('\n');
}

function renderCsv(report) {
  const rows = [
    ['kind', 'id', 'status', 'detail'].join(',')
  ];
  rows.push(['report', report.reportVersion, report.status, `samples=${report.sampleCount}`].join(','));
  rows.push(['product_gate', report.productGate.productGateVersion, report.productGate.status, `release=${report.releaseDossier.dossierVersion}`].map(csv).join(','));
  for (const check of report.productGate.checks) {
    rows.push(['product_gate_check', check.checkId, check.passed ? 'passed' : 'failed', report.productGate.productGateVersion].map(csv).join(','));
  }
  for (const sample of report.samples) {
    rows.push([
      'sample',
      sample.sampleId,
      sample.providerStatus,
      `mode=${sample.collectionMode};ux=${sample.permissionUxState};raw=${sample.rawContentStored}`
    ].map(csv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nativeFlag = readFlag('--native');
  const report = await runContextProviderSoakReport({
    jsonPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/context-provider-soak-report.json',
    markdownPath: readFlag('--markdown') ?? 'dist/context-provider-soak-report.md',
    csvPath: readFlag('--csv') ?? 'dist/context-provider-soak-report.csv',
    cycles: Number(readFlag('--cycles') ?? 6),
    enableNativeProbe: nativeFlag == null ? process.platform === 'win32' : nativeFlag !== 'false',
    timeoutMs: Number(readFlag('--timeout-ms') ?? 1200)
  });
  console.log(`Context provider soak: ${report.status}`);
  console.log(`Product gate: ${report.productGate.status}`);
  console.log(`Report: ${readFlag('--output') ?? readFlag('--report') ?? 'dist/context-provider-soak-report.json'}`);
  if (report.productGate.status !== 'passed') process.exitCode = 1;
}
