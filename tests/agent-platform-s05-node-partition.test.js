import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluateS05NodePartitionEvidence } from '../scripts/agent-platform-independent-oracle.mjs';

const publicText = 'Synthetic public research result: source checked and summarized.';
const finalText = `${publicText}\nVerified on the user PC after reconnection.`;
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function validEvidence() {
  return { schemaVersion: 1, scenarioId: 'S05', fixtureId: 's05-two-runtime-node-pc-offline-rejoin-v1',
    expected: { finalText },
    processBoundary: { separateProductProcesses: true, nodeProcessPid: 102, pcResumeProcessPid: 205,
      processRestartBetweenPhases: true, nodeProcessStoppedBeforePcResume: true },
    phases: { node: { missionStatusAfterRun: 'PAUSED', pcWasOffline: true, pcFileCreated: false,
      executedActions: 1, blockedActionAttemptCount: 0, blockedReason: ['device-offline'] },
      pcResume: { missionStatus: 'COMPLETED', completionStatus: 'verified', pcOnlineProbe: true, pcActionExecutions: 1 } },
    actions: { publicResearch: { status: 'succeeded', attempts: 1, verificationStatus: 'passed', outcome: 'success' },
      pcSummary: { status: 'succeeded', attempts: 1, verificationStatus: 'passed', outcome: 'success' } },
    artifacts: { node: { relativePath: 'always-on-node/public-research.txt', text: publicText,
      byteLength: Buffer.byteLength(publicText), sha256: sha(publicText) },
      pc: { relativePath: 'user-pc/summary.txt', text: finalText, byteLength: Buffer.byteLength(finalText), sha256: sha(finalText) } },
    sideEffects: { providerCalls: 0, networkRequests: 0, externalWrites: 0, syntheticAvailabilityProbes: true },
    mission: { status: 'COMPLETED', completionStatus: 'verified' },
    limitations: { sharedHostFilesystem: true, physicalCrossDeviceDeploymentVerified: false, remoteServiceIdentityVerified: false } };
}

test('S05 oracle accepts only a paused offline PC followed by verified same-Mission resume evidence', () => {
  assert.equal(evaluateS05NodePartitionEvidence(validEvidence()).status, 'passed');
});

test('S05 oracle rejects false completion, offline side effects, tampered artifacts, and physical deployment overclaims', () => {
  const invalidCases = [
    evidence => { evidence.phases.node.pcFileCreated = true; },
    evidence => { evidence.phases.pcResume.missionStatus = 'BLOCKED'; },
    evidence => { evidence.artifacts.pc.text = 'tampered'; },
    evidence => { evidence.processBoundary.pcResumeProcessPid = evidence.processBoundary.nodeProcessPid; },
    evidence => { evidence.limitations.physicalCrossDeviceDeploymentVerified = true; },
    evidence => { evidence.sideEffects.networkRequests = 1; }
  ];
  for (const mutate of invalidCases) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.equal(evaluateS05NodePartitionEvidence(evidence).status, 'failed');
  }
});
