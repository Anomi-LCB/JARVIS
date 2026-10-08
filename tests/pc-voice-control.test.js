import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { BridgeRequestValidator } from '../apps/bridge/src/request-validator.js';
import {
  createPcVoiceDecisionPrompt,
  evaluatePcVoiceDecision,
  normalizePcVoicePhrase
} from '../src/domain/pc-voice-control.js';
import { TaskStatus } from '../packages/shared/src/types.js';

test('PC voice confirmation accepts only the exact challenge phrase and stores no transcript', () => {
  const handoff = voiceHandoff();
  const prompt = createPcVoiceDecisionPrompt(handoff);
  const accepted = evaluatePcVoiceDecision({
    transcript: `  자비스, ${prompt.phrase}! 승인. `,
    confidence: 0.93,
    handoff,
    nowMs: Date.parse('2026-08-16T12:00:30.000Z')
  });

  assert.equal(normalizePcVoicePhrase(' 자비스, 청록  파동! 승인 '), '자비스 청록 파동 승인');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.decision, 'approve');
  assert.equal(accepted.proof.challengeResponse, '청록 파동');
  assert.equal(accepted.proof.transcriptStored, false);
  assert.equal(accepted.proof.rawAudioStored, false);
  assert.equal(Object.hasOwn(accepted.proof, 'transcript'), false);

  const partial = evaluatePcVoiceDecision({
    transcript: '승인',
    confidence: 0.99,
    handoff,
    nowMs: Date.parse('2026-08-16T12:00:30.000Z')
  });
  assert.equal(partial.accepted, false);
  assert.equal(partial.reason, 'exact-phrase-required');
});

test('PC voice confirmation requires an exact repeat when recognition confidence is low or missing', () => {
  const handoff = voiceHandoff();
  const first = evaluatePcVoiceDecision({
    transcript: '자비스 청록 파동 승인',
    confidence: 0.2,
    handoff,
    nowMs: 1_000
  });
  assert.equal(first.needsRepeat, true);
  assert.equal(first.candidate.count, 1);

  const second = evaluatePcVoiceDecision({
    transcript: '자비스 청록 파동 승인',
    confidence: null,
    handoff,
    previousCandidate: first.candidate,
    nowMs: 2_000
  });
  assert.equal(second.accepted, true);
  assert.equal(second.proof.confirmationCount, 2);
  assert.equal(second.proof.confidence, null);
});

test('D Bridge request validation requires decision-bound private PC voice proof', () => {
  const validator = new BridgeRequestValidator();
  const valid = validator.validate('pc_console.handoff.decision', {
    decision: 'approve',
    voiceProof: {
      mode: 'pc-voice-challenge',
      challengeId: 'challenge_001',
      challengeResponse: '청록 파동',
      spokenDecision: 'approve',
      confidence: 0.9,
      confirmationCount: 1,
      transcriptStored: false,
      rawAudioStored: false
    }
  });
  assert.equal(valid.success, true);

  const missingPrivacy = validator.validate('pc_console.handoff.decision', {
    decision: 'approve',
    voiceProof: {
      mode: 'pc-voice-challenge',
      challengeId: 'challenge_001',
      challengeResponse: '청록 파동',
      spokenDecision: 'approve',
      confidence: 0.9,
      confirmationCount: 1
    }
  });
  assert.equal(missingPrivacy.success, false);
  assert.equal(missingPrivacy.validation.issues.some((item) => item.path === 'voiceProof.transcriptStored'), true);
});

test('D Bridge keeps high-risk PC voice approval local, expiring, private, and single-use', () => {
  let now = new Date('2026-08-16T12:00:00.000Z');
  const { bridgeRuntime, coreFacade } = createAgRuntime({ clock: () => now, env: {} });
  const pairing = bridgeRuntime.pairing.start();
  const paired = bridgeRuntime.pairing.confirm({
    deviceId: 'pc_voice_phone',
    deviceName: 'PC Voice Test Phone',
    pairingCode: pairing.pairingCode
  });
  const created = bridgeRuntime.createTask({
    rawText: '파워셸 명령으로 현재 날짜와 시간을 조회해줘',
    token: paired.deviceToken
  });
  const task = coreFacade.getTask(created.taskId);
  task.approvalCard.riskTier = 3;
  const approval = bridgeRuntime.listApprovals({ token: paired.deviceToken }).items
    .find((item) => item.taskId === created.taskId);
  const requested = bridgeRuntime.requestPcConfirmation({
    approvalId: approval.approvalId,
    token: paired.deviceToken,
    reason: 'pc_voice_contract_test'
  });
  assert.equal(requested.success, true);
  assert.match(requested.voiceChallenge.phrase, /^[가-힣]+ [가-힣]+$/);
  const duplicate = bridgeRuntime.requestPcConfirmation({
    approvalId: approval.approvalId,
    token: paired.deviceToken,
    reason: 'pc_voice_contract_duplicate'
  });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.handoffId, requested.handoffId);
  assert.equal(duplicate.voiceChallenge.challengeId, requested.voiceChallenge.challengeId);

  const remoteList = bridgeRuntime.listPcConfirmationHandoffs({
    token: paired.deviceToken,
    requestContext: { remoteAddress: '192.168.0.25' }
  });
  assert.equal(remoteList.error.code, 'D_PC_CONSOLE_LOCAL_ONLY');

  const invalid = bridgeRuntime.decidePcConfirmationHandoff({
    handoffId: requested.handoffId,
    token: paired.deviceToken,
    decision: 'approve',
    operatorId: 'pc-voice-test',
    voiceProof: voiceProof(requested, { challengeResponse: '잘못된 문구' })
  });
  assert.equal(invalid.error.code, 'D_PC_VOICE_PROOF_INVALID');
  assert.equal(invalid.attemptsRemaining, 2);

  const decisionSwap = bridgeRuntime.decidePcConfirmationHandoff({
    handoffId: requested.handoffId,
    token: paired.deviceToken,
    decision: 'approve',
    operatorId: 'pc-voice-test',
    voiceProof: voiceProof(requested, { spokenDecision: 'reject' })
  });
  assert.equal(decisionSwap.error.code, 'D_PC_VOICE_PROOF_INVALID');
  assert.equal(decisionSwap.attemptsRemaining, 1);

  const accepted = bridgeRuntime.decidePcConfirmationHandoff({
    handoffId: requested.handoffId,
    token: paired.deviceToken,
    decision: 'approve',
    operatorId: 'pc-voice-test',
    voiceProof: voiceProof(requested)
  });
  assert.equal(accepted.success, true);
  assert.equal(accepted.taskStatus, TaskStatus.APPROVED);
  assert.ok(accepted.executionHandoffId);
  assert.equal(accepted.handoff.voiceConfirmation.transcriptStored, false);
  assert.equal(accepted.handoff.voiceConfirmation.rawAudioStored, false);
  assert.equal(accepted.handoff.voiceChallenge.consumedAt, now.toISOString());

  const replay = bridgeRuntime.decidePcConfirmationHandoff({
    handoffId: requested.handoffId,
    token: paired.deviceToken,
    decision: 'approve',
    operatorId: 'pc-voice-test',
    voiceProof: voiceProof(requested)
  });
  assert.equal(replay.error.code, 'D_PC_HANDOFF_ALREADY_DECIDED');

  now = new Date('2026-08-16T12:03:00.000Z');
});

function voiceHandoff() {
  return {
    handoffId: 'pc_handoff_voice_001',
    voiceChallenge: {
      challengeId: 'pc_voice_challenge_001',
      phrase: '청록 파동',
      expiresAt: '2026-08-16T12:02:00.000Z',
      attemptsRemaining: 3
    }
  };
}

function voiceProof(requested, overrides = {}) {
  return {
    mode: 'pc-voice-challenge',
    challengeId: requested.voiceChallenge.challengeId,
    challengeResponse: requested.voiceChallenge.phrase,
    spokenDecision: 'approve',
    confidence: 0.94,
    confirmationCount: 1,
    engine: 'browser-speech-recognition',
    transcriptStored: false,
    rawAudioStored: false,
    ...overrides
  };
}
