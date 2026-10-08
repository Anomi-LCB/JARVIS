import { createHash } from 'node:crypto';
import { reviseGoalContract } from './goal-contract.js';

const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value && typeof value === 'object' ? sort(value) : value);
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const issue = (code, message, extra = {}) => ({ success: false, error: { code: `A_MISSION_GOAL_REVISION_${code}`, message, ...extra } });
const currentRevision = mission => mission.goalContract?.revision ?? 1;
const pending = mission => mission.goalRevisionRequest?.state === 'pending';
const effectful = action => {
  const profile = action.operation?.dispatch?.profile ?? action.capabilityProfile;
  return profile?.contractReadOnly !== true || profile?.mutatesSystem === true || profile?.externalTransfer === true;
};

/** Goal revisions preserve prior effects; they never authorize compensation or
 * turn an unknown provider result into permission to try the effect again. */
export class MissionGoalRevisionCoordinator {
  constructor(runtime, { normalizeSuccessCriteria, normalizeConstraints }) {
    this.runtime = runtime;
    this.normalizeSuccessCriteria = normalizeSuccessCriteria;
    this.normalizeConstraints = normalizeConstraints;
    this.drains = new Map();
  }
  response(mission, request) {
    if (request.state === 'cancelled') return issue('CANCELLED', '취소된 목표의 수정 요청은 적용하지 않습니다.');
    if (request.state === 'failed') return issue('APPLY_FAILED', '수정 내용을 저장하지 못했습니다. 같은 요청으로 다시 확인하세요.');
    return { success: true, status: request.state === 'applied' ? 'applied' : 'pending', mission: this.runtime.publicMission(mission),
      revisionRequest: { idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision,
        targetRevision: request.targetRevision, state: request.state, requestedAt: request.requestedAt,
        appliedAt: request.appliedAt ?? null, conflicts: clone(request.conflicts ?? []), nextAction: request.nextAction ?? null } };
  }
  request(missionId, input = {}) {
    const mission = this.runtime.missions.get(missionId);
    if (!mission) return { success: false, error: { code: 'A_MISSION_NOT_FOUND', message: 'Mission was not found.' } };
    if (this.runtime.shutdownRequest) return issue('SHUTTING_DOWN', '종료 중에는 목표를 수정할 수 없습니다.');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['objective', 'successCriteria', 'constraints', 'expectedRevision', 'idempotencyKey', 'reason'].includes(key))
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/u.test(input.idempotencyKey)
      || typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 32768
      || (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1000))) {
      return issue('INPUT_INVALID', '원문 전체, 현재 목표 버전, 고유 요청 키를 올바르게 입력하세요.');
    }
    const requestHash = digest(canonical(input));
    const previous = (mission.goalRevisionRequests ?? []).find(item => item.idempotencyKey === input.idempotencyKey);
    if (previous) return previous.requestHash === requestHash ? this.response(mission, previous)
      : issue('IDEMPOTENCY_CONFLICT', '같은 수정 요청 키에 다른 내용을 사용할 수 없습니다.');
    if (mission.status === 'CANCELLED') return issue('CANCELLED', '취소된 목표를 수정해 재개할 수 없습니다.');
    if (pending(mission)) return issue('PENDING', '진행 중인 작업의 결과를 보존한 뒤 앞선 수정 요청을 적용합니다.');
    if (input.expectedRevision !== currentRevision(mission)) return issue('CAS_CONFLICT', '목표 버전이 바뀌었습니다. 최신 목표를 읽고 수정하세요.', { currentRevision: currentRevision(mission) });
    if ((mission.goalRevisionRequests?.length ?? 0) >= 100) return issue('HISTORY_LIMIT', '수정 기록의 보존 한도에 도달했습니다. 새 Mission에서 후속 작업을 시작하세요.');
    let criteria = null, constraints = null;
    try {
      if (input.successCriteria !== undefined) {
        criteria = this.normalizeSuccessCriteria(input.successCriteria, input.objective.length);
        if (!criteria.length) criteria = [{ criterionId: 'criterion_1', statement: input.objective.trim() }];
      }
      if (input.constraints !== undefined) constraints = this.normalizeConstraints(input.constraints);
      // Validate the complete replacement before interrupting any useful work.
      reviseGoalContract(mission.goalContract, { objective: input.objective, successCriteria: criteria });
    } catch (error) { return issue('CONTRACT_INVALID', error.message, { causeCode: error.code ?? null }); }
    const request = { idempotencyKey: input.idempotencyKey, requestHash, expectedRevision: input.expectedRevision,
      targetRevision: input.expectedRevision + 1, requestedAt: this.runtime.clock().toISOString(), state: 'pending',
      input: { objective: input.objective, successCriteria: criteria, constraints, reason: input.reason ?? null } };
    const before = clone(mission);
    mission.goalRevisionRequests ??= [];
    mission.goalRevisionRequests.push(request); mission.goalRevisionRequest = request;
    try { this.runtime.touch(mission, 'mission-goal-revision-requested'); }
    catch (error) { this.restore(mission, before); return issue('PERSIST_FAILED', '수정 요청을 저장하지 못해 기존 목표를 유지했습니다.', { causeCode: error.code ?? null }); }
    const active = this.runtime.activeRuns.get(missionId);
    if (active) {
      // Abort planning only. The existing worker handoff must settle or remain
      // uncertain; its effects and receipts must not be discarded by this edit.
      active.controller.abort('goal-revision-requested');
      this.schedule(mission, active.promise);
    } else {
      try { this.apply(mission); }
      catch (error) { return issue('PERSIST_FAILED', '수정 적용을 저장하지 못했습니다. 보존된 요청은 재시작 후 확인됩니다.', { causeCode: error.code ?? null }); }
    }
    return this.response(mission, mission.goalRevisionRequest);
  }
  restore(mission, previous) { for (const key of Object.keys(mission)) delete mission[key]; Object.assign(mission, previous); }
  schedule(mission, activePromise = Promise.resolve()) {
    if (this.drains.has(mission.missionId)) return;
    const work = Promise.resolve(activePromise).catch(() => {}).then(() => this.apply(mission))
      .catch(error => {
        mission.goalRevisionRequest.state = 'failed';
        mission.goalRevisionRequest.errorCode = error.code ?? 'revision-apply-error';
        mission.status = mission.status === 'CANCELLED' ? 'CANCELLED' : 'PAUSED';
        mission.stopReason = 'goal-revision-apply-failed';
        try { this.runtime.touch(mission, 'mission-goal-revision-failed'); } catch { /* retain the persisted pending request for restart */ }
      }).finally(() => this.drains.delete(mission.missionId));
    this.drains.set(mission.missionId, work);
  }
  hydrate() {
    for (const mission of this.runtime.missions.values()) if (pending(mission)) {
      // JSON storage does not preserve object aliases. Reattach the request log
      // so an applied restart is also an applied idempotency replay.
      mission.goalRevisionRequest = mission.goalRevisionRequests?.find(item => item.idempotencyKey === mission.goalRevisionRequest.idempotencyKey)
        ?? mission.goalRevisionRequest;
      this.schedule(mission);
    }
  }
  effects(mission) {
    return mission.waves.flatMap(wave => wave.actions).filter(action => action.revisionNoHandoff !== true && !this.runtime.hasVerifiedUnpublishedPersonFailure?.(action) && effectful(action)
      && (action.status === 'succeeded' || action.attempts > 0 || action.operation?.dispatch || action.effect?.state === 'uncertain'))
      .map(action => ({ actionId: action.actionId, taskId: action.taskId, effectId: action.effect?.effectId ?? action.operation?.operationId ?? action.actionId,
        requirementIds: clone(action.requirementIds ?? []), toolName: action.actualToolName ?? action.expectedToolName,
        status: action.status === 'succeeded' ? 'confirmed' : 'unknown', goalRevision: action.goalRevision ?? currentRevision(mission) }));
  }
  apply(mission) {
    const request = mission.goalRevisionRequest;
    if (!request || request.state !== 'pending') return;
    if (mission.status === 'CANCELLED') {
      request.state = 'cancelled'; request.nextAction = '취소 상태를 유지합니다. 필요하면 새 Mission을 만드세요.';
      this.runtime.touch(mission, 'mission-goal-revision-cancelled'); return;
    }
    if (this.runtime.activeRuns.has(mission.missionId)) return;
    if (currentRevision(mission) !== request.expectedRevision) throw Object.assign(new Error('revision-cas-lost'), { code: 'A_MISSION_GOAL_REVISION_CAS_CONFLICT' });
    const prior = clone(mission), previous = mission.goalContract, effects = this.effects(mission);
    const ids = new Set(previous.requirements.map(item => item.requirementId));
    const linked = effects.flatMap(effect => effect.requirementIds.filter(id => ids.has(id)).map(requirementId => ({
      requirementId, effectId: `effect_${digest(effect.effectId).slice(0, 32)}`, status: effect.status })));
    const next = reviseGoalContract(previous, { objective: request.input.objective, successCriteria: request.input.successCriteria, executedEffects: linked });
    // Unbound criteria cannot silently prove a changed goal merely because an
    // old output still exists. Preserve the criteria while requiring review.
    if (request.input.successCriteria === null && previous.objectiveSha256 !== next.objectiveSha256) {
      next.revisionChange.invalidatedCriterionIds = [...new Set([...next.revisionChange.invalidatedCriterionIds,
        ...previous.successCriteria.filter(criterion => !previous.criterionBindings?.some(binding => binding.criterionId === criterion.criterionId
          && binding.status === 'bound' && next.requirements.some(requirement => requirement.requirementId === binding.requirementId))).map(item => item.criterionId)])];
    }
    const retained = new Set(next.requirements.map(item => item.requirementId));
    const conflicts = effects.filter(effect => effect.status === 'unknown' || !effect.requirementIds.length
      || effect.requirementIds.some(id => !retained.has(id))).map(effect => ({ ...effect,
        code: effect.status === 'unknown' ? 'uncertain-effect-before-revision'
          : !effect.requirementIds.length ? 'unmapped-effect-before-revision' : 'completed-effect-before-revision' }));
    mission.goalRevisionHistory ??= [];
    mission.goalRevisionHistory.push({ revision: previous.revision, objective: mission.objective, goalContract: clone(previous),
      successCriteria: clone(mission.successCriteria), constraints: clone(mission.constraints), completion: clone(mission.completion),
      authorization: clone(mission.authorization), revisedAt: this.runtime.clock().toISOString(), requestKey: request.idempotencyKey,
      revisionReason: request.input.reason ?? null, revisedToRevision: next.revision, effects: clone(effects) });
    for (const wave of mission.waves) {
      for (const action of wave.actions) {
        action.goalRevision ??= previous.revision;
        if (!['succeeded', 'failed', 'skipped'].includes(action.status) && !effects.some(effect => effect.actionId === action.actionId)) {
          action.status = 'skipped'; action.skipReason = 'goal-revision-superseded'; action.supersededByRevision = next.revision;
        }
      }
      if (!['completed', 'completed_with_failures'].includes(wave.status)) {
        wave.status = 'completed_with_failures'; wave.supersededByRevision = next.revision;
      }
    }
    for (const gate of mission.gates) if (['pending', 'approved'].includes(gate.status)) {
      gate.priorStatus = gate.status; gate.status = 'superseded'; gate.supersededByRevision = next.revision;
    }
    mission.objective = request.input.objective.trim(); mission.objectiveHash = digest(mission.objective);
    mission.goalContract = next; mission.successCriteria = clone(next.successCriteria);
    if (request.input.constraints !== null) mission.constraints = clone(request.input.constraints);
    mission.completion = null; mission.goalCompletionCoverage = null; mission.verificationSummary = null;
    mission.verificationStatus = 'unverified'; mission.planStall = null; mission.failureSignatures = {};
    mission.goalRevisionEffects = effects; mission.goalRevisionConflicts = conflicts;
    request.state = 'applied'; request.appliedAt = this.runtime.clock().toISOString(); request.conflicts = conflicts;
    request.nextAction = conflicts.length ? '표시된 이전 실행 결과를 확인하세요. 이미 실행한 일을 취소하거나 다시 실행하지 않았습니다.'
      : next.revisionChange.invalidatedCriterionIds.length ? '변경된 목표에 맞는 완료 기준을 지정하세요.' : '새 목표의 남은 작업을 다시 계획할 수 있습니다.';
    mission.status = 'PAUSED'; mission.stopReason = conflicts.length ? 'goal-revision-effect-conflict'
      : next.revisionChange.invalidatedCriterionIds.length ? 'goal-revision-criteria-review' : 'goal-revision-ready';
    try { this.runtime.touch(mission, 'mission-goal-revision-applied'); }
    catch (error) { this.restore(mission, prior); throw error; }
    for (const action of mission.waves.flatMap(wave => wave.actions).filter(item => item.supersededByRevision === next.revision && item.taskId)) {
      try { this.runtime.coreFacade.cancelTask?.(action.taskId, { reason: 'goal-revision-superseded', source: mission.missionId }); }
      catch { /* The revision dispatch guard still prevents this task from running. */ }
    }
  }
  pause(mission, wave = null) {
    if (!pending(mission)) return false;
    if (mission.status !== 'CANCELLED') { mission.status = 'PAUSED'; mission.stopReason = 'goal-revision-pending'; }
    if (wave) wave.status = 'paused';
    return true;
  }
  blocksRun(mission) {
    if (pending(mission)) return issue('PENDING', '기존 실행 결과를 보존한 뒤 목표 수정을 적용합니다.');
    if (mission.goalRevisionRequest?.state === 'failed') return issue('APPLY_FAILED', '목표 수정 저장을 확인해야 합니다.');
    if (mission.goalRevisionConflicts?.length) return issue('EFFECT_CONFLICT', '이전 실행 효과를 먼저 확인해야 합니다.', { conflicts: clone(mission.goalRevisionConflicts) });
    if (mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length) return issue('CRITERIA_REVIEW', '새 목표의 완료 기준을 지정해야 합니다.', { criterionIds: clone(mission.goalContract.revisionChange.invalidatedCriterionIds) });
    return null;
  }
  gateIssue(mission, gate) {
    if (pending(mission)) return issue('PENDING', '목표 수정 중에는 이전 승인에 응답할 수 없습니다.');
    if (gate.status === 'superseded' || (gate.goalRevision ?? 1) !== currentRevision(mission)) return issue('STALE_GATE', '이전 목표의 승인을 새 목표에 사용할 수 없습니다.');
    return null;
  }
  actionIssue(mission, action, task) {
    const blocked = this.blocksRun(mission); if (blocked) return blocked;
    if ((action.goalRevision ?? 1) !== currentRevision(mission)) return issue('STALE_ACTION', '이전 목표의 미실행 계획을 재사용할 수 없습니다.');
    if (currentRevision(mission) <= 1) return null;
    if (!effectful(action)) return null;
    const priorEffects = mission.goalRevisionEffects ?? [];
    const prior = mission.waves.flatMap(wave => wave.actions).find(item => item.actionId !== action.actionId
      && priorEffects.some(effect => effect.actionId === item.actionId)
      && (item.requirementIds?.some(id => action.requirementIds?.includes(id))
        || (item.operation?.dispatch?.toolName === task?.plan?.action?.toolName
          && canonical(item.operation.dispatch.arguments) === canonical(task.plan.action.arguments))));
    return prior ? issue('EFFECT_REPLAY_BLOCKED', '이전 목표에서 이미 실행했거나 결과가 불명확한 효과를 다시 실행하지 않습니다.', { actionId: prior.actionId }) : null;
  }
  completionIssue(mission) { return this.blocksRun(mission); }
}
