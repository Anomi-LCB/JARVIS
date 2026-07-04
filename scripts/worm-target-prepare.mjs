import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultTargetDir = 'artifacts/worm-target';
const defaultDistDir = 'dist';
const defaultOutputDir = 'dist/worm-target';
const defaultJsonPath = 'dist/worm-target-report.json';
const defaultMarkdownPath = 'dist/worm-target-report.md';

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
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function isSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

function workspaceRelative(workspaceRoot, path) {
  return normalizePath(relative(workspaceRoot, path));
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

async function writeTargetDocs({ targetRoot, workspaceRoot }) {
  const metadataPath = join(targetRoot, '.jarvis-worm-target.json');
  const policyPath = join(targetRoot, 'APPEND_ONLY_POLICY.md');
  const readmePath = join(targetRoot, 'README.md');
  const metadata = {
    targetVersion: 'jarvis-worm-target-v1',
    initializedAt: new Date().toISOString(),
    appendOnlyPolicy: 'copy-only-when-absent-or-byte-identical; block-on-existing-mismatch',
    rawCredentialsStored: false,
    rawCommandStored: false
  };
  if (!(await exists(metadataPath))) {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  }
  if (!(await exists(policyPath))) {
    await writeFile(policyPath, [
      '# JARVIS WORM Target Policy',
      '',
      'This directory is used as an append-only artifact target for JARVIS release evidence.',
      '',
      '- New bundle hashes may be added.',
      '- Existing bundle files must be byte-identical or sync is blocked.',
      '- Raw credentials, shell commands, and operator secrets are not stored here.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!(await exists(readmePath))) {
    await writeFile(readmePath, [
      '# JARVIS WORM Target',
      '',
      `Workspace: \`${workspaceRelative(workspaceRoot, workspaceRoot)}\``,
      'Use `npm run ops:worm-sync -- --external-dir "<this-directory>"` to copy the current promotion manifest.',
      ''
    ].join('\n'), 'utf8');
  }
  return { metadataPath, policyPath, readmePath };
}

export async function runWormTargetPrepare({
  workspaceRoot = process.cwd(),
  targetDir = process.env.JARVIS_WORM_SYNC_DIR || process.env.JARVIS_WORM_APPEND_ONLY_DIR || resolve(workspaceRoot, defaultTargetDir),
  distDir = resolve(workspaceRoot, defaultDistDir),
  outputDir = resolve(workspaceRoot, defaultOutputDir),
  jsonPath = resolve(workspaceRoot, defaultJsonPath),
  markdownPath = resolve(workspaceRoot, defaultMarkdownPath)
} = {}) {
  const targetRoot = resolve(targetDir);
  const distRoot = resolve(distDir);
  const outputRoot = resolve(outputDir);
  const manifestPath = join(distRoot, 'worm-promotion', 'manifest.json');
  const manifestHashPath = join(distRoot, 'worm-promotion', 'manifest.sha256');
  const proofPath = join(distRoot, 'worm-promotion', 'external-sync-proof.json');
  const manifest = await readJson(manifestPath);
  const proof = await readJson(proofPath);

  await mkdir(targetRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  const targetDocs = await writeTargetDocs({ targetRoot, workspaceRoot });

  const bundleHash = manifest?.bundleHash ?? null;
  const targetBundleDir = bundleHash ? join(targetRoot, bundleHash) : null;
  const targetManifestPath = targetBundleDir ? join(targetBundleDir, 'manifest.json') : null;
  const targetHashPath = targetBundleDir ? join(targetBundleDir, 'manifest.sha256') : null;
  const targetProofPath = targetBundleDir ? join(targetBundleDir, 'sync-proof.json') : null;
  const targetManifestExists = targetManifestPath ? await exists(targetManifestPath) : false;
  const targetHashExists = targetHashPath ? await exists(targetHashPath) : false;
  const localManifestHash = await exists(manifestPath) ? await sha256File(manifestPath) : null;
  const localHashFileHash = await exists(manifestHashPath) ? await sha256File(manifestHashPath) : null;
  const targetManifestHash = targetManifestExists ? await sha256File(targetManifestPath) : null;
  const targetHashFileHash = targetHashExists ? await sha256File(targetHashPath) : null;
  const targetManifestMatches = !targetManifestExists || targetManifestHash === localManifestHash;
  const targetHashMatches = !targetHashExists || targetHashFileHash === localHashFileHash;
  const targetUnderDist = isInside(distRoot, targetRoot);
  const targetUnderPromotionStaging = isInside(join(distRoot, 'worm-promotion'), targetRoot);
  const proofMatchesTarget = isSynced(proof?.status)
    && proof?.target?.root
    && resolve(proof.target.root) === targetRoot;
  const blockedMismatch = !targetManifestMatches || !targetHashMatches;

  const checks = [
    {
      checkId: 'local_worm_manifest_ready',
      passed: manifest?.status === 'ready-for-external-worm-promotion',
      detail: { status: manifest?.status ?? 'missing', bundleHash }
    },
    {
      checkId: 'target_directory_initialized',
      passed: await exists(targetRoot),
      detail: { targetRoot }
    },
    {
      checkId: 'target_outside_dist',
      passed: !targetUnderDist,
      detail: { targetRoot, distRoot }
    },
    {
      checkId: 'target_not_inside_promotion_staging',
      passed: !targetUnderPromotionStaging,
      detail: { targetRoot }
    },
    {
      checkId: 'append_only_policy_documented',
      passed: await exists(targetDocs.policyPath),
      detail: { policyPath: workspaceRelative(workspaceRoot, targetDocs.policyPath) }
    },
    {
      checkId: 'existing_bundle_manifest_matches',
      passed: targetManifestMatches,
      detail: { targetManifestExists, localManifestHash, targetManifestHash }
    },
    {
      checkId: 'existing_bundle_hash_file_matches',
      passed: targetHashMatches,
      detail: { targetHashExists, localHashFileHash, targetHashFileHash }
    },
    {
      checkId: 'raw_secret_or_command_not_stored',
      passed: proof?.rawCredentialsStored !== true && proof?.rawCommandStored !== true,
      detail: {
        wormRawCredentialsStored: proof?.rawCredentialsStored ?? null,
        wormRawCommandStored: proof?.rawCommandStored ?? null
      }
    }
  ];

  const blockingChecks = checks.filter((check) => !check.passed);
  const status = blockedMismatch
    ? 'blocked-existing-bundle-mismatch'
    : proofMatchesTarget
      ? 'synced'
      : blockingChecks.length === 0
        ? 'ready-for-worm-sync'
        : 'blocked-target-not-ready';
  const syncCommand = `npm run ops:worm-sync -- --external-dir "${targetRoot}"`;
  const finalRefreshCommand = [
    'npm run ops:worm-promotion',
    syncCommand,
    'npm run ops:field-kit',
    'npm run ag:handoff',
    'npm run ops:preflight',
    'npm run ops:final-gate'
  ].join('; ');

  const report = {
    reportVersion: 'jarvis-worm-target-prepare-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      targetRoot,
      manifestStatus: manifest?.status ?? 'missing',
      bundleHash,
      proofStatus: proof?.status ?? 'missing',
      proofMatchesTarget: Boolean(proofMatchesTarget),
      blockingCheckCount: blockingChecks.length,
      syncCommand,
      finalRefreshCommand
    },
    checks,
    target: {
      root: targetRoot,
      metadataPath: targetDocs.metadataPath,
      policyPath: targetDocs.policyPath,
      readmePath: targetDocs.readmePath,
      targetBundleDir,
      targetManifestPath,
      targetHashPath,
      targetProofPath,
      appendOnlyPolicy: 'copy-only-when-absent-or-byte-identical; block-on-existing-mismatch'
    },
    generatedArtifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      rawCredentialsStored: false,
      rawCommandStored: false
    },
    nextActions: buildNextActions({ status, syncCommand, finalRefreshCommand })
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function buildNextActions({ status, syncCommand, finalRefreshCommand }) {
  if (status === 'ready-for-worm-sync') {
    return [syncCommand, 'Run npm run ops:worm-target again to confirm synced status after sync.'];
  }
  if (status === 'synced') {
    return ['Run npm run ops:preflight; npm run ops:final-gate to refresh release status.'];
  }
  if (status === 'blocked-existing-bundle-mismatch') {
    return ['Use a new empty append-only target or investigate the existing mismatched bundle before retrying.'];
  }
  return [finalRefreshCommand];
}

function renderMarkdown(report) {
  return [
    '# JARVIS WORM Target Prepare',
    '',
    `Status: **${report.status}**`,
    `Target root: \`${report.summary.targetRoot}\``,
    `Bundle hash: \`${report.summary.bundleHash ?? 'missing'}\``,
    `Proof status: ${report.summary.proofStatus}`,
    `Sync command: \`${report.summary.syncCommand}\``,
    '',
    '## Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.passed ? 'yes' : 'no'} |`),
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
    else if (arg === '--target-dir' || arg === '--target') args.targetDir = argv[++index];
    else if (arg === '--dist-dir') args.distDir = argv[++index];
    else if (arg === '--output-dir') args.outputDir = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runWormTargetPrepare(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS WORM Target Prepare');
  console.log(`Status: ${report.status}`);
  console.log(`Target: ${report.summary.targetRoot}`);
  console.log(`Bundle hash: ${report.summary.bundleHash ?? 'missing'}`);
  console.log(`Sync command: ${report.summary.syncCommand}`);
  console.log('Reports: dist/worm-target-report.json, dist/worm-target-report.md');
  if (report.status.startsWith('blocked')) process.exitCode = 1;
}
