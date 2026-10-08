import { createHash, randomUUID } from 'node:crypto';
import { MissionGrant, MissionStatus } from './mission-runtime.js';
import {missionEgressGoalBinding} from './mission-egress-goal-binding.js';
import {evaluateMissionDataPurpose, DATA_PURPOSE_POLICY_VERSION, MANAGED_EVIDENCE_PURPOSE} from '../security/data-purpose-policy.js';

export const MISSION_EGRESS_POLICY_VERSION = 'jarvis-mission-egress-policy-v2';
const PROVIDER_ID = 'openai-agents-api';
const TOOL_NAME = 'jarvis.mission.read_text';
const hash = value => createHash('sha256').update(value).digest('hex');
const rank = value => /^[DM][0-4]$/u.test(value ?? '') ? Number(value[1]) : null;
const terminal = new Set([MissionStatus.COMPLETED, MissionStatus.CANCELLED, MissionStatus.FAILED, MissionStatus.BLOCKED]);

/**
 * Local deterministic egress policy for the narrow managed-agent read tool.
 * It is deliberately opt-in: callers must provision the OS-protected signer
 * before wiring these callbacks into a managed session broker.
 */
export function createMissionEgressAuthorizationPolicy({ missionRuntime, keyStore, providerId = PROVIDER_ID,
  toolName = TOOL_NAME, policyVersion = MISSION_EGRESS_POLICY_VERSION, decisionId = randomUUID } = {}) {
  if (!missionRuntime?.missions?.get || typeof missionRuntime.createExternalEgressGate !== 'function'
    || !keyStore || typeof keyStore.signDecision !== 'function' || typeof keyStore.verifyDecision !== 'function') {
    throw new Error('A_MISSION_EGRESS_POLICY_DEPENDENCIES_REQUIRED');
  }
  if (!providerId || !toolName || !policyVersion || typeof decisionId !== 'function') throw new Error('A_MISSION_EGRESS_POLICY_CONFIGURATION_INVALID');

  const authorize = async request => {
    if (request?.providerId !== providerId || request?.toolName !== toolName || request?.untrusted !== true
      || request?.classificationRequired !== true || typeof request?.content !== 'string'
      || !request.content.trim() || request.content.length > 120_000 || hash(request.content) !== request.contentToAuthorizeSha256) {
      return denied('request-scope-invalid');
    }
    const dataRank = rank(request.classification?.dataClass), ministryRank = rank(request.classification?.ministryDataClass ?? 'M0');
    if (dataRank === null || ministryRank === null || !request.classification?.classifierVersion) return denied('classification-invalid');
    if(request.purpose!==MANAGED_EVIDENCE_PURPOSE || request.contentKind!=='LOCAL_FILE_CONTENT')return denied('data-purpose-not-permitted');
    const dataDecision=evaluateMissionDataPurpose(request);
    if(dataDecision.action==='withhold')return denied(dataDecision.reason);
    const sensitivity = Math.max(dataRank, ministryRank);
    if (sensitivity >= 3) return denied('sensitive-content-withheld');
    const mission = missionRuntime.missions.get(request.parentMissionId);
    if (!mission || terminal.has(mission.status)) return denied('mission-unavailable');
    if (!mission.authorization?.grants?.includes(MissionGrant.READ_ONLY)) return denied('mission-read-grant-missing');
    const goalRevision = mission.goalContract?.revision ?? 1;
    const goalBinding = missionEgressGoalBinding(mission);
    if (request.goalRevision !== undefined && request.goalRevision !== goalRevision
      || request.goalBinding !== undefined && request.goalBinding !== goalBinding) return denied('mission-goal-changed');
    const now = missionRuntime.clock().getTime();
    const nowIso = new Date(now).toISOString();
    const existing = mission.gates.find(gate => gate.type === 'external_data_egress' && gate.callKey === request.callKey);
    if (existing && (existing.childMissionId !== request.childMissionId || existing.providerId !== providerId
      || existing.toolName !== toolName || existing.contentSha256 !== request.contentToAuthorizeSha256)) return denied('gate-scope-mismatch');

    let authorizationMode = 'policy-auto', gateId = null, approvedBy = `policy:${policyVersion}`;
    if (dataDecision.action==='mask' || existing) {
      let gate = existing;
      if (!gate) {
        const created = missionRuntime.createExternalEgressGate(mission, { childMissionId: request.childMissionId,
          callKey: request.callKey, providerId, toolName, contentSha256: request.contentToAuthorizeSha256,
          dataClass: request.classification.dataClass, ministryDataClass: request.classification.ministryDataClass ?? null });
        if (created?.success !== true) return denied('gate-creation-failed');
        gate = mission.gates.find(item => item.gateId === created.gateId);
      }
      if (!gate || gate.status === 'pending') return { status: 'pending_approval', gateId: gate?.gateId ?? null };
      if (gate.status !== 'approved' || gate.missionId !== mission.missionId
        || gate.goalRevision !== (mission.goalContract?.revision ?? 1) || gate.decidedBy == null
        || !Number.isFinite(Date.parse(gate.expiresAt ?? '')) || Date.parse(gate.expiresAt) <= now) return denied('gate-not-authorized');
      authorizationMode = 'mission-gate'; gateId = gate.gateId; approvedBy = gate.decidedBy;
    }

    const issuedAt = nowIso, expiresAt = new Date(now + 5 * 60_000).toISOString();
    const claims = { decision: 'allow', decisionId: decisionId(), missionId: mission.missionId, callKey: request.callKey,
      childMissionId: request.childMissionId, goalRevision, goalBinding,
      ...(request.argumentsSha256 ? {argumentsSha256:request.argumentsSha256} : {}),
      ...(request.sourceDataRef ? {sourceDataRef:request.sourceDataRef} : {}),
      executionMandateId:mission.executionMandateId??null,
      providerId, toolName, contentSha256: request.contentToAuthorizeSha256, use: 'single-call',
      purpose:MANAGED_EVIDENCE_PURPOSE,contentKind:'LOCAL_FILE_CONTENT',dataPolicyVersion:DATA_PURPOSE_POLICY_VERSION,
      authorizationMode, gateId, approvedBy, policyVersion, issuedAt, expiresAt,
      classification: { dataClass: request.classification.dataClass,
        ministryDataClass: request.classification.ministryDataClass ?? null,
        classifierVersion: request.classification.classifierVersion,
        sensitiveFlags:[...(request.classification.sensitiveFlags??[])] } };
    try {
      return { status: 'authorized', decisionId: claims.decisionId, content: request.content,
        authorization: keyStore.signDecision(claims) };
    } catch { return denied('signing-unavailable'); }
  };

  return Object.freeze({ authorize, verify: envelope => {
    if (keyStore.verifyDecision(envelope) !== true) return false;
    const claims = envelope.claims, mission = missionRuntime.missions.get(claims.missionId);
    if(claims.purpose!==MANAGED_EVIDENCE_PURPOSE || claims.contentKind!=='LOCAL_FILE_CONTENT'
      || claims.dataPolicyVersion!==DATA_PURPOSE_POLICY_VERSION)return false;
    const dataDecision=evaluateMissionDataPurpose(claims);
    if(dataDecision.action==='withhold')return false;
    const now = missionRuntime.clock().getTime();
    if (!mission || terminal.has(mission.status) || !mission.authorization?.grants?.includes(MissionGrant.READ_ONLY)
      || claims.providerId !== providerId || claims.toolName !== toolName
      || claims.policyVersion !== policyVersion || claims.goalRevision !== (mission.goalContract?.revision ?? 1)
      || claims.goalBinding !== missionEgressGoalBinding(mission)
      || Date.parse(claims.expiresAt) <= now || !Number.isFinite(Date.parse(claims.expiresAt))) return false;
    if (claims.authorizationMode === 'policy-auto') return dataDecision.action==='retain' && !mission.gates.some(g => g.type === 'external_data_egress' && g.callKey === claims.callKey);
    const gate = mission.gates.find(g => g.gateId === claims.gateId && g.type === 'external_data_egress');
    return gate?.status === 'approved' && gate.goalRevision === claims.goalRevision && gate.callKey === claims.callKey
      && gate.childMissionId === claims.childMissionId && gate.providerId === providerId && gate.toolName === toolName
      && gate.contentSha256 === claims.contentSha256 && gate.decidedBy === claims.approvedBy
      && Number.isFinite(Date.parse(gate.expiresAt)) && Date.parse(gate.expiresAt) > now;
  },
    status: ({ managedSessionConfigured = false } = {}) => ({ policyVersion, providerId, toolName,
      signer: keyStore.status?.() ?? { configured: 'unknown' }, liveProviderConfigured: false,
      managedSessionConfigured: managedSessionConfigured === true, externalTransferEnabled: false }),
    initializeKey: options => {
      if (typeof keyStore.initialize !== 'function') throw new Error('A_MISSION_EGRESS_KEY_INITIALIZATION_UNAVAILABLE');
      return keyStore.initialize(options);
    },
    rotateKey: options => {
      if (typeof keyStore.rotate !== 'function') throw new Error('A_MISSION_EGRESS_KEY_ROTATION_UNAVAILABLE');
      return keyStore.rotate(options);
    },
    recoverUnreadableKey: options => {
      if (typeof keyStore.recoverUnreadable !== 'function') throw new Error('A_MISSION_EGRESS_KEY_RECOVERY_UNAVAILABLE');
      return keyStore.recoverUnreadable(options);
    } });
}

function denied(reason) { return { status: 'denied', reason }; }
