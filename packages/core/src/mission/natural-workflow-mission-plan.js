import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileNaturalWorkflowObjective } from './natural-workflow-compiler.js';
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const localDispatches=new WeakMap();
const unpublishedOldFailures=new WeakMap();
export function bindNaturalWorkflowDispatches(context, actions, verifiedUnpublishedOldActionIds=[]) {
  unpublishedOldFailures.set(context,new Set(verifiedUnpublishedOldActionIds));
  localDispatches.set(context,actions.filter(action=>action.status==='succeeded'&&action.operation?.dispatch?.toolName==='workflow.execute')
    .map(action=>({actionId:action.actionId,dispatch:structuredClone(action.operation.dispatch)})));
  return context;
}
export function withNaturalWorkflowWorkspace(context, workspaceRoot) {
  const derived={...context,workspaceRoot};
  if(localDispatches.has(context))localDispatches.set(derived,localDispatches.get(context));
  if(unpublishedOldFailures.has(context))unpublishedOldFailures.set(derived,unpublishedOldFailures.get(context));
  return derived;
}

// A completed tool call must belong to this exact compiled request. The
// observation carries the digest collected from the executed packet by G.
export function compileNaturalWorkflowMission(context = {}, preparedCompiled = null) {
  const mission = context.mission;
  if (!mission || !context.workspaceRoot) return null;
  const started = performance.now();
  const compiled = preparedCompiled ?? compileNaturalWorkflowObjective(mission.objective, { workspaceRoot: context.workspaceRoot });
  if (!compiled || compiled.status === 'absent') return null;
  const clauses = compiled.clauses ?? [];
  const metadata = {
    plannerVersion: 'a-goal-executive-planner-v1',
    provider: 'natural-workflow-compiler',
    externalService: 'none',
    model: compiled.compilerVersion ?? 'natural-workflow-v1',
    latencyMs: Number((performance.now() - started).toFixed(3)),
    rawObjectiveSharedWithModel: false,
    degraded: false,
    modelRoundTrips: 0,
    clauseCount: clauses.length,
    cacheHit: compiled.cacheHit === true
  };
  const unsatisfied = (reason) => (mission.successCriteria ?? []).map(({ criterionId }) => ({
    criterionId, status: 'unsatisfied', evidenceActionIds: [], reason
  }));
  const blocked = (reason, summary) => plan({
    decision: 'blocked', summary, blockedReason: reason, actions: [],
    criteriaAssessment: unsatisfied(summary)
  }, { ...metadata, reason });
  if (!compiled.spec) {
    return blocked(compiled.code ?? compiled.reason ?? 'natural-workflow-compile-blocked',
      compiled.message ?? compiled.summary ?? '명령의 모든 작업을 정확히 해석하지 못해 실행하지 않았습니다.');
  }
  const specSha256 = createHash('sha256').update(JSON.stringify(compiled.spec)).digest('hex');
  metadata.specSha256 = specSha256;
  const latest = (context.observations ?? []).filter((item) => item.toolName === 'workflow.execute'
    &&!unpublishedOldFailures.get(context)?.has(item.actionId)).at(-1);
  if (latest) {
    if (latest.outcome !== 'success') return blocked(latest.error?.code ?? 'natural-workflow-execution-failed',
      latest.summary ?? '복합 작업을 완료하지 못했습니다.');
    if (latest.verification?.status !== 'passed') return blocked('natural-workflow-verification-failed',
      '생성된 결과가 실행 검증을 통과하지 못했습니다.');
    const actual = latest.data?.workflow;
    let dispatchedSpecSha256 = specSha256;
    const dispatch = localDispatches.get(context)?.find(action=>action.actionId===latest.actionId)?.dispatch;
    if (dispatch?.workflowSpecSource !== undefined) {
      // SQL canonicalizes snapshot object keys. Preserve the exact dispatched
      // bytes for the receipt digest, while comparing the full original plan
      // structurally; arrays (operation order) are deliberately not reordered.
      try {
        if (dispatch.taskId!==latest.taskId || dispatch.toolName!=='workflow.execute'
          || typeof dispatch.workflowSpecSource!=='string'
          || canonical(JSON.parse(dispatch.workflowSpecSource))!==canonical(compiled.spec)) throw Error('dispatch-source-mismatch');
        dispatchedSpecSha256=createHash('sha256').update(dispatch.workflowSpecSource).digest('hex');
      } catch { return blocked('natural-workflow-evidence-mismatch', '실행한 작업 원문이 이번 명령의 전체 작업 계획과 일치하지 않습니다.'); }
    }
    if (!latest.actionId || actual?.specSha256 !== dispatchedSpecSha256 || actual?.workflowId !== compiled.spec.workflowId
      || actual?.nodeCount !== compiled.spec.nodes.length) {
      return blocked('natural-workflow-evidence-mismatch', '실행 증거가 이번 명령의 전체 작업 계획과 일치하지 않습니다.');
    }
    // A matching execution receipt proves this workflow ran, not every additional
    // requirement in the user's criterion. Core computes these checks independently.
    const criteriaAssessment = (mission.successCriteria ?? []).map(({ criterionId }) => {
      const proof = (context.criterionEvidence ?? []).find(item => item.criterionId === criterionId);
      const satisfied = proof?.passed === true && proof?.status === 'passed'
        && proof.evidenceActionIds?.includes(latest.actionId);
      return { criterionId, status: satisfied ? 'satisfied' : 'unsatisfied',
        evidenceActionIds: satisfied ? [...proof.evidenceActionIds] : [],
        reason: satisfied ? 'Core의 요구사항별 독립 산출물 검증을 통과했습니다.'
          : '실행은 확인했지만 이 요구사항을 입증하는 독립 검증이 부족합니다.' };
    });
    const verified = criteriaAssessment.length > 0 && criteriaAssessment.every(item => item.status === 'satisfied');
    return plan({
      decision: verified ? 'complete' : 'pause',
      ...(verified ? {} : { pauseReason: 'verification-incomplete' }),
      summary: verified ? `${clauses.length}개 작업을 완료하고 ${compiled.spec.outputs?.length ?? 0}개 결과 파일을 검증했습니다.`
        : '작업 산출물을 보존했습니다. 남은 성공 기준은 증거를 확인한 뒤 완료 처리합니다.',
      blockedReason: null, actions: [],
      criteriaAssessment
    }, { ...metadata, reason: verified ? 'natural-workflow-complete' : 'verification-incomplete' });
  }
  return plan({
    decision: 'continue', summary: `${clauses.length}개 작업의 순서와 데이터 관계를 확인했습니다. 처리를 시작합니다.`,
    blockedReason: null,
    actions: [{
      id: 'natural_workflow_execute', title: `${clauses.length}개 복합 작업 처리`,
      command: '로컬 복합 워크플로를 실행하고 요청한 결과 파일을 생성해',
      expectedToolName: 'workflow.execute',
      arguments: { spec: compiled.spec, workspaceRoot: context.workspaceRoot, ...(preparedCompiled ? {allowOverwrite:false} : {}) },
      dependencies: [], successSignal: '전체 작업과 산출물 검증을 통과하고 실행 계획의 해시가 원래 명령과 일치함'
    }],
    criteriaAssessment: unsatisfied('작업의 실행 증거가 아직 없습니다.')
  }, { ...metadata, reason: 'natural-workflow-execute' });
}

function plan(value, planning) {
  const result = { ...value, question: null, planning };
  result.fingerprint = createHash('sha256').update(JSON.stringify({
    decision: value.decision, actions: value.actions, criteriaAssessment: value.criteriaAssessment,
    blockedReason: value.blockedReason, pauseReason: value.pauseReason
  })).digest('hex');
  return result;
}
