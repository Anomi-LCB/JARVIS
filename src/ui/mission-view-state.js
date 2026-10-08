import { pcCommandDenialNextAction } from '../../packages/shared/src/pc-local-denial.js';
import {workflowFailureGuidance} from '../../packages/shared/src/workflow-failure-guidance.js';

function browserStorage() {
  try { return globalThis.sessionStorage; } catch { return null; }
}

function selectionKey({ endpoint = '', conversationId = '' } = {}) {
  return `jarvis.activeMission.${encodeURIComponent(String(endpoint).replace(/\/+$/, ''))}.${encodeURIComponent(conversationId)}`;
}

function validMissionId(value) {
  // Core stableId deliberately preserves Unicode letters and numbers. Korean
  // goals must survive reload exactly like ASCII fixture missions.
  return typeof value === 'string' && /^[\p{L}\p{N}._:-]{1,256}$/u.test(value);
}

// A tab's current goal survives reloads without crossing core or conversation boundaries.
export function createMissionSelection({ storage = browserStorage() } = {}) {
  const selections = new Map();
  return {
    read(scope) {
      const key = selectionKey(scope);
      if (selections.has(key)) return selections.get(key);
      let stored;
      try { stored = storage?.getItem(key); } catch {}
      const value = validMissionId(stored) ? stored : null;
      selections.set(key, value);
      return value;
    },
    write(scope, missionId) {
      const key = selectionKey(scope);
      const value = validMissionId(missionId) ? missionId : null;
      selections.set(key, value);
      try {
        if (value) storage?.setItem(key, value);
        else storage?.removeItem(key);
      } catch {}
      return value;
    }
  };
}

export function preferredMissionId(missions = []) {
  const timestamp = (mission) => Date.parse(mission?.createdAt ?? mission?.updatedAt ?? '') || 0;
  return [...missions].sort((left, right) => timestamp(right) - timestamp(left))
    .find((mission) => validMissionId(mission?.missionId))?.missionId ?? null;
}

export function missionPcRecoveryGuidance(mission={},language='ko') {
  if(mission.status!=='PAUSED')return [];
  const actions=(mission.waves??[]).flatMap(wave=>wave.actions??[]);
  return [...new Set(actions.filter(action=>action.recovery?.required===true&&action.recovery.status==='blocked'
    &&action.recovery.error?.code==='A_MISSION_RECOVERY_EXECUTION_UNCERTAIN')
    .map(action=>pcCommandDenialNextAction(action.recovery.error,language)).filter(Boolean))];
}

export function missionWorkflowFailureGuidance(mission={},language='ko'){
 if(!['BLOCKED','FAILED'].includes(mission.status)||mission.stopReason==='reconciliation-required'||Number(mission.uncertainEffectCount)>0)return null;
 const latestFailure=[...(mission.observations??[])].reverse().find(item=>item.outcome==='failed');
 return workflowFailureGuidance(latestFailure?.error?.code??mission.lastError?.code??mission.stopReason,language);
}

export function missionProgressMessage(mission = {}) {
  const status = String(mission.status ?? '').toUpperCase();
  const reason = String(mission.stopReason ?? '');
  const guidance=missionPcRecoveryGuidance(mission);
  if (reason === 'reconciliation-required' || Number(mission.uncertainEffectCount) > 0) {
    return `실행 결과를 다시 확인하고 있습니다. 중복 실행을 막기 위해 기존 요청의 처리 상태부터 확인합니다.${guidance.length?` PC 실행 설정 확인이 필요합니다. ${guidance.join(' ')}`:''}`;
  }
  const detail=missionWorkflowFailureGuidance(mission);
  if(detail)return `${detail.summary} ${detail.nextAction}`;
  if (mission.goalCompletionCoverage?.allowed === false) {
    return '입력한 명령에서 아직 실행·확인되지 않은 단계가 있습니다. 일부 결과만으로 전체 목표를 완료 처리하지 않습니다.';
  }
  if (reason === 'verification-incomplete' || (status === 'COMPLETED' && mission.verificationStatus && mission.verificationStatus !== 'passed')) {
    return '실행한 작업의 결과를 모두 검증하지 못했습니다. 확인된 결과와 남은 요구사항을 구분해 표시합니다.';
  }
  if (['REGISTERED', 'RUNNING'].includes(status)) return '다음 행동을 계획하고 있습니다.';
  if (status === 'CREATED') return '목표가 등록되었습니다. 실행을 기다리고 있습니다.';
  if (status === 'COMPLETED') return missionVerificationView(mission).verified
    ? '정의된 완료 기준과 실행 결과를 확인했습니다.'
    : '이전 기준에서 완료로 기록된 작업입니다. 현재 기준의 요구사항 검증 증거는 없습니다.';
  if (status === 'WAITING_APPROVAL') return '다음 행동에 필요한 승인을 기다리고 있습니다.';
  if (status === 'WAITING_INPUT') return '계속 진행하는 데 필요한 답변을 기다리고 있습니다.';
  if (reason === 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED') {
    return '지원하지 않는 명령 표현이 있어 실행을 멈췄습니다. 입력한 문장을 수정해 다시 요청해 주세요.';
  }
  if (/^NATURAL_WORKFLOW_/.test(reason)) return '명령의 데이터 이름, 경로 또는 조건을 확인할 수 없어 멈췄습니다. 입력한 문장을 확인해 다시 요청해 주세요.';
  if (/^A_WORK_REFERENCE_(STALE|NOT_FOUND|UNVERIFIED)$/.test(reason)) return '이어서 사용할 파일이 변경되었거나 현재 확인되지 않아 멈췄습니다. 사용할 파일을 지정해 다시 요청해 주세요.';
  if (reason === 'A_WORK_REFERENCE_AMBIGUOUS') return '이어서 사용할 파일이 여러 개입니다. 사용할 파일을 지정해 다시 요청해 주세요.';
  if (/budget|limit-reached/.test(reason)) return '이번 목표의 실행 한도에 도달해 멈췄습니다. 완료된 결과를 확인해 남은 작업을 요청해 주세요.';
  if (reason === 'runtime-restart-recovery') return '서비스가 다시 시작되어 목표 실행이 일시 중지되었습니다.';
  if (reason === 'action-recovery-required') {
    return guidance.length?`PC 실행 설정 확인이 필요합니다. ${guidance.join(' ')}`:'진행 중 문제가 발생해 복구 확인이 필요합니다.';
  }
  if (status === 'CANCELLED') return '목표 실행이 중단되었습니다.';
  if (status === 'PAUSED') return '목표 실행이 일시 중지되었습니다.';
  if (status === 'BLOCKED') return '계속 실행할 조건을 충족하지 못해 멈췄습니다. 목표 세부정보를 확인해 주세요.';
  if (status === 'FAILED') return '목표를 완료하지 못했습니다. 목표 세부정보를 확인해 주세요.';
  return '아직 실행된 행동이 없습니다.';
}

// Tool executions and verified requirements are different units. Never derive
// semantic completion from successfulActions or a planner's completion string.
export function missionVerificationView(mission = {}) {
  const summary = mission.verificationSummary;
  const criteria = Array.isArray(summary?.criteria) ? summary.criteria : [];
  const status = mission.verificationStatus ?? summary?.status ?? null;
  const uncertainCount = Math.max(0, Number(mission.uncertainEffectCount) || 0);
  const verifiedCount = criteria.filter((criterion) => criterion.status === 'passed').length;
  const totalCount = criteria.length || (Array.isArray(mission.successCriteria) ? mission.successCriteria.length : 0);
  const legacy = mission.status === 'COMPLETED' && (status === null || summary?.version === 'legacy');
  const coverage = mission.goalCompletionCoverage;
  const goalBlocked = coverage?.allowed === false;
  const goalRequirements = Array.isArray(mission.goalContract?.requirements) ? mission.goalContract.requirements : [];
  const coveredIds = new Set(coverage?.coveredRequirementIds ?? []);
  const missingIds = new Set(coverage?.missingRequirementIds ?? []);
  const goalRequirementsView = goalRequirements.map(item => ({ requirementId: item.requirementId, text: item.text,
    label: coveredIds.has(item.requirementId) ? '실행 근거 확인' : missingIds.has(item.requirementId) ? '확인 필요' : '검사 대기' }));
  const verified = mission.status === 'COMPLETED' && status === 'passed' && uncertainCount === 0
    && !goalBlocked && totalCount > 0 && verifiedCount === totalCount;
  const label = uncertainCount > 0 || mission.stopReason === 'reconciliation-required'
    ? '결과 확인 중'
    : legacy ? '이전 기준 완료'
    : goalBlocked || mission.stopReason === 'verification-incomplete' || status === 'unverified'
      ? '검증 대기'
      : status === 'failed' ? '검증 미충족'
        : verified ? '검증 완료' : null;
  return { label, verified, legacy, verifiedCount, totalCount, uncertainCount,
    goalBlocked, goalRequirements: goalRequirementsView,
    criteria: criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      statement: criterion.statement,
      status: criterion.status,
      label: criterion.status === 'passed' ? '확인됨' : criterion.status === 'failed' ? '미충족' : '미검증'
    })) };
}

export const missionSelection = createMissionSelection();
