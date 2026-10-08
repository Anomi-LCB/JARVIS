import {desktopPayloadWouldLoseContent} from '../../../packages/shared/src/desktop-request-integrity.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedOperations = new Set([
  'launch',
  'wait',
  'inspect',
  'focusWindow',
  'setFocus',
  'setValue',
  'sendKeys',
  'invoke',
  'clickElement',
  'toggle',
  'select',
  'expand',
  'collapse',
  'clickText',
  'clickTemplate'
]);

const allowedVerifications = new Set([
  'windowExists',
  'windowTitleContains',
  'elementExists',
  'elementValueEquals',
  'elementNameEquals',
  'elementNameContains',
  'elementEnabled'
]);

const blockedLaunchNames = new Set([
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe',
  'reg.exe', 'sc.exe', 'taskkill.exe', 'shutdown.exe', 'rundll32.exe'
]);

const blockedLaunchExtensions = new Set(['.ps1', '.psm1', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.hta']);

const blockedVisualTargetPatterns = [
  /비밀번호|암호|인증\s*코드|password|passcode|otp/i,
  /결제|구매|송금|이체|payment|purchase|buy\s+now|transfer\s+funds/i,
  /삭제|제거|초기화|포맷|delete|remove|uninstall|factory\s*reset|format/i,
  /모두\s*허용|항상\s*허용|allow\s*all|always\s*allow/i
];

export class WindowsDesktopControlToolAdapter {
  constructor({
    helperPath = fileURLToPath(new URL('./windows-desktop-control.ps1', import.meta.url)),
    powershellExecutable = 'powershell.exe',
    timeoutMs = 20000,
    runner = null,
    hostPlatform = platform(),
    allowedRoots = [process.cwd()]
  } = {}) {
    this.helperPath = helperPath;
    this.powershellExecutable = powershellExecutable;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
    this.hostPlatform = hostPlatform;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.contract = {
      toolName: 'desktop.control',
      readOnly: false,
      mutatesSystem: true,
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['operationCount', 'verification', 'observedWindow', 'interactiveSession', 'localOcrPerception', 'localTemplatePerception'],
      blockedOperations: ['passwordControlInput', 'scriptHostLaunch', 'unverifiedMutation', 'rawCoordinateClick', 'riskyVisualTarget', 'untrustedTemplate', 'ambiguousVisualTarget'],
      modes: ['shadow', 'execute']
    };
  }

  normalize(args = {}) {
    const normalizationIssues = [];
    if (Array.isArray(args.operations) && args.operations.length > 16) normalizationIssues.push('desktop-control-operation-limit-exceeded');
    if (Array.isArray(args.verification) && args.verification.length > 12) normalizationIssues.push('desktop-control-verification-limit-exceeded');
    if (args.verification !== undefined && !Array.isArray(args.verification)) normalizationIssues.push('desktop-control-verification-invalid');
    if (desktopPayloadWouldLoseContent(args)) normalizationIssues.push('desktop-control-payload-would-be-truncated');
    const target = sanitizeTarget(args.target);
    const operations = (Array.isArray(args.operations) ? args.operations : [])
      .slice(0, 16)
      .map((operation) => sanitizeOperation(operation))
      .map((operation) => this.prepareTemplateOperation(operation))
      .filter(Boolean);
    const verification = (Array.isArray(args.verification) ? args.verification : [])
      .slice(0, 12)
      .map((check) => sanitizeVerification(check))
      .filter(Boolean);
    if (Array.isArray(args.operations) && args.operations.slice(0,16).some(operation => !sanitizeOperation(operation))) normalizationIssues.push('desktop-control-operation-invalid');
    if (Array.isArray(args.verification) && args.verification.slice(0,12).some(check => !sanitizeVerification(check))) normalizationIssues.push('desktop-control-verification-invalid');
    const normalized = {
      target,
      operations,
      verification: verification.length ? verification : deriveVerification(operations, target),
      timeoutMs: clampNumber(args.timeoutMs, 500, 15000, 5000),
      ...(normalizationIssues.length ? { normalizationIssues } : {})
    };
    return normalized;
  }

  validate(request) {
    const issues = [...(request.normalizationIssues ?? [])];
    if (this.hostPlatform !== 'win32') issues.push('desktop-control-windows-only');
    if (!this.runner && !existsSync(this.helperPath)) issues.push('desktop-control-helper-missing');
    if (request.operations.length === 0) issues.push('desktop-control-operations-required');
    if (request.verification.length > 12) issues.push('desktop-control-verification-limit-exceeded');
    if (request.verification.some(check => check.type === 'elementEnabled' && check.expected !== undefined && !/^(true|false)$/i.test(String(check.expected).trim()))) {
      issues.push('desktop-control-enabled-state-invalid');
    }
    const changesState = request.operations.some(operation => ['invoke','clickElement','toggle','select','expand','collapse','sendKeys'].includes(operation.op));
    if (changesState && !request.verification.some(check => !['windowExists','elementExists'].includes(check.type))) {
      issues.push('desktop-control-state-postcondition-required');
    }
    const mutating = request.operations.filter((operation) => !['wait', 'inspect'].includes(operation.op));
    if (mutating.length > 0 && request.verification.length === 0) issues.push('desktop-control-verification-required');
    const needsTarget = request.operations.some((operation) => operation.op !== 'launch' && operation.op !== 'wait');
    if (needsTarget && !hasTargetSelector(request.target)) issues.push('desktop-control-target-required');
    for (const operation of request.operations) {
      if (!allowedOperations.has(operation.op)) issues.push(`desktop-operation-unsupported:${operation.op}`);
      if (operation.op === 'launch') {
        const fileName = basename(String(operation.filePath ?? '')).toLowerCase();
        const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
        if (!operation.filePath) issues.push('desktop-launch-path-required');
        if (blockedLaunchNames.has(fileName) || blockedLaunchExtensions.has(extension)) issues.push(`desktop-launch-blocked:${fileName}`);
      }
      if (operation.op === 'sendKeys' && !hasElementSelector(operation.selector)) {
        issues.push('desktop-sendkeys-element-selector-required');
      }
      if (operation.op === 'clickText') {
        if (!operation.text) issues.push('desktop-visual-text-required');
        if (blockedVisualTargetPatterns.some((pattern) => pattern.test(operation.text ?? ''))) {
          issues.push('desktop-visual-target-blocked');
        }
        const hasStatePostcondition = request.verification.some((check) => !['windowExists', 'elementExists'].includes(check.type));
        if (!hasStatePostcondition) issues.push('desktop-visual-click-postcondition-required');
      }
      if (operation.op === 'clickTemplate') {
        if (!operation.templatePath) issues.push('desktop-visual-template-required');
        if (!operation.targetLabel) issues.push('desktop-visual-template-label-required');
        if (blockedVisualTargetPatterns.some((pattern) => pattern.test(operation.targetLabel ?? ''))) {
          issues.push('desktop-visual-target-blocked');
        }
        if (!operation.templateHash || operation.templateTrusted !== true) issues.push('desktop-visual-template-untrusted');
        const hasStatePostcondition = request.verification.some((check) => !['windowExists', 'elementExists'].includes(check.type));
        if (!hasStatePostcondition) issues.push('desktop-visual-click-postcondition-required');
      }
      if (['setValue', 'setFocus', 'invoke', 'clickElement', 'toggle', 'select', 'expand', 'collapse'].includes(operation.op)
        && !hasElementSelector(operation.selector)) {
        issues.push(`desktop-element-selector-required:${operation.op}`);
      }
    }
    for (const check of request.verification) {
      if (!allowedVerifications.has(check.type)) issues.push(`desktop-verification-unsupported:${check.type}`);
      if (check.type.startsWith('element') && !hasElementSelector(check.selector)) {
        issues.push(`desktop-verification-selector-required:${check.type}`);
      }
    }
    return [...new Set(issues)];
  }

  prepareTemplateOperation(operation) {
    if (!operation || operation.op !== 'clickTemplate' || !operation.templatePath) return operation;
    const requestedPath = operation.templatePath;
    const candidate = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.allowedRoots[0] ?? process.cwd(), requestedPath);
    if (!isInsideAnyRoot(candidate, this.allowedRoots)) return operation;
    try {
      const realPath = realpathSync(candidate);
      if (!isInsideAnyRoot(realPath, this.allowedRoots)) return operation;
      const stats = statSync(realPath);
      const extension = extname(realPath).toLowerCase();
      if (!stats.isFile() || stats.size < 32 || stats.size > 4 * 1024 * 1024 || !['.png', '.bmp', '.jpg', '.jpeg'].includes(extension)) {
        return operation;
      }
      return {
        ...operation,
        templatePath: realPath,
        templateHash: createHash('sha256').update(readFileSync(realPath)).digest('hex'),
        templateTrusted: true
      };
    } catch {
      return operation;
    }
  }

  async shadow(args = {}) {
    const request = this.normalize(args);
    const warnings = this.validate(request);
    let observation = null;
    const hasLaunch = request.operations.some((operation) => operation.op === 'launch');
    if (warnings.length === 0 && !hasLaunch && hasTargetSelector(request.target)) {
      const probe = this.run({
        ...request,
        operations: [{ op: 'inspect' }],
        verification: [{ type: 'windowExists' }],
        timeoutMs: Math.min(request.timeoutMs, 1500)
      });
      observation = sanitizeHelperEvidence(probe);
      if (probe.status !== 'success') warnings.push(probe.error ?? 'desktop-target-preflight-failed');
    }
    return {
      mode: 'shadow',
      expectedChangesCount: request.operations.filter((operation) => !['wait', 'inspect'].includes(operation.op)).length,
      operationPlan: request.operations.map(operationPreview),
      verificationPlan: request.verification.map(verificationPreview),
      observation,
      warnings
    };
  }

  async execute(args = {}) {
    const request = this.normalize(args);
    const warnings = this.validate(request);
    if (warnings.length > 0) {
      return {
        status: 'blocked',
        error: warnings[0],
        summary: '데스크톱 제어 사전 검사를 통과하지 못했습니다.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings
      };
    }
    const result = this.run(request);
    const evidence = sanitizeHelperEvidence(result);
    if (result.status !== 'success' || result.verification?.passed !== true) {
      const changedItems = completedDesktopMutations(request, evidence, false);
      return {
        status: 'failed',
        error: result.error ?? 'desktop-control-verification-failed',
        summary: 'PC 조작 후 목표 상태를 확인하지 못했습니다.',
        outputPaths: [],
        changedItems,
        rollbackAvailable: false,
        operationCount: evidence.operationCount,
        verification: evidence.verification,
        observedWindow: evidence.observedWindow,
        interactiveSession: result.interactiveSession === true,
        sideEffectsMayHaveOccurred: changedItems.length > 0,
        evidence
      };
    }
    return {
      status: 'success',
      outputPaths: [],
      changedItems: request.operations
        .filter((operation) => !['wait', 'inspect'].includes(operation.op))
        .map((operation, index) => ({ type: 'desktop_interaction', operation: operation.op, sequenceIndex: index })),
      rollbackAvailable: false,
      operationCount: request.operations.length,
      verification: evidence.verification,
      observedWindow: evidence.observedWindow,
      interactiveSession: result.interactiveSession === true,
      evidence
    };
  }

  run(request) {
    if (this.runner) return this.runner(structuredClone(request));
    const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
    try {
      const stdout = execFileSync(this.powershellExecutable, [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.helperPath
      ], {
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, JARVIS_DESKTOP_REQUEST_BASE64: encoded }
      });
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
      return JSON.parse(line);
    } catch (error) {
      return {
        adapterVersion: 'b-windows-desktop-control-v1',
        status: 'failed',
        error: compact(error?.stderr || error?.message || error),
        interactiveSession: false,
        operations: [],
        verification: { passed: false, checks: [] },
        observedWindow: { found: false }
      };
    }
  }
}

function sanitizeTarget(value = {}) {
  return compactObject({
    processId: Number.isInteger(Number(value?.processId)) && Number(value.processId) > 0 ? Number(value.processId) : undefined,
    processName: cleanText(value?.processName, 120),
    title: cleanText(value?.title, 300),
    titleContains: cleanText(value?.titleContains, 300),
    className: cleanText(value?.className, 200)
  });
}

function sanitizeSelector(value = {}) {
  return compactObject({
    automationId: cleanText(value?.automationId, 240),
    name: cleanText(value?.name, 500),
    nameContains: cleanText(value?.nameContains, 500),
    className: cleanText(value?.className, 200),
    controlType: cleanText(value?.controlType, 80),
    index: Number.isInteger(Number(value?.index)) ? Math.max(0, Math.min(100, Number(value.index))) : undefined
  });
}

function sanitizeOperation(value = {}) {
  const op = cleanText(value?.op, 40);
  if (!op) return null;
  return compactObject({
    op,
    target: hasTargetSelector(value?.target) ? sanitizeTarget(value.target) : undefined,
    selector: hasElementSelector(value?.selector) ? sanitizeSelector(value.selector) : undefined,
    filePath: cleanText(value?.filePath, 500),
    arguments: Array.isArray(value?.arguments) ? value.arguments.slice(0, 16).map((item) => cleanText(item, 500)).filter(Boolean) : undefined,
    value: value?.value === undefined || value?.value === null ? undefined : String(value.value).slice(0, 8000),
    keys: cleanText(value?.keys, 2000),
    text: cleanText(value?.text, 500),
    targetLabel: cleanText(value?.targetLabel, 300),
    templatePath: cleanText(value?.templatePath, 1000),
    minConfidence: op === 'clickTemplate' ? clampNumber(value?.minConfidence, 0.8, 0.995, 0.9) : undefined,
    scaleTolerance: op === 'clickTemplate' ? clampNumber(value?.scaleTolerance, 0, 0.35, 0.2) : undefined,
    ambiguityGap: op === 'clickTemplate' ? clampNumber(value?.ambiguityGap, 0.01, 0.25, 0.03) : undefined,
    matchMode: ['exact', 'contains'].includes(String(value?.matchMode ?? '').toLowerCase())
      ? String(value.matchMode).toLowerCase()
      : undefined,
    occurrence: Number.isInteger(Number(value?.occurrence))
      ? Math.max(0, Math.min(20, Number(value.occurrence)))
      : undefined,
    timeoutMs: value?.timeoutMs === undefined ? undefined : clampNumber(value.timeoutMs, 0, 15000, 1000)
  });
}

function sanitizeVerification(value = {}) {
  const type = cleanText(value?.type, 60);
  if (!type) return null;
  return compactObject({
    type,
    target: hasTargetSelector(value?.target) ? sanitizeTarget(value.target) : undefined,
    selector: hasElementSelector(value?.selector) ? sanitizeSelector(value.selector) : undefined,
    expected: value?.expected === undefined || value?.expected === null ? undefined : String(value.expected).slice(0, 8000),
    timeoutMs: value?.timeoutMs === undefined ? undefined : clampNumber(value.timeoutMs, 0, 15000, 1000)
  });
}

function deriveVerification(operations, target) {
  const checks = [];
  if (hasTargetSelector(target) && operations.some((operation) => !['wait'].includes(operation.op))) {
    checks.push({ type: 'windowExists' });
  }
  for (const operation of operations) {
    if (operation.op === 'setValue') {
      checks.push({ type: 'elementValueEquals', selector: operation.selector, expected: operation.value });
    } else if (['invoke', 'clickElement', 'toggle', 'select', 'expand', 'collapse', 'setFocus', 'sendKeys'].includes(operation.op)) {
      checks.push({ type: 'elementExists', selector: operation.selector });
    }
  }
  return checks;
}

function operationPreview(operation) {
  return compactObject({
    op: operation.op,
    target: operation.target,
    selector: operation.selector,
    filePath: operation.filePath,
    argumentCount: operation.arguments?.length,
    valueLength: operation.value?.length,
    keysLength: operation.keys?.length,
    textLength: operation.text?.length,
    targetLabelLength: operation.targetLabel?.length,
    templateName: operation.templatePath ? basename(operation.templatePath) : undefined,
    templateHash: operation.templateHash,
    minConfidence: operation.minConfidence,
    scaleTolerance: operation.scaleTolerance,
    ambiguityGap: operation.ambiguityGap,
    matchMode: operation.matchMode,
    occurrence: operation.occurrence,
    timeoutMs: operation.timeoutMs
  });
}

function verificationPreview(check) {
  return compactObject({
    type: check.type,
    target: check.target,
    selector: check.selector,
    expectedLength: check.expected?.length,
    timeoutMs: check.timeoutMs
  });
}

function sanitizeHelperEvidence(result = {}) {
  return {
    adapterVersion: result.adapterVersion ?? 'b-windows-desktop-control-v1',
    status: result.status ?? 'failed',
    interactiveSession: result.interactiveSession === true,
    operationCount: Number(result.operationCount ?? result.operations?.length ?? 0),
    operations: (result.operations ?? []).map((item) => compactObject({
      op: cleanText(item?.op, 40),
      status: cleanText(item?.status, 40),
      durationMs: Number(item?.durationMs ?? 0),
      processId: Number(item?.processId ?? 0) || undefined,
      element: item?.element,
      window: item?.window,
      perception: sanitizePerception(item?.perception)
    })),
    verification: {
      passed: result.verification?.passed === true,
      checks: (result.verification?.checks ?? []).map((check) => compactObject({
        type: cleanText(check?.type, 60),
        passed: check?.passed === true,
        reason: cleanText(check?.reason, 120),
        expectedHash: cleanText(check?.expectedHash, 80),
        actualHash: cleanText(check?.actualHash, 80),
        actual: typeof check?.actual === 'boolean' ? check.actual : undefined
      }))
    },
    observedWindow: result.observedWindow ?? { found: false },
    failedOperation: cleanText(result.failedOperation, 40),
    desktopLease: compactObject({
      serialized: result.desktopLease?.serialized === true,
      waitMs: Number.isFinite(Number(result.desktopLease?.waitMs)) ? Number(result.desktopLease.waitMs) : undefined,
      abandonedRecovered: result.desktopLease?.abandonedRecovered === true
    }),
    diagnostics: sanitizeDesktopDiagnostics(result.diagnostics)
  };
}

function completedDesktopMutations(request, evidence, verified) {
  return request.operations.flatMap((operation, index) => {
    if (['wait', 'inspect'].includes(operation.op)) return [];
    if (evidence.operations?.[index]?.status !== 'completed') return [];
    return [{
      type: 'desktop_interaction',
      operation: operation.op,
      sequenceIndex: index,
      verificationStatus: verified ? 'verified' : 'unverified'
    }];
  });
}

function sanitizeDesktopDiagnostics(value) {
  if (!value || typeof value !== 'object') return undefined;
  return compactObject({
    kind: cleanText(value.kind, 40),
    status: cleanText(value.status, 40),
    matchCount: Number.isInteger(Number(value.matchCount)) ? Number(value.matchCount) : undefined,
    candidateCount: Number.isInteger(Number(value.candidateCount)) ? Number(value.candidateCount) : undefined,
    wordCount: Number.isInteger(Number(value.wordCount)) ? Number(value.wordCount) : undefined,
    captureWidth: Number.isInteger(Number(value.captureWidth)) ? Number(value.captureWidth) : undefined,
    captureHeight: Number.isInteger(Number(value.captureHeight)) ? Number(value.captureHeight) : undefined,
    captureHash: cleanText(value.captureHash, 80),
    captureMode: cleanText(value.captureMode, 40)
  });
}

function sanitizePerception(value) {
  if (!value || typeof value !== 'object') return undefined;
  return compactObject({
    adapterVersion: cleanText(value.adapterVersion, 80),
    engine: cleanText(value.engine, 80),
    languageTag: cleanText(value.languageTag, 40),
    queryHash: cleanText(value.queryHash, 80),
    matchMode: cleanText(value.matchMode, 20),
    matchCount: Number.isInteger(Number(value.matchCount)) ? Number(value.matchCount) : undefined,
    candidateCount: Number.isInteger(Number(value.candidateCount)) ? Number(value.candidateCount) : undefined,
    selectedIndex: Number.isInteger(Number(value.selectedIndex)) ? Number(value.selectedIndex) : undefined,
    wordCount: Number.isInteger(Number(value.wordCount)) ? Number(value.wordCount) : undefined,
    captureHash: cleanText(value.captureHash, 80),
    captureMode: cleanText(value.captureMode, 40),
    templateHash: cleanText(value.templateHash, 80),
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : undefined,
    secondConfidence: Number.isFinite(Number(value.secondConfidence)) ? Number(value.secondConfidence) : undefined,
    ambiguityGap: Number.isFinite(Number(value.ambiguityGap)) ? Number(value.ambiguityGap) : undefined,
    selectedScale: Number.isFinite(Number(value.selectedScale)) ? Number(value.selectedScale) : undefined,
    screenshotStored: value.screenshotStored === true,
    rawOcrTextStored: value.rawOcrTextStored === true,
    rawPixelsStored: value.rawPixelsStored === true,
    templateCopied: value.templateCopied === true,
    foregroundVerified: value.foregroundVerified === true
  });
}

function isInsideAnyRoot(path, roots) {
  return roots.some((root) => {
    const rel = relative(resolve(root), resolve(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function hasTargetSelector(value) {
  return Boolean(value && (value.processId || value.processName || value.title || value.titleContains || value.className));
}

function hasElementSelector(value) {
  return Boolean(value && (value.automationId || value.name || value.nameContains || value.className || value.controlType));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function cleanText(value, maxLength) {
  return value === undefined || value === null ? undefined : String(value).replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLength) || undefined;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}
