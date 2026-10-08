import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const reportIndexBatchStorage = new AsyncLocalStorage();
const reservedReportIds = new Set(['report-index', 'report-worm-manifest']);
const reportStorageKeyVersion = 'g-report-storage-key-v1';
const mappedReportStorageKeyPrefix = 'report-id-v1-';
const cleanupApprovalScopeVersion = 'g-report-cleanup-approval-scope-v1';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export class VerificationReportStore {
  constructor({
    reportDir = 'apps/verification/reports',
    immutableArtifactRoot = null,
    cleanupApproverValidator = defaultCleanupApproverValidator
  } = {}) {
    this.reportDir = reportDir;
    this.indexPath = join(this.reportDir, 'report-index.json');
    this.cleanupApprovals = new Map();
    this.cleanupApproverValidator = cleanupApproverValidator;
    this.immutableArtifactRoot = immutableArtifactRoot ?? join(this.reportDir, 'report-worm-artifact-store');
    this.immutableArtifactRoots = immutableArtifactRoot
      ? [resolve(immutableArtifactRoot)]
      : [...new Set([
          resolve(this.immutableArtifactRoot),
          resolve(dirname(this.reportDir), 'report-worm-artifact-store')
        ])];
    mkdirSync(this.reportDir, { recursive: true });
    this.indexMtimeMs = null;
    this.indexItems = this.loadIndexFromDisk();
  }

  async runIndexBatch(callback, { operation = 'verification-index-batch' } = {}) {
    const parent = reportIndexBatchStorage.getStore();
    if (parent?.store === this) return await callback();
    const context = {
      batchVersion: 'g-report-index-operation-batch-v1',
      operation,
      store: this,
      entries: new Map(),
      startedAt: new Date().toISOString()
    };
    return await reportIndexBatchStorage.run(context, async () => {
      let result;
      let operationError = null;
      try {
        result = await callback();
      } catch (error) {
        operationError = error;
      }
      try {
        this.flushIndexEntries([...context.entries.values()]);
      } catch (flushError) {
        if (operationError && typeof operationError === 'object') {
          operationError.reportIndexFlushError = flushError?.message ?? String(flushError);
        } else {
          operationError = flushError;
        }
      }
      if (operationError) throw operationError;
      return result;
    });
  }

  save(report) {
    const reportId = requireValidLogicalReportId(report?.verificationId);
    const { storageKey, jsonPath, htmlPath } = this.currentReportPaths(reportId);
    const storedReport = this.sanitize({
      ...report,
      verificationId: reportId,
      evidence: {
        ...report.evidence,
        reportJsonPath: jsonPath,
        reportHtmlPath: htmlPath
      }
    });
    writeFileSync(jsonPath, JSON.stringify(storedReport, null, 2), 'utf8');
    writeFileSync(htmlPath, this.renderHtml(storedReport), 'utf8');
    this.upsertIndex(storedReport, { storageKey, jsonPath, htmlPath });
    return { jsonPath, htmlPath };
  }

  sanitize(value) {
    if (typeof value === 'string') {
      return value
        .replace(/\b(?:authorization\s*[:=]\s*)?bearer\s+[a-z0-9._~+\/-]+=*/gi, 'authorization=[masked]')
        .replace(/api[_-]?key\s*[:=]\s*[\w.-]+/gi, 'api_key=[masked]')
        .replace(/token\s*[:=]\s*[\w.-]+/gi, 'token=[masked]')
        .replace(/password\s*[:=]\s*\S+/gi, 'password=[masked]')
        .replace(/\b010[-.\s]?\d{4}[-.\s]?\d{4}\b/g, '[masked-phone]');
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveReportKey(key) ? '[masked]' : this.sanitize(entry)
      ]));
    }
    return value;
  }

  read(reportId) {
    if (!isValidLogicalReportId(reportId)) return null;
    const logicalReportId = String(reportId);
    const candidates = [this.currentReportPaths(logicalReportId).jsonPath];
    const indexed = this.readIndex().find((item) => item.reportId === logicalReportId);
    if (indexed?.jsonPath) candidates.push(indexed.jsonPath);
    const legacy = this.legacyReportPaths(logicalReportId);
    if (legacy?.jsonPath) candidates.push(legacy.jsonPath);
    for (const jsonPath of new Set(candidates)) {
      if (!exactFileExists(jsonPath)) continue;
      try {
        const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
        if (String(report?.verificationId ?? '') === logicalReportId) return report;
      } catch {
        // Try the next deterministic, confined compatibility path.
      }
    }
    return null;
  }

  index() {
    return {
      indexVersion: 'g-report-index-v1',
      reportDir: this.reportDir,
      items: this.readIndex()
    };
  }

  trend({ limit = 50 } = {}) {
    const items = this.readIndex()
      .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
      .slice(0, limit);
    const byStatus = {};
    for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    const scores = items.map((item) => Number(item.score)).filter(Number.isFinite);
    return {
      trendVersion: 'g-report-trend-v1',
      generatedAt: new Date().toISOString(),
      totalReports: items.length,
      byStatus,
      averageScore: scores.length ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10 : null,
      latest: items[0] ?? null,
      scoreTrend: items
        .slice()
        .reverse()
        .map((item) => ({ reportId: item.reportId, status: item.status, score: item.score, createdAt: item.createdAt }))
    };
  }

  diff({ baseReportId, currentReportId, baseReport = null, currentReport = null } = {}) {
    const base = baseReport ?? this.read(baseReportId);
    const current = currentReport ?? this.read(currentReportId);
    if (!base?.checks || !current?.checks) {
      return { success: false, error: { code: 'G_REPORT_DIFF_SOURCE_NOT_FOUND' } };
    }
    const expected = new Map(base.checks.map((check) => [check.checkId, check]));
    const actual = new Map(current.checks.map((check) => [check.checkId, check]));
    const diffs = [];
    if (base.status !== current.status) {
      diffs.push({ type: 'report_status_changed', expectedStatus: base.status, actualStatus: current.status });
    }
    if (Number(current.score) !== Number(base.score)) {
      diffs.push({ type: 'report_score_changed', expectedScore: base.score, actualScore: current.score });
    }
    for (const [checkId, check] of expected.entries()) {
      if (!actual.has(checkId)) {
        diffs.push({ type: 'missing_check', checkId, expectedStatus: check.status });
      } else if (actual.get(checkId).status !== check.status) {
        diffs.push({ type: 'check_status_changed', checkId, expectedStatus: check.status, actualStatus: actual.get(checkId).status });
      }
    }
    for (const [checkId, check] of actual.entries()) {
      if (!expected.has(checkId)) {
        diffs.push({ type: 'new_check', checkId, actualStatus: check.status });
      }
    }
    return {
      success: true,
      diffVersion: 'g-report-diff-v1',
      baseReportId: base.verificationId,
      currentReportId: current.verificationId,
      status: diffs.length ? 'changed' : 'unchanged',
      diffs
    };
  }

  cleanup({ keepLast = 100, maxAgeMs = null, dryRun = true } = {}) {
    const plan = this.retentionPlan({ keepLast, maxAgeMs });
    const removed = [];
    const incompleteReportIds = plan.removable
      .filter((item) => this.reportArtifactState(item.reportId).presentCount === 1)
      .map((item) => item.reportId);
    if (!dryRun && incompleteReportIds.length > 0) {
      return {
        cleanupVersion: 'g-report-cleanup-v1',
        status: 'blocked_incomplete_artifacts',
        dryRun,
        keepLast,
        maxAgeMs,
        removableCount: plan.removable.length,
        retainedCount: plan.retained.length,
        removable: plan.removable,
        removed,
        incompleteReportIds
      };
    }
    if (!dryRun) {
      for (const item of plan.removable) {
        for (const path of this.reportArtifactPaths(item, { includeLegacy: true })) {
          if (path && exactFileExists(path)) {
            try {
              unlinkSync(path);
              removed.push(path);
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error;
            }
          }
        }
      }
      this.writeIndex(plan.retained);
    }
    return {
      cleanupVersion: 'g-report-cleanup-v1',
      status: dryRun ? 'dry_run' : 'executed',
      dryRun,
      keepLast,
      maxAgeMs,
      removableCount: plan.removable.length,
      retainedCount: plan.retained.length,
      removable: plan.removable,
      removed,
      incompleteReportIds
    };
  }

  syncImmutableArtifacts({
    targetDir = this.immutableArtifactRoot,
    dryRun = true,
    keepLast = 100
  } = {}) {
    const confinedTargetDir = this.requireImmutableTargetDir(targetDir, { create: !dryRun });
    const items = this.readIndex()
      .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
      .slice(0, Math.max(1, Number(keepLast) || 100));
    const artifacts = [];
    for (const item of items) {
      const storageKey = reportStorageKey(item.reportId);
      const artifactState = this.reportArtifactState(item.reportId);
      if (artifactState.presentCount === 0) continue;
      for (const artifact of [artifactState.json, artifactState.html]) {
        const { artifactType, path: sourcePath, present } = artifact;
        if (!present) {
          artifacts.push({
            artifactId: `${item.reportId}:${artifactType}`,
            reportId: item.reportId,
            artifactType,
            sourcePath,
            sourceVariant: artifact.variant,
            destinationPath: null,
            sourceSha256: null,
            destinationSha256: null,
            sizeBytes: 0,
            status: 'missing',
            immutable: false
          });
          continue;
        }
        const sourceSha256 = this.fileSha256(sourcePath);
        const destinationPath = join(confinedTargetDir, `${storageKey}-${sourceSha256}.${artifactType}`);
        let destinationExists = exactFileExists(destinationPath);
        let copiedThisRun = false;
        if (!dryRun && !destinationExists) {
          try {
            copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
            copiedThisRun = true;
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
          }
          destinationExists = exactFileExists(destinationPath);
        }
        const finalDestinationSha256 = destinationExists ? this.fileSha256(destinationPath) : null;
        const conflict = destinationExists && finalDestinationSha256 !== sourceSha256;
        const copied = copiedThisRun && destinationExists && finalDestinationSha256 === sourceSha256;
        const artifactStatus = conflict ? 'conflict' : (copied ? 'copied' : (destinationExists ? 'already_present' : 'pending'));
        artifacts.push({
          artifactId: `${item.reportId}:${artifactType}`,
          reportId: item.reportId,
          artifactType,
          sourcePath,
          sourceVariant: artifact.variant,
          destinationPath,
          sourceSha256,
          destinationSha256: finalDestinationSha256,
          sizeBytes: statSync(sourcePath).size,
          status: artifactStatus,
          immutable: ['copied', 'already_present'].includes(artifactStatus)
        });
      }
    }
    const conflictCount = artifacts.filter((item) => item.status === 'conflict').length;
    const missingArtifactCount = artifacts.filter((item) => item.status === 'missing').length;
    const pendingArtifactCount = artifacts.filter((item) => item.status === 'pending').length;
    const copiedCount = artifacts.filter((item) => item.status === 'copied').length;
    const verifiedCount = artifacts.filter((item) => ['copied', 'already_present'].includes(item.status)).length;
    const status = conflictCount
      ? 'conflict'
      : (missingArtifactCount || (!dryRun && pendingArtifactCount)
          ? 'incomplete'
          : (artifacts.length ? (dryRun ? 'dry_run' : 'synced') : 'empty'));
    const manifestCore = {
      manifestVersion: 'g-report-worm-manifest-v1',
      generatedAt: new Date().toISOString(),
      reportDir: this.reportDir,
      targetDir: confinedTargetDir,
      status,
      missingArtifactCount,
      pendingArtifactCount,
      artifacts
    };
    const manifestScopeSha256 = createHash('sha256').update(JSON.stringify(manifestCore)).digest('hex');
    const manifest = { ...manifestCore, manifestScopeSha256 };
    const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = createHash('sha256').update(serializedManifest).digest('hex');
    const manifestPath = join(confinedTargetDir, `report-worm-manifest-${manifestSha256}.json`);
    if (!dryRun) writeImmutableText(manifestPath, serializedManifest);
    return {
      syncVersion: 'g-report-immutable-artifact-sync-v1',
      generatedAt: manifest.generatedAt,
      status,
      dryRun,
      targetDir: confinedTargetDir,
      manifestPath,
      manifestSha256,
      artifactStore: {
        storeVersion: 'g-report-worm-artifact-store-v1',
        adapter: 'local-worm-mirror',
        retentionDays: 365,
        immutableWritePolicy: {
          appendOnly: true,
          overwriteAllowed: false,
          deleteAllowed: false
        }
      },
      totalReports: items.length,
      artifactCount: artifacts.length,
      copiedCount,
      verifiedCount,
      conflictCount,
      missingArtifactCount,
      pendingArtifactCount,
      artifacts
    };
  }

  retentionPolicyUi({ keepLast = 100, maxAgeMs = null } = {}) {
    const retention = this.retentionDashboard({ keepLast, maxAgeMs });
    const syncPreview = this.syncImmutableArtifacts({ keepLast, dryRun: true });
    return {
      uiContractVersion: 'g-report-retention-policy-ui-v1',
      generatedAt: new Date().toISOString(),
      status: retention.dashboardVersion === 'g-report-retention-dashboard-v1' ? 'ready' : 'needs_attention',
      reportDir: this.reportDir,
      policyControls: [
        { controlId: 'keepLast', component: 'stepper', value: keepLast, min: 1, max: 1000 },
        { controlId: 'maxAgeMs', component: 'number-input', value: maxAgeMs, nullable: true },
        { controlId: 'dryRun', component: 'toggle', value: true },
        { controlId: 'approvalRequired', component: 'toggle', value: true, locked: true }
      ],
      actions: {
        previewCleanup: { method: 'GET', endpoint: '/reports/retention' },
        requestCleanupApproval: { method: 'POST', endpoint: '/reports/cleanup/approval' },
        executeApprovedCleanup: { method: 'POST', endpoint: '/reports/cleanup/approval' },
        syncImmutableArtifacts: { method: 'POST', endpoint: '/reports/artifacts/sync' },
        openTrendVisualization: { method: 'GET', endpoint: '/reports/trend/visualization' }
      },
      approvalWorkflow: {
        workflowVersion: 'g-report-cleanup-approval-workflow-v1',
        approvalScopeVersion: cleanupApprovalScopeVersion,
        requiredForExecute: true,
        oneTimeApproval: true,
        approverValidationContract: 'g-report-cleanup-approver-validation-v1',
        requiredFields: ['requestedBy', 'reason', 'approvedBy', 'approvalId'],
        requestFields: ['requestedBy', 'reason', 'keepLast', 'maxAgeMs'],
        executeFields: ['approvedBy', 'approvalId']
      },
      retention,
      immutableSyncPreview: {
        syncVersion: syncPreview.syncVersion,
        status: syncPreview.status,
        artifactStore: syncPreview.artifactStore,
        artifactCount: syncPreview.artifactCount
      },
      rows: retention.removable
    };
  }

  cleanupApprovalWorkflow(request = {}) {
    const execute = request.execute === true;
    const dryRun = request.dryRun !== false;
    const requestedPolicy = normalizeCleanupPolicy({
      keepLast: request.keepLast,
      maxAgeMs: request.maxAgeMs
    });

    if (!execute) {
      const cleanupPreview = this.cleanup({ ...requestedPolicy, dryRun: true });
      const requestedBy = String(request.requestedBy ?? 'verification-admin').trim();
      const normalizedReason = String(request.reason ?? '').trim();
      const suppliedApprovalId = String(request.approvalId ?? '').trim();
      const generatedApprovalId = suppliedApprovalId || `g-report-cleanup-approval-${randomUUID()}`;
      if (this.cleanupApprovals.has(generatedApprovalId)) {
        return this.cleanupApprovalResponse({
          status: 'blocked_duplicate_approval_id',
          approval: this.cleanupApprovals.get(generatedApprovalId),
          cleanupPreview
        });
      }
      const approvalFingerprint = this.cleanupPlanFingerprint(requestedPolicy, cleanupPreview.removable);
      const approval = {
        approvalId: generatedApprovalId,
        approvalVersion: 'g-report-cleanup-approval-v1',
        approvalScopeVersion: cleanupApprovalScopeVersion,
        approvalFingerprint,
        status: 'pending_approval',
        requestedBy,
        reason: normalizedReason,
        requestedAt: new Date().toISOString(),
        policy: requestedPolicy,
        removableCount: cleanupPreview.removableCount,
        removableBytes: cleanupPreview.removable.reduce((sum, item) => sum + this.reportBytes(item), 0),
        removableReportIds: cleanupPreview.removable.map((item) => item.reportId)
      };
      this.cleanupApprovals.set(generatedApprovalId, approval);
      return this.cleanupApprovalResponse({ status: approval.status, approval, cleanupPreview });
    }

    const approvalId = String(request.approvalId ?? '');
    const approval = this.cleanupApprovals.get(approvalId);
    if (!approval || !request.approvedBy) {
      const cleanupPreview = this.cleanup({ ...requestedPolicy, dryRun: true });
      return this.cleanupApprovalResponse({
        status: 'blocked_missing_approval',
        approval: approval ?? { approvalId, status: 'missing' },
        cleanupPreview
      });
    }
    const cleanupPreview = this.cleanup({ ...approval.policy, dryRun: true });
    if (approval.status !== 'pending_approval') {
      return this.cleanupApprovalResponse({
        status: 'blocked_approval_not_pending',
        approval,
        cleanupPreview
      });
    }

    const suppliedPolicyFields = ['keepLast', 'maxAgeMs'].filter((key) => Object.prototype.hasOwnProperty.call(request, key));
    if (suppliedPolicyFields.some((key) => !Object.is(requestedPolicy[key], approval.policy[key]))) {
      return this.cleanupApprovalResponse({
        status: 'blocked_approval_scope_mismatch',
        approval,
        cleanupPreview
      });
    }

    const currentFingerprint = this.cleanupPlanFingerprint(approval.policy, cleanupPreview.removable);
    if (currentFingerprint !== approval.approvalFingerprint) {
      const invalidatedApproval = {
        ...approval,
        status: 'invalidated_stale',
        invalidatedAt: new Date().toISOString(),
        currentFingerprint
      };
      this.cleanupApprovals.set(approvalId, invalidatedApproval);
      return this.cleanupApprovalResponse({
        status: 'blocked_stale_approval',
        approval: invalidatedApproval,
        cleanupPreview
      });
    }

    const approverValidation = this.validateCleanupApprover({ approval, approvedBy: request.approvedBy });
    if (!approverValidation.valid) {
      return this.cleanupApprovalResponse({
        status: 'blocked_invalid_approver',
        approval: { ...approval, approverValidation },
        cleanupPreview
      });
    }

    const executingApproval = {
      ...approval,
      status: 'executing',
      approvedBy: approverValidation.approvedBy,
      approverValidation,
      approvedAt: new Date().toISOString(),
      executionDryRun: dryRun
    };
    this.cleanupApprovals.set(approvalId, executingApproval);
    let execution;
    try {
      execution = this.cleanup({ ...approval.policy, dryRun });
    } catch (error) {
      this.cleanupApprovals.set(approvalId, {
        ...executingApproval,
        status: 'execution_failed',
        failedAt: new Date().toISOString()
      });
      throw error;
    }
    if (execution.status === 'blocked_incomplete_artifacts') {
      const blockedApproval = {
        ...executingApproval,
        status: 'execution_blocked_incomplete_artifacts'
      };
      this.cleanupApprovals.set(approvalId, blockedApproval);
      return this.cleanupApprovalResponse({
        status: 'blocked_incomplete_artifacts',
        approval: blockedApproval,
        cleanupPreview,
        execution
      });
    }
    const completedApproval = {
      ...executingApproval,
      status: dryRun ? 'approved_dry_run' : 'executed',
      completedAt: new Date().toISOString()
    };
    this.cleanupApprovals.set(approvalId, completedApproval);
    return this.cleanupApprovalResponse({
      status: completedApproval.status,
      approval: completedApproval,
      cleanupPreview,
      execution
    });
  }

  cleanupApprovalResponse({ status, approval, cleanupPreview, execution = null }) {
    return {
      workflowVersion: 'g-report-cleanup-approval-workflow-v1',
      generatedAt: new Date().toISOString(),
      status,
      approvalRequired: true,
      approval,
      cleanupPreview,
      execution
    };
  }

  longTermTrendVisualization({
    limit = 100,
    htmlPath = join(this.reportDir, 'report-long-term-trend.html')
  } = {}) {
    const trend = this.trend({ limit });
    const retention = this.retentionDashboard({ keepLast: Math.max(1, Number(limit) || 100) });
    const immutableSyncPreview = this.syncImmutableArtifacts({ keepLast: Math.max(1, Number(limit) || 100), dryRun: true });
    const statusBucketsByDay = this.statusBucketsByDay(trend.scoreTrend);
    const rows = trend.scoreTrend.map((item) => `
      <tr>
        <td>${escapeHtml(item.createdAt ?? '')}</td>
        <td>${escapeHtml(item.reportId)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.score)}</td>
      </tr>`).join('');
    mkdirSync(this.reportDir, { recursive: true });
    writeFileSync(htmlPath, `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>JARVIS Report Long-Term Trend</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #15201a; }
    .metric { display: inline-block; margin-right: 16px; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #c8d5cd; padding: 8px; text-align: left; }
    th { background: #edf6ef; }
  </style>
</head>
<body>
  <h1>Report Long-Term Trend</h1>
  <p>
    <span class="metric"><strong>Reports:</strong> ${escapeHtml(trend.totalReports)}</span>
    <span class="metric"><strong>Average score:</strong> ${escapeHtml(trend.averageScore ?? 'n/a')}</span>
    <span class="metric"><strong>Retention:</strong> ${escapeHtml(retention.status)}</span>
    <span class="metric"><strong>WORM sync:</strong> ${escapeHtml(immutableSyncPreview.status)}</span>
  </p>
  <table>
    <thead><tr><th>Created</th><th>Report</th><th>Status</th><th>Score</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No reports</td></tr>'}</tbody>
  </table>
</body>
</html>`, 'utf8');
    return {
      visualizationVersion: 'g-report-long-term-trend-visualization-v1',
      generatedAt: new Date().toISOString(),
      status: trend.totalReports > 0 ? 'ready' : 'empty',
      limit,
      reportCount: trend.totalReports,
      statusBucketsByDay,
      scoreTrend: trend.scoreTrend,
      retention: {
        dashboardVersion: retention.dashboardVersion,
        status: retention.status,
        totalReports: retention.totalReports,
        removableCount: retention.removableCount
      },
      immutableSyncPreview: {
        syncVersion: immutableSyncPreview.syncVersion,
        status: immutableSyncPreview.status,
        artifactStore: immutableSyncPreview.artifactStore,
        artifactCount: immutableSyncPreview.artifactCount
      },
      artifact: {
        written: true,
        artifactVersion: 'g-report-long-term-trend-html-v1',
        htmlPath
      }
    };
  }

  productGate({
    keepLast = 100,
    artifactDryRun = false,
    cleanupRequestedBy = 'verification-product-gate'
  } = {}) {
    const index = this.index();
    const retentionPolicyUi = this.retentionPolicyUi({ keepLast });
    const longTermTrend = this.longTermTrendVisualization({ limit: keepLast });
    const immutableArtifactSync = this.syncImmutableArtifacts({ keepLast, dryRun: artifactDryRun });
    const cleanupApprovalWorkflow = this.cleanupApprovalWorkflow({
      keepLast,
      requestedBy: cleanupRequestedBy,
      reason: 'Product gate preview for report artifact retention.'
    });
    const checks = [
      {
        checkId: 'report_index_available',
        passed: index.indexVersion === 'g-report-index-v1' && index.items.length >= 1
      },
      {
        checkId: 'report_retention_policy_ui_ready',
        passed: retentionPolicyUi.uiContractVersion === 'g-report-retention-policy-ui-v1'
          && retentionPolicyUi.approvalWorkflow.workflowVersion === 'g-report-cleanup-approval-workflow-v1'
      },
      {
        checkId: 'report_long_term_trend_visualized',
        passed: longTermTrend.visualizationVersion === 'g-report-long-term-trend-visualization-v1'
          && longTermTrend.artifact?.artifactVersion === 'g-report-long-term-trend-html-v1'
          && longTermTrend.artifact?.written === true
      },
      {
        checkId: 'report_immutable_worm_sync_ready',
        passed: immutableArtifactSync.syncVersion === 'g-report-immutable-artifact-sync-v1'
          && ['dry_run', 'synced'].includes(immutableArtifactSync.status)
          && immutableArtifactSync.artifactStore.storeVersion === 'g-report-worm-artifact-store-v1'
          && immutableArtifactSync.artifactCount >= 1
      },
      {
        checkId: 'report_cleanup_approval_workflow_ready',
        passed: cleanupApprovalWorkflow.workflowVersion === 'g-report-cleanup-approval-workflow-v1'
          && cleanupApprovalWorkflow.status === 'pending_approval'
          && cleanupApprovalWorkflow.approvalRequired === true
      }
    ];
    return {
      productGateVersion: 'g-report-store-product-gate-v1',
      generatedAt: new Date().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      index,
      retentionPolicyUi,
      longTermTrend,
      immutableArtifactSync,
      cleanupApprovalWorkflow
    };
  }

  retentionDashboard({ keepLast = 100, maxAgeMs = null } = {}) {
    const plan = this.retentionPlan({ keepLast, maxAgeMs });
    const allItems = [...plan.retained, ...plan.removable];
    const storageBytes = allItems.reduce((sum, item) => sum + this.reportBytes(item), 0);
    const removableBytes = plan.removable.reduce((sum, item) => sum + this.reportBytes(item), 0);
    const createdTimes = allItems
      .map((item) => Date.parse(item.createdAt ?? ''))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    return {
      dashboardVersion: 'g-report-retention-dashboard-v1',
      generatedAt: new Date().toISOString(),
      policy: {
        keepLast,
        maxAgeMs,
        cleanupEndpoint: '/reports/cleanup/approval',
        cleanupMode: 'approval_bound_execute'
      },
      status: plan.removable.length > 0 ? 'rotation_recommended' : 'ok',
      reportDir: this.reportDir,
      totalReports: allItems.length,
      retainedCount: plan.retained.length,
      removableCount: plan.removable.length,
      storageBytes,
      removableBytes,
      oldestCreatedAt: createdTimes.length ? new Date(createdTimes[0]).toISOString() : null,
      newestCreatedAt: createdTimes.length ? new Date(createdTimes.at(-1)).toISOString() : null,
      ageBuckets: this.ageBuckets(allItems),
      removable: plan.removable.map((item) => ({
        reportId: item.reportId,
        status: item.status,
        score: item.score,
        createdAt: item.createdAt,
        reason: item.reason,
        bytes: this.reportBytes(item)
      }))
    };
  }

  retentionPlan({ keepLast = 100, maxAgeMs = null, nowMs = Date.now() } = {}) {
    const items = this.readIndex().sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
    const retained = [];
    const removable = [];
    items.forEach((item, index) => {
      const createdAt = Date.parse(item.createdAt ?? '');
      const tooOld = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && Number.isFinite(createdAt) && nowMs - createdAt > maxAgeMs;
      const overLimit = index >= keepLast;
      if (tooOld || overLimit) removable.push({ ...item, reason: tooOld ? 'maxAgeMs' : 'keepLast' });
      else retained.push(item);
    });
    return { retained, removable };
  }

  reportBytes(item) {
    return this.reportArtifactPaths(item, { includeLegacy: true }).reduce((sum, path) => {
      if (!path || !existsSync(path)) return sum;
      try {
        return sum + statSync(path).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  ageBuckets(items) {
    const nowMs = Date.now();
    const buckets = { unknown: 0, under1d: 0, d1to7: 0, d7to30: 0, over30d: 0 };
    for (const item of items) {
      const createdAt = Date.parse(item.createdAt ?? '');
      if (!Number.isFinite(createdAt)) {
        buckets.unknown += 1;
        continue;
      }
      const ageMs = Math.max(0, nowMs - createdAt);
      if (ageMs < 86_400_000) buckets.under1d += 1;
      else if (ageMs < 7 * 86_400_000) buckets.d1to7 += 1;
      else if (ageMs < 30 * 86_400_000) buckets.d7to30 += 1;
      else buckets.over30d += 1;
    }
    return buckets;
  }

  statusBucketsByDay(items) {
    const buckets = {};
    for (const item of items) {
      const day = Number.isFinite(Date.parse(item.createdAt ?? ''))
        ? new Date(item.createdAt).toISOString().slice(0, 10)
        : 'unknown';
      buckets[day] ??= { passed: 0, failed: 0, other: 0 };
      if (item.status === 'passed') buckets[day].passed += 1;
      else if (item.status === 'failed') buckets[day].failed += 1;
      else buckets[day].other += 1;
    }
    return Object.entries(buckets).map(([day, counts]) => ({ day, ...counts }));
  }

  fileSha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  validateCleanupApprover({ approval, approvedBy }) {
    try {
      const result = this.cleanupApproverValidator({
        approval: { ...approval },
        approvedBy
      });
      if (result && typeof result === 'object') {
        return {
          contractVersion: 'g-report-cleanup-approver-validation-v1',
          valid: result.valid === true,
          approvedBy: String(result.approvedBy ?? approvedBy).trim(),
          reason: result.reason ?? null
        };
      }
      return {
        contractVersion: 'g-report-cleanup-approver-validation-v1',
        valid: result === true,
        approvedBy: String(approvedBy ?? '').trim(),
        reason: result === true ? null : 'approver_validator_rejected'
      };
    } catch {
      return {
        contractVersion: 'g-report-cleanup-approver-validation-v1',
        valid: false,
        approvedBy: String(approvedBy ?? '').trim(),
        reason: 'approver_validator_error'
      };
    }
  }

  cleanupPlanFingerprint(policy, removable) {
    const scope = {
      approvalScopeVersion: cleanupApprovalScopeVersion,
      policy: normalizeCleanupPolicy(policy),
      removable: removable
        .map((item) => {
          const state = this.reportArtifactState(item.reportId);
          return {
            reportId: item.reportId,
            createdAt: item.createdAt ?? null,
            artifacts: [state.json, state.html].map((artifact) => ({
              artifactType: artifact.artifactType,
              variant: artifact.variant,
              present: artifact.present,
              sha256: artifact.present ? this.fileSha256(artifact.path) : null
            }))
          };
        })
        .sort((left, right) => left.reportId.localeCompare(right.reportId))
    };
    return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  }

  requireImmutableTargetDir(targetDir, { create = false } = {}) {
    if (typeof targetDir !== 'string' || !targetDir.trim()) {
      throw reportStoreError('G_REPORT_WORM_TARGET_INVALID', 'Immutable artifact target directory is invalid.');
    }
    const candidate = resolve(targetDir);
    const allowedRoot = this.immutableArtifactRoots.find((root) => isPathInsideOrEqual(root, candidate));
    if (!allowedRoot) {
      throw reportStoreError('G_REPORT_WORM_TARGET_OUTSIDE_ROOT', 'Immutable artifact target is outside the configured root.');
    }
    if (existsSync(allowedRoot) && lstatSync(allowedRoot).isSymbolicLink()) {
      throw reportStoreError('G_REPORT_WORM_TARGET_SYMLINK', 'Immutable artifact root cannot be a symbolic link.');
    }
    const nearestExisting = nearestExistingPath(candidate);
    if (nearestExisting && existsSync(allowedRoot)) {
      const realRoot = realpathSync(allowedRoot);
      const realAncestor = realpathSync(nearestExisting);
      if (!isPathInsideOrEqual(realRoot, realAncestor)) {
        throw reportStoreError('G_REPORT_WORM_TARGET_OUTSIDE_ROOT', 'Immutable artifact target resolves outside the configured root.');
      }
    }
    if (create) {
      mkdirSync(allowedRoot, { recursive: true });
      mkdirSync(candidate, { recursive: true });
      const realRoot = realpathSync(allowedRoot);
      const realCandidate = realpathSync(candidate);
      if (!isPathInsideOrEqual(realRoot, realCandidate)) {
        throw reportStoreError('G_REPORT_WORM_TARGET_OUTSIDE_ROOT', 'Immutable artifact target resolves outside the configured root.');
      }
    }
    return candidate;
  }

  currentReportPaths(reportId) {
    const storageKey = reportStorageKey(reportId);
    return {
      storageKey,
      storageKeyVersion: reportStorageKeyVersion,
      jsonPath: join(this.reportDir, `${storageKey}.json`),
      htmlPath: join(this.reportDir, `${storageKey}.html`)
    };
  }

  legacyReportPaths(reportId) {
    if (!isLegacyReportFileStem(reportId)) return null;
    return {
      storageKey: reportId,
      storageKeyVersion: 'legacy-direct-v0',
      jsonPath: join(this.reportDir, `${reportId}.json`),
      htmlPath: join(this.reportDir, `${reportId}.html`)
    };
  }

  reportArtifactState(reportId) {
    const current = this.currentReportPaths(reportId);
    const legacy = this.legacyReportPaths(reportId);
    const select = (artifactType) => {
      const key = `${artifactType}Path`;
      if (exactFileExists(current[key])) {
        return { artifactType, path: current[key], present: true, variant: 'current' };
      }
      if (legacy && exactFileExists(legacy[key])) {
        return { artifactType, path: legacy[key], present: true, variant: 'legacy' };
      }
      return { artifactType, path: current[key], present: false, variant: 'missing' };
    };
    const json = select('json');
    const html = select('html');
    return {
      current,
      legacy,
      json,
      html,
      presentCount: Number(json.present) + Number(html.present),
      complete: json.present && html.present
    };
  }

  normalizeIndexItem(item) {
    if (!item || !isValidLogicalReportId(item.reportId)) return null;
    const reportId = String(item.reportId);
    const state = this.reportArtifactState(reportId);
    const onlyLegacy = state.complete
      && state.json.variant === 'legacy'
      && state.html.variant === 'legacy';
    const selected = onlyLegacy ? state.legacy : state.current;
    return {
      ...item,
      reportId,
      storageKey: selected.storageKey,
      storageKeyVersion: selected.storageKeyVersion,
      jsonPath: state.json.path,
      htmlPath: state.html.path
    };
  }

  reportArtifactPaths(item, { includeLegacy = false } = {}) {
    if (!item || !isValidLogicalReportId(item.reportId)) return [];
    const state = this.reportArtifactState(String(item.reportId));
    const paths = [state.json, state.html]
      .filter((artifact) => artifact.present)
      .map((artifact) => artifact.path);
    if (includeLegacy) {
      for (const candidate of [
        state.current.jsonPath,
        state.current.htmlPath,
        state.legacy?.jsonPath,
        state.legacy?.htmlPath
      ]) {
        if (candidate && exactFileExists(candidate)) paths.push(candidate);
      }
    }
    return [...new Set(paths)].filter((path) => isPathInside(this.reportDir, path));
  }

  readIndex() {
    this.refreshIndexCache();
    const context = reportIndexBatchStorage.getStore();
    if (context?.store === this && context.entries.size > 0) {
      return this.mergeIndexEntries(this.indexItems, [...context.entries.values()]);
    }
    return this.indexItems.map((item) => ({ ...item }));
  }

  loadIndexFromDisk() {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      this.indexMtimeMs = statSync(this.indexPath).mtimeMs;
      return Array.isArray(parsed.items)
        ? this.mergeIndexEntries([], parsed.items.map((item) => this.normalizeIndexItem(item)).filter(Boolean))
        : [];
    } catch {
      this.indexMtimeMs = null;
      return [];
    }
  }

  refreshIndexCache() {
    try {
      const mtimeMs = statSync(this.indexPath).mtimeMs;
      if (this.indexMtimeMs !== mtimeMs) this.indexItems = this.loadIndexFromDisk();
    } catch {
      if (this.indexMtimeMs !== null) {
        this.indexMtimeMs = null;
        this.indexItems = [];
      }
    }
  }

  writeIndex(items) {
    const normalizedItems = this.mergeIndexEntries(
      [],
      items.map((item) => this.normalizeIndexItem(item)).filter(Boolean)
    );
    mkdirSync(this.reportDir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify({
      indexVersion: 'g-report-index-v1',
      updatedAt: new Date().toISOString(),
      items: normalizedItems
    }, null, 2), 'utf8');
    this.indexItems = normalizedItems.map((item) => ({ ...item }));
    this.indexMtimeMs = statSync(this.indexPath).mtimeMs;
  }

  upsertIndex(report, { storageKey, jsonPath, htmlPath }) {
    const entry = {
      reportId: report.verificationId,
      storageKey,
      storageKeyVersion: reportStorageKeyVersion,
      taskId: report.taskId ?? null,
      status: report.status,
      score: report.score,
      createdAt: report.createdAt,
      checkCount: report.checks?.length ?? 0,
      failedCheckCount: (report.checks ?? []).filter((check) => check.status === 'failed').length,
      jsonPath,
      htmlPath
    };
    const context = reportIndexBatchStorage.getStore();
    if (context?.store === this) {
      context.entries.set(entry.reportId, entry);
      return entry;
    }
    this.flushIndexEntries([entry]);
    return entry;
  }

  flushIndexEntries(entries) {
    if (!entries.length) return { flushed: 0 };
    this.refreshIndexCache();
    const items = this.mergeIndexEntries(this.indexItems, entries);
    this.writeIndex(items);
    return { flushed: entries.length, total: items.length };
  }

  mergeIndexEntries(existing, entries) {
    const byId = new Map(existing.map((item) => [item.reportId, { ...item }]));
    for (const entry of entries) byId.set(entry.reportId, { ...entry });
    return [...byId.values()].sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
  }

  renderHtml(report) {
    const rows = report.checks
      .map(
        (check) => `
          <tr>
            <td>${escapeHtml(check.checkName)}</td>
            <td>${escapeHtml(check.status)}</td>
            <td>${escapeHtml(check.severity)}</td>
            <td>${escapeHtml(check.message)}</td>
          </tr>`
      )
      .join('');
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>JARVIS Verification ${escapeHtml(report.verificationId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #15201a; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #c8d5cd; padding: 8px; text-align: left; }
    th { background: #edf6ef; }
  </style>
</head>
<body>
  <h1>JARVIS Verification Report</h1>
  <p><strong>ID:</strong> ${escapeHtml(report.verificationId)}</p>
  <p><strong>Status:</strong> ${escapeHtml(report.status)} / <strong>Score:</strong> ${escapeHtml(report.score)}</p>
  <table>
    <thead><tr><th>Check</th><th>Status</th><th>Severity</th><th>Message</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  }
}

function isValidLogicalReportId(value) {
  const reportId = String(value ?? '');
  return reportId.length > 0
    && reportId.length <= 512
    && Buffer.byteLength(reportId, 'utf8') <= 2_048
    && reportId.trim() === reportId
    && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(reportId)
    && !/[\\/]/u.test(reportId)
    && reportId !== '.'
    && reportId !== '..'
    && !reservedReportIds.has(reportId.toLowerCase());
}

function reportStorageKey(reportId) {
  const logicalReportId = requireValidLogicalReportId(reportId);
  return `${mappedReportStorageKeyPrefix}${createHash('sha256').update(logicalReportId, 'utf8').digest('hex')}`;
}

function isLegacyReportFileStem(reportId) {
  return isValidLogicalReportId(reportId)
    && reportId.length <= 250
    && !/[<>:"|?*]/u.test(reportId)
    && !/[. ]$/u.test(reportId)
    && !reportId.toLowerCase().startsWith(mappedReportStorageKeyPrefix)
    && !isWindowsReservedFileStem(reportId)
    && !reservedReportIds.has(reportId.toLowerCase())
    && reportId.toLowerCase() !== 'report-long-term-trend';
}

function isWindowsReservedFileStem(reportId) {
  const firstSegment = reportId.split('.')[0];
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(firstSegment);
}

function isPathInside(parentPath, candidatePath) {
  const relativePath = relative(resolve(parentPath), resolve(candidatePath));
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function isPathInsideOrEqual(parentPath, candidatePath) {
  return resolve(parentPath) === resolve(candidatePath) || isPathInside(parentPath, candidatePath);
}

function nearestExistingPath(candidatePath) {
  let current = resolve(candidatePath);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function exactFileExists(path) {
  if (!path || !existsSync(path)) return false;
  try {
    return lstatSync(path).isFile()
      && basename(realpathSync.native(path)) === basename(path);
  } catch {
    return false;
  }
}

function writeImmutableText(path, serialized) {
  try {
    writeFileSync(path, serialized, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (readFileSync(path, 'utf8') !== serialized) {
      throw reportStoreError('G_REPORT_WORM_MANIFEST_CONFLICT', 'Immutable artifact manifest already exists with different content.');
    }
  }
}

function normalizeCleanupPolicy({ keepLast, maxAgeMs } = {}) {
  const numericKeepLast = Number(keepLast);
  const numericMaxAgeMs = maxAgeMs === null || maxAgeMs === undefined ? null : Number(maxAgeMs);
  return {
    keepLast: Number.isFinite(numericKeepLast) && numericKeepLast >= 0 ? Math.floor(numericKeepLast) : 100,
    maxAgeMs: Number.isFinite(numericMaxAgeMs) && numericMaxAgeMs >= 0 ? numericMaxAgeMs : null
  };
}

function defaultCleanupApproverValidator({ approval, approvedBy }) {
  const normalizedApprover = String(approvedBy ?? '').trim();
  const normalizedRequester = String(approval?.requestedBy ?? '').trim();
  const structurallyValid = normalizedApprover.length > 0
    && normalizedApprover.length <= 256
    && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalizedApprover);
  return {
    valid: structurallyValid && normalizedApprover !== normalizedRequester,
    approvedBy: normalizedApprover,
    reason: structurallyValid
      ? (normalizedApprover === normalizedRequester ? 'requester_cannot_self_approve' : null)
      : 'approver_identity_invalid'
  };
}

function reportStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireValidLogicalReportId(value) {
  if (isValidLogicalReportId(value)) return String(value);
  const error = new TypeError('Verification report identifier is invalid.');
  error.code = 'G_REPORT_ID_INVALID';
  throw error;
}

function isSensitiveReportKey(value) {
  const key = String(value ?? '').replace(/[_-]/gu, '').toLowerCase();
  return key === 'token'
    || key.endsWith('accesstoken')
    || key.endsWith('refreshtoken')
    || key === 'authorization'
    || key.endsWith('password')
    || key.endsWith('secret')
    || key.endsWith('credential')
    || key === 'cookie'
    || key.endsWith('apikey')
    || key.endsWith('signingkey')
    || key.endsWith('privatekey')
    || key.endsWith('encryptionkey');
}
