import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { compileNaturalWorkflowMission, withNaturalWorkflowWorkspace } from './natural-workflow-mission-plan.js';
import { validateWorkflowSpec } from './workflow-ir.js';
import { isLocalOnlyWorkflowSpec } from './mission-local-workflow-constraints.js';

const workflowPathSuffix = '.workflow.json';

export function compileLocalWorkflowMission(context = {}) {
  const mission = context?.mission;
  const workspaceRoot = normalizeWorkspaceRoot(context?.workspaceRoot);
  if (!mission || !workspaceRoot) return null;

  const naturalPlan = compileNaturalWorkflowMission(withNaturalWorkflowWorkspace(context, workspaceRoot));
  if (naturalPlan) return naturalPlan;

  const pathSelection = selectWorkflowSpecPath(mission.objective, workspaceRoot);
  if (pathSelection.status === 'absent') return null;
  if (pathSelection.status !== 'selected') {
    return createCompilerPlan({
      decision: 'blocked',
      summary: pathSelection.status === 'ambiguous'
        ? '서로 다른 워크플로 명세 경로가 여러 개라 실행 대상을 안전하게 확정할 수 없습니다.'
        : '워크플로 명세 경로가 허용된 작업 폴더를 벗어나 실행을 차단했습니다.',
      question: null,
      blockedReason: pathSelection.status === 'ambiguous'
        ? 'local-workflow-spec-path-ambiguous'
        : 'local-workflow-spec-outside-workspace',
      actions: [],
      criteriaAssessment: unsatisfiedCriteria(mission, '안전한 워크플로 명세 경로가 확정되지 않았습니다.')
    }, pathSelection.status);
  }

  const observations = Array.isArray(context.observations) ? context.observations : [];
  const workflowObservations = observations.filter((observation) => observation?.toolName === 'workflow.execute');
  const latestExecution = workflowObservations.at(-1);
  if (latestExecution?.outcome === 'success' && latestExecution.verification?.status === 'passed') {
    const evidenceActionIds = latestExecution.actionId ? [latestExecution.actionId] : [];
    return createCompilerPlan({
      decision: 'complete',
      summary: `${basename(pathSelection.path)} 워크플로의 실행과 결과 검증을 완료했습니다.`,
      question: null,
      blockedReason: null,
      actions: [],
      criteriaAssessment: (mission.successCriteria ?? []).map((criterion) => ({
        criterionId: criterion.criterionId,
        status: 'satisfied',
        evidenceActionIds,
        reason: 'typed local workflow가 A-G 실행 경로와 결과 검증을 통과했습니다.'
      }))
    }, 'local-workflow-complete');
  }
  if (latestExecution?.outcome === 'success') {
    return createCompilerPlan({
      decision: 'blocked',
      summary: latestExecution.summary ?? `${basename(pathSelection.path)} 워크플로 실행 결과의 독립 검증이 완료되지 않았습니다.`,
      question: null,
      blockedReason: 'local-workflow-verification-failed',
      actions: [],
      criteriaAssessment: unsatisfiedCriteria(mission, '워크플로 실행 결과가 G 검증을 통과하지 못했습니다.')
    }, 'local-workflow-verification-failed');
  }
  if (latestExecution && latestExecution.outcome !== 'success') {
    return createCompilerPlan({
      decision: 'blocked',
      summary: latestExecution.summary ?? `${basename(pathSelection.path)} 워크플로 실행이 실패했습니다.`,
      question: null,
      blockedReason: latestExecution.error?.code ?? 'local-workflow-execution-failed',
      actions: [],
      criteriaAssessment: unsatisfiedCriteria(mission, '워크플로의 검증된 성공 증거가 없습니다.')
    }, 'local-workflow-failed');
  }

  const displayPath = relative(workspaceRoot, pathSelection.path) || basename(pathSelection.path);
  let expectedSha256;
  try {
    const info = statSync(pathSelection.path);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('workflow-spec-size-or-type-invalid');
    const bytes = readFileSync(pathSelection.path);
    const spec = validateWorkflowSpec(JSON.parse(bytes.toString('utf8')));
    if (!isLocalOnlyWorkflowSpec(spec)) throw new Error('workflow-spec-has-nonlocal-operations');
    expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    return createCompilerPlan({ decision: 'blocked', summary: `${basename(pathSelection.path)} 파일은 검증된 로컬 워크플로 명세가 아니므로 실행하지 않았습니다.`,
      question: null, blockedReason: `local-workflow-spec-unverified:${error.code ?? error.message}`, actions: [],
      criteriaAssessment: unsatisfiedCriteria(mission, '워크플로 파일의 무결성과 로컬 동작 범위를 확인할 수 없습니다.') }, 'local-workflow-spec-unverified');
  }
  return createCompilerPlan({
    decision: 'continue',
    summary: `${displayPath}의 검증된 typed workflow 명세를 로컬 실행기로 전달합니다.`,
    question: null,
    blockedReason: null,
    actions: [{
      id: 'local_workflow_execute',
      title: `${basename(pathSelection.path)} 로컬 워크플로 실행`,
      command: `로컬 typed workflow 명세 "${pathSelection.path}"를 실행해`,
      expectedToolName: 'workflow.execute',
      arguments: { specPath: pathSelection.path, expectedSha256 },
      requirementIds: (mission.goalContract?.requirements ?? [])
        .filter(requirement => !(mission.goalContract?.constraints ?? []).some(item => item.requirementId === requirement.requirementId))
        .map(requirement => requirement.requirementId),
      constraintRequirementIds: (mission.goalContract?.constraints ?? []).map(item => item.requirementId),
      dependencies: [],
      successSignal: '모든 DAG 노드가 제한된 로컬 실행기에서 완료되고 산출물 및 실행 영수증이 G 검증을 통과함'
    }],
    criteriaAssessment: unsatisfiedCriteria(mission, '워크플로 실행 증거가 아직 없습니다.')
  }, 'local-workflow-execute');
}

export function extractLocalWorkflowSpecPath(objective, workspaceRoot) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) return null;
  const selection = selectWorkflowSpecPath(objective, normalizedRoot);
  return selection.status === 'selected' ? selection.path : null;
}

function selectWorkflowSpecPath(objective, workspaceRoot) {
  const candidates = extractPathCandidates(objective);
  if (candidates.length === 0) return { status: 'absent' };
  const selected = new Map();
  let unsafe = false;
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, workspaceRoot);
    if (!resolved) {
      unsafe = true;
      continue;
    }
    selected.set(pathIdentity(resolved), resolved);
  }
  if (unsafe) return { status: 'unsafe' };
  if (selected.size > 1) return { status: 'ambiguous' };
  if (selected.size === 0) return { status: 'unsafe' };
  return { status: 'selected', path: [...selected.values()][0] };
}

function extractPathCandidates(objective) {
  const text = String(objective ?? '');
  if (!text.toLocaleLowerCase().includes(workflowPathSuffix)) return [];
  const candidates = [];
  const quotedSpans = [];
  const quotedPattern = /["'“‘`]([^"'”’`\r\n]+?\.workflow\.json)["'”’`]/giu;
  for (const match of text.matchAll(quotedPattern)) {
    candidates.push(cleanPathCandidate(match[1]));
    quotedSpans.push([match.index, match.index + match[0].length]);
  }
  const unquotedPattern = /[^\s"'“”‘’`<>|?*\u0000-\u001f]+?\.workflow\.json/giu;
  for (const match of text.matchAll(unquotedPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (quotedSpans.some(([left, right]) => start >= left && end <= right)) continue;
    candidates.push(cleanPathCandidate(match[0]));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function cleanPathCandidate(value) {
  let candidate = String(value ?? '').trim().replace(/^[([{<]+/u, '').replace(/[)\]}>]+$/u, '');
  const drivePathOffset = candidate.search(/[A-Za-z]:[\\/]/u);
  if (drivePathOffset > 0) candidate = candidate.slice(drivePathOffset);
  return candidate;
}

function resolveCandidate(candidate, workspaceRoot) {
  if (
    !candidate
    || /[\u0000-\u001f\u007f]/u.test(candidate)
    || /^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)
    || !candidate.toLocaleLowerCase().endsWith(workflowPathSuffix)
  ) return null;
  const absolute = resolve(isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate));
  if (!isInside(workspaceRoot, absolute)) return null;

  if (existsSync(absolute)) {
    try {
      const realRoot = realpathSync.native(workspaceRoot);
      const realCandidate = realpathSync.native(absolute);
      if (!isInside(realRoot, realCandidate)) return null;
    } catch {
      return null;
    }
  }
  return absolute;
}

function normalizeWorkspaceRoot(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return resolve(value);
}

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function pathIdentity(value) {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function unsatisfiedCriteria(mission, reason) {
  return (mission.successCriteria ?? []).map((criterion) => ({
    criterionId: criterion.criterionId,
    status: 'unsatisfied',
    evidenceActionIds: [],
    reason
  }));
}

function createCompilerPlan(plan, reason) {
  const result = {
    ...plan,
    planning: {
      plannerVersion: 'a-goal-executive-planner-v1',
      provider: 'local-workflow-compiler',
      externalService: 'none',
      model: 'deterministic-local-workflow-v1',
      latencyMs: 0,
      rawObjectiveSharedWithModel: false,
      degraded: false,
      reason,
      modelRoundTrips: 0
    }
  };
  result.fingerprint = createHash('sha256').update(JSON.stringify({
    decision: result.decision,
    actions: result.actions,
    criteriaAssessment: result.criteriaAssessment,
    blockedReason: result.blockedReason
  })).digest('hex');
  return result;
}
