import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MissionGrant, MissionStatus } from './mission-runtime.js';
import { minimizeExternalText } from './mission-planner.js';
import { normalizeMissionRoleAssignment } from './mission-role-scope.js';
import {missionEgressGoalBinding} from './mission-egress-goal-binding.js';
import {DATA_PURPOSE_POLICY_VERSION,MANAGED_EVIDENCE_PURPOSE,evaluateMissionDataPurpose} from '../security/data-purpose-policy.js';

const TOOL_NAME = 'jarvis.mission.read_text';
const PROVIDER_ID = 'openai-agents-api';
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Creates a deliberately narrow remote-tool dispatcher. Every accepted read
 * is a child Mission executed by MissionRuntime's normal E→B→G path. The
 * required egress policy sees the verified local output before anything is
 * returned to the managed provider; without a positive decision, no content
 * leaves this process.
 */
export function createMissionRuntimeManagedAgentDispatcher({ missionRuntime, authorizeEgress, verifyEgressDecision, egressPolicy = null,
  dataClassifier = missionRuntime?.dataClassifier } = {}) {
  if (!missionRuntime?.createMission || !missionRuntime?.createWave || !missionRuntime?.executeWave
    || !missionRuntime?.coreFacade?.getTask || !Array.isArray(missionRuntime.allowedRoots)) {
    fail('A_MANAGED_AGENT_MISSION_RUNTIME_REQUIRED');
  }
  authorizeEgress ??= egressPolicy?.authorize?.bind(egressPolicy);
  verifyEgressDecision ??= egressPolicy?.verify?.bind(egressPolicy);
  if (typeof authorizeEgress !== 'function') fail('A_MANAGED_AGENT_EGRESS_POLICY_REQUIRED');
  if (typeof verifyEgressDecision !== 'function') fail('A_MANAGED_AGENT_EGRESS_DECISION_VERIFIER_REQUIRED');

  const dispatchVerifiedTool = async function(request) {
    const parent = missionRuntime.missions.get(request?.missionId);
    if (!parent) return { status: 'blocked', error: 'The bound JARVIS Mission no longer exists.' };
    if ([MissionStatus.COMPLETED, MissionStatus.CANCELLED, MissionStatus.FAILED, MissionStatus.BLOCKED].includes(parent.status)) {
      return { status: 'blocked', error: 'A terminal JARVIS Mission cannot dispatch managed-agent tools.' };
    }
    if (!parent.authorization?.grants?.includes(MissionGrant.READ_ONLY)) {
      return { status: 'blocked', error: 'The JARVIS Mission has no read-only execution grant.' };
    }
    const goalBinding = missionEgressGoalBinding(parent);
    const executionMandateId=parent.executionMandateId??null;
    const parentDataAuthorized=path=>{
      if((parent.executionMandateId??null)!==executionMandateId)return false;
      if(executionMandateId===null)return true;
      try{
        const guard=missionRuntime.resultReadGuard?.(parent);
        if(typeof guard!=='function')return false;
        guard({path,kind:'read'});return true;
      }catch{return false;}
    };
    const currentParentAuthorized = () => missionRuntime.missions.get(parent.missionId) === parent
      && ![MissionStatus.COMPLETED, MissionStatus.CANCELLED, MissionStatus.FAILED, MissionStatus.BLOCKED].includes(parent.status)
      && parent.authorization?.grants?.includes(MissionGrant.READ_ONLY)
      && missionEgressGoalBinding(parent) === goalBinding;
    const role = normalizeMissionRoleAssignment({ workerRole: request?.workerRole ?? null,
      collaborationGroupId: request?.collaborationGroupId ?? null });
    if (!role.valid) return { status: 'blocked', error: 'The managed-agent role assignment is invalid.' };
    if (request?.toolName !== TOOL_NAME) return { status: 'blocked', error: 'This managed-agent tool is not supported.' };
    const args = request.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['path', 'offset', 'maxChars', 'sourceActionId'].includes(key))
      || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4_000
      || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 100_000))
      || (args.maxChars !== undefined && (!Number.isSafeInteger(args.maxChars) || args.maxChars < 1 || args.maxChars > 12_000))) {
      return { status: 'blocked', error: 'The read request has invalid or unsupported arguments.' };
    }
    let path = isAbsolute(args.path) ? resolve(args.path) : resolve(missionRuntime.allowedRoots[0], args.path);
    if (!missionRuntime.allowedRoots.some(root => isInside(root, path))) {
      return { status: 'blocked', error: 'The requested path is outside JARVIS allowed roots.' };
    }
    let canonicalRoots = [];
    try {
      const [canonicalPath, ...resolvedRoots] = await Promise.all([
        realpath(path), ...missionRuntime.allowedRoots.map(root => realpath(root))
      ]);
      canonicalRoots = resolvedRoots;
      if (!canonicalRoots.some(root => isInside(root, canonicalPath))) {
        return { status: 'blocked', error: 'The resolved path crosses a symbolic link outside JARVIS allowed roots.' };
      }
      path = canonicalPath;
    } catch {
      return { status: 'blocked', error: 'The requested path or an allowed root could not be resolved safely.' };
    }

    if (!currentParentAuthorized()) return { status: 'blocked', error: 'The Mission changed while resolving the read scope.' };
    let roleArtifactProof = null;
    if (role.assignment && args.sourceActionId !== undefined) {
      if (typeof args.sourceActionId !== 'string' || !args.sourceActionId.trim() || args.sourceActionId.length > 200) {
        return { status: 'blocked', error: 'The source action identifier is invalid.' };
      }
      const sourceAction = parent.waves.flatMap(wave => wave.actions).find(item => item.actionId === args.sourceActionId);
      if (!sourceAction) return { status: 'blocked', error: 'The named source action does not belong to this Mission.' };
      if (sourceAction.status !== 'succeeded') return { status: 'blocked', error: 'The named source action has not succeeded.' };
      if (typeof sourceAction.workerRole !== 'string' || sourceAction.workerRole === role.assignment.workerRole) {
        return { status: 'blocked', error: 'The named source action is not owned by a different role.' };
      }
      if (sourceAction.collaborationGroupId !== role.assignment.collaborationGroupId) {
        return { status: 'blocked', error: 'The named source action belongs to a different collaboration group.' };
      }
      const sourceObservation = sourceAction && parent.observations.find(item => item.actionId === sourceAction.actionId
        && item.taskId === sourceAction.taskId && item.outcome === 'success'
        && item.verification?.status === 'passed' && typeof item.verification?.verificationId === 'string'
        && item.verification.verificationId && typeof item.evidenceId === 'string' && item.evidenceId);
      const sourceArtifacts = sourceObservation?.artifacts?.filter(item => item.outsideAllowedRoots === false
        && Number.isInteger(item.rootIndex) && item.rootIndex >= 0 && item.rootIndex < canonicalRoots.length
        && typeof item.relativePath === 'string' && item.relativePath.length > 0
        && typeof item.contentSha256 === 'string' && /^[a-f0-9]{64}$/iu.test(item.contentSha256)) ?? [];
      if (!sourceObservation || sourceArtifacts.length === 0) {
        return { status: 'blocked', error: 'The source action lacks a task-bound G-verified artifact.' };
      }
      let sourceArtifact = null;
      for (const candidate of sourceArtifacts) {
        try {
          const artifactPath = await realpath(resolve(canonicalRoots[candidate.rootIndex], candidate.relativePath));
          if (isInside(canonicalRoots[candidate.rootIndex], artifactPath) && artifactPath === path) {
            sourceArtifact = candidate;
            break;
          }
        } catch { /* A missing sibling artifact must not hide the requested valid artifact. */ }
      }
      if (!sourceArtifact) {
        return { status: 'blocked', error: 'The requested path does not match the verified source artifact.' };
      }
      roleArtifactProof = { actionId: sourceAction.actionId, role: sourceAction.workerRole,
        contentSha256: sourceArtifact.contentSha256.toLowerCase(), verificationId: sourceObservation.verification.verificationId };
    }

    if (!currentParentAuthorized()) return { status: 'blocked', error: 'The Mission changed while resolving the role scope.' };
    if(!parentDataAuthorized(path))return {status:'blocked',error:'The parent Mission does not currently delegate this file read.'};
    const callKey = hash(`${request.sessionId}\n${request.turnId}\n${request.callId}`);
    const missionIdempotencyKey = `managed-agent-read:${callKey}`;
    const created = missionRuntime.createMission({
      objective: '관리형 에이전트가 요청한 텍스트 파일을 읽고, 실행 증거를 확인한다.',
      successCriteria: ['허용 경로의 텍스트 파일 읽기가 B 실행 결과와 G 검증으로 확인된다.'],
      budgets: { maxActions: 1, maxWaves: 1, maxPlannerCalls: 1, maxActiveRuntimeMs: 120_000 },
      authorization: { grants: [MissionGrant.READ_ONLY] },
      metadata: { managedAgentParentMissionId: parent.missionId, managedAgentCallKey: callKey,
        managedAgentReadScope:{goalBinding,executionMandateId,path} },
      idempotencyKey: missionIdempotencyKey
    });
    if (created?.success === false || typeof created?.missionId !== 'string') {
      return { status: 'blocked', error: 'JARVIS could not create the bounded read Mission.' };
    }
    const child = missionRuntime.missions.get(created.missionId);
    const pauseChildForEgress = reason => {
      if (!['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED'].includes(child?.status)) {
        child.status = MissionStatus.PAUSED; child.stopReason = reason;
        missionRuntime.touch(child, reason);
      }
    };
    if (!child || child.metadata?.managedAgentParentMissionId !== parent.missionId
      || child.metadata?.managedAgentCallKey !== callKey
      ||child.metadata?.managedAgentReadScope?.goalBinding!==goalBinding
      ||child.metadata?.managedAgentReadScope?.executionMandateId!==executionMandateId
      ||child.metadata?.managedAgentReadScope?.path!==path) {
      return { status: 'blocked', error: 'The persisted child Mission identity did not match this remote call.' };
    }
    if (child.waves.length === 0) {
      const wave = missionRuntime.createWave(child, {
        summary: '요청된 로컬 텍스트를 읽고 G 실행 증거를 확인합니다.',
        actions: [{
          id: 'managed_agent_read_text',
          title: '허용 경로 텍스트 읽기',
          command: `허용된 경로의 텍스트 파일을 읽는다: ${path}`,
          expectedToolName: 'filesystem.readText',
          arguments: { path, offset: args.offset ?? 0, maxChars: args.maxChars ?? 12_000 },
          dependencies: [],
          ...(role.assignment ?? {}),
          successSignal: 'filesystem.readText 실행과 G 검증이 통과한다.'
        }]
      });
      if (!wave) return { status: 'blocked', error: `JARVIS rejected the read plan (${child.stopReason ?? 'unknown'}).` };
    }
    const action = child.waves.flatMap(wave => wave.actions).find(item => item.localActionId === 'managed_agent_read_text');
    if (!action) return { status: 'blocked', error: 'The persisted read action is missing.' };
    if (action.status !== 'succeeded') {
      if (['failed', 'skipped'].includes(action.status)) return { status: 'blocked', error: 'JARVIS did not verify the requested local read.' };
      const wave = child.waves.find(item => item.actions.includes(action));
      await missionRuntime.executeWave(child, wave);
    }
    if (action.status !== 'succeeded') {
      if (!['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED'].includes(child.status)) {
        child.status = MissionStatus.PAUSED; child.stopReason = 'managed-agent-read-not-verified';
        missionRuntime.touch(child, 'managed-agent-read-not-verified');
      }
      return { status: 'blocked', error: 'JARVIS paused or rejected the local read before G verification.' };
    }

    const observation = child.observations.find(item => item.actionId === action.actionId && item.outcome === 'success');
    const task = missionRuntime.coreFacade.getTask(action.taskId);
    const verification = observation?.verification ?? task?.executionVerification;
    const evidenceId = observation?.evidenceId;
    const verificationId = verification?.verificationId;
    if (verification?.status !== 'passed' || typeof verificationId !== 'string' || !verificationId
      || typeof evidenceId !== 'string' || !evidenceId || task?.taskId !== action.taskId) {
      return { status: 'blocked', error: 'The local read lacks a task-bound G verification record.' };
    }
    const execution = task.executionResult?.executionResult ?? task.executionResult ?? {};
    const content = execution.stdoutPreview;
    if (typeof content !== 'string' || content.length > 12_000) {
      return { status: 'blocked', error: 'The verified text preview is missing or exceeds the egress limit.' };
    }
    if (roleArtifactProof && observation.data?.fileEvidence?.contentSha256 !== roleArtifactProof.contentSha256) {
      missionRuntime.recordEvent('mission.managed-agent.artifact-handoff-stale', parent, {
        callKey: hash(`${request.sessionId}\n${request.turnId}\n${request.callId}`),
        sourceActionId: roleArtifactProof.actionId,
        sourceVerificationId: roleArtifactProof.verificationId,
        expectedContentSha256: roleArtifactProof.contentSha256,
        observedContentSha256: observation.data?.fileEvidence?.contentSha256 ?? null,
        workerRole: role.assignment.workerRole,
        collaborationGroupId: role.assignment.collaborationGroupId
      });
      pauseChildForEgress('managed-agent-role-artifact-changed-after-verification');
      return { status: 'blocked', error: 'The source artifact changed after G verification; no content was sent externally.' };
    }

    if (!currentParentAuthorized()||!parentDataAuthorized(path)) {
      pauseChildForEgress('managed-agent-egress-parent-scope-changed');
      return { status: 'blocked', error: 'The Mission changed before external-transfer authorization.' };
    }
    let egress;
    let classification;
    try {
      classification = dataClassifier?.classify?.(content);
    } catch {
      classification = null;
    }
    const validClass = value => /^D[0-4]$/u.test(value ?? '');
    const validMinistryClass = value => value === undefined || /^M[0-4]$/u.test(value);
    if (!classification || typeof classification !== 'object' || typeof classification.then === 'function'
      || !validClass(classification.dataClass) || !validMinistryClass(classification.ministryDataClass)) {
      pauseChildForEgress('managed-agent-egress-classification-unavailable');
      missionRuntime.recordEvent('mission.managed-agent.egress-denied', parent, { callKey, childMissionId: child.missionId,
        reason: 'classification-unavailable' });
      return { status: 'blocked', error: 'Local data classification was unavailable; no content was sent externally.' };
    }
    const sensitivityRank = value => Number(value?.slice(1) ?? 0);
    if (Math.max(sensitivityRank(classification.dataClass), sensitivityRank(classification.ministryDataClass)) >= 3) {
      pauseChildForEgress('managed-agent-egress-sensitive-content-withheld');
      missionRuntime.recordEvent('mission.managed-agent.egress-denied', parent, { callKey, childMissionId: child.missionId,
        reason: 'sensitive-content-withheld', dataClass: classification.dataClass, ministryDataClass: classification.ministryDataClass ?? null });
      return { status: 'blocked', error: 'The content is classified as highly sensitive and was withheld from the external provider.' };
    }
    const redactions = [];
    const dataDecision=evaluateMissionDataPurpose({purpose:MANAGED_EVIDENCE_PURPOSE,contentKind:'LOCAL_FILE_CONTENT',classification});
    const minimizedContent = minimizeExternalText(content, dataClassifier, 'managedAgent.toolOutput', redactions, 'LOCAL_FILE_CONTENT', {purpose:MANAGED_EVIDENCE_PURPOSE});
    if (dataDecision.action==='withhold' || typeof minimizedContent !== 'string' || minimizedContent.startsWith('[LOCAL_FILE_CONTENT_WITHHELD:') || minimizedContent.startsWith('[DATA_PURPOSE_WITHHELD:')) {
      pauseChildForEgress('managed-agent-egress-minimization-failed');
      missionRuntime.recordEvent('mission.managed-agent.egress-denied', parent, { callKey, childMissionId: child.missionId,
        reason: 'minimization-failed' });
      return { status: 'blocked', error: 'The local content could not be minimized safely; nothing was sent externally.' };
    }
    try {
      egress = await authorizeEgress({
        purpose:MANAGED_EVIDENCE_PURPOSE,contentKind:'LOCAL_FILE_CONTENT',
        sourceDataRef:`file:${path}`,executionMandateId,
        providerId: PROVIDER_ID,
        toolName: TOOL_NAME,
        parentMissionId: parent.missionId,
        goalRevision: parent.goalContract?.revision ?? 1,
        goalBinding,
        argumentsSha256:request.argumentsSha256,
        childMissionId: child.missionId,
        taskId: task.taskId,
        callKey,
        sourcePath: path,
        content: minimizedContent,
        contentSha256: hash(content),
        contentToAuthorizeSha256: hash(minimizedContent),
        classification: { dataClass: classification.dataClass, ministryDataClass: classification.ministryDataClass ?? null,
          classifierVersion: classification.classifierVersion ?? 'unknown',sensitiveFlags:[...(classification.sensitiveFlags??[])] },
        redactions,
        untrusted: true,
        classificationRequired: true
      });
    } catch {
      pauseChildForEgress('managed-agent-egress-policy-unavailable');
      missionRuntime.recordEvent('mission.managed-agent.egress-denied', parent, { callKey, childMissionId: child.missionId, reason: 'policy-unavailable' });
      return { status: 'blocked', error: 'External data-transfer policy could not be evaluated.' };
    }
    if (egress?.status === 'pending_approval') {
      const gate = parent.gates.find(item => item.gateId === egress.gateId && item.type === 'external_data_egress'
        && item.callKey === callKey && item.childMissionId === child.missionId && item.providerId === PROVIDER_ID
        && item.toolName === TOOL_NAME && item.contentSha256 === hash(minimizedContent));
      if (!gate || gate.status !== 'pending' || Date.parse(gate.expiresAt ?? '') <= missionRuntime.clock().getTime()) {
        pauseChildForEgress('managed-agent-egress-gate-invalid');
        return { status: 'blocked', error: 'The external-transfer approval gate is missing or does not match this exact call.' };
      }
      pauseChildForEgress('managed-agent-egress-awaiting-user-approval');
      missionRuntime.recordEvent('mission.managed-agent.egress-approval-pending', parent, {
        callKey, childMissionId: child.missionId, gateId: gate.gateId, contentSha256: hash(minimizedContent)
      });
      return { status: 'pending_approval', gateId: gate.gateId };
    }
    const claims = egress?.authorization?.claims;
    const issuedAt = Date.parse(claims?.issuedAt ?? '');
    const expiresAt = Date.parse(claims?.expiresAt ?? '');
    const now = missionRuntime.clock().getTime();
    const approvalGate = parent.gates.find(item => item.type === 'external_data_egress' && item.callKey === callKey);
    const classificationRank = Math.max(sensitivityRank(classification.dataClass), sensitivityRank(classification.ministryDataClass));
    const policyAutoAuthorized = claims?.authorizationMode === 'policy-auto' && dataDecision.action==='retain' && classificationRank <= 1 && !approvalGate;
    const missionGateAuthorized = claims?.authorizationMode === 'mission-gate'
      && approvalGate?.status === 'approved' && approvalGate.gateId === claims.gateId
      && approvalGate.childMissionId === child.missionId && approvalGate.providerId === PROVIDER_ID
      && approvalGate.toolName === TOOL_NAME && approvalGate.contentSha256 === hash(minimizedContent)
      && approvalGate.decidedBy === claims.approvedBy && Date.parse(approvalGate.expiresAt ?? '') > now;
    let authorizationVerified = false;
    try { authorizationVerified = await verifyEgressDecision(egress?.authorization) === true; } catch { authorizationVerified = false; }
    const authorizationBound = claims?.decision === 'allow'
      && claims?.decisionId === egress?.decisionId
      && claims?.missionId === parent.missionId
      && claims?.callKey === callKey
      && claims?.providerId === PROVIDER_ID
      && claims?.toolName === TOOL_NAME
      && claims?.purpose===MANAGED_EVIDENCE_PURPOSE && claims?.contentKind==='LOCAL_FILE_CONTENT'
      && claims?.dataPolicyVersion===DATA_PURPOSE_POLICY_VERSION
      && claims?.contentSha256 === hash(minimizedContent)
      && claims?.sourceDataRef===`file:${path}`
      && claims?.executionMandateId===executionMandateId
      && claims?.use === 'single-call'
      && typeof claims?.approvedBy === 'string' && claims.approvedBy.trim().length > 0
      && typeof claims?.policyVersion === 'string' && claims.policyVersion.trim().length > 0
      && (policyAutoAuthorized || missionGateAuthorized)
      && Number.isFinite(issuedAt) && Number.isFinite(expiresAt)
      && issuedAt <= now + 30_000 && expiresAt > now && expiresAt > issuedAt
      && expiresAt - issuedAt <= 300_000;
    if (!currentParentAuthorized() || !parentDataAuthorized(path) || egress?.status !== 'authorized' || typeof egress.decisionId !== 'string' || !egress.decisionId.trim()
      || egress.content !== minimizedContent || !authorizationVerified || !authorizationBound) {
      pauseChildForEgress('managed-agent-egress-denied');
      missionRuntime.recordEvent('mission.managed-agent.egress-denied', parent, { callKey, childMissionId: child.missionId,
        decisionId: typeof egress?.decisionId === 'string' ? egress.decisionId : null,
        reason: !currentParentAuthorized() ? 'parent-scope-changed' : egress?.status !== 'authorized' ? 'not-authorized'
          : egress.content !== minimizedContent ? 'authorized-content-mismatch'
            : !authorizationVerified ? 'decision-signature-invalid' : 'decision-scope-invalid' });
      return { status: 'blocked', error: 'External data transfer authorization was invalid, expired, or outside this exact Mission/tool/content scope.' };
    }

    child.status = MissionStatus.PAUSED;
    child.stopReason = 'managed-agent-read-action-verified';
    missionRuntime.touch(child, 'managed-agent-read-action-verified');
    missionRuntime.recordEvent('mission.managed-agent.read-egress-authorized', child, {
      parentMissionId: parent.missionId, taskId: task.taskId, egressDecisionId: egress.decisionId,
      contentSha256: hash(egress.content), providerId: PROVIDER_ID
    });
    missionRuntime.touch(parent, 'managed-agent-tool-verified-dispatch');
    missionRuntime.recordEvent('mission.managed-agent.tool-verified-dispatch', parent, {
      callKey, childMissionId: child.missionId, taskId: task.taskId,
      verificationId, evidenceId, egressDecisionId: egress.decisionId,
      outputSha256: hash(egress.content), providerId: PROVIDER_ID
    });
    const output = JSON.stringify({ trustBoundary: 'LOCAL_FILE_CONTENT', untrusted: true,
      content: egress.content, contentSha256: hash(egress.content) });
    return {
      status: 'verified', output,
      egressAuthorization:egress.authorization,
      verification: { status: 'passed', verificationId,
        evidenceRef: `g:managed-agent:${hash(JSON.stringify({ missionId: child.missionId, taskId: task.taskId,
          verificationId, evidenceId, egressDecisionId: egress.decisionId }))}` }
    };
  };
  dispatchVerifiedTool.validateToolResult=async request=>{
    const parent=missionRuntime.missions.get(request.missionId),envelope=request.result?.egressAuthorization,claims=envelope?.claims;
    let output;
    try{output=JSON.parse(request.result.output);}catch{return {authorized:false};}
    if(!parent || !claims || output?.untrusted!==true || output.trustBoundary!=='LOCAL_FILE_CONTENT'
      || Object.keys(output).some(k=>!['untrusted','trustBoundary','content','contentSha256'].includes(k))
      || typeof output.content!=='string' || hash(output.content)!==claims.contentSha256 || output.contentSha256!==claims.contentSha256
      || claims.argumentsSha256!==request.argumentsSha256 || claims.missionId!==request.missionId
      || claims.callKey!==hash(`${request.sessionId}\n${request.turnId}\n${request.callId}`)
      || claims.providerId!==PROVIDER_ID || claims.toolName!==TOOL_NAME
      || claims.purpose!==MANAGED_EVIDENCE_PURPOSE || claims.contentKind!=='LOCAL_FILE_CONTENT'
      || claims.dataPolicyVersion!==DATA_PURPOSE_POLICY_VERSION) return {authorized:false};
    const approvalCurrent=()=>{
      const gate=parent.gates.find(g=>g.type==='external_data_egress' && g.callKey===claims.callKey);
      if(claims.authorizationMode==='policy-auto') return !gate;
      return claims.authorizationMode==='mission-gate' && gate?.status==='approved' && gate.gateId===claims.gateId
        && gate.goalRevision===claims.goalRevision && gate.childMissionId===claims.childMissionId
        && gate.providerId===PROVIDER_ID && gate.toolName===TOOL_NAME && gate.contentSha256===claims.contentSha256
        && gate.decidedBy===claims.approvedBy && Number.isFinite(Date.parse(gate.expiresAt))
        && Date.parse(gate.expiresAt)>missionRuntime.clock().getTime();
    };
    const commitCheck=()=>missionRuntime.missions.get(request.missionId)===parent
      && ![MissionStatus.COMPLETED,MissionStatus.CANCELLED,MissionStatus.FAILED,MissionStatus.BLOCKED].includes(parent.status)
      && parent.authorization?.grants?.includes(MissionGrant.READ_ONLY)===true
      && claims.goalRevision===(parent.goalContract?.revision??1)
      && claims.goalBinding===missionEgressGoalBinding(parent)
      && Number.isFinite(Date.parse(claims.expiresAt)) && Date.parse(claims.expiresAt)>missionRuntime.clock().getTime()
      && approvalCurrent()
      && parentDataScopeCurrent()
      && (egressPolicy ? egressPolicy.verify(envelope)===true : true);
    function parentDataScopeCurrent(){
      if((parent.executionMandateId??null)!==(claims.executionMandateId??null))return false;
      if(!parent.executionMandateId)return true;
      if(typeof claims.sourceDataRef!=='string'||!claims.sourceDataRef.startsWith('file:'))return false;
      try{
        const guard=missionRuntime.resultReadGuard?.(parent);
        if(typeof guard!=='function')return false;
        guard({path:claims.sourceDataRef.slice(5),kind:'read'});return true;
      }catch{return false;}
    }
    let verified=false;try{verified=await verifyEgressDecision(envelope)===true;}catch{}
    return {authorized:verified && commitCheck(),commitCheck};
  };
  return dispatchVerifiedTool;
}

export const MANAGED_AGENT_MISSION_TOOLS = Object.freeze([TOOL_NAME]);
