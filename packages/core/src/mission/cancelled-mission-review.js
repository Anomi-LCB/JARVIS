import { recoverMissionAction } from './mission-action-recovery.js';
import { remoteArtifactDigest as digest } from './remote-artifact-contract.js';

const failure = code => ({ success: false, error: { code: `A_MISSION_CANCELLATION_REVIEW_${code}` } });

/** Observation only: never prepare a task, resume publication, reconcile SQL, or ingest memory. */
export async function reviewCancelledMission(runtime, missionId, request = {}) {
  const mission = runtime.missions.get(missionId);
  if (!mission) return { success: false, error: { code: 'A_MISSION_NOT_FOUND' } };
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['expectedGoalRevision', 'expectedObjectiveSha256'].includes(key))
    || !Number.isSafeInteger(request.expectedGoalRevision) || request.expectedGoalRevision < 1
    || !/^[a-f0-9]{64}$/u.test(request.expectedObjectiveSha256 ?? '')) return failure('INPUT_INVALID');
  if (mission.status !== 'CANCELLED') return failure('NOT_CANCELLED');
  if (runtime.activeRuns.has(missionId)) return failure('RUN_ACTIVE');
  if (mission.goalContract?.revision !== request.expectedGoalRevision
    || mission.goalContract?.objectiveSha256 !== request.expectedObjectiveSha256) return failure('SOURCE_CHANGED');
  const snapshot = structuredClone(mission), snapshotHash = digest(mission);
  const actions = snapshot.waves.flatMap(wave => wave.actions);
  if (actions.length > 40) return failure('ACTION_LIMIT');
  const items = [];
  for (const action of actions) {
    const base = { actionId: action.actionId, operationId: action.operation?.operationId ?? null,
      toolName: action.actualToolName ?? action.expectedToolName ?? null };
    const effect = runtime.effectCoordinator.effect(action);
    const effectHash = digest(effect);
    let item;
    if (!action.operation && !action.attempts) item = { ...base, status: 'not-started', currentArtifactVerified: false };
    else if (effect?.state === 'failed' && effect.receipt?.notDispatched === true
      && effect.mission_id === missionId && effect.operation_id === action.operation?.operationId
      && effect.request_sha256 === digest(effect.intent?.request)
      && effect.intent?.request?.taskId === action.taskId
      && effect.intent?.request?.toolName === action.actualToolName
      && effect.intent?.request?.plannedRequestSha256 === action.operation?.requestSha256) {
      item = { ...base, status: 'not-dispatched', effectState: effect.state, currentArtifactVerified: false };
    } else if (effect && digest(effect.intent?.request?.executorBinding ?? { kind: 'pc-local' })
      !== digest(runtime.effectCoordinator.executorBinding())) {
      item = { ...base, status: 'unresolved', currentArtifactVerified: false, reason: 'A_MISSION_EFFECT_EXECUTOR_CHANGED' };
    } else {
      let recovered;
      try {
        const scopedGuard = runtime.resultReadGuard(snapshot);
        const currentReadGuard = scopedGuard ? access => {
          if (runtime.missions.get(missionId) !== mission || mission.executionMandateId !== snapshot.executionMandateId
            || mission.goalContract?.revision !== snapshot.goalContract?.revision
            || mission.goalContract?.objectiveSha256 !== snapshot.goalContract?.objectiveSha256) {
            throw Object.assign(new Error('Cancellation review source changed'), { code: 'A_MISSION_CANCELLATION_REVIEW_SOURCE_CHANGED' });
          }
          return scopedGuard(access);
        } : null;
        recovered = await recoverMissionAction({ missionId, action, allowedRoots: runtime.allowedRoots,
          coreFacade: runtime.coreFacade, worker: runtime.orchestrationWorker, pcAgent: runtime.pcAgent,
          observationOnly: true,
          beforeResultRead: currentReadGuard,
          durableEffect: effect, workflowCognitionIntents: runtime.effectCoordinator.workflowCognitionIntents,
          remoteArtifactRecovery: runtime.effectCoordinator.remoteArtifactRecoveryContext(action) });
      } catch { recovered = { status: 'blocked', error: { code: 'A_MISSION_CANCELLATION_REVIEW_OBSERVATION_UNAVAILABLE' } }; }
      item = recovered.status === 'recovered'
        ? { ...base, status: 'verified-executed', currentArtifactVerified: true,
          source: recovered.source, verificationId: recovered.verification.verificationId,
          packetId: recovered.packetId, effectState: effect?.state ?? null }
        : { ...base, status: 'unresolved', currentArtifactVerified: false,
          reason: recovered.error?.code ?? 'A_MISSION_CANCELLATION_REVIEW_RECEIPT_UNAVAILABLE',
          ...(recovered.error?.causeCode ? { causeCode: recovered.error.causeCode } : {}) };
    }
    if (runtime.missions.get(missionId) !== mission || digest(mission) !== snapshotHash
      || digest(runtime.effectCoordinator.effect(action)) !== effectHash) return failure('SOURCE_CHANGED');
    items.push(item);
  }
  return { success: true, reviewVersion: 'a-cancelled-mission-review-v1', missionId, status: 'CANCELLED',
    goalRevision: request.expectedGoalRevision, objectiveSha256: request.expectedObjectiveSha256,
    checkedAt: runtime.clock().toISOString(), executionAuthority: false, effectsChanged: false,
    memoriesChanged: false, items, unresolvedCount: items.filter(item => item.status === 'unresolved').length };
}
