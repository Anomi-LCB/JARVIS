import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultManifestPath = 'dist/worm-promotion/manifest.json';
const defaultManifestHashPath = 'dist/worm-promotion/manifest.sha256';
const defaultOutputPath = 'dist/worm-promotion/external-sync-proof.json';
const defaultMarkdownPath = 'dist/worm-promotion/external-sync-proof.md';

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

async function copyIfAbsentOrMatching(source, target) {
  const sourceHash = await sha256File(source);
  if (await exists(target)) {
    const targetHash = await sha256File(target);
    return {
      copied: false,
      matchedExisting: targetHash === sourceHash,
      sourceHash,
      targetHash
    };
  }

  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return {
    copied: true,
    matchedExisting: true,
    sourceHash,
    targetHash: sourceHash
  };
}

function appendOnlyTargetFromEnv(env = process.env) {
  const targetDir = env.JARVIS_WORM_SYNC_DIR || env.JARVIS_WORM_APPEND_ONLY_DIR;
  if (!targetDir) return null;
  return {
    provider: 'local-append-only-directory',
    root: resolve(targetDir),
    env: targetDir === env.JARVIS_WORM_SYNC_DIR ? 'JARVIS_WORM_SYNC_DIR' : 'JARVIS_WORM_APPEND_ONLY_DIR'
  };
}

export async function runExternalWormSync({
  manifestPath = defaultManifestPath,
  manifestHashPath = defaultManifestHashPath,
  outputPath = defaultOutputPath,
  markdownPath = defaultMarkdownPath,
  externalDir = appendOnlyTargetFromEnv()?.root,
  provider = externalDir ? 'local-append-only-directory' : 'not-configured',
  providerEnv = appendOnlyTargetFromEnv()?.env ?? null
} = {}) {
  const manifest = await readJson(manifestPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  if (!manifest) {
    const proof = buildProof({
      status: 'blocked-missing-local-manifest',
      manifest,
      provider,
      providerEnv,
      manifestPath,
      manifestHashPath,
      externalDir,
      details: {
        message: `Missing WORM manifest: ${manifestPath}`
      }
    });
    await writeProof({ proof, outputPath, markdownPath });
    return proof;
  }

  if (manifest.status !== 'ready-for-external-worm-promotion') {
    const proof = buildProof({
      status: 'blocked-local-manifest-not-ready',
      manifest,
      provider,
      providerEnv,
      manifestPath,
      manifestHashPath,
      externalDir,
      details: {
        localManifestStatus: manifest.status
      }
    });
    await writeProof({ proof, outputPath, markdownPath });
    return proof;
  }

  const sourceManifestHash = await sha256File(manifestPath);
  const sourceHashFilePresent = await exists(manifestHashPath);
  const sourceHashFileHash = sourceHashFilePresent ? await sha256File(manifestHashPath) : null;

  if (!externalDir) {
    const proof = buildProof({
      status: 'not-configured-local-staging-only',
      manifest,
      provider,
      providerEnv,
      manifestPath,
      manifestHashPath,
      externalDir,
      sourceManifestHash,
      sourceHashFileHash,
      details: {
        configuredEnv: ['JARVIS_WORM_SYNC_DIR', 'JARVIS_WORM_APPEND_ONLY_DIR'],
        commandEnvDeprecated: 'JARVIS_WORM_SYNC_COMMAND',
        localBundleDir: manifest.localAppendOnlyStaging?.bundleDir ?? null
      }
    });
    await writeProof({ proof, outputPath, markdownPath });
    return proof;
  }

  const bundleHash = manifest.bundleHash;
  const targetBundleDir = join(resolve(externalDir), bundleHash);
  const targetManifestPath = join(targetBundleDir, 'manifest.json');
  const targetManifestHashPath = join(targetBundleDir, 'manifest.sha256');
  const targetProofPath = join(targetBundleDir, 'sync-proof.json');

  const manifestCopy = await copyIfAbsentOrMatching(manifestPath, targetManifestPath);
  const hashCopy = sourceHashFilePresent
    ? await copyIfAbsentOrMatching(manifestHashPath, targetManifestHashPath)
    : {
        copied: false,
        matchedExisting: true,
        sourceHash: null,
        targetHash: null
      };
  const blockedByMismatch = !manifestCopy.matchedExisting || !hashCopy.matchedExisting;
  const priorProof = await readJson(targetProofPath);
  const status = blockedByMismatch
    ? 'blocked-existing-bundle-mismatch'
    : priorProof?.status === 'synced' || priorProof?.status === 'already-synced'
      ? 'already-synced'
      : 'synced';

  const proof = buildProof({
    status,
    manifest,
    provider,
    providerEnv,
    manifestPath,
    manifestHashPath,
    externalDir,
    sourceManifestHash,
    sourceHashFileHash,
    details: {
      targetBundleDir: resolve(targetBundleDir),
      targetManifestPath: resolve(targetManifestPath),
      targetManifestHashPath: resolve(targetManifestHashPath),
      targetProofPath: resolve(targetProofPath),
      manifestCopy,
      hashCopy,
      priorProofStatus: priorProof?.status ?? null
    }
  });

  if (!blockedByMismatch) {
    await writeFile(targetProofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  }
  await writeProof({ proof, outputPath, markdownPath });
  return proof;
}

function buildProof({
  status,
  manifest,
  provider,
  providerEnv,
  manifestPath,
  manifestHashPath,
  externalDir,
  sourceManifestHash = null,
  sourceHashFileHash = null,
  details = {}
}) {
  return {
    proofVersion: 'jarvis-external-worm-sync-proof-v1',
    generatedAt: new Date().toISOString(),
    status,
    provider,
    providerEnv,
    bundleHash: manifest?.bundleHash ?? null,
    artifactCount: manifest?.artifactCount ?? null,
    localManifest: {
      path: normalizePath(relative(process.cwd(), manifestPath)),
      sha256: sourceManifestHash,
      hashFilePath: normalizePath(relative(process.cwd(), manifestHashPath)),
      hashFileSha256: sourceHashFileHash
    },
    target: {
      root: externalDir ? resolve(externalDir) : null,
      appendOnlyPolicy: externalDir
        ? 'copy-only-when-absent-or-byte-identical; block-on-existing-mismatch'
        : 'external target not configured'
    },
    rawCredentialsStored: false,
    rawCommandStored: false,
    details
  };
}

async function writeProof({ proof, outputPath, markdownPath }) {
  await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(proof), 'utf8');
}

function renderMarkdown(proof) {
  return [
    '# JARVIS External WORM Sync Proof',
    '',
    `Status: **${proof.status}**`,
    `Provider: ${proof.provider}`,
    `Bundle hash: \`${proof.bundleHash ?? 'missing'}\``,
    `Artifacts: ${proof.artifactCount ?? 'missing'}`,
    `Target root: \`${proof.target.root ?? 'not configured'}\``,
    `Append-only policy: ${proof.target.appendOnlyPolicy}`,
    `Raw credentials stored: ${proof.rawCredentialsStored ? 'yes' : 'no'}`,
    `Raw command stored: ${proof.rawCommandStored ? 'yes' : 'no'}`,
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifestPath = argv[++index];
    else if (arg === '--manifest-sha256') args.manifestHashPath = argv[++index];
    else if (arg === '--output' || arg === '--json') args.outputPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--external-dir') args.externalDir = argv[++index];
    else if (arg === '--provider') args.provider = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proof = await runExternalWormSync(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS External WORM Sync Proof');
  console.log(`Status: ${proof.status}`);
  console.log(`Provider: ${proof.provider}`);
  console.log(`Bundle hash: ${proof.bundleHash ?? 'missing'}`);
  console.log('Reports: dist/worm-promotion/external-sync-proof.json, dist/worm-promotion/external-sync-proof.md');
  if (proof.status.startsWith('blocked')) process.exitCode = 1;
}
