import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CommandInputProviderRegistry,
  createDefaultCommandInputProviderPack,
  runCommandInputProviderQualityReport
} from '../packages/core/src/intake/input-providers.js';

export const commandInputProviderQualityReportVersion = 'a-command-input-provider-quality-report-v1';

export async function runCommandInputProviderQualityDossier({
  jsonPath = 'dist/command-input-provider-quality-report.json',
  markdownPath = 'dist/command-input-provider-quality-report.md',
  csvPath = 'dist/command-input-provider-quality-report.csv',
  fixtureDir = 'dist/command-input-provider-fixtures',
  failBelowAccuracy = 0.9,
  clock = () => new Date()
} = {}) {
  const fixtures = await writeFixtureCorpus(fixtureDir);
  const commandRunner = async ({ kind }) => {
    const textByKind = {
      stt: { text: '오늘 회의록 정리하고 액션 아이템을 만들어줘', confidence: 0.96, engine: 'fixture-stt-engine' },
      ocr: { text: '화면 파일 목록을 보고 정리해줘', confidence: 0.94, engine: 'fixture-ocr-engine' },
      pdf: { text: 'PDF 계약서 요약과 리스크 체크를 진행해줘', confidence: 0.92, engine: 'fixture-pdf-parser' },
      office: { text: 'Office 회의 안건 표를 만들고 참석자에게 공유해줘', confidence: 0.91, engine: 'fixture-office-parser' }
    };
    return {
      ...textByKind[kind],
      adapterVersion: 'a-command-input-adapter-output-v1',
      latencyMs: kind === 'office' ? 18 : 12
    };
  };
  const registry = new CommandInputProviderRegistry({
    allowedRoots: [resolve(fixtureDir)],
    providers: createDefaultCommandInputProviderPack({
      stt: { commandRunner },
      ocr: { commandRunner },
      document: { commandRunner }
    })
  });
  const report = await runCommandInputProviderQualityReport({
    registry,
    fixtures,
    allowedRoots: [resolve(fixtureDir)],
    failBelowAccuracy,
    clock
  });

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

async function writeFixtureCorpus(fixtureDir) {
  await mkdir(fixtureDir, { recursive: true });
  const files = {
    voice: join(fixtureDir, 'voice.wav'),
    image: join(fixtureDir, 'screen.png'),
    pdf: join(fixtureDir, 'brief.pdf'),
    office: join(fixtureDir, 'brief.docx')
  };
  await writeFile(files.voice, 'fixture audio placeholder', 'utf8');
  await writeFile(files.image, 'fixture image placeholder', 'utf8');
  await writeFile(files.pdf, 'fixture pdf placeholder', 'utf8');
  await writeFile(files.office, 'fixture office placeholder', 'utf8');
  return [
    {
      fixtureId: 'voice.stt_command_provider',
      inputMode: 'voice',
      expectedProviderId: 'a-stt-command-provider-v1',
      expectedTextIncludes: ['회의록'],
      attachment: { name: 'voice.wav', path: files.voice, mimeType: 'audio/wav' }
    },
    {
      fixtureId: 'image.ocr_command_provider',
      inputMode: 'image',
      expectedProviderId: 'a-ocr-command-provider-v1',
      expectedTextIncludes: ['화면 파일 목록'],
      attachment: { name: 'screen.png', path: files.image, mimeType: 'image/png' }
    },
    {
      fixtureId: 'document.pdf_parser_provider',
      inputMode: 'file',
      expectedProviderId: 'a-document-parser-provider-v1',
      expectedTextIncludes: ['PDF 계약서'],
      attachment: { name: 'brief.pdf', path: files.pdf, mimeType: 'application/pdf' }
    },
    {
      fixtureId: 'document.office_parser_provider',
      inputMode: 'file',
      expectedProviderId: 'a-document-parser-provider-v1',
      expectedTextIncludes: ['Office 회의 안건'],
      attachment: { name: 'brief.docx', path: files.office, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
  ];
}

function renderMarkdown(report) {
  const lines = [
    '# Command Input Provider Quality Report',
    '',
    `Status: **${report.status}**`,
    `Version: \`${report.reportVersion}\``,
    `Accuracy: **${report.accuracy}**`,
    `Drift: **${report.drift.status}**`,
    `P95 latency: **${report.latency.p95Ms ?? 'n/a'}ms**`,
    `Deployment readiness: **${report.deploymentReadiness.status}**`,
    `Product gate: **${report.productGate.status}**`,
    `Release dossier: \`${report.releaseDossier.dossierVersion}\``,
    `Artifact manifest: \`${report.releaseDossier.artifactManifest.artifactManifestVersion}\``,
    `Operational handoff: \`${report.releaseDossier.operationalHandoffManifest.manifestVersion}\` / ${report.releaseDossier.operationalHandoffManifest.status}`,
    `WORM promotion package: \`${report.releaseDossier.externalWormPromotionPackage.packageVersion}\``,
    `CI/nightly gate plan: \`${report.releaseDossier.ciNightlyGatePlan.planVersion}\``,
    '',
    '## Providers',
    '',
    '| Provider | Accuracy | Fixtures | P95 latency |',
    '| --- | ---: | ---: | ---: |',
    ...report.providerGroups.map((item) => `| ${item.providerId} | ${item.accuracy} | ${item.fixtureCount} | ${item.p95LatencyMs ?? ''} |`),
    '',
    '## Fixtures',
    '',
    '| Fixture | Provider | Status | Latency |',
    '| --- | --- | --- | ---: |',
    ...report.results.map((item) => `| ${item.fixtureId} | ${item.actualProviderId} | ${item.status} | ${item.latencyMs} |`)
      .concat([
        '',
        '## Product Gate',
        '',
        ...report.productGate.checks.map((check) => `- ${check.checkId}: ${check.passed ? 'passed' : 'failed'}`)
      ])
  ];
  return `${lines.join('\n')}\n`;
}

function renderCsv(report) {
  const rows = [['fixture_id', 'provider_id', 'status', 'latency_ms', 'content_source'].join(',')];
  for (const item of report.results) {
    rows.push([item.fixtureId, item.actualProviderId, item.status, item.latencyMs, item.contentSource].map(csv).join(','));
  }
  for (const check of report.productGate.checks) {
    rows.push(['product_gate', check.checkId, check.passed ? 'passed' : 'failed', '', report.productGate.productGateVersion].map(csv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
    else if (arg === '--fixture-dir') args.fixtureDir = argv[++index];
    else if (arg === '--fail-below-accuracy') args.failBelowAccuracy = Number(argv[++index]);
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCommandInputProviderQualityDossier(parseArgs(process.argv.slice(2)));
  console.log('# Command Input Provider Quality Report');
  console.log(`Status: ${report.status}`);
  console.log(`Accuracy: ${report.accuracy}`);
  console.log(`Drift: ${report.drift.status}`);
  console.log(`Product gate: ${report.productGate.status}`);
  console.log(`Report: ${resolve('dist/command-input-provider-quality-report.json')}`);
  if (report.productGate.status !== 'passed') process.exitCode = 1;
}
