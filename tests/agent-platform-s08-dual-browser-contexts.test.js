import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHandoffManager } from '../apps/pc-agent/src/browser-handoff-manager.js';
import { evaluateS08DualBrowserEvidence } from '../scripts/agent-platform-independent-oracle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(root, 'packages/core/fixtures/s08-dual-browser-contexts.json'), 'utf8'));
const binding = value => createHash('sha256').update(value).digest('hex');

test('S08 binds sessions to isolated browser context, environment, and account hint through handoff', async () => {
  const clickLog = { personal: [], remote: [] };
  let remoteUrl = `${fixture.origin}/inbox`;
  const manager = new BrowserHandoffManager({
    confirmOwner: async ({ handoffId, confirmationToken }) => handoffId.length > 0 && confirmationToken.length > 0,
    reauthorize: async ({ origin }) => origin === fixture.origin
  });
  const personal = manager.register({ ...fixture.contexts[0], accountBindingHash: binding('account-a'), allowedOrigins: [fixture.origin],
    driver: { contextId: fixture.contexts[0].contextId, currentUrl: async () => `${fixture.origin}/inbox`,
      click: async ({ selector }) => clickLog.personal.push(selector) } });
  const remote = manager.register({ ...fixture.contexts[1], accountBindingHash: binding('account-b'), allowedOrigins: [fixture.origin],
    driver: { contextId: fixture.contexts[1].contextId, currentUrl: async () => remoteUrl,
      click: async ({ selector }) => clickLog.remote.push(selector) } });
  assert.throws(() => manager.register({ sessionId: 'duplicate-context-session', environmentId: 'remote',
    contextId: fixture.contexts[0].contextId, allowedOrigins: [fixture.origin], driver: { currentUrl: async () => fixture.origin, click: async () => {} } }),
  { code: 'B_BROWSER_CONTEXT_SHARED' });

  const wrongEnvironment = await manager.dispatch({ sessionId: remote.sessionId, ticket: remote.ticket,
    expectedEnvironmentId: 'personal', expectedAccountBindingHash: binding('account-b'), action: { type: 'click', selector: '#compose' } });
  const wrongAccount = await manager.dispatch({ sessionId: remote.sessionId, ticket: remote.ticket,
    expectedEnvironmentId: 'remote', expectedAccountBindingHash: binding('account-a'), action: { type: 'click', selector: '#compose' } });
  const noMismatch = await manager.dispatch({ sessionId: remote.sessionId, ticket: remote.ticket,
    expectedEnvironmentId: 'remote', expectedAccountBindingHash: binding('account-b'), action: { type: 'click', selector: '#compose' } });
  const personalAction = await manager.dispatch({ sessionId: personal.sessionId, ticket: personal.ticket,
    expectedEnvironmentId: 'personal', expectedAccountBindingHash: binding('account-a'), action: { type: 'click', selector: '#search' } });
  const handoff = manager.beginHandoff({ sessionId: remote.sessionId });
  const paused = await manager.dispatch({ sessionId: remote.sessionId, ticket: remote.ticket,
    expectedEnvironmentId: 'remote', expectedAccountBindingHash: binding('account-b'), action: { type: 'click', selector: '#send' } });
  remoteUrl = `${fixture.origin}/inbox`;
  const resumed = await manager.completeHandoff({ sessionId: remote.sessionId, handoffId: handoff.handoffId,
    confirmationToken: handoff.confirmationToken });

  assert.equal(wrongEnvironment.code, 'B_BROWSER_SESSION_BINDING_MISMATCH');
  assert.equal(wrongAccount.code, 'B_BROWSER_SESSION_BINDING_MISMATCH');
  assert.equal(noMismatch.status, 'completed');
  assert.equal(personalAction.status, 'completed');
  assert.deepEqual(clickLog.personal, ['#search']);
  assert.deepEqual(clickLog.remote, ['#compose']);
  assert.equal(paused.code, 'B_BROWSER_AUTOMATION_PAUSED_FOR_HUMAN');
  assert.equal(resumed.automationPaused, false);
  assert.equal(manager.status(personal.sessionId).contextBindingHash === manager.status(remote.sessionId).contextBindingHash, false);

  const evidence = { schemaVersion: 1, scenarioId: 'S08', fixtureId: fixture.fixtureId,
    origin: fixture.origin, contextStatuses: [manager.status(personal.sessionId), manager.status(remote.sessionId)],
    duplicateContextRejected: true, wrongEnvironmentCode: wrongEnvironment.code, wrongAccountCode: wrongAccount.code,
    wrongBindingDispatches: 0, clicks: clickLog, pausedHandoffCode: paused.code,
    resumed: { status: resumed.status, environmentId: resumed.environmentId ?? manager.status(remote.sessionId).environmentId,
      accountBindingHash: resumed.accountBindingHash ?? manager.status(remote.sessionId).accountBindingHash,
      automationPaused: resumed.automationPaused },
    credentialValuesExposed: [...manager.auditLog()].some(entry => /\baccount-a\b|\baccount-b\b|confirmationToken|password|otp/iu.test(JSON.stringify(entry))),
    networkRequests: 0, externalWrites: 0, providerCalls: 0, liveBrowserUsed: false };
  assert.equal(evaluateS08DualBrowserEvidence(evidence).status, 'passed', JSON.stringify(evaluateS08DualBrowserEvidence(evidence).checks));
  assert.equal(evaluateS08DualBrowserEvidence({ ...evidence, wrongAccountCode: null }).checks
    .find(item => item.id === 'wrong_environment_and_account_are_blocked_before_actions')?.status, 'failed');
  const evidencePath = process.env.JARVIS_S08_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});
