import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultSourceDir = 'dist/field-validation-import';
const defaultTargetDir = 'dist/field-validation';
const defaultDistDir = 'dist';
const defaultJsonPath = 'dist/field-evidence-import-report.json';
const defaultMarkdownPath = 'dist/field-evidence-import-report.md';

const coreEvidenceFiles = [
  'package-manifest.json',
  'installed-service-verification.json',
  'installed-service-smoke.json',
  'installed-service-soak.json'
];

const pcEvidenceFiles = [
  'package-manifest.json',
  'service-smoke-report.json',
  'install-release-report.json',
  'release-gate-report.json',
  'release-evidence.json',
  'signature-verification-report.json',
  'tray-state.json'
];

const rootEvidenceFiles = [
  'field-validation-run-summary.json'
];

const wormEvidenceFiles = [
  'external-sync-proof.json',
  'external-sync-proof.md'
];

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(stripBom(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

function stripBom(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function statusFromReport(report) {
  return String(report?.status ?? '').toLowerCase();
}

function isPassedStatus(status) {
  return ['passed', 'passed-with-warnings', 'ready', 'ready-with-warnings', 'verified'].includes(status);
}

function isSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

function sourceCandidates(sourceDir, section, fileName) {
  if (section === 'root') {
    return [
      join(sourceDir, fileName),
      join(sourceDir, 'field-validation', fileName)
    ];
  }
  if (section === 'worm-promotion') {
    return [
      join(sourceDir, 'worm-promotion', fileName),
      join(sourceDir, 'dist', 'worm-promotion', fileName)
    ];
  }
  return [
    join(sourceDir, section, fileName),
    join(sourceDir, 'field-validation', section, fileName),
    join(sourceDir, 'dist', 'field-validation', section, fileName)
  ];
}

async function findSource(sourceDir, section, fileName) {
  for (const candidate of sourceCandidates(sourceDir, section, fileName)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function targetPath({ targetDir, distDir, section, fileName }) {
  if (section === 'root') return join(targetDir, fileName);
  if (section === 'worm-promotion') return join(distDir, 'worm-promotion', fileName);
  return join(targetDir, section, fileName);
}

async function copyEvidenceFile({ workspaceRoot, sourceDir, targetDir, distDir, section, fileName }) {
  const sourcePath = await findSource(sourceDir, section, fileName);
  const target = targetPath({ targetDir, distDir, section, fileName });
  if (!sourcePath) {
    return {
      section,
      fileName,
      imported: false,
      sourcePath: null,
      targetPath: normalizePath(relative(workspaceRoot, target)),
      sha256: null,
      status: 'missing'
    };
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  const report = fileName.endsWith('.json') ? await readJson(target) : null;
  const status = statusFromReport(report) || 'present';
  return {
    section,
    fileName,
    imported: true,
    sourcePath: normalizePath(relative(workspaceRoot, sourcePath)),
    targetPath: normalizePath(relative(workspaceRoot, target)),
    sha256: await sha256File(target),
    status
  };
}

function sectionStatus(records, requiredFiles) {
  const required = records.filter((record) => requiredFiles.includes(record.fileName));
  if (required.every((record) => record.imported && isPassedStatus(record.status))) return 'verified';
  if (required.some((record) => record.imported)) return 'partial';
  return 'missing';
}

async function readImportedJson({ targetDir, distDir }) {
  const [fieldRunSummary, wormProof] = await Promise.all([
    readJson(join(targetDir, 'field-validation-run-summary.json')),
    readJson(join(distDir, 'worm-promotion', 'external-sync-proof.json'))
  ]);
  return { fieldRunSummary, wormProof };
}

export async function runFieldEvidenceImport({
  workspaceRoot = process.cwd(),
  sourceDir = resolve(workspaceRoot, defaultSourceDir),
  targetDir = resolve(workspaceRoot, defaultTargetDir),
  distDir = resolve(workspaceRoot, defaultDistDir),
  jsonPath = resolve(workspaceRoot, defaultJsonPath),
  markdownPath = resolve(workspaceRoot, defaultMarkdownPath)
} = {}) {
  const sourceRoot = resolve(sourceDir);
  const targetRoot = resolve(targetDir);
  const distRoot = resolve(distDir);
  const sourcePresent = await exists(sourceRoot);

  await mkdir(targetRoot, { recursive: true });
  await mkdir(join(targetRoot, 'core'), { recursive: true });
  await mkdir(join(targetRoot, 'pc-agent'), { recursive: true });
  await mkdir(join(distRoot, 'worm-promotion'), { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  const records = [];
  if (sourcePresent) {
    for (const fileName of rootEvidenceFiles) {
      records.push(await copyEvidenceFile({ workspaceRoot, sourceDir: sourceRoot, targetDir: targetRoot, distDir: distRoot, section: 'root', fileName }));
    }
    for (const fileName of coreEvidenceFiles) {
      records.push(await copyEvidenceFile({ workspaceRoot, sourceDir: sourceRoot, targetDir: targetRoot, distDir: distRoot, section: 'core', fileName }));
    }
    for (const fileName of pcEvidenceFiles) {
      records.push(await copyEvidenceFile({ workspaceRoot, sourceDir: sourceRoot, targetDir: targetRoot, distDir: distRoot, section: 'pc-agent', fileName }));
    }
    for (const fileName of wormEvidenceFiles) {
      records.push(await copyEvidenceFile({ workspaceRoot, sourceDir: sourceRoot, targetDir: targetRoot, distDir: distRoot, section: 'worm-promotion', fileName }));
    }
  }

  const { fieldRunSummary, wormProof } = await readImportedJson({ targetDir: targetRoot, distDir: distRoot });
  const coreStatus = sectionStatus(records.filter((record) => record.section === 'core'), [
    'installed-service-verification.json',
    'installed-service-smoke.json',
    'installed-service-soak.json'
  ]);
  const pcStatus = sectionStatus(records.filter((record) => record.section === 'pc-agent'), [
    'service-smoke-report.json',
    'install-release-report.json',
    'release-evidence.json'
  ]);
  const fieldRunStatus = statusFromReport(fieldRunSummary) || 'missing';
  const fieldRunVerified = fieldRunStatus === 'passed';
  const wormStatus = wormProof?.status ?? 'missing';
  const importedCount = records.filter((record) => record.imported).length;
  const status = !sourcePresent
    ? 'blocked-missing-source'
    : importedCount === 0
      ? 'blocked-no-importable-evidence'
      : coreStatus === 'verified' && pcStatus === 'verified' && fieldRunVerified
        ? 'imported-field-evidence'
        : 'imported-partial-evidence';

  const report = {
    reportVersion: 'jarvis-field-evidence-import-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      sourceDir: resolve(sourceRoot),
      targetDir: resolve(targetRoot),
      sourcePresent,
      importedCount,
      coreStatus,
      pcAgentStatus: pcStatus,
      fieldRunStatus,
      wormSyncStatus: wormStatus,
      wormSyncVerified: isSynced(wormStatus),
      refreshCommand: 'npm run ops:field-kit; npm run ag:handoff; npm run ops:preflight; npm run ops:final-gate'
    },
    checks: [
      {
        checkId: 'source_directory_present',
        passed: sourcePresent,
        detail: { sourceDir: resolve(sourceRoot) }
      },
      {
        checkId: 'allowed_evidence_imported',
        passed: importedCount > 0,
        detail: { importedCount }
      },
      {
        checkId: 'field_run_summary_passed',
        passed: fieldRunVerified,
        detail: { status: fieldRunStatus }
      },
      {
        checkId: 'core_admin_evidence_verified',
        passed: coreStatus === 'verified',
        detail: { status: coreStatus }
      },
      {
        checkId: 'pc_agent_admin_evidence_verified',
        passed: pcStatus === 'verified',
        detail: { status: pcStatus }
      },
      {
        checkId: 'raw_secret_or_command_not_stored',
        passed: wormProof?.rawCredentialsStored !== true && wormProof?.rawCommandStored !== true,
        detail: {
          wormRawCredentialsStored: wormProof?.rawCredentialsStored ?? null,
          wormRawCommandStored: wormProof?.rawCommandStored ?? null
        }
      }
    ],
    importedFiles: records,
    generatedArtifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      rawAdminTokenStored: false,
      rawWormCredentialStored: false,
      rawExternalCommandStored: false
    },
    nextActions: buildNextActions({ status, fieldRunVerified, coreStatus, pcStatus, wormStatus })
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildNextActions({ status, fieldRunVerified, coreStatus, pcStatus, wormStatus }) {
  if (status === 'blocked-missing-source') {
    return ['Provide --source-dir pointing to the copied field validation evidence folder.'];
  }
  if (status === 'blocked-no-importable-evidence') {
    return ['Use a source folder containing field-validation-run-summary.json plus core/ and pc-agent/ evidence files.'];
  }
  const actions = [];
  if (!fieldRunVerified || coreStatus !== 'verified' || pcStatus !== 'verified') {
    actions.push('Run the administrator field validation kit on the target Windows machine, then import that evidence folder again.');
  }
  if (!isSynced(wormStatus)) {
    actions.push('Run ops:worm-sync with an append-only target, or include worm-promotion/external-sync-proof.json in the import source.');
  }
  actions.push('Run npm run ops:field-kit; npm run ag:handoff; npm run ops:preflight; npm run ops:final-gate.');
  return actions;
}

function renderMarkdown(report) {
  return [
    '# JARVIS Field Evidence Import',
    '',
    `Status: **${report.status}**`,
    `Source: \`${report.summary.sourceDir}\``,
    `Imported files: ${report.summary.importedCount}`,
    `Core admin evidence: ${report.summary.coreStatus}`,
    `PC Agent evidence: ${report.summary.pcAgentStatus}`,
    `Field run summary: ${report.summary.fieldRunStatus}`,
    `External WORM sync: ${report.summary.wormSyncStatus}`,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.passed ? 'yes' : 'no'} |`),
    '',
    '## Imported Files',
    '',
    '| Section | File | Imported | SHA-256 |',
    '| --- | --- | --- | --- |',
    ...report.importedFiles.map((file) => `| ${file.section} | ${file.fileName} | ${file.imported ? 'yes' : 'no'} | ${file.sha256 ?? 'missing'} |`),
    '',
    '## Next Actions',
    '',
    ...report.nextActions.map((action) => `- ${action}`),
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--source-dir' || arg === '--source') args.sourceDir = argv[++index];
    else if (arg === '--target-dir' || arg === '--target') args.targetDir = argv[++index];
    else if (arg === '--dist-dir') args.distDir = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFieldEvidenceImport(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Field Evidence Import');
  console.log(`Status: ${report.status}`);
  console.log(`Imported files: ${report.summary.importedCount}`);
  console.log(`Core admin evidence: ${report.summary.coreStatus}`);
  console.log(`PC Agent evidence: ${report.summary.pcAgentStatus}`);
  console.log(`Field run summary: ${report.summary.fieldRunStatus}`);
  console.log('Reports: dist/field-evidence-import-report.json, dist/field-evidence-import-report.md');
  if (report.status.startsWith('blocked')) process.exitCode = 1;
}
