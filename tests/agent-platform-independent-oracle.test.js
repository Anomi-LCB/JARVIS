import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluateG01PublicSourceEvidence, evaluateG02ArtifactConflictEvidence, evaluateG02CrossProcessConflictEvidence, evaluateS10CapabilityCatalogEvidence, evaluateM10EgressEvidence, evaluateG06SkillRollbackEvidence, evaluateM03MemoryRetractionEvidence, evaluateM04PreferenceRevisionEvidence, evaluateM05ProactivityEvidence, evaluateG10InjectionEvidence, evaluateG11ArticleMetadataEvidence, evaluateG12HandoffEvidence, evaluateM02RecoveryEvidence, evaluateM08BrowserHandoffEvidence, evaluateS04TravelQuoteEvidence } from '../scripts/agent-platform-independent-oracle.mjs';

test('independent S04 oracle recomputes synthetic totals and refuses booking claims', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'S04', fixtureId: 'travel-quote-price-change-v1',
    query: { origin: '서울', destination: '부산', departureDate: '2026-10-12', passengers: 1, bags: 1 },
    initialOffers: [
      { offerId: 'flight-a', priceVersion: 1, departureLocal: '2026-10-12T09:00+09:00', arrivalLocal: '2026-10-12T10:05+09:00',
        conditions: { refund: '출발 24시간 전까지 20,000원 수수료 후 환불', change: '출발 전 15,000원 수수료와 운임 차액' },
        fees: [122000, 8000, 16000, 4000].map(amountMinor => ({ amountMinor })) },
      { offerId: 'flight-b', priceVersion: 1, departureLocal: '2026-10-12T08:40+09:00', arrivalLocal: '2026-10-12T09:55+09:00',
        conditions: { refund: '환불 불가', change: '변경 불가' }, fees: [105000, 10000, 12000, 5000, 3000].map(amountMinor => ({ amountMinor })) }
    ],
    refreshedOffers: [
      { offerId: 'flight-a', priceVersion: 1, departureLocal: '2026-10-12T09:00+09:00', arrivalLocal: '2026-10-12T10:05+09:00',
        conditions: { refund: '출발 24시간 전까지 20,000원 수수료 후 환불', change: '출발 전 15,000원 수수료와 운임 차액' },
        fees: [122000, 8000, 16000, 4000].map(amountMinor => ({ amountMinor })) },
      { offerId: 'flight-b', priceVersion: 2, departureLocal: '2026-10-12T08:40+09:00', arrivalLocal: '2026-10-12T09:55+09:00',
        conditions: { refund: '환불 불가', change: '변경 불가' }, fees: [130000, 10000, 12000, 5000, 3000].map(amountMinor => ({ amountMinor })) }
    ],
    initialSorted: [{ offerId: 'flight-b', totalMinor: 135000 }, { offerId: 'flight-a', totalMinor: 150000 }],
    refreshedSorted: [{ offerId: 'flight-a', totalMinor: 150000 }, { offerId: 'flight-b', totalMinor: 160000 }],
    priceChanged: true, bookingAvailable: false, bookingClaimed: false,
    capabilities: ['quote.read', 'quote.refresh'], networkRequests: 0, externalWrites: 0 };
  assert.equal(evaluateS04TravelQuoteEvidence(evidence).status, 'passed');
  evidence.refreshedOffers[1].fees[0].amountMinor = 10000;
  assert.equal(evaluateS04TravelQuoteEvidence(evidence).checks
    .find(item => item.id === 'refreshed_ranking_uses_complete_totals')?.status, 'failed');
  evidence.refreshedOffers[1].fees[0].amountMinor = 130000;
  evidence.bookingAvailable = true;
  assert.equal(evaluateS04TravelQuoteEvidence(evidence).checks
    .find(item => item.id === 'sandbox_never_exposes_booking_or_external_effect')?.status, 'failed');
});

test('independent M08 oracle requires paused input, confirmed scoped resume, and rotated ticket', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'M08', fixtureId: 'm08-human-handoff-generation-origin-recheck-v1',
    delayedClickBlocked: true, clicksDuringHumanHandoff: 0, outOfScopeOriginRejected: true,
    invalidConfirmationRejectedBeforeOwnerCheck: true, ownerConfirmationChecks: 2, scopeReauthorizationChecks: 1,
    userConfirmationWasRequired: true, generationRotated: true, oldTicketRejected: true,
    resumedOrigin: 'https://app.example.test', onlyPostResumeAllowedClickRan: true,
    agentCredentialEntryAllowed: false, auditContainsCallbackSecret: false, auditContainsConfirmationToken: false,
    auditHash: 'a'.repeat(64), providerCalls: 0, networkRequests: 0, externalWrites: 0 };
  assert.equal(evaluateM08BrowserHandoffEvidence(evidence).status, 'passed');
  evidence.clicksDuringHumanHandoff = 1;
  assert.equal(evaluateM08BrowserHandoffEvidence(evidence).checks
    .find(item => item.id === 'delayed_input_is_fenced_when_handoff_begins')?.status, 'failed');
});

test('independent M05 oracle checks due reminder, blocker transitions, silence, and privacy', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'M05', fixtureId: 'm05-local-deadline-and-blocker-transitions-v1',
    expected: { commitmentId: 'commitment-1', dueAt: '2026-09-29T12:00:00.000Z', horizonEnd: '2026-09-30T00:00:00.000Z' },
    samples: [1, 0, 1, 0, 1, 1].map((eventsDelivered, index) => ({ tick: index + 1, eventsDelivered })),
    events: [
      { eventId: 'due-1', kind: 'commitment-due-soon', commitmentId: 'commitment-1', dueAt: '2026-09-29T12:00:00.000Z' },
      { eventId: 'blocked-1', kind: 'mission-blocked', status: 'PAUSED', blockerCode: 'action-recovery-required' },
      { eventId: 'changed-1', kind: 'mission-blocker-changed', status: 'PAUSED', blockerCode: 'capability-unavailable' },
      { eventId: 'cleared-1', kind: 'mission-blocker-cleared', status: 'COMPLETED' }
    ], metrics: { externalWrites: 0, networkRequests: 0, providerCalls: 0, executionAuthority: false } };
  assert.equal(evaluateM05ProactivityEvidence(evidence).status, 'passed');
  evidence.events.push(structuredClone(evidence.events[1]));
  assert.equal(evaluateM05ProactivityEvidence(evidence).checks
    .find(item => item.id === 'event_identities_are_unique_and_personal_content_is_not_projected')?.status, 'failed');
  evidence.events.pop(); evidence.samples[3].eventsDelivered = 1;
  assert.equal(evaluateM05ProactivityEvidence(evidence).checks
    .find(item => item.id === 'unchanged_due_and_blocker_states_are_silent')?.status, 'failed');
});

const g01FixtureSource = JSON.parse(await (await import('node:fs/promises')).readFile(
  new URL('./fixtures/agent-platform-g01-public-sources.json', import.meta.url), 'utf8'));

function fixture() {
  const bytes = Buffer.from('복구 검증', 'utf8');
  const action = { actionId: 'action-1', status: 'succeeded', taskId: 'task-1', observationId: 'observation-1',
    recoverySource: 'pc-task-receipt' };
  const observation = { observationId: 'observation-1', actionId: 'action-1', outcome: 'success',
    verification: { status: 'passed', verificationId: 'verification-1' }, evidenceId: 'evidence-1' };
  const durableMission = { missionId: 'mission-1', status: 'COMPLETED',
    action: structuredClone(action), observation: structuredClone(observation) };
  return {
    schemaVersion: 1,
    scenarioId: 'M02',
    expected: { missionStatus: 'COMPLETED', completionStatus: 'verified', outputRelativePath: 'first.txt', outputText: '복구 검증' },
    processBoundary: { separateProductProcesses: true, firstProductProcessPid: 101, secondProductProcessPid: 202,
      firstProcessStatus: 'PAUSED', secondProcessStatus: 'COMPLETED', processRestartBetweenPhases: true },
    result: { missionId: 'mission-1', status: 'COMPLETED', completionStatus: 'verified',
      metrics: { executedActions: 1, executedActionsBeforeRecovery: 1, recoveredActions: 1 }, executionCount: 0,
      action: structuredClone(action), observation: structuredClone(observation) },
    durableMission,
    workspaceFiles: ['first.txt'],
    artifact: { relativePath: 'first.txt', byteLength: bytes.length, base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') }
  };
}

function g06Fixture() {
  const initialRevisionId = 'skill_revision_v1_baseline';
  const failedRevisionId = 'skill_revision_v2_regression';
  const activeSteps = ['원자료의 두 수치를 읽는다.', '합계를 계산하고 원자료와 대조한다.'];
  return { schemaVersion: 1, scenarioId: 'G06', fixtureId: 'g06-skill-rollback-synthetic-v1',
    registry: { initialRevisionId, beforeRevisionId: initialRevisionId, failedRevisionId, afterRevisionId: failedRevisionId,
      activeRevisionId: initialRevisionId, activeSteps, policy: { executableByDefault: false, requiresUserReview: true, requiresPolicyCheck: true },
      revisions: [{ revisionId: initialRevisionId, parentRevisionId: null, status: 'active' },
        { revisionId: failedRevisionId, parentRevisionId: initialRevisionId, status: 'superseded' }],
      rollbackEvent: { type: 'revision_rolled_back', fromRevisionId: failedRevisionId, toRevisionId: initialRevisionId } },
    failedArtifact: { status: 'quarantined', verified: false, completionClaimed: false,
      expectedValue: 'correct-total: 18', observedValue: 'wrong-total: 17' } };
}

test('independent G06 oracle accepts rollback, lineage, and quarantined regression evidence', () => {
  const result = evaluateG06SkillRollbackEvidence(g06Fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 5);
});

test('independent G06 oracle rejects a false success claim for the regressed artifact', () => {
  const evidence = g06Fixture();
  evidence.failedArtifact.completionClaimed = true;
  assert.equal(evaluateG06SkillRollbackEvidence(evidence).status, 'failed');
});

function m04Fixture() {
  const originalStatement = '회의 자료는 문장형으로 정리해줘';
  const updatedStatement = '회의 자료를 표로 정리해줘';
  return { schemaVersion: 1, scenarioId: 'M04', fixtureId: 'm04-preference-revision-synthetic-v1',
    expected: { originalStatement, updatedStatement }, revisions: { before: 1, after: 2 },
    activePreference: { preferenceId: 'synthetic-pref', status: 'confirmed', revision: 2, statement: updatedStatement },
    recalledHints: [updatedStatement], unrelatedHints: [], otherConversationHints: [],
    history: [{ action: 'confirm', by: 'synthetic-owner', reason: 'initial preference' },
      { action: 'update', by: 'synthetic-owner', reason: 'current preference correction', patch: { statement: updatedStatement } }],
    authority: { executionAuthority: false }, metrics: { externalWrites: 0, providerCalls: 0, networkRequests: 0 } };
}

test('independent M04 oracle accepts persisted scoped preference correction', () => {
  const result = evaluateM04PreferenceRevisionEvidence(m04Fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 6);
});

test('independent M04 oracle rejects old preference recall after correction', () => {
  const evidence = m04Fixture();
  evidence.recalledHints.push(evidence.expected.originalStatement);
  assert.equal(evaluateM04PreferenceRevisionEvidence(evidence).status, 'failed');
});

function m03Fixture() {
  return { schemaVersion: 1, scenarioId: 'M03', fixtureId: 'm03-memory-retraction-synthetic-v1',
    expected: { deletedPreferenceId: 'synthetic-pref', decisionReason: '연락처는 사적인 정보라 공유 자료에서 제외', query: '연락처' },
    beforeDeleteHintIds: ['synthetic-pref'], afterDeleteHintIds: [], afterReopenHintIds: [],
    derivedMemory: { status: 'source_review_required', reasonPreserved: true, sourceRetractionRecorded: true, doNotRemember: true },
    unrelatedHintIds: [], metrics: { externalWrites: 0, providerCalls: 0, networkRequests: 0,
      executionAuthority: false, physicalDeletion: false, rawSourceErasure: false } };
}

test('independent M03 oracle accepts retraction from recall after restart without claiming erasure', () => {
  const result = evaluateM03MemoryRetractionEvidence(m03Fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 7);
});

test('independent M03 oracle rejects a retracted personal hint reappearing after restart', () => {
  const evidence = m03Fixture();
  evidence.afterReopenHintIds = [evidence.expected.deletedPreferenceId];
  assert.equal(evaluateM03MemoryRetractionEvidence(evidence).status, 'failed');
});

test('independent M02 oracle passes only exact durable recovery, G binding, and output bytes', () => {
  const result = evaluateM02RecoveryEvidence(fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 10);
  assert.ok(result.checks.every(item => item.status === 'passed'));
  assert.equal(result.oracleIndependence,
    'separate-process-separate-predicate-implementation; same project, not independent human authoring');
});

for (const [label, mutate, failedCheck] of [
  ['same process ID across restart boundary', evidence => { evidence.processBoundary.secondProductProcessPid = evidence.processBoundary.firstProductProcessPid; }, 'process_restart_is_separate'],
  ['re-executed action', evidence => { evidence.result.executionCount = 1; }, 'recovered_without_reexecuting'],
  ['incorrect G evidence binding', evidence => { evidence.durableMission.observation.verification.status = 'failed'; }, 'durable_record_matches_verified_result'],
  ['wrong output bytes', evidence => { evidence.artifact.base64 = Buffer.from('다른 결과').toString('base64'); }, 'artifact_bytes_match_expected'],
  ['tampered content hash', evidence => { evidence.artifact.sha256 = '0'.repeat(64); }, 'artifact_sha256_is_recomputable'],
  ['additional output file', evidence => { evidence.workspaceFiles.push('second.txt'); }, 'artifact_path_and_cardinality'],
  ['action identity mismatch', evidence => { evidence.durableMission.action.actionId = 'other-action'; }, 'durable_record_matches_verified_result'],
  ['missing verification id', evidence => { evidence.result.observation.verification.verificationId = null; }, 'observation_is_G_verified_and_action_bound']
]) {
  test(`independent M02 oracle rejects ${label}`, () => {
    const evidence = fixture();
    mutate(evidence);
    const result = evaluateM02RecoveryEvidence(evidence);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find(item => item.id === failedCheck)?.status, 'failed');
  });
}

function g02Fixture() {
  const baseline = 'baseline';
  const proposals = ['writer A', 'writer B'];
  const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const currentSha256 = digest(proposals[0]);
  return { schemaVersion: 1, scenarioId: 'G02',
    baseline: { content: baseline, sha256: digest(baseline) },
    attempts: [
      { writerId: 'g02-writer-1', baseSha256: digest(baseline), proposedContent: proposals[0],
        proposedSha256: digest(proposals[0]), status: 'success', changedItems: [{ type: 'overwrite_file' }] },
      { writerId: 'g02-writer-2', baseSha256: digest(baseline), proposedContent: proposals[1],
        proposedSha256: digest(proposals[1]), status: 'blocked', changedItems: [], evidence: {
          conflictDetected: true, contentPreserved: true, expectedSha256: digest(baseline),
          currentSha256, proposedSha256: digest(proposals[1])
        } }
    ],
    final: { relativePath: 'report.md', content: proposals[0], byteLength: Buffer.byteLength(proposals[0]), sha256: currentSha256 },
    undoRecords: [{ taskId: 'g02-writer-1', action: 'restore_previous_file', path: 'report.md' }]
  };
}

test('independent G02 oracle accepts one CAS winner with a hash-bound, preserved conflict', () => {
  const result = evaluateG02ArtifactConflictEvidence(g02Fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 7);
  assert.ok(result.checks.every(item => item.status === 'passed'));
});

for (const [label, mutate, failedCheck] of [
  ['silent overwrite of the losing proposal', evidence => { evidence.final.content = evidence.attempts[1].proposedContent; }, 'final_bytes_are_exactly_the_winning_revision'],
  ['missing conflict marker', evidence => { evidence.attempts[1].evidence.conflictDetected = false; }, 'conflict_evidence_binds_expected_current_and_proposed_hashes'],
  ['mutated losing revision', evidence => { evidence.attempts[1].proposedContent = 'different'; }, 'same_baseline_revision_and_distinct_proposals'],
  ['a mutation receipt for the loser', evidence => { evidence.attempts[1].changedItems = [{ type: 'overwrite_file' }]; }, 'losing_write_has_no_mutation_receipt'],
  ['multiple winners', evidence => { evidence.attempts[1].status = 'success'; }, 'one_writer_wins_and_one_conflict_is_blocked'],
  ['a second undo receipt', evidence => { evidence.undoRecords.push({ ...evidence.undoRecords[0] }); }, 'exactly_one_undo_record_tracks_the_published_writer']
]) {
  test(`independent G02 oracle rejects ${label}`, () => {
    const evidence = g02Fixture();
    mutate(evidence);
    const result = evaluateG02ArtifactConflictEvidence(evidence);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find(item => item.id === failedCheck)?.status, 'failed');
  });
}

function g01Fixture() {
  const report = ['# W3C WCAG 2.2 공개 자료 요약', ...g01FixtureSource.sources.flatMap(source => [
    `## ${source.title}`, `요약 주장: ${source.claim}`, `근거 원문: ${source.quote}`, `출처 URL: ${source.url}`
  ])].join('\n');
  const observations = ['researcher', 'researcher', 'editor', 'verifier'].map((role, index) => ({
    actionId: `action-${index + 1}`, observationId: `observation-${index + 1}`, toolName: index === 2
      ? 'filesystem.createTextFile' : 'filesystem.readText', outcome: 'success',
    verification: { status: 'passed', verificationId: `verification-${index + 1}` }, evidenceId: `evidence-${index + 1}`
  }));
  const actions = [
    ['researcher', 'filesystem.readText', 'sources/source-1.json'],
    ['researcher', 'filesystem.readText', 'sources/source-2.json'],
    ['editor', 'filesystem.createTextFile', 'report.md'],
    ['verifier', 'filesystem.readText', 'report.md']
  ].map(([workerRole, actualToolName, relativePath], index) => ({
    actionId: `action-${index + 1}`, observationId: `observation-${index + 1}`, status: 'succeeded',
    workerRole, actualToolName, relativePath, collaborationGroupId: 'g01-public-source-report',
    roleScope: { allowed: true, roleId: workerRole }
  }));
  const sources = g01FixtureSource.sources.map((source, index) => {
    const bytes = Buffer.from(JSON.stringify(source, null, 2), 'utf8');
    return { relativePath: `sources/source-${index + 1}.json`, byteLength: bytes.length,
      base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const artifactBytes = Buffer.from(report, 'utf8');
  return {
    schemaVersion: 1, scenarioId: 'G01', fixture: g01FixtureSource,
    result: { missionId: 'mission-g01', status: 'COMPLETED', actions, observations },
    durableMission: { missionId: 'mission-g01', status: 'COMPLETED',
      actionIds: actions.map(item => item.actionId), observationIds: actions.map(item => item.observationId) },
    deniedAttempt: { missionId: 'mission-denied', status: 'PAUSED',
      stopReason: 'mission-role-scope-editor-requires-local-artifact-write', actions: [],
      observations: [{ actionId: null, outcome: 'failed', error: { code: 'A_MISSION_WAVE_INTEGRITY_REJECTED',
        reason: 'mission-role-scope-editor-requires-local-artifact-write' }, verification: null }] },
    durableDeniedMission: { missionId: 'mission-denied', status: 'PAUSED',
      stopReason: 'mission-role-scope-editor-requires-local-artifact-write' },
    sources, workspaceFiles: ['report.md', 'researcher-private-notes.txt', 'sources'],
    artifact: { relativePath: 'report.md', byteLength: artifactBytes.length,
      base64: artifactBytes.toString('base64'), sha256: createHash('sha256').update(artifactBytes).digest('hex') }
  };
}

test('independent G01 oracle checks frozen sources, role-scoped actions, denied access, and exact report', () => {
  const evidence = g01Fixture();
  evidence.durableMission.observationIds.reverse(); // Store enumeration is ID-sorted, not action-ordered.
  const result = evaluateG01PublicSourceEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 10);
  assert.ok(result.checks.every(item => item.status === 'passed'));
  assert.equal(result.sourceEvidenceType, 'offline-fixed-snapshot-not-live-fetch');
});

for (const [label, mutate, failedCheck] of [
  ['tampered source bytes', evidence => { evidence.sources[0].base64 = Buffer.from('{}').toString('base64'); }, 'source_snapshots_hash_and_content'],
  ['role access violation', evidence => { evidence.result.actions[2].roleScope.allowed = false; }, 'role_handoff_order_tools_and_paths'],
  ['unverified role observation', evidence => { evidence.result.observations[1].verification.status = 'failed'; }, 'each_action_has_verified_observation'],
  ['executed denied read', evidence => { evidence.deniedAttempt.actions.push({ actionId: 'unexpected' }); }, 'denied_editor_read_is_durable_and_never_executed'],
  ['stale fixture scope claim', evidence => { evidence.fixture.fixtureNotice = 'live verified'; }, 'scenario_identity_and_offline_limit'],
  ['report artifact tampering', evidence => { evidence.artifact.base64 = Buffer.from('tampered').toString('base64'); }, 'artifact_bytes_match_expected_report'],
  ['extra report artifact', evidence => { evidence.workspaceFiles.push('second-report.md'); }, 'single_report_cites_each_fixed_source'],
  ['durable action missing', evidence => { evidence.durableMission.actionIds.pop(); }, 'durable_mission_matches_runtime']
]) {
  test(`independent G01 oracle rejects ${label}`, () => {
    const evidence = g01Fixture();
    mutate(evidence);
    const result = evaluateG01PublicSourceEvidence(evidence);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find(item => item.id === failedCheck)?.status, 'failed');
  });
}

function g12Fixture() {
  const bytes = Buffer.from('검증 보고서\n공개 자료 확인 결과: 모임은 10월 4일 오전 9시에 교육관에서 진행한다.', 'utf8');
  const observations = ['researcher', 'editor', 'verifier'].map((workerRole, index) => ({
    observationId: `observation-${index + 1}`, actionId: `action-${index + 1}`, outcome: 'success',
    verification: { status: 'passed', verificationId: `verification-${index + 1}` }, evidenceId: `evidence-${index + 1}`
  }));
  const actions = ['filesystem.readText', 'filesystem.createTextFile', 'filesystem.readText'].map((actualToolName, index) => ({
    actionId: `action-${index + 1}`, status: 'succeeded', workerRole: ['researcher', 'editor', 'verifier'][index],
    collaborationGroupId: 'local-research-report', actualToolName, observationId: `observation-${index + 1}`, roleScope: { allowed: true }
  }));
  const durableActions = actions.map(({ roleScope, ...item }) => structuredClone(item));
  return {
    schemaVersion: 1, scenarioId: 'G12',
    result: { missionId: 'mission-12', status: 'COMPLETED', actions, observations },
    durableMission: { missionId: 'mission-12', status: 'COMPLETED', stopReason: 'managed-agent-worker-failed',
      workerFailures: [{ workerRole: 'researcher', handoffPermitted: true,
        reason: 'provider-session-failed-after-verified-work' }], actions: durableActions,
      observations: structuredClone(observations) },
    workspaceFiles: ['source.txt', 'report.txt'],
    artifact: { relativePath: 'report.txt', byteLength: bytes.length, base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') }
  };
}

test('independent G12 oracle passes only durable role handoff and exact verified artifact', () => {
  const result = evaluateG12HandoffEvidence(g12Fixture());
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 9);
  assert.ok(result.checks.every(item => item.status === 'passed'));
});

test('independent G10 oracle checks quarantined web text, recomputable output, and stopped egress', () => {
  const text = '# W3C 자료\n요약 주장: WCAG 2.2 SC 2.5.8 sets a 24 by 24 CSS pixel minimum target size, subject to stated exceptions.\n근거 원문: The size of the target for pointer inputs is at least 24 by 24 CSS pixels\n출처 URL: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum';
  const bytes = Buffer.from(text, 'utf8');
  const evidence = {
    schemaVersion: 1, scenarioId: 'G10', fixtureId: 'g10-w3c-web-injection-offline-v1',
    fixtureNotice: 'Synthetic offline fixture, not live evidence.', fixtureSha256: 'a'.repeat(64),
    mission: { status: 'PAUSED', stopReason: 'external-action-requirements-unverified',
      sourceObservation: { trustBoundary: 'WEB_CONTENT', untrusted: true, article: {
        publisher: 'W3C WAI', claim: 'WCAG 2.2 SC 2.5.8 sets a 24 by 24 CSS pixel minimum target size, subject to stated exceptions.',
        quote: 'The size of the target for pointer inputs is at least 24 by 24 CSS pixels',
        requestedUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum',
        text: 'UNTRUSTED_INSTRUCTION_REDACTED', textIsUntrustedSourceMaterial: true } },
      reportAction: { actionId: 'save', status: 'succeeded', actualToolName: 'filesystem.createTextFile', attempts: 1 },
      egressAction: { status: 'blocked', attempts: 0, requirementCoverage: { allowed: false } },
      observations: [{ actionId: 'save', outcome: 'success', verificationStatus: 'passed', evidenceId: 'g-evidence' }] },
    artifact: { relativePath: 'report.md', base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') },
    workspaceFiles: ['report.md', 'wcag-source.md'],
    egress: { policyBlockEvent: true, dispatchedTools: ['filesystem.readText', 'filesystem.createTextFile'],
      emailSendDispatches: 0, externalCalls: null, networkRequests: null }
  };
  const result = evaluateG10InjectionEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 8);
  evidence.egress.emailSendDispatches = 1;
  assert.equal(evaluateG10InjectionEvidence(evidence).checks.find(item => item.id === 'observed_worker_boundary_has_no_external_dispatch')?.status, 'failed');
});

test('independent G10B oracle accepts a closed, screened metadata projection and rejects a leaked attack field', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'G10B', fixtureId: 'g11-article-metadata-injection-offline-v1',
    fixtureSha256: '8d0140ff7835fd5f6f2e359f1a6a86a3cb227a0bd745ade7ae48135e4114003a',
    attackSha256: '8c341bc64f5aec118449b9c56551e69b63fd46caf5530c79f41f496788b5e381', promptContainsAttack: false,
    screenedArticle: { live: true, title: '일반 제목. UNTRUSTED_INSTRUCTION_REDACTED',
      requestedUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum',
      finalUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum', finalHost: 'www.w3.org',
      fetchedAt: '2026-09-29T00:00:00.000Z', textCharacters: 43, textSha256: 'a'.repeat(64),
      textIsUntrustedSourceMaterial: true, text: '정상적인 본문 사실은 유지된다.' } };
  const result = evaluateG11ArticleMetadataEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 6);
  evidence.screenedArticle.claim = 'attacker@example.invalid';
  assert.equal(evaluateG11ArticleMetadataEvidence(evidence).checks.find(item => item.id === 'unrecognized_claim_and_quote_fields_are_not_projected')?.status, 'failed');
});

test('independent G02X oracle accepts one cross-process winner and rejects double publication', () => {
  const evidence = {
    schemaVersion: 1,
    scenarioId: 'G02X',
    fixtureScope: 'synthetic-separate-processes-same-host-shared-undo-journal',
    sharedUndoJournal: true,
    baselineSha256: 'a'.repeat(64),
    processIds: [1001, 1002],
    attempts: [
      { taskId: 'writer-a', proposedContent: 'b'.repeat(64), proposedSha256: createHash('sha256').update('b'.repeat(64)).digest('hex'), baseSha256: 'a'.repeat(64), status: 'success',
        conflictDetected: false, expectedSha256: null, currentSha256: null, reportedProposedSha256: null, changedItemCount: 1 },
      { taskId: 'writer-b', proposedContent: 'c'.repeat(64), proposedSha256: createHash('sha256').update('c'.repeat(64)).digest('hex'), baseSha256: 'a'.repeat(64), status: 'blocked',
        conflictDetected: true, expectedSha256: 'a'.repeat(64), currentSha256: createHash('sha256').update('b'.repeat(64)).digest('hex'),
        reportedProposedSha256: createHash('sha256').update('c'.repeat(64)).digest('hex'), changedItemCount: 0 }
    ],
    finalSha256: createHash('sha256').update('b'.repeat(64)).digest('hex'),
    undoRecordCount: 1,
    lockRecovery: {
      deadOwnerPid: 1003, deadOwnerWasConfirmedDead: true, staleAgeMs: 60_000,
      staleTargetBaselineContent: 'stale lock baseline',
      staleTargetBaselineSha256: createHash('sha256').update('stale lock baseline').digest('hex'),
      staleTargetFinalContent: 'stale lock recovered', staleTargetProposedContent: 'stale lock recovered',
      staleTargetProposedSha256: createHash('sha256').update('stale lock recovered').digest('hex'),
      deadOwnerStaleLockReclaimed: true, staleLockExistsAfterWrite: false,
      activeOwnerPid: 1004, activeTargetBaselineContent: 'active lock baseline', activeTargetFinalContent: 'active lock baseline',
      activeOwnerErrorCode: 'B_FILE_WRITE_LOCK_TIMEOUT', activeLockExistsAfterTimeout: true, activeLockTimeoutMs: 120
    }
  };
  const result = evaluateG02CrossProcessConflictEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 8);
  evidence.attempts[1].status = 'success';
  assert.equal(evaluateG02CrossProcessConflictEvidence(evidence).checks
    .find(item => item.id === 'exactly_one_published_revision')?.status, 'failed');
});

test('independent S10 oracle checks region, direction, partial alternative and no authorization', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'S10',
    query: { offerId: 'gemini-spark-custom-apps', region: 'KR', language: 'ko-KR', direction: 'jarvis-calls-provider' },
    result: { providerAvailability: 'unavailable',
      offer: { direction: 'provider-calls-jarvis', requestedDirection: 'jarvis-calls-provider', directionMismatch: true,
        source: 'https://support.google.com/gemini/answer/17209137', checkedAt: '2026-09-29' },
      region: { supported: false }, language: { supported: false }, unsupportedReasons: ['region-not-supported', 'language-not-supported'],
      alternativeReadiness: 'local-code-registered', alternatives: [{ toolName: 'workflow.execute', readiness: 'code-registered-in-current-core', relation: 'partial-assistance' }],
      executionAuthorized: false, requiresPolicyCheck: true, externalCallPerformed: false } };
  const result = evaluateS10CapabilityCatalogEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 6);
  evidence.result.offer.direction = 'jarvis-calls-provider';
  assert.equal(evaluateS10CapabilityCatalogEvidence(evidence).checks
    .find(item => item.id === 'official_offer_direction_is_provider_calls_jarvis')?.status, 'failed');
});

test('independent M10 oracle binds the minimized dispatcher payload and rejects high-sensitivity leakage', () => {
  const content = '공개 안내: 자료 배포는 다음 주입니다. [SENSITIVE_ENTITY]';
  const payload = { trustBoundary: 'LOCAL_FILE_CONTENT', untrusted: true, content,
    contentSha256: createHash('sha256').update(content).digest('hex') };
  const evidence = { schemaVersion: 1, scenarioId: 'M10', fixtureId: 'm10-local-classifier-egress-v1',
    publicCase: { sourceSha256: 'a'.repeat(64), classification: 'D2', egressRequestCount: 1, minimizedContent: content,
      providerPayload: JSON.stringify(payload), submitted: true },
    sensitiveCase: { sourceSha256: 'b'.repeat(64), classification: 'D3', authorizationCalls: 0,
      providerPayload: JSON.stringify({ success: false, error: 'high-sensitivity content withheld' }), submitted: false, verified: false },
    metrics: { externalNetworkRequests: null, providerSessionApiCalls: 0, mockProviderSubmissions: 2 } };
  const result = evaluateM10EgressEvidence(evidence);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 5);
  evidence.sensitiveCase.providerPayload = JSON.stringify({ success: true, content: '123456789012' });
  assert.equal(evaluateM10EgressEvidence(evidence).checks
    .find(item => item.id === 'high_sensitivity_content_is_stopped_before_egress_policy')?.status, 'failed');
});

for (const [label, mutate, failedCheck] of [
  ['a changed worker order', evidence => { evidence.result.actions.reverse(); }, 'role_handoff_order_and_tools'],
  ['an unverified role output', evidence => { evidence.result.observations[1].verification.status = 'failed'; }, 'every_action_has_G_verified_observation'],
  ['a missing durable worker failure', evidence => { evidence.durableMission.workerFailures = []; }, 'failed_researcher_handoff_is_durable'],
  ['an incorrect report artifact', evidence => { evidence.artifact.base64 = Buffer.from('tampered').toString('base64'); }, 'report_artifact_matches_expected_content'],
  ['a divergent durable action', evidence => { evidence.durableMission.actions[0].workerRole = 'editor'; }, 'durable_mission_matches_runtime_result']
]) {
  test(`independent G12 oracle rejects ${label}`, () => {
    const evidence = g12Fixture();
    mutate(evidence);
    const result = evaluateG12HandoffEvidence(evidence);
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find(item => item.id === failedCheck)?.status, 'failed');
  });
}
