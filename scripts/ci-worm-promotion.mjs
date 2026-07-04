import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultDistDir = 'dist';
const defaultOutputDir = 'dist/worm-promotion';
const workflowPath = '.github/workflows/product-evidence.yml';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function listFiles(root, { exclude = [] } = {}) {
  const output = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = normalizePath(relative(root, path));
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  }
  if (await exists(root)) await walk(root);
  return output.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function runCiWormPromotion({
  distDir = defaultDistDir,
  outputDir = defaultOutputDir,
  jsonPath = join(defaultOutputDir, 'manifest.json'),
  markdownPath = join(defaultOutputDir, 'manifest.md')
} = {}) {
  const gate = await readJson(join(distDir, 'ag-product-readiness-gate.json'));
  const handoff = await readJson(join(distDir, 'ag-operator-handoff.json'));
  const adminAttempts = await readJson(join(distDir, 'windows-admin-install-attempts.json'));
  const externalSyncProof = await readJson(join(outputDir, 'external-sync-proof.json'));
  const files = await listFiles(distDir, {
    exclude: [
      normalizePath(relative(distDir, outputDir)),
      'worm-target',
      'worm-target-report.json',
      'worm-target-report.md'
    ]
  });
  const artifactHashes = [];
  for (const file of files) {
    const statsPath = normalizePath(relative(process.cwd(), file));
    artifactHashes.push({
      path: statsPath,
      sha256: await sha256File(file)
    });
  }
  const workflowExists = await exists(workflowPath);
  const workflowHash = workflowExists ? await sha256File(workflowPath) : null;
  const payloadForHash = {
    manifestVersion: 'jarvis-ci-worm-promotion-v1',
    gateStatus: gate?.status ?? 'missing',
    handoffStatus: handoff?.status ?? 'missing',
    artifactHashes,
    workflowPath: workflowExists ? workflowPath : null,
    workflowHash
  };
  const bundleHash = sha256Json(payloadForHash);
  const bundleDir = join(outputDir, 'bundles', bundleHash);
  const manifest = {
    ...payloadForHash,
    generatedAt: new Date().toISOString(),
    status: gate?.status === 'passed'
      && handoff?.status === 'ready-for-field-validation'
      && artifactHashes.length > 0
      && workflowExists
      ? 'ready-for-external-worm-promotion'
      : 'blocked',
    bundleHash,
    artifactCount: artifactHashes.length,
    externalSync: {
      status: externalSyncProof?.status ?? 'proof-not-generated',
      proofPath: normalizePath(relative(process.cwd(), join(outputDir, 'external-sync-proof.json'))),
      configuredTargetEnv: ['JARVIS_WORM_SYNC_DIR', 'JARVIS_WORM_APPEND_ONLY_DIR'],
      deprecatedCommandEnv: 'JARVIS_WORM_SYNC_COMMAND',
      rawCommandStored: false
    },
    fieldValidation: {
      windowsAdminInstallAttemptStatus: adminAttempts?.status ?? 'missing',
      handoffExternalValidationPending: handoff?.summary?.externalValidationPending ?? null
    },
    localAppendOnlyStaging: {
      bundleDir: resolve(bundleDir),
      latestPointer: resolve(join(outputDir, 'latest.json')),
      immutableByConvention: true
    }
  };

  await mkdir(bundleDir, { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  const bundleManifestPath = join(bundleDir, 'manifest.json');
  const bundleHashPath = join(bundleDir, 'manifest.sha256');
  if (!(await exists(bundleManifestPath))) {
    await writeFile(bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(bundleHashPath, `${bundleHash}  manifest.json\n`, 'utf8');
  }
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(manifest), 'utf8');
  await writeFile(join(outputDir, 'latest.json'), `${JSON.stringify({
    bundleHash,
    manifestPath: normalizePath(relative(process.cwd(), bundleManifestPath)),
    generatedAt: manifest.generatedAt,
    status: manifest.status
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(outputDir, 'manifest.sha256'), `${bundleHash}  manifest.json\n`, 'utf8');
  return manifest;
}

function renderMarkdown(manifest) {
  return [
    '# JARVIS CI/WORM Promotion Manifest',
    '',
    `Status: **${manifest.status}**`,
    `Bundle hash: \`${manifest.bundleHash}\``,
    `Artifacts: ${manifest.artifactCount}`,
    `Workflow: ${manifest.workflowPath ?? 'missing'}`,
    `Workflow hash: ${manifest.workflowHash ?? 'missing'}`,
    `External sync: ${manifest.externalSync.status}`,
    '',
    '## Field Validation',
    '',
    `- Windows admin install attempt: ${manifest.fieldValidation.windowsAdminInstallAttemptStatus}`,
    `- Handoff external validation pending: ${manifest.fieldValidation.handoffExternalValidationPending}`,
    '',
    '## Local Append-Only Staging',
    '',
    `- Bundle dir: \`${manifest.localAppendOnlyStaging.bundleDir}\``,
    `- Latest pointer: \`${manifest.localAppendOnlyStaging.latestPointer}\``,
    '',
    '## Artifact Hashes',
    '',
    ...manifest.artifactHashes.map((item) => `- \`${item.sha256}\`  ${item.path}`),
    ''
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await runCiWormPromotion();
  console.log('# JARVIS CI/WORM Promotion Manifest');
  console.log(`Status: ${manifest.status}`);
  console.log(`Bundle hash: ${manifest.bundleHash}`);
  console.log(`Artifacts: ${manifest.artifactCount}`);
  console.log('Reports: dist/worm-promotion/manifest.json, dist/worm-promotion/manifest.md, dist/worm-promotion/manifest.sha256');
  if (manifest.status !== 'ready-for-external-worm-promotion') process.exitCode = 1;
}
