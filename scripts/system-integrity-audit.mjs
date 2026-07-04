import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/system-integrity-audit-report.json';
const defaultMarkdownPath = 'dist/system-integrity-audit-report.md';
const sourceRoots = ['apps', 'packages', 'scripts', 'src', 'tests'];
const sourceExtensions = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);
const htmlExtensions = new Set(['.html', '.css']);
const moduleExtensions = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json'];
const ignoredSegments = new Set([
  '.git',
  '.gradle',
  '.jarvis-gradle-includes',
  '.expo',
  'android',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'ios',
  'node_modules'
]);

export async function runSystemIntegrityAudit({
  workspaceRoot = process.cwd(),
  jsonPath = resolve(workspaceRoot, defaultJsonPath),
  markdownPath = resolve(workspaceRoot, defaultMarkdownPath)
} = {}) {
  const root = resolve(workspaceRoot);
  const files = await collectAuditFiles(root);
  const packageJsonPaths = await collectPackageJsonPaths(root);
  const checks = [];

  checks.push(await checkPackageJson(root));
  checks.push(await checkWorkspacePackages(root));
  checks.push(await checkPackageEntrypoints(root, packageJsonPaths));
  checks.push(await checkNpmScriptTargets(root, packageJsonPaths));
  checks.push(await checkRelativeModuleLinks(root, files.sourceFiles));
  checks.push(await checkHtmlAssetLinks(root, files.htmlFiles));
  checks.push(await checkProductEvidenceStrictness(root));

  const blocking = checks.filter((item) => item.status === 'failed' && item.severity === 'blocking');
  const warnings = checks.filter((item) => item.status === 'warning');
  const report = {
    reportVersion: 'jarvis-system-integrity-audit-v1',
    generatedAt: new Date().toISOString(),
    status: blocking.length === 0 ? 'passed' : 'blocked',
    summary: {
      checkedSourceFiles: files.sourceFiles.length,
      checkedHtmlAssetFiles: files.htmlFiles.length,
      checkedPackageJsonFiles: packageJsonPaths.length,
      checkCount: checks.length,
      blockingFailures: blocking.length,
      warnings: warnings.length
    },
    checks,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath)
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

async function checkPackageJson(root) {
  const packageJson = await readJson(join(root, 'package.json'));
  return makeCheck({
    checkId: 'root_package_json_valid',
    passed: Boolean(packageJson?.name && packageJson?.type === 'module' && packageJson?.scripts),
    detail: {
      name: packageJson?.name ?? null,
      type: packageJson?.type ?? null,
      scriptCount: Object.keys(packageJson?.scripts ?? {}).length
    }
  });
}

async function checkWorkspacePackages(root) {
  const packageJson = await readJson(join(root, 'package.json'));
  const workspaces = Array.isArray(packageJson?.workspaces) ? packageJson.workspaces : [];
  const results = [];
  for (const pattern of workspaces) {
    if (!pattern.endsWith('/*')) {
      results.push({ pattern, status: 'skipped-unsupported-pattern' });
      continue;
    }
    const baseDir = join(root, pattern.slice(0, -2));
    const children = await safeReaddir(baseDir);
    const packages = [];
    for (const child of children) {
      const fullPath = join(baseDir, child.name);
      if (!child.isDirectory() || shouldIgnorePath(root, fullPath)) continue;
      const packagePath = join(fullPath, 'package.json');
      packages.push({
        name: child.name,
        packageJson: relativePath(root, packagePath),
        exists: existsSync(packagePath)
      });
    }
    results.push({ pattern, packages });
  }
  const missing = results.flatMap((item) => (item.packages ?? []).filter((pkg) => !pkg.exists));
  return makeCheck({
    checkId: 'workspace_package_manifests_present',
    passed: missing.length === 0,
    detail: {
      workspaceCount: workspaces.length,
      missing
    }
  });
}

async function checkPackageEntrypoints(root, packageJsonPaths) {
  const failures = [];
  for (const packagePath of packageJsonPaths) {
    const packageJson = await readJson(packagePath);
    if (!packageJson) continue;
    for (const field of ['main', 'module', 'types']) {
      const value = packageJson[field];
      if (!value || typeof value !== 'string') continue;
      const target = join(dirname(packagePath), value);
      if (!existsSync(target)) {
        failures.push({
          packageJson: relativePath(root, packagePath),
          field,
          value
        });
      }
    }
  }
  return makeCheck({
    checkId: 'package_entrypoints_exist',
    passed: failures.length === 0,
    detail: { failures }
  });
}

async function checkNpmScriptTargets(root, packageJsonPaths) {
  const failures = [];
  const scriptCount = { total: 0, nodeTargets: 0 };
  for (const packagePath of packageJsonPaths) {
    const packageJson = await readJson(packagePath);
    const scripts = packageJson?.scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      scriptCount.total += 1;
      const target = extractNodeScriptTarget(command);
      if (!target) continue;
      scriptCount.nodeTargets += 1;
      const resolved = resolve(dirname(packagePath), target);
      if (!existsSync(resolved)) {
        failures.push({
          packageJson: relativePath(root, packagePath),
          script: name,
          target
        });
      }
    }
  }
  return makeCheck({
    checkId: 'npm_script_node_targets_exist',
    passed: failures.length === 0,
    detail: {
      scriptCount,
      failures
    }
  });
}

async function checkRelativeModuleLinks(root, sourceFiles) {
  const failures = [];
  let importCount = 0;
  for (const filePath of sourceFiles) {
    const text = await readText(filePath);
    for (const specifier of findModuleSpecifiers(text)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      importCount += 1;
      const cleanSpecifier = stripSpecifierSuffix(specifier);
      const resolved = specifier.startsWith('/')
        ? resolve(root, `.${cleanSpecifier}`)
        : resolve(dirname(filePath), cleanSpecifier);
      if (!moduleTargetExists(resolved)) {
        failures.push({
          file: relativePath(root, filePath),
          specifier
        });
      }
    }
  }
  return makeCheck({
    checkId: 'relative_module_links_resolve',
    passed: failures.length === 0,
    detail: {
      fileCount: sourceFiles.length,
      importCount,
      failures: failures.slice(0, 50),
      failureCount: failures.length
    }
  });
}

async function checkHtmlAssetLinks(root, htmlFiles) {
  const failures = [];
  let linkCount = 0;
  for (const filePath of htmlFiles) {
    const text = await readText(filePath);
    for (const link of findAssetLinks(text)) {
      if (!isLocalAssetLink(link)) continue;
      linkCount += 1;
      const clean = stripSpecifierSuffix(link);
      const target = resolve(dirname(filePath), clean);
      if (!existsSync(target)) {
        failures.push({
          file: relativePath(root, filePath),
          link
        });
      }
    }
  }
  return makeCheck({
    checkId: 'html_and_css_asset_links_resolve',
    passed: failures.length === 0,
    detail: {
      fileCount: htmlFiles.length,
      linkCount,
      failures: failures.slice(0, 50),
      failureCount: failures.length
    }
  });
}

async function checkProductEvidenceStrictness(root) {
  const filePath = join(root, 'scripts/product-evidence.mjs');
  const text = await readText(filePath);
  const nonZeroAllowances = [];
  const allowPattern = /\{\s*id:\s*['"]([^'"]+)['"][\s\S]*?allowExitCodes:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = allowPattern.exec(text))) {
    const values = match[2]
      .split(',')
      .map((item) => Number(item.trim().replaceAll('_', '')))
      .filter((item) => Number.isFinite(item));
    const nonZero = values.filter((item) => item !== 0);
    if (nonZero.length > 0) {
      nonZeroAllowances.push({ stepId: match[1], allowExitCodes: values });
    }
  }
  const requiredSteps = [
    'wearable-field-chaos',
    'system-integrity-audit',
    'mobile-live-bridge-e2e',
    'final-release-verification-bundle'
  ];
  const missingSteps = requiredSteps.filter((stepId) => !text.includes(`id: '${stepId}'`) && !text.includes(`id: "${stepId}"`));
  return makeCheck({
    checkId: 'product_evidence_is_strict_and_complete',
    passed: nonZeroAllowances.length === 0 && missingSteps.length === 0,
    detail: {
      nonZeroAllowances,
      missingSteps
    }
  });
}

async function collectAuditFiles(root) {
  const sourceFiles = [];
  const htmlFiles = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = join(root, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    await walkFiles(root, absoluteRoot, (filePath) => {
      const extension = extname(filePath);
      if (sourceExtensions.has(extension)) sourceFiles.push(filePath);
      if (htmlExtensions.has(extension)) htmlFiles.push(filePath);
    });
  }
  for (const rootFile of ['index.html', 'index.js']) {
    const filePath = join(root, rootFile);
    if (!existsSync(filePath)) continue;
    const extension = extname(filePath);
    if (sourceExtensions.has(extension)) sourceFiles.push(filePath);
    if (htmlExtensions.has(extension)) htmlFiles.push(filePath);
  }
  sourceFiles.sort();
  htmlFiles.sort();
  return { sourceFiles, htmlFiles };
}

async function collectPackageJsonPaths(root) {
  const paths = [join(root, 'package.json')];
  for (const sourceRoot of ['apps', 'packages']) {
    const absoluteRoot = join(root, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    await walkFiles(root, absoluteRoot, (filePath) => {
      if (filePath.endsWith(`${sep}package.json`)) paths.push(filePath);
    });
  }
  return [...new Set(paths)].sort();
}

async function walkFiles(root, dir, visit) {
  if (shouldIgnorePath(root, dir)) return;
  const entries = await safeReaddirWithTypes(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (shouldIgnorePath(root, fullPath)) continue;
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function shouldIgnorePath(root, filePath) {
  const rel = relativePath(root, filePath);
  return rel.split(/[\\/]+/).some((segment) => ignoredSegments.has(segment));
}

function findModuleSpecifiers(text) {
  const specifiers = [];
  const pattern = /\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

function findAssetLinks(text) {
  const links = [];
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;
  while ((match = attrPattern.exec(text))) links.push(match[1]);
  const cssPattern = /\burl\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  while ((match = cssPattern.exec(text))) links.push(match[1]);
  return links;
}

function isLocalAssetLink(link) {
  const value = String(link ?? '').trim();
  if (!value || value.startsWith('#')) return false;
  return !/^(?:https?:|mailto:|tel:|data:|javascript:|app:|file:)/i.test(value);
}

function stripSpecifierSuffix(specifier) {
  return String(specifier).split('#')[0].split('?')[0];
}

function moduleTargetExists(basePath) {
  for (const extension of moduleExtensions) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return true;
  }
  if (existsSync(basePath)) {
    try {
      const packageJson = join(basePath, 'package.json');
      if (existsSync(packageJson)) return true;
      return ['index.js', 'index.mjs', 'index.ts', 'index.tsx', 'index.json']
        .some((item) => existsSync(join(basePath, item)));
    } catch {
      return false;
    }
  }
  return false;
}

function extractNodeScriptTarget(command) {
  const tokens = shellTokens(command);
  if (tokens.length === 0) return null;
  const nodeIndex = tokens.findIndex((token) => /^(?:node|node\.exe)$/i.test(token) || /[\\/]node(?:\.exe)?$/i.test(token));
  if (nodeIndex < 0) return null;
  for (let index = nodeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === '--') continue;
    if (token.startsWith('-')) continue;
    if (/\.(?:js|mjs|cjs|ts|tsx)$/i.test(token)) return token;
    return null;
  }
  return null;
}

function shellTokens(command) {
  return String(command ?? '')
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
}

function makeCheck({ checkId, passed, detail = {}, severity = 'blocking' }) {
  return {
    checkId,
    status: passed ? 'passed' : 'failed',
    severity,
    detail
  };
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReaddirWithTypes(dir) {
  try {
    await stat(dir);
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function relativePath(root, filePath) {
  const relative = resolve(filePath).slice(resolve(root).length).replace(/^[/\\]/, '');
  return relative.split(sep).join('/');
}

function renderMarkdown(report) {
  return [
    '# JARVIS System Integrity Audit',
    '',
    `Status: **${report.status}**`,
    `Source files: ${report.summary.checkedSourceFiles}`,
    `HTML/CSS files: ${report.summary.checkedHtmlAssetFiles}`,
    `Package manifests: ${report.summary.checkedPackageJsonFiles}`,
    `Blocking failures: ${report.summary.blockingFailures}`,
    '',
    '## Checks',
    '',
    '| Check | Status | Severity |',
    '| --- | --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.status} | ${item.severity} |`),
    ''
  ].join('\n');
}

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runSystemIntegrityAudit({
    jsonPath: resolve(readFlag('--json', defaultJsonPath)),
    markdownPath: resolve(readFlag('--markdown', defaultMarkdownPath))
  });
  console.log('# JARVIS System Integrity Audit');
  console.log(`Status: ${report.status}`);
  console.log(`Checks: ${report.checks.filter((item) => item.status === 'passed').length}/${report.checks.length}`);
  console.log(`Blocking failures: ${report.summary.blockingFailures}`);
  console.log('Reports: dist/system-integrity-audit-report.json, dist/system-integrity-audit-report.md');
  if (report.status !== 'passed') process.exitCode = 1;
}
