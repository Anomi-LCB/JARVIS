import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY_POINTS = ['tests/outbound-node-supervisor.test.js', 'tests/outbound-command-dispatcher.test.js', 'tests/pc-outbound-command-https.test.js', 'tests/pc-outbound-command-mailbox.test.js', 'tests/remote-container-separation.test.js', 'tests/remote-artifact-consistency.test.js', 'tests/mission-criteria-evidence.test.js', 'tests/mission-execution-authority.test.js', 'tests/mission-effect-coordinator.test.js',
  'tests/worker-core-authority.test.js', 'tests/core-service-mission-authority.test.js',
  'tests/google-operation-broker.test.js', 'tests/google-vault-client.test.js', 'tests/google-broker-https.test.js',
  'tests/configured-google-broker.test.js', 'tests/google-read-delegation.test.js', 'tests/personal-google-evidence.test.js', 'tests/private-file.test.js', 'tests/pc-outbound-channel.test.js', 'tests/core-pc-outbound.test.js', 'tests/pc-execution-redirect.test.js', 'tests/pc-outbound-receipt-client.test.js', 'tests/mission-recovery-remote.test.js', 'tests/remote-mission-effect.test.js', 'tests/operation-artifact-reader.test.js', 'tests/outbound-operation-artifact.test.js', 'tests/remote-artifact-contract.test.js', 'tests/sqlite-mission-store.test.js', 'tests/sqlite-mission-adversarial.test.js'];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// This packages only the fixed authority/credential-operation tests and their literal JS imports.
// It is deliberately not a repository archive or a production deployment tool.
export function buildCloudValidationBundle({ root = ROOT, destination } = {}) {
  const sourceRoot = realpathSync(root);
  const output = resolve(destination ?? resolve(root, 'artifacts', `cloud-validation-${Date.now()}`));
  if (!output.startsWith(resolve(root, 'artifacts') + sep)) throw new Error('Bundle destination must be inside artifacts');
  const pending = [...ENTRY_POINTS], files = new Map(), externalModules = new Set();
  while (pending.length) {
    const name = pending.pop().replaceAll('\\', '/');
    if (files.has(name)) continue;
    if (!/^(tests|packages|apps)\/.+\.(js|mjs)$/.test(name) && !['scripts/core-service-runtime.mjs', 'scripts/personal-google-connect.mjs', 'scripts/google-credential-broker.mjs', 'scripts/pc-outbound-channel.mjs'].includes(name)
      && !/^skill-center\/registry\/(providers|catalog|fragments|recipes|profiles|compatibility)\.js$/.test(name)) throw new Error(`Disallowed bundle source: ${name}`);
    const path = resolve(sourceRoot, name);
    if (!path.startsWith(sourceRoot + sep) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('Source escaped the fixed code tree');
    const bytes = readFileSync(path), text = bytes.toString('utf8');
    files.set(name, bytes);
    const references = [
      ...text.matchAll(/\b(?:from|import)\s*['"]([A-Za-z0-9@._:/-]+)['"]/g),
      ...text.matchAll(/\bimport\s*\(\s*['"]([A-Za-z0-9@._:/-]+)['"]/g),
      ...text.matchAll(/\bnew URL\(\s*['"]([^'"]+\.(?:mjs|js))['"]\s*,\s*import\.meta\.url/g)
    ];
    for (const match of references) {
      const specifier = match[1];
      if (specifier.startsWith('.')) pending.push(relative(sourceRoot, resolve(dirname(path), specifier)));
      else if (!BUILTINS.has(specifier) && !specifier.startsWith('file:')) externalModules.add(specifier);
    }
  }
  // Runtime-loaded policy is not a JS import. Keep this required data allowlist explicit.
  for (const name of ['apps/pc-agent/install/daemon-config.json', 'apps/pc-agent/install/windows-service-manifest.json', 'apps/policy-security/policies/e/default-policy.json', 'apps/verification/fixtures/ag-simulation-expanded-scenarios.json']) {
    const path = resolve(sourceRoot, name);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('Policy source escaped the code tree');
    files.set(name, readFileSync(path));
  }
  // Synthetic TLS identities only; never copy production certificate/key directories.
  for (const leaf of ['ca', 'server', 'server-key', 'core', 'core-key', 'other', 'other-key']) {
    const name = `tests/fixtures/google-broker-tls/${leaf}.pem`, path = resolve(sourceRoot, name);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('TLS test fixture escaped the code tree');
    files.set(name, readFileSync(path));
  }
  // wx + nonrecursive mkdir refuses to replace any existing evidence bundle.
  mkdirSync(output);
  for (const [name, bytes] of files) {
    const target = resolve(output, name); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
  }
  writeFileSync(resolve(output, 'package.json'), '{"type":"module","private":true}\n', { flag: 'wx' });
  const manifest = {
    version: 'cloud-authority-validation-bundle-v1', createdAt: new Date().toISOString(),
    purpose: 'isolated-contract-validation-only', productionActivation: false,
    entryPoints: ENTRY_POINTS, testFileConcurrency: 1, externalModules: [...externalModules].sort(),
    files: [...files].sort(([a],[b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, sha256: digest(bytes), size: bytes.length })),
    excluded: ['personal data', 'credential vaults', 'runtime databases', 'logs', 'node_modules', 'repository history'],
    limitations: ['Literal import graph only; copied bundle must execute before use', 'No cloud account or resource provisioned', 'Linux container execution remains unverified until its test result is recorded']
  };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(resolve(output, 'Dockerfile'), `ARG NODE_IMAGE\nFROM \${NODE_IMAGE}\nWORKDIR /validation\nRUN groupadd -g 2000 jarvis-broker && useradd -u 2000 -g 2000 -M -d /nonexistent jarvis-broker && groupadd -g 2001 jarvis-core && useradd -u 2001 -g 2001 -M -d /nonexistent jarvis-core && groupadd -g 2002 jarvis-worker && useradd -u 2002 -g 2002 -M -d /nonexistent jarvis-worker\nCOPY --chown=node:node apps/ ./apps/\nCOPY --chown=node:node packages/ ./packages/\nCOPY --chown=node:node scripts/ ./scripts/\nCOPY --chown=node:node skill-center/ ./skill-center/\nCOPY --chown=node:node tests/ ./tests/\nCOPY --chown=node:node package.json ./package.json\nUSER node\nCMD ${JSON.stringify(['node', '--test', '--test-concurrency=1', ...ENTRY_POINTS])}\n`, { flag: 'wx' });
  return { destination: output, fileCount: files.size, externalModules: manifest.externalModules, productionActivation: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(buildCloudValidationBundle({ destination: process.argv[2] }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
