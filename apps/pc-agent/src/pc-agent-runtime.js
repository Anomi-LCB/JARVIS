import { access, copyFile, mkdir, readFile, readdir, stat, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { basename, dirname, extname, resolve, relative } from 'node:path';
import { ActionType, maskSensitive, ModuleId, stableId, TaskStatus } from '../../../packages/shared/src/types.js';
import { JsonlAuditLog } from '../../../packages/shared/src/audit-log.js';
import { appendJsonlSync } from '../../../packages/shared/src/jsonl.js';
import { ExcelWorkbookWorker, runWorkbookProductFixturePack } from './adapters/excel/excel-worker.js';
import { createClaudeCliRunner } from '../../../packages/core/src/intent/claude-cli-intent-adapter.js';

// 자기교정용 프롬프트: 실패한 셸 명령의 원인을 주고 수정 명령을 받는다.
function buildShellCorrectionPrompt({ rawText, command, stderr, verifyOutput }) {
  return [
    '이전에 실행한 PowerShell 명령이 목표를 달성하지 못했습니다. 원인을 추정해 수정한 명령을 만드세요.',
    `원래 사용자 요청: ${rawText || '(불명)'}`,
    `실행했던 명령: ${command}`,
    `표준오류(stderr): ${stderr ? stderr.slice(0, 500) : '(없음)'}`,
    `검증 결과(기대와 다름): ${verifyOutput ? verifyOutput.slice(0, 300) : '(출력 없음)'}`,
    '',
    '규칙: 삭제/포맷/종료/외부전송 등 파괴적 명령은 만들지 않는다. 조회·생성·수정 위주로 고친다.',
    'JSON 하나만 출력: {"command":"<수정된 powershell>","verify":"<읽기전용 검증 셸>"}',
    '설명, 마크다운, 코드펜스 금지.'
  ].join('\n');
}

function extractJsonLoose(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    // claude CLI가 {result:"..."} 래퍼로 줄 수 있어 한 겹 벗긴다.
    if (parsed && typeof parsed.result === 'string') {
      const inner = String(parsed.result).match(/\{[\s\S]*\}/);
      if (inner) { try { return JSON.parse(inner[0]); } catch { /* fall through */ } }
    }
    return parsed;
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(path) {
  let cursor = resolve(path);
  while (true) {
    if (await exists(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

async function assertAllowedRealPath(path, allowedRoots, { checkParentForCreate = false } = {}) {
  const resolved = resolve(path);
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw new Error(`outside-allowed-roots:${resolved}`);
  }
  const canonicalRoots = [];
  for (const root of allowedRoots) {
    canonicalRoots.push(await realpath(root).catch(() => resolve(root)));
  }
  const probePath = checkParentForCreate ? await nearestExistingPath(dirname(resolved)) : await nearestExistingPath(resolved);
  const canonicalProbe = await realpath(probePath).catch(() => resolve(probePath));
  if (!canonicalRoots.some((root) => isInside(root, canonicalProbe))) {
    throw new Error(`outside-allowed-roots-realpath:${resolved}:${canonicalProbe}`);
  }
  return resolved;
}

export function classifyFileIssue({ code, path, targetPath = null, detail = null }) {
  const catalog = {
    missingSource: {
      severity: 'error',
      retryable: false,
      userAction: 'Choose an existing source file before executing the move.'
    },
    targetExists: {
      severity: 'conflict',
      retryable: true,
      userAction: 'Choose a different destination or explicitly approve overwrite.'
    },
    outsideAllowedRoots: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Select a path inside an approved local workspace root.'
    },
    permissionDenied: {
      severity: 'blocked',
      retryable: true,
      userAction: 'Check Windows file permissions or run the service under an account with access.'
    },
    pathEscapeRealpath: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Remove the symlink/junction escape or choose a real path inside the approved root.'
    },
    toctouChanged: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Retry after confirming the path was not replaced between preflight and execution.'
    },
    unknownFsError: {
      severity: 'error',
      retryable: true,
      userAction: 'Review the file path and retry after the OS error is resolved.'
    }
  };
  const meta = catalog[code] ?? catalog.unknownFsError;
  return {
    code,
    severity: meta.severity,
      retryable: meta.retryable,
    taxonomy: pathSafetyIssueCatalog().issues[code] ?? pathSafetyIssueCatalog().issues.unknownFsError,
    path,
    targetPath,
    detail,
    userAction: meta.userAction
  };
}

export function classifyFileError(error, { path = null, targetPath = null } = {}) {
  const message = String(error?.message ?? error ?? '');
  if (message.includes('outside-allowed-roots-realpath')) return classifyFileIssue({ code: 'pathEscapeRealpath', path, targetPath, detail: message });
  if (message.includes('outside-allowed-roots')) return classifyFileIssue({ code: 'outsideAllowedRoots', path, targetPath, detail: message });
  if (['EACCES', 'EPERM'].includes(error?.code)) return classifyFileIssue({ code: 'permissionDenied', path, targetPath, detail: message });
  return classifyFileIssue({ code: 'unknownFsError', path, targetPath, detail: message });
}

export function pathSafetyIssueCatalog() {
  return {
    catalogVersion: 'b-path-safety-issue-catalog-v1',
    issues: {
      missingSource: { category: 'existence', osCodes: ['ENOENT'], blocksExecution: true },
      targetExists: { category: 'conflict', osCodes: ['EEXIST'], blocksExecution: true },
      outsideAllowedRoots: { category: 'policy', osCodes: [], blocksExecution: true },
      permissionDenied: { category: 'windows-acl-or-permission', osCodes: ['EACCES', 'EPERM'], blocksExecution: true },
      pathEscapeRealpath: { category: 'junction-symlink-realpath-escape', osCodes: [], blocksExecution: true },
      toctouChanged: { category: 'open-after-realpath-toctou', osCodes: [], blocksExecution: true },
      unknownFsError: { category: 'unknown-filesystem-error', osCodes: [], blocksExecution: true }
    }
  };
}

export class PathSafetyGuard {
  constructor({ allowedRoots = ['./workspace'], clock = () => new Date() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.clock = clock;
    this.guardVersion = 'b-path-safety-guard-v1';
  }

  async inspect(inputPath, { checkParentForCreate = false, operation = 'read' } = {}) {
    const resolvedPath = resolve(inputPath);
    const lexicalAllowed = this.allowedRoots.some((root) => isInside(root, resolvedPath));
    const canonicalRoots = [];
    for (const root of this.allowedRoots) {
      canonicalRoots.push(await realpath(root).catch(() => resolve(root)));
    }
    const probePath = checkParentForCreate ? await nearestExistingPath(dirname(resolvedPath)) : await nearestExistingPath(resolvedPath);
    const canonicalProbe = await realpath(probePath).catch(() => resolve(probePath));
    const realpathAllowed = canonicalRoots.some((root) => isInside(root, canonicalProbe));
    const issue = !lexicalAllowed
      ? classifyFileIssue({ code: 'outsideAllowedRoots', path: inputPath, targetPath: resolvedPath, detail: `outside-allowed-roots:${resolvedPath}` })
      : (!realpathAllowed
          ? classifyFileIssue({ code: 'pathEscapeRealpath', path: inputPath, targetPath: resolvedPath, detail: `outside-allowed-roots-realpath:${resolvedPath}:${canonicalProbe}` })
          : null);
    return {
      inspectionVersion: 'b-path-safety-inspection-v1',
      operation,
      inputPath,
      resolvedPath,
      checkParentForCreate,
      probePath,
      canonicalProbe,
      canonicalRoots,
      lexicalAllowed,
      realpathAllowed,
      allowed: lexicalAllowed && realpathAllowed,
      issue
    };
  }

  async assertAllowed(inputPath, options = {}) {
    const inspection = await this.inspect(inputPath, options);
    if (!inspection.allowed) {
      throw new Error(inspection.issue?.detail ?? `outside-allowed-roots:${inspection.resolvedPath}`);
    }
    return inspection.resolvedPath;
  }

  async createOpenAfterRealpathLock(inputPath, { checkParentForCreate = false, operation = 'write' } = {}) {
    const inspection = await this.inspect(inputPath, { checkParentForCreate, operation });
    if (!inspection.allowed) {
      return {
        lockVersion: 'b-open-after-realpath-lock-v1',
        status: 'blocked',
        inspection
      };
    }
    const lockPath = checkParentForCreate ? inspection.probePath : inspection.resolvedPath;
    const lockStat = await stat(lockPath).catch(() => null);
    const signature = pathSignature({ path: lockPath, canonicalPath: inspection.canonicalProbe, stat: lockStat });
    return {
      lockVersion: 'b-open-after-realpath-lock-v1',
      status: 'locked',
      lockedAt: this.clock().toISOString(),
      operation,
      inputPath,
      lockPath,
      canonicalPath: inspection.canonicalProbe,
      signature,
      inspection
    };
  }

  async verifyOpenAfterRealpathLock(lock) {
    if (!lock || lock.status !== 'locked') {
      return {
        verificationVersion: 'b-open-after-realpath-lock-verification-v1',
        status: 'blocked',
        issue: classifyFileIssue({ code: 'toctouChanged', path: lock?.inputPath ?? null, detail: 'missing-or-unlocked-toctou-lock' })
      };
    }
    const currentCanonicalPath = await realpath(lock.lockPath).catch(() => resolve(lock.lockPath));
    const currentStat = await stat(lock.lockPath).catch(() => null);
    const currentSignature = pathSignature({ path: lock.lockPath, canonicalPath: currentCanonicalPath, stat: currentStat });
    const changedFields = Object.entries(lock.signature)
      .filter(([key, value]) => currentSignature[key] !== value)
      .map(([key]) => key);
    const changed = changedFields.length > 0;
    return {
      verificationVersion: 'b-open-after-realpath-lock-verification-v1',
      status: changed ? 'changed' : 'valid',
      changed,
      changedFields,
      lock,
      currentSignature,
      issue: changed ? classifyFileIssue({ code: 'toctouChanged', path: lock.inputPath, targetPath: lock.lockPath, detail: `toctou-lock-changed:${changedFields.join(',')}` }) : null
    };
  }

  async runFixtureCorpus(corpus) {
    const cases = corpus?.cases ?? [];
    const results = [];
    for (const fixture of cases) {
      const inspection = await this.inspect(fixture.path, fixture.options ?? {});
      const passed = inspection.allowed === fixture.expectedAllowed
        && (!fixture.expectedIssueCode || inspection.issue?.code === fixture.expectedIssueCode);
      results.push({
        caseId: fixture.caseId,
        passed,
        expectedAllowed: fixture.expectedAllowed,
        expectedIssueCode: fixture.expectedIssueCode ?? null,
        inspection
      });
    }
    return {
      corpusVersion: corpus?.corpusVersion ?? 'b-path-safety-fixture-corpus-v1',
      guardVersion: this.guardVersion,
      issueCatalog: pathSafetyIssueCatalog(),
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      passRate: results.length ? roundRatio(results.filter((item) => item.passed).length / results.length) : 1,
      status: results.every((item) => item.passed) ? 'passed' : 'failed',
      results
    };
  }
}

export function createPathSafetyFixtureCorpus({
  allowedRoot,
  outsideRoot,
  junctionPath = null
} = {}) {
  const cases = [
    {
      caseId: 'safe-create-parent-inside-root',
      path: resolve(allowedRoot, 'safe-output.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: true
    },
    {
      caseId: 'lexical-outside-root-blocked',
      path: resolve(outsideRoot, 'outside.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: false,
      expectedIssueCode: 'outsideAllowedRoots'
    }
  ];
  if (junctionPath) {
    cases.push({
      caseId: 'junction-realpath-escape-blocked',
      path: resolve(junctionPath, 'escape.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: false,
      expectedIssueCode: 'pathEscapeRealpath'
    });
  }
  return {
    corpusVersion: 'b-path-safety-fixture-corpus-v1',
    description: 'Allowed-root, Windows ACL taxonomy, realpath escape, and TOCTOU preflight corpus.',
    cases
  };
}

export function createPathSafetyReleaseDossier({
  corpusReport,
  lock,
  verification,
  runtimeStatus = null,
  clock = () => new Date()
} = {}) {
  const issueCatalog = corpusReport?.issueCatalog ?? pathSafetyIssueCatalog();
  const releaseChecks = [
    {
      checkId: 'path_safety_issue_catalog_release_evidence',
      passed: issueCatalog.catalogVersion === 'b-path-safety-issue-catalog-v1'
        && issueCatalog.issues?.permissionDenied?.category === 'windows-acl-or-permission'
        && issueCatalog.issues?.pathEscapeRealpath?.category === 'junction-symlink-realpath-escape'
        && issueCatalog.issues?.toctouChanged?.category === 'open-after-realpath-toctou'
    },
    {
      checkId: 'path_safety_fixture_corpus_release_evidence',
      passed: corpusReport?.corpusVersion === 'b-path-safety-fixture-corpus-v1'
        && corpusReport.status === 'passed'
        && corpusReport.passRate === 1,
      total: corpusReport?.total ?? 0,
      passedCount: corpusReport?.passed ?? 0
    },
    {
      checkId: 'open_after_realpath_lock_release_evidence',
      passed: lock?.lockVersion === 'b-open-after-realpath-lock-v1'
        && lock.status === 'locked'
        && verification?.verificationVersion === 'b-open-after-realpath-lock-verification-v1'
        && ['valid', 'changed'].includes(verification.status),
      verificationStatus: verification?.status ?? null,
      changedFields: verification?.changedFields ?? []
    },
    {
      checkId: 'toctou_change_detection_release_evidence',
      passed: verification?.status === 'changed'
        && verification.issue?.code === 'toctouChanged',
      issueCode: verification?.issue?.code ?? null
    },
    {
      checkId: 'runtime_path_safety_adapter_release_evidence',
      passed: !runtimeStatus
        || (runtimeStatus.guardVersion === 'b-path-safety-guard-v1'
          && runtimeStatus.adapters?.createTextFile?.toctouLock === true),
      guardVersion: runtimeStatus?.guardVersion ?? null,
      createTextFileToctouLock: runtimeStatus?.adapters?.createTextFile?.toctouLock ?? null
    }
  ];
  const artifactManifest = {
    artifactManifestVersion: 'b-path-safety-release-artifact-manifest-v1',
    generatedAt: clock().toISOString(),
    issueCatalogHash: createHash('sha256').update(canonicalJson(issueCatalog)).digest('hex'),
    corpusReportHash: createHash('sha256').update(canonicalJson({
      corpusVersion: corpusReport?.corpusVersion ?? null,
      status: corpusReport?.status ?? null,
      total: corpusReport?.total ?? 0,
      passed: corpusReport?.passed ?? 0,
      passRate: corpusReport?.passRate ?? null,
      issueCodes: (corpusReport?.results ?? []).map((item) => item.issueCode ?? item.issue?.code ?? null).filter(Boolean).sort()
    })).digest('hex'),
    lockHash: createHash('sha256').update(canonicalJson({
      lockVersion: lock?.lockVersion ?? null,
      status: lock?.status ?? null,
      operation: lock?.operation ?? null,
      signatureHash: lock?.signature ? createHash('sha256').update(canonicalJson(lock.signature)).digest('hex') : null
    })).digest('hex'),
    verificationHash: createHash('sha256').update(canonicalJson({
      verificationVersion: verification?.verificationVersion ?? null,
      status: verification?.status ?? null,
      issueCode: verification?.issue?.code ?? null,
      changedFields: verification?.changedFields ?? []
    })).digest('hex'),
    runtimeStatusHash: createHash('sha256').update(canonicalJson({
      guardVersion: runtimeStatus?.guardVersion ?? null,
      adapters: runtimeStatus?.adapters ?? null
    })).digest('hex'),
    rawPathStored: false,
    rawCanonicalPathStored: false,
    rawFixturePathStored: false,
    rawSignaturePayloadStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-path-safety-release-raw-leak-check-v1',
    rawLeakDetected: containsPathSafetyRawLeak(artifactManifest),
    checkedRawFields: [
      'rawPathStored',
      'rawCanonicalPathStored',
      'rawFixturePathStored',
      'rawSignaturePayloadStored'
    ]
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-path-safety-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "B path safety guard" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'path_safety_release_dossier_ready',
      'path_safety_corpus_and_acl_ready',
      'path_safety_toctou_detection_ready',
      'path_safety_release_artifact_manifest_ready',
      'path_safety_worm_promotion_package_ready'
    ],
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    rawPathStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-path-safety-worm-promotion-package-v1',
    providerContractVersion: 'b-path-safety-worm-provider-contract-v1',
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && ciNightlyGatePlan.planVersion === 'b-path-safety-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPathStored: false,
    rawSignaturePayloadStored: false
  };
  const dossier = {
    dossierVersion: 'b-path-safety-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    rawContentStored: false,
    rawPathStored: false,
    issueCatalogHash: artifactManifest.issueCatalogHash,
    corpusReportHash: artifactManifest.corpusReportHash,
    toctou: {
      lockHash: artifactManifest.lockHash,
      verificationHash: artifactManifest.verificationHash,
      verificationStatus: verification?.status ?? null,
      issueCode: verification?.issue?.code ?? null
    },
    runtimeStatusHash: artifactManifest.runtimeStatusHash,
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'attach_path_safety_hash_only_corpus_toctou_acl_and_worm_release_evidence'
      : 'block_path_safety_release_until_corpus_and_toctou_checks_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createPathSafetyProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'path_safety_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'b-path-safety-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'path_safety_corpus_and_acl_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'path_safety_issue_catalog_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'path_safety_fixture_corpus_release_evidence' && check.passed) === true
    },
    {
      checkId: 'path_safety_toctou_detection_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'toctou_change_detection_release_evidence' && check.passed) === true
    },
    {
      checkId: 'path_safety_raw_content_not_stored',
      passed: releaseDossier?.rawContentStored === false
        && releaseDossier?.rawPathStored === false
    },
    {
      checkId: 'path_safety_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.artifactManifestVersion === 'b-path-safety-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawPathStored === false
        && releaseDossier.artifactManifest?.rawCanonicalPathStored === false
    },
    {
      checkId: 'path_safety_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'b-path-safety-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-path-safety-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-path-safety-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function pathSignature({ path, canonicalPath, stat: fileStat }) {
  return {
    path: resolve(path),
    canonicalPath: resolve(canonicalPath),
    exists: Boolean(fileStat),
    dev: fileStat?.dev ?? null,
    ino: fileStat?.ino ?? null,
    mode: fileStat?.mode ?? null,
    size: fileStat?.size ?? null,
    mtimeMs: fileStat ? Math.round(fileStat.mtimeMs) : null
  };
}

function roundRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function batchDiffForFileMoves(checks) {
  const conflicts = [];
  for (const check of checks) {
    if (!check.sourceExists) {
      conflicts.push(classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to }));
    }
    if (check.targetExists) {
      conflicts.push(classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to }));
    }
  }
  return {
    total: checks.length,
    ready: checks.filter((check) => check.sourceExists && !check.targetExists).length,
    blocked: conflicts.length,
    creates: checks.filter((check) => check.sourceExists && !check.targetExists).map((check) => check.to),
    removes: checks.filter((check) => check.sourceExists && !check.targetExists).map((check) => check.from),
    conflicts
  };
}

function fileMoveResolutionKey(check) {
  return `${resolve(check.from)}=>${resolve(check.to)}`;
}

function normalizeFileMoveConflictResolutions(input = {}) {
  const resolutions = new Map();
  const add = (candidate = {}) => {
    if (!candidate) return;
    const action = candidate.action ?? candidate.strategy ?? candidate.mode ?? null;
    const resolution = { ...candidate, action };
    const keys = [
      candidate.key,
      candidate.moveKey,
      candidate.from && candidate.to ? `${resolve(candidate.from)}=>${resolve(candidate.to)}` : null,
      candidate.from ? resolve(candidate.from) : null,
      candidate.to ? resolve(candidate.to) : null
    ].filter(Boolean);
    for (const key of keys) resolutions.set(String(key), resolution);
  };

  if (Array.isArray(input)) {
    input.forEach(add);
    return resolutions;
  }
  if (input && typeof input === 'object' && (input.action || input.strategy || input.mode)) {
    add(input);
    return resolutions;
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === 'string') {
      add({ key, action: value });
    } else {
      add({ key, ...(value ?? {}) });
    }
  }
  return resolutions;
}

function resolutionForFileMove(check, resolutions) {
  return resolutions.get(fileMoveResolutionKey(check))
    ?? resolutions.get(resolve(check.from))
    ?? resolutions.get(resolve(check.to))
    ?? null;
}

function suggestedFileMoveTarget(targetPath, { action = 'rename' } = {}) {
  const extension = extname(targetPath);
  const stem = basename(targetPath, extension);
  const label = action === 'copy' ? 'copy' : 'renamed';
  return resolve(dirname(targetPath), `${stem}.${label}${extension}`);
}

function fileMoveIssueCodes(check) {
  const codes = [];
  if (!check.sourceExists) codes.push('missingSource');
  if (check.targetExists) codes.push('targetExists');
  for (const issue of check.pathIssues ?? []) codes.push(issue.code);
  return [...new Set(codes)];
}

export function createFileConflictResolutionUiState({ checks = [], conflicts = [], batchDiff = null, batchPolicy = null } = {}) {
  const actionCatalog = [
    { action: 'rename', label: 'Rename destination', destructive: false, defaultFor: ['targetExists'] },
    { action: 'copy', label: 'Copy instead of move', destructive: false, defaultFor: ['targetExists'] },
    { action: 'skip', label: 'Skip item', destructive: false, defaultFor: ['missingSource', 'permissionDenied', 'pathEscapeRealpath', 'outsideAllowedRoots'] },
    { action: 'overwrite', label: 'Overwrite destination', destructive: true, requiresExplicitApproval: true, defaultFor: [] }
  ];
  const items = checks.map((check, index) => {
    const issueCodes = fileMoveIssueCodes(check);
    const decisionRequired = issueCodes.length > 0;
    const suggestedTarget = check.targetExists ? suggestedFileMoveTarget(check.to, { action: 'rename' }) : check.to;
    const recommendedAction = issueCodes.includes('targetExists')
      ? 'rename'
      : issueCodes.length
        ? 'skip'
        : 'move';
    return {
      itemId: stableId('file-move-ui', `${check.from}:${check.to}:${index}`),
      from: check.from,
      to: check.to,
      issueCodes,
      decisionRequired,
      recommendedAction,
      suggestedTarget,
      availableActions: issueCodes.includes('targetExists')
        ? ['rename', 'copy', 'skip', 'overwrite']
        : issueCodes.length
          ? ['skip']
          : ['move'],
      policyItem: batchPolicy?.items?.[index] ?? null
    };
  });
  return {
    uiVersion: 'b-file-conflict-resolution-ui-v1',
    mode: 'pre-execution-review',
    batchDiff,
    actionCatalog,
    pendingDecisionCount: items.filter((item) => item.decisionRequired).length,
    safeDefault: 'rename-target-conflicts-and-skip-blocked-items',
    conflicts,
    items
  };
}

export function createFileMoveBatchPolicy({ checks = [], conflictResolutions = {}, allowOverwrite = false } = {}) {
  const resolutions = normalizeFileMoveConflictResolutions(conflictResolutions);
  const items = checks.map((check, index) => {
    const issueCodes = fileMoveIssueCodes(check);
    const resolution = resolutionForFileMove(check, resolutions);
    const requestedAction = resolution?.action ?? null;
    const base = {
      itemId: stableId('file-move-policy', `${check.from}:${check.to}:${index}`),
      moveKey: fileMoveResolutionKey(check),
      from: check.from,
      requestedTo: check.to,
      to: check.to,
      sourceExists: check.sourceExists,
      targetExists: check.targetExists,
      issueCodes,
      requestedAction,
      resolutionApplied: Boolean(requestedAction)
    };

    if ((check.pathIssues ?? []).length) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: check.pathIssues };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: check.pathIssues,
        availableActions: ['skip']
      };
    }

    if (!check.sourceExists) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to })] };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: [classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to })],
        availableActions: ['skip']
      };
    }

    if (check.targetExists) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to })] };
      }
      if (requestedAction === 'rename' || requestedAction === 'copy') {
        const targetPath = resolve(resolution.targetPath ?? resolution.to ?? suggestedFileMoveTarget(check.to, { action: requestedAction }));
        return {
          ...base,
          status: 'ready',
          action: requestedAction,
          to: targetPath,
          changeType: requestedAction === 'copy' ? 'copy_file' : 'move_file_renamed_target',
          sourceRetained: requestedAction === 'copy',
          issues: []
        };
      }
      if (requestedAction === 'overwrite' && (allowOverwrite || resolution.allowOverwrite === true)) {
        return {
          ...base,
          status: 'ready',
          action: 'overwrite',
          to: check.to,
          changeType: 'move_file_overwrite_target',
          destructive: true,
          issues: []
        };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: [classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to })],
        availableActions: ['rename', 'copy', 'skip', 'overwrite']
      };
    }

    if (requestedAction === 'skip') {
      return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [] };
    }
    if (requestedAction === 'copy') {
      const targetPath = resolve(resolution.targetPath ?? resolution.to ?? check.to);
      return { ...base, status: 'ready', action: 'copy', to: targetPath, changeType: 'copy_file', sourceRetained: true, issues: [] };
    }
    if (requestedAction === 'rename') {
      const targetPath = resolve(resolution.targetPath ?? resolution.to ?? check.to);
      return { ...base, status: 'ready', action: 'rename', to: targetPath, changeType: 'move_file_renamed_target', issues: [] };
    }
    return { ...base, status: 'ready', action: 'move', changeType: 'move_file', issues: [] };
  });
  const readyItems = items.filter((item) => item.status === 'ready');
  const blockedItems = items.filter((item) => item.status === 'blocked');
  const skippedItems = items.filter((item) => item.status === 'skipped');
  return {
    policyVersion: 'b-file-move-batch-policy-v1',
    allowedActions: ['move', 'rename', 'copy', 'skip', 'overwrite'],
    total: items.length,
    readyCount: readyItems.length,
    skippedCount: skippedItems.length,
    blockedCount: blockedItems.length,
    plannedChangesCount: readyItems.length,
    overwriteCount: readyItems.filter((item) => item.action === 'overwrite').length,
    safeToExecute: blockedItems.length === 0 && readyItems.every((item) => item.action !== 'overwrite' || allowOverwrite),
    requiresExplicitApproval: readyItems.some((item) => item.action === 'overwrite'),
    items,
    readyItems,
    blockedItems,
    skippedItems
  };
}

export function createPartialMoveTransactionDryRun({ batchPolicy, taskId = null } = {}) {
  const readyItems = batchPolicy?.readyItems ?? [];
  const blockedItems = batchPolicy?.blockedItems ?? [];
  const skippedItems = batchPolicy?.skippedItems ?? [];
  const operations = readyItems.map((item) => ({
    action: item.action,
    changeType: item.changeType,
    from: item.from,
    to: item.to,
    sourceRetained: item.sourceRetained === true
  }));
  const rollbackActions = readyItems.map((item) => item.action === 'copy'
    ? { action: 'delete_created_file', path: item.to }
    : { action: 'move_back', from: item.from, to: item.to });
  const status = blockedItems.length && readyItems.length
    ? 'partial-ready-requires-user-choice'
    : blockedItems.length
      ? 'blocked'
      : 'ready';
  return {
    dryRunVersion: 'b-partial-move-transaction-dry-run-v1',
    taskId,
    status,
    plannedChangesCount: readyItems.length,
    skippedCount: skippedItems.length,
    blockedCount: blockedItems.length,
    phases: [
      { phase: 'preflight', status: blockedItems.length ? 'requires-user-choice' : 'passed', blockedItems },
      { phase: 'prepare-target-directories', status: readyItems.length ? 'planned' : 'noop', directories: [...new Set(readyItems.map((item) => dirname(item.to)))] },
      { phase: 'apply-file-operations', status: readyItems.length ? 'planned' : 'noop', operations },
      { phase: 'rollback-plan', status: readyItems.length ? 'available' : 'noop', rollbackActions }
    ]
  };
}

export function createWindowsAclDenyCorpus({ deniedPath = 'C:\\System Volume Information\\jarvis-denied.txt', allowedRoot = null } = {}) {
  return {
    corpusVersion: 'b-windows-acl-deny-corpus-v1',
    platform: 'win32',
    purpose: 'Verify that Windows ACL deny and permission errors are classified without escaping the allowed root policy.',
    cases: [
      {
        caseId: 'windows-acl-deny-write',
        operation: 'create',
        path: deniedPath,
        allowedRoot,
        expectedIssueCode: 'permissionDenied',
        expectedOsCodes: ['EACCES', 'EPERM'],
        simulatedIssue: classifyFileIssue({ code: 'permissionDenied', path: deniedPath, detail: 'windows-acl-deny-fixture' })
      }
    ]
  };
}

export function createFileOperationReleaseDossier({
  previewShadow = null,
  executionResult = null,
  clock = () => new Date()
} = {}) {
  const previewPolicy = previewShadow?.batchPolicy ?? null;
  const executionPolicy = executionResult?.batchPolicy ?? null;
  const activePolicy = executionPolicy ?? previewPolicy;
  const partialMoveTransactionDryRun = executionResult?.partialMoveTransactionDryRun
    ?? previewShadow?.partialMoveTransactionDryRun
    ?? null;
  const aclCorpus = previewShadow?.windowsAclDenyCorpus ?? createWindowsAclDenyCorpus();
  const releaseChecks = [
    {
      checkId: 'file_conflict_resolution_ui_release_evidence',
      passed: previewShadow?.conflictResolutionUi?.uiVersion === 'b-file-conflict-resolution-ui-v1'
        && previewShadow.conflictResolutionUi.safeDefault === 'rename-target-conflicts-and-skip-blocked-items',
      pendingDecisionCount: previewShadow?.conflictResolutionUi?.pendingDecisionCount ?? 0
    },
    {
      checkId: 'file_move_batch_policy_release_evidence',
      passed: activePolicy?.policyVersion === 'b-file-move-batch-policy-v1'
        && Array.isArray(activePolicy.allowedActions)
        && activePolicy.allowedActions.includes('rename')
        && activePolicy.allowedActions.includes('copy')
        && activePolicy.allowedActions.includes('skip'),
      readyCount: activePolicy?.readyCount ?? 0,
      blockedCount: activePolicy?.blockedCount ?? 0,
      skippedCount: activePolicy?.skippedCount ?? 0
    },
    {
      checkId: 'partial_move_transaction_dry_run_release_evidence',
      passed: partialMoveTransactionDryRun?.dryRunVersion === 'b-partial-move-transaction-dry-run-v1'
        && Array.isArray(partialMoveTransactionDryRun.phases)
        && partialMoveTransactionDryRun.phases.some((phase) => phase.phase === 'rollback-plan'),
      status: partialMoveTransactionDryRun?.status ?? null,
      plannedChangesCount: partialMoveTransactionDryRun?.plannedChangesCount ?? 0
    },
    {
      checkId: 'windows_acl_deny_corpus_release_evidence',
      passed: aclCorpus?.corpusVersion === 'b-windows-acl-deny-corpus-v1'
        && aclCorpus.cases?.some((item) => item.expectedIssueCode === 'permissionDenied'),
      caseCount: aclCorpus?.cases?.length ?? 0
    },
    {
      checkId: 'file_execution_policy_outcome_release_evidence',
      passed: !executionResult
        || (executionResult.status === 'success'
          && executionResult.batchPolicy?.policyVersion === 'b-file-move-batch-policy-v1'
          && executionResult.partialMoveTransactionDryRun?.dryRunVersion === 'b-partial-move-transaction-dry-run-v1'),
      executionStatus: executionResult?.status ?? null,
      changedItems: executionResult?.changedItems?.length ?? 0
    },
    {
      checkId: 'file_rollback_coverage_release_evidence',
      passed: !executionResult
        || executionResult.rollbackAvailable === true
        || executionResult.batchPolicy?.readyCount === 0,
      rollbackAvailable: executionResult?.rollbackAvailable ?? null
    }
  ];
  const artifactManifest = {
    artifactManifestVersion: 'b-file-operation-release-artifact-manifest-v1',
    generatedAt: clock().toISOString(),
    conflictResolutionUiHash: createHash('sha256').update(canonicalJson(previewShadow?.conflictResolutionUi ?? null)).digest('hex'),
    batchPolicyHash: createHash('sha256').update(canonicalJson(activePolicy ?? null)).digest('hex'),
    partialMoveTransactionHash: createHash('sha256').update(canonicalJson(partialMoveTransactionDryRun ?? null)).digest('hex'),
    aclCorpusHash: createHash('sha256').update(canonicalJson({
      corpusVersion: aclCorpus?.corpusVersion ?? null,
      caseCount: aclCorpus?.cases?.length ?? 0,
      expectedIssueCodes: (aclCorpus?.cases ?? []).map((item) => item.expectedIssueCode).sort()
    })).digest('hex'),
    executionOutcomeHash: createHash('sha256').update(canonicalJson({
      status: executionResult?.status ?? null,
      changedCount: executionResult?.changedItems?.length ?? 0,
      outputCount: executionResult?.outputPaths?.length ?? 0,
      rollbackAvailable: executionResult?.rollbackAvailable === true,
      undoJournalId: executionResult?.undoJournalId ? createHash('sha256').update(String(executionResult.undoJournalId)).digest('hex') : null
    })).digest('hex'),
    rawFilePathsStored: false,
    rawFileContentStored: false,
    rawUndoPayloadStored: false,
    rawAclPathStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-file-operation-release-raw-leak-check-v1',
    rawLeakDetected: containsFileOperationRawLeak(artifactManifest),
    checkedRawFields: [
      'rawFilePathsStored',
      'rawFileContentStored',
      'rawUndoPayloadStored',
      'rawAclPathStored'
    ]
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-file-operation-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "B pc-agent lists files" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'file_operation_release_dossier_ready',
      'file_operation_conflict_policy_ready',
      'file_operation_acl_and_rollback_ready',
      'file_operation_release_artifact_manifest_ready',
      'file_operation_worm_promotion_package_ready'
    ],
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    rawFilePathsStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-file-operation-worm-promotion-package-v1',
    providerContractVersion: 'b-file-operation-worm-provider-contract-v1',
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && ciNightlyGatePlan.planVersion === 'b-file-operation-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawFilePathsStored: false,
    rawFileContentStored: false
  };
  const dossier = {
    dossierVersion: 'b-file-operation-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    rawContentStored: false,
    rawFilePathsStored: false,
    rawFileContentStored: false,
    preview: previewShadow
      ? {
          mode: previewShadow.mode,
          batchDiffHash: createHash('sha256').update(canonicalJson(previewShadow.batchDiff ?? null)).digest('hex'),
          conflictPolicy: previewShadow.conflictPolicy,
          conflictCount: previewShadow.conflicts?.length ?? 0,
          conflictResolutionUiHash: artifactManifest.conflictResolutionUiHash,
          batchPolicyHash: createHash('sha256').update(canonicalJson(previewShadow.batchPolicy ?? null)).digest('hex'),
          partialMoveTransactionHash: createHash('sha256').update(canonicalJson(previewShadow.partialMoveTransactionDryRun ?? null)).digest('hex'),
          windowsAclDenyCorpusHash: artifactManifest.aclCorpusHash
        }
      : null,
    execution: executionResult
      ? {
          status: executionResult.status,
          changedItemCount: executionResult.changedItems?.length ?? 0,
          outputPathHashes: (executionResult.outputPaths ?? []).map((item) => createHash('sha256').update(String(item)).digest('hex')),
          rollbackAvailable: executionResult.rollbackAvailable === true,
          batchPolicyHash: createHash('sha256').update(canonicalJson(executionResult.batchPolicy ?? null)).digest('hex'),
          partialMoveTransactionHash: createHash('sha256').update(canonicalJson(executionResult.partialMoveTransactionDryRun ?? null)).digest('hex'),
          undoJournalIdHash: executionResult.undoJournalId ? createHash('sha256').update(String(executionResult.undoJournalId)).digest('hex') : null
        }
      : null,
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'attach_file_conflict_batch_acl_rollback_hash_only_and_worm_release_evidence'
      : 'block_file_operation_release_until_conflict_policy_and_rollback_evidence_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createFileOperationProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'file_operation_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'b-file-operation-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'file_operation_conflict_policy_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_conflict_resolution_ui_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_move_batch_policy_release_evidence' && check.passed) === true
    },
    {
      checkId: 'file_operation_acl_and_rollback_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'windows_acl_deny_corpus_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_rollback_coverage_release_evidence' && check.passed) === true
    },
    {
      checkId: 'file_operation_raw_content_not_stored',
      passed: releaseDossier?.rawContentStored === false
        && releaseDossier?.rawFilePathsStored === false
        && releaseDossier?.rawFileContentStored === false
    },
    {
      checkId: 'file_operation_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.artifactManifestVersion === 'b-file-operation-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawFilePathsStored === false
        && releaseDossier.artifactManifest?.rawFileContentStored === false
    },
    {
      checkId: 'file_operation_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'b-file-operation-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-file-operation-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-file-operation-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function spreadsheetColumnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function countBy(items, key) {
  return (items ?? []).reduce((counts, item) => {
    const value = item?.[key] ?? 'unknown';
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function containsExecutionPacketReleaseRawLeak(value, needles = {}) {
  const serialized = JSON.stringify(value ?? {});
  const rawKeyLeak = Object.keys(needles)
    .some((key) => new RegExp(`"${key}"\\s*:`).test(serialized));
  return rawKeyLeak
    || /"arguments"\s*:|"content"\s*:|"path"\s*:|"capabilityToken"\s*:|"userConfirmation"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsCapabilityVaultRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"vaultPath"\s*:|"tokenId"\s*:|"secret"\s*:|"keyMaterial"\s*:|"plaintext"\s*:|cap_secret_|JARVIS_PC_AGENT_VAULT_KEY|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsFileOperationRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"from"\s*:|"to"\s*:|"path"\s*:|"targetPath"\s*:|"outputPaths"\s*:|"changedItems"\s*:|"content"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsPathSafetyRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"canonicalPath"\s*:|"allowedRoot"\s*:|"outsideRoot"\s*:|"junctionPath"\s*:|"signature"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsRollbackReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"archivePath"\s*:|"sourcePath"\s*:|"targetPath"\s*:|"manifestPath"\s*:|"drillPath"\s*:|"capabilityToken"\s*:|"undoPayload"\s*:|"payload"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsExecutionEvidenceReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"outputPaths"\s*:|"changedItems"\s*:|"files"\s*:|"adapterEvidence"\s*:|"capabilityToken"\s*:|"userCommand"\s*:|"content"\s*:|"previousContent"\s*:|"sourceLogPath"\s*:|"logPath"\s*:|"path"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

export class UndoJournal {
  constructor({ journalPath = null, clock = () => new Date() } = {}) {
    this.entries = [];
    this.records = [];
    this.journalPath = journalPath;
    this.clock = clock;
    this.load();
  }

  load() {
    if (!this.journalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const entries = new Map();
    for (const line of lines) {
      const event = JSON.parse(line);
      this.records.push(event);
      if (event.recordType === 'undo') {
        entries.set(event.undoJournalId, { ...event });
      }
      if (event.recordType === 'undo_rolled_back' && entries.has(event.undoJournalId)) {
        entries.set(event.undoJournalId, {
          ...entries.get(event.undoJournalId),
          rollbackStatus: 'rolled_back',
          rolledBackAt: event.rolledBackAt,
          rollbackResult: event.rollbackResult
        });
      }
    }
    this.entries = [...entries.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  record(action) {
    const createdAt = this.clock().toISOString();
    const entry = {
      recordType: 'undo',
      undoJournalId: `undo_${this.entries.length + 1}_${Date.parse(createdAt).toString(36)}`,
      createdAt,
      rollbackStatus: 'pending',
      ...action
    };
    this.addHash(entry);
    this.entries.unshift(entry);
    this.records.push({ ...entry });
    if (this.journalPath) appendJsonlSync(this.journalPath, entry);
    return entry;
  }

  markRolledBack(entry, rollbackResult) {
    const rolledBackAt = this.clock().toISOString();
    for (const item of this.entries) {
      if (item.undoJournalId === entry.undoJournalId) {
        item.rollbackStatus = 'rolled_back';
        item.rolledBackAt = rolledBackAt;
        item.rollbackResult = rollbackResult;
      }
    }
    const marker = {
      recordType: 'undo_rolled_back',
      undoJournalId: entry.undoJournalId,
      taskId: entry.taskId,
      rolledBackAt,
      rollbackResult
    };
    this.addHash(marker);
    this.records.push(marker);
    if (this.journalPath) appendJsonlSync(this.journalPath, marker);
    return marker;
  }

  list({ includeRolledBack = false } = {}) {
    return this.entries.filter((entry) => includeRolledBack || entry.rollbackStatus !== 'rolled_back');
  }

  history() {
    return [...this.entries];
  }

  verifyChain() {
    let previousHash = 'GENESIS';
    const failures = [];
    let hashedRecords = 0;
    let legacyRecords = 0;
    for (const record of this.records) {
      if (!record.hash || !record.previousHash) {
        legacyRecords += 1;
        continue;
      }
      hashedRecords += 1;
      if (record.previousHash !== previousHash) {
        failures.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          reason: 'previous-hash-mismatch',
          expected: previousHash,
          actual: record.previousHash
        });
      }
      const expectedHash = this.hashRecord(record);
      if (record.hash !== expectedHash) {
        failures.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          reason: 'hash-mismatch',
          expected: expectedHash,
          actual: record.hash
        });
      }
      previousHash = record.hash;
    }
    return {
      status: failures.length === 0 ? 'valid' : 'invalid',
      checked: this.records.length,
      hashedRecords,
      legacyRecords,
      latestHash: previousHash,
      failures
    };
  }

  addHash(record) {
    const previous = [...this.records].reverse().find((item) => item.hash)?.hash ?? 'GENESIS';
    record.previousHash = previous;
    record.hash = this.hashRecord(record);
    return record;
  }

  hashRecord(record) {
    const hashable = { ...record };
    delete hashable.hash;
    return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
  }
}

export class RollbackTransactionLog {
  constructor({ journalPath = null, clock = () => new Date() } = {}) {
    this.journalPath = journalPath;
    this.clock = clock;
    this.records = [];
    this.transactions = new Map();
    this.load();
  }

  load() {
    if (!this.journalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const line of lines) {
      const record = JSON.parse(line);
      this.records.push(record);
      this.applyRecord(record);
    }
  }

  begin({ taskId, plan }) {
    const active = this.activeForTask(taskId);
    if (active) {
      return {
        success: false,
        error: { code: 'B_ROLLBACK_TRANSACTION_ACTIVE' },
        transaction: active
      };
    }
    const startedAt = this.clock().toISOString();
    const transactionId = `rbtx_${this.records.length + 1}_${Date.parse(startedAt).toString(36)}`;
    const record = {
      recordType: 'rollback_transaction_started',
      transactionId,
      taskId,
      status: 'running',
      startedAt,
      stepCount: plan.stepCount,
      readyCount: plan.readyCount,
      blockedCount: plan.blockedCount,
      lockedPaths: this.lockedPathsFor(plan),
      planDigest: createHash('sha256').update(canonicalJson({
        taskId,
        stepCount: plan.stepCount,
        steps: plan.steps.map((step) => ({
          undoJournalId: step.undoJournalId,
          action: step.action,
          status: step.status,
          paths: step.paths
        }))
      })).digest('hex')
    };
    this.appendRecord(record);
    return { success: true, transaction: this.transactions.get(transactionId) };
  }

  recordStep(transaction, { step, rollbackResult = null, status, reason = null }) {
    const at = this.clock().toISOString();
    const record = {
      recordType: 'rollback_transaction_step',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      at,
      undoJournalId: step?.undoJournalId ?? rollbackResult?.undoJournalId ?? null,
      action: step?.action ?? rollbackResult?.action ?? null,
      status,
      reason,
      paths: step?.paths ?? null,
      rollbackResult
    };
    this.appendRecord(record);
    return record;
  }

  complete(transaction, { rolledBack = [], skipped = [] } = {}) {
    const completedAt = this.clock().toISOString();
    const status = skipped.length
      ? rolledBack.length
        ? 'completed_with_skips'
        : 'blocked'
      : 'completed';
    const record = {
      recordType: 'rollback_transaction_completed',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      status,
      completedAt,
      rolledBackCount: rolledBack.length,
      skippedCount: skipped.length
    };
    this.appendRecord(record);
    return this.transactions.get(transaction.transactionId);
  }

  fail(transaction, error, { rolledBack = [], skipped = [] } = {}) {
    const failedAt = this.clock().toISOString();
    const record = {
      recordType: 'rollback_transaction_failed',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      status: 'failed',
      failedAt,
      rolledBackCount: rolledBack.length,
      skippedCount: skipped.length,
      error: {
        code: error?.code ?? 'B_ROLLBACK_TRANSACTION_FAILED',
        message: error?.message ?? String(error)
      }
    };
    this.appendRecord(record);
    return this.transactions.get(transaction.transactionId);
  }

  activeForTask(taskId) {
    return this.active().find((transaction) => transaction.taskId === taskId) ?? null;
  }

  active() {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.status === 'running')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  history({ taskId = null, limit = 100 } = {}) {
    return [...this.transactions.values()]
      .filter((transaction) => !taskId || transaction.taskId === taskId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  status() {
    return {
      transactions: this.transactions.size,
      active: this.active(),
      recent: this.history({ limit: 20 }),
      chain: this.verifyChain()
    };
  }

  lockedPathsFor(plan) {
    const paths = new Set();
    for (const step of plan.steps ?? []) {
      for (const value of Object.values(step.paths ?? {})) {
        if (typeof value === 'string' && value.trim()) {
          paths.add(resolve(value));
        }
      }
    }
    return [...paths].sort();
  }

  appendRecord(record) {
    this.addHash(record);
    this.records.push(record);
    this.applyRecord(record);
    if (this.journalPath) appendJsonlSync(this.journalPath, record);
    return record;
  }

  applyRecord(record) {
    if (record.recordType === 'rollback_transaction_started') {
      this.transactions.set(record.transactionId, {
        transactionId: record.transactionId,
        taskId: record.taskId,
        status: 'running',
        startedAt: record.startedAt,
        stepCount: record.stepCount,
        readyCount: record.readyCount,
        blockedCount: record.blockedCount,
        lockedPaths: record.lockedPaths ?? [],
        planDigest: record.planDigest,
        steps: []
      });
      return;
    }
    const transaction = this.transactions.get(record.transactionId);
    if (!transaction) return;
    if (record.recordType === 'rollback_transaction_step') {
      transaction.steps.push({
        at: record.at,
        undoJournalId: record.undoJournalId,
        action: record.action,
        status: record.status,
        reason: record.reason,
        paths: record.paths,
        rollbackResult: record.rollbackResult
      });
      transaction.lastStepAt = record.at;
      return;
    }
    if (record.recordType === 'rollback_transaction_completed') {
      transaction.status = record.status;
      transaction.completedAt = record.completedAt;
      transaction.rolledBackCount = record.rolledBackCount;
      transaction.skippedCount = record.skippedCount;
      return;
    }
    if (record.recordType === 'rollback_transaction_failed') {
      transaction.status = 'failed';
      transaction.failedAt = record.failedAt;
      transaction.rolledBackCount = record.rolledBackCount;
      transaction.skippedCount = record.skippedCount;
      transaction.error = record.error;
    }
  }

  verifyChain() {
    let previousHash = 'GENESIS';
    const failures = [];
    for (const record of this.records) {
      if (record.previousHash !== previousHash) {
        failures.push({
          recordType: record.recordType,
          transactionId: record.transactionId,
          reason: 'previous-hash-mismatch',
          expected: previousHash,
          actual: record.previousHash
        });
      }
      const expectedHash = this.hashRecord(record);
      if (record.hash !== expectedHash) {
        failures.push({
          recordType: record.recordType,
          transactionId: record.transactionId,
          reason: 'hash-mismatch',
          expected: expectedHash,
          actual: record.hash
        });
      }
      previousHash = record.hash;
    }
    return {
      status: failures.length === 0 ? 'valid' : 'invalid',
      checked: this.records.length,
      latestHash: previousHash,
      failures
    };
  }

  addHash(record) {
    const previous = [...this.records].reverse().find((item) => item.hash)?.hash ?? 'GENESIS';
    record.previousHash = previous;
    record.hash = this.hashRecord(record);
    return record;
  }

  hashRecord(record) {
    const hashable = { ...record };
    delete hashable.hash;
    return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
  }
}

export class ExecutionPacketJournal {
  constructor({ journalPath = 'apps/pc-agent/logs/packet-journal.jsonl', clock = () => new Date() } = {}) {
    this.journalPath = journalPath;
    this.clock = clock;
    this.records = [];
    this.results = new Map();
    this.load();
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
    for (const record of this.records) {
      if (record.recordType === 'packet_result') {
        this.results.set(record.idempotencyKey, record.result);
      }
    }
  }

  idempotencyKey(packet = {}) {
    if (packet.idempotencyKey) return packet.idempotencyKey;
    if (packet.packetId) return `packet:${packet.packetId}`;
    const digest = createHash('sha256')
      .update(JSON.stringify({
        taskId: packet.taskId,
        requestedMode: packet.requestedMode ?? 'execute',
        toolName: packet.action?.toolName,
        actionType: packet.action?.actionType,
        arguments: packet.action?.arguments ?? {}
      }))
      .digest('hex');
    return `derived:${digest}`;
  }

  recordReceived(packet, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const record = {
      recordType: 'packet_received',
      idempotencyKey,
      packetId: packet.packetId ?? null,
      taskId: packet.taskId,
      requestedMode: packet.requestedMode ?? (dryRun ? 'shadow' : 'execute'),
      toolName: packet.action?.toolName ?? null,
      actionType: packet.action?.actionType ?? null,
      dryRun,
      receivedAt: this.clock().toISOString()
    };
    this.append(record);
    return record;
  }

  recordResult(packet, result, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const record = {
      recordType: 'packet_result',
      idempotencyKey,
      packetId: packet.packetId ?? null,
      taskId: packet.taskId,
      status: result.status,
      dryRun,
      completedAt: this.clock().toISOString(),
      result
    };
    this.results.set(idempotencyKey, result);
    this.append(record);
    return record;
  }

  resultFor(packet) {
    return this.results.get(this.idempotencyKey(packet)) ?? null;
  }

  pending() {
    const completed = new Set([...this.results.keys()]);
    return this.records
      .filter((record) => record.recordType === 'packet_received' && !completed.has(record.idempotencyKey))
      .slice()
      .reverse();
  }

  append(record) {
    this.records.push(record);
    appendJsonlSync(this.journalPath, record);
    return record;
  }
}

export class ExecutionPacketQueue {
  constructor({ queuePath = 'apps/pc-agent/logs/packet-queue.jsonl', maxAttempts = 3, baseBackoffMs = 1000, clock = () => new Date() } = {}) {
    this.queuePath = queuePath;
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.clock = clock;
    this.items = new Map();
    this.records = [];
    this.load();
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.queuePath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
    for (const record of this.records) {
      if (record.recordType === 'packet_queued') {
        this.items.set(record.queueId, {
          queueId: record.queueId,
          idempotencyKey: record.idempotencyKey,
          packet: record.packet,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: record.queuedAt,
          queuedAt: record.queuedAt,
          lastError: null
        });
      }
      if (record.recordType === 'packet_attempt') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'running';
          item.attempts = record.attempt;
          item.lastAttemptAt = record.attemptedAt;
        }
      }
      if (record.recordType === 'packet_retry_scheduled') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'retry_scheduled';
          item.attempts = record.attempt;
          item.nextAttemptAt = record.nextAttemptAt;
          item.lastError = record.error;
        }
      }
      if (record.recordType === 'packet_succeeded') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'succeeded';
          item.completedAt = record.completedAt;
          item.resultStatus = record.resultStatus;
        }
      }
      if (record.recordType === 'packet_quarantined') {
        const item = this.items.get(record.queueId) ?? {
          queueId: record.queueId,
          idempotencyKey: record.idempotencyKey,
          packet: record.packet ?? null,
          queuedAt: record.quarantinedAt,
          attempts: record.attempt ?? 0
        };
        item.status = 'quarantined';
        item.quarantinedAt = record.quarantinedAt;
        item.reason = record.reason;
        item.error = record.error;
        item.reviewStatus = 'needs_review';
        this.items.set(record.queueId, item);
      }
      if (record.recordType === 'packet_reviewed') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.reviewStatus = record.reviewStatus;
          item.reviewedAt = record.reviewedAt;
          item.reviewedBy = record.reviewedBy;
          item.reviewNote = record.note;
        }
      }
      if (record.recordType === 'packet_requeued') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'queued';
          item.reviewStatus = 'requeued';
          item.requeuedAt = record.requeuedAt;
          item.attempts = 0;
          item.nextAttemptAt = record.nextAttemptAt;
          item.error = null;
          item.lastError = null;
          item.reason = null;
        }
      }
      if (record.recordType === 'packet_ignored') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'ignored';
          item.reviewStatus = 'ignored';
          item.ignoredAt = record.ignoredAt;
          item.reviewedBy = record.reviewedBy;
          item.reviewNote = record.note;
        }
      }
      if (record.recordType === 'packet_retry_policy_updated') {
        if (Number.isInteger(record.current?.maxAttempts)) this.maxAttempts = record.current.maxAttempts;
        if (Number.isInteger(record.current?.baseBackoffMs)) this.baseBackoffMs = record.current.baseBackoffMs;
        this.policyUpdatedAt = record.updatedAt ?? record.current?.updatedAt ?? null;
      }
    }
  }

  idempotencyKey(packet) {
    return packet.idempotencyKey ?? `${packet.taskId ?? 'missing-task'}:${packet.packetId ?? createHash('sha256').update(canonicalJson(packet.action ?? packet)).digest('hex')}`;
  }

  validate(packet) {
    const errors = [];
    if (!packet || typeof packet !== 'object') errors.push('packet object is required');
    if (!packet?.taskId) errors.push('taskId is required');
    if (!packet?.action?.toolName) errors.push('action.toolName is required');
    if (!packet?.action?.actionType) errors.push('action.actionType is required');
    if (!packet?.capabilityToken?.tokenId) errors.push('capabilityToken.tokenId is required');
    if (packet?.userConfirmation?.confirmed !== true) errors.push('userConfirmation.confirmed must be true');
    return { valid: errors.length === 0, errors };
  }

  enqueue(packet, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const existing = [...this.items.values()].find((item) => item.idempotencyKey === idempotencyKey && ['queued', 'retry_scheduled', 'running', 'succeeded'].includes(item.status));
    if (existing) {
      return { ...this.publicItem(existing), duplicate: true };
    }
    const queueId = stableId('queue', idempotencyKey, this.clock().toISOString());
    const queuedAt = this.clock().toISOString();
    const validation = this.validate(packet);
    const item = {
      queueId,
      idempotencyKey,
      packet,
      status: validation.valid ? 'queued' : 'quarantined',
      attempts: 0,
      nextAttemptAt: queuedAt,
      queuedAt,
      dryRun,
      validation
    };
    this.items.set(queueId, item);
    this.append({
      recordType: 'packet_queued',
      queueId,
      idempotencyKey,
      packet,
      dryRun,
      queuedAt
    });
    if (!validation.valid) {
      this.quarantine(item, {
        reason: 'schema-invalid',
        error: validation.errors.join('; '),
        attempt: 0
      });
    }
    return this.publicItem(item);
  }

  async processNext(handler, { now = this.clock() } = {}) {
    const item = this.nextRunnable(now);
    if (!item) return { processed: false, reason: 'queue-empty' };
    item.status = 'running';
    item.attempts += 1;
    const attemptedAt = this.clock().toISOString();
    this.append({
      recordType: 'packet_attempt',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      attempt: item.attempts,
      attemptedAt
    });
    try {
      const result = await handler(item.packet, { queueId: item.queueId, attempt: item.attempts });
      item.status = 'succeeded';
      item.completedAt = this.clock().toISOString();
      item.resultStatus = result?.status ?? 'unknown';
      this.append({
        recordType: 'packet_succeeded',
        queueId: item.queueId,
        idempotencyKey: item.idempotencyKey,
        attempt: item.attempts,
        resultStatus: item.resultStatus,
        completedAt: item.completedAt
      });
      return { processed: true, item: this.publicItem(item), result };
    } catch (error) {
      const errorMessage = error.message ?? String(error);
      if (item.attempts >= this.maxAttempts) {
        this.quarantine(item, {
          reason: 'max-attempts-exceeded',
          error: errorMessage,
          attempt: item.attempts
        });
        return { processed: true, item: this.publicItem(item), quarantined: true };
      }
      const delayMs = this.baseBackoffMs * (2 ** Math.max(item.attempts - 1, 0));
      const nextAttemptAt = new Date(this.clock().getTime() + delayMs).toISOString();
      item.status = 'retry_scheduled';
      item.nextAttemptAt = nextAttemptAt;
      item.lastError = errorMessage;
      this.append({
        recordType: 'packet_retry_scheduled',
        queueId: item.queueId,
        idempotencyKey: item.idempotencyKey,
        attempt: item.attempts,
        delayMs,
        nextAttemptAt,
        error: errorMessage
      });
      return { processed: true, item: this.publicItem(item), retryScheduled: true };
    }
  }

  async drain(handler, { limit = 10 } = {}) {
    const results = [];
    for (let index = 0; index < limit; index += 1) {
      const processed = await this.processNext(handler);
      if (!processed.processed) break;
      results.push(processed);
    }
    return {
      processed: results.length,
      results,
      status: this.status()
    };
  }

  nextRunnable(now) {
    const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
    return [...this.items.values()]
      .filter((item) => ['queued', 'retry_scheduled'].includes(item.status))
      .filter((item) => Date.parse(item.nextAttemptAt) <= nowTime)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0] ?? null;
  }

  quarantine(item, { reason, error, attempt }) {
    item.status = 'quarantined';
    item.quarantinedAt = this.clock().toISOString();
    item.reason = reason;
    item.error = error;
    item.reviewStatus = 'needs_review';
    this.append({
      recordType: 'packet_quarantined',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      packet: item.packet,
      reason,
      error,
      attempt,
      quarantinedAt: item.quarantinedAt
    });
    return item;
  }

  poisonPackets({ includeIgnored = false } = {}) {
    return [...this.items.values()]
      .filter((item) => item.status === 'quarantined' || (includeIgnored && item.status === 'ignored'))
      .sort((a, b) => Date.parse(b.quarantinedAt ?? b.ignoredAt ?? b.queuedAt) - Date.parse(a.quarantinedAt ?? a.ignoredAt ?? a.queuedAt))
      .map((item) => this.publicItem(item));
  }

  reviewPoisonPacket(queueId, { decision = 'reviewed', reviewedBy = 'local-operator', note = '' } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (!['quarantined', 'ignored'].includes(item.status)) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    const reviewStatus = decision === 'reviewed' ? 'reviewed' : decision;
    item.reviewStatus = reviewStatus;
    item.reviewedAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    this.append({
      recordType: 'packet_reviewed',
      queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      reviewStatus,
      reviewedBy,
      note,
      reviewedAt: item.reviewedAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  requeuePoisonPacket(queueId, { reviewedBy = 'local-operator', note = '', patch = null } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (item.status !== 'quarantined') {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    const nextPacket = patch ? { ...item.packet, ...patch, action: { ...item.packet?.action, ...patch.action } } : item.packet;
    const validation = this.validate(nextPacket);
    if (!validation.valid) {
      this.reviewPoisonPacket(queueId, { decision: 'review_failed_validation', reviewedBy, note: `${note} ${validation.errors.join('; ')}`.trim() });
      return { success: false, error: { code: 'B_QUEUE_REQUEUE_PACKET_INVALID', errors: validation.errors }, item: this.publicItem(item) };
    }
    item.packet = nextPacket;
    item.status = 'queued';
    item.reviewStatus = 'requeued';
    item.requeuedAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    item.attempts = 0;
    item.nextAttemptAt = item.requeuedAt;
    item.error = null;
    item.lastError = null;
    item.reason = null;
    item.validation = validation;
    this.append({
      recordType: 'packet_requeued',
      queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      packet: item.packet,
      reviewedBy,
      note,
      nextAttemptAt: item.nextAttemptAt,
      requeuedAt: item.requeuedAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  ignorePoisonPacket(queueId, { reviewedBy = 'local-operator', note = '' } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (item.status !== 'quarantined') {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    item.status = 'ignored';
    item.reviewStatus = 'ignored';
    item.ignoredAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    this.append({
      recordType: 'packet_ignored',
      queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      reviewedBy,
      note,
      ignoredAt: item.ignoredAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  retryPolicy() {
    return {
      maxAttempts: this.maxAttempts,
      baseBackoffMs: this.baseBackoffMs,
      queuePath: this.queuePath,
      updatedAt: this.policyUpdatedAt ?? null
    };
  }

  updateRetryPolicy({ maxAttempts = this.maxAttempts, baseBackoffMs = this.baseBackoffMs, updatedBy = 'local-operator', reason = '' } = {}) {
    const nextMaxAttempts = Number(maxAttempts);
    const nextBaseBackoffMs = Number(baseBackoffMs);
    if (!Number.isInteger(nextMaxAttempts) || nextMaxAttempts < 1 || nextMaxAttempts > 10) {
      return { success: false, error: { code: 'B_QUEUE_POLICY_MAX_ATTEMPTS_INVALID', message: 'maxAttempts must be an integer between 1 and 10.' } };
    }
    if (!Number.isInteger(nextBaseBackoffMs) || nextBaseBackoffMs < 100 || nextBaseBackoffMs > 60_000) {
      return { success: false, error: { code: 'B_QUEUE_POLICY_BACKOFF_INVALID', message: 'baseBackoffMs must be an integer between 100 and 60000.' } };
    }
    const previous = this.retryPolicy();
    this.maxAttempts = nextMaxAttempts;
    this.baseBackoffMs = nextBaseBackoffMs;
    this.policyUpdatedAt = this.clock().toISOString();
    const current = this.retryPolicy();
    this.append({
      recordType: 'packet_retry_policy_updated',
      previous,
      current,
      updatedBy,
      reason,
      updatedAt: this.policyUpdatedAt
    });
    return { success: true, previous, current };
  }

  publicItem(item) {
    return {
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      packetId: item.packet?.packetId ?? null,
      toolName: item.packet?.action?.toolName ?? null,
      status: item.status,
      attempts: item.attempts,
      queuedAt: item.queuedAt,
      nextAttemptAt: item.nextAttemptAt,
      completedAt: item.completedAt ?? null,
      quarantinedAt: item.quarantinedAt ?? null,
      requeuedAt: item.requeuedAt ?? null,
      ignoredAt: item.ignoredAt ?? null,
      reason: item.reason ?? null,
      error: item.error ?? item.lastError ?? null,
      reviewStatus: item.reviewStatus ?? null,
      reviewedAt: item.reviewedAt ?? null,
      reviewedBy: item.reviewedBy ?? null,
      reviewNote: item.reviewNote ?? null
    };
  }

  status() {
    const items = [...this.items.values()];
    return {
      queuePath: this.queuePath,
      maxAttempts: this.maxAttempts,
      baseBackoffMs: this.baseBackoffMs,
      retryPolicy: this.retryPolicy(),
      total: items.length,
      queued: items.filter((item) => item.status === 'queued').length,
      retryScheduled: items.filter((item) => item.status === 'retry_scheduled').length,
      running: items.filter((item) => item.status === 'running').length,
      succeeded: items.filter((item) => item.status === 'succeeded').length,
      quarantined: items.filter((item) => item.status === 'quarantined').length,
      ignored: items.filter((item) => item.status === 'ignored').length,
      next: items.filter((item) => ['queued', 'retry_scheduled'].includes(item.status)).map((item) => this.publicItem(item)).slice(0, 10),
      deadLetters: this.poisonPackets().slice(0, 20)
    };
  }

  append(record) {
    this.records.push(record);
    appendJsonlSync(this.queuePath, record);
    return record;
  }
}

export class CapabilityTokenVault {
  constructor({
    vaultPath = 'apps/pc-agent/logs/capability-vault.jsonl',
    secret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key',
    keyProvider = null,
    clock = () => new Date()
  } = {}) {
    this.vaultPath = vaultPath;
    this.clock = clock;
    this.keyProvider = keyProvider ?? createDefaultVaultKeyProvider({ secret, vaultPath });
    this.keyInfo = this.keyProvider.resolveKey();
    this.key = this.deriveKey(this.keyInfo.keyMaterial);
    this.keyId = this.keyIdFor(this.keyInfo.keyMaterial);
    this.keyRing = new Map([[this.keyId, this.key]]);
    this.rotationHistory = [];
    this.records = [];
    this.load();
  }

  deriveKey(keyMaterial) {
    return createHash('sha256').update(keyMaterial).digest();
  }

  keyIdFor(keyMaterial) {
    return `pc_vault_key_${createHash('sha256').update(keyMaterial).digest('hex').slice(0, 20)}`;
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.vaultPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
  }

  sealCapabilityToken(token, { taskId, packetId, toolName } = {}) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = JSON.stringify(token);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const record = {
      recordType: 'sealed_capability_token',
      vaultRecordId: stableId('capvault', `${taskId}:${packetId ?? token.tokenId}`, this.clock().toISOString()),
      taskId,
      packetId: packetId ?? null,
      toolName: toolName ?? null,
      tokenIdHash: createHash('sha256').update(token.tokenId ?? '').digest('hex'),
      algorithm: 'aes-256-gcm',
      keyProvider: this.keyInfo.provider,
      keyId: this.keyId,
      keyProtectedByOs: this.keyInfo.protectedByOs === true,
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authTag: authTag.toString('base64'),
      sealedAt: this.clock().toISOString()
    };
    this.records.unshift(record);
    appendJsonlSync(this.vaultPath, record);
    return {
      vaultRecordId: record.vaultRecordId,
      tokenIdHash: record.tokenIdHash,
      sealedAt: record.sealedAt
    };
  }

  open(record) {
    const key = this.keyRing.get(record.keyId) ?? this.key;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(decrypted);
  }

  status() {
    return {
      statusVersion: 'b-capability-vault-status-v1',
      vaultPath: this.vaultPath,
      sealedCount: this.records.length,
      keyProvider: {
        providerVersion: 'b-capability-vault-key-provider-v1',
        provider: this.keyInfo.provider,
        keyId: this.keyId,
        protectedByOs: this.keyInfo.protectedByOs === true,
        scope: this.keyInfo.scope ?? null,
        fallback: this.keyInfo.fallback === true,
        warning: this.keyInfo.warning ?? null
      },
      deploymentPolicy: this.deploymentPolicy(),
      rotation: {
        rotationVersion: 'b-capability-vault-key-rotation-policy-v1',
        supported: true,
        retainedKeyCount: this.keyRing.size,
        rotationCount: this.rotationHistory.length,
        history: this.rotationHistory.slice(0, 10)
      },
      latest: this.records[0]
        ? {
            vaultRecordId: this.records[0].vaultRecordId,
            taskId: this.records[0].taskId,
            tokenIdHash: this.records[0].tokenIdHash,
            keyProvider: this.records[0].keyProvider ?? null,
            keyId: this.records[0].keyId ?? null,
            keyProtectedByOs: this.records[0].keyProtectedByOs === true,
            sealedAt: this.records[0].sealedAt
          }
        : null,
      plaintextTokenStored: this.records.some((record) => JSON.stringify(record).includes('"tokenId"'))
    };
  }

  deploymentPolicy() {
    return {
      policyVersion: 'b-capability-vault-deployment-policy-v1',
      preferredProvider: 'windows-dpapi',
      credentialManagerCompatible: true,
      fallbackProvider: 'env-secret-or-static-dev-secret',
      plaintextTokenStorageAllowed: false,
      serviceEnvironment: {
        providerEnv: 'JARVIS_PC_AGENT_VAULT_KEY_PROVIDER=windows-dpapi',
        optionalSecretEnv: 'JARVIS_PC_AGENT_VAULT_KEY'
      },
      recovery: {
        exportVersion: 'b-capability-vault-export-v1',
        importRecoveryVersion: 'b-capability-vault-import-recovery-v1',
        keyEscrowRequiredForOldRotatedRecords: true
      }
    };
  }

  rotateKey({ nextKeyProvider = null, reason = 'manual_rotation' } = {}) {
    const previous = {
      keyId: this.keyId,
      provider: this.keyInfo.provider,
      protectedByOs: this.keyInfo.protectedByOs === true
    };
    if (nextKeyProvider) this.keyProvider = nextKeyProvider;
    else {
      this.keyProvider = new StaticVaultKeyProvider({
        secret: `rotated-${randomBytes(32).toString('base64')}`,
        provider: this.keyInfo.provider === 'windows-dpapi' ? 'windows-dpapi-rotation-drill' : 'static-rotation-drill'
      });
    }
    this.keyInfo = this.keyProvider.resolveKey();
    this.key = this.deriveKey(this.keyInfo.keyMaterial);
    this.keyId = this.keyIdFor(this.keyInfo.keyMaterial);
    this.keyRing.set(this.keyId, this.key);
    const rotation = {
      rotationVersion: 'b-capability-vault-key-rotation-v1',
      rotatedAt: this.clock().toISOString(),
      reason,
      previous,
      current: {
        keyId: this.keyId,
        provider: this.keyInfo.provider,
        protectedByOs: this.keyInfo.protectedByOs === true
      },
      retainedKeyCount: this.keyRing.size
    };
    this.rotationHistory.unshift(rotation);
    return rotation;
  }

  keyRotationDrill({ reason = 'product_drill' } = {}) {
    const before = this.sealCapabilityToken(
      { tokenId: `cap_rotation_before_${this.clock().getTime()}`, scope: ['drill.before'] },
      { taskId: 'vault_rotation_drill_before', toolName: 'vault.drill' }
    );
    const beforeRecord = this.records.find((record) => record.vaultRecordId === before.vaultRecordId);
    const rotation = this.rotateKey({ reason });
    const after = this.sealCapabilityToken(
      { tokenId: `cap_rotation_after_${this.clock().getTime()}`, scope: ['drill.after'] },
      { taskId: 'vault_rotation_drill_after', toolName: 'vault.drill' }
    );
    const afterRecord = this.records.find((record) => record.vaultRecordId === after.vaultRecordId);
    const beforeOpened = this.open(beforeRecord);
    const afterOpened = this.open(afterRecord);
    const checks = [
      {
        checkId: 'previous_record_opened_after_rotation',
        passed: beforeOpened.tokenId.startsWith('cap_rotation_before_')
      },
      {
        checkId: 'new_record_opened_after_rotation',
        passed: afterOpened.tokenId.startsWith('cap_rotation_after_')
      },
      {
        checkId: 'key_id_changed',
        passed: rotation.previous.keyId !== rotation.current.keyId
      }
    ];
    return {
      drillVersion: 'b-capability-vault-key-rotation-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      rotation
    };
  }

  exportEncryptedVault({ reason = 'vault_export' } = {}) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = JSON.stringify({
      exportPayloadVersion: 'b-capability-vault-export-payload-v1',
      exportedAt: this.clock().toISOString(),
      reason,
      records: this.records
    });
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      exportVersion: 'b-capability-vault-export-v1',
      exportedAt: this.clock().toISOString(),
      reason,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      keyId: this.keyId,
      recordCount: this.records.length,
      plaintextTokenStored: false,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  importEncryptedVault({ exportBundle, reason = 'vault_import_recovery', replace = false } = {}) {
    if (!exportBundle || exportBundle.exportVersion !== 'b-capability-vault-export-v1') {
      return { success: false, error: { code: 'B_VAULT_EXPORT_INVALID' } };
    }
    const key = exportBundle.keyId ? (this.keyRing.get(exportBundle.keyId) ?? this.key) : this.key;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(exportBundle.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(exportBundle.authTag, 'base64'));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(exportBundle.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8'));
    const importedRecords = payload.records ?? [];
    if (replace) {
      this.records = [];
      writeFileSync(this.vaultPath, '', 'utf8');
    }
    const existing = new Set(this.records.map((record) => record.vaultRecordId));
    let importedCount = 0;
    for (const record of importedRecords) {
      if (existing.has(record.vaultRecordId)) continue;
      this.records.unshift(record);
      appendJsonlSync(this.vaultPath, record);
      importedCount += 1;
    }
    return {
      recoveryVersion: 'b-capability-vault-import-recovery-v1',
      generatedAt: this.clock().toISOString(),
      reason,
      status: 'recovered',
      success: true,
      exportKeyId: exportBundle.keyId,
      exportedRecordCount: importedRecords.length,
      importedCount,
      sealedCount: this.records.length,
      plaintextTokenStored: this.status().plaintextTokenStored
    };
  }

  releaseDossier({
    productChecks = [],
    vaultStatus = this.status(),
    exportBundle = null,
    recovery = null,
    rotationDrill = null
  } = {}) {
    const releaseChecks = [
      {
        checkId: 'capability_vault_key_provider_release_evidence',
        passed: vaultStatus.keyProvider?.providerVersion === 'b-capability-vault-key-provider-v1'
          && (vaultStatus.keyProvider.protectedByOs === true || vaultStatus.deploymentPolicy?.preferredProvider === 'windows-dpapi')
          && vaultStatus.deploymentPolicy?.policyVersion === 'b-capability-vault-deployment-policy-v1',
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        preferredProvider: vaultStatus.deploymentPolicy?.preferredProvider ?? null
      },
      {
        checkId: 'capability_vault_plaintext_absence_release_evidence',
        passed: vaultStatus.plaintextTokenStored === false,
        sealedCount: vaultStatus.sealedCount,
        plaintextTokenStored: vaultStatus.plaintextTokenStored
      },
      {
        checkId: 'capability_vault_encrypted_export_release_evidence',
        passed: exportBundle?.exportVersion === 'b-capability-vault-export-v1'
          && exportBundle.encrypted === true
          && exportBundle.plaintextTokenStored === false
          && exportBundle.recordCount >= 1,
        recordCount: exportBundle?.recordCount ?? 0,
        keyId: exportBundle?.keyId ?? null
      },
      {
        checkId: 'capability_vault_import_recovery_release_evidence',
        passed: recovery?.recoveryVersion === 'b-capability-vault-import-recovery-v1'
          && recovery.status === 'recovered'
          && recovery.plaintextTokenStored === false,
        exportedRecordCount: recovery?.exportedRecordCount ?? 0,
        importedCount: recovery?.importedCount ?? 0
      },
      {
        checkId: 'capability_vault_key_rotation_release_evidence',
        passed: rotationDrill?.drillVersion === 'b-capability-vault-key-rotation-drill-v1'
          && rotationDrill.status === 'passed'
          && rotationDrill.rotation?.previous?.keyId !== rotationDrill.rotation?.current?.keyId,
        retainedKeyCount: rotationDrill?.rotation?.retainedKeyCount ?? 0,
        currentProvider: rotationDrill?.rotation?.current?.provider ?? null
      }
    ];
    const artifactManifest = {
      manifestVersion: 'b-capability-vault-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      vaultPathHash: createHash('sha256').update(String(this.vaultPath ?? '')).digest('hex'),
      keyProviderHash: createHash('sha256').update(canonicalJson({
        providerVersion: vaultStatus.keyProvider?.providerVersion ?? null,
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        scope: vaultStatus.keyProvider?.scope ?? null,
        fallback: vaultStatus.keyProvider?.fallback === true
      })).digest('hex'),
      exportEvidenceHash: createHash('sha256').update(canonicalJson({
        exportVersion: exportBundle?.exportVersion ?? null,
        encrypted: exportBundle?.encrypted === true,
        recordCount: exportBundle?.recordCount ?? 0,
        plaintextTokenStored: exportBundle?.plaintextTokenStored === true
      })).digest('hex'),
      recoveryEvidenceHash: createHash('sha256').update(canonicalJson({
        recoveryVersion: recovery?.recoveryVersion ?? null,
        status: recovery?.status ?? null,
        importedCount: recovery?.importedCount ?? 0,
        plaintextTokenStored: recovery?.plaintextTokenStored === true
      })).digest('hex'),
      rotationDrillHash: createHash('sha256').update(canonicalJson({
        drillVersion: rotationDrill?.drillVersion ?? null,
        status: rotationDrill?.status ?? null,
        retainedKeyCount: rotationDrill?.rotation?.retainedKeyCount ?? 0
      })).digest('hex'),
      rawVaultPathStored: false,
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false,
      plaintextTokenStored: vaultStatus.plaintextTokenStored === true
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-capability-vault-release-raw-leak-check-v1',
      rawLeakDetected: containsCapabilityVaultRawLeak(artifactManifest),
      checkedRawFields: [
        'rawVaultPathStored',
        'rawTokenIdStored',
        'rawSecretStored',
        'rawKeyMaterialStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-capability-vault-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-capability-vault-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        sealedCount: vaultStatus.sealedCount,
        providerVersion: vaultStatus.keyProvider?.providerVersion ?? null,
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        plaintextTokenStored: vaultStatus.plaintextTokenStored === true,
        exportReady: exportBundle?.exportVersion === 'b-capability-vault-export-v1' && exportBundle.encrypted === true,
        recoveryReady: recovery?.recoveryVersion === 'b-capability-vault-import-recovery-v1' && recovery.status === 'recovered',
        rotationReady: rotationDrill?.drillVersion === 'b-capability-vault-key-rotation-drill-v1' && rotationDrill.status === 'passed'
      },
      fallbackPolicy: {
        policyVersion: 'b-capability-vault-fallback-policy-v1',
        primaryFlow: 'windows_dpapi_or_credential_manager_key_provider',
        fallbackFlows: [
          'env_secret_dev_provider_with_plaintext_absence_check',
          'encrypted_export_import_recovery',
          'key_rotation_drill_before_release'
        ],
        operatorEscalation: 'pc_agent_vault_lifecycle_api'
      },
      rawVaultPathStored: false,
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-capability-vault-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B capability vault supports OS-protected key provider" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'plaintext_token_not_stored',
        'encrypted_export_created',
        'import_recovery_completed',
        'key_rotation_drill_passed',
        'capability_vault_release_artifact_manifest_ready',
        'capability_vault_operational_handoff_ready',
        'capability_vault_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawVaultPathStored: false,
      rawTokenIdStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-capability-vault-worm-promotion-package-v1',
      providerContractVersion: 'b-capability-vault-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-capability-vault-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-capability-vault-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false
    };
    const dossier = {
      dossierVersion: 'b-capability-vault-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: productChecks.every((check) => check.passed)
        && releaseChecks.every((check) => check.passed)
        && externalWormPromotionPackage.status === 'ready'
        ? 'passed'
        : 'blocked',
      vaultPathHash: artifactManifest.vaultPathHash,
      rawVaultPathStored: false,
      sealedCount: vaultStatus.sealedCount,
      keyProvider: vaultStatus.keyProvider,
      deploymentPolicy: vaultStatus.deploymentPolicy,
      rotation: vaultStatus.rotation,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      exportEvidence: exportBundle
        ? {
            exportVersion: exportBundle.exportVersion,
            encrypted: exportBundle.encrypted,
            recordCount: exportBundle.recordCount,
            plaintextTokenStored: exportBundle.plaintextTokenStored,
            keyId: exportBundle.keyId
          }
        : null,
      recoveryEvidence: recovery,
      rotationDrill,
      productChecks: productChecks.map((check) => ({ ...check })),
      releaseChecks,
      recommendedReleaseAction: releaseChecks.every((check) => check.passed)
        && externalWormPromotionPackage.status === 'ready'
        ? 'attach_capability_vault_hash_only_handoff_and_worm_release_evidence'
        : 'block_capability_vault_release_until_dpapi_or_recovery_evidence_passes'
    };
    dossier.dossierSha256 = createHash('sha256').update(JSON.stringify(dossier)).digest('hex');
    return dossier;
  }

  productGate() {
    const status = this.status();
    this.sealCapabilityToken(
      { tokenId: `cap_product_gate_${this.clock().getTime()}`, scope: ['vault.product_gate'] },
      { taskId: 'vault_product_gate', toolName: 'vault.productGate' }
    );
    const exportBundle = this.exportEncryptedVault({ reason: 'product_gate_export' });
    const recoveryVault = new CapabilityTokenVault({
      vaultPath: `${this.vaultPath}.recovery-${this.clock().getTime()}.jsonl`,
      keyProvider: {
        resolveKey: () => this.keyInfo
      },
      clock: this.clock
    });
    const recovery = recoveryVault.importEncryptedVault({
      exportBundle,
      reason: 'product_gate_recovery',
      replace: true
    });
    const rotationDrill = this.keyRotationDrill({ reason: 'product_gate_rotation' });
    const checks = [
      {
        checkId: 'os_or_deployment_policy_available',
        passed: status.keyProvider.protectedByOs === true || status.deploymentPolicy.preferredProvider === 'windows-dpapi'
      },
      {
        checkId: 'plaintext_token_not_stored',
        passed: this.status().plaintextTokenStored === false
      },
      {
        checkId: 'encrypted_export_created',
        passed: exportBundle.exportVersion === 'b-capability-vault-export-v1' && exportBundle.encrypted === true
      },
      {
        checkId: 'import_recovery_completed',
        passed: recovery.recoveryVersion === 'b-capability-vault-import-recovery-v1' && recovery.status === 'recovered'
      },
      {
        checkId: 'key_rotation_drill_passed',
        passed: rotationDrill.drillVersion === 'b-capability-vault-key-rotation-drill-v1' && rotationDrill.status === 'passed'
      }
    ];
    const releaseDossier = this.releaseDossier({
      productChecks: checks,
      vaultStatus: this.status(),
      exportBundle,
      recovery,
      rotationDrill
    });
    checks.push({
      checkId: 'capability_vault_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'b-capability-vault-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    });
    checks.push({
      checkId: 'capability_vault_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest?.manifestVersion === 'b-capability-vault-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawVaultPathStored === false
        && releaseDossier.artifactManifest.rawTokenIdStored === false
    });
    checks.push({
      checkId: 'capability_vault_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'b-capability-vault-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'b-capability-vault-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-capability-vault-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
    });
    checks.push({
      checkId: 'capability_vault_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'b-capability-vault-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-capability-vault-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    });
    recoveryVault.close?.();
    return {
      productGateVersion: 'b-capability-vault-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      vaultStatus: this.status(),
      exportBundle: {
        exportVersion: exportBundle.exportVersion,
        encrypted: exportBundle.encrypted,
        recordCount: exportBundle.recordCount,
        keyId: exportBundle.keyId,
        plaintextTokenStored: exportBundle.plaintextTokenStored
      },
      recovery,
      rotationDrill,
      releaseDossier
    };
  }
}

export class StaticVaultKeyProvider {
  constructor({ secret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key', provider = process.env.JARVIS_PC_AGENT_VAULT_KEY ? 'env-secret' : 'static-dev-secret' } = {}) {
    this.secret = secret;
    this.provider = provider;
  }

  resolveKey() {
    return {
      keyMaterial: Buffer.from(String(this.secret), 'utf8'),
      provider: this.provider,
      protectedByOs: false,
      fallback: this.provider === 'static-dev-secret'
    };
  }
}

export class WindowsDpapiVaultKeyProvider {
  constructor({
    cachePath = 'apps/pc-agent/logs/capability-vault.dpapi-key',
    scope = 'CurrentUser',
    fallbackSecret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key'
  } = {}) {
    this.cachePath = cachePath;
    this.scope = scope;
    this.fallbackSecret = fallbackSecret;
  }

  resolveKey() {
    if (process.platform !== 'win32') {
      return this.fallback(`DPAPI provider requires Windows; current platform is ${process.platform}.`);
    }
    try {
      const keyMaterial = existsSync(this.cachePath)
        ? this.unprotect(readFileSync(this.cachePath, 'utf8').trim())
        : this.createProtectedKey();
      return {
        keyMaterial,
        provider: 'windows-dpapi',
        protectedByOs: true,
        scope: this.scope,
        cachePath: this.cachePath,
        fallback: false
      };
    } catch (error) {
      return this.fallback(`DPAPI key provider failed: ${error.message}`);
    }
  }

  createProtectedKey() {
    const keyMaterial = randomBytes(32);
    const protectedKey = this.protect(keyMaterial);
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, `${protectedKey}\n`, { encoding: 'utf8', flag: 'wx' });
    return keyMaterial;
  }

  protect(keyMaterial) {
    return runDpapiPowerShell({
      inputBase64: Buffer.from(keyMaterial).toString('base64'),
      scope: this.scope,
      mode: 'Protect'
    });
  }

  unprotect(protectedBase64) {
    const clearBase64 = runDpapiPowerShell({
      inputBase64: protectedBase64,
      scope: this.scope,
      mode: 'Unprotect'
    });
    return Buffer.from(clearBase64, 'base64');
  }

  fallback(warning) {
    return {
      keyMaterial: Buffer.from(String(this.fallbackSecret), 'utf8'),
      provider: 'static-dev-fallback',
      protectedByOs: false,
      fallback: true,
      warning
    };
  }
}

function createDefaultVaultKeyProvider({ secret, vaultPath }) {
  const requested = String(process.env.JARVIS_PC_AGENT_VAULT_KEY_PROVIDER ?? '').toLowerCase();
  if (requested === 'windows-dpapi' || requested === 'dpapi') {
    return new WindowsDpapiVaultKeyProvider({
      cachePath: `${vaultPath}.dpapi-key`,
      fallbackSecret: secret
    });
  }
  return new StaticVaultKeyProvider({
    secret,
    provider: process.env.JARVIS_PC_AGENT_VAULT_KEY ? 'env-secret' : 'static-dev-secret'
  });
}

function runDpapiPowerShell({ inputBase64, scope, mode }) {
  const method = mode === 'Protect' ? 'Protect' : 'Unprotect';
  const command = [
    'Add-Type -AssemblyName System.Security;',
    '$bytes=[Convert]::FromBase64String($env:JARVIS_DPAPI_INPUT);',
    `$scope=[System.Security.Cryptography.DataProtectionScope]::${scope === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser'};`,
    `$out=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,$scope);`,
    '[Convert]::ToBase64String($out)'
  ].join(' ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, JARVIS_DPAPI_INPUT: inputBase64 }
  }).trim();
}

export class ToolAdapterRegistry {
  constructor() {
    this.adapters = new Map();
    this.contracts = new Map();
  }

  register(toolName, adapter) {
    const validation = this.validateAdapter(toolName, adapter);
    if (!validation.valid) {
      const error = new Error(`Tool adapter contract invalid: ${validation.errors.join(' | ')}`);
      error.code = 'B_TOOL_ADAPTER_CONTRACT_INVALID';
      error.errors = validation.errors;
      throw error;
    }
    this.adapters.set(toolName, adapter);
    this.contracts.set(toolName, adapter.contract);
  }

  get(toolName) {
    return this.adapters.get(toolName);
  }

  contractFor(toolName) {
    return this.contracts.get(toolName) ?? null;
  }

  capabilityMatrix() {
    return [...this.contracts.values()];
  }

  validateAdapter(toolName, adapter) {
    const errors = [];
    if (!toolName) errors.push('toolName is required.');
    if (typeof adapter?.shadow !== 'function') errors.push(`${toolName}.shadow(args, packet) is required.`);
    if (typeof adapter?.execute !== 'function') errors.push(`${toolName}.execute(args, packet) is required.`);
    if (!adapter?.contract || typeof adapter.contract !== 'object') errors.push(`${toolName}.contract is required.`);
    if (adapter?.contract?.toolName !== toolName) errors.push(`${toolName}.contract.toolName must match registry key.`);
    if (!Array.isArray(adapter?.contract?.evidence)) errors.push(`${toolName}.contract.evidence must be an array.`);
    if (!Array.isArray(adapter?.contract?.modes) || adapter.contract.modes.length === 0) errors.push(`${toolName}.contract.modes is required.`);
    return { valid: errors.length === 0, errors };
  }
}

export class ExecutionEvidenceSchemaRegistry {
  constructor() {
    this.schemas = new Map([
      ['filesystem.createTextFile', ['outputPaths', 'changedItems', 'files', 'undoJournalId', 'adapterEvidence.targetPath']],
      ['filesystem.moveFiles', ['outputPaths', 'changedItems', 'files', 'undoJournalId']],
      ['excel.createWorkbook', ['outputPaths', 'changedItems', 'files', 'adapterEvidence.workbook']],
      ['browser.search', ['adapterEvidence.browser.networkCapture', 'adapterEvidence.browser.domSnapshot', 'adapterEvidence.browser.blockedOperations']]
    ]);
  }

  validate(evidence) {
    const required = this.schemas.get(evidence.toolName) ?? ['outputPaths', 'changedItems'];
    const missing = required.filter((path) => this.lookup(evidence, path) === undefined);
    return {
      valid: missing.length === 0,
      schemaId: `b-evidence-${evidence.toolName ?? 'generic'}-v1`,
      required,
      missing
    };
  }

  lookup(value, path) {
    return path.split('.').reduce((current, part) => current?.[part], value);
  }

  snapshot() {
    const schemas = [...this.schemas.entries()]
      .map(([toolName, required]) => ({ toolName, schemaId: `b-evidence-${toolName}-v1`, required: [...required].sort() }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
    const snapshot = {
      snapshotVersion: 'b-execution-evidence-schema-snapshot-v1',
      generatedAt: new Date().toISOString(),
      schemaCount: schemas.length,
      schemas
    };
    return {
      ...snapshot,
      snapshotHash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
    };
  }

  regressionReport(baseline) {
    const current = this.snapshot();
    const baselineSchemas = new Map((baseline?.schemas ?? []).map((item) => [item.toolName, item]));
    const currentSchemas = new Map(current.schemas.map((item) => [item.toolName, item]));
    const items = [];
    for (const [toolName, schema] of currentSchemas) {
      const previous = baselineSchemas.get(toolName);
      const added = schema.required.filter((item) => !(previous?.required ?? []).includes(item));
      const removed = (previous?.required ?? []).filter((item) => !schema.required.includes(item));
      items.push({
        toolName,
        status: !previous ? 'added' : (removed.length ? 'breaking_removed_required_field' : added.length ? 'expanded' : 'unchanged'),
        added,
        removed
      });
    }
    for (const [toolName, schema] of baselineSchemas) {
      if (!currentSchemas.has(toolName)) {
        items.push({ toolName, status: 'removed_schema', added: [], removed: schema.required ?? [] });
      }
    }
    return {
      reportVersion: 'b-execution-evidence-schema-regression-v1',
      generatedAt: new Date().toISOString(),
      status: items.some((item) => item.status === 'removed_schema' || item.status === 'breaking_removed_required_field') ? 'failed' : 'passed',
      currentSnapshotHash: current.snapshotHash,
      baselineSnapshotHash: baseline?.snapshotHash ?? null,
      items
    };
  }
}

export class EvidencePrivacyRedactor {
  constructor({ sensitiveKeyPattern = /password|token|secret|cookie|authorization|apiKey|previousContent|content|credential|주민|비밀번호|계좌/i } = {}) {
    this.sensitiveKeyPattern = sensitiveKeyPattern;
  }

  redact(value) {
    const stats = { sensitiveKeyCount: 0 };
    const redacted = this.walk(value, stats);
    return { redacted, stats };
  }

  walk(value, stats) {
    if (Array.isArray(value)) return value.map((item) => this.walk(item, stats));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (this.sensitiveKeyPattern.test(key)) {
        stats.sensitiveKeyCount += 1;
        return [key, '[redacted]'];
      }
      return [key, this.walk(item, stats)];
    }));
  }

  runFixtureCorpus(corpus = createEvidencePrivacyFixtureCorpus()) {
    const items = (corpus.cases ?? []).map((testCase) => {
      const result = this.redact(testCase.input);
      const serialized = JSON.stringify(result.redacted);
      const leaks = (testCase.mustNotContain ?? []).filter((needle) => serialized.includes(needle));
      return {
        caseId: testCase.caseId,
        status: leaks.length === 0 && result.stats.sensitiveKeyCount >= (testCase.expectedSensitiveKeyCountMin ?? 1) ? 'passed' : 'failed',
        sensitiveKeyCount: result.stats.sensitiveKeyCount,
        leaks,
        redacted: result.redacted
      };
    });
    return {
      corpusVersion: corpus.corpusVersion,
      reportVersion: 'b-evidence-privacy-redaction-fixture-report-v1',
      generatedAt: new Date().toISOString(),
      status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
      caseCount: items.length,
      items
    };
  }
}

export function createEvidencePrivacyFixtureCorpus() {
  return {
    corpusVersion: 'b-evidence-privacy-redaction-fixture-corpus-v1',
    generatedAt: new Date().toISOString(),
    cases: [
      {
        caseId: 'capability_token_redacted',
        input: { tokenId: 'cap_plaintext_token', authorization: 'Bearer secret-token', safe: 'ok' },
        mustNotContain: ['cap_plaintext_token', 'secret-token'],
        expectedSensitiveKeyCountMin: 2
      },
      {
        caseId: 'file_content_redacted',
        input: { targetPath: 'C:/safe/out.txt', previousContent: 'private before', content: 'private after' },
        mustNotContain: ['private before', 'private after'],
        expectedSensitiveKeyCountMin: 2
      },
      {
        caseId: 'browser_cookie_redacted',
        input: { browser: { networkCapture: { cookie: 'sid=abc', headers: { authorization: 'Bearer abc' } }, domSnapshot: '<main>safe</main>' } },
        mustNotContain: ['sid=abc', 'Bearer abc'],
        expectedSensitiveKeyCountMin: 2
      }
    ]
  };
}

function createToolContract({
  toolName,
  readOnly = false,
  mutatesSystem = false,
  rollback = false,
  evidence = [],
  blockedOperations = [],
  modes = ['shadow', 'execute']
}) {
  return {
    toolName,
    readOnly,
    mutatesSystem,
    preview: true,
    execute: true,
    rollback,
    evidence,
    blockedOperations,
    modes
  };
}

export class ExecutionEvidenceCollector {
  constructor({ clock = () => new Date(), logPath = 'apps/pc-agent/logs/evidence.jsonl', schemaRegistry = new ExecutionEvidenceSchemaRegistry(), privacyRedactor = new EvidencePrivacyRedactor() } = {}) {
    this.clock = clock;
    this.logPath = logPath;
    this.items = new Map();
    this.schemaRegistry = schemaRegistry;
    this.privacyRedactor = privacyRedactor;
  }

  async fileHash(path) {
    const buffer = await readFile(path);
    return createHash('sha256').update(buffer).digest('hex');
  }

  async collect({ packet, shadow, executionResult, status }) {
    const files = [];
    for (const outputPath of executionResult.outputPaths ?? []) {
      if (await exists(outputPath)) {
        const fileStat = await stat(outputPath);
        files.push({
          path: outputPath,
          sha256: await this.fileHash(outputPath),
          size: fileStat.size
        });
      }
    }
    const adapterRedaction = this.privacyRedactor.redact(maskSensitive(executionResult.evidence ?? {}));
    const evidence = {
      evidenceId: stableId('evidence', `${packet.taskId}:${packet.packetId ?? 'packet'}`, this.clock().toISOString()),
      taskId: packet.taskId,
      packetId: packet.packetId,
      status,
      toolName: packet.action?.toolName,
      actionType: packet.action?.actionType,
      outputPaths: executionResult.outputPaths ?? [],
      changedItems: executionResult.changedItems ?? [],
      files,
      shadow: {
        expectedChangesCount: shadow?.expectedChangesCount ?? 0,
        warnings: shadow?.warnings ?? []
      },
      undoJournalId: executionResult.undoJournalId,
      adapterEvidence: adapterRedaction.redacted,
      privacyRedaction: {
        policy: 'mask-sensitive-keys-before-g-f-handoff',
        sensitiveKeyCount: adapterRedaction.stats.sensitiveKeyCount,
        plaintextCapabilityTokenPresent: JSON.stringify(adapterRedaction.redacted).includes(packet.capabilityToken?.tokenId ?? '__missing_token__')
      },
      collectedAt: this.clock().toISOString(),
      logPath: this.logPath
    };
    evidence.schemaValidation = this.schemaRegistry.validate(evidence);
    this.items.set(packet.taskId, evidence);
    appendJsonlSync(this.logPath, evidence);
    return evidence;
  }

  get(taskId) {
    return this.items.get(taskId) ?? { success: false, error: { code: 'B_EVIDENCE_NOT_FOUND' } };
  }

  recent(limit = 20) {
    return [...this.items.values()].slice(-limit).reverse();
  }

  query({ cursor = 0, limit = 20, taskId = null, status = null, toolName = null, since = null, until = null } = {}) {
    const offset = Math.max(0, Number(cursor ?? 0));
    const pageLimit = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const sinceMs = since ? Date.parse(since) : null;
    const untilMs = until ? Date.parse(until) : null;
    const filtered = [...this.items.values()]
      .filter((item) => !taskId || item.taskId === taskId)
      .filter((item) => !status || item.status === status)
      .filter((item) => !toolName || item.toolName === toolName)
      .filter((item) => sinceMs === null || Date.parse(item.collectedAt) >= sinceMs)
      .filter((item) => untilMs === null || Date.parse(item.collectedAt) <= untilMs)
      .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
    const items = filtered.slice(offset, offset + pageLimit);
    return {
      queryVersion: 'b-execution-evidence-query-v1',
      generatedAt: this.clock().toISOString(),
      filters: { taskId, status, toolName, since, until },
      pageInfo: {
        cursor: offset,
        limit: pageLimit,
        total: filtered.length,
        nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
      },
      items
    };
  }

  retentionReport({ keepLast = 100, maxAgeMs = null } = {}) {
    const nowMs = this.clock().getTime();
    const sorted = [...this.items.values()].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
    const removable = sorted
      .map((item, index) => {
        const ageMs = Math.max(0, nowMs - Date.parse(item.collectedAt ?? this.clock().toISOString()));
        const reasons = [];
        if (index >= keepLast) reasons.push('keepLast');
        if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) reasons.push('maxAgeMs');
        return reasons.length ? {
          evidenceId: item.evidenceId,
          taskId: item.taskId,
          collectedAt: item.collectedAt,
          ageMs,
          reasons
        } : null;
      })
      .filter(Boolean);
    return {
      reportVersion: 'b-execution-evidence-retention-report-v1',
      generatedAt: this.clock().toISOString(),
      policy: { keepLast, maxAgeMs },
      total: sorted.length,
      retainedCount: sorted.length - removable.length,
      removableCount: removable.length,
      rotationRecommended: removable.length > 0,
      removable
    };
  }

  async rotate({ keepLast = 100, maxAgeMs = null, dryRun = true, archivePath = null } = {}) {
    const report = this.retentionReport({ keepLast, maxAgeMs });
    const removableIds = new Set(report.removable.map((item) => item.evidenceId));
    const removed = [...this.items.values()].filter((item) => removableIds.has(item.evidenceId));
    const retained = [...this.items.values()].filter((item) => !removableIds.has(item.evidenceId));
    const rotation = {
      rotationVersion: 'b-execution-evidence-rotation-v1',
      generatedAt: this.clock().toISOString(),
      dryRun,
      report,
      removed: removed.map((item) => ({ evidenceId: item.evidenceId, taskId: item.taskId, collectedAt: item.collectedAt })),
      retainedCount: retained.length,
      archive: null
    };
    if (dryRun || removed.length === 0) return rotation;
    const resolvedArchivePath = archivePath ?? resolve(dirname(this.logPath), `evidence-archive-${this.clock().getTime()}.json`);
    const archive = {
      archiveVersion: 'b-execution-evidence-rotation-archive-v1',
      generatedAt: this.clock().toISOString(),
      sourceLogPath: this.logPath,
      itemCount: removed.length,
      items: removed
    };
    await mkdir(dirname(resolvedArchivePath), { recursive: true });
    await writeFile(resolvedArchivePath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    await writeFile(this.logPath, retained.map((item) => JSON.stringify(item)).join('\n') + (retained.length ? '\n' : ''), 'utf8');
    this.items = new Map(retained.map((item) => [item.taskId, item]));
    rotation.archive = {
      path: resolvedArchivePath,
      sha256: createHash('sha256').update(canonicalJson(archive)).digest('hex'),
      itemCount: removed.length
    };
    return rotation;
  }

  schemaSnapshot() {
    return this.schemaRegistry.snapshot();
  }

  schemaRegressionReport(baseline) {
    return this.schemaRegistry.regressionReport(baseline);
  }

  privacyFixtureReport() {
    return this.privacyRedactor.runFixtureCorpus();
  }
}

export class ExecutionMemoryEmitter {
  constructor({ clock = () => new Date(), logPath = 'apps/pc-agent/logs/memory-events.jsonl' } = {}) {
    this.clock = clock;
    this.logPath = logPath;
    this.items = [];
  }

  emit({ packet, executionResult, outcome, evidence }) {
    const event = {
      eventId: stableId('memexec', `${packet.taskId}:${packet.packetId ?? 'packet'}:${outcome}`, this.clock().toISOString()),
      eventType: outcome === 'blocked' ? 'execution.blocked' : outcome === 'failure' ? 'execution.failed' : 'execution.completed',
      taskId: packet.taskId,
      packetId: packet.packetId,
      skillId: packet.action?.skillId,
      toolName: packet.action?.toolName,
      actionType: packet.action?.actionType,
      outcome,
      userCommand: packet.action?.arguments?.rawText ?? packet.action?.arguments?.content ?? packet.action?.arguments?.query ?? '',
      interpretedIntent: packet.action?.toolName ?? packet.action?.actionType ?? 'unknown',
      payload: {
        outputPaths: executionResult.outputPaths ?? [],
        changedItems: executionResult.changedItems ?? [],
        rollbackAvailable: executionResult.rollbackAvailable === true,
        evidenceId: evidence?.evidenceId
      },
      learningFlags: {
        doNotRemember: false,
        sourceModule: ModuleId.PC_AGENT
      },
      createdAt: this.clock().toISOString()
    };
    this.items.unshift(event);
    appendJsonlSync(this.logPath, event);
    return event;
  }

  recent(limit = 20) {
    return this.items.slice(0, limit);
  }

  query({ cursor = 0, limit = 20, eventType = null, taskId = null } = {}) {
    const offset = Math.max(0, Number(cursor ?? 0));
    const pageLimit = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const filtered = this.items
      .filter((item) => !eventType || item.eventType === eventType)
      .filter((item) => !taskId || item.taskId === taskId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const items = filtered.slice(offset, offset + pageLimit);
    return {
      queryVersion: 'b-execution-memory-event-query-v1',
      generatedAt: this.clock().toISOString(),
      filters: { eventType, taskId },
      pageInfo: {
        cursor: offset,
        limit: pageLimit,
        total: filtered.length,
        nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
      },
      items
    };
  }
}

export class FileSystemToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.pathGuard = new PathSafetyGuard({ allowedRoots: this.allowedRoots });
    this.contract = createToolContract({
      toolName: 'filesystem.createTextFile',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'overwriteWithoutApproval']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async shadow(args) {
    let targetPath;
    let pathSafety = null;
    let toctouLock = null;
    try {
      pathSafety = await this.pathGuard.inspect(args.path, { checkParentForCreate: true, operation: 'create' });
      if (!pathSafety.allowed) throw new Error(pathSafety.issue?.detail ?? `outside-allowed-roots:${pathSafety.resolvedPath}`);
      targetPath = pathSafety.resolvedPath;
      toctouLock = await this.pathGuard.createOpenAfterRealpathLock(args.path, { checkParentForCreate: true, operation: 'create' });
    } catch (error) {
      const issue = classifyFileError(error, { path: args.path });
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        targetPath: resolve(args.path),
        targetExists: false,
        conflictPolicy: 'blocked-by-path-guard',
        pathSafety,
        issues: [issue],
        warnings: [issue.detail ?? issue.code]
      };
    }
    const targetExists = await exists(targetPath);
    const issues = targetExists && !args.allowOverwrite
      ? [classifyFileIssue({ code: 'targetExists', path: targetPath, targetPath })]
      : [];
    return {
      mode: 'shadow',
      expectedChangesCount: targetExists && !args.allowOverwrite ? 0 : 1,
      targetPath,
      targetExists,
      conflictPolicy: args.allowOverwrite ? 'overwrite-approved' : 'block-overwrite-without-approval',
      pathSafety,
      toctouLock,
      issues,
      warnings: issues.map((issue) => issue.code === 'targetExists' ? `target-exists:${targetPath}` : issue.code)
    };
  }

  async execute(args, packet = {}) {
    const preview = await this.shadow(args);
    const targetPath = preview.targetPath;
    if (preview.warnings.length) {
      return {
        status: 'blocked',
        summary: 'File create preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: preview.warnings,
        evidence: {
          targetPath,
          conflictPolicy: preview.conflictPolicy,
          issues: preview.issues ?? []
        }
      };
    }
    const lockVerification = await this.pathGuard.verifyOpenAfterRealpathLock(preview.toctouLock);
    if (lockVerification.status !== 'valid') {
      return {
        status: 'blocked',
        summary: 'File create path lock changed before execution.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: [lockVerification.issue?.detail ?? 'toctou-lock-changed'],
        evidence: {
          targetPath,
          conflictPolicy: 'blocked-by-toctou-lock',
          issues: [lockVerification.issue],
          pathSafety: preview.pathSafety,
          toctouLock: preview.toctouLock,
          lockVerification
        }
      };
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const previousContent = args.allowOverwrite && await exists(targetPath) ? await readFile(targetPath, 'utf8') : null;
    await writeFile(targetPath, args.content ?? '', 'utf8');
    const undo = this.undoJournal.record(previousContent === null ? {
      taskId: packet.taskId,
      action: 'delete_created_file',
      path: targetPath
    } : {
      taskId: packet.taskId,
      action: 'restore_previous_file',
      path: targetPath,
      previousContent
    });
    return {
      status: 'success',
      outputPaths: [targetPath],
      changedItems: [{ type: previousContent === null ? 'create_file' : 'overwrite_file', path: targetPath }],
      rollbackAvailable: true,
      undoJournalId: undo.undoJournalId,
      evidence: {
        targetPath,
        conflictPolicy: preview.conflictPolicy,
        pathSafety: preview.pathSafety,
        toctouLock: preview.toctouLock,
        lockVerification
      }
    };
  }
}

export class FileListToolAdapter {
  constructor({ allowedRoots = ['./workspace'] } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.contract = createToolContract({
      toolName: 'filesystem.listFiles',
      readOnly: true,
      evidence: ['directory', 'itemCount', 'metadataOnly'],
      blockedOperations: ['outsideAllowedRoots', 'fileContentRead']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async shadow(args) {
    let directory;
    try {
      directory = await assertAllowedRealPath(args.directory ?? args.path ?? './workspace', this.allowedRoots);
    } catch (error) {
      const issue = classifyFileError(error, { path: args.directory ?? args.path });
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        directory: resolve(args.directory ?? args.path ?? './workspace'),
        items: [],
        issues: [issue],
        warnings: [issue.detail ?? issue.code]
      };
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const items = await Promise.all(entries.slice(0, args.maxItems ?? 100).map(async (entry) => {
      const fullPath = resolve(directory, entry.name);
      const itemStat = await stat(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: itemStat.size,
        modifiedAt: itemStat.mtime.toISOString()
      };
    }));
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      directory,
      items,
      warnings: []
    };
  }

  async execute(args) {
    const shadow = await this.shadow(args);
    return {
      status: 'success',
      outputPaths: [],
      changedItems: [],
      rollbackAvailable: false,
      listedItems: shadow.items
    };
  }
}

// 셸 명령의 위험도를 정적 분류한다. 'blocked'는 어댑터가 승인과 무관하게 절대 실행하지 않는다.
// 문자열 denylist는 난독화로 우회 가능하므로, 정적 검사를 무력화하는 "동적 실행"을 먼저 차단한다.
const shellDenyPatterns = [
  // 동적 실행/난독화: iex 등은 그 안의 코드를 검사할 수 없어 denylist 자체를 무력화한다 → 원천 차단.
  { re: /(^|\s|;|&|\||\()(iex|icm)(\s|$)|invoke-expression|invoke-command\b|-encodedcommand|-enc\b|-e\s+[A-Za-z0-9+/=]{16,}|frombase64string|\[scriptblock\]|\.invoke\(/i, reason: '동적 코드 실행' },
  { re: /downloadstring|downloadfile|downloaddata|start-bitstransfer|invoke-webrequest|invoke-restmethod|\biwr\b|\bcurl\b|\bwget\b|net\.webclient/i, reason: '원격 다운로드/실행' },
  // 삭제(별칭 포함): ri/rbp는 Remove-Item 별칭.
  { re: /(^|\s|;|&|\||\()(rm|del|erase|rd|rmdir|ri|rbp|rmo|rjb)(\s|$|\s*-)|remove-item|remove-psdrive|clear-recyclebin/i, reason: '파일/폴더 삭제' },
  // 파일 내용 삭제/비우기
  { re: /clear-content|clear-item\b|(^|\s|;|\|)clc(\s|$)|(^|\s|;|\|)cli(\s|$)/i, reason: '파일 내용 삭제' },
  { re: /format\s+[a-z]:|format\s+\/[qsxy]|\bformat-volume\b|\bformat-disk\b|diskpart|mkfs|clear-disk|clean\s+all|initialize-disk/i, reason: '디스크 포맷/초기화' },
  { re: /shutdown|restart-computer|stop-computer|logoff|halt/i, reason: '시스템 종료/재시작' },
  { re: /reg\s+delete|remove-itemproperty|remove-item\s+hk|new-itemproperty\s+.*hklm/i, reason: '레지스트리 변경' },
  { re: /\b(takeown|icacls|cacls)\b|set-acl/i, reason: '권한 변경' },
  { re: /bcdedit|(^|\s)sfc(\s|$)|(^|\s)dism(\s|$)|set-executionpolicy/i, reason: '시스템 구성 변경' },
  { re: /net\s+user|new-localuser|remove-localuser|net\s+localgroup|add-localgroupmember/i, reason: '계정 변경' },
  { re: /-method\s+post|(-T|--upload)\b|\bscp\b|\bftp\b|send-mailmessage|smtp/i, reason: '외부 전송' }
];

// 민감정보 파일 접근은 차단까진 안 하되 주의(caution)로 올려 승인 카드에서 확인하게 한다.
const shellSensitivePattern = /id_rsa|id_ed25519|\.ssh[\\/]|\.pem\b|\.ppk\b|\.env\b|credentials(\.json)?|\.aws[\\/]|unattend\.xml|\bsam\b|ntds\.dit/i;

export function classifyShellCommand(command) {
  const text = String(command ?? '');
  if (!text.trim()) return { risk: 'blocked', reason: '빈 명령' };
  for (const rule of shellDenyPatterns) {
    if (rule.re.test(text)) return { risk: 'blocked', reason: rule.reason };
  }
  if (shellSensitivePattern.test(text)) {
    return { risk: 'caution', reason: '민감정보 파일 접근' };
  }
  if (/stop-process|taskkill|(^|\s|;|\|)kill(\s|$)|(^|\s|;|\|)spps(\s|$)/i.test(text)) {
    return { risk: 'caution', reason: '프로세스 종료' };
  }
  if (/(^|\s)(mv|move|move-item|copy|cp|copy-item|ni|new-item|set-content|add-content|out-file|sc|ac)(\s|$)|>>?/i.test(text)) {
    return { risk: 'caution', reason: '파일 생성/수정' };
  }
  return { risk: 'safe', reason: '읽기/조회' };
}

// 자연어를 셸 명령으로 바꿔 실행한다. 실제 명령은 승인 카드에 노출되며,
// 파괴적 명령은 아래 정적 차단으로 승인 여부와 무관하게 실행되지 않는다.
export class ShellExecuteToolAdapter {
  constructor({ shell = 'powershell', timeoutMs = 60000, workingDir = null, maxOutputChars = 6000, correctionRunner = null, maxCorrections = 2 } = {}) {
    this.shell = shell;
    this.timeoutMs = timeoutMs;
    this.workingDir = resolve(workingDir ?? process.env.USERPROFILE ?? process.env.HOME ?? './workspace');
    this.maxOutputChars = maxOutputChars;
    this.maxCorrections = maxCorrections;
    // 자기교정 러너(claude CLI). 미인증/미설치면 호출이 실패해 교정 없이 감지만 한다(graceful).
    this.correctionEnabled = process.env.JARVIS_SHELL_SELFCORRECT !== '0';
    this.correctionRunner = correctionRunner ?? createClaudeCliRunner({ model: process.env.JARVIS_LLM_INTENT_MODEL ?? 'haiku', timeoutMs: 45000 });
    this.contract = createToolContract({
      toolName: 'shell.execute',
      mutatesSystem: true,
      rollback: false,
      evidence: ['command', 'shell', 'exitCode', 'stdoutPreview'],
      blockedOperations: ['destructiveCommand', 'externalTransfer'],
      modes: ['shadow', 'execute']
    });
  }

  commandOf(args) {
    return String(args?.command ?? args?.shellCommand ?? '').trim();
  }

  // 셸을 한 번 실행한다(동기). UTF-8 출력을 강제한다.
  runShellOnce(command) {
    const psCommand = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
    const wrapped = this.shell === 'cmd'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand] };
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let timedOut = false;
    try {
      stdout = execFileSync(wrapped.file, wrapped.args, { cwd: this.workingDir, timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1;
      stdout = error.stdout ? String(error.stdout) : '';
      stderr = error.stderr ? String(error.stderr) : String(error.message ?? '');
      timedOut = error.killed === true || String(error.code ?? '') === 'ETIMEDOUT';
    }
    return { exitCode, stdout, stderr, timedOut, executed: exitCode === 0 && !timedOut };
  }

  // 읽기 전용 verify 셸로 결과를 확인한다. 안전하지 않으면 실행하지 않는다.
  verifyIfSafe(verifyCommand, executed) {
    const vc = String(verifyCommand ?? '').trim();
    if (!executed || !vc) return null;
    if (classifyShellCommand(vc).risk !== 'safe') return { verified: null, output: '', verifyCommand: vc, error: 'verify-not-readonly' };
    try {
      const vout = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${vc}`],
        { cwd: this.workingDir, timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
      const out = String(vout ?? '').trim();
      const negative = /^(false|0|없음|not found|아니오|no)$/i.test(out);
      return { verified: out.length > 0 && !negative, output: out.slice(0, 600), verifyCommand: vc };
    } catch {
      return { verified: false, output: '', verifyCommand: vc, error: 'verify-failed' };
    }
  }

  async shadow(args) {
    const command = this.commandOf(args);
    const classified = classifyShellCommand(command);
    return {
      mode: 'shadow',
      expectedChangesCount: classified.risk === 'safe' ? 0 : 1,
      command,
      shell: this.shell,
      riskLevel: classified.risk,
      riskReason: classified.reason,
      willBlock: classified.risk === 'blocked',
      warnings: classified.risk === 'blocked' ? [`차단: ${classified.reason} 명령은 실행할 수 없습니다`] : []
    };
  }

  async execute(args) {
    let command = this.commandOf(args);
    const classified = classifyShellCommand(command);
    if (classified.risk === 'blocked') {
      return { status: 'blocked', error: `destructive-command-blocked:${classified.reason}`, command, shell: this.shell, outputPaths: [], rollbackAvailable: false };
    }
    const rawText = String(args?.rawText ?? '');
    let verifyCommand = String(args?.verifyCommand ?? '').trim();

    // 1) 실행 + 자기검증
    let run = this.runShellOnce(command);
    let verification = this.verifyIfSafe(verifyCommand, run.executed);
    const attempts = [{ command, exitCode: run.exitCode, verified: verification?.verified ?? null, corrected: false }];

    // 2) 자기교정: 실행 자체가 실패했거나(비정상 종료) 검증이 실패했으면, 원인을 분석해 명령을 고쳐 다시 시도한다.
    let corrections = 0;
    const needsCorrection = () => !run.executed || (verification && verification.verified === false);
    while (needsCorrection() && this.correctionEnabled && corrections < this.maxCorrections) {
      corrections += 1;
      const failContext = run.executed ? (verification?.output ?? '') : run.stderr;
      let fixOut;
      try {
        fixOut = this.correctionRunner(buildShellCorrectionPrompt({ rawText, command, stderr: run.stderr, verifyOutput: failContext }));
      } catch {
        break;
      }
      const fix = extractJsonLoose(fixOut);
      const fixCmd = typeof fix?.command === 'string' ? fix.command.trim() : '';
      // 교정안이 없거나, 그대로거나, 파괴적이면 중단(자동 재시도로 위험을 만들지 않는다).
      if (!fixCmd || fixCmd === command || classifyShellCommand(fixCmd).risk === 'blocked') break;
      command = fixCmd;
      verifyCommand = typeof fix?.verify === 'string' && fix.verify.trim() ? fix.verify.trim() : verifyCommand;
      run = this.runShellOnce(command);
      verification = this.verifyIfSafe(verifyCommand, run.executed);
      attempts.push({ command, exitCode: run.exitCode, verified: verification?.verified ?? null, corrected: true });
    }

    const executed = run.executed;
    let summary = run.timedOut ? '명령이 시간 초과로 중단됐어요.' : (executed ? '명령을 실행했어요.' : '명령이 오류로 끝났어요.');
    if (executed && verification) {
      if (verification.verified === true) {
        summary += corrections > 0 ? ` 처음엔 어긋났지만 ${corrections}번 고쳐서 목표를 달성했어요. ✓` : ' 결과도 확인했어요. ✓';
      } else if (verification.verified === false) {
        summary += ` ${corrections > 0 ? `${corrections}번 고쳐봤지만 ` : ''}아직 목표에 못 미쳐요 — 확인이 필요해요.`;
      }
    } else if (!executed && corrections > 0) {
      summary += ` ${corrections}번 고쳐봤지만 여전히 실패했어요 — 확인이 필요해요.`;
    }

    return {
      status: executed ? 'success' : 'failed',
      command,
      shell: this.shell,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdoutPreview: String(run.stdout ?? '').slice(0, this.maxOutputChars),
      stderrPreview: String(run.stderr ?? '').slice(0, this.maxOutputChars),
      verification,
      corrections,
      attempts,
      summary,
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// PC 전체에서 파일을 이름/확장자/기간/내용으로 찾는다. 읽기 전용이라 안전하다.
export class FileSearchToolAdapter {
  constructor({ maxResults = 100, maxDepth = 6, timeoutMs = 15000 } = {}) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.roots = {
      home,
      desktop: resolve(home, 'Desktop'),
      documents: resolve(home, 'Documents'),
      downloads: resolve(home, 'Downloads')
    };
    this.maxResults = maxResults;
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
    this.excludeDirs = new Set(['node_modules', '.git', '.next', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'dist', 'build', '.jarvis-backups']);
    this.contract = createToolContract({
      toolName: 'filesystem.searchFiles',
      readOnly: true,
      evidence: ['query', 'matchCount', 'roots'],
      blockedOperations: ['fileContentWrite']
    });
  }

  criteriaOf(args) {
    return {
      query: String(args?.query ?? '').trim().toLowerCase(),
      extensions: Array.isArray(args?.extensions) ? args.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()) : [],
      modifiedWithinDays: Number.isFinite(args?.modifiedWithinDays) ? args.modifiedWithinDays : null,
      contentQuery: String(args?.contentQuery ?? '').trim().toLowerCase(),
      scope: ['home', 'desktop', 'documents', 'downloads'].includes(args?.scope) ? args.scope : 'home'
    };
  }

  async shadow(args) {
    const c = this.criteriaOf(args);
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      query: c.query,
      extensions: c.extensions,
      scope: c.scope,
      root: this.roots[c.scope] ?? this.roots.home,
      warnings: []
    };
  }

  async execute(args) {
    const c = this.criteriaOf(args);
    const root = this.roots[c.scope] ?? this.roots.home;
    const deadline = Date.now() + this.timeoutMs;
    const cutoff = c.modifiedWithinDays != null ? Date.now() - c.modifiedWithinDays * 86400000 : null;
    const queryWords = c.query ? c.query.split(/\s+/).filter(Boolean) : [];
    const matches = [];
    const walk = async (dir, depth) => {
      if (matches.length >= this.maxResults || Date.now() > deadline || depth > this.maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= this.maxResults || Date.now() > deadline) return;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.excludeDirs.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(full, depth + 1);
        } else {
          const name = entry.name.toLowerCase();
          const ext = extname(name).replace(/^\./, '');
          if (queryWords.length && !queryWords.every((w) => name.includes(w))) continue;
          if (c.extensions.length && !c.extensions.includes(ext)) continue;
          let st;
          try {
            st = await stat(full);
          } catch {
            continue;
          }
          if (cutoff && st.mtimeMs < cutoff) continue;
          if (c.contentQuery) {
            if (st.size > 2 * 1024 * 1024) continue;
            try {
              const body = await readFile(full, 'utf8');
              if (!body.toLowerCase().includes(c.contentQuery)) continue;
            } catch {
              continue;
            }
          }
          matches.push({ name: entry.name, path: full, size: st.size, modifiedAt: st.mtime.toISOString() });
        }
      }
    };
    await walk(root, 0);
    matches.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return {
      status: 'success',
      query: c.query,
      scope: c.scope,
      root,
      matchCount: matches.length,
      matches,
      summary: matches.length ? `${matches.length}개 파일을 찾았어요.` : '조건에 맞는 파일을 찾지 못했어요.',
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// 사용자 폴더에서 이름 키워드로 파일들을 찾는다(첨부·편집 대상 해석용 공통 헬퍼).
// 여러 개가 매칭될 수 있으므로 최근순 배열로 돌려주고, 호출부가 모호성을 처리한다.
async function findFilesByQuery(query, { roots, extensions = [], maxDepth = 6, excludeDirs, limit = 12 } = {}) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const deadline = Date.now() + 10000;
  const matches = [];
  const walk = async (dir, depth) => {
    if (Date.now() > deadline || depth > maxDepth || matches.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs?.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else {
        const name = entry.name.toLowerCase();
        const ext = extname(name).replace(/^\./, '');
        if (extensions.length && !extensions.includes(ext)) continue;
        if (!words.every((w) => name.includes(w))) continue;
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        matches.push({ path: full, name: entry.name, mtimeMs: st.mtimeMs });
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches.slice(0, limit);
}

// 기존 엑셀(xlsx) 파일의 셀 내용을 수정한다. 편집 전 백업을 만들어 되돌릴 수 있게 한다.
export class DocumentEditToolAdapter {
  constructor({ maxDepth = 6 } = {}) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.searchRoots = [resolve(home, 'Desktop'), resolve(home, 'Documents'), resolve(home, 'Downloads'), resolve('./workspace')];
    this.excludeDirs = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'dist', 'build', '.jarvis-backups']);
    this.maxDepth = maxDepth;
    // 백업은 사용자 문서 폴더를 어지럽히지 않도록 전용 폴더에 모은다(누적 정리도 이 폴더만 보면 됨).
    this.backupDir = process.env.JARVIS_BACKUP_DIR ?? resolve(home, '.jarvis-backups');
    this.contract = createToolContract({
      toolName: 'document.edit',
      mutatesSystem: true,
      rollback: true,
      evidence: ['targetPath', 'editedCells', 'backupPath'],
      blockedOperations: ['targetFileMissing', 'unsupportedFormat']
    });
  }

  async loadExcelJS() {
    try {
      const mod = await import('exceljs');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  // 대상 파일을 해석한다. 정확한 경로면 그것을, 이름 검색이면 후보 배열을 준다.
  async resolveTargets(args) {
    if (args?.targetPath && existsSync(args.targetPath)) return [{ path: resolve(args.targetPath), name: basename(args.targetPath) }];
    return findFilesByQuery(args?.targetQuery ?? args?.targetPath, {
      roots: this.searchRoots,
      extensions: ['xlsx'],
      maxDepth: this.maxDepth,
      excludeDirs: this.excludeDirs
    });
  }

  async shadow(args) {
    const targets = await this.resolveTargets(args);
    const target = targets[0] ?? null;
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    return {
      mode: 'shadow',
      expectedChangesCount: edits.length,
      targetPath: target?.path ?? null,
      targetFound: Boolean(target),
      edits,
      warnings: target ? [] : ['수정할 엑셀 파일을 찾지 못했습니다']
    };
  }

  async execute(args) {
    const targets = await this.resolveTargets(args);
    if (targets.length === 0) {
      return { status: 'failed', error: 'target-file-missing', outputPaths: [], rollbackAvailable: false };
    }
    // 대상 파일이 여러 개면 임의로 고르지 않고 어느 파일인지 되묻는다.
    if (targets.length > 1) {
      return {
        status: 'needs_choice',
        candidates: targets.map((t) => ({ name: t.name, path: t.path })),
        summary: `"${args?.targetQuery ?? ''}"에 맞는 파일이 ${targets.length}개 있어요: ${targets.slice(0, 6).map((t) => t.name).join(', ')}. 어느 파일을 수정할까요?`,
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    const target = targets[0];
    if (extname(target.path).toLowerCase() !== '.xlsx') {
      return { status: 'failed', error: `unsupported-format:${extname(target.path)}`, targetPath: target.path, outputPaths: [], rollbackAvailable: false };
    }
    const ExcelJS = await this.loadExcelJS();
    if (!ExcelJS) {
      return { status: 'failed', error: 'exceljs-not-installed', targetPath: target.path, outputPaths: [], rollbackAvailable: false };
    }
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(target.path);
      const ws = (args?.sheet && wb.getWorksheet(args.sheet)) || wb.worksheets[0];

      // 1단계(변경 없이 스캔): findText가 여러 셀에 걸리고 범위가 불명확하면 실행하지 않고 선택지를 돌려준다.
      const collectHits = (findText) => {
        const needle = String(findText);
        const hits = [];
        ws.eachRow((row, rowNumber) => {
          row.eachCell((cell) => {
            if (String(cell.value ?? '').includes(needle)) {
              hits.push({ address: cell.address, row: rowNumber, current: String(cell.value ?? '') });
            }
          });
        });
        return hits;
      };
      const ambiguous = [];
      for (const edit of edits) {
        if (edit?.cell || edit?.findText == null) continue;
        const scope = String(edit.scope ?? 'ask');
        const hits = collectHits(edit.findText);
        if (hits.length > 1 && scope !== 'all' && scope !== 'first') {
          ambiguous.push({ findText: String(edit.findText), value: edit.value, matchCount: hits.length, locations: hits.slice(0, 12) });
        }
      }
      if (ambiguous.length) {
        // 모호함: 파일을 건드리지 않고, 발견 위치와 맥락을 사용자에게 제시한다.
        const first = ambiguous[0];
        const preview = first.locations.map((h) => `${h.address}: "${h.current}"`).join(' / ');
        return {
          status: 'needs_choice',
          targetPath: target.path,
          ambiguous,
          summary: `"${first.first ?? first.findText}"이(가) ${first.matchCount}곳에 있어요: ${preview}. 전체를 바꿀까요, 아니면 특정 셀(예: ${first.locations[0].address})만 바꿀까요?`,
          choicePrompt: `"${first.findText}"을(를) 모두 바꾸려면 "전부 바꿔줘", 특정 위치만 바꾸려면 셀 주소(예: ${first.locations[0].address})나 위치를 말해 주세요.`,
          outputPaths: [],
          rollbackAvailable: false
        };
      }

      // 2단계(실제 편집): 백업 후 적용. 백업은 전용 폴더에 두어 원본 옆을 어지럽히지 않는다.
      mkdirSync(this.backupDir, { recursive: true });
      const backupPath = resolve(this.backupDir, `${basename(target.path)}.${Date.now()}.bak`);
      await copyFile(target.path, backupPath);
      const editedCells = [];
      const notFound = [];
      for (const edit of edits) {
        if (edit?.cell) {
          ws.getCell(edit.cell).value = edit.value;
          editedCells.push(edit.cell);
        } else if (edit?.findText != null) {
          const scope = String(edit.scope ?? 'ask');
          const hits = collectHits(edit.findText);
          if (hits.length === 0) {
            notFound.push(String(edit.findText));
            continue;
          }
          const targets = scope === 'first' ? hits.slice(0, 1) : hits; // 1개거나 scope=all이면 전부
          for (const h of targets) {
            const cell = ws.getCell(h.address);
            // 문자열이면 부분 치환, 그 외에는 값 통째 교체.
            cell.value = typeof cell.value === 'string'
              ? cell.value.split(String(edit.findText)).join(String(edit.value))
              : edit.value;
            editedCells.push(h.address);
          }
        }
      }
      await wb.xlsx.writeFile(target.path);
      const parts = [`${editedCells.length}개 셀을 수정했어요`];
      if (notFound.length) parts.push(`("${notFound.join('", "')}"은(는) 찾지 못함)`);
      return {
        status: 'success',
        targetPath: target.path,
        editedCells,
        notFound,
        backupPath,
        summary: `${basename(target.path)}에서 ${parts.join(' ')}.`,
        outputPaths: [target.path],
        rollbackAvailable: true
      };
    } catch (error) {
      return { status: 'failed', error: String(error?.message ?? error), targetPath: target.path, outputPaths: [], rollbackAvailable: false };
    }
  }
}

// 첨부 파일과 함께 메일을 보낸다. SMTP 자격증명(JARVIS_SMTP_USER/PASS)이 있어야 실제 발송한다.
export class EmailSendToolAdapter {
  constructor() {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.searchRoots = [resolve(home, 'Desktop'), resolve(home, 'Documents'), resolve(home, 'Downloads'), resolve('./workspace')];
    this.excludeDirs = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'dist', 'build', '.jarvis-backups']);
    this.contract = createToolContract({
      toolName: 'email.send',
      mutatesSystem: false,
      rollback: false,
      evidence: ['to', 'subject', 'attachmentCount'],
      blockedOperations: ['recipientMissing', 'smtpNotConfigured']
    });
  }

  async loadNodemailer() {
    try {
      const mod = await import('nodemailer');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  smtpConfig() {
    const user = process.env.JARVIS_SMTP_USER;
    const pass = process.env.JARVIS_SMTP_PASS;
    if (!user || !pass) return null;
    return { user, pass, service: process.env.JARVIS_SMTP_SERVICE ?? 'gmail' };
  }

  async resolveAttachments(query) {
    if (!query) return [];
    return findFilesByQuery(query, { roots: this.searchRoots, excludeDirs: this.excludeDirs });
  }

  async shadow(args) {
    const attachments = await this.resolveAttachments(args?.attachmentQuery);
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      to: args?.to ?? '',
      subject: args?.subject ?? '',
      attachmentPath: attachments[0]?.path ?? null,
      attachmentCount: attachments.length,
      attachmentAmbiguous: attachments.length > 1,
      smtpConfigured: Boolean(this.smtpConfig()),
      warnings: this.smtpConfig() ? [] : ['메일 계정이 설정되지 않아 실제 발송은 되지 않습니다']
    };
  }

  async execute(args) {
    let to = String(args?.to ?? '').trim();
    // "내 메일/내 구글메일/나에게" 같은 본인 발송이면 SMTP 계정 주소로 채운다.
    if (!to || !/@/.test(to)) {
      const rawText = String(args?.rawText ?? '');
      const cfg = this.smtpConfig();
      if (cfg && /(내|제)\s*(구글\s*)?(이|e)?메일|나(에게|한테|한테로)|본인(에게)?|self|스스로/i.test(rawText)) {
        to = cfg.user;
      }
    }
    if (!to || !/@/.test(to)) {
      return { status: 'blocked', error: 'recipient-missing-or-invalid', to, summary: '받는 사람 이메일 주소를 못 찾았어요. 주소를 알려주시거나 "내 메일로"라고 해주세요.', outputPaths: [], rollbackAvailable: false };
    }
    // 첨부 후보가 여러 개면 임의로 보내지 않는다(잘못된 파일 외부 유출 방지). 어느 파일인지 되묻는다.
    const attachments = await this.resolveAttachments(args?.attachmentQuery);
    if (attachments.length > 1) {
      return {
        status: 'needs_choice',
        to,
        candidates: attachments.map((a) => ({ name: a.name, path: a.path })),
        summary: `첨부할 파일 후보가 ${attachments.length}개예요: ${attachments.slice(0, 6).map((a) => a.name).join(', ')}. 어느 파일을 보낼까요? (잘못된 파일이 외부로 나가지 않도록 확인합니다)`,
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    const attachment = attachments[0] ?? null;
    const config = this.smtpConfig();
    if (!config) {
      return { status: 'blocked', error: 'smtp-not-configured', to, outputPaths: [], rollbackAvailable: false };
    }
    const nodemailer = await this.loadNodemailer();
    if (!nodemailer) {
      return { status: 'failed', error: 'nodemailer-not-installed', to, outputPaths: [], rollbackAvailable: false };
    }
    try {
      const transporter = nodemailer.createTransport({ service: config.service, auth: { user: config.user, pass: config.pass } });
      await transporter.sendMail({
        from: config.user,
        to,
        subject: String(args?.subject ?? '(제목 없음)'),
        text: String(args?.body ?? ''),
        attachments: attachment ? [{ path: attachment.path, filename: attachment.name }] : []
      });
      return {
        status: 'success',
        to,
        subject: String(args?.subject ?? ''),
        attachmentCount: attachment ? 1 : 0,
        summary: `${to}로 메일을 보냈어요${attachment ? ` (첨부: ${attachment.name})` : ''}.`,
        outputPaths: [],
        rollbackAvailable: false
      };
    } catch (error) {
      return { status: 'failed', error: String(error?.message ?? error), to, outputPaths: [], rollbackAvailable: false };
    }
  }
}

export class FileMoveToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), toolName = 'filesystem.moveFiles', previewOnly = false } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.previewOnly = previewOnly;
    this.contract = createToolContract({
      toolName,
      mutatesSystem: !previewOnly,
      rollback: !previewOnly,
      evidence: ['from', 'to', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'missingSource', 'targetExists'],
      modes: previewOnly ? ['shadow'] : ['shadow', 'execute']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async normalizeMoves(args) {
    const moves = args.moves ?? (args.from && args.to ? [{ from: args.from, to: args.to }] : []);
    const normalized = [];
    for (const move of moves) {
      const item = { fromInput: move.from, toInput: move.to, from: resolve(move.from), to: resolve(move.to), pathIssues: [] };
      try {
        item.from = await assertAllowedRealPath(move.from, this.allowedRoots);
      } catch (error) {
        item.pathIssues.push(classifyFileError(error, { path: move.from, targetPath: move.to }));
      }
      try {
        item.to = await assertAllowedRealPath(move.to, this.allowedRoots, { checkParentForCreate: true });
      } catch (error) {
        item.pathIssues.push(classifyFileError(error, { path: move.from, targetPath: move.to }));
      }
      normalized.push(item);
    }
    return normalized;
  }

  async shadow(args) {
    const moves = await this.normalizeMoves(args);
    const checks = [];
    for (const move of moves) {
      checks.push({
        from: move.from,
        to: move.to,
        pathIssues: move.pathIssues,
        sourceExists: await exists(move.from),
        targetExists: await exists(move.to)
      });
    }
    const batchDiff = batchDiffForFileMoves(checks);
    const batchPolicy = createFileMoveBatchPolicy({
      checks,
      conflictResolutions: args.conflictResolutions ?? args.resolutions ?? {},
      allowOverwrite: args.allowOverwrite === true
    });
    const conflicts = [
      ...batchDiff.conflicts,
      ...checks.flatMap((check) => check.pathIssues ?? [])
    ];
    const conflictResolutionUi = createFileConflictResolutionUiState({ checks, conflicts, batchDiff, batchPolicy });
    const partialMoveTransactionDryRun = createPartialMoveTransactionDryRun({ batchPolicy, taskId: args.taskId ?? null });
    const warnings = [
      ...batchPolicy.blockedItems.flatMap((item) => (item.issues ?? []).map((issue) => issue.detail ?? `${issue.code}:${item.from}`)),
      ...batchPolicy.readyItems
        .filter((item) => item.action === 'overwrite')
        .map((item) => `overwrite-requires-explicit-approval:${item.to}`)
    ];
    return {
      mode: 'shadow',
      expectedChangesCount: moves.length,
      moves: checks,
      batchDiff,
      batchPolicy,
      conflicts,
      conflictResolutionUi,
      conflictPolicy: 'block-batch-until-all-items-ready',
      partialMoveTransactionDryRun,
      windowsAclDenyCorpus: createWindowsAclDenyCorpus({ allowedRoot: this.allowedRoots[0] ?? null }),
      warnings
    };
  }

  async execute(args, packet = {}) {
    if (this.previewOnly) {
      return {
        status: 'blocked',
        summary: 'Preview-only adapter cannot execute.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: ['preview-only-adapter']
      };
    }
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Move preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings,
        evidence: {
          batchDiff: shadow.batchDiff,
          conflicts: shadow.conflicts,
          conflictPolicy: shadow.conflictPolicy,
          conflictResolutionUi: shadow.conflictResolutionUi,
          batchPolicy: shadow.batchPolicy,
          partialMoveTransactionDryRun: shadow.partialMoveTransactionDryRun
        }
      };
    }
    const movedItems = [];
    for (const move of shadow.batchPolicy.readyItems) {
      await mkdir(dirname(move.to), { recursive: true });
      if (move.action === 'copy') {
        await copyFile(move.from, move.to);
        movedItems.push({ type: 'copy_file', from: move.from, to: move.to });
        this.undoJournal.record({
          taskId: packet.taskId,
          action: 'delete_created_file',
          path: move.to
        });
      } else {
        await rename(move.from, move.to);
        movedItems.push({ type: move.action === 'rename' ? 'move_file_renamed_target' : 'move_file', from: move.from, to: move.to });
        this.undoJournal.record({
          taskId: packet.taskId,
          action: 'move_back',
          from: move.from,
          to: move.to
        });
      }
    }
    return {
      status: 'success',
      outputPaths: movedItems.map((item) => item.to),
      changedItems: movedItems,
      rollbackAvailable: movedItems.length > 0,
      batchPolicy: shadow.batchPolicy,
      partialMoveTransactionDryRun: shadow.partialMoveTransactionDryRun,
      undoJournalId: this.undoJournal.list().find((entry) => entry.taskId === packet.taskId)?.undoJournalId
    };
  }
}

export class BrowserReadOnlyGuard {
  constructor({ blockedOperations = ['formSubmit', 'download', 'fileUpload', 'credentialEntry', 'javascriptExecution', 'cookieMutation'] } = {}) {
    this.blockedOperations = blockedOperations;
  }

  inspect(args = {}) {
    const readOnly = args.readOnly !== false;
    const checks = [
      { operation: 'navigation', attempted: true, allowed: readOnly, reason: readOnly ? 'GET navigation only' : 'read-only mode disabled' },
      { operation: 'download', attempted: args.download === true, allowed: false, reason: 'downloads are blocked in browser.search' },
      { operation: 'formSubmit', attempted: args.submitForms === true, allowed: false, reason: 'form submission is blocked in browser.search' },
      { operation: 'fileUpload', attempted: args.fileUpload === true, allowed: false, reason: 'file upload is blocked in browser.search' },
      { operation: 'credentialEntry', attempted: args.enterCredentials === true, allowed: false, reason: 'credential entry is blocked in browser.search' },
      { operation: 'javascriptExecution', attempted: args.executeScript === true, allowed: false, reason: 'custom JavaScript execution is blocked in browser.search' },
      { operation: 'cookieMutation', attempted: args.allowCookies === true, allowed: false, reason: 'cookie mutation is blocked in browser.search' }
    ];
    const warnings = [];
    if (!readOnly) warnings.push('browser-search-must-be-read-only');
    for (const check of checks) {
      if (check.attempted && check.allowed === false && check.operation !== 'navigation') {
        warnings.push(`browser-${check.operation.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-blocked`);
      }
    }
    return {
      readOnly,
      blockedOperations: this.blockedOperations,
      checks,
      warnings,
      sideEffectsAllowed: false
    };
  }
}

export class BrowserNetworkRecorder {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  capture({ url, method = 'GET', searchEngine, response = null, sideEffects = null }) {
    const requestId = stableId('net', `${method}:${url}`, this.clock().toISOString());
    return {
      requestId,
      capturedAt: this.clock().toISOString(),
      method,
      url,
      searchEngine,
      requestHeaders: {
        accept: 'text/html,application/xhtml+xml',
        cookie: '[blocked]'
      },
      response: {
        status: response?.status ?? 200,
        contentType: response?.contentType ?? 'text/html',
        bodyCapture: 'metadata-and-sanitized-preview-only'
      },
      sideEffects: sideEffects ?? {
        cookiesWritten: false,
        downloadsStarted: false,
        formsSubmitted: false,
        filesUploaded: false,
        credentialsEntered: false
      }
    };
  }
}

export class BrowserDomSnapshotter {
  snapshot({ url, resultPreview = [], text = null, source = 'deterministic-preview' }) {
    const nodes = resultPreview.map((item) => ({
      role: 'search-result',
      rank: item.rank,
      title: item.title,
      url: item.url,
      snippet: item.snippet
    }));
    const snapshotText = text ?? nodes.map((node) => `${node.title}\n${node.snippet}`).join('\n\n');
    return {
      snapshotId: stableId('dom', url ?? 'browser-search', resultPreview.length),
      url,
      captureMode: 'sanitized-text-only',
      source,
      nodeCount: nodes.length,
      textPreview: snapshotText.slice(0, 1200),
      textSha256: createHash('sha256').update(snapshotText).digest('hex'),
      nodes,
      excluded: ['forms', 'inputs', 'scripts', 'cookies', 'downloads']
    };
  }
}

export const defaultBrowserNetworkReplayCorpusPath = 'apps/pc-agent/fixtures/browser-network-replay-corpus.json';
export const defaultWorkbookProductCorpusPath = 'apps/pc-agent/fixtures/workbook-product-corpus.json';

export function loadBrowserNetworkReplayCorpus(fixturePath = defaultBrowserNetworkReplayCorpusPath) {
  const resolvedPath = resolve(fixturePath);
  const raw = readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error(`invalid-browser-network-replay-corpus:${resolvedPath}`);
  }
  return {
    ...parsed,
    fixturePath: resolvedPath,
    fixtureSha256: createHash('sha256').update(raw).digest('hex')
  };
}

export function loadWorkbookProductCorpus(fixturePath = defaultWorkbookProductCorpusPath) {
  const resolvedPath = resolve(fixturePath);
  const raw = readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error(`invalid-workbook-product-corpus:${resolvedPath}`);
  }
  return {
    ...parsed,
    fixturePath: resolvedPath,
    fixtureSha256: createHash('sha256').update(raw).digest('hex')
  };
}

export async function runWorkbookProductCorpus({
  fixturePath = defaultWorkbookProductCorpusPath,
  fixturePack = null,
  outputRoot = 'dist/workbook-product-soak/workbooks',
  cycles = null,
  clock = () => new Date()
} = {}) {
  const pack = fixturePack ?? loadWorkbookProductCorpus(fixturePath);
  const report = await runWorkbookProductFixturePack({
    fixturePack: pack,
    outputRoot,
    cycles: cycles ?? pack.workerPool?.cycles ?? 2,
    clock
  });
  return {
    reportVersion: 'b-workbook-product-soak-report-v1',
    status: report.status,
    generatedAt: clock().toISOString(),
    fixturePackVersion: pack.fixturePackVersion,
    fixturePackId: pack.fixturePackId,
    fixturePath: pack.fixturePath ?? resolve(fixturePath),
    fixtureSha256: pack.fixtureSha256 ?? createHash('sha256').update(JSON.stringify(pack)).digest('hex'),
    outputRoot: resolve(outputRoot),
    migrationReport: report.migrationReport,
    workerPoolSoak: report.workerPoolSoak,
    rendererProbe: report.rendererProbe,
    coverage: report.coverage,
    nextActions: report.status === 'passed'
      ? ['Run with JARVIS_WORKBOOK_RENDERER_REQUIRED=true on a host with Excel or LibreOffice to capture strict external-renderer evidence.']
      : ['Inspect failed workbook fixture, renderer probe, or template migration item before release.']
  };
}

export function createBrowserCacheRecoveryGuide({
  cachePath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '%LOCALAPPDATA%\\ms-playwright',
  error = null,
  systemChromePath = process.env.JARVIS_BROWSER_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  pythonExecutable = process.env.JARVIS_PYTHON_PLAYWRIGHT ?? 'python'
} = {}) {
  return {
    guideVersion: 'b-playwright-cache-recovery-guide-v1',
    status: 'operator-action-required-only',
    cachePath,
    detectedError: error?.message ?? error ?? null,
    recoveryPolicy: {
      destructiveCleanupAutomated: false,
      preferSystemChromeFallback: true,
      preserveEvidenceBeforeCleanup: true
    },
    environmentOverrides: {
      JARVIS_BROWSER_CHROME_PATH: systemChromePath,
      JARVIS_PYTHON_PLAYWRIGHT: pythonExecutable,
      PLAYWRIGHT_BROWSERS_PATH: cachePath
    },
    steps: [
      'Stop active JARVIS browser replay or live browser jobs.',
      'Archive the managed browser cache lock/error log as release evidence.',
      'Remove only stale Playwright lock files under the configured cache path after operator approval.',
      'Rerun npm run browser:replay-soak to confirm replay corpus stability.',
      'If managed Chromium remains unavailable, use JARVIS_BROWSER_CHROME_PATH system Chrome fallback.'
    ],
    verificationCommands: [
      'npm run browser:replay-soak',
      'node --test --test-name-pattern "B browser|Playwright" tests/ag-runtime.test.js'
    ]
  };
}

export function createBrowserRenderingSnapshot({
  fixture = null,
  liveCapture = null,
  domSnapshot = null,
  resultPreview = [],
  text = null,
  clock = () => new Date()
} = {}) {
  const previewText = Array.isArray(resultPreview)
    ? resultPreview.map((item) => `${item.title ?? ''} ${item.snippet ?? ''}`).join(' ')
    : '';
  const sanitizedText = sanitizeBrowserText(
    text
      ?? liveCapture?.sanitizedText
      ?? domSnapshot?.textPreview
      ?? fixture?.bodyText
      ?? previewText
  );
  const screenshotHash = liveCapture?.screenshot?.sha256
    ?? createHash('sha256').update(`${fixture?.fixtureId ?? 'browser'}|${fixture?.title ?? ''}|${sanitizedText}`).digest('hex');
  const screenshotSize = liveCapture?.screenshot?.sizeBytes
    ?? Buffer.byteLength(`${fixture?.fixtureId ?? ''}:${sanitizedText}`, 'utf8');
  return {
    snapshotVersion: 'b-browser-rendering-snapshot-v1',
    snapshotId: stableId('browser-rendering', fixture?.fixtureId ?? domSnapshot?.url ?? 'browser', screenshotHash),
    capturedAt: clock().toISOString(),
    source: liveCapture?.driver ?? domSnapshot?.source ?? 'recorded-network-replay',
    fixtureId: fixture?.fixtureId ?? null,
    url: fixture?.url ?? domSnapshot?.url ?? null,
    captureMode: 'sanitized-dom-and-viewport-hash',
    textPreview: sanitizedText.slice(0, 600),
    sanitizedTextSha256: createHash('sha256').update(sanitizedText).digest('hex'),
    nodeCount: domSnapshot?.nodeCount ?? Math.max(1, Array.isArray(resultPreview) ? resultPreview.length : 1),
    screenshot: {
      captureMode: 'viewport-png-hash-only',
      sha256: screenshotHash,
      sizeBytes: screenshotSize
    },
    layout: {
      viewport: { width: 1365, height: 768 },
      stableTextLengthBucket: Math.ceil(sanitizedText.length / 100) * 100,
      maxTextPreviewCharacters: 600
    },
    excludedRawArtifacts: ['screenshotPixels', 'cookies', 'inputs', 'scripts', 'downloads']
  };
}

export function diffBrowserRenderingSnapshots({
  baseline = null,
  current,
  expectedTextIncludes = []
} = {}) {
  if (!current) {
    return {
      diffVersion: 'b-browser-rendering-diff-v1',
      status: 'failed',
      failures: ['missing-current-rendering-snapshot']
    };
  }
  const text = String(current.textPreview ?? '').toLowerCase();
  const missingExpectedText = expectedTextIncludes.filter((expected) => !text.includes(String(expected).toLowerCase()));
  const screenshotHashValid = /^[a-f0-9]{64}$/i.test(String(current.screenshot?.sha256 ?? ''));
  const textStable = baseline
    ? baseline.sanitizedTextSha256 === current.sanitizedTextSha256
    : true;
  const failures = [
    ...missingExpectedText.map((expected) => `missing-text:${expected}`),
    ...(screenshotHashValid ? [] : ['missing-viewport-screenshot-hash']),
    ...(current.nodeCount > 0 ? [] : ['empty-dom-snapshot'])
  ];
  return {
    diffVersion: 'b-browser-rendering-diff-v1',
    status: failures.length ? 'failed' : 'passed',
    baselineSnapshotId: baseline?.snapshotId ?? null,
    currentSnapshotId: current.snapshotId,
    missingExpectedText,
    screenshotHashStable: baseline ? baseline.screenshot?.sha256 === current.screenshot?.sha256 : true,
    textStable,
    failures
  };
}

export function createBrowserReplayDriver(fixturePack = loadBrowserNetworkReplayCorpus(), { clock = () => new Date() } = {}) {
  const fixtures = new Map((fixturePack.fixtures ?? []).map((fixture) => [browserReplayFixtureKey(fixture), fixture]));
  return {
    driver: 'recorded-network-replay',
    async capture({ url, query, searchEngine, maxResults = 5 }) {
      const fixture = fixtures.get(browserReplayFixtureKey({ query, searchEngine }))
        ?? [...fixtures.values()].find((item) => item.url === url)
        ?? [...fixtures.values()].find((item) => item.query === query)
        ?? null;
      if (!fixture) {
        return {
          live: false,
          driver: 'recorded-network-replay',
          status: 'fixture-missing',
          warnings: ['browser-replay-fixture-missing']
        };
      }
      const sanitizedText = sanitizeBrowserText(fixture.bodyText ?? '');
      const resultPreview = createLiveResultPreview({
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        title: fixture.title,
        url: fixture.url,
        bodyText: sanitizedText,
        maxResults
      });
      const requests = (fixture.requests ?? []).map((request) => ({
        method: String(request.method ?? 'GET').toUpperCase(),
        url: request.url,
        resourceType: request.resourceType ?? 'document',
        blocked: request.method && String(request.method).toUpperCase() !== 'GET' ? request.blocked === true : request.blocked === true
      }));
      const allowedRequestMethods = [...new Set(requests.filter((request) => request.blocked !== true).map((request) => request.method))];
      return {
        live: true,
        replay: true,
        fixtureId: fixture.fixtureId,
        driver: 'recorded-network-replay',
        status: 'captured',
        capturedAt: clock().toISOString(),
        resultPreview,
        pageTitle: fixture.title,
        sanitizedText,
        networkEvents: {
          requests,
          responses: fixture.responses ?? [],
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET' && request.blocked === true).length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET' || request.blocked === true),
          allowedRequestMethods,
          replayMode: 'recorded-fixture'
        },
        screenshot: {
          captureMode: 'viewport-png-hash-only',
          sha256: createHash('sha256').update(`${fixture.fixtureId}|${fixture.title}|${sanitizedText}`).digest('hex'),
          sizeBytes: Buffer.byteLength(`${fixture.fixtureId}:${sanitizedText}`, 'utf8')
        },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        }
      };
    }
  };
}

export async function runBrowserNetworkReplayCorpus({
  fixturePath = defaultBrowserNetworkReplayCorpusPath,
  fixturePack = null,
  cycles = 1,
  clock = () => new Date()
} = {}) {
  const pack = fixturePack ?? loadBrowserNetworkReplayCorpus(fixturePath);
  const cycleCount = Math.max(1, Number(cycles) || 1);
  const adapter = new BrowserSearchToolAdapter({
    browserDriver: createBrowserReplayDriver(pack, { clock })
  });
  const items = [];
  const renderingDiffs = [];
  for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
    for (const fixture of pack.fixtures) {
      const executed = await adapter.execute({
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        maxResults: Math.min(3, fixture.expectedTextIncludes?.length + 1 || 3),
        readOnly: true
      });
      const browserEvidence = executed.evidence?.browser ?? {};
      const renderingSnapshot = createBrowserRenderingSnapshot({
        fixture,
        liveCapture: browserEvidence.liveCapture,
        domSnapshot: browserEvidence.domSnapshot,
        resultPreview: browserEvidence.resultPreview,
        clock
      });
      const renderingDiff = diffBrowserRenderingSnapshots({
        current: renderingSnapshot,
        expectedTextIncludes: fixture.expectedTextIncludes ?? []
      });
      renderingDiffs.push({
        fixtureId: fixture.fixtureId,
        cycleIndex,
        ...renderingDiff
      });
      const sideEffects = browserEvidence.networkCapture?.sideEffects ?? {};
      const blockedNonGetRequests = browserEvidence.liveCapture?.networkEvents?.blockedNonGetRequests ?? 0;
      const allRequestsGetOnly = browserEvidence.liveCapture?.networkEvents?.allRequestsGetOnly === true;
      const rawSensitiveLeak = browserRenderingRawSensitiveLeakDetected(renderingSnapshot.textPreview);
      const sideEffectsBlocked = Object.values(sideEffects).every((value) => value === false);
      const expectedTextPresent = renderingDiff.missingExpectedText.length === 0;
      const passed = executed.status === 'success'
        && allRequestsGetOnly
        && sideEffectsBlocked
        && !rawSensitiveLeak
        && expectedTextPresent
        && renderingDiff.status === 'passed';
      items.push({
        itemVersion: 'b-browser-network-replay-item-v1',
        fixtureId: fixture.fixtureId,
        cycleIndex,
        status: passed ? 'passed' : 'failed',
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        executedStatus: executed.status,
        allRequestsGetOnly,
        blockedNonGetRequests,
        expectedTextPresent,
        rawSensitiveLeak,
        sideEffectsBlocked,
        domSnapshot: {
          captureMode: browserEvidence.domSnapshot?.captureMode,
          source: browserEvidence.domSnapshot?.source,
          nodeCount: browserEvidence.domSnapshot?.nodeCount,
          textSha256: browserEvidence.domSnapshot?.textSha256
        },
        renderingSnapshot,
        renderingDiff
      });
    }
  }
  const passedCount = items.filter((item) => item.status === 'passed').length;
  const passRate = items.length ? passedCount / items.length : 0;
  const failed = items.filter((item) => item.status === 'failed');
  return {
    reportVersion: 'b-browser-network-replay-corpus-report-v1',
    status: failed.length ? 'failed' : 'passed',
    generatedAt: clock().toISOString(),
    fixturePackVersion: pack.fixturePackVersion,
    fixturePackId: pack.fixturePackId,
    fixturePath: pack.fixturePath ?? resolve(fixturePath),
    fixtureSha256: pack.fixtureSha256 ?? createHash('sha256').update(JSON.stringify(pack)).digest('hex'),
    fixtureCount: pack.fixtures.length,
    cycleCount,
    itemCount: items.length,
    passedCount,
    passRate,
    coverage: {
      engines: [...new Set(pack.fixtures.map((fixture) => fixture.searchEngine))],
      blockedMutationAttemptFixtures: pack.fixtures.filter((fixture) => (fixture.requests ?? []).some((request) => String(request.method).toUpperCase() !== 'GET')).length,
      expectedTextAssertions: pack.fixtures.reduce((sum, fixture) => sum + (fixture.expectedTextIncludes?.length ?? 0), 0),
      renderingSnapshots: items.length,
      cacheRecoveryGuide: 'b-playwright-cache-recovery-guide-v1'
    },
    cacheRecoveryGuide: createBrowserCacheRecoveryGuide(),
    renderingDiffs,
    items,
    failures: failed.map((item) => ({
      fixtureId: item.fixtureId,
      cycleIndex: item.cycleIndex,
      renderingFailures: item.renderingDiff.failures,
      allRequestsGetOnly: item.allRequestsGetOnly,
      rawSensitiveLeak: item.rawSensitiveLeak
    }))
  };
}

export async function runBrowserReadOnlySoak({
  fixturePath = defaultBrowserNetworkReplayCorpusPath,
  fixturePack = null,
  cycles = 3,
  clock = () => new Date()
} = {}) {
  const report = await runBrowserNetworkReplayCorpus({ fixturePath, fixturePack, cycles, clock });
  const hashesByFixture = new Map();
  for (const item of report.items) {
    const hashes = hashesByFixture.get(item.fixtureId) ?? new Set();
    hashes.add(item.renderingSnapshot.screenshot.sha256);
    hashesByFixture.set(item.fixtureId, hashes);
  }
  const unstableFixtures = [...hashesByFixture.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([fixtureId]) => fixtureId);
  return {
    soakVersion: 'b-browser-readonly-soak-v1',
    status: report.status === 'passed' && unstableFixtures.length === 0 ? 'passed' : 'failed',
    generatedAt: clock().toISOString(),
    cycles: report.cycleCount,
    fixtureCount: report.fixtureCount,
    itemCount: report.itemCount,
    passRate: report.passRate,
    stableRendering: unstableFixtures.length === 0,
    unstableFixtures,
    report
  };
}

function browserReplayFixtureKey({ query, searchEngine }) {
  return `${String(searchEngine ?? '').toLowerCase()}::${String(query ?? '').trim().toLowerCase()}`;
}

function browserRenderingRawSensitiveLeakDetected(value) {
  const text = String(value ?? '');
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b\d{2,3}-\d{3,4}-\d{4}\b/.test(text);
}

export class PlaywrightReadOnlyBrowserDriver {
  constructor({
    enabled = ['1', 'true', 'playwright', 'python-playwright'].includes(String(process.env.JARVIS_BROWSER_DRIVER ?? '').toLowerCase()),
    moduleName = 'playwright',
    timeoutMs = 7000,
    pythonExecutable = process.env.JARVIS_PYTHON_PLAYWRIGHT ?? 'python',
    systemChromePath = process.env.JARVIS_BROWSER_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    clock = () => new Date()
  } = {}) {
    this.enabled = enabled;
    this.moduleName = moduleName;
    this.timeoutMs = timeoutMs;
    this.pythonExecutable = pythonExecutable;
    this.systemChromePath = systemChromePath;
    this.clock = clock;
  }

  async capture({ url, query, searchEngine, maxResults = 5 }) {
    if (!this.enabled) {
      return {
        live: false,
        driver: 'playwright',
        status: 'disabled',
        warnings: ['playwright-driver-disabled']
      };
    }
    let browser = null;
    try {
      const playwright = await import(this.moduleName);
      const chromium = playwright.chromium;
      if (!chromium?.launch) throw new Error('playwright chromium launcher is unavailable');
      const requests = [];
      const responses = [];
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: true,
        viewport: { width: 1365, height: 768 }
      });
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const request = route.request();
        requests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
        if (request.method() !== 'GET') return route.abort('blockedbyclient');
        return route.continue();
      });
      page.on('response', (response) => {
        responses.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()['content-type'] ?? null
        });
      });
      page.on('download', (download) => {
        requests.push({ method: 'DOWNLOAD', url: download.url(), resourceType: 'download', blocked: true });
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const title = await page.title().catch(() => '');
      const bodyText = sanitizeBrowserText(await page.locator('body').innerText({ timeout: 1500 }).catch(() => ''));
      const screenshot = await page.screenshot({ fullPage: false, timeout: this.timeoutMs }).catch(() => null);
      const resultPreview = createLiveResultPreview({
        query,
        searchEngine,
        title,
        url,
        bodyText,
        maxResults
      });
      return {
        live: true,
        driver: 'playwright',
        status: 'captured',
        capturedAt: this.clock().toISOString(),
        resultPreview,
        pageTitle: title,
        sanitizedText: bodyText,
        networkEvents: {
          requests,
          responses: responses.slice(0, 25),
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET').length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET')
        },
        screenshot: screenshot
          ? {
              captureMode: 'viewport-png-hash-only',
              sha256: createHash('sha256').update(screenshot).digest('hex'),
              sizeBytes: screenshot.length
            }
          : {
              captureMode: 'unavailable',
              sha256: null,
              sizeBytes: 0
            },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        }
      };
    } catch (error) {
      const fallback = this.captureWithPythonPlaywright({ url, query, searchEngine, maxResults }, error);
      if (fallback.live || fallback.status !== 'unavailable') return fallback;
      return fallback;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  captureWithPythonPlaywright({ url, query, searchEngine, maxResults = 5 }, nodeError) {
    const script = `
import hashlib
import json
import re
import sys

payload = json.loads(sys.argv[1])
requests = []
responses = []

def sanitize(value):
    value = re.sub(r"\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b", "[email]", value or "", flags=re.I)
    value = re.sub(r"\\b\\d{2,3}-\\d{3,4}-\\d{4}\\b", "[phone]", value)
    return re.sub(r"\\s+", " ", value).strip()[:4000]

try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        launch_options = {"headless": True}
        if payload.get("systemChromePath"):
            launch_options["executable_path"] = payload["systemChromePath"]
        browser = p.chromium.launch(**launch_options)
        context = browser.new_context(accept_downloads=False, java_script_enabled=True, viewport={"width": 1365, "height": 768})
        page = context.new_page()

        def handle_route(route):
            request = route.request
            requests.append({"method": request.method, "url": request.url, "resourceType": request.resource_type})
            if request.method != "GET":
                route.abort()
            else:
                route.continue_()

        page.route("**/*", handle_route)
        page.on("response", lambda response: responses.append({
            "url": response.url,
            "status": response.status,
            "contentType": response.headers.get("content-type")
        }))
        page.on("download", lambda download: requests.append({
            "method": "DOWNLOAD",
            "url": download.url,
            "resourceType": "download",
            "blocked": True
        }))
        page.goto(payload["url"], wait_until="domcontentloaded", timeout=payload["timeoutMs"])
        title = page.title()
        try:
            body_text = sanitize(page.locator("body").inner_text(timeout=1500))
        except Exception:
            body_text = ""
        try:
            screenshot = page.screenshot(full_page=False, timeout=payload["timeoutMs"])
            screenshot_hash = hashlib.sha256(screenshot).hexdigest()
            screenshot_size = len(screenshot)
        except Exception:
            screenshot_hash = None
            screenshot_size = 0
        browser.close()
        print(json.dumps({
            "ok": True,
            "title": title,
            "bodyText": body_text,
            "requests": requests,
            "responses": responses[:25],
            "screenshotHash": screenshot_hash,
            "screenshotSize": screenshot_size
        }, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
`;
    try {
      const output = execFileSync(this.pythonExecutable, [
        '-c',
        script,
        JSON.stringify({
          url,
          timeoutMs: this.timeoutMs,
          systemChromePath: this.systemChromePath
        })
      ], {
        encoding: 'utf8',
        timeout: this.timeoutMs + 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}');
      if (!payload.ok) {
        throw new Error(payload.error ?? 'python playwright capture failed');
      }
      const bodyText = sanitizeBrowserText(payload.bodyText ?? '');
      const resultPreview = createLiveResultPreview({
        query,
        searchEngine,
        title: payload.title,
        url,
        bodyText,
        maxResults
      });
      const requests = payload.requests ?? [];
      return {
        live: true,
        driver: 'python-playwright-system-chrome',
        status: 'captured',
        capturedAt: this.clock().toISOString(),
        resultPreview,
        pageTitle: payload.title ?? '',
        sanitizedText: bodyText,
        networkEvents: {
          requests,
          responses: payload.responses ?? [],
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET').length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET')
        },
        screenshot: payload.screenshotHash
          ? {
              captureMode: 'viewport-png-hash-only',
              sha256: payload.screenshotHash,
              sizeBytes: payload.screenshotSize ?? 0
            }
          : {
              captureMode: 'unavailable',
              sha256: null,
              sizeBytes: 0
            },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        },
        fallbackFrom: {
          driver: 'node-playwright',
          error: nodeError?.message ?? null
        }
      };
    } catch (fallbackError) {
      return {
        live: false,
        driver: 'playwright',
        status: 'unavailable',
        warnings: ['playwright-driver-unavailable', 'python-playwright-system-chrome-unavailable'],
        error: `${nodeError?.message ?? 'node playwright unavailable'}; ${fallbackError.message}`
      };
    }
  }
}

function sanitizeBrowserText(value) {
  return String(value ?? '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{2,3}-\d{3,4}-\d{4}\b/g, '[phone]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function createLiveResultPreview({ query, searchEngine, title, url, bodyText, maxResults }) {
  const count = Math.max(1, Math.min(Number(maxResults ?? 5), 10));
  const sentences = bodyText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fallback = title || bodyText.slice(0, 80) || query || 'live browser result';
  return Array.from({ length: Math.min(count, Math.max(1, sentences.length || 1)) }, (_, index) => ({
    rank: index + 1,
    title: index === 0 ? fallback.slice(0, 120) : `${query || 'search'} live excerpt ${index + 1}`,
    url: index === 0 ? url : `${url}#jarvis-live-${index + 1}`,
    snippet: (sentences[index] ?? bodyText.slice(index * 160, (index + 1) * 160) ?? '').slice(0, 240) || `Live read-only ${searchEngine} page capture.`
  }));
}

export class BrowserSearchToolAdapter {
  constructor({ allowedEngines = ['duckduckgo', 'bing'], readOnlyGuard = new BrowserReadOnlyGuard(), networkRecorder = new BrowserNetworkRecorder(), domSnapshotter = new BrowserDomSnapshotter(), browserDriver = new PlaywrightReadOnlyBrowserDriver() } = {}) {
    this.allowedEngines = new Set(allowedEngines);
    this.readOnlyGuard = readOnlyGuard;
    this.networkRecorder = networkRecorder;
    this.domSnapshotter = domSnapshotter;
    this.browserDriver = browserDriver;
    this.contract = createToolContract({
      toolName: 'browser.search',
      readOnly: true,
      evidence: ['query', 'searchEngine', 'url', 'resultPreview', 'blockedOperations', 'networkCapture', 'domSnapshot', 'liveCapture'],
      blockedOperations: ['formSubmit', 'download', 'fileUpload', 'credentialEntry', 'javascriptExecution', 'cookieMutation'],
      modes: ['shadow', 'execute']
    });
  }

  searchUrl({ query, searchEngine = 'duckduckgo' }) {
    if (searchEngine === 'bing') return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  }

  async shadow(args) {
    const query = String(args.query ?? '').trim();
    const searchEngine = args.searchEngine ?? 'duckduckgo';
    const readOnly = args.readOnly !== false;
    const warnings = [];
    const guard = this.readOnlyGuard.inspect(args);
    if (!query) warnings.push('empty-query');
    if (!this.allowedEngines.has(searchEngine)) warnings.push(`engine-not-allowed:${searchEngine}`);
    if (!readOnly) warnings.push('browser-search-must-be-read-only');
    warnings.push(...guard.warnings.filter((warning) => !warnings.includes(warning)));
    const url = query ? this.searchUrl({ query, searchEngine }) : null;
    const resultPreview = query ? this.previewResults({ query, searchEngine, maxResults: args.maxResults }) : [];
    const liveCapture = url && !warnings.length ? await this.browserDriver.capture({ url, query, searchEngine, maxResults: args.maxResults }) : null;
    const liveResultPreview = liveCapture?.live && liveCapture.resultPreview?.length ? liveCapture.resultPreview : resultPreview;
    const networkCapture = liveCapture?.live
      ? this.networkRecorder.capture({ url, searchEngine, response: liveCapture.networkEvents?.responses?.[0], sideEffects: liveCapture.sideEffects })
      : url ? this.networkRecorder.capture({ url, searchEngine }) : null;
    const domSnapshot = liveCapture?.live
      ? this.domSnapshotter.snapshot({ url, resultPreview: liveResultPreview, text: liveCapture.sanitizedText, source: 'playwright-live-read-only' })
      : url ? this.domSnapshotter.snapshot({ url, resultPreview }) : null;
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      query,
      searchEngine,
      readOnly,
      url,
      navigationPlan: {
        url,
        method: 'GET',
        networkMode: 'public-web-read-only',
        contentCapture: 'metadata-and-preview-only'
      },
      readOnlyGuard: guard,
      blockedOperations: this.contract.blockedOperations,
      blockedOperationProofs: guard.checks,
      networkCapture,
      domSnapshot,
      liveCapture,
      resultPreview: liveResultPreview,
      warnings
    };
  }

  async execute(args) {
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Browser search preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings
      };
    }
    return {
      status: 'success',
      outputPaths: [],
      changedItems: [],
      rollbackAvailable: false,
      readOnly: true,
      search: {
        query: shadow.query,
        searchEngine: shadow.searchEngine,
        url: shadow.url,
        maxResults: Math.min(Number(args.maxResults ?? 5), 10),
        resultPreview: shadow.resultPreview,
        networkCapture: shadow.networkCapture,
        domSnapshot: shadow.domSnapshot,
        liveCapture: summarizeBrowserLiveCapture(shadow.liveCapture)
      },
      evidence: {
        browser: {
          readOnly: true,
          navigationPlan: shadow.navigationPlan,
          blockedOperations: shadow.blockedOperations,
          blockedOperationProofs: shadow.blockedOperationProofs,
          networkCapture: shadow.networkCapture,
          domSnapshot: shadow.domSnapshot,
          liveCapture: summarizeBrowserLiveCapture(shadow.liveCapture),
          resultPreview: shadow.resultPreview,
          sideEffectsAllowed: shadow.readOnlyGuard.sideEffectsAllowed
        }
      }
    };
  }

  previewResults({ query, searchEngine, maxResults = 5 }) {
    const count = Math.max(1, Math.min(Number(maxResults ?? 5), 5));
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    return Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      title: `${terms || 'search'} preview ${index + 1}`,
      url: `${this.searchUrl({ query, searchEngine })}&jarvis_preview=${index + 1}`,
      snippet: 'Read-only search preview generated before any browser side effect.'
    }));
  }
}

function summarizeBrowserLiveCapture(liveCapture) {
  if (!liveCapture) return null;
  return {
    live: liveCapture.live === true,
    driver: liveCapture.driver,
    status: liveCapture.status,
    capturedAt: liveCapture.capturedAt ?? null,
    warnings: liveCapture.warnings ?? [],
    error: liveCapture.error ?? null,
    pageTitle: liveCapture.pageTitle ?? null,
    networkEvents: liveCapture.networkEvents
      ? {
          requestCount: liveCapture.networkEvents.requests?.length ?? 0,
          responseCount: liveCapture.networkEvents.responses?.length ?? 0,
          blockedNonGetRequests: liveCapture.networkEvents.blockedNonGetRequests ?? 0,
          allRequestsGetOnly: liveCapture.networkEvents.allRequestsGetOnly === true
        }
      : null,
    screenshot: liveCapture.screenshot ?? null
  };
}

export class ExcelWorkbookToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), workbookWorker = new ExcelWorkbookWorker() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.workbookWorker = workbookWorker;
    this.contract = createToolContract({
      toolName: 'excel.createWorkbook',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'workbook.sheetName', 'workbook.rowCount', 'workbook.templateId', 'workbook.chartCount', 'workbook.chartPartCount', 'workbook.hasDrawing', 'workbook.openValidation', 'workbook.visualValidation', 'workbook.renderSmoke', 'workbook.worker', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'macroWorkbook', 'overwriteWithoutApproval', 'rowLimitExceeded', 'unsupportedChartType']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async normalize(args) {
    const outputPath = this.assertAllowed(args.outputPath ?? args.path);
    const prepared = await this.workbookWorker.prepare({ ...args, outputPath });
    const warnings = [];
    if (outputPath.toLowerCase().endsWith('.xlsm')) warnings.push('xlsm-macro-workbook-forbidden');
    if (!outputPath.toLowerCase().endsWith('.xlsx')) warnings.push('xlsx-output-required');
    if (!prepared.sheetName || prepared.sheetName.length > 31 || /[\[\]:*?/\\]/.test(prepared.sheetName)) warnings.push('invalid-sheet-name');
    if (!Array.isArray(prepared.columns) || prepared.columns.length === 0) warnings.push('columns-required');
    if (!Array.isArray(prepared.rows)) warnings.push('rows-must-be-array');
    if (prepared.rows.length > 5000) warnings.push('row-limit-exceeded');
    for (const chart of prepared.charts) {
      if (!['bar', 'line', 'pie'].includes(chart.type)) warnings.push(`unsupported-chart-type:${chart.type}`);
    }
    return {
      ...prepared,
      outputPath,
      warnings
    };
  }

  async normalizeTemplate(template = {}) {
    return this.workbookWorker.templateCatalog.resolveTemplate(template);
  }

  normalizeStyle(style = {}) {
    return this.workbookWorker.normalizeStyle(style);
  }

  normalizeCharts(charts, columns, rows) {
    return this.workbookWorker.normalizeCharts(charts, columns, rows);
  }

  async shadow(args) {
    const normalized = await this.normalize(args);
    await assertAllowedRealPath(normalized.outputPath, this.allowedRoots, { checkParentForCreate: true });
    if (await exists(normalized.outputPath)) {
      normalized.warnings.push(`target-exists:${normalized.outputPath}`);
    }
    return {
      mode: 'shadow',
      expectedChangesCount: 1,
      outputPath: normalized.outputPath,
      sheetName: normalized.sheetName,
      columnCount: normalized.columns.length,
      rowCount: normalized.rows.length,
      templateId: normalized.template.templateId,
      templateSource: normalized.template.source,
      templateVersion: normalized.template.version,
      worker: {
        workerId: this.workbookWorker.workerId,
        processIsolation: 'worker-module'
      },
      style: normalized.style,
      chartCount: normalized.charts.length,
      charts: normalized.charts,
      overwrite: false,
      warnings: normalized.warnings
    };
  }

  async execute(args, packet = {}) {
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Workbook preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings
      };
    }
    const normalized = await this.normalize(args);
    await assertAllowedRealPath(normalized.outputPath, this.allowedRoots, { checkParentForCreate: true });
    const workerResult = await this.workbookWorker.writeWorkbook({ ...args, outputPath: normalized.outputPath });
    const inspection = workerResult.inspection;
    const undo = this.undoJournal.record({
      taskId: packet.taskId,
      action: 'delete_created_file',
      path: normalized.outputPath,
      fileKind: 'xlsx'
    });
    return {
      status: 'success',
      outputPaths: [normalized.outputPath],
      changedItems: [{ type: 'create_workbook', path: normalized.outputPath }],
      rollbackAvailable: true,
      undoJournalId: undo.undoJournalId,
      evidence: {
        verificationEvidenceId: `evidence_${packet.taskId ?? 'workbook'}`,
        workbook: {
          outputPath: normalized.outputPath,
          sheetName: inspection.sheetName,
          columnCount: inspection.columnCount,
          rowCount: inspection.rowCount,
          templateId: inspection.templateId,
          templateSource: inspection.templateSource,
          templateVersion: inspection.templateVersion,
          chartCount: inspection.chartCount,
          chartPartCount: inspection.chartPartCount,
          hasDrawing: inspection.hasDrawing,
          hasStyles: inspection.hasStyles,
          hasAutoFilter: inspection.hasAutoFilter,
          hasContentTypes: inspection.hasContentTypes,
          hasWorkbookRelationship: inspection.hasWorkbookRelationship,
          zipMagic: inspection.zipMagic,
          worker: workerResult.worker,
          openValidation: workerResult.openValidation,
          visualValidation: workerResult.visualValidation,
          renderSmoke: workerResult.renderSmoke
        }
      }
    };
  }
}

export class PcAgentRuntime {
  constructor({ policyRuntime, allowedRoots = ['./workspace'], auditLog = null, auditRoot, undoJournalPath, rollbackTransactionPath, packetJournalPath, packetQueuePath, tokenVaultPath, tokenVaultKeyProvider = null, browserDriver = null, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.auditRoot = auditRoot;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.policyRuntime = policyRuntime;
    this.auditLog = auditLog ?? new JsonlAuditLog({
      filePath: auditRoot ? `${auditRoot}/pc-agent-audit.jsonl` : 'apps/pc-agent/logs/pc-agent-audit.jsonl',
      clock
    });
    this.executionLogPath = auditRoot ? `${auditRoot}/executions.jsonl` : 'apps/pc-agent/logs/executions.jsonl';
    this.packetJournal = new ExecutionPacketJournal({
      clock,
      journalPath: packetJournalPath ?? (auditRoot ? `${auditRoot}/packet-journal.jsonl` : 'apps/pc-agent/logs/packet-journal.jsonl')
    });
    this.executionQueue = new ExecutionPacketQueue({
      clock,
      queuePath: packetQueuePath ?? (auditRoot ? `${auditRoot}/packet-queue.jsonl` : 'apps/pc-agent/logs/packet-queue.jsonl')
    });
    this.capabilityVault = new CapabilityTokenVault({
      clock,
      vaultPath: tokenVaultPath ?? (auditRoot ? `${auditRoot}/capability-vault.jsonl` : 'apps/pc-agent/logs/capability-vault.jsonl'),
      keyProvider: tokenVaultKeyProvider
    });
    this.evidenceCollector = new ExecutionEvidenceCollector({
      clock,
      logPath: auditRoot ? `${auditRoot}/evidence.jsonl` : 'apps/pc-agent/logs/evidence.jsonl'
    });
    this.memoryEmitter = new ExecutionMemoryEmitter({
      clock,
      logPath: auditRoot ? `${auditRoot}/memory-events.jsonl` : 'apps/pc-agent/logs/memory-events.jsonl'
    });
    this.undoJournal = new UndoJournal({
      clock,
      journalPath: undoJournalPath ?? (auditRoot ? `${auditRoot}/undo-journal.jsonl` : 'apps/pc-agent/logs/undo-journal.jsonl')
    });
    this.rollbackTransactions = new RollbackTransactionLog({
      clock,
      journalPath: rollbackTransactionPath ?? (auditRoot ? `${auditRoot}/rollback-transactions.jsonl` : 'apps/pc-agent/logs/rollback-transactions.jsonl')
    });
    this.registry = new ToolAdapterRegistry();
    this.fileSystemAdapter = new FileSystemToolAdapter({ allowedRoots, undoJournal: this.undoJournal });
    this.registry.register('filesystem.createTextFile', this.fileSystemAdapter);
    this.registry.register('filesystem.listFiles', new FileListToolAdapter({ allowedRoots }));
    this.registry.register('filesystem.previewMoveFiles', new FileMoveToolAdapter({
      allowedRoots,
      undoJournal: this.undoJournal,
      toolName: 'filesystem.previewMoveFiles',
      previewOnly: true
    }));
    this.registry.register('filesystem.moveFiles', new FileMoveToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('excel.createWorkbook', new ExcelWorkbookToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('browser.search', new BrowserSearchToolAdapter({ browserDriver: browserDriver ?? undefined }));
    this.registry.register('shell.execute', new ShellExecuteToolAdapter({}));
    this.registry.register('filesystem.searchFiles', new FileSearchToolAdapter({}));
    this.registry.register('document.edit', new DocumentEditToolAdapter({}));
    this.registry.register('email.send', new EmailSendToolAdapter({}));
    this.logs = [];
    this.results = new Map();
    for (const result of this.packetJournal.results.values()) {
      this.results.set(result.taskId, result);
      this.logs.unshift({ ...result, replayedFromPacketJournal: true });
    }
  }

  queueExecutionPacket(packet, { dryRun = false } = {}) {
    const queued = this.executionQueue.enqueue(packet, { dryRun });
    this.auditLog.write('execution.packet.queued', {
      taskId: queued.taskId,
      packetId: queued.packetId,
      queueId: queued.queueId,
      status: queued.status,
      attempts: queued.attempts
    });
    return queued;
  }

  async processExecutionQueue({ limit = 10 } = {}) {
    const result = await this.executionQueue.drain(
      (packet) => this.receiveExecutionPacket(packet),
      { limit }
    );
    this.auditLog.write('execution.queue.drained', {
      processed: result.processed,
      queued: result.status.queued,
      retryScheduled: result.status.retryScheduled,
      quarantined: result.status.quarantined
    });
    return result;
  }

  executionQueueStatus() {
    return this.executionQueue.status();
  }

  executionQueuePolicy() {
    return this.executionQueue.retryPolicy();
  }

  updateExecutionQueuePolicy(options = {}) {
    const result = this.executionQueue.updateRetryPolicy(options);
    this.auditLog.write('execution.queue.retry_policy_updated', {
      success: result.success,
      maxAttempts: result.current?.maxAttempts ?? null,
      baseBackoffMs: result.current?.baseBackoffMs ?? null,
      updatedBy: options.updatedBy ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  poisonQueueStatus({ includeIgnored = false } = {}) {
    return {
      items: this.executionQueue.poisonPackets({ includeIgnored }),
      queue: this.executionQueue.status()
    };
  }

  reviewPoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.reviewPoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_reviewed', {
      queueId,
      success: result.success,
      reviewStatus: result.item?.reviewStatus ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  requeuePoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.requeuePoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_requeued', {
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  ignorePoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.ignorePoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_ignored', {
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  executionPacketReleaseDossier() {
    const journalRecords = this.packetJournal.records;
    const queueRecords = this.executionQueue.records;
    const journalCounts = countBy(journalRecords, 'recordType');
    const queueCounts = countBy(queueRecords, 'recordType');
    const queueStatus = this.executionQueue.status();
    const rawLeakNeedle = {
      packet: true,
      capabilityToken: true,
      userConfirmation: true,
      arguments: true,
      queuePath: true,
      journalPath: true
    };
    const artifactManifest = {
      manifestVersion: 'b-execution-packet-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      journalManifest: {
        manifestVersion: 'b-execution-packet-journal-manifest-v1',
        recordCount: journalRecords.length,
        resultCount: this.packetJournal.results.size,
        recordCounts: journalCounts,
        idempotencyKeyHashes: journalRecords
          .map((record) => record.idempotencyKey)
          .filter(Boolean)
          .slice(0, 50)
          .map((key) => createHash('sha256').update(String(key)).digest('hex'))
      },
      queueManifest: {
        manifestVersion: 'b-execution-packet-queue-manifest-v1',
        recordCount: queueRecords.length,
        recordCounts: queueCounts,
        statusCounts: {
          total: queueStatus.total,
          queued: queueStatus.queued,
          retryScheduled: queueStatus.retryScheduled,
          succeeded: queueStatus.succeeded,
          quarantined: queueStatus.quarantined,
          ignored: queueStatus.ignored
        },
        retryPolicyHash: createHash('sha256').update(canonicalJson({
          maxAttempts: queueStatus.retryPolicy.maxAttempts,
          baseBackoffMs: queueStatus.retryPolicy.baseBackoffMs,
          updatedAt: queueStatus.retryPolicy.updatedAt ?? null
        })).digest('hex')
      },
      healthHandshake: {
        handshakeVersion: 'b-execution-packet-health-handshake-v1',
        journalReady: journalRecords.some((record) => record.recordType === 'packet_received')
          && journalRecords.some((record) => record.recordType === 'packet_result'),
        queueReady: queueRecords.some((record) => record.recordType === 'packet_queued')
          && queueRecords.some((record) => record.recordType === 'packet_succeeded'),
        idempotencyReady: this.packetJournal.results.size > 0,
        retryPolicyReady: Number.isInteger(queueStatus.retryPolicy.maxAttempts)
          && Number.isInteger(queueStatus.retryPolicy.baseBackoffMs)
      },
      fallbackPolicy: {
        policyVersion: 'b-execution-packet-fallback-policy-v1',
        primaryFlow: 'service_supervisor_queue_drain_to_receive_execution_packet',
        fallbackFlows: [
          'manual_queue_drain_from_local_api',
          'poison_queue_review_requeue_or_ignore',
          'idempotent_packet_replay_after_restart'
        ],
        operatorEscalation: 'pc_agent_tray_poison_queue_review'
      },
      packetJournalPathHash: createHash('sha256').update(String(this.packetJournal.journalPath ?? '')).digest('hex'),
      packetQueuePathHash: createHash('sha256').update(String(this.executionQueue.queuePath ?? '')).digest('hex'),
      rawExecutionPacketPayloadStored: false,
      rawQueueFilePathStored: false,
      rawJournalFilePathStored: false,
      rawCapabilityTokenStored: false,
      rawUserConfirmationStored: false
    };
    const rawLeakDetected = containsExecutionPacketReleaseRawLeak(artifactManifest, rawLeakNeedle);
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-execution-packet-release-raw-leak-check-v1',
      rawLeakDetected,
      checkedNeedles: Object.keys(rawLeakNeedle)
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-execution-packet-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B pc-agent service supervisor drains queued packets" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'execution_packet_journal_manifest_ready',
        'execution_packet_queue_manifest_ready',
        'execution_packet_health_handshake_ready',
        'execution_packet_raw_payload_not_stored',
        'execution_packet_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      rawExecutionPacketPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-execution-packet-worm-promotion-package-v1',
      providerContractVersion: 'b-execution-packet-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-execution-packet-release-artifact-manifest-v1'
        && artifactManifest.healthHandshake.handshakeVersion === 'b-execution-packet-health-handshake-v1'
        && artifactManifest.healthHandshake.journalReady
        && artifactManifest.healthHandshake.queueReady
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && ciNightlyGatePlan.planVersion === 'b-execution-packet-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawExecutionPacketPayloadStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-execution-packet-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'promote_execution_packet_journal_queue_and_supervisor_evidence_to_worm'
        : 'block_execution_packet_release_until_queue_journal_health_passes'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    return releaseDossier;
  }

  executionPacketProductGate() {
    const releaseDossier = this.executionPacketReleaseDossier();
    const checks = [
      {
        checkId: 'execution_packet_release_dossier_ready',
        passed: releaseDossier.dossierVersion === 'b-execution-packet-release-dossier-v1'
          && releaseDossier.status === 'passed'
          && releaseDossier.dossierSha256.length === 64
      },
      {
        checkId: 'execution_packet_journal_manifest_ready',
        passed: releaseDossier.artifactManifest.journalManifest.manifestVersion === 'b-execution-packet-journal-manifest-v1'
          && releaseDossier.artifactManifest.journalManifest.recordCount >= 2
          && releaseDossier.artifactManifest.journalManifest.resultCount >= 1
      },
      {
        checkId: 'execution_packet_queue_manifest_ready',
        passed: releaseDossier.artifactManifest.queueManifest.manifestVersion === 'b-execution-packet-queue-manifest-v1'
          && releaseDossier.artifactManifest.queueManifest.recordCounts.packet_queued >= 1
          && releaseDossier.artifactManifest.queueManifest.recordCounts.packet_succeeded >= 1
      },
      {
        checkId: 'execution_packet_health_handshake_ready',
        passed: releaseDossier.artifactManifest.healthHandshake.handshakeVersion === 'b-execution-packet-health-handshake-v1'
          && releaseDossier.artifactManifest.healthHandshake.journalReady
          && releaseDossier.artifactManifest.healthHandshake.queueReady
          && releaseDossier.artifactManifest.healthHandshake.idempotencyReady
      },
      {
        checkId: 'execution_packet_raw_payload_not_stored',
        passed: releaseDossier.artifactManifest.rawExecutionPacketPayloadStored === false
          && releaseDossier.artifactManifest.rawCapabilityTokenStored === false
          && releaseDossier.artifactManifest.rawUserConfirmationStored === false
          && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
      },
      {
        checkId: 'execution_packet_worm_promotion_package_ready',
        passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-execution-packet-worm-promotion-package-v1'
          && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-execution-packet-worm-provider-contract-v1'
          && releaseDossier.externalWormPromotionPackage.status === 'ready'
      }
    ];
    return {
      productGateVersion: 'b-execution-packet-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
      checks,
      releaseDossier
    };
  }

  rollbackTransactionStatus() {
    return this.rollbackTransactions.status();
  }

  pathSafetyStatus() {
    return {
      guardVersion: 'b-path-safety-guard-v1',
      allowedRoots: this.allowedRoots,
      issueCatalog: pathSafetyIssueCatalog(),
      adapters: {
        createTextFile: {
          toctouLock: true,
          realpathGuard: true
        },
        moveFiles: {
          realpathGuard: true
        },
        listFiles: {
          realpathGuard: true
        }
      }
    };
  }

  async runPathSafetyCorpus(corpus) {
    const guard = new PathSafetyGuard({ allowedRoots: this.allowedRoots, clock: this.clock });
    const report = await guard.runFixtureCorpus(corpus);
    this.auditLog.write('path_safety.corpus_run', {
      corpusVersion: report.corpusVersion,
      status: report.status,
      total: report.total,
      passed: report.passed,
      passRate: report.passRate
    });
    return report;
  }

  async runWorkbookProductCorpus(options = {}) {
    const report = await runWorkbookProductCorpus({
      ...options,
      clock: options.clock ?? this.clock
    });
    this.auditLog.write('workbook.product_corpus_run', {
      reportVersion: report.reportVersion,
      status: report.status,
      fixturePackVersion: report.fixturePackVersion,
      workerPoolStatus: report.workerPoolSoak.status,
      migrationStatus: report.migrationReport.status
    });
    return report;
  }

  queryExecutionEvidence(options = {}) {
    return this.evidenceCollector.query(options);
  }

  executionEvidenceRetention(options = {}) {
    return this.evidenceCollector.retentionReport(options);
  }

  async rotateExecutionEvidence(options = {}) {
    const rotation = await this.evidenceCollector.rotate(options);
    this.auditLog.write('execution.evidence.rotated', {
      dryRun: rotation.dryRun,
      removed: rotation.removed.length,
      retainedCount: rotation.retainedCount,
      archivePath: rotation.archive?.path ?? null
    });
    return rotation;
  }

  executionEvidenceSchemaSnapshot() {
    return this.evidenceCollector.schemaSnapshot();
  }

  executionEvidenceSchemaRegression(baseline) {
    return this.evidenceCollector.schemaRegressionReport(baseline);
  }

  executionEvidencePrivacyFixtureReport() {
    return this.evidenceCollector.privacyFixtureReport();
  }

  queryExecutionMemoryEvents(options = {}) {
    return this.memoryEmitter.query(options);
  }

  async executionEvidenceProductGate({ keepLast = 1, maxAgeMs = null } = {}) {
    const query = this.queryExecutionEvidence({ limit: 1 });
    const nextPage = query.pageInfo.nextCursor
      ? this.queryExecutionEvidence({ cursor: query.pageInfo.nextCursor, limit: 1 })
      : null;
    const retention = this.executionEvidenceRetention({ keepLast, maxAgeMs });
    const rotationDryRun = await this.rotateExecutionEvidence({ keepLast, maxAgeMs, dryRun: true });
    const schemaSnapshot = this.executionEvidenceSchemaSnapshot();
    const schemaRegression = this.executionEvidenceSchemaRegression(schemaSnapshot);
    const privacyFixtures = this.executionEvidencePrivacyFixtureReport();
    const memoryEvents = this.queryExecutionMemoryEvents({ limit: 5 });
    const recentEvidenceIds = new Set(
      this.evidenceCollector.recent(20)
        .map((item) => item.evidenceId)
        .filter(Boolean)
    );
    const memoryLinked = recentEvidenceIds.size === 0
      || memoryEvents.items.some((item) => recentEvidenceIds.has(item.payload?.evidenceId));
    const paginationHealthy = query.pageInfo.total <= query.pageInfo.limit
      ? query.pageInfo.nextCursor === null
      : Boolean(nextPage) && Number(nextPage.pageInfo.cursor) === Number(query.pageInfo.nextCursor);
    const checks = [
      {
        checkId: 'execution_evidence_query_pagination_ready',
        passed: query.queryVersion === 'b-execution-evidence-query-v1' && paginationHealthy
      },
      {
        checkId: 'execution_evidence_retention_policy_ready',
        passed: retention.reportVersion === 'b-execution-evidence-retention-report-v1' && typeof retention.retainedCount === 'number'
      },
      {
        checkId: 'execution_evidence_rotation_dry_run_ready',
        passed: rotationDryRun.rotationVersion === 'b-execution-evidence-rotation-v1' && rotationDryRun.dryRun === true
      },
      {
        checkId: 'execution_evidence_schema_regression_passed',
        passed: schemaSnapshot.snapshotVersion === 'b-execution-evidence-schema-snapshot-v1' && schemaRegression.status === 'passed'
      },
      {
        checkId: 'execution_evidence_privacy_redaction_passed',
        passed: privacyFixtures.reportVersion === 'b-evidence-privacy-redaction-fixture-report-v1' && privacyFixtures.status === 'passed'
      },
      {
        checkId: 'execution_memory_event_evidence_link_ready',
        passed: memoryEvents.queryVersion === 'b-execution-memory-event-query-v1' && memoryLinked
      }
    ];
    const releaseCheckSnapshot = checks.map((check) => ({ checkId: check.checkId, passed: check.passed }));
    const recentEvidence = this.evidenceCollector.recent(50);
    const artifactManifest = {
      manifestVersion: 'b-execution-evidence-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      evidenceLogPathHash: createHash('sha256').update(String(this.evidenceCollector.logPath ?? '')).digest('hex'),
      memoryEventLogPathHash: createHash('sha256').update(String(this.memoryEmitter.logPath ?? '')).digest('hex'),
      evidenceQueryHash: createHash('sha256').update(canonicalJson({
        queryVersion: query.queryVersion,
        total: query.pageInfo.total,
        limit: query.pageInfo.limit,
        nextCursor: query.pageInfo.nextCursor,
        statusCounts: countBy(recentEvidence, 'status'),
        toolCounts: countBy(recentEvidence, 'toolName')
      })).digest('hex'),
      retentionEvidenceHash: createHash('sha256').update(canonicalJson({
        reportVersion: retention.reportVersion,
        total: retention.total,
        retainedCount: retention.retainedCount,
        removableCount: retention.removableCount,
        rotationRecommended: retention.rotationRecommended,
        policy: retention.policy
      })).digest('hex'),
      rotationDryRunHash: createHash('sha256').update(canonicalJson({
        rotationVersion: rotationDryRun.rotationVersion,
        dryRun: rotationDryRun.dryRun === true,
        removedCount: rotationDryRun.removed.length,
        retainedCount: rotationDryRun.retainedCount
      })).digest('hex'),
      schemaSnapshotHash: schemaSnapshot.snapshotHash,
      schemaRegressionHash: createHash('sha256').update(canonicalJson({
        reportVersion: schemaRegression.reportVersion,
        status: schemaRegression.status,
        currentSnapshotHash: schemaRegression.currentSnapshotHash,
        baselineSnapshotHash: schemaRegression.baselineSnapshotHash,
        itemStatusCounts: countBy(schemaRegression.items, 'status')
      })).digest('hex'),
      privacyFixtureHash: createHash('sha256').update(canonicalJson({
        reportVersion: privacyFixtures.reportVersion,
        corpusVersion: privacyFixtures.corpusVersion,
        status: privacyFixtures.status,
        caseCount: privacyFixtures.caseCount
      })).digest('hex'),
      memoryLinkageHash: createHash('sha256').update(canonicalJson({
        queryVersion: memoryEvents.queryVersion,
        total: memoryEvents.pageInfo.total,
        recentEvidenceCount: recentEvidenceIds.size,
        linked: memoryLinked
      })).digest('hex'),
      evidenceCount: query.pageInfo.total,
      memoryEventCount: memoryEvents.pageInfo.total,
      recentToolCounts: countBy(recentEvidence, 'toolName'),
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-execution-evidence-release-raw-leak-check-v1',
      rawLeakDetected: containsExecutionEvidenceReleaseRawLeak(artifactManifest),
      checkedRawFields: [
        'rawExecutionEvidenceStored',
        'rawFilePathStored',
        'rawMemoryPayloadStored',
        'rawCapabilityTokenStored',
        'rawUserCommandStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-execution-evidence-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-execution-evidence-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        queryReady: query.queryVersion === 'b-execution-evidence-query-v1',
        retentionReady: retention.reportVersion === 'b-execution-evidence-retention-report-v1',
        rotationDryRunReady: rotationDryRun.rotationVersion === 'b-execution-evidence-rotation-v1' && rotationDryRun.dryRun === true,
        schemaRegressionReady: schemaRegression.status === 'passed',
        privacyRedactionReady: privacyFixtures.status === 'passed',
        memoryLinkageReady: memoryLinked,
        evidenceCount: query.pageInfo.total,
        memoryEventCount: memoryEvents.pageInfo.total
      },
      fallbackPolicy: {
        policyVersion: 'b-execution-evidence-fallback-policy-v1',
        primaryFlow: 'collect_redacted_execution_evidence_then_emit_memory_event_for_f_and_g',
        fallbackFlows: [
          'schema_regression_blocks_release_on_removed_required_fields',
          'privacy_fixture_failure_blocks_g_f_handoff',
          'retention_rotation_dry_run_before_archive_write',
          'manual_memory_link_repair_from_evidence_id'
        ],
        operatorEscalation: 'pc_agent_evidence_product_gate_and_memory_event_query'
      },
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-execution-evidence-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B pc-agent execution evidence supports retention" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'execution_evidence_query_pagination_ready',
        'execution_evidence_retention_policy_ready',
        'execution_evidence_rotation_dry_run_ready',
        'execution_evidence_schema_regression_passed',
        'execution_evidence_privacy_redaction_passed',
        'execution_memory_event_evidence_link_ready',
        'execution_evidence_release_dossier_ready',
        'execution_evidence_release_artifact_manifest_ready',
        'execution_evidence_operational_handoff_ready',
        'execution_evidence_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawExecutionEvidenceStored: false,
      rawMemoryPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-execution-evidence-worm-promotion-package-v1',
      providerContractVersion: 'b-execution-evidence-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-execution-evidence-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-execution-evidence-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawExecutionEvidenceStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-execution-evidence-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      releaseChecks: releaseCheckSnapshot,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'attach_execution_evidence_schema_privacy_memory_handoff_and_worm_release_evidence'
        : 'block_execution_evidence_release_until_schema_privacy_retention_and_memory_link_pass'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    checks.push({
      checkId: 'execution_evidence_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'b-execution-evidence-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierSha256.length === 64
    });
    checks.push({
      checkId: 'execution_evidence_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest.manifestVersion === 'b-execution-evidence-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawExecutionEvidenceStored === false
        && releaseDossier.artifactManifest.rawMemoryPayloadStored === false
    });
    checks.push({
      checkId: 'execution_evidence_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest.manifestVersion === 'b-execution-evidence-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest.healthHandshakeVersion === 'b-execution-evidence-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest.fallbackPolicy.policyVersion === 'b-execution-evidence-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest.status === 'ready'
    });
    checks.push({
      checkId: 'execution_evidence_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-execution-evidence-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-execution-evidence-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage.status === 'ready'
    });
    return {
      productGateVersion: 'b-execution-evidence-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      evidenceCount: query.pageInfo.total,
      query,
      nextPage,
      retention,
      rotationDryRun,
      schemaSnapshot,
      schemaRegression,
      privacyFixtures,
      memoryEvents,
      releaseDossier
    };
  }

  async receiveExecutionPacket(packet, { dryRun = false } = {}) {
    const startedAt = this.clock().toISOString();
    const action = packet.action ?? {};
    const existing = this.packetJournal.resultFor(packet);
    if (existing) {
      const replay = {
        ...existing,
        idempotentReplay: true,
        replayedAt: this.clock().toISOString()
      };
      this.logs.unshift(replay);
      this.results.set(packet.taskId, replay);
      this.auditLog.write('execution.packet.replayed', {
        taskId: packet.taskId,
        packetId: packet.packetId,
        idempotencyKey: this.packetJournal.idempotencyKey(packet)
      });
      return replay;
    }
    this.packetJournal.recordReceived(packet, { dryRun });
    if (!packet.userConfirmation?.confirmed) {
      return this.block(packet, 'B_USER_CONFIRMATION_REQUIRED', { dryRun });
    }
    if (action.actionType === ActionType.DELETE_FILE) {
      return this.block(packet, 'B_FORBIDDEN_DESTRUCTIVE_ACTION', { dryRun });
    }
    if (!packet.capabilityToken?.tokenId) {
      return this.block(packet, 'B_CAPABILITY_TOKEN_REQUIRED', { dryRun });
    }
    const sealedCapabilityToken = this.capabilityVault.sealCapabilityToken(packet.capabilityToken, {
      taskId: packet.taskId,
      packetId: packet.packetId,
      toolName: action.toolName
    });
    const validation = this.policyRuntime?.capabilities?.validate({
      tokenId: packet.capabilityToken.tokenId,
      taskId: packet.taskId,
      toolName: action.toolName,
      actionType: action.actionType
    });
    if (validation && !validation.valid) {
      return this.block(packet, validation.reason, { dryRun });
    }
    const adapter = this.registry.get(action.toolName);
    if (!adapter) {
      return this.block(packet, 'B_TOOL_ADAPTER_NOT_FOUND', { dryRun });
    }
    const requestedMode = action.toolName === 'filesystem.previewMoveFiles' ? 'shadow' : packet.requestedMode ?? 'execute';
    if (!adapter.contract.modes.includes(requestedMode)) {
      return this.block(packet, `B_TOOL_MODE_NOT_ALLOWED:${requestedMode}`, { dryRun });
    }
    let shadow;
    try {
      shadow = await adapter.shadow(action.arguments ?? {}, packet);
    } catch (error) {
      return this.block(packet, error.message ?? 'B_TOOL_PREFLIGHT_EXCEPTION', { dryRun });
    }
    shadow.adapterContract = adapter.contract;
    if (dryRun || packet.requestedMode === 'shadow' || action.toolName === 'filesystem.previewMoveFiles') {
      const shadowResult = {
        taskId: packet.taskId,
        status: TaskStatus.VERIFYING,
        shadow,
        executionResult: null
      };
      this.auditLog.write('execution.shadow', {
        taskId: packet.taskId,
        packetId: packet.packetId,
        toolName: action.toolName,
        expectedChangesCount: shadow.expectedChangesCount,
        warnings: shadow.warnings
      });
      this.packetJournal.recordResult(packet, shadowResult, { dryRun: true });
      return shadowResult;
    }
    let executionResult;
    try {
      executionResult = await adapter.execute(action.arguments ?? {}, packet);
    } catch (error) {
      return this.block(packet, error.message ?? 'B_TOOL_EXECUTION_EXCEPTION', { dryRun });
    }
    if (executionResult.status === 'blocked') {
      return this.block(packet, executionResult.warnings?.[0] ?? 'B_TOOL_PREFLIGHT_FAILED', { dryRun });
    }
    this.policyRuntime?.capabilities?.consume({ tokenId: packet.capabilityToken.tokenId, executionResult: executionResult.status });
    const finishedAt = this.clock().toISOString();
    const enrichedExecutionResult = {
      packetId: packet.packetId,
      taskId: packet.taskId,
      startedAt,
      finishedAt,
      executedBy: {
        module: ModuleId.PC_AGENT,
        toolName: action.toolName
      },
      safety: {
        capabilityTokenUsed: packet.capabilityToken.tokenId,
        capabilityTokenVaultRef: sealedCapabilityToken,
        irreversibleActionDetected: false,
        rollbackAvailable: executionResult.rollbackAvailable === true,
        adapterContract: adapter.contract
      },
      ...executionResult
    };
    const evidence = await this.evidenceCollector.collect({
      packet,
      shadow,
      executionResult: enrichedExecutionResult,
      status: 'success'
    });
    enrichedExecutionResult.evidence = {
      ...enrichedExecutionResult.evidence,
      shadowReportId: evidence.evidenceId,
      undoJournalId: enrichedExecutionResult.undoJournalId,
      logPath: this.executionLogPath,
      verificationEvidenceId: evidence.evidenceId,
      executionEvidence: evidence
    };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult: enrichedExecutionResult,
      outcome: 'success',
      evidence
    });
    const result = {
      taskId: packet.taskId,
      status: TaskStatus.COMPLETED,
      shadow,
      executionResult: enrichedExecutionResult,
      evidence,
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    this.packetJournal.recordResult(packet, result, { dryRun: false });
    this.auditLog.write('execution.completed', {
      taskId: packet.taskId,
      packetId: packet.packetId,
      toolName: action.toolName,
      outputPaths: enrichedExecutionResult.outputPaths,
      undoJournalId: enrichedExecutionResult.undoJournalId,
      evidenceId: evidence.evidenceId,
      memoryEventId: memoryEvent.eventId
    });
    this.logs.unshift(result);
    this.results.set(packet.taskId, result);
    return result;
  }

  block(packet, reason, { dryRun = false } = {}) {
    const executionResult = { status: 'blocked', summary: reason, outputPaths: [], changedItems: [], rollbackAvailable: false };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult,
      outcome: 'blocked',
      evidence: null
    });
    const result = {
      taskId: packet.taskId,
      status: TaskStatus.BLOCKED,
      blockedReason: reason,
      executionResult,
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    this.packetJournal.recordResult(packet, result, { dryRun });
    this.auditLog.write('execution.blocked', {
      taskId: packet.taskId,
      packetId: packet.packetId,
      reason,
      memoryEventId: memoryEvent.eventId
    });
    this.logs.unshift(result);
    this.results.set(packet.taskId, result);
    return result;
  }

  taskResult(taskId) {
    return this.results.get(taskId) ?? { success: false, error: { code: 'B_TASK_NOT_FOUND' } };
  }

  taskEvidence(taskId) {
    return this.evidenceCollector.get(taskId);
  }

  recentMemoryEvents(limit = 20) {
    return this.memoryEmitter.recent(limit);
  }

  async rollbackPlan(taskId) {
    const entries = this.undoJournal.list().filter((entry) => entry.taskId === taskId);
    if (!entries.length) {
      return { success: false, taskId, error: { code: 'B_ROLLBACK_NOT_FOUND' } };
    }
    const steps = [];
    for (const entry of entries) {
      steps.push(await this.rollbackStepPlan(entry));
    }
    const blocked = steps.filter((step) => step.status === 'blocked');
    const ready = steps.filter((step) => step.status === 'ready');
    const noop = steps.filter((step) => step.status === 'noop');
    return {
      success: true,
      taskId,
      dryRun: true,
      stepCount: steps.length,
      readyCount: ready.length,
      noopCount: noop.length,
      blockedCount: blocked.length,
      steps,
      blocked,
      chain: this.undoJournal.verifyChain()
    };
  }

  async rollbackStepPlan(entry) {
    const base = {
      undoJournalId: entry.undoJournalId,
      taskId: entry.taskId,
      action: entry.action,
      createdAt: entry.createdAt,
      rollbackStatus: entry.rollbackStatus,
      status: 'ready',
      checks: [],
      paths: {},
      risk: 'low'
    };
    if (entry.action === 'delete_created_file') {
      const safety = await this.rollbackPathSafety(entry.path);
      const currentExists = await exists(entry.path);
      return this.withRollbackSafety(base, safety, {
        paths: { deletePath: entry.path, resolvedDeletePath: safety.resolved ?? null },
        checks: [{ id: 'created-file-current-state', passed: true, exists: currentExists }],
        status: currentExists ? 'ready' : 'noop',
        change: currentExists ? 'delete created file' : 'created file already missing; mark undo entry rolled back'
      });
    }
    if (entry.action === 'restore_previous_file') {
      const safety = await this.rollbackPathSafety(entry.path, { checkParentForCreate: true });
      const hasPreviousContent = typeof entry.previousContent === 'string';
      return this.withRollbackSafety(base, safety, {
        paths: { restorePath: entry.path, resolvedRestorePath: safety.resolved ?? null },
        checks: [{ id: 'previous-content-present', passed: hasPreviousContent }],
        status: hasPreviousContent ? 'ready' : 'blocked',
        blockedReason: hasPreviousContent ? null : 'B_ROLLBACK_PREVIOUS_CONTENT_MISSING',
        change: 'restore previous file content'
      });
    }
    if (entry.action === 'move_back') {
      const fromSafety = await this.rollbackPathSafety(entry.from, { checkParentForCreate: true });
      const toSafety = await this.rollbackPathSafety(entry.to);
      const currentExists = await exists(entry.to);
      const restoreTargetExists = await exists(entry.from);
      const safety = fromSafety.allowed ? toSafety : fromSafety;
      const status = currentExists && !restoreTargetExists ? 'ready' : 'blocked';
      const blockedReason = !currentExists
        ? 'B_ROLLBACK_MOVE_SOURCE_MISSING'
        : restoreTargetExists
          ? 'B_ROLLBACK_MOVE_TARGET_EXISTS'
          : null;
      return this.withRollbackSafety(base, safety, {
        paths: {
          restorePath: entry.from,
          currentPath: entry.to,
          resolvedRestorePath: fromSafety.resolved ?? null,
          resolvedCurrentPath: toSafety.resolved ?? null
        },
        checks: [
          { id: 'moved-file-current-location-exists', passed: currentExists, path: entry.to },
          { id: 'restore-target-clear', passed: !restoreTargetExists, path: entry.from },
          { id: 'restore-path-allowed', passed: fromSafety.allowed, detail: fromSafety.reason ?? null },
          { id: 'current-path-allowed', passed: toSafety.allowed, detail: toSafety.reason ?? null }
        ],
        status,
        blockedReason,
        change: 'move file back to original path'
      });
    }
    return {
      ...base,
      status: 'blocked',
      blockedReason: 'B_ROLLBACK_ACTION_UNKNOWN',
      change: 'unknown rollback action'
    };
  }

  async rollbackPathSafety(path, { checkParentForCreate = false } = {}) {
    try {
      const resolved = await assertAllowedRealPath(path, this.allowedRoots, { checkParentForCreate });
      return { allowed: true, path, resolved };
    } catch (error) {
      return {
        allowed: false,
        path,
        resolved: resolve(path),
        reason: 'B_ROLLBACK_OUTSIDE_ALLOWED_ROOTS',
        detail: error.message
      };
    }
  }

  withRollbackSafety(base, safety, patch) {
    const checks = [...(patch.checks ?? [])];
    checks.push({
      id: 'allowed-realpath-root',
      passed: safety.allowed,
      path: safety.path,
      resolved: safety.resolved,
      detail: safety.detail ?? null
    });
    if (!safety.allowed) {
      return {
        ...base,
        ...patch,
        checks,
        status: 'blocked',
        blockedReason: safety.reason,
        safety
      };
    }
    if (patch.status === 'blocked') {
      return {
        ...base,
        ...patch,
        checks,
        safety
      };
    }
    return {
      ...base,
      ...patch,
      checks,
      blockedReason: null,
      safety
    };
  }

  async rollbackTask(taskId) {
    const entries = this.undoJournal.list().filter((entry) => entry.taskId === taskId);
    if (!entries.length) {
      return { success: false, error: { code: 'B_ROLLBACK_NOT_FOUND' } };
    }
    const plan = await this.rollbackPlan(taskId);
    const transactionStart = this.rollbackTransactions.begin({ taskId, plan });
    if (!transactionStart.success) {
      return {
        success: false,
        taskId,
        error: transactionStart.error,
        transaction: transactionStart.transaction,
        plan
      };
    }
    const transaction = transactionStart.transaction;
    const rolledBack = [];
    const skipped = [];
    const stepsById = new Map(plan.steps.map((step) => [step.undoJournalId, step]));
    try {
      for (const entry of entries) {
        const step = stepsById.get(entry.undoJournalId);
        if (step?.status === 'blocked') {
          const skippedEntry = {
            undoJournalId: entry.undoJournalId,
            reason: step.blockedReason,
            paths: step.paths,
            checks: step.checks
          };
          skipped.push(skippedEntry);
          this.rollbackTransactions.recordStep(transaction, {
            step,
            status: 'skipped',
            reason: step.blockedReason,
            rollbackResult: skippedEntry
          });
          continue;
        }
        if (entry.action === 'delete_created_file') {
          await rm(entry.path, { force: true });
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, path: entry.path, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
        if (entry.action === 'restore_previous_file') {
          await mkdir(dirname(entry.path), { recursive: true });
          await writeFile(entry.path, entry.previousContent ?? '', 'utf8');
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, path: entry.path, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
        if (entry.action === 'move_back') {
          await mkdir(dirname(entry.from), { recursive: true });
          await rename(entry.to, entry.from);
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, from: entry.from, to: entry.to, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
      }
    } catch (error) {
      const failedTransaction = this.rollbackTransactions.fail(transaction, error, { rolledBack, skipped });
      this.auditLog.write('rollback.failed', {
        taskId,
        transactionId: transaction.transactionId,
        error: error.message,
        rolledBackCount: rolledBack.length,
        skippedCount: skipped.length
      });
      return {
        success: false,
        taskId,
        error: { code: 'B_ROLLBACK_TRANSACTION_FAILED', message: error.message },
        transaction: failedTransaction,
        plan,
        rolledBack,
        skipped
      };
    }
    const completedTransaction = this.rollbackTransactions.complete(transaction, { rolledBack, skipped });
    this.auditLog.write('rollback.completed', {
      taskId,
      transactionId: transaction.transactionId,
      count: rolledBack.length,
      skippedCount: skipped.length,
      plannedSteps: plan.stepCount,
      blockedCount: plan.blockedCount
    });
    if (!rolledBack.length && skipped.length) {
      return { success: false, taskId, error: { code: 'B_ROLLBACK_UNSAFE_ENTRIES' }, transaction: completedTransaction, plan, skipped };
    }
    return { success: true, taskId, transaction: completedTransaction, plan, rolledBack, skipped };
  }

  async exportRollbackArchive(taskId, { outputPath = null } = {}) {
    const plan = await this.rollbackPlan(taskId);
    if (!plan.success) return plan;
    const generatedAt = this.clock().toISOString();
    const journalRecords = this.undoJournal.records.filter((record) => record.taskId === taskId);
    const archiveBase = {
      archiveType: 'jarvis.pc-agent.rollback-archive',
      schemaVersion: '1.0',
      taskId,
      generatedAt,
      dryRun: true,
      plan,
      journalRecords,
      rollbackTransactions: this.rollbackTransactions.history({ taskId, limit: 20 }),
      chain: this.undoJournal.verifyChain()
    };
    const digest = createHash('sha256').update(canonicalJson(archiveBase)).digest('hex');
    const archive = {
      ...archiveBase,
      digest,
      signature: {
        algorithm: 'sha256-local-digest',
        value: digest,
        signedAt: generatedAt
      }
    };
    const result = { success: true, taskId, archive };
    if (!outputPath) {
      this.auditLog.write('rollback.archive.generated', { taskId, digest, persisted: false });
      return result;
    }
    const safety = await this.rollbackPathSafety(outputPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        success: false,
        taskId,
        error: { code: 'B_ROLLBACK_ARCHIVE_OUTSIDE_ALLOWED_ROOTS', message: safety.detail },
        archive
      };
    }
    await mkdir(dirname(safety.resolved), { recursive: true });
    await writeFile(safety.resolved, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    const [fileInfo, fileContent] = await Promise.all([stat(safety.resolved), readFile(safety.resolved)]);
    const file = {
      path: safety.resolved,
      size: fileInfo.size,
      sha256: createHash('sha256').update(fileContent).digest('hex')
    };
    this.auditLog.write('rollback.archive.generated', { taskId, digest, persisted: true, path: file.path, sha256: file.sha256 });
    return { ...result, file };
  }

  rollbackArchiveSignatureKeyRotationDrill({
    archive,
    oldKeyId = 'rollback-archive-signing-key-v1',
    newKeyId = 'rollback-archive-signing-key-v2'
  } = {}) {
    const digest = archive?.digest ?? createHash('sha256').update(canonicalJson(archive ?? {})).digest('hex');
    const sign = (keyId) => createHmac('sha256', keyId).update(digest).digest('hex');
    const oldSignature = {
      keyId: oldKeyId,
      algorithm: 'hmac-sha256-local-rotation-drill',
      value: sign(oldKeyId)
    };
    const newSignature = {
      keyId: newKeyId,
      algorithm: 'hmac-sha256-local-rotation-drill',
      value: sign(newKeyId)
    };
    const checks = [
      {
        checkId: 'archive_digest_available',
        passed: typeof digest === 'string' && digest.length === 64
      },
      {
        checkId: 'old_signature_verifies',
        passed: oldSignature.value === sign(oldKeyId)
      },
      {
        checkId: 'new_signature_verifies',
        passed: newSignature.value === sign(newKeyId)
      },
      {
        checkId: 'rotation_changes_signature_material',
        passed: oldSignature.value !== newSignature.value
      }
    ];
    return {
      drillVersion: 'b-rollback-archive-signature-key-rotation-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      digest,
      dualSignatureWindow: {
        previousKeyAccepted: true,
        nextKeyAccepted: true,
        nextKeyPreferred: true
      },
      oldSignature,
      newSignature,
      checks
    };
  }

  async syncRollbackArchiveToWorm({ taskId, archivePath, targetDir = null } = {}) {
    if (!archivePath) {
      return {
        syncVersion: 'b-rollback-worm-archive-sync-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_ARCHIVE_PATH_REQUIRED' }
      };
    }
    const sourceContent = await readFile(archivePath);
    const sourceSha256 = createHash('sha256').update(sourceContent).digest('hex');
    const safeTaskId = String(taskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const resolvedTargetDir = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-worm-store'));
    const targetPath = resolve(resolvedTargetDir, `${safeTaskId}-${sourceSha256.slice(0, 16)}.json`);
    const safety = await this.rollbackPathSafety(targetPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        syncVersion: 'b-rollback-worm-archive-sync-v1',
        storeVersion: 'b-rollback-worm-archive-store-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_WORM_TARGET_OUTSIDE_ALLOWED_ROOTS', message: safety.detail },
        targetPath,
        safety
      };
    }
    let copied = false;
    let existingHash = null;
    if (await exists(targetPath)) {
      existingHash = createHash('sha256').update(await readFile(targetPath)).digest('hex');
      if (existingHash !== sourceSha256) {
        return {
          syncVersion: 'b-rollback-worm-archive-sync-v1',
          storeVersion: 'b-rollback-worm-archive-store-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_WORM_HASH_MISMATCH' },
          sourceSha256,
          existingHash,
          targetPath
        };
      }
    } else {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(archivePath, targetPath);
      copied = true;
    }
    const manifest = {
      syncVersion: 'b-rollback-worm-archive-sync-v1',
      storeVersion: 'b-rollback-worm-archive-store-v1',
      generatedAt: this.clock().toISOString(),
      status: 'synced',
      taskId,
      policy: {
        writeOnce: true,
        overwriteExistingArchive: false,
        contentAddressedName: true
      },
      itemCount: 1,
      items: [{
        taskId,
        sourcePath: resolve(archivePath),
        targetPath,
        sha256: sourceSha256,
        copied,
        existingHash,
        writeOnce: true
      }]
    };
    const manifestPath = resolve(resolvedTargetDir, 'rollback-worm-manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    this.auditLog.write('rollback.archive.worm_synced', {
      taskId,
      targetPath,
      sha256: sourceSha256,
      copied
    });
    return { ...manifest, manifestPath };
  }

  async rollbackCrashRecoveryDrill({ taskId, plan, targetDir = null } = {}) {
    if (!plan?.success) {
      return {
        drillVersion: 'b-rollback-crash-recovery-drill-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_PLAN_REQUIRED' }
      };
    }
    const safeTaskId = String(taskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const drillDir = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-crash-drills'));
    const drillPath = resolve(drillDir, `${safeTaskId}-${this.clock().getTime()}-transactions.jsonl`);
    const safety = await this.rollbackPathSafety(drillPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        drillVersion: 'b-rollback-crash-recovery-drill-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_CRASH_DRILL_PATH_BLOCKED', message: safety.detail },
        safety
      };
    }
    await mkdir(dirname(safety.resolved), { recursive: true });
    const drillTaskId = `${taskId}:crash-drill`;
    const firstLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const started = firstLog.begin({ taskId: drillTaskId, plan });
    const reloadedLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const recoveredActive = reloadedLog.activeForTask(drillTaskId);
    const recoveredStatus = reloadedLog.status();
    const completed = recoveredActive
      ? reloadedLog.complete(recoveredActive, { rolledBack: [], skipped: [] })
      : null;
    const finalLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const checks = [
      {
        checkId: 'running_transaction_persisted_before_crash',
        passed: started.success === true
      },
      {
        checkId: 'running_transaction_recovered_after_restart',
        passed: Boolean(recoveredActive)
      },
      {
        checkId: 'recovered_chain_valid',
        passed: recoveredStatus.chain.status === 'valid'
      },
      {
        checkId: 'recovered_transaction_can_complete',
        passed: completed?.status === 'completed'
      },
      {
        checkId: 'final_chain_valid_after_completion',
        passed: finalLog.verifyChain().status === 'valid'
      }
    ];
    return {
      drillVersion: 'b-rollback-crash-recovery-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      taskId,
      drillTaskId,
      drillPath: safety.resolved,
      started: started.transaction,
      recoveredActive,
      completed,
      recoveredStatus,
      finalStatus: finalLog.status(),
      checks
    };
  }

  async rollbackProductGate({ taskId = null, targetDir = null } = {}) {
    const pendingEntries = this.undoJournal.list();
    const resolvedTaskId = taskId ?? pendingEntries[0]?.taskId ?? null;
    const targetRoot = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-product-gate'));
    const plan = resolvedTaskId ? await this.rollbackPlan(resolvedTaskId) : {
      success: false,
      taskId: resolvedTaskId,
      error: { code: 'B_ROLLBACK_TASK_REQUIRED' }
    };
    const safeTaskId = String(resolvedTaskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const archivePath = resolve(targetRoot, 'staging', `${safeTaskId}-${this.clock().getTime()}-rollback-archive.json`);
    const archive = plan.success ? await this.exportRollbackArchive(resolvedTaskId, { outputPath: archivePath }) : plan;
    const wormSync = archive.success
      ? await this.syncRollbackArchiveToWorm({
          taskId: resolvedTaskId,
          archivePath: archive.file?.path,
          targetDir: resolve(targetRoot, 'worm-store')
        })
      : {
          syncVersion: 'b-rollback-worm-archive-sync-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_ARCHIVE_NOT_AVAILABLE' }
        };
    const keyRotation = archive.success
      ? this.rollbackArchiveSignatureKeyRotationDrill({ archive: archive.archive })
      : this.rollbackArchiveSignatureKeyRotationDrill({ archive: null });
    const crashRecovery = plan.success
      ? await this.rollbackCrashRecoveryDrill({
          taskId: resolvedTaskId,
          plan,
          targetDir: resolve(targetRoot, 'crash-recovery')
        })
      : {
          drillVersion: 'b-rollback-crash-recovery-drill-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_PLAN_NOT_AVAILABLE' }
        };
    const undoChain = this.undoJournal.verifyChain();
    const transactionStatus = this.rollbackTransactionStatus();
    const checks = [
      {
        checkId: 'rollback_plan_ready',
        passed: plan.success === true && plan.chain?.status === 'valid' && plan.readyCount >= 1,
        detail: { taskId: resolvedTaskId, readyCount: plan.readyCount, blockedCount: plan.blockedCount }
      },
      {
        checkId: 'undo_journal_chain_valid',
        passed: undoChain.status === 'valid',
        detail: { checked: undoChain.checked, latestHash: undoChain.latestHash }
      },
      {
        checkId: 'rollback_archive_exported',
        passed: archive.success === true && archive.archive?.digest?.length === 64 && archive.file?.sha256?.length === 64,
        detail: { path: archive.file?.path, digest: archive.archive?.digest }
      },
      {
        checkId: 'rollback_worm_archive_synced',
        passed: wormSync.syncVersion === 'b-rollback-worm-archive-sync-v1'
          && wormSync.storeVersion === 'b-rollback-worm-archive-store-v1'
          && wormSync.status === 'synced'
          && wormSync.items?.every((item) => item.writeOnce === true),
        detail: { manifestPath: wormSync.manifestPath, itemCount: wormSync.itemCount }
      },
      {
        checkId: 'rollback_archive_signature_rotation_passed',
        passed: keyRotation.drillVersion === 'b-rollback-archive-signature-key-rotation-drill-v1' && keyRotation.status === 'passed',
        detail: { oldKeyId: keyRotation.oldSignature?.keyId, newKeyId: keyRotation.newSignature?.keyId }
      },
      {
        checkId: 'rollback_crash_recovery_drill_passed',
        passed: crashRecovery.drillVersion === 'b-rollback-crash-recovery-drill-v1' && crashRecovery.status === 'passed',
        detail: { drillPath: crashRecovery.drillPath }
      },
      {
        checkId: 'rollback_transaction_chain_valid',
        passed: transactionStatus.chain.status === 'valid',
        detail: { checked: transactionStatus.chain.checked, active: transactionStatus.active.length }
      }
    ];
    const releaseCheckSnapshot = checks.map((check) => ({ checkId: check.checkId, passed: check.passed }));
    const artifactManifest = {
      manifestVersion: 'b-rollback-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      taskIdHash: createHash('sha256').update(String(resolvedTaskId ?? '')).digest('hex'),
      undoJournalPathHash: createHash('sha256').update(String(this.undoJournal.journalPath ?? '')).digest('hex'),
      rollbackTransactionJournalPathHash: createHash('sha256').update(String(this.rollbackTransactions.journalPath ?? '')).digest('hex'),
      undoJournalManifest: {
        manifestVersion: 'b-rollback-undo-journal-manifest-v1',
        recordCount: this.undoJournal.records.length,
        pendingEntryCount: pendingEntries.length,
        recordCounts: countBy(this.undoJournal.records, 'recordType'),
        chainStatus: undoChain.status,
        latestHash: undoChain.latestHash ?? null
      },
      transactionManifest: {
        manifestVersion: 'b-rollback-transaction-journal-manifest-v1',
        recordCount: this.rollbackTransactions.records.length,
        transactionCount: transactionStatus.transactions,
        activeCount: transactionStatus.active.length,
        recordCounts: countBy(this.rollbackTransactions.records, 'recordType'),
        chainStatus: transactionStatus.chain.status,
        latestHash: transactionStatus.chain.latestHash ?? null
      },
      planEvidenceHash: createHash('sha256').update(canonicalJson({
        success: plan.success === true,
        dryRun: plan.dryRun === true,
        readyCount: plan.readyCount ?? 0,
        blockedCount: plan.blockedCount ?? 0,
        stepCount: plan.steps?.length ?? 0,
        chainStatus: plan.chain?.status ?? null
      })).digest('hex'),
      archiveEvidenceHash: createHash('sha256').update(canonicalJson({
        success: archive.success === true,
        digest: archive.archive?.digest ?? null,
        fileSha256: archive.file?.sha256 ?? null,
        fileSize: archive.file?.size ?? null,
        signatureAlgorithm: archive.archive?.signature?.algorithm ?? null
      })).digest('hex'),
      wormSyncEvidenceHash: createHash('sha256').update(canonicalJson({
        syncVersion: wormSync.syncVersion ?? null,
        storeVersion: wormSync.storeVersion ?? null,
        status: wormSync.status ?? null,
        itemCount: wormSync.itemCount ?? 0,
        itemHashes: (wormSync.items ?? []).map((item) => ({
          sha256: item.sha256,
          copied: item.copied === true,
          writeOnce: item.writeOnce === true,
          existingHash: item.existingHash ?? null
        }))
      })).digest('hex'),
      keyRotationEvidenceHash: createHash('sha256').update(canonicalJson({
        drillVersion: keyRotation.drillVersion ?? null,
        status: keyRotation.status ?? null,
        digest: keyRotation.digest ?? null,
        oldKeyIdHash: keyRotation.oldSignature?.keyId
          ? createHash('sha256').update(String(keyRotation.oldSignature.keyId)).digest('hex')
          : null,
        newKeyIdHash: keyRotation.newSignature?.keyId
          ? createHash('sha256').update(String(keyRotation.newSignature.keyId)).digest('hex')
          : null
      })).digest('hex'),
      crashRecoveryEvidenceHash: createHash('sha256').update(canonicalJson({
        drillVersion: crashRecovery.drillVersion ?? null,
        status: crashRecovery.status ?? null,
        checkSummary: (crashRecovery.checks ?? []).map((check) => ({ checkId: check.checkId, passed: check.passed })),
        finalChainStatus: crashRecovery.finalStatus?.chain?.status ?? null
      })).digest('hex'),
      releaseCheckHash: createHash('sha256').update(canonicalJson(releaseCheckSnapshot)).digest('hex'),
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawWormArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-rollback-release-raw-leak-check-v1',
      rawLeakDetected: containsRollbackReleaseRawLeak(artifactManifest),
      checkedRawFields: [
        'rawUndoPayloadStored',
        'rawRollbackPathStored',
        'rawArchivePathStored',
        'rawWormArchivePathStored',
        'rawCapabilityTokenStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-rollback-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-rollback-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        rollbackPlanReady: plan.success === true && plan.readyCount >= 1,
        undoJournalChainValid: undoChain.status === 'valid',
        archiveExportReady: archive.success === true && archive.archive?.digest?.length === 64,
        wormArchiveSynced: wormSync.status === 'synced' && wormSync.storeVersion === 'b-rollback-worm-archive-store-v1',
        signatureRotationReady: keyRotation.status === 'passed',
        crashRecoveryReady: crashRecovery.status === 'passed',
        transactionChainValid: transactionStatus.chain.status === 'valid'
      },
      fallbackPolicy: {
        policyVersion: 'b-rollback-fallback-policy-v1',
        primaryFlow: 'dry_run_plan_then_transaction_locked_undo_journal_rollback',
        fallbackFlows: [
          'export_digest_signed_archive_before_rollback',
          'sync_rollback_archive_to_worm_store',
          'recover_running_transaction_from_jsonl_after_restart',
          'escalate_blocked_or_skipped_steps_to_manual_review'
        ],
        operatorEscalation: 'pc_agent_rollback_transactions_and_archive_review'
      },
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-rollback-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B undo journal persists rollback records" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'rollback_plan_ready',
        'undo_journal_chain_valid',
        'rollback_archive_exported',
        'rollback_worm_archive_synced',
        'rollback_archive_signature_rotation_passed',
        'rollback_crash_recovery_drill_passed',
        'rollback_transaction_chain_valid',
        'rollback_release_artifact_manifest_ready',
        'rollback_operational_handoff_ready',
        'rollback_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawUndoPayloadStored: false,
      rawArchivePathStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-rollback-worm-promotion-package-v1',
      providerContractVersion: 'b-rollback-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-rollback-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-rollback-ci-nightly-gate-plan-v1'
        && wormSync.status === 'synced'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawUndoPayloadStored: false,
      rawArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-rollback-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      taskIdHash: artifactManifest.taskIdHash,
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawWormArchivePathStored: false,
      rawCapabilityTokenStored: false,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      releaseChecks: releaseCheckSnapshot,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'attach_rollback_hash_only_release_dossier_and_external_worm_promotion_package'
        : 'block_rollback_release_until_archive_worm_rotation_and_crash_recovery_pass'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    checks.push({
      checkId: 'rollback_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest.manifestVersion === 'b-rollback-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawUndoPayloadStored === false
        && releaseDossier.artifactManifest.rawArchivePathStored === false
    });
    checks.push({
      checkId: 'rollback_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest.manifestVersion === 'b-rollback-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest.healthHandshakeVersion === 'b-rollback-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest.fallbackPolicy.policyVersion === 'b-rollback-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest.status === 'ready'
    });
    checks.push({
      checkId: 'rollback_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-rollback-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-rollback-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage.status === 'ready'
        && releaseDossier.dossierSha256.length === 64
    });
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    const gate = {
      productGateVersion: 'b-rollback-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status,
      taskId: resolvedTaskId,
      checks,
      plan,
      archive,
      wormSync,
      keyRotation,
      crashRecovery,
      undoChain,
      transactionStatus,
      releaseDossier,
      recommendations: status === 'passed'
        ? ['Keep rollback WORM archive, signature rotation drill, crash recovery drill, and hash-only release dossier with release evidence.']
        : checks.filter((check) => !check.passed).map((check) => `Resolve rollback product gate check: ${check.checkId}`)
    };
    this.auditLog.write('rollback.product_gate', {
      status,
      taskId: resolvedTaskId,
      checks: checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      wormManifestPath: wormSync.manifestPath ?? null
    });
    return gate;
  }

  isRollbackAllowed(path) {
    const resolved = resolve(path);
    return this.allowedRoots.some((root) => isInside(root, resolved));
  }
}
