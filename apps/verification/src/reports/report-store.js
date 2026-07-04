import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export class VerificationReportStore {
  constructor({ reportDir = 'apps/verification/reports' } = {}) {
    this.reportDir = reportDir;
    this.indexPath = join(this.reportDir, 'report-index.json');
    this.cleanupApprovals = new Map();
    mkdirSync(this.reportDir, { recursive: true });
  }

  save(report) {
    const jsonPath = join(this.reportDir, `${report.verificationId}.json`);
    const htmlPath = join(this.reportDir, `${report.verificationId}.html`);
    const storedReport = this.sanitize({
      ...report,
      evidence: {
        ...report.evidence,
        reportJsonPath: jsonPath,
        reportHtmlPath: htmlPath
      }
    });
    writeFileSync(jsonPath, JSON.stringify(storedReport, null, 2), 'utf8');
    writeFileSync(htmlPath, this.renderHtml(storedReport), 'utf8');
    this.upsertIndex(storedReport, { jsonPath, htmlPath });
    return { jsonPath, htmlPath };
  }

  sanitize(value) {
    if (typeof value === 'string') {
      return value
        .replace(/api[_-]?key\s*[:=]\s*[\w.-]+/gi, 'api_key=[masked]')
        .replace(/token\s*[:=]\s*[\w.-]+/gi, 'token=[masked]')
        .replace(/password\s*[:=]\s*\S+/gi, 'password=[masked]')
        .replace(/\b010[-.\s]?\d{4}[-.\s]?\d{4}\b/g, '[masked-phone]');
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.sanitize(entry)]));
    }
    return value;
  }

  read(reportId) {
    const jsonPath = join(this.reportDir, `${reportId}.json`);
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch {
      return null;
    }
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
    if (!dryRun) {
      for (const item of plan.removable) {
        for (const path of [item.jsonPath, item.htmlPath]) {
          if (path && existsSync(path)) {
            rmSync(path, { force: true });
            removed.push(path);
          }
        }
      }
      this.writeIndex(plan.retained);
    }
    return {
      cleanupVersion: 'g-report-cleanup-v1',
      dryRun,
      keepLast,
      maxAgeMs,
      removableCount: plan.removable.length,
      retainedCount: plan.retained.length,
      removable: plan.removable,
      removed
    };
  }

  syncImmutableArtifacts({
    targetDir = join(this.reportDir, 'report-worm-artifact-store'),
    dryRun = true,
    keepLast = 100
  } = {}) {
    const items = this.readIndex()
      .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
      .slice(0, Math.max(1, Number(keepLast) || 100));
    const manifestPath = join(targetDir, 'report-worm-manifest.json');
    const artifacts = [];
    if (!dryRun) mkdirSync(targetDir, { recursive: true });
    for (const item of items) {
      for (const [artifactType, sourcePath] of [['json', item.jsonPath], ['html', item.htmlPath]]) {
        if (!sourcePath || !existsSync(sourcePath)) continue;
        const sourceSha256 = this.fileSha256(sourcePath);
        const destinationPath = join(targetDir, `${item.reportId}-${sourceSha256.slice(0, 12)}.${artifactType}`);
        const destinationExists = existsSync(destinationPath);
        const destinationSha256 = destinationExists ? this.fileSha256(destinationPath) : null;
        const conflict = destinationExists && destinationSha256 !== sourceSha256;
        if (!dryRun && !destinationExists) copyFileSync(sourcePath, destinationPath);
        const copied = !dryRun && existsSync(destinationPath) && this.fileSha256(destinationPath) === sourceSha256;
        artifacts.push({
          artifactId: `${item.reportId}:${artifactType}`,
          reportId: item.reportId,
          artifactType,
          sourcePath,
          destinationPath,
          sourceSha256,
          destinationSha256: existsSync(destinationPath) ? this.fileSha256(destinationPath) : null,
          sizeBytes: statSync(sourcePath).size,
          status: conflict ? 'conflict' : (copied ? 'copied' : (destinationExists ? 'already_present' : 'pending')),
          immutable: !conflict
        });
      }
    }
    const conflictCount = artifacts.filter((item) => item.status === 'conflict').length;
    const copiedCount = artifacts.filter((item) => item.status === 'copied').length;
    const verifiedCount = artifacts.filter((item) => ['copied', 'already_present'].includes(item.status)).length;
    const status = conflictCount
      ? 'conflict'
      : (artifacts.length ? (dryRun ? 'dry_run' : 'synced') : 'empty');
    const manifest = {
      manifestVersion: 'g-report-worm-manifest-v1',
      generatedAt: new Date().toISOString(),
      reportDir: this.reportDir,
      targetDir,
      artifacts
    };
    if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return {
      syncVersion: 'g-report-immutable-artifact-sync-v1',
      generatedAt: manifest.generatedAt,
      status,
      dryRun,
      targetDir,
      manifestPath,
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
        requiredForExecute: true,
        requiredFields: ['requestedBy', 'reason', 'approvedBy', 'approvalId']
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

  cleanupApprovalWorkflow({
    keepLast = 100,
    maxAgeMs = null,
    requestedBy = 'verification-admin',
    reason = '',
    approvedBy = null,
    approvalId = null,
    execute = false,
    dryRun = true
  } = {}) {
    const cleanupPreview = this.cleanup({ keepLast, maxAgeMs, dryRun: true });
    const normalizedReason = String(reason || '').trim();
    const generatedApprovalId = approvalId ?? `g-report-cleanup-approval-${createHash('sha256')
      .update(JSON.stringify({ keepLast, maxAgeMs, requestedBy, normalizedReason, removable: cleanupPreview.removable.map((item) => item.reportId) }))
      .digest('hex')
      .slice(0, 12)}`;
    if (!execute) {
      const approval = {
        approvalId: generatedApprovalId,
        approvalVersion: 'g-report-cleanup-approval-v1',
        status: 'pending_approval',
        requestedBy,
        reason: normalizedReason,
        requestedAt: new Date().toISOString(),
        policy: { keepLast, maxAgeMs },
        removableCount: cleanupPreview.removableCount,
        removableBytes: cleanupPreview.removable.reduce((sum, item) => sum + this.reportBytes(item), 0),
        removableReportIds: cleanupPreview.removable.map((item) => item.reportId)
      };
      this.cleanupApprovals.set(generatedApprovalId, approval);
      return {
        workflowVersion: 'g-report-cleanup-approval-workflow-v1',
        generatedAt: approval.requestedAt,
        status: 'pending_approval',
        approvalRequired: true,
        approval,
        cleanupPreview,
        execution: null
      };
    }
    const approval = this.cleanupApprovals.get(generatedApprovalId);
    if (!approval || !approvedBy) {
      return {
        workflowVersion: 'g-report-cleanup-approval-workflow-v1',
        generatedAt: new Date().toISOString(),
        status: 'blocked_missing_approval',
        approvalRequired: true,
        approval: approval ?? { approvalId: generatedApprovalId, status: 'missing' },
        cleanupPreview,
        execution: null
      };
    }
    const execution = this.cleanup({ keepLast, maxAgeMs, dryRun });
    const completedApproval = {
      ...approval,
      status: dryRun ? 'approved_dry_run' : 'executed',
      approvedBy,
      approvedAt: new Date().toISOString(),
      executionDryRun: dryRun
    };
    this.cleanupApprovals.set(generatedApprovalId, completedApproval);
    return {
      workflowVersion: 'g-report-cleanup-approval-workflow-v1',
      generatedAt: completedApproval.approvedAt,
      status: completedApproval.status,
      approvalRequired: true,
      approval: completedApproval,
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
        cleanupEndpoint: '/reports/cleanup',
        cleanupMode: 'explicit_dry_run_or_execute'
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
    return [item.jsonPath, item.htmlPath].reduce((sum, path) => {
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

  readIndex() {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  writeIndex(items) {
    mkdirSync(this.reportDir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify({
      indexVersion: 'g-report-index-v1',
      updatedAt: new Date().toISOString(),
      items
    }, null, 2), 'utf8');
  }

  upsertIndex(report, { jsonPath, htmlPath }) {
    const items = this.readIndex().filter((item) => item.reportId !== report.verificationId);
    items.push({
      reportId: report.verificationId,
      taskId: report.taskId ?? null,
      status: report.status,
      score: report.score,
      createdAt: report.createdAt,
      checkCount: report.checks?.length ?? 0,
      failedCheckCount: (report.checks ?? []).filter((check) => check.status === 'failed').length,
      jsonPath,
      htmlPath
    });
    this.writeIndex(items.sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '')));
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
