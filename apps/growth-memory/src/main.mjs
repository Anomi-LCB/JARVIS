import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ModuleId } from '../../../packages/shared/src/types.js';
import { readJsonBody, routeParams, routePath, safeHandle, sendJson } from '../../../packages/shared/src/http.js';
import { createOpenApiSpecFromRouteContracts, createRouteContract } from '../../../packages/shared/src/openapi-contract.js';
import { GrowthRuntime } from './growth-runtime.js';
import { SqliteMemoryStore } from './db/sqlite-store.js';

export const growthMemoryRouteContracts = [
  createRouteContract('GET', '/health', 'Read F growth-memory health.'),
  createRouteContract('GET', '/openapi.json', 'Read F growth-memory OpenAPI contract.'),
  createRouteContract('POST', '/events', 'Ingest a memory event.'),
  createRouteContract('POST', '/feedback', 'Record task feedback.'),
  createRouteContract('POST', '/memory/query', 'Query planning memory context.'),
  createRouteContract('POST', '/memory/minimize/preview', 'Preview sensitive-memory minimization.'),
  createRouteContract('GET', '/memory/minimize/fixtures', 'Run sensitive-memory minimizer fixture pack.'),
  createRouteContract('GET', '/memory/minimize/false-positive-dashboard', 'Read sensitive minimizer false-positive review dashboard.'),
  createRouteContract('POST', '/memory/minimize/release-dossier', 'Run sensitive minimizer release dossier checks.'),
  createRouteContract('GET', '/memory/retention/policy-ui', 'Read retention policy UI contract.'),
  createRouteContract('GET', '/memory/events/schema', 'Read MemoryEvent schema status.'),
  createRouteContract('GET', '/memory/events/schema-bundle', 'Read external MemoryEvent JSON Schema bundle.'),
  createRouteContract('POST', '/memory/events/schema-diff', 'Run MemoryEvent schema diff report.'),
  createRouteContract('POST', '/memory/events/schema-diff-review', 'Run MemoryEvent schema diff approval workflow.'),
  createRouteContract('GET', '/memory/events/fixtures', 'Read MemoryEvent fixture corpus.'),
  createRouteContract('POST', '/memory/events/migration-compatibility', 'Run MemoryEvent migration compatibility report.'),
  createRouteContract('GET', '/memory/events/learning-verifier-matrix', 'Read G learning verifier schema matrix.'),
  createRouteContract('GET', '/memory/events/ingest-telemetry', 'Read MemoryEvent ingest telemetry.'),
  createRouteContract('GET', '/memory/events/operational-corpus', 'Read hash-only anonymized MemoryEvent operational corpus.'),
  createRouteContract('GET', '/memory/events/generated-fixture-drift', 'Read generated MemoryEvent fixture drift dashboard.'),
  createRouteContract('POST', '/memory/events/product-gate', 'Run MemoryEvent ingest product gate.'),
  createRouteContract('POST', '/memory/events/release-dossier', 'Run MemoryEvent ingest release dossier checks.'),
  createRouteContract('GET', '/memory/retention/report', 'Read retention report.'),
  createRouteContract('POST', '/memory/retention/apply', 'Apply retention policy.'),
  createRouteContract('GET', '/memory/retention/schedule', 'Read retention schedule status.'),
  createRouteContract('POST', '/memory/retention/run', 'Run retention scheduler.'),
  createRouteContract('GET', '/storage/status', 'Read storage status.'),
  createRouteContract('GET', '/storage/encryption-key', 'Read encrypted storage backup key provider status.'),
  createRouteContract('GET', '/storage/backup-location-policy', 'Read backup location and immutable mirror policy.'),
  createRouteContract('GET', '/storage/at-rest-encryption-policy', 'Read at-rest storage encryption deployment policy.'),
  createRouteContract('POST', '/storage/backup', 'Create storage backup.'),
  createRouteContract('POST', '/storage/encrypted-backup', 'Create encrypted storage backup envelope.'),
  createRouteContract('POST', '/storage/restore', 'Restore storage backup.'),
  createRouteContract('GET', '/storage/backups/retention', 'Preview backup retention.'),
  createRouteContract('POST', '/storage/backups/rotate', 'Rotate backups by retention policy.'),
  createRouteContract('POST', '/storage/worm-sync', 'Sync encrypted backup to immutable mirror target.'),
  createRouteContract('POST', '/storage/restore-drill', 'Run read-only restore drill.'),
  createRouteContract('POST', '/storage/periodic-restore-drill', 'Create periodic storage restore drill evidence.'),
  createRouteContract('POST', '/storage/large-migration-fixture', 'Run large SQLite migration fixture.'),
  createRouteContract('POST', '/storage/release-dossier', 'Run storage persistence release dossier checks.'),
  createRouteContract('POST', '/storage/product-gate', 'Run storage persistence product gate.'),
  createRouteContract('GET', '/preferences', 'Read preference hypotheses.'),
  createRouteContract('GET', '/preferences/confirmed', 'Read confirmed preferences.'),
  createRouteContract('GET', '/preferences/conflicts', 'Read preference conflicts.'),
  createRouteContract('GET', '/preferences/confidence-calibration', 'Read preference hypothesis confidence calibration report.'),
  createRouteContract('GET', '/preferences/tolerance-profile', 'Read user preference tolerance profile visualization.'),
  createRouteContract('POST', '/preferences/product-gate', 'Run preference hypothesis product readiness gate.'),
  createRouteContract('POST', '/preferences/release-dossier', 'Run preference hypothesis release dossier checks.'),
  createRouteContract('POST', '/preferences/batch-decision', 'Batch decide preference hypotheses.'),
  createRouteContract('POST', '/preferences/migration-diff', 'Preview confirmed preference scope migration diff.'),
  createRouteContract('POST', '/preferences/confirmed/application-preview', 'Preview confirmed preference planning application.'),
  createRouteContract('POST', '/preferences/confirmed/conflict-dossier', 'Read confirmed preference conflict resolution dossier.'),
  createRouteContract('GET', '/preferences/confirmed/drift-trend', 'Read confirmed preference drift trend.'),
  createRouteContract('POST', '/preferences/confirmed/migration-review-queue', 'Read confirmed preference scope migration review queue.'),
  createRouteContract('POST', '/preferences/confirmed/product-gate', 'Run confirmed preference product readiness gate.'),
  createRouteContract('POST', '/preferences/confirmed/release-dossier', 'Run confirmed preference release dossier checks.'),
  createRouteContract('POST', '/preferences/:hypothesisId/decision', 'Decide a preference hypothesis.'),
  createRouteContract('PATCH', '/preferences/confirmed/:preferenceId', 'Update a confirmed preference.'),
  createRouteContract('POST', '/preferences/confirmed/:preferenceId', 'Update a confirmed preference.'),
  createRouteContract('POST', '/preferences/confirmed/:preferenceId/revoke', 'Revoke a confirmed preference.'),
  createRouteContract('GET', '/failures', 'Read failure lessons.'),
  createRouteContract('GET', '/failures/trends', 'Read failure trends.'),
  createRouteContract('GET', '/failures/recurrence-dashboard', 'Read failure recurrence dashboard.'),
  createRouteContract('GET', '/failures/guardrail-review-queue', 'Read failure guardrail review queue.'),
  createRouteContract('GET', '/failures/recurrence-visualization', 'Read failure recurrence trend visualization.'),
  createRouteContract('GET', '/failures/effectiveness-tuning', 'Read failure guardrail effectiveness tuning report.'),
  createRouteContract('GET', '/failures/taxonomy-fixtures', 'Read failure taxonomy fixture coverage.'),
  createRouteContract('POST', '/failures/product-gate', 'Run failure memory product readiness gate.'),
  createRouteContract('POST', '/failures/release-dossier', 'Run failure memory release dossier checks.'),
  createRouteContract('POST', '/failures/:failureId/guardrail', 'Review a failure guardrail.'),
  createRouteContract('GET', '/planning-guardrails', 'Read A planning guardrails.'),
  createRouteContract('GET', '/planning-context', 'Read A planning preference context.'),
  createRouteContract('GET', '/growth/review/latest', 'Read latest growth review.'),
  createRouteContract('GET', '/patterns', 'Read repeated task patterns.'),
  createRouteContract('GET', '/patterns/trends', 'Read pattern trends.'),
  createRouteContract('GET', '/patterns/embedding-adapters', 'Read pattern embedding adapter policy.'),
  createRouteContract('GET', '/patterns/corpus', 'Read anonymized pattern mining corpus.'),
  createRouteContract('GET', '/patterns/cluster-review', 'Read pattern cluster split/merge review queue.'),
  createRouteContract('POST', '/patterns/calibration', 'Calibrate pattern threshold.'),
  createRouteContract('POST', '/patterns/product-gate', 'Run pattern mining product readiness gate.'),
  createRouteContract('GET', '/genomes/trends', 'Read genome trends.'),
  createRouteContract('GET', '/genomes/weight-calibration', 'Read genome weight calibration profile.'),
  createRouteContract('GET', '/genomes/drift-diff', 'Read genome drift diff.'),
  createRouteContract('GET', '/genomes/threshold-alerts', 'Read genome threshold alerts.'),
  createRouteContract('POST', '/genomes/product-gate', 'Run genome product readiness gate.'),
  createRouteContract('POST', '/genomes/release-dossier', 'Run genome release dossier checks.'),
  createRouteContract('GET', '/trends/archive', 'Read persisted growth trend archive.'),
  createRouteContract('GET', '/advanced-learning', 'Read advanced learning models.'),
  createRouteContract('GET', '/advanced-learning/skill-registry', 'Read skill draft registry.'),
  createRouteContract('GET', '/advanced-learning/verifier', 'Read advanced learning verifier report.'),
  createRouteContract('POST', '/advanced-learning/product-gate', 'Run advanced learning product readiness gate.'),
  createRouteContract('POST', '/advanced-learning/release-dossier', 'Run advanced learning release dossier checks.'),
  createRouteContract('POST', '/advanced-learning/skill-drafts/:draftId/review', 'Review a skill draft.'),
  createRouteContract('POST', '/advanced-learning/skill-registry/:skillId/usefulness', 'Record approved skill usefulness feedback.'),
  createRouteContract('GET', '/maturity-score', 'Read maturity score.'),
  createRouteContract('GET', '/maturity-score/trends', 'Read maturity trends.'),
  createRouteContract('GET', '/maturity-score/thresholds', 'Read maturity thresholds.'),
  createRouteContract('GET', '/maturity-score/threshold-profile', 'Read user maturity threshold profile.'),
  createRouteContract('POST', '/maturity-score/threshold-migration-diff', 'Preview maturity threshold migration diff.'),
  createRouteContract('POST', '/maturity-score/thresholds/calibration', 'Calibrate maturity thresholds.'),
  createRouteContract('GET', '/maturity-score/alerts', 'Read maturity alerts.'),
  createRouteContract('GET', '/maturity-score/dashboard', 'Read maturity score dashboard.'),
  createRouteContract('POST', '/maturity-score/product-gate', 'Run maturity score product gate.'),
  createRouteContract('POST', '/maturity-score/release-dossier', 'Run maturity score release dossier checks.'),
  createRouteContract('POST', '/autonomy/candidates/generate', 'Generate autonomy candidates.'),
  createRouteContract('GET', '/autonomy/candidates', 'Read autonomy candidates.'),
  createRouteContract('GET', '/autonomy/candidates/trends', 'Read autonomy candidate decision trends.'),
  createRouteContract('POST', '/autonomy/candidates/expiry/run', 'Run autonomy candidate expiry scheduler.'),
  createRouteContract('POST', '/autonomy/candidates/release-dossier', 'Run autonomy candidate release dossier checks.'),
  createRouteContract('POST', '/autonomy/candidates/:candidateId/submit-to-policy', 'Submit autonomy candidate to E policy.'),
  createRouteContract('POST', '/autonomy/candidates/:candidateId/review', 'Review autonomy candidate.'),
  createRouteContract('GET', '/memory/hygiene/report', 'Read memory hygiene report.'),
  createRouteContract('GET', '/memory/hygiene/trends', 'Read memory hygiene trends.'),
  createRouteContract('GET', '/memory/hygiene/decisions/history', 'Read memory hygiene decision history.'),
  createRouteContract('GET', '/memory/retention/calendar', 'Read retention policy calendar.'),
  createRouteContract('POST', '/memory/hygiene/decisions', 'Record a memory hygiene decision.'),
  createRouteContract('POST', '/memory/hygiene/decisions/batch', 'Record batch memory hygiene decisions.'),
  createRouteContract('POST', '/memory/hygiene/product-gate', 'Run memory hygiene review product gate.'),
  createRouteContract('POST', '/memory/hygiene/release-dossier', 'Run memory hygiene release dossier checks.')
];

export function createGrowthMemoryOpenApiSpec() {
  return createOpenApiSpecFromRouteContracts({
    title: 'JARVIS F Growth Memory API',
    moduleId: ModuleId.GROWTH_MEMORY,
    routes: growthMemoryRouteContracts
  });
}

export function createGrowthMemoryServer(growthRuntime) {
  return http.createServer((request, response) => {
    safeHandle(response, async () => {
      const path = routePath(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, { status: 'ok', module: ModuleId.GROWTH_MEMORY, version: '1.0.0' });
      }
      if (request.method === 'GET' && path === '/openapi.json') {
        return sendJson(response, 200, createGrowthMemoryOpenApiSpec());
      }
      if (request.method === 'POST' && path === '/events') {
        return sendJson(response, 200, growthRuntime.ingestor.ingest(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/feedback') {
        return sendJson(response, 200, growthRuntime.recordFeedback(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/query') {
        const body = await readJsonBody(request);
        return sendJson(response, 200, growthRuntime.memoryContext(body.query ?? ''));
      }
      if (request.method === 'POST' && path === '/memory/minimize/preview') {
        return sendJson(response, 200, growthRuntime.minimizePreview(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/minimize/fixtures') {
        return sendJson(response, 200, growthRuntime.sensitiveMinimizerFixtureReport());
      }
      if (request.method === 'GET' && path === '/memory/minimize/false-positive-dashboard') {
        return sendJson(response, 200, growthRuntime.sensitiveMinimizerFalsePositiveDashboard());
      }
      if (request.method === 'POST' && path === '/memory/minimize/release-dossier') {
        return sendJson(response, 200, growthRuntime.sensitiveMinimizerReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/retention/policy-ui') {
        return sendJson(response, 200, growthRuntime.retentionPolicyUiContract({
          sensitiveReviewDays: Number(url.searchParams.get('sensitiveReviewDays') ?? 0),
          staleReviewDays: Number(url.searchParams.get('staleReviewDays') ?? 90)
        }));
      }
      if (request.method === 'GET' && path === '/memory/events/schema') {
        return sendJson(response, 200, growthRuntime.memoryEventSchemaStatus());
      }
      if (request.method === 'GET' && path === '/memory/events/schema-bundle') {
        return sendJson(response, 200, growthRuntime.memoryEventJsonSchemaBundle());
      }
      if (request.method === 'POST' && path === '/memory/events/schema-diff') {
        return sendJson(response, 200, growthRuntime.memoryEventSchemaDiff(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/events/schema-diff-review') {
        return sendJson(response, 200, growthRuntime.memoryEventSchemaDiffApprovalWorkflow(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/events/fixtures') {
        return sendJson(response, 200, growthRuntime.memoryEventFixtureCorpus());
      }
      if (request.method === 'POST' && path === '/memory/events/migration-compatibility') {
        return sendJson(response, 200, growthRuntime.memoryEventMigrationCompatibilityReport(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/events/learning-verifier-matrix') {
        return sendJson(response, 200, growthRuntime.memoryEventLearningVerifierSchemaMatrix());
      }
      if (request.method === 'GET' && path === '/memory/events/ingest-telemetry') {
        return sendJson(response, 200, growthRuntime.ingestor.ingestTelemetry());
      }
      if (request.method === 'GET' && path === '/memory/events/operational-corpus') {
        return sendJson(response, 200, growthRuntime.ingestor.anonymizedOperationalCorpus({
          limit: Number(url.searchParams.get('limit') ?? 100)
        }));
      }
      if (request.method === 'GET' && path === '/memory/events/generated-fixture-drift') {
        return sendJson(response, 200, growthRuntime.memoryEventGeneratedFixtureDriftDashboard({
          limit: Number(url.searchParams.get('limit') ?? 100)
        }));
      }
      if (request.method === 'POST' && path === '/memory/events/product-gate') {
        return sendJson(response, 200, growthRuntime.memoryEventIngestProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/events/release-dossier') {
        return sendJson(response, 200, growthRuntime.memoryEventIngestReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/retention/report') {
        return sendJson(response, 200, growthRuntime.retentionReport({
          sensitiveReviewDays: Number(url.searchParams.get('sensitiveReviewDays') ?? 0),
          staleReviewDays: Number(url.searchParams.get('staleReviewDays') ?? 90)
        }));
      }
      if (request.method === 'POST' && path === '/memory/retention/apply') {
        return sendJson(response, 200, growthRuntime.applyRetentionPolicy(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/retention/schedule') {
        return sendJson(response, 200, growthRuntime.retentionScheduleStatus({
          intervalDays: Number(url.searchParams.get('intervalDays') ?? 7),
          sensitiveReviewDays: Number(url.searchParams.get('sensitiveReviewDays') ?? 0),
          staleReviewDays: Number(url.searchParams.get('staleReviewDays') ?? 90)
        }));
      }
      if (request.method === 'POST' && path === '/memory/retention/run') {
        return sendJson(response, 200, growthRuntime.runRetentionScheduler(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/storage/status') {
        return sendJson(response, 200, growthRuntime.storageStatus());
      }
      if (request.method === 'GET' && path === '/storage/encryption-key') {
        return sendJson(response, 200, growthRuntime.storageEncryptionKeyProvider());
      }
      if (request.method === 'GET' && path === '/storage/backup-location-policy') {
        return sendJson(response, 200, growthRuntime.backupLocationPolicy());
      }
      if (request.method === 'GET' && path === '/storage/at-rest-encryption-policy') {
        return sendJson(response, 200, growthRuntime.storageAtRestEncryptionDeploymentPolicy());
      }
      if (request.method === 'POST' && path === '/storage/backup') {
        return sendJson(response, 200, growthRuntime.backupStorage(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/encrypted-backup') {
        return sendJson(response, 200, growthRuntime.encryptedBackupStorage(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/restore') {
        return sendJson(response, 200, growthRuntime.restoreStorage(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/storage/backups/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, growthRuntime.backupRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 5),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null
        }));
      }
      if (request.method === 'POST' && path === '/storage/backups/rotate') {
        return sendJson(response, 200, growthRuntime.rotateBackups(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/worm-sync') {
        return sendJson(response, 200, growthRuntime.syncEncryptedBackupToWorm(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/restore-drill') {
        return sendJson(response, 200, growthRuntime.restoreDrill(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/periodic-restore-drill') {
        return sendJson(response, 200, growthRuntime.storagePeriodicRestoreDrillEvidence(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/large-migration-fixture') {
        return sendJson(response, 200, growthRuntime.storageLargeMigrationFixture(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/release-dossier') {
        return sendJson(response, 200, growthRuntime.storagePersistenceReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/storage/product-gate') {
        return sendJson(response, 200, growthRuntime.storagePersistenceProductGate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/preferences') {
        const review = growthRuntime.latestReview();
        return sendJson(response, 200, { items: review.preferenceCandidates });
      }
      if (request.method === 'GET' && path === '/preferences/confirmed') {
        return sendJson(response, 200, { items: growthRuntime.confirmedPreferenceRegistry.all() });
      }
      if (request.method === 'GET' && path === '/preferences/conflicts') {
        return sendJson(response, 200, growthRuntime.preferenceConflictReport());
      }
      if (request.method === 'GET' && path === '/preferences/confidence-calibration') {
        return sendJson(response, 200, growthRuntime.preferenceConfidenceCalibration());
      }
      if (request.method === 'GET' && path === '/preferences/tolerance-profile') {
        return sendJson(response, 200, growthRuntime.preferenceToleranceProfile());
      }
      if (request.method === 'POST' && path === '/preferences/product-gate') {
        return sendJson(response, 200, growthRuntime.preferenceHypothesisProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/release-dossier') {
        return sendJson(response, 200, growthRuntime.preferenceHypothesisReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/batch-decision') {
        return sendJson(response, 200, growthRuntime.decidePreferenceBatch(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/migration-diff') {
        return sendJson(response, 200, growthRuntime.preferenceMigrationDiff(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/confirmed/application-preview') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceApplicationPreview(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/confirmed/conflict-dossier') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceConflictResolutionDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/preferences/confirmed/drift-trend') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceDriftTrend({
          windowDays: Number(url.searchParams.get('windowDays') ?? 180)
        }));
      }
      if (request.method === 'POST' && path === '/preferences/confirmed/migration-review-queue') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceMigrationReviewQueue(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/confirmed/product-gate') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/preferences/confirmed/release-dossier') {
        return sendJson(response, 200, growthRuntime.confirmedPreferenceReleaseDossier(await readJsonBody(request)));
      }
      const preferenceDecisionParams = routeParams('/preferences/:hypothesisId/decision', path);
      if (request.method === 'POST' && preferenceDecisionParams) {
        return sendJson(response, 200, growthRuntime.decidePreference({
          hypothesisId: preferenceDecisionParams.hypothesisId,
          ...(await readJsonBody(request))
        }));
      }
      const preferenceUpdateParams = routeParams('/preferences/confirmed/:preferenceId', path);
      if ((request.method === 'PATCH' || request.method === 'POST') && preferenceUpdateParams) {
        return sendJson(response, 200, growthRuntime.updatePreference(preferenceUpdateParams.preferenceId, await readJsonBody(request)));
      }
      const preferenceRevokeParams = routeParams('/preferences/confirmed/:preferenceId/revoke', path);
      if (request.method === 'POST' && preferenceRevokeParams) {
        return sendJson(response, 200, growthRuntime.revokePreference(preferenceRevokeParams.preferenceId, await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/failures') {
        const review = growthRuntime.latestReview();
        return sendJson(response, 200, { items: review.failureLessons });
      }
      if (request.method === 'GET' && path === '/failures/trends') {
        return sendJson(response, 200, growthRuntime.latestReview().failureTrend);
      }
      if (request.method === 'GET' && path === '/failures/recurrence-dashboard') {
        return sendJson(response, 200, growthRuntime.failureBuilder.trendStatus().dashboard);
      }
      if (request.method === 'GET' && path === '/failures/guardrail-review-queue') {
        return sendJson(response, 200, growthRuntime.failureGuardrailReviewQueue({
          query: url.searchParams.get('query') ?? ''
        }));
      }
      if (request.method === 'GET' && path === '/failures/recurrence-visualization') {
        return sendJson(response, 200, growthRuntime.failureRecurrenceTrendVisualization());
      }
      if (request.method === 'GET' && path === '/failures/effectiveness-tuning') {
        return sendJson(response, 200, growthRuntime.failureGuardrailEffectivenessTuning());
      }
      if (request.method === 'GET' && path === '/failures/taxonomy-fixtures') {
        return sendJson(response, 200, growthRuntime.failureTaxonomyFixtureCoverage());
      }
      if (request.method === 'POST' && path === '/failures/product-gate') {
        return sendJson(response, 200, growthRuntime.failureMemoryProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/failures/release-dossier') {
        return sendJson(response, 200, growthRuntime.failureMemoryReleaseDossier(await readJsonBody(request)));
      }
      const failureGuardrailParams = routeParams('/failures/:failureId/guardrail', path);
      if (request.method === 'POST' && failureGuardrailParams) {
        return sendJson(response, 200, growthRuntime.reviewFailureGuardrail(
          failureGuardrailParams.failureId,
          await readJsonBody(request)
        ));
      }
      if (request.method === 'GET' && path === '/planning-guardrails') {
        return sendJson(response, 200, growthRuntime.planningFailureGuardrails(url.searchParams.get('query') ?? ''));
      }
      if (request.method === 'GET' && path === '/planning-context') {
        return sendJson(response, 200, growthRuntime.planningPreferenceContext(url.searchParams.get('query') ?? ''));
      }
      if (request.method === 'GET' && path === '/growth/review/latest') {
        return sendJson(response, 200, growthRuntime.latestReview());
      }
      if (request.method === 'GET' && path === '/patterns') {
        return sendJson(response, 200, { items: growthRuntime.latestReview().repeatedTasks });
      }
      if (request.method === 'GET' && path === '/patterns/trends') {
        return sendJson(response, 200, growthRuntime.latestReview().patternTrend);
      }
      if (request.method === 'GET' && path === '/patterns/embedding-adapters') {
        return sendJson(response, 200, growthRuntime.patternEmbeddingAdapterStatus());
      }
      if (request.method === 'GET' && path === '/patterns/corpus') {
        return sendJson(response, 200, growthRuntime.patternAnonymizedCorpus({
          limit: Number(url.searchParams.get('limit') ?? 5000)
        }));
      }
      if (request.method === 'GET' && path === '/patterns/cluster-review') {
        return sendJson(response, 200, growthRuntime.patternClusterReview({
          limit: Number(url.searchParams.get('limit') ?? 5000)
        }));
      }
      if (request.method === 'POST' && path === '/patterns/calibration') {
        return sendJson(response, 200, growthRuntime.calibratePatternThreshold(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/patterns/product-gate') {
        return sendJson(response, 200, growthRuntime.patternMiningProductGate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/genomes/trends') {
        return sendJson(response, 200, growthRuntime.latestReview().genomeTrend);
      }
      if (request.method === 'GET' && path === '/genomes/weight-calibration') {
        return sendJson(response, 200, growthRuntime.genomeWeightCalibrationProfile());
      }
      if (request.method === 'GET' && path === '/genomes/drift-diff') {
        return sendJson(response, 200, growthRuntime.genomeDriftDiff());
      }
      if (request.method === 'GET' && path === '/genomes/threshold-alerts') {
        return sendJson(response, 200, growthRuntime.genomeThresholdAlerts());
      }
      if (request.method === 'POST' && path === '/genomes/product-gate') {
        return sendJson(response, 200, growthRuntime.genomeProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/genomes/release-dossier') {
        return sendJson(response, 200, growthRuntime.genomeReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/trends/archive') {
        return sendJson(response, 200, growthRuntime.growthTrendArchive({
          trendType: url.searchParams.get('trendType') || null,
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 200
        }));
      }
      if (request.method === 'GET' && path === '/advanced-learning') {
        return sendJson(response, 200, growthRuntime.advancedLearningModels());
      }
      if (request.method === 'GET' && path === '/advanced-learning/skill-registry') {
        return sendJson(response, 200, growthRuntime.skillRegistryStatus());
      }
      if (request.method === 'GET' && path === '/advanced-learning/verifier') {
        return sendJson(response, 200, growthRuntime.advancedLearningVerifierReport());
      }
      if (request.method === 'POST' && path === '/advanced-learning/product-gate') {
        return sendJson(response, 200, growthRuntime.advancedLearningProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/advanced-learning/release-dossier') {
        return sendJson(response, 200, growthRuntime.advancedLearningReleaseDossier(await readJsonBody(request)));
      }
      const skillDraftReviewParams = routeParams('/advanced-learning/skill-drafts/:draftId/review', path);
      if (request.method === 'POST' && skillDraftReviewParams) {
        return sendJson(response, 200, growthRuntime.reviewSkillDraft(skillDraftReviewParams.draftId, await readJsonBody(request)));
      }
      const skillUsefulnessParams = routeParams('/advanced-learning/skill-registry/:skillId/usefulness', path);
      if (request.method === 'POST' && skillUsefulnessParams) {
        return sendJson(response, 200, growthRuntime.recordSkillUsefulness(skillUsefulnessParams.skillId, await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/maturity-score') {
        return sendJson(response, 200, growthRuntime.maturityScore());
      }
      if (request.method === 'GET' && path === '/maturity-score/trends') {
        return sendJson(response, 200, growthRuntime.maturityTrend());
      }
      if (request.method === 'GET' && path === '/maturity-score/thresholds') {
        return sendJson(response, 200, growthRuntime.maturityThresholds());
      }
      if (request.method === 'GET' && path === '/maturity-score/threshold-profile') {
        return sendJson(response, 200, growthRuntime.maturityThresholdProfile({
          userScope: url.searchParams.get('userScope') ?? 'default-user',
          workspaceScope: url.searchParams.get('workspaceScope') ?? 'default-workspace'
        }));
      }
      if (request.method === 'POST' && path === '/maturity-score/threshold-migration-diff') {
        return sendJson(response, 200, growthRuntime.maturityThresholdMigrationDiff(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/maturity-score/thresholds/calibration') {
        return sendJson(response, 200, growthRuntime.calibrateMaturityThresholds(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/maturity-score/alerts') {
        return sendJson(response, 200, growthRuntime.maturityAlerts());
      }
      if (request.method === 'GET' && path === '/maturity-score/dashboard') {
        return sendJson(response, 200, growthRuntime.maturityDashboard());
      }
      if (request.method === 'POST' && path === '/maturity-score/product-gate') {
        return sendJson(response, 200, growthRuntime.maturityProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/maturity-score/release-dossier') {
        return sendJson(response, 200, growthRuntime.maturityScoreReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/autonomy/candidates/generate') {
        return sendJson(response, 200, { items: growthRuntime.generateAutonomyCandidates() });
      }
      if (request.method === 'GET' && path === '/autonomy/candidates') {
        return sendJson(response, 200, growthRuntime.autonomyCandidateLifecycle());
      }
      if (request.method === 'GET' && path === '/autonomy/candidates/trends') {
        return sendJson(response, 200, growthRuntime.autonomyDecisionTrend());
      }
      if (request.method === 'POST' && path === '/autonomy/candidates/expiry/run') {
        return sendJson(response, 200, growthRuntime.runAutonomyExpiryScheduler(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/autonomy/candidates/release-dossier') {
        return sendJson(response, 200, growthRuntime.autonomyCandidateReleaseDossier(await readJsonBody(request)));
      }
      const submitParams = routeParams('/autonomy/candidates/:candidateId/submit-to-policy', path);
      if (request.method === 'POST' && submitParams) {
        return sendJson(response, 200, growthRuntime.submitAutonomyCandidate(submitParams.candidateId));
      }
      const reviewParams = routeParams('/autonomy/candidates/:candidateId/review', path);
      if (request.method === 'POST' && reviewParams) {
        return sendJson(response, 200, growthRuntime.reviewAutonomyCandidate(reviewParams.candidateId, await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/memory/hygiene/report') {
        const review = growthRuntime.latestReview();
        return sendJson(response, 200, review.hygiene);
      }
      if (request.method === 'GET' && path === '/memory/hygiene/trends') {
        return sendJson(response, 200, growthRuntime.hygieneTrendReport({
          windowDays: Number(url.searchParams.get('windowDays') ?? 30),
          intervalDays: Number(url.searchParams.get('intervalDays') ?? 7),
          sensitiveReviewDays: Number(url.searchParams.get('sensitiveReviewDays') ?? 0),
          staleReviewDays: Number(url.searchParams.get('staleReviewDays') ?? 90)
        }));
      }
      if (request.method === 'GET' && path === '/memory/hygiene/decisions/history') {
        return sendJson(response, 200, growthRuntime.hygieneDecisionHistory({
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit'),
          action: url.searchParams.get('action'),
          targetType: url.searchParams.get('targetType')
        }));
      }
      if (request.method === 'GET' && path === '/memory/retention/calendar') {
        return sendJson(response, 200, growthRuntime.retentionPolicyCalendar({
          horizonDays: Number(url.searchParams.get('horizonDays') ?? 28),
          intervalDays: Number(url.searchParams.get('intervalDays') ?? 7),
          sensitiveReviewDays: Number(url.searchParams.get('sensitiveReviewDays') ?? 0),
          staleReviewDays: Number(url.searchParams.get('staleReviewDays') ?? 90)
        }));
      }
      if (request.method === 'POST' && path === '/memory/hygiene/decisions') {
        return sendJson(response, 200, growthRuntime.decideHygiene(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/hygiene/decisions/batch') {
        return sendJson(response, 200, growthRuntime.decideHygieneBatch(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/hygiene/product-gate') {
        return sendJson(response, 200, growthRuntime.hygieneReviewProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/memory/hygiene/release-dossier') {
        return sendJson(response, 200, growthRuntime.hygieneReviewReleaseDossier(await readJsonBody(request)));
      }
      sendJson(response, 404, { success: false, error: { code: 'F_ROUTE_NOT_FOUND' } });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 17780);
  createGrowthMemoryServer(new GrowthRuntime({ memoryStore: new SqliteMemoryStore() })).listen(port, '127.0.0.1', () => {
    console.log(`JARVIS-F Growth Memory listening at http://127.0.0.1:${port}`);
  });
}
