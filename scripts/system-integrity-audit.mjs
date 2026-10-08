import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/system-integrity-audit-report.json';
const defaultMarkdownPath = 'dist/system-integrity-audit-report.md';
const sourceRoots = ['apps', 'packages', 'scripts', 'src', 'tests'];
const sourceExtensions = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);
const htmlExtensions = new Set(['.html', '.css']);
const moduleExtensions = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json'];
const staticAssetRootNames = new Set(['public', 'static', 'www']);
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
  checks.push(await checkReleaseEvidenceConsistency(root));

  const blocking = checks.filter((item) => item.status === 'failed' && item.severity === 'blocking');
  const warnings = checks.filter((item) => item.status === 'warning');
  const report = {
    reportVersion: 'jarvis-system-integrity-audit-v1',
    generatedAt: new Date().toISOString(),
    status: blocking.length > 0 ? 'blocked' : warnings.length > 0 ? 'passed-with-warnings' : 'passed',
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
      if (!await npmScriptTargetExists(dirname(packagePath), target)) {
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
      if (!assetTargetExists(root, filePath, clean)) {
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
    'runtime-trust-audit',
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

function reportTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function evaluateReleaseEvidenceConsistency({
  finalGate = null,
  completionLedger = null,
  ciAnnotations = null,
  releaseAttestation = null,
  verificationBundle = null
} = {}) {
  if (!finalGate) {
    return {
      applicable: false,
      passed: true,
      gateStatus: 'missing',
      issueCount: 0,
      issues: [],
      reports: []
    };
  }

  const gateStatus = String(finalGate.status ?? 'unknown');
  const gateReady = ['passed', 'release-ready'].includes(gateStatus);
  const gateGeneratedAt = typeof finalGate.generatedAt === 'string' ? finalGate.generatedAt : null;
  const gateTimestamp = reportTimestamp(gateGeneratedAt);
  const expectedExternalPending = Number(finalGate.summary?.externalValidationPending);
  const issues = [];
  const reportSpecs = [
    {
      reportId: 'product-completion-ledger',
      report: completionLedger,
      gateStatus: completionLedger?.summary?.finalReleaseGateStatus,
      expectedStatuses: gateReady ? ['ready', 'ready-with-warnings'] : ['blocked'],
      externalPending: completionLedger?.summary?.externalValidationPending
    },
    {
      reportId: 'ci-verification-annotations',
      report: ciAnnotations,
      gateStatus: ciAnnotations?.summary?.finalReleaseGateStatus,
      expectedStatuses: gateReady ? ['passed', 'passed-with-warnings'] : ['blocked'],
      externalPending: ciAnnotations?.summary?.externalValidationPending
    },
    {
      reportId: 'final-release-attestation',
      report: releaseAttestation,
      gateStatus: releaseAttestation?.summary?.finalReleaseGateStatus,
      expectedStatuses: gateReady ? ['attested-local-field-release', 'attested'] : ['blocked'],
      externalPending: null
    },
    {
      reportId: 'final-release-verification-bundle',
      report: verificationBundle,
      gateStatus: null,
      expectedStatuses: gateReady ? ['passed', 'passed-with-operational-notes'] : ['blocked'],
      externalPending: null
    }
  ];

  if (gateTimestamp === null) {
    issues.push({ reportId: 'final-release-gate', issue: 'invalid-generated-at', actual: gateGeneratedAt });
  }

  const reports = reportSpecs.map((spec) => {
    const generatedAt = typeof spec.report?.generatedAt === 'string' ? spec.report.generatedAt : null;
    const timestamp = reportTimestamp(generatedAt);
    const status = typeof spec.report?.status === 'string' ? spec.report.status : null;
    const stale = gateTimestamp !== null && timestamp !== null && timestamp < gateTimestamp;

    if (!spec.report) {
      issues.push({ reportId: spec.reportId, issue: 'missing-report' });
    } else {
      if (timestamp === null) {
        issues.push({ reportId: spec.reportId, issue: 'invalid-generated-at', actual: generatedAt });
      } else if (stale) {
        issues.push({ reportId: spec.reportId, issue: 'older-than-final-gate', generatedAt, gateGeneratedAt });
      }
      if (!spec.expectedStatuses.includes(status)) {
        issues.push({
          reportId: spec.reportId,
          issue: 'release-state-contradiction',
          expected: spec.expectedStatuses,
          actual: status
        });
      }
      if (spec.gateStatus !== null && spec.gateStatus !== undefined && spec.gateStatus !== gateStatus) {
        issues.push({
          reportId: spec.reportId,
          issue: 'gate-status-mismatch',
          expected: gateStatus,
          actual: spec.gateStatus
        });
      }
      if (Number.isFinite(expectedExternalPending)
        && spec.externalPending !== null
        && spec.externalPending !== undefined
        && Number(spec.externalPending) !== expectedExternalPending) {
        issues.push({
          reportId: spec.reportId,
          issue: 'external-validation-count-mismatch',
          expected: expectedExternalPending,
          actual: Number(spec.externalPending)
        });
      }
    }

    return {
      reportId: spec.reportId,
      present: Boolean(spec.report),
      generatedAt,
      status,
      stale
    };
  });

  if (verificationBundle && completionLedger
    && verificationBundle.summary?.ledgerStatus !== completionLedger.status) {
    issues.push({
      reportId: 'final-release-verification-bundle',
      issue: 'ledger-status-mismatch',
      expected: completionLedger.status,
      actual: verificationBundle.summary?.ledgerStatus ?? null
    });
  }
  if (verificationBundle && ciAnnotations
    && verificationBundle.summary?.ciAnnotationStatus !== ciAnnotations.status) {
    issues.push({
      reportId: 'final-release-verification-bundle',
      issue: 'ci-status-mismatch',
      expected: ciAnnotations.status,
      actual: verificationBundle.summary?.ciAnnotationStatus ?? null
    });
  }
  if (verificationBundle && releaseAttestation
    && verificationBundle.summary?.attestationStatus !== releaseAttestation.status) {
    issues.push({
      reportId: 'final-release-verification-bundle',
      issue: 'attestation-status-mismatch',
      expected: releaseAttestation.status,
      actual: verificationBundle.summary?.attestationStatus ?? null
    });
  }

  return {
    applicable: true,
    passed: issues.length === 0,
    gateStatus,
    gateGeneratedAt,
    expectedExternalPending: Number.isFinite(expectedExternalPending) ? expectedExternalPending : null,
    issueCount: issues.length,
    issues,
    reports
  };
}

async function checkReleaseEvidenceConsistency(root) {
  const [finalGate, completionLedger, ciAnnotations, releaseAttestation, verificationBundle] = await Promise.all([
    readJsonOptional(join(root, 'dist/final-release-gate.json')),
    readJsonOptional(join(root, 'dist/product-completion-ledger.json')),
    readJsonOptional(join(root, 'dist/ci-verification-annotations.json')),
    readJsonOptional(join(root, 'dist/final-release-attestation.json')),
    readJsonOptional(join(root, 'dist/final-release-verification-bundle.json'))
  ]);
  const detail = evaluateReleaseEvidenceConsistency({
    finalGate,
    completionLedger,
    ciAnnotations,
    releaseAttestation,
    verificationBundle
  });
  return makeCheck({
    checkId: 'release_evidence_chain_consistent',
    passed: detail.passed,
    severity: 'warning',
    detail
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
  const { code, strings } = tokenizeJavaScriptStrings(text);
  const specifiers = [];
  const pattern = /\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(code))) {
    const token = match[1] ?? match[2] ?? match[3];
    const specifier = strings.get(token);
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function tokenizeJavaScriptStrings(text) {
  const source = String(text ?? '');
  const strings = new Map();
  let code = '';
  let index = 0;
  let stringIndex = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline < 0) break;
      code += '\n';
      index = newline + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const comment = source.slice(index, end < 0 ? source.length : end + 2);
      code += comment.replace(/[^\r\n]/g, ' ');
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && isRegexLiteralStart(code)) {
      index = scanRegexLiteral(source, index);
      code += 'null';
      continue;
    }
    if (character === '`') {
      const end = scanQuotedLiteral(source, index, '`');
      code += 'null';
      index = end;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = scanQuotedLiteral(source, index, character);
      const rawValue = source.slice(index + 1, Math.max(index + 1, end - 1));
      const token = `__JARVIS_STRING_${stringIndex++}__`;
      strings.set(token, decodeJavaScriptString(rawValue));
      code += `"${token}"`;
      index = end;
      continue;
    }
    code += character;
    index += 1;
  }
  return { code, strings };
}

function isRegexLiteralStart(code) {
  const trimmed = code.replace(/[\s\uFEFF]+$/u, '');
  if (!trimmed) return true;
  const previous = trimmed.at(-1);
  if ('([{=,:;!&|?+*%^~<>-'.includes(previous)) return true;
  return /(?:^|[^\p{L}\p{N}_$])(?:return|case|throw|else|do|typeof|instanceof|in|of|yield|await)$/u.test(trimmed);
}

function scanRegexLiteral(source, start) {
  let escaped = false;
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (character === '/' && !inCharacterClass) {
      let end = index + 1;
      while (/[a-z]/iu.test(source[end] ?? '')) end += 1;
      return end;
    }
    if (character === '\n' || character === '\r') return index;
  }
  return source.length;
}

function scanQuotedLiteral(source, start, quote) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  return source.length;
}

function decodeJavaScriptString(value) {
  return String(value)
    .replace(/\\([\\'"`])/g, '$1')
    .replace(/\\([?#])/g, '$1');
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

async function npmScriptTargetExists(packageRoot, target) {
  const normalizedTarget = String(target).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!/[?*[]/.test(normalizedTarget)) return existsSync(resolve(packageRoot, normalizedTarget));

  const segments = normalizedTarget.split('/');
  const firstPatternSegment = segments.findIndex((segment) => /[?*[]/.test(segment));
  const searchRoot = resolve(packageRoot, ...segments.slice(0, Math.max(0, firstPatternSegment)));
  if (!existsSync(searchRoot)) return false;

  const matcher = globToRegExp(normalizedTarget);
  return directoryContainsMatch(searchRoot, packageRoot, matcher);
}

async function directoryContainsMatch(dir, packageRoot, matcher) {
  const entries = await safeReaddirWithTypes(dir);
  for (const entry of entries) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContainsMatch(filePath, packageRoot, matcher)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const packageRelativePath = relative(packageRoot, filePath).split(sep).join('/');
    if (matcher.test(packageRelativePath)) return true;
  }
  return false;
}

function globToRegExp(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`);
}

function assetTargetExists(root, filePath, link) {
  if (!link.startsWith('/') && !link.startsWith('\\')) {
    return existsSync(resolve(dirname(filePath), link));
  }

  const relativeLink = `.${link.replaceAll('\\', '/')}`;
  const candidates = [
    resolve(root, relativeLink),
    resolve(dirname(filePath), relativeLink)
  ];
  const staticRoot = findNearestStaticAssetRoot(root, filePath);
  if (staticRoot) candidates.unshift(resolve(staticRoot, relativeLink));
  return [...new Set(candidates)].some((candidate) => existsSync(candidate));
}

function findNearestStaticAssetRoot(root, filePath) {
  const resolvedRoot = resolve(root);
  let cursor = dirname(resolve(filePath));
  while (cursor === resolvedRoot || cursor.startsWith(`${resolvedRoot}${sep}`)) {
    if (staticAssetRootNames.has(basename(cursor).toLowerCase())) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
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
    status: passed ? 'passed' : severity === 'warning' ? 'warning' : 'failed',
    severity,
    detail
  };
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

async function readJsonOptional(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
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
  if (report.status === 'blocked') process.exitCode = 1;
}
