import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgGapAudit } from './ag-gap-audit.mjs';

const defaultTargets = {
  overallProductReadiness: 95,
  docProductReadiness: 90,
  requirementProductReadiness: 85
};

const productLanes = [
  {
    laneId: 'windows-service-lane',
    title: 'Windows service product lane',
    docs: ['A', 'B'],
    externalDependencies: ['Administrator PowerShell', 'Windows Service Control Manager'],
    commands: [
      'npm run core:service-package -- --output-dir dist/core-service-package',
      'npm run core:service-release',
      'npm run contracts:federated-gate',
      'powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/install-all.ps1',
      'npm run command-input:quality',
      'npm run context:provider-soak',
      'npm run pc-agent:package -- --output dist/pc-agent-installer',
      'npm run pc-agent:install-release',
      'npm run workbook:product-soak',
      'npm run shadow:approval-soak',
      'powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/install-all.ps1'
    ],
    artifacts: [
      'dist/core-service-package/package-manifest.json',
      'dist/core-service-release-dossier.json',
      'dist/federated-openapi-contract-gate-report.json',
      'dist/core-service-smoke-report.json',
      'dist/core-service-soak-report.json',
      'dist/command-input-provider-quality-report.json',
      'dist/context-provider-soak-report.json',
      'dist/pc-agent-installer/package-manifest.json',
      'dist/pc-agent-install-release-dossier.json',
      'dist/workbook-product-soak-report.json',
      'dist/shadow-approval-soak-report.json',
      'dist/pc-agent-daemon-smoke-report.json'
    ]
  },
  {
    laneId: 'mobile-device-lane',
    title: 'Physical mobile device lane',
    docs: ['C', 'D'],
    externalDependencies: ['Android device or emulator', 'ADB', 'Expo/React Native build toolchain'],
    commands: [
      'npm run mobile:verify',
      'npm run bridge:server-soak',
      'npm run bridge:network-guard-drill',
      'npm run bridge:client-contract-gate',
      'npm run mobile:android-install -- --build --install',
      'npm run mobile:device',
      'npm run mobile:release-dossier',
      'npm run mobile:live-bridge-e2e'
    ],
    artifacts: [
      'dist/mobile-verification-report.json',
      'dist/bridge-server-soak-report.json',
      'dist/bridge-network-guard-drill-report.json',
      'dist/bridge-client-contract-gate-report.json',
      'dist/mobile-android-install-report.json',
      'dist/mobile-device-smoke-report.json',
      'dist/mobile-release-dossier.json',
      'dist/mobile-live-bridge-e2e-report.json'
    ]
  },
  {
    laneId: 'browser-soak-lane',
    title: 'Browser and local PC adapter soak lane',
    docs: ['B', 'G'],
    externalDependencies: ['Managed browser runtime', 'Network replay corpus'],
    commands: [
      'node --test --test-name-pattern "B browser|Playwright|golden fixture" tests/ag-runtime.test.js',
      'npm run browser:replay-soak',
      'npm run pc-agent:daemon-smoke -- --output dist/pc-agent-daemon-smoke-report.json'
    ],
    artifacts: [
      'dist/browser-replay-soak-report.json',
      'dist/pc-agent-daemon-smoke-report.json',
      'dist/ag-smoke-report.json'
    ]
  },
  {
    laneId: 'growth-quality-lane',
    title: 'Growth memory quality lane',
    docs: ['F'],
    externalDependencies: ['Approved anonymized workflow corpus', 'Longitudinal preference/failure feedback'],
    commands: [
      'npm run growth:quality',
      'node --test --test-name-pattern "^F " tests/ag-runtime.test.js',
      'npm run ag:gap'
    ],
    artifacts: [
      'dist/growth-quality-corpus-report.json',
      'dist/ag-strict-gap-audit.json',
      'dist/ag-strict-gap-audit.md'
    ]
  },
  {
    laneId: 'security-redteam-lane',
    title: 'Security and redteam expansion lane',
    docs: ['E', 'G'],
    externalDependencies: ['Large redteam fixture corpus', 'Sensitive leak fixture corpus'],
    commands: [
      'npm run security:redteam',
      'node --test --test-name-pattern "E |G .*redteam|G tool poisoning" tests/ag-runtime.test.js',
      'npm run ag:gap'
    ],
    artifacts: [
      'dist/security-redteam-corpus-report.json',
      'dist/security-redteam-corpus-report.md',
      'dist/ag-strict-gap-audit.json',
      'dist/ag-strict-gap-audit.md'
    ]
  },
  {
    laneId: 'verification-dashboard-lane',
    title: 'G verification dashboard and release evidence lane',
    docs: ['G'],
    externalDependencies: ['Artifact retention storage', 'CI annotation target'],
    commands: [
      'npm run verification:dashboard',
      'node --test --test-name-pattern "^G |A-G strict gap audit" tests/ag-runtime.test.js',
      'npm run ag:product-gate'
    ],
    artifacts: [
      'dist/verification-dashboard-dossier.json',
      'dist/verification-dashboard-dossier.md',
      'dist/verification-dashboard-dossier.csv',
      'dist/ag-strict-gap-audit.json',
      'dist/ag-product-readiness-gate.json',
      'dist/ag-product-readiness-gate.md'
    ]
  }
];

const recommendedDirections = [
  {
    directionId: 'product-readiness-lab-v1',
    label: 'Product readiness lab',
    value: 'One command creates a release dossier, lane checklist, artifact map, and exact next execution queue.',
    reason: 'This is the fastest path from impressive prototype to verifiable product readiness.'
  },
  {
    directionId: 'physical-evidence-first-v1',
    label: 'Physical evidence first',
    value: 'Prioritize Administrator Windows service runs, physical Android/iOS runs, and long soaks over more surface features.',
    reason: 'The remaining risk is mostly environmental and operational, not contract shape.'
  },
  {
    directionId: 'quality-corpus-flywheel-v1',
    label: 'Quality corpus flywheel',
    value: 'Turn every failure, redteam case, browser replay, and learning review into a durable fixture.',
    reason: 'This makes the system compound: every bug becomes permanent product knowledge.'
  }
];

export async function runProductReadinessGate({
  jsonPath = 'dist/ag-product-readiness-gate.json',
  markdownPath = 'dist/ag-product-readiness-gate.md',
  csvPath = 'dist/ag-product-readiness-gate.csv',
  gapJsonPath = 'dist/ag-strict-gap-audit.json',
  gapMarkdownPath = 'dist/ag-strict-gap-audit.md',
  gapCsvPath = 'dist/ag-strict-gap-audit.csv',
  targets = defaultTargets,
  failOnBlocked = false
} = {}) {
  const gapReport = await runAgGapAudit({
    jsonPath: gapJsonPath,
    markdownPath: gapMarkdownPath,
    csvPath: gapCsvPath
  });
  const generatedArtifactPaths = new Set([jsonPath, markdownPath, csvPath].map((path) => resolve(path)));
  const lanes = await Promise.all(productLanes.map((lane) => evaluateLane(lane, gapReport, { generatedArtifactPaths })));
  const docChecks = gapReport.docs.map((doc) => ({
    checkId: `doc_${doc.id.toLowerCase()}_product_target`,
    docId: doc.id,
    title: doc.title,
    status: doc.productReadinessScore >= targets.docProductReadiness ? 'passed' : 'blocked',
    actual: doc.productReadinessScore,
    target: targets.docProductReadiness,
    gap: round(targets.docProductReadiness - doc.productReadinessScore)
  }));
  const lowRequirements = gapReport.docs
    .flatMap((doc) => doc.requirements.map((requirement) => ({
      docId: doc.id,
      docTitle: doc.title,
      id: requirement.id,
      title: requirement.title,
      productReadiness: round(requirement.productReadiness * 100),
      target: targets.requirementProductReadiness,
      gap: round(targets.requirementProductReadiness - requirement.productReadiness * 100),
      laneId: laneIdForRequirement(requirement),
      nextAction: requirement.nextActions?.[0] ?? null,
      weight: requirement.weight
    })))
    .filter((item) => item.productReadiness < targets.requirementProductReadiness)
    .sort((a, b) => (b.gap * b.weight) - (a.gap * a.weight))
    .slice(0, 20);
  const checks = [
    {
      checkId: 'overall_product_readiness_target',
      status: gapReport.overall.productReadinessScore >= targets.overallProductReadiness ? 'passed' : 'blocked',
      actual: gapReport.overall.productReadinessScore,
      target: targets.overallProductReadiness,
      gap: round(targets.overallProductReadiness - gapReport.overall.productReadinessScore)
    },
    {
      checkId: 'all_doc_product_targets',
      status: docChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      blockedDocs: docChecks.filter((check) => check.status === 'blocked').map((check) => check.docId)
    },
    {
      checkId: 'all_product_lanes_have_artifact_plan',
      status: lanes.every((lane) => lane.commands.length > 0 && lane.artifactChecks.length > 0) ? 'passed' : 'blocked',
      lanes: lanes.map((lane) => lane.laneId)
    },
    {
      checkId: 'high_gap_requirements_triaged',
      status: lowRequirements.length > 0 ? 'blocked' : 'passed',
      count: lowRequirements.length
    }
  ];
  const status = checks.some((check) => check.status === 'blocked') ? 'blocked' : 'passed';
  const nextExecutionQueue = buildNextExecutionQueue({ lanes, lowRequirements });
  const report = {
    reportVersion: 'ag-product-readiness-gate-v1',
    generatedAt: new Date().toISOString(),
    status,
    targets,
    overall: gapReport.overall,
    checks,
    docChecks,
    lanes,
    lowRequirements,
    recommendedDirections,
    nextExecutionQueue,
    summary: {
      blockedDocCount: docChecks.filter((check) => check.status === 'blocked').length,
      laneCount: lanes.length,
      lanesWithMissingArtifacts: lanes.filter((lane) => lane.missingArtifactCount > 0).length,
      lowRequirementCount: lowRequirements.length,
      highestImpactLane: nextExecutionQueue[0]?.laneId ?? null
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');

  if (failOnBlocked && report.status !== 'passed') {
    throw new Error(`A-G product readiness gate is ${report.status}: ${report.overall.productReadinessScore}% < ${targets.overallProductReadiness}%`);
  }
  return report;
}

async function evaluateLane(lane, gapReport, { generatedArtifactPaths = new Set() } = {}) {
  const docs = gapReport.docs.filter((doc) => lane.docs.includes(doc.id));
  const artifactChecks = await Promise.all(lane.artifacts.map(async (path) => {
    const resolvedPath = resolve(path);
    const generatedByCurrentRun = generatedArtifactPaths.has(resolvedPath);
    const fileExists = await pathExists(resolvedPath);
    const exists = fileExists || generatedByCurrentRun;
    const parsed = fileExists && path.endsWith('.json') ? await readJsonSafe(resolvedPath) : null;
    return {
      path,
      exists,
      status: generatedByCurrentRun && !fileExists ? 'generated-current-run' : exists ? 'present' : 'missing',
      reportStatus: parsed?.status ?? parsed?.summary?.status ?? (generatedByCurrentRun ? 'pending-current-run-write' : null),
      reportVersion: parsed?.reportVersion ?? parsed?.packageVersion ?? (generatedByCurrentRun && path.endsWith('.json') ? 'ag-product-readiness-gate-v1' : null)
    };
  }));
  const missingArtifactCount = artifactChecks.filter((check) => !check.exists).length;
  const docAverage = docs.length ? round(docs.reduce((sum, doc) => sum + doc.productReadinessScore, 0) / docs.length) : 0;
  return {
    laneVersion: 'ag-product-readiness-lane-v1',
    laneId: lane.laneId,
    title: lane.title,
    docs: lane.docs,
    status: missingArtifactCount === 0 ? 'evidence-present' : 'needs-evidence',
    docProductReadinessAverage: docAverage,
    externalDependencies: lane.externalDependencies,
    commands: lane.commands,
    artifactChecks,
    missingArtifactCount,
    primaryGap: lanePrimaryGap(lane, gapReport)
  };
}

function lanePrimaryGap(lane, gapReport) {
  const gaps = gapReport.docs
    .filter((doc) => lane.docs.includes(doc.id))
    .flatMap((doc) => doc.requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      productReadiness: round(requirement.productReadiness * 100),
      nextAction: requirement.nextActions?.[0] ?? null,
      impact: round((1 - requirement.productReadiness) * requirement.weight * 100)
    })))
    .sort((a, b) => b.impact - a.impact);
  return gaps[0] ?? null;
}

function laneIdForRequirement(requirement) {
  if (requirement.id.startsWith('A-')) return 'windows-service-lane';
  if (requirement.id === 'B-06') return 'browser-soak-lane';
  if (requirement.id.startsWith('B-')) return 'windows-service-lane';
  if (requirement.id.startsWith('C-') || requirement.id.startsWith('D-')) return 'mobile-device-lane';
  if (requirement.id.startsWith('E-')) return 'security-redteam-lane';
  if (requirement.id.startsWith('F-')) return 'growth-quality-lane';
  if (['G-07', 'G-08'].includes(requirement.id)) return 'security-redteam-lane';
  return 'verification-dashboard-lane';
}

function buildNextExecutionQueue({ lanes, lowRequirements }) {
  const byLane = new Map(lanes.map((lane) => [lane.laneId, { lane, requirements: [] }]));
  for (const requirement of lowRequirements) {
    const item = byLane.get(requirement.laneId);
    if (item) item.requirements.push(requirement);
  }
  return [...byLane.values()]
    .map(({ lane, requirements }) => ({
      laneId: lane.laneId,
      title: lane.title,
      priorityScore: round(lane.missingArtifactCount * 10 + requirements.reduce((sum, item) => sum + item.gap * item.weight, 0)),
      missingArtifactCount: lane.missingArtifactCount,
      lowRequirementCount: requirements.length,
      firstCommand: lane.commands[0] ?? null,
      keyArtifacts: lane.artifactChecks.map((check) => check.path),
      topRequirement: requirements[0] ?? lane.primaryGap
    }))
    .filter((item) => item.priorityScore > 0)
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS A-G Product Readiness Gate',
    '',
    `Status: **${report.status}**`,
    `Overall product readiness: **${report.overall.productReadinessScore}%** / target ${report.targets.overallProductReadiness}%`,
    `Strict implementation: **${report.overall.strictScore}%**`,
    '',
    '## Recommended Direction',
    '',
    ...report.recommendedDirections.map((item) => `- **${item.label}**: ${item.value} ${item.reason}`),
    '',
    '## Execution Queue',
    '',
    '| Priority | Lane | Missing artifacts | Low requirements | First command |',
    '| --- | --- | ---: | ---: | --- |',
    ...report.nextExecutionQueue.map((item) => `| ${item.priorityScore} | ${escapeMd(item.title)} | ${item.missingArtifactCount} | ${item.lowRequirementCount} | \`${escapeMd(item.firstCommand ?? '')}\` |`),
    '',
    '## Document Targets',
    '',
    '| Doc | Product | Target | Status |',
    '| --- | ---: | ---: | --- |',
    ...report.docChecks.map((check) => `| ${check.docId} ${escapeMd(check.title)} | ${check.actual}% | ${check.target}% | ${check.status} |`),
    '',
    '## Product Lanes',
    '',
    ...report.lanes.flatMap((lane) => [
      `### ${lane.title}`,
      '',
      `Status: **${lane.status}**`,
      `Docs: ${lane.docs.join(', ')}`,
      `External dependencies: ${lane.externalDependencies.join(', ')}`,
      '',
      'Commands:',
      ...lane.commands.map((command) => `- \`${command}\``),
      '',
      'Artifacts:',
      ...lane.artifactChecks.map((check) => `- ${check.exists ? 'present' : 'missing'}: \`${check.path}\``),
      ''
    ]),
    '## Highest Product Gaps',
    '',
    '| Requirement | Product | Lane | Next action |',
    '| --- | ---: | --- | --- |',
    ...report.lowRequirements.slice(0, 12).map((item) => `| ${item.id} ${escapeMd(item.title)} | ${item.productReadiness}% | ${item.laneId} | ${escapeMd(item.nextAction ?? '')} |`)
  ];
  return `${lines.join('\n')}\n`;
}

function renderCsv(report) {
  const rows = [['kind', 'requirement_id', 'title', 'status', 'product', 'target', 'lane', 'next_action'].join(',')];
  for (const check of report.docChecks) {
    rows.push(['doc', check.docId, csv(check.title), check.status, check.actual, check.target, '', ''].join(','));
  }
  for (const lane of report.lanes) {
    rows.push(['lane', lane.laneId, csv(lane.title), lane.status, lane.docProductReadinessAverage, '', lane.laneId, csv(lane.primaryGap?.nextAction ?? '')].join(','));
  }
  for (const item of report.lowRequirements) {
    rows.push(['requirement', item.id, csv(item.title), 'blocked', item.productReadiness, item.target, item.laneId, csv(item.nextAction ?? '')].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
    else if (arg === '--overall-target') args.overallProductReadiness = Number(argv[++index]);
    else if (arg === '--doc-target') args.docProductReadiness = Number(argv[++index]);
    else if (arg === '--requirement-target') args.requirementProductReadiness = Number(argv[++index]);
    else if (arg === '--fail-on-blocked') args.failOnBlocked = true;
  }
  const targets = {
    ...defaultTargets,
    ...(Number.isFinite(args.overallProductReadiness) ? { overallProductReadiness: args.overallProductReadiness } : {}),
    ...(Number.isFinite(args.docProductReadiness) ? { docProductReadiness: args.docProductReadiness } : {}),
    ...(Number.isFinite(args.requirementProductReadiness) ? { requirementProductReadiness: args.requirementProductReadiness } : {})
  };
  return {
    jsonPath: args.jsonPath ?? 'dist/ag-product-readiness-gate.json',
    markdownPath: args.markdownPath ?? 'dist/ag-product-readiness-gate.md',
    csvPath: args.csvPath ?? 'dist/ag-product-readiness-gate.csv',
    targets,
    failOnBlocked: args.failOnBlocked === true
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProductReadinessGate(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS A-G Product Readiness Gate');
  console.log(`Status: ${report.status}`);
  console.log(`Overall product readiness: ${report.overall.productReadinessScore}% / ${report.targets.overallProductReadiness}%`);
  console.log(`Blocked docs: ${report.summary.blockedDocCount}`);
  console.log(`Top lane: ${report.summary.highestImpactLane ?? 'none'}`);
  console.log('Reports: dist/ag-product-readiness-gate.json, dist/ag-product-readiness-gate.md, dist/ag-product-readiness-gate.csv');
  if (report.status !== 'passed' && parseArgs(process.argv.slice(2)).failOnBlocked) process.exitCode = 1;
}
