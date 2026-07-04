import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';

export async function runGrowthQualityCorpus({
  jsonPath = 'dist/growth-quality-corpus-report.json',
  markdownPath = 'dist/growth-quality-corpus-report.md',
  csvPath = 'dist/growth-quality-corpus-report.csv',
  clock = () => new Date()
} = {}) {
  const corpusRoot = await mkdtemp(join(tmpdir(), 'jarvis-growth-quality-corpus-'));
  const memoryStore = new SqliteMemoryStore({
    dbPath: join(corpusRoot, 'growth.sqlite'),
    reviewDir: join(corpusRoot, 'reviews'),
    backupDir: join(corpusRoot, 'backups'),
    clock
  });
  const { growthRuntime } = createAgRuntime({ clock, memoryStore });
  const seed = seedGrowthQualityCorpus(growthRuntime);
  const preferenceCandidate = growthRuntime.latestReview().preferenceCandidates.find((item) => item.statement.includes('날짜를 크게'));
  const confirmedPreference = preferenceCandidate
    ? growthRuntime.decidePreference({
        hypothesisId: preferenceCandidate.hypothesisId,
        decision: 'confirm',
        decidedBy: 'growth_quality_corpus',
        reason: 'stable formatting preference in quality corpus',
        scopePolicy: {
          userScope: 'quality-corpus-user',
          workspaceScope: 'weekly-report-workspace',
          taskFamily: 'document_workflow'
        }
      })
    : { success: false, error: { code: 'F_QUALITY_PREFERENCE_CANDIDATE_MISSING' } };
  const conflictCandidate = growthRuntime.latestReview().preferenceCandidates.find((item) => item.statement.includes('작게'));
  const batchPreferenceReview = conflictCandidate
    ? growthRuntime.decidePreferenceBatch({
        decisions: [{
          hypothesisId: conflictCandidate.hypothesisId,
          decision: 'reject',
          reason: 'conflicts with confirmed large-date preference',
          scopePolicy: {
            userScope: 'quality-corpus-user',
            workspaceScope: 'weekly-report-workspace'
          }
        }],
        decidedBy: 'growth_quality_corpus'
      })
    : { success: false, error: { code: 'F_QUALITY_CONFLICT_CANDIDATE_MISSING' } };
  const preferenceMigration = growthRuntime.preferenceMigrationDiff({
    targetScopePolicy: {
      workspaceScope: 'weekly-report-workspace-v2',
      migrationStrategy: 'batch_review_before_apply'
    }
  });
  const firstFailure = growthRuntime.latestReview().failureLessons[0] ?? null;
  const failureGuardrailReview = firstFailure
    ? growthRuntime.reviewFailureGuardrail(firstFailure.failureId, {
        decision: 'update',
        reviewedBy: 'growth_quality_corpus',
        reason: 'quality corpus recurrence review',
        patch: {
          guardrailChecklist: [...firstFailure.guardrailChecklist, 'verify_recurrence_dashboard_before_autonomy'],
          lesson: `${firstFailure.lesson} 재발 대시보드에서 안정 상태를 확인한 뒤 자동화 후보로 승격한다.`
        }
      })
    : { success: false, error: { code: 'F_QUALITY_FAILURE_LESSON_MISSING' } };
  const recurrenceDashboard = growthRuntime.planningFailureGuardrails('').recurrenceDashboard;
  const failureMemoryProductGate = growthRuntime.failureMemoryProductGate({ query: '밴드' });
  const failureMemoryReleaseDossier = growthRuntime.failureMemoryReleaseDossier({ query: '밴드' });
  const advancedBeforeReview = growthRuntime.advancedLearningModels();
  const firstSkillDraft = advancedBeforeReview.skillDistillations[0] ?? null;
  const skillReview = firstSkillDraft
    ? growthRuntime.reviewSkillDraft(firstSkillDraft.distilledSkillId, {
        decision: 'approve',
        decidedBy: 'growth_quality_corpus',
        reason: 'quality corpus confirms non-executable assistive draft'
      })
    : { success: false, error: { code: 'F_QUALITY_SKILL_DRAFT_MISSING' } };
  const skillUsefulness = skillReview.registryEntry
    ? growthRuntime.recordSkillUsefulness(skillReview.registryEntry.skillId, {
        outcome: 'adopted',
        taskId: 'growth_quality_skill_usefulness',
        decidedBy: 'growth_quality_corpus',
        reason: 'draft helped produce a safer repeated-workflow checklist'
      })
    : { success: false, error: { code: 'F_QUALITY_SKILL_REGISTRY_ENTRY_MISSING' } };
  const autonomyCandidate = growthRuntime.generateAutonomyCandidates()[0] ?? null;
  const submittedAutonomy = autonomyCandidate
    ? growthRuntime.submitAutonomyCandidate(autonomyCandidate.candidateId)
    : { success: false, error: { code: 'F_QUALITY_AUTONOMY_CANDIDATE_MISSING' } };
  const reviewedAutonomy = autonomyCandidate
    ? growthRuntime.reviewAutonomyCandidate(autonomyCandidate.candidateId, {
        decision: 'approve',
        decidedBy: 'growth_quality_corpus',
        reason: 'policy-approved low-risk repeated workflow'
      })
    : { success: false, error: { code: 'F_QUALITY_AUTONOMY_CANDIDATE_MISSING' } };
  const autonomyExpiryScheduler = growthRuntime.runAutonomyExpiryScheduler({ dryRun: true });
  const autonomyReleaseDossier = growthRuntime.autonomyCandidateReleaseDossier();

  const review = growthRuntime.latestReview();
  const advanced = growthRuntime.advancedLearningModels();
  const skillRegistryPersistence = growthRuntime.skillRegistryPersistenceStatus();
  const advancedLearningVerifier = growthRuntime.advancedLearningVerifierReport();
  const advancedLearningProductGate = growthRuntime.advancedLearningProductGate();
  const advancedLearningReleaseDossier = growthRuntime.advancedLearningReleaseDossier();
  const autonomyLifecycle = growthRuntime.autonomyCandidateLifecycle();
  const autonomyDecisionTrend = growthRuntime.autonomyDecisionTrend();
  const maturity = growthRuntime.maturityScore();
  const maturityProductGate = growthRuntime.maturityProductGate({
    score: maturity,
    targetThresholds: { totalMin: 75, verificationPassRateMin: 0.95 }
  });
  const maturityReleaseDossier = growthRuntime.maturityScoreReleaseDossier({
    targetThresholds: { totalMin: 75, verificationPassRateMin: 0.95 }
  });
  const hygieneTrend = growthRuntime.hygieneTrendReport({ windowDays: 180, staleReviewDays: 30 });
  const trendArchive = growthRuntime.growthTrendArchive();
  const genomeProductGate = growthRuntime.genomeProductGate();
  const genomeReleaseDossier = growthRuntime.genomeReleaseDossier({ query: '날짜' });
  const memoryEventSchemaBundle = growthRuntime.memoryEventJsonSchemaBundle();
  const memoryEventFixtureCorpus = growthRuntime.memoryEventFixtureCorpus();
  const memoryEventMigrationCompatibility = growthRuntime.memoryEventMigrationCompatibilityReport();
  const learningVerifierSchemaMatrix = growthRuntime.memoryEventLearningVerifierSchemaMatrix();
  const memoryEventIngestProductGate = growthRuntime.memoryEventIngestProductGate();
  const memoryEventIngestReleaseDossier = growthRuntime.memoryEventIngestReleaseDossier();
  const conflictReport = growthRuntime.preferenceConflictReport();
  const preferenceConfidenceCalibration = growthRuntime.preferenceConfidenceCalibration();
  const preferenceToleranceProfile = growthRuntime.preferenceToleranceProfile();
  const preferenceProductGate = growthRuntime.preferenceHypothesisProductGate();
  const preferenceReleaseDossier = growthRuntime.preferenceHypothesisReleaseDossier();
  const confirmedPreferenceProductGate = growthRuntime.confirmedPreferenceProductGate({
    query: '날짜',
    targetScopePolicy: {
      workspaceScope: 'weekly-report-workspace-v2',
      migrationStrategy: 'batch_review_before_apply'
    }
  });
  const confirmedPreferenceReleaseDossier = growthRuntime.confirmedPreferenceReleaseDossier({
    query: '날짜',
    targetScopePolicy: {
      workspaceScope: 'weekly-report-workspace-v2',
      migrationStrategy: 'batch_review_before_apply'
    }
  });
  const patternEmbeddingAdapters = growthRuntime.patternEmbeddingAdapterStatus();
  const patternCorpus = growthRuntime.patternAnonymizedCorpus();
  const patternClusterReview = growthRuntime.patternClusterReview();
  const patternMiningProductGate = growthRuntime.patternMiningProductGate({ minPatterns: 2, minCorpusItems: 12 });
  const sensitiveMinimizerFixtures = growthRuntime.sensitiveMinimizerFixtureReport();
  const sensitiveFalsePositiveDashboard = growthRuntime.sensitiveMinimizerFalsePositiveDashboard({
    fixtureReport: sensitiveMinimizerFixtures
  });
  const sensitiveMinimizerReleaseDossier = growthRuntime.sensitiveMinimizerReleaseDossier();
  const retentionPolicyUi = growthRuntime.retentionPolicyUiContract({ sensitiveReviewDays: 0, staleReviewDays: 90 });
  const hygieneProductGate = growthRuntime.hygieneReviewProductGate({ windowDays: 180, sensitiveReviewDays: 0, staleReviewDays: 90 });
  const hygieneReleaseDossier = growthRuntime.hygieneReviewReleaseDossier({ windowDays: 180, sensitiveReviewDays: 0, staleReviewDays: 90 });
  const storageProductGate = growthRuntime.storagePersistenceProductGate({
    backupId: 'growth-quality-storage-product-gate',
    largeMigrationEventCount: 120,
    wormDryRun: false
  });
  const storageReleaseDossier = storageProductGate.releaseDossier;
  const checks = [];
  const add = (checkId, pass, detail = {}) => checks.push({ checkId, status: pass ? 'passed' : 'failed', detail });

  add('memory_event_corpus_seeded', seed.eventCount >= 30, { eventCount: seed.eventCount });
  add('memory_event_schema_bundle_exported', memoryEventSchemaBundle.bundleVersion === 'f-memory-event-json-schema-bundle-v1' && memoryEventSchemaBundle.schemas.MemoryEvent.required.includes('learningFlags'), {
    bundleVersion: memoryEventSchemaBundle.bundleVersion,
    schemaVersion: memoryEventSchemaBundle.schemaVersion
  });
  add('memory_event_fixture_corpus_compatible', memoryEventFixtureCorpus.corpusVersion === 'f-memory-event-fixture-corpus-v1' && memoryEventMigrationCompatibility.status === 'passed', {
    fixtureCount: memoryEventFixtureCorpus.fixtureCount,
    compatibilityItems: memoryEventMigrationCompatibility.itemCount,
    variantCoverage: memoryEventMigrationCompatibility.variantCoverage
  });
  add('memory_event_learning_verifier_schema_matrix_passed', learningVerifierSchemaMatrix.matrixVersion === 'f-g-learning-verifier-schema-matrix-v1' && learningVerifierSchemaMatrix.status === 'passed', {
    linked: learningVerifierSchemaMatrix.linked,
    fixtureCount: learningVerifierSchemaMatrix.fixtureCount,
    variantCoverage: learningVerifierSchemaMatrix.variantCoverage
  });
  add('memory_event_ingest_product_gate_passed', memoryEventIngestProductGate.productGateVersion === 'f-memory-event-ingest-product-gate-v1'
    && memoryEventIngestProductGate.status === 'passed'
    && memoryEventIngestProductGate.operationalCorpus.rawPayloadStored === false
    && memoryEventIngestProductGate.schemaDiffApproval.workflowVersion === 'f-memory-event-schema-diff-approval-workflow-v1'
    && memoryEventIngestProductGate.generatedFixtureDrift.dashboardVersion === 'f-memory-event-generated-fixture-drift-dashboard-v1', {
    status: memoryEventIngestProductGate.status,
    telemetry: memoryEventIngestProductGate.telemetry.telemetryVersion,
    storedCount: memoryEventIngestProductGate.telemetry.storedCount,
    operationalItems: memoryEventIngestProductGate.operationalCorpus.itemCount,
    backpressureStatus: memoryEventIngestProductGate.backpressure.status,
    schemaDiffApprovalStatus: memoryEventIngestProductGate.schemaDiffApproval.status,
    generatedFixtureDriftStatus: memoryEventIngestProductGate.generatedFixtureDrift.status
  });
  add('memory_event_ingest_release_dossier_passed', memoryEventIngestReleaseDossier.dossierVersion === 'f-memory-event-ingest-release-dossier-v1'
    && memoryEventIngestReleaseDossier.status === 'passed'
    && memoryEventIngestReleaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
    && memoryEventIngestReleaseDossier.operationalHandoffManifest.status === 'ready'
    && memoryEventIngestReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-memory-event-ingest-worm-promotion-package-v1', {
    status: memoryEventIngestReleaseDossier.status,
    releaseHash: memoryEventIngestReleaseDossier.releaseHash,
    operationalHandoffStatus: memoryEventIngestReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: memoryEventIngestReleaseDossier.externalWormPromotionPackage.status
  });
  add('pattern_miner_detects_multiple_workflows', review.repeatedTasks.length >= 2, {
    patternCount: review.repeatedTasks.length,
    patterns: review.repeatedTasks.map((item) => item.description)
  });
  add('negative_evidence_affects_pattern_safety', review.repeatedTasks.some((item) => item.negativeEvidence?.count > 0 && item.safetyStatus === 'review_required_negative_evidence'), {
    patterns: review.repeatedTasks.map((item) => ({ patternId: item.patternId, negativeEvidence: item.negativeEvidence, safetyStatus: item.safetyStatus }))
  });
  add('pattern_embedding_adapter_policy_declared', patternEmbeddingAdapters.registryVersion === 'f-pattern-embedding-adapter-registry-v1'
    && patternEmbeddingAdapters.policy.externalOptInRequired === true
    && patternEmbeddingAdapters.policy.rawTextExported === false
    && patternEmbeddingAdapters.adapters.some((item) => item.provider === 'local' && item.enabled === true), {
    registryVersion: patternEmbeddingAdapters.registryVersion,
    externalAvailable: patternEmbeddingAdapters.externalAvailable,
    policy: patternEmbeddingAdapters.policy
  });
  add('pattern_anonymized_corpus_exported', patternCorpus.corpusVersion === 'f-pattern-anonymized-log-corpus-v1'
    && patternCorpus.itemCount >= 12
    && patternCorpus.privacy.rawTextStored === false
    && patternCorpus.privacy.eventIdsHashed === true
    && patternCorpus.rejectedItems.some((item) => item.reasons.includes('contains-sensitive-data') || item.reasons.includes('external-content')), {
    corpusVersion: patternCorpus.corpusVersion,
    itemCount: patternCorpus.itemCount,
    rejectedCount: patternCorpus.rejectedCount,
    scaleProfile: patternCorpus.scaleProfile
  });
  add('pattern_cluster_review_has_split_merge_actions', patternClusterReview.reportVersion === 'f-pattern-cluster-review-v1'
    && patternClusterReview.reviewActions.includes('approve_merge')
    && patternClusterReview.reviewActions.includes('split_cluster')
    && patternClusterReview.mergeCandidates.length >= 1
    && patternClusterReview.splitCandidates.length >= 1, {
    reportVersion: patternClusterReview.reportVersion,
    reviewQueueCount: patternClusterReview.reviewQueueCount,
    mergeCandidates: patternClusterReview.mergeCandidates.length,
    splitCandidates: patternClusterReview.splitCandidates.length,
    uiContract: patternClusterReview.uiContract
  });
  add('pattern_mining_product_gate_passed', patternMiningProductGate.productGateVersion === 'f-pattern-mining-product-gate-v1'
    && patternMiningProductGate.status === 'passed'
    && patternMiningProductGate.releaseDossier.dossierVersion === 'f-pattern-mining-release-dossier-v1'
    && patternMiningProductGate.releaseDossier.operationalHandoffManifest.status === 'ready'
    && patternMiningProductGate.releaseDossier.externalWormPromotionPackage.packageVersion === 'f-pattern-mining-worm-promotion-package-v1'
    && patternMiningProductGate.embeddingAdapters.registryVersion === 'f-pattern-embedding-adapter-registry-v1'
    && patternMiningProductGate.corpus.privacy.rawTextStored === false
    && patternMiningProductGate.clusterReview.uiContract.contractVersion === 'f-pattern-cluster-review-ui-contract-v1', {
    status: patternMiningProductGate.status,
    checks: patternMiningProductGate.checks.map((item) => ({ checkId: item.checkId, passed: item.passed })),
    patternCount: patternMiningProductGate.patterns.length,
    corpusItemCount: patternMiningProductGate.corpus.itemCount,
    reviewQueueCount: patternMiningProductGate.clusterReview.reviewQueueCount,
    wormPromotionStatus: patternMiningProductGate.releaseDossier.externalWormPromotionPackage.status
  });
  add('confirmed_preference_promoted', confirmedPreference.success === true && review.confirmedPreferences.length >= 1, {
    confirmedPreferenceCount: review.confirmedPreferences.length
  });
  add('confirmed_preference_scope_batch_reviewed', confirmedPreference.item?.scopePolicy?.policyVersion === 'f-confirmed-preference-scope-policy-v1' && batchPreferenceReview.success === true, {
    scopePolicy: confirmedPreference.item?.scopePolicy,
    batchId: batchPreferenceReview.batchId,
    appliedCount: batchPreferenceReview.appliedCount
  });
  add('confirmed_preference_migration_diff_created', preferenceMigration.diffVersion === 'f-confirmed-preference-migration-diff-v1' && preferenceMigration.migrationRequiredCount >= 1, {
    migrationRequiredCount: preferenceMigration.migrationRequiredCount
  });
  add('confirmed_preference_product_gate_passed', confirmedPreferenceProductGate.productGateVersion === 'f-confirmed-preference-product-gate-v1'
    && confirmedPreferenceProductGate.status === 'passed'
    && confirmedPreferenceProductGate.applicationPreview.previewVersion === 'f-confirmed-preference-application-preview-v1'
    && confirmedPreferenceProductGate.conflictDossier.dossierVersion === 'f-confirmed-preference-conflict-resolution-dossier-v1'
    && confirmedPreferenceProductGate.driftTrend.trendVersion === 'f-confirmed-preference-drift-trend-v1'
    && confirmedPreferenceProductGate.migrationReviewQueue.queueVersion === 'f-confirmed-preference-scope-migration-review-queue-v1', {
    status: confirmedPreferenceProductGate.status,
    planningHints: confirmedPreferenceProductGate.applicationPreview.planningHints.length,
    migrationQueueCount: confirmedPreferenceProductGate.migrationReviewQueue.queueCount,
    driftStatus: confirmedPreferenceProductGate.driftTrend.status
  });
  add('confirmed_preference_release_dossier_passed', confirmedPreferenceReleaseDossier.dossierVersion === 'f-confirmed-preference-release-dossier-v1'
    && confirmedPreferenceReleaseDossier.status === 'passed'
    && confirmedPreferenceReleaseDossier.lifecycleWorkflow.workflowVersion === 'f-confirmed-preference-lifecycle-release-workflow-v1'
    && confirmedPreferenceReleaseDossier.artifactManifest.rawPreferenceStatementStored === false
    && confirmedPreferenceReleaseDossier.operationalHandoffManifest.status === 'ready'
    && confirmedPreferenceReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-confirmed-preference-worm-promotion-package-v1'
    && confirmedPreferenceReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: confirmedPreferenceReleaseDossier.status,
    releaseHash: confirmedPreferenceReleaseDossier.releaseHash,
    handoffStatus: confirmedPreferenceReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: confirmedPreferenceReleaseDossier.externalWormPromotionPackage.status,
    checks: confirmedPreferenceReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('preference_conflict_detected', conflictReport.items.some((item) => item.severity === 'high' || item.semanticConflictSummary?.highestSeverity === 'high'), {
    conflictCount: conflictReport.items.length
  });
  add('preference_confidence_calibration_ready', preferenceConfidenceCalibration.reportVersion === 'f-preference-confidence-calibration-report-v1'
    && preferenceConfidenceCalibration.corpusVersion === 'f-preference-confidence-calibration-corpus-v1'
    && preferenceConfidenceCalibration.privacy.rawTextStored === false
    && preferenceConfidenceCalibration.privacy.statementHashOnly === true, {
    candidateCount: preferenceConfidenceCalibration.candidateCount,
    meanCalibrationError: preferenceConfidenceCalibration.meanCalibrationError,
    horizon: preferenceConfidenceCalibration.horizon
  });
  add('preference_tolerance_profile_visualized', preferenceToleranceProfile.profileVersion === 'f-preference-tolerance-profile-v1'
    && preferenceToleranceProfile.visualizationVersion === 'f-preference-tolerance-visualization-v1'
    && preferenceToleranceProfile.policy.confirmRequiresAcknowledgement === true, {
    averageTolerance: preferenceToleranceProfile.summary.averageTolerance,
    strictReviewDimensions: preferenceToleranceProfile.summary.strictReviewDimensions
  });
  add('preference_hypothesis_product_gate_passed', preferenceProductGate.productGateVersion === 'f-preference-hypothesis-product-gate-v1'
    && preferenceProductGate.status === 'passed', {
    checks: preferenceProductGate.checks
  });
  add('preference_hypothesis_release_dossier_passed', preferenceReleaseDossier.dossierVersion === 'f-preference-hypothesis-release-dossier-v1'
    && preferenceReleaseDossier.status === 'passed'
    && preferenceReleaseDossier.safetyProbe.unsafeCandidateCount === 0
    && preferenceReleaseDossier.artifactManifest.rawPreferenceTextStored === false
    && preferenceReleaseDossier.operationalHandoffManifest.status === 'ready'
    && preferenceReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-preference-hypothesis-worm-promotion-package-v1', {
    checks: preferenceReleaseDossier.checks,
    releaseHash: preferenceReleaseDossier.releaseHash,
    wormPromotionStatus: preferenceReleaseDossier.externalWormPromotionPackage.status
  });
  add('failure_guardrails_created', review.failureLessons.length >= 2 && review.failureLessons.some((item) => item.planningGuardrail?.injectBefore === 'A.TaskPlanner.createPlan'), {
    failureCount: review.failureLessons.length
  });
  add('failure_guardrail_review_persisted_and_dashboarded', failureGuardrailReview.success === true && failureGuardrailReview.persisted === true && recurrenceDashboard.dashboardVersion === 'f-failure-recurrence-dashboard-v1', {
    persisted: failureGuardrailReview.persisted,
    recurrenceDashboard
  });
  add('failure_memory_product_gate_passed', failureMemoryProductGate.productGateVersion === 'f-failure-memory-product-gate-v1'
    && failureMemoryProductGate.status === 'passed'
    && failureMemoryProductGate.reviewQueue.queueVersion === 'f-failure-guardrail-review-queue-v1'
    && failureMemoryProductGate.recurrenceVisualization.visualizationVersion === 'f-failure-recurrence-trend-visualization-v1'
    && failureMemoryProductGate.effectivenessTuning.reportVersion === 'f-failure-guardrail-effectiveness-tuning-v1', {
    status: failureMemoryProductGate.status,
    reviewQueueCount: failureMemoryProductGate.reviewQueue.queueCount,
    recurrenceStatus: failureMemoryProductGate.recurrenceVisualization.status,
    averageEffectivenessScore: failureMemoryProductGate.effectivenessTuning.averageEffectivenessScore
  });
  add('failure_memory_release_dossier_passed', failureMemoryReleaseDossier.dossierVersion === 'f-failure-memory-release-dossier-v1'
    && failureMemoryReleaseDossier.status === 'passed'
    && failureMemoryReleaseDossier.releaseWorkflow.workflowVersion === 'f-failure-memory-release-workflow-v1'
    && failureMemoryReleaseDossier.artifactManifest.rawFailurePayloadStored === false
    && failureMemoryReleaseDossier.operationalHandoffManifest.status === 'ready'
    && failureMemoryReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-failure-memory-worm-promotion-package-v1'
    && failureMemoryReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: failureMemoryReleaseDossier.status,
    releaseHash: failureMemoryReleaseDossier.releaseHash,
    handoffStatus: failureMemoryReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: failureMemoryReleaseDossier.externalWormPromotionPackage.status,
    checks: failureMemoryReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('hygiene_blocks_sensitive_and_external_memory', hygieneTrend.memoryEvents.sensitive >= 1 && hygieneTrend.memoryEvents.externalContent >= 1 && review.hygiene.reviewQueue.length >= 1, {
    sensitive: hygieneTrend.memoryEvents.sensitive,
    externalContent: hygieneTrend.memoryEvents.externalContent,
    reviewQueue: review.hygiene.reviewQueue.length
  });
  add('sensitive_minimizer_fixture_pack_passed', sensitiveMinimizerFixtures.reportVersion === 'f-sensitive-minimizer-fixture-report-v1'
    && sensitiveMinimizerFixtures.status === 'passed'
    && sensitiveMinimizerFixtures.fixtureCount >= 6
    && sensitiveMinimizerFixtures.coverage.ruleIds.includes('email_address')
    && sensitiveMinimizerFixtures.items.every((item) => item.redactionDiffHashOnly === true), {
    fixturePackId: sensitiveMinimizerFixtures.fixturePackId,
    fixtureCount: sensitiveMinimizerFixtures.fixtureCount,
    passRate: sensitiveMinimizerFixtures.passRate,
    ruleIds: sensitiveMinimizerFixtures.coverage.ruleIds
  });
  add('sensitive_false_positive_dashboard_ready', sensitiveFalsePositiveDashboard.dashboardVersion === 'f-sensitive-minimizer-false-positive-dashboard-v1'
    && sensitiveFalsePositiveDashboard.queueCount >= 1
    && sensitiveFalsePositiveDashboard.uiContract.decisionActions.includes('add_context_exception'), {
    queueCount: sensitiveFalsePositiveDashboard.queueCount,
    uiContract: sensitiveFalsePositiveDashboard.uiContract
  });
  add('sensitive_minimizer_release_dossier_passed', sensitiveMinimizerReleaseDossier.dossierVersion === 'f-sensitive-minimizer-release-dossier-v1'
    && sensitiveMinimizerReleaseDossier.status === 'passed'
    && sensitiveMinimizerReleaseDossier.releaseWorkflow.workflowVersion === 'f-sensitive-minimizer-release-workflow-v1'
    && sensitiveMinimizerReleaseDossier.artifactManifest.rawSensitivePayloadStored === false
    && sensitiveMinimizerReleaseDossier.artifactManifest.falsePositiveReviewStoredHashOnly === true
    && sensitiveMinimizerReleaseDossier.artifactManifest.contextExceptionRawTextStored === false
    && sensitiveMinimizerReleaseDossier.artifactManifest.retentionPolicyValuesHashOnly === true
    && sensitiveMinimizerReleaseDossier.operationalHandoffManifest.status === 'ready'
    && sensitiveMinimizerReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-sensitive-minimizer-worm-promotion-package-v1', {
    status: sensitiveMinimizerReleaseDossier.status,
    releaseHash: sensitiveMinimizerReleaseDossier.releaseHash,
    operationalHandoffStatus: sensitiveMinimizerReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: sensitiveMinimizerReleaseDossier.externalWormPromotionPackage.status,
    checks: sensitiveMinimizerReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('sensitive_false_positive_review_decision_persisted', sensitiveMinimizerReleaseDossier.releaseWorkflow.falsePositiveReviewLedger?.ledgerVersion === 'f-sensitive-minimizer-false-positive-review-ledger-v1'
    && sensitiveMinimizerReleaseDossier.releaseWorkflow.falsePositiveReviewLedger?.decisionCount >= 1
    && sensitiveMinimizerReleaseDossier.artifactManifest.falsePositiveReviewStoredHashOnly === true, {
    decisionCount: sensitiveMinimizerReleaseDossier.releaseWorkflow.falsePositiveReviewLedger?.decisionCount ?? 0,
    hashOnly: sensitiveMinimizerReleaseDossier.artifactManifest.falsePositiveReviewStoredHashOnly
  });
  add('sensitive_context_exception_registry_ready', sensitiveMinimizerReleaseDossier.releaseWorkflow.contextExceptionRegistry?.registryVersion === 'f-sensitive-minimizer-context-exception-registry-v1'
    && sensitiveMinimizerReleaseDossier.releaseWorkflow.contextExceptionRegistry?.exceptionCount >= 1
    && sensitiveMinimizerReleaseDossier.artifactManifest.contextExceptionRawTextStored === false, {
    exceptionCount: sensitiveMinimizerReleaseDossier.releaseWorkflow.contextExceptionRegistry?.exceptionCount ?? 0,
    rawTextStored: sensitiveMinimizerReleaseDossier.artifactManifest.contextExceptionRawTextStored
  });
  add('sensitive_retention_policy_diff_ready', sensitiveMinimizerReleaseDossier.releaseWorkflow.retentionPolicyDiff?.diffVersion === 'f-sensitive-minimizer-retention-policy-diff-v1'
    && sensitiveMinimizerReleaseDossier.releaseWorkflow.retentionPolicyDiff?.rawPolicyValuesStored === false
    && sensitiveMinimizerReleaseDossier.artifactManifest.retentionPolicyValuesHashOnly === true, {
    status: sensitiveMinimizerReleaseDossier.releaseWorkflow.retentionPolicyDiff?.status,
    changedFields: sensitiveMinimizerReleaseDossier.releaseWorkflow.retentionPolicyDiff?.changedFields?.length ?? 0
  });
  add('retention_policy_ui_contract_ready', retentionPolicyUi.uiContractVersion === 'f-retention-policy-ui-contract-v1'
    && retentionPolicyUi.policyRows.some((item) => item.policyId === 'sensitive-memory' && item.action === 'redact')
    && retentionPolicyUi.controls.some((item) => item.controlId === 'stale-review-days'), {
    status: retentionPolicyUi.status,
    policyRows: retentionPolicyUi.policyRows
  });
  add('hygiene_review_product_gate_passed', hygieneProductGate.productGateVersion === 'f-hygiene-review-product-gate-v1'
    && hygieneProductGate.status === 'passed'
    && hygieneProductGate.history.historyVersion === 'f-hygiene-decision-history-v1'
    && hygieneProductGate.calendar.calendarVersion === 'f-retention-policy-calendar-v1', {
    status: hygieneProductGate.status,
    historyTotal: hygieneProductGate.history.pageInfo.total,
    calendarStatus: hygieneProductGate.calendar.status
  });
  add('hygiene_release_dossier_passed', hygieneReleaseDossier.dossierVersion === 'f-hygiene-review-release-dossier-v1'
    && hygieneReleaseDossier.status === 'passed'
    && hygieneReleaseDossier.releaseWorkflow.workflowVersion === 'f-hygiene-review-release-workflow-v1'
    && hygieneReleaseDossier.artifactManifest.rawHygienePayloadStored === false
    && hygieneReleaseDossier.operationalHandoffManifest.status === 'ready'
    && hygieneReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-hygiene-review-worm-promotion-package-v1'
    && hygieneReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: hygieneReleaseDossier.status,
    releaseHash: hygieneReleaseDossier.releaseHash,
    handoffStatus: hygieneReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: hygieneReleaseDossier.externalWormPromotionPackage.status,
    checks: hygieneReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('genome_trend_recorded', review.genomes.schemaVersion === 'f-genome-v2' && Boolean(review.genomeTrend.latest?.snapshotId), {
    schemaVersion: review.genomes.schemaVersion,
    snapshotId: review.genomeTrend.latest?.snapshotId
  });
  add('genome_product_gate_passed', genomeProductGate.productGateVersion === 'f-genome-product-gate-v1'
    && genomeProductGate.status === 'passed'
    && genomeProductGate.calibration.profileVersion === 'f-genome-weight-calibration-profile-v1'
    && genomeProductGate.driftDiff.diffVersion === 'f-genome-drift-diff-v1'
    && genomeProductGate.dashboard.dashboardVersion === 'f-genome-product-dashboard-v1', {
    status: genomeProductGate.status,
    riskPosture: genomeProductGate.genomes.riskCalibration.posture,
    alertCount: genomeProductGate.alerts.alerts.length,
    archiveCount: genomeProductGate.archive.countsByType.genome
  });
  add('genome_release_dossier_passed', genomeReleaseDossier.dossierVersion === 'f-genome-release-dossier-v1'
    && genomeReleaseDossier.status === 'passed'
    && genomeReleaseDossier.releaseProjection.projectionVersion === 'f-genome-release-hash-only-projection-v1'
    && genomeReleaseDossier.artifactManifest.rawGenomeTextStored === false
    && genomeReleaseDossier.operationalHandoffManifest.status === 'ready'
    && genomeReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-genome-worm-promotion-package-v1'
    && genomeReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: genomeReleaseDossier.status,
    releaseHash: genomeReleaseDossier.releaseHash,
    handoffStatus: genomeReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: genomeReleaseDossier.externalWormPromotionPackage.status,
    checks: genomeReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('skill_distillation_reviewed', skillReview.success === true && advanced.skillRegistry.registryEntries.length >= 1, {
    registryEntries: advanced.skillRegistry.registryEntries.length
  });
  add('skill_registry_persisted_and_scored', skillRegistryPersistence.statusVersion === 'f-approved-skill-registry-persistence-v1'
    && skillRegistryPersistence.persisted === true
    && skillRegistryPersistence.snapshotCount >= 1
    && skillUsefulness.success === true
    && skillRegistryPersistence.usefulnessReport.reportVersion === 'f-skill-usefulness-report-v1', {
    snapshotCount: skillRegistryPersistence.snapshotCount,
    usefulnessAverage: skillRegistryPersistence.usefulnessReport.averageScore
  });
  add('advanced_learning_verifier_passed', advancedLearningVerifier.reportVersion === 'f-advanced-learning-verifier-report-v1'
    && advancedLearningVerifier.verifierVersion === 'g-advanced-learning-verifier-v1'
    && advancedLearningVerifier.status === 'passed', {
    checkedCount: advancedLearningVerifier.checkedCount,
    failedCount: advancedLearningVerifier.failedCount
  });
  add('advanced_learning_product_gate_passed', advancedLearningProductGate.productGateVersion === 'f-advanced-learning-product-gate-v1'
    && advancedLearningProductGate.status === 'passed'
    && advancedLearningProductGate.usefulnessCorpus.corpusVersion === 'f-skill-usefulness-operational-corpus-v1'
    && advancedLearningProductGate.providerComparisonTrend.trendVersion === 'f-skill-distillation-provider-comparison-trend-v1', {
    status: advancedLearningProductGate.status,
    registryEntries: advancedLearningProductGate.advancedLearning.skillRegistry.registryEntries.length,
    usefulnessCorpusItems: advancedLearningProductGate.usefulnessCorpus.entryCount,
    providerTrendStatus: advancedLearningProductGate.providerComparisonTrend.status
  });
  add('advanced_learning_release_dossier_passed', advancedLearningReleaseDossier.dossierVersion === 'f-advanced-learning-release-dossier-v1'
    && advancedLearningReleaseDossier.status === 'passed'
    && advancedLearningReleaseDossier.releaseProjection.projectionVersion === 'f-advanced-learning-release-hash-only-projection-v1'
    && advancedLearningReleaseDossier.artifactManifest.rawSkillTextStored === false
    && advancedLearningReleaseDossier.operationalHandoffManifest.status === 'ready'
    && advancedLearningReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-advanced-learning-worm-promotion-package-v1'
    && advancedLearningReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: advancedLearningReleaseDossier.status,
    releaseHash: advancedLearningReleaseDossier.releaseHash,
    handoffStatus: advancedLearningReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: advancedLearningReleaseDossier.externalWormPromotionPackage.status,
    checks: advancedLearningReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('autonomy_lifecycle_reviewed', reviewedAutonomy.success === true && growthRuntime.autonomyCandidateLifecycle().items.some((item) => item.status === 'user_approved'), {
    submittedStatus: submittedAutonomy.status ?? submittedAutonomy.lifecycle?.state ?? null
  });
  add('autonomy_lifecycle_persisted_trended', autonomyLifecycle.lifecycleVersion === 'f-autonomy-candidate-lifecycle-v2'
    && autonomyLifecycle.persistence.restorable === true
    && autonomyDecisionTrend.trendVersion === 'f-autonomy-decision-trend-v1'
    && autonomyDecisionTrend.total >= 1, {
    statusCounts: autonomyDecisionTrend.statusCounts,
    approvalRate: autonomyDecisionTrend.approvalRate
  });
  add('autonomy_expiry_scheduler_ready', autonomyExpiryScheduler.reportVersion === 'f-autonomy-expiry-scheduler-v1'
    && autonomyExpiryScheduler.status === 'passed'
    && autonomyExpiryScheduler.scannedCount >= 1, {
    expiredCount: autonomyExpiryScheduler.expiredCount,
    nextRunAfterMinutes: autonomyExpiryScheduler.nextRunAfterMinutes
  });
  add('autonomy_release_dossier_passed', autonomyReleaseDossier.dossierVersion === 'f-autonomy-candidate-release-dossier-v1'
    && autonomyReleaseDossier.status === 'passed'
    && autonomyReleaseDossier.releaseWorkflow.workflowVersion === 'f-autonomy-candidate-release-workflow-v1'
    && autonomyReleaseDossier.artifactManifest.rawCandidateTextStored === false
    && autonomyReleaseDossier.operationalHandoffManifest.status === 'ready'
    && autonomyReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-autonomy-candidate-worm-promotion-package-v1'
    && autonomyReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: autonomyReleaseDossier.status,
    releaseHash: autonomyReleaseDossier.releaseHash,
    handoffStatus: autonomyReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: autonomyReleaseDossier.externalWormPromotionPackage.status,
    checks: autonomyReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('maturity_score_threshold_passes', maturity.thresholdStatus === 'passed' && maturity.learningVerification.status === 'passed', {
    total: maturity.total,
    thresholdStatus: maturity.thresholdStatus,
    learningVerification: maturity.learningVerification.status
  });
  add('maturity_product_gate_passed', maturityProductGate.productGateVersion === 'f-maturity-score-product-gate-v1'
    && maturityProductGate.status === 'passed'
    && maturityProductGate.thresholdProfile.profileVersion === 'f-maturity-threshold-profile-v1'
    && maturityProductGate.migrationDiff.diffVersion === 'f-maturity-threshold-migration-diff-v1'
    && maturityProductGate.dashboard.dashboardVersion === 'f-maturity-score-dashboard-v1', {
    status: maturityProductGate.status,
    total: maturityProductGate.score.total,
    migrationRequired: maturityProductGate.migrationDiff.migrationRequired,
    alertCount: maturityProductGate.dashboard.alerts.items.length
  });
  add('maturity_release_dossier_passed', maturityReleaseDossier.dossierVersion === 'f-maturity-score-release-dossier-v1'
    && maturityReleaseDossier.status === 'passed'
    && maturityReleaseDossier.releaseWorkflow.workflowVersion === 'f-maturity-score-release-workflow-v1'
    && maturityReleaseDossier.artifactManifest.rawLearningPayloadStored === false
    && maturityReleaseDossier.operationalHandoffManifest.status === 'ready'
    && maturityReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-maturity-score-worm-promotion-package-v1'
    && maturityReleaseDossier.externalWormPromotionPackage.status === 'ready', {
    status: maturityReleaseDossier.status,
    releaseHash: maturityReleaseDossier.releaseHash,
    handoffStatus: maturityReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: maturityReleaseDossier.externalWormPromotionPackage.status,
    checks: maturityReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });
  add('growth_trend_snapshots_persisted', trendArchive.persisted === true && ['genome', 'maturity', 'hygiene'].every((type) => trendArchive.countsByType[type] >= 1), {
    countsByType: trendArchive.countsByType,
    latestByType: trendArchive.latestByType
  });
  add('storage_persistence_product_gate_passed', storageProductGate.productGateVersion === 'f-storage-persistence-product-gate-v1'
    && storageProductGate.status === 'passed'
    && storageProductGate.encryptedBackup.backupVersion === 'f-storage-encrypted-backup-v1'
    && storageProductGate.restoreDrill.drillVersion === 'f-storage-encrypted-restore-drill-v1'
    && storageProductGate.largeMigration.reportVersion === 'f-storage-large-migration-fixture-v1'
    && storageProductGate.wormSync.syncVersion === 'f-storage-worm-backup-sync-v1'
    && storageProductGate.atRestDeploymentPolicy.policyVersion === 'f-storage-at-rest-encryption-deployment-policy-v1'
    && storageProductGate.periodicRestoreDrill.evidenceVersion === 'f-storage-periodic-restore-drill-evidence-v1'
    && storageProductGate.releaseDossier.dossierVersion === 'f-storage-release-dossier-v1'
    && storageProductGate.releaseDossier.externalWormPromotionPackage.packageVersion === 'f-storage-worm-promotion-package-v1', {
    checks: storageProductGate.checks,
    encryptedBackup: storageProductGate.encryptedBackup.fileName,
    largeMigrationInserted: storageProductGate.largeMigration.insertedCount,
    wormStatus: storageProductGate.wormSync.status,
    atRestPolicyStatus: storageProductGate.atRestDeploymentPolicy.status,
    periodicRestoreStatus: storageProductGate.periodicRestoreDrill.status
  });
  add('storage_release_dossier_passed', storageReleaseDossier.dossierVersion === 'f-storage-release-dossier-v1'
    && storageReleaseDossier.status === 'passed'
    && storageReleaseDossier.releaseWorkflow.workflowVersion === 'f-storage-release-workflow-v1'
    && storageReleaseDossier.artifactManifest.manifestVersion === 'f-storage-release-artifact-manifest-v1'
    && storageReleaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
    && storageReleaseDossier.operationalHandoffManifest.status === 'ready'
    && storageReleaseDossier.externalWormPromotionPackage.packageVersion === 'f-storage-worm-promotion-package-v1', {
    status: storageReleaseDossier.status,
    releaseHash: storageReleaseDossier.releaseHash,
    wormArchive: storageReleaseDossier.artifactManifest.wormArchive.archiveContractVersion,
    operationalHandoffStatus: storageReleaseDossier.operationalHandoffManifest.status,
    wormPromotionStatus: storageReleaseDossier.externalWormPromotionPackage.status,
    checks: storageReleaseDossier.checks.map((item) => ({ checkId: item.checkId, passed: item.passed }))
  });

  const failed = checks.filter((check) => check.status === 'failed');
  const report = {
    reportVersion: 'f-growth-quality-corpus-report-v1',
    corpusId: 'f-growth-quality-corpus-v1',
    status: failed.length ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    checks,
    seed,
    metrics: {
      eventCount: growthRuntime.ingestor.all().length,
      patternCount: review.repeatedTasks.length,
      preferenceCandidateCount: review.preferenceCandidates.length,
      confirmedPreferenceCount: review.confirmedPreferences.length,
      failureLessonCount: review.failureLessons.length,
      failureMemoryProductGateStatus: failureMemoryProductGate.status,
      failureMemoryReleaseDossierStatus: failureMemoryReleaseDossier.status,
      failureGuardrailReviewQueueCount: failureMemoryProductGate.reviewQueue.queueCount,
      failureGuardrailAverageEffectiveness: failureMemoryProductGate.effectivenessTuning.averageEffectivenessScore,
      preferenceMigrationRequiredCount: preferenceMigration.migrationRequiredCount,
      confirmedPreferenceProductGateStatus: confirmedPreferenceProductGate.status,
      confirmedPreferenceReleaseDossierStatus: confirmedPreferenceReleaseDossier.status,
      confirmedPreferenceMigrationReviewQueueCount: confirmedPreferenceProductGate.migrationReviewQueue.queueCount,
      confirmedPreferenceDriftScore: confirmedPreferenceProductGate.driftTrend.driftScore,
      failureGuardrailReviewPersisted: failureGuardrailReview.persisted === true,
      skillDraftCount: advanced.skillDistillations.length,
      skillRegistryEntryCount: advanced.skillRegistry.registryEntries.length,
      skillRegistrySnapshotCount: skillRegistryPersistence.snapshotCount,
      skillUsefulnessAverage: skillRegistryPersistence.usefulnessReport.averageScore,
      advancedLearningProductGateStatus: advancedLearningProductGate.status,
      advancedLearningReleaseDossierStatus: advancedLearningReleaseDossier.status,
      skillUsefulnessOperationalCorpusItems: advancedLearningProductGate.usefulnessCorpus.entryCount,
      skillDistillationProviderTrendStatus: advancedLearningProductGate.providerComparisonTrend.status,
      autonomyCandidateCount: review.autonomyCandidates.length,
      autonomyDecisionTrendTotal: autonomyDecisionTrend.total,
      autonomyReleaseDossierStatus: autonomyReleaseDossier.status,
      maturityTotal: maturity.total,
      maturityThresholdStatus: maturity.thresholdStatus,
      maturityProductGateStatus: maturityProductGate.status,
      maturityReleaseDossierStatus: maturityReleaseDossier.status,
      maturityProductGateAlertCount: maturityProductGate.dashboard.alerts.items.length,
      hygieneHealthStatus: hygieneTrend.healthStatus,
      trendSnapshotCount: trendArchive.total,
      genomeProductGateStatus: genomeProductGate.status,
      genomeReleaseDossierStatus: genomeReleaseDossier.status,
      genomeProductGateAlertCount: genomeProductGate.alerts.alerts.length,
      memoryEventFixtureCount: memoryEventFixtureCorpus.fixtureCount,
      memoryEventMigrationCompatibilityItems: memoryEventMigrationCompatibility.itemCount,
      learningVerifierSchemaMatrixFixtures: learningVerifierSchemaMatrix.fixtureCount,
      memoryEventIngestTelemetryStored: memoryEventIngestProductGate.telemetry.storedCount,
      memoryEventOperationalCorpusItems: memoryEventIngestProductGate.operationalCorpus.itemCount,
      memoryEventIngestProductGateStatus: memoryEventIngestProductGate.status,
      memoryEventIngestReleaseDossierStatus: memoryEventIngestReleaseDossier.status,
      patternCorpusItemCount: patternCorpus.itemCount,
      patternCorpusRejectedCount: patternCorpus.rejectedCount,
      patternClusterReviewQueueCount: patternClusterReview.reviewQueueCount,
      patternMergeCandidateCount: patternClusterReview.mergeCandidates.length,
      patternSplitCandidateCount: patternClusterReview.splitCandidates.length,
      patternMiningProductGateStatus: patternMiningProductGate.status,
      patternMiningProductGateReviewQueueCount: patternMiningProductGate.clusterReview.reviewQueueCount,
      preferenceCalibrationMeanError: preferenceConfidenceCalibration.meanCalibrationError,
      preferenceToleranceAverage: preferenceToleranceProfile.summary.averageTolerance,
      sensitiveMinimizerFixtureCount: sensitiveMinimizerFixtures.fixtureCount,
      sensitiveFalsePositiveQueueCount: sensitiveFalsePositiveDashboard.queueCount,
      sensitiveMinimizerReleaseDossierStatus: sensitiveMinimizerReleaseDossier.status,
      retentionPolicyUiRows: retentionPolicyUi.policyRows.length,
      hygieneProductGateStatus: hygieneProductGate.status,
      hygieneReleaseDossierStatus: hygieneReleaseDossier.status,
      hygieneDecisionHistoryTotal: hygieneProductGate.history.pageInfo.total,
      storageLargeMigrationInserted: storageProductGate.largeMigration.insertedCount,
      storageProductGateStatus: storageProductGate.status,
      storageReleaseDossierStatus: storageReleaseDossier.status
    },
    review: {
      repeatedTasks: review.repeatedTasks.map((item) => ({
        patternId: item.patternId,
        description: item.description,
        occurrenceCount: item.occurrenceCount,
        safetyStatus: item.safetyStatus,
        supportScore: item.supportScore
      })),
      confirmedPreferences: review.confirmedPreferences.map((item) => ({
        preferenceId: item.preferenceId,
        statement: item.statement,
        status: item.status,
        confidence: item.confidence,
        scopePolicy: item.scopePolicy
      })),
      failureLessons: review.failureLessons.map((item) => ({
        failureId: item.failureId,
        taskId: item.taskId,
        category: item.cause?.category,
        severity: item.severity,
        futureGuardrail: item.futureGuardrail
      })),
      skillRegistry: advanced.skillRegistry,
      skillRegistryPersistence,
      advancedLearningVerifier,
      advancedLearningProductGate,
      advancedLearningReleaseDossier,
      autonomyLifecycle,
      autonomyDecisionTrend,
      autonomyExpiryScheduler,
      autonomyReleaseDossier,
      preferenceMigration,
      preferenceConfidenceCalibration,
      preferenceToleranceProfile,
      preferenceProductGate,
      preferenceReleaseDossier,
      confirmedPreferenceProductGate,
      confirmedPreferenceReleaseDossier,
      recurrenceDashboard,
      failureMemoryProductGate,
      failureMemoryReleaseDossier,
      maturity,
      maturityProductGate,
      maturityReleaseDossier,
      hygieneTrend,
      trendArchive,
      genomeProductGate,
      genomeReleaseDossier,
      memoryEventSchemaBundle: {
        bundleVersion: memoryEventSchemaBundle.bundleVersion,
        schemaVersion: memoryEventSchemaBundle.schemaVersion,
        required: memoryEventSchemaBundle.schemas.MemoryEvent.required,
        variantCount: memoryEventSchemaBundle.variantCatalog.familyCount + memoryEventSchemaBundle.variantCatalog.exactVariantCount
      },
      memoryEventFixtureCorpus: {
        corpusVersion: memoryEventFixtureCorpus.corpusVersion,
        fixtureCount: memoryEventFixtureCorpus.fixtureCount,
        validFixtureCount: memoryEventFixtureCorpus.validFixtureCount,
        invalidFixtureCount: memoryEventFixtureCorpus.invalidFixtureCount
      },
      memoryEventMigrationCompatibility,
      learningVerifierSchemaMatrix,
      memoryEventIngestProductGate,
      memoryEventIngestReleaseDossier,
      patternEmbeddingAdapters,
      patternCorpus: {
        corpusVersion: patternCorpus.corpusVersion,
        itemCount: patternCorpus.itemCount,
        rejectedCount: patternCorpus.rejectedCount,
        privacy: patternCorpus.privacy,
        scaleProfile: patternCorpus.scaleProfile,
        patternCoverage: patternCorpus.patternCoverage
      },
      patternClusterReview,
      patternMiningProductGate,
      sensitiveMinimizer: {
        fixtures: sensitiveMinimizerFixtures,
        falsePositiveDashboard: sensitiveFalsePositiveDashboard,
        releaseDossier: sensitiveMinimizerReleaseDossier,
        retentionPolicyUi
      },
      hygieneProductGate,
      hygieneReleaseDossier,
      storageProductGate,
      storageReleaseDossier
    },
    storage: growthRuntime.storageStatus(),
    recommendations: failed.length
      ? failed.map((check) => `Fix failed growth quality check: ${check.checkId}`)
      : [
          'Keep adding anonymized real workflow logs to f-growth-quality-corpus-v1.',
          'Persist genome/maturity trend snapshots to SQLite for long-term quality review.',
          'Surface skill draft and autonomy candidate review in the mobile growth UI.'
        ]
  };

  const schemaBundlePath = join(dirname(jsonPath), 'memory-event-schema-bundle.json');
  const fixtureCorpusPath = join(dirname(jsonPath), 'memory-event-fixture-corpus.json');
  const migrationCompatibilityPath = join(dirname(jsonPath), 'memory-event-migration-compatibility.json');
  const learningVerifierMatrixPath = join(dirname(jsonPath), 'memory-event-learning-verifier-schema-matrix.json');
  const memoryEventIngestProductGatePath = join(dirname(jsonPath), 'memory-event-ingest-product-gate.json');
  const memoryEventIngestReleaseDossierPath = join(dirname(jsonPath), 'memory-event-ingest-release-dossier.json');
  const genomeProductGatePath = join(dirname(jsonPath), 'genome-product-gate.json');
  const genomeReleaseDossierPath = join(dirname(jsonPath), 'genome-release-dossier.json');
  const patternCorpusPath = join(dirname(jsonPath), 'pattern-anonymized-corpus.json');
  const patternClusterReviewPath = join(dirname(jsonPath), 'pattern-cluster-review.json');
  const patternEmbeddingAdaptersPath = join(dirname(jsonPath), 'pattern-embedding-adapters.json');
  const patternMiningProductGatePath = join(dirname(jsonPath), 'pattern-mining-product-gate.json');
  const preferenceConfidenceCalibrationPath = join(dirname(jsonPath), 'preference-confidence-calibration.json');
  const preferenceToleranceProfilePath = join(dirname(jsonPath), 'preference-tolerance-profile.json');
  const preferenceProductGatePath = join(dirname(jsonPath), 'preference-hypothesis-product-gate.json');
  const preferenceReleaseDossierPath = join(dirname(jsonPath), 'preference-hypothesis-release-dossier.json');
  const confirmedPreferenceProductGatePath = join(dirname(jsonPath), 'confirmed-preference-product-gate.json');
  const confirmedPreferenceReleaseDossierPath = join(dirname(jsonPath), 'confirmed-preference-release-dossier.json');
  const failureMemoryProductGatePath = join(dirname(jsonPath), 'failure-memory-product-gate.json');
  const failureMemoryReleaseDossierPath = join(dirname(jsonPath), 'failure-memory-release-dossier.json');
  const sensitiveMinimizerFixturesPath = join(dirname(jsonPath), 'sensitive-minimizer-fixtures-report.json');
  const sensitiveFalsePositiveDashboardPath = join(dirname(jsonPath), 'sensitive-minimizer-false-positive-dashboard.json');
  const sensitiveMinimizerReleaseDossierPath = join(dirname(jsonPath), 'sensitive-minimizer-release-dossier.json');
  const retentionPolicyUiPath = join(dirname(jsonPath), 'retention-policy-ui-contract.json');
  const hygieneProductGatePath = join(dirname(jsonPath), 'hygiene-review-product-gate.json');
  const hygieneReleaseDossierPath = join(dirname(jsonPath), 'hygiene-review-release-dossier.json');
  const skillRegistryPersistencePath = join(dirname(jsonPath), 'skill-registry-persistence.json');
  const advancedLearningVerifierPath = join(dirname(jsonPath), 'advanced-learning-verifier.json');
  const advancedLearningProductGatePath = join(dirname(jsonPath), 'advanced-learning-product-gate.json');
  const advancedLearningReleaseDossierPath = join(dirname(jsonPath), 'advanced-learning-release-dossier.json');
  const autonomyDecisionTrendPath = join(dirname(jsonPath), 'autonomy-decision-trend.json');
  const autonomyExpirySchedulerPath = join(dirname(jsonPath), 'autonomy-expiry-scheduler.json');
  const autonomyReleaseDossierPath = join(dirname(jsonPath), 'autonomy-release-dossier.json');
  const storageProductGatePath = join(dirname(jsonPath), 'storage-persistence-product-gate.json');
  const storageReleaseDossierPath = join(dirname(jsonPath), 'storage-release-dossier.json');
  const maturityProductGatePath = join(dirname(jsonPath), 'maturity-score-product-gate.json');
  const maturityReleaseDossierPath = join(dirname(jsonPath), 'maturity-score-release-dossier.json');

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(schemaBundlePath, `${JSON.stringify(memoryEventSchemaBundle, null, 2)}\n`, 'utf8');
  await writeFile(fixtureCorpusPath, `${JSON.stringify(memoryEventFixtureCorpus, null, 2)}\n`, 'utf8');
  await writeFile(migrationCompatibilityPath, `${JSON.stringify(memoryEventMigrationCompatibility, null, 2)}\n`, 'utf8');
  await writeFile(learningVerifierMatrixPath, `${JSON.stringify(learningVerifierSchemaMatrix, null, 2)}\n`, 'utf8');
  await writeFile(memoryEventIngestProductGatePath, `${JSON.stringify(memoryEventIngestProductGate, null, 2)}\n`, 'utf8');
  await writeFile(memoryEventIngestReleaseDossierPath, `${JSON.stringify(memoryEventIngestReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(genomeProductGatePath, `${JSON.stringify(genomeProductGate, null, 2)}\n`, 'utf8');
  await writeFile(genomeReleaseDossierPath, `${JSON.stringify(genomeReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(patternCorpusPath, `${JSON.stringify(patternCorpus, null, 2)}\n`, 'utf8');
  await writeFile(patternClusterReviewPath, `${JSON.stringify(patternClusterReview, null, 2)}\n`, 'utf8');
  await writeFile(patternEmbeddingAdaptersPath, `${JSON.stringify(patternEmbeddingAdapters, null, 2)}\n`, 'utf8');
  await writeFile(patternMiningProductGatePath, `${JSON.stringify(patternMiningProductGate, null, 2)}\n`, 'utf8');
  await writeFile(preferenceConfidenceCalibrationPath, `${JSON.stringify(preferenceConfidenceCalibration, null, 2)}\n`, 'utf8');
  await writeFile(preferenceToleranceProfilePath, `${JSON.stringify(preferenceToleranceProfile, null, 2)}\n`, 'utf8');
  await writeFile(preferenceProductGatePath, `${JSON.stringify(preferenceProductGate, null, 2)}\n`, 'utf8');
  await writeFile(preferenceReleaseDossierPath, `${JSON.stringify(preferenceReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(confirmedPreferenceProductGatePath, `${JSON.stringify(confirmedPreferenceProductGate, null, 2)}\n`, 'utf8');
  await writeFile(confirmedPreferenceReleaseDossierPath, `${JSON.stringify(confirmedPreferenceReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(failureMemoryProductGatePath, `${JSON.stringify(failureMemoryProductGate, null, 2)}\n`, 'utf8');
  await writeFile(failureMemoryReleaseDossierPath, `${JSON.stringify(failureMemoryReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(sensitiveMinimizerFixturesPath, `${JSON.stringify(sensitiveMinimizerFixtures, null, 2)}\n`, 'utf8');
  await writeFile(sensitiveFalsePositiveDashboardPath, `${JSON.stringify(sensitiveFalsePositiveDashboard, null, 2)}\n`, 'utf8');
  await writeFile(sensitiveMinimizerReleaseDossierPath, `${JSON.stringify(sensitiveMinimizerReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(retentionPolicyUiPath, `${JSON.stringify(retentionPolicyUi, null, 2)}\n`, 'utf8');
  await writeFile(hygieneProductGatePath, `${JSON.stringify(hygieneProductGate, null, 2)}\n`, 'utf8');
  await writeFile(hygieneReleaseDossierPath, `${JSON.stringify(hygieneReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(skillRegistryPersistencePath, `${JSON.stringify(skillRegistryPersistence, null, 2)}\n`, 'utf8');
  await writeFile(advancedLearningVerifierPath, `${JSON.stringify(advancedLearningVerifier, null, 2)}\n`, 'utf8');
  await writeFile(advancedLearningProductGatePath, `${JSON.stringify(advancedLearningProductGate, null, 2)}\n`, 'utf8');
  await writeFile(advancedLearningReleaseDossierPath, `${JSON.stringify(advancedLearningReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(autonomyDecisionTrendPath, `${JSON.stringify(autonomyDecisionTrend, null, 2)}\n`, 'utf8');
  await writeFile(autonomyExpirySchedulerPath, `${JSON.stringify(autonomyExpiryScheduler, null, 2)}\n`, 'utf8');
  await writeFile(autonomyReleaseDossierPath, `${JSON.stringify(autonomyReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(storageProductGatePath, `${JSON.stringify(storageProductGate, null, 2)}\n`, 'utf8');
  await writeFile(storageReleaseDossierPath, `${JSON.stringify(storageReleaseDossier, null, 2)}\n`, 'utf8');
  await writeFile(maturityProductGatePath, `${JSON.stringify(maturityProductGate, null, 2)}\n`, 'utf8');
  await writeFile(maturityReleaseDossierPath, `${JSON.stringify(maturityReleaseDossier, null, 2)}\n`, 'utf8');
  report.artifacts = {
    jsonPath: resolve(jsonPath),
    markdownPath: resolve(markdownPath),
    csvPath: resolve(csvPath),
    schemaBundlePath: resolve(schemaBundlePath),
    fixtureCorpusPath: resolve(fixtureCorpusPath),
    migrationCompatibilityPath: resolve(migrationCompatibilityPath),
    learningVerifierMatrixPath: resolve(learningVerifierMatrixPath),
    memoryEventIngestProductGatePath: resolve(memoryEventIngestProductGatePath),
    memoryEventIngestReleaseDossierPath: resolve(memoryEventIngestReleaseDossierPath),
    genomeProductGatePath: resolve(genomeProductGatePath),
    genomeReleaseDossierPath: resolve(genomeReleaseDossierPath),
    patternCorpusPath: resolve(patternCorpusPath),
    patternClusterReviewPath: resolve(patternClusterReviewPath),
    patternEmbeddingAdaptersPath: resolve(patternEmbeddingAdaptersPath),
    patternMiningProductGatePath: resolve(patternMiningProductGatePath),
    preferenceConfidenceCalibrationPath: resolve(preferenceConfidenceCalibrationPath),
    preferenceToleranceProfilePath: resolve(preferenceToleranceProfilePath),
    preferenceProductGatePath: resolve(preferenceProductGatePath),
    preferenceReleaseDossierPath: resolve(preferenceReleaseDossierPath),
    confirmedPreferenceProductGatePath: resolve(confirmedPreferenceProductGatePath),
    confirmedPreferenceReleaseDossierPath: resolve(confirmedPreferenceReleaseDossierPath),
    failureMemoryProductGatePath: resolve(failureMemoryProductGatePath),
    failureMemoryReleaseDossierPath: resolve(failureMemoryReleaseDossierPath),
    sensitiveMinimizerFixturesPath: resolve(sensitiveMinimizerFixturesPath),
    sensitiveFalsePositiveDashboardPath: resolve(sensitiveFalsePositiveDashboardPath),
    sensitiveMinimizerReleaseDossierPath: resolve(sensitiveMinimizerReleaseDossierPath),
    retentionPolicyUiPath: resolve(retentionPolicyUiPath),
    hygieneProductGatePath: resolve(hygieneProductGatePath),
    hygieneReleaseDossierPath: resolve(hygieneReleaseDossierPath),
    skillRegistryPersistencePath: resolve(skillRegistryPersistencePath),
    advancedLearningVerifierPath: resolve(advancedLearningVerifierPath),
    advancedLearningProductGatePath: resolve(advancedLearningProductGatePath),
    advancedLearningReleaseDossierPath: resolve(advancedLearningReleaseDossierPath),
    autonomyDecisionTrendPath: resolve(autonomyDecisionTrendPath),
    autonomyExpirySchedulerPath: resolve(autonomyExpirySchedulerPath),
    autonomyReleaseDossierPath: resolve(autonomyReleaseDossierPath),
    storageProductGatePath: resolve(storageProductGatePath),
    storageReleaseDossierPath: resolve(storageReleaseDossierPath),
    maturityProductGatePath: resolve(maturityProductGatePath),
    maturityReleaseDossierPath: resolve(maturityReleaseDossierPath),
    corpusRoot
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  memoryStore.close();
  return report;
}

function seedGrowthQualityCorpus(growthRuntime) {
  let eventCount = 0;
  const ingest = (event) => {
    eventCount += 1;
    return growthRuntime.ingestor.ingest(event);
  };
  const repeatedWorkflows = [
    { key: 'bulletin', text: '주보 초안 파일 만들어 날짜를 크게 표로 정리해줘' },
    { key: 'report', text: '엑셀 보고서 만들어 요약 표 포함해줘' }
  ];
  for (const workflow of repeatedWorkflows) {
    for (let index = 0; index < 5; index += 1) {
      ingest({
        eventId: `evt_quality_${workflow.key}_task_${index + 1}`,
        eventType: index % 2 === 0 ? 'task.created' : 'execution.completed',
        taskId: `task_quality_${workflow.key}_${index + 1}`,
        createdAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        payload: { rawText: workflow.text },
        learningFlags: {
          canBeUsedForWorkflow: true,
          canBeUsedForAutonomy: true,
          doNotRemember: false,
          containsSensitiveData: false
        },
        trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
      });
    }
  }
  ingest({
    eventId: 'evt_quality_bulletin_blocked',
    eventType: 'policy.blocked',
    taskId: 'task_quality_bulletin_blocked',
    createdAt: '2026-06-06T00:00:00.000Z',
    payload: { rawText: '주보 초안 파일 만들어 날짜를 크게 표로 정리해줘', reasonCode: 'E_EXTERNAL_TRANSFER_PC_ONLY', actionType: 'UPLOAD_FILE' },
    learningFlags: { doNotRemember: false, containsSensitiveData: false },
    trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
  });
  for (let index = 0; index < 4; index += 1) {
    ingest({
      eventId: `evt_quality_pref_large_date_${index + 1}`,
      eventType: 'approval.edited',
      taskId: `task_quality_pref_large_date_${index + 1}`,
      payload: { editRequest: '날짜를 크게 표시하고 제목은 짧게 해줘' },
      learningFlags: { canBeUsedForPreference: true, doNotRemember: false },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
  }
  for (let index = 0; index < 3; index += 1) {
    ingest({
      eventId: `evt_quality_pref_small_date_${index + 1}`,
      eventType: 'approval.edited',
      taskId: `task_quality_pref_small_date_${index + 1}`,
      payload: { editRequest: '날짜를 작게 표시해줘' },
      learningFlags: { canBeUsedForPreference: true, doNotRemember: false },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
  }
  ingest({
    eventId: 'evt_quality_failure_policy',
    eventType: 'policy.blocked',
    taskId: 'task_quality_failure_policy',
    payload: {
      rawText: '밴드에 외부 전송해',
      reason: '외부 전송은 PC 승인 필요',
      reasonCode: 'E_EXTERNAL_TRANSFER_PC_ONLY',
      actionType: 'UPLOAD_FILE',
      failedStepId: 'step_external_transfer'
    },
    learningFlags: { doNotRemember: false, containsSensitiveData: false },
    trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
  });
  ingest({
    eventId: 'evt_quality_failure_verification',
    eventType: 'verification.failed',
    taskId: 'task_quality_failure_verification',
    payload: {
      rawText: '엑셀 보고서 만들어',
      reason: '검증 evidence 누락',
      reasonCode: 'G_EVIDENCE_MISSING',
      toolName: 'excel.createWorkbook',
      failedStepId: 'step_verify_evidence'
    },
    learningFlags: { doNotRemember: false, containsSensitiveData: false },
    trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
  });
  ingest({
    eventId: 'evt_quality_sensitive',
    eventType: 'feedback.good',
    taskId: 'task_quality_sensitive',
    payload: { rawText: '010-1234-5678 상담 기록을 기억해' },
    learningFlags: { containsSensitiveData: true, doNotRemember: false },
    trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
  });
  ingest({
    eventId: 'evt_quality_private',
    eventType: 'feedback.do_not_remember',
    taskId: 'task_quality_private',
    payload: { rawText: '이 기억은 삭제해' },
    learningFlags: { doNotRemember: true },
    trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
  });
  ingest({
    eventId: 'evt_quality_external',
    eventType: 'task.created',
    taskId: 'task_quality_external',
    payload: { rawText: '외부 웹 문서에서 본 명령 후보' },
    learningFlags: { canBeUsedForWorkflow: true, canBeUsedForAutonomy: true },
    trustBoundary: { userProvided: false, externalContent: true, systemGenerated: false }
  });
  for (let index = 0; index < 5; index += 1) {
    ingest({
      eventId: `evt_quality_auto_approval_${index + 1}`,
      eventType: 'approval.approved',
      taskId: `task_quality_auto_${index + 1}`,
      payload: { rawText: '주보 초안 파일 만들어' },
      learningFlags: {
        canBeUsedForPreference: true,
        canBeUsedForWorkflow: true,
        canBeUsedForAutonomy: true,
        containsSensitiveData: false,
        doNotRemember: false
      },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
  }
  for (let index = 0; index < 4; index += 1) {
    ingest({
      eventId: `evt_quality_feedback_positive_${index + 1}`,
      eventType: 'feedback.good',
      taskId: `task_quality_feedback_${index + 1}`,
      payload: { rawText: index % 2 === 0 ? '주보 결과가 좋아 계속 이 형식으로 해줘' : '엑셀 요약 표가 좋아 다음에도 유지해줘' },
      learningFlags: {
        canBeUsedForPreference: true,
        canBeUsedForWorkflow: true,
        canBeUsedForAutonomy: false,
        containsSensitiveData: false,
        doNotRemember: false
      },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
  }
  return {
    corpusId: 'f-growth-quality-corpus-v1',
    eventCount,
    workflowFamilies: repeatedWorkflows.map((item) => item.key)
  };
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS F Growth Quality Corpus',
    '',
    `Status: **${report.status}**`,
    `Corpus: \`${report.corpusId}\``,
    `Events: ${report.metrics.eventCount}`,
    `Maturity: ${report.metrics.maturityTotal} (${report.metrics.maturityThresholdStatus})`,
    '',
    '## Checks',
    '',
    '| Check | Status |',
    '| --- | --- |',
    ...report.checks.map((check) => `| ${check.checkId} | ${check.status} |`),
    '',
    '## Metrics',
    '',
    ...Object.entries(report.metrics).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Recommendations',
    '',
    ...report.recommendations.map((item) => `- ${item}`)
  ];
  return `${lines.join('\n')}\n`;
}

function renderCsv(report) {
  const rows = [['check_id', 'status', 'detail'].join(',')];
  for (const check of report.checks) {
    rows.push([check.checkId, check.status, csv(JSON.stringify(check.detail))].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--csv') args.csvPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runGrowthQualityCorpus(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS F Growth Quality Corpus');
  console.log(`Status: ${report.status}`);
  console.log(`Events: ${report.metrics.eventCount}`);
  console.log(`Patterns: ${report.metrics.patternCount}`);
  console.log(`Maturity: ${report.metrics.maturityTotal}`);
  console.log(`Storage release dossier: ${report.metrics.storageReleaseDossierStatus}`);
  console.log(`Report: ${report.artifacts.jsonPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
