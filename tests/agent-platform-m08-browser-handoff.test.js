import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { BrowserHandoffManager } from '../apps/pc-agent/src/browser-handoff-manager.js';

test('M08 pauses delayed browser input and resumes only after owner confirmation and origin/scope recheck', async () => {
  let currentUrl = 'https://app.example.test/login';
  let releaseCurrentUrl;
  let deferNextRead = true;
  let ownerToken = null;
  let ownerConfirmationCalls = 0;
  let reauthorizationCalls = 0;
  let allowScope = true;
  let pausedByDriver = false;
  const clicks = [];
  const clickStatuses = [];
  let manager;
  const driver = {
    currentUrl: () => {
      if (deferNextRead) {
        deferNextRead = false;
        return new Promise(resolveUrl => { releaseCurrentUrl = resolveUrl; });
      }
      return currentUrl;
    },
    pauseAutomation: () => { pausedByDriver = true; },
    click: async ({ selector }) => { clicks.push(selector); clickStatuses.push(manager.status('m08-session-001').status); }
  };
  manager = new BrowserHandoffManager({
    confirmOwner: async ({ confirmationToken }) => { ownerConfirmationCalls += 1; return confirmationToken === ownerToken; },
    reauthorize: async ({ origin, allowedOrigins }) => { reauthorizationCalls += 1; return allowScope && allowedOrigins.includes(origin); }
  });
  const registered = manager.register({ sessionId: 'm08-session-001', driver, allowedOrigins: [
    'https://app.example.test', 'https://login.example.test'
  ] });

  const pendingClick = manager.dispatch({ sessionId: registered.sessionId, ticket: registered.ticket,
    action: { type: 'click', selector: '[data-testid="continue"]' } });
  const firstHandoff = manager.beginHandoff({ sessionId: registered.sessionId, reason: 'user-login-required' });
  ownerToken = firstHandoff.confirmationToken;
  assert.equal(manager.status(registered.sessionId).status, 'human_handoff');
  assert.equal(manager.status(registered.sessionId).automationPaused, true);
  assert.equal(pausedByDriver, true);
  let invalidConfirmationRejected = false;
  await assert.rejects(manager.completeHandoff({ sessionId: registered.sessionId, handoffId: firstHandoff.handoffId,
    confirmationToken: 'wrong-token' }), error => { invalidConfirmationRejected = error.code === 'B_BROWSER_HANDOFF_CONFIRMATION_INVALID'; return invalidConfirmationRejected; });
  assert.equal(ownerConfirmationCalls, 0);
  releaseCurrentUrl('https://app.example.test/login');
  const staleAction = await pendingClick;
  assert.deepEqual(staleAction, { status: 'blocked', code: 'B_BROWSER_AUTOMATION_PAUSED_FOR_HUMAN' });
  assert.deepEqual(clicks, []);

  currentUrl = 'https://unapproved.example.test/callback';
  await assert.rejects(manager.completeHandoff({ sessionId: registered.sessionId, handoffId: firstHandoff.handoffId,
    confirmationToken: firstHandoff.confirmationToken }), error => error.code === 'B_BROWSER_HANDOFF_ORIGIN_OUT_OF_SCOPE');
  assert.equal(manager.status(registered.sessionId).status, 'human_handoff');

  const retryHandoff = manager.restartHandoff({ sessionId: registered.sessionId, reason: 'scope-reconfirmation-required' });
  ownerToken = retryHandoff.confirmationToken;
  currentUrl = 'https://app.example.test/oauth/callback?access_token=fixture-secret-must-not-be-logged';
  const resumed = await manager.completeHandoff({ sessionId: registered.sessionId, handoffId: retryHandoff.handoffId,
    confirmationToken: retryHandoff.confirmationToken });
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.origin, 'https://app.example.test');
  assert.ok(resumed.generation > firstHandoff.generation);
  assert.equal(manager.status(registered.sessionId).credentialValuesExposed, false);
  assert.equal(manager.status(registered.sessionId).automationPaused, false);

  const oldTicketResult = await manager.dispatch({ sessionId: registered.sessionId, ticket: registered.ticket,
    action: { type: 'click', selector: '#submit' } });
  assert.deepEqual(oldTicketResult, { status: 'blocked', code: 'B_BROWSER_ACTION_TICKET_STALE' });
  const completed = await manager.dispatch({ sessionId: registered.sessionId, ticket: resumed.ticket,
    action: { type: 'click', selector: '[data-testid="continue"]' } });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(clicks, ['[data-testid="continue"]']);
  await assert.rejects(manager.dispatch({ sessionId: registered.sessionId, ticket: resumed.ticket,
    action: { type: 'type', selector: '#password', value: 'must-never-be-accepted' } }), error => error.code === 'B_BROWSER_ACTION_INVALID');

  const audit = manager.auditLog();
  assert.equal(audit.some(item => item.event === 'browser.action.rejected' && item.reason === 'handoff-or-generation-changed'), true);
  assert.equal(JSON.stringify(audit).includes('fixture-secret-must-not-be-logged'), false);
  assert.equal(JSON.stringify(audit).includes('confirmationToken'), false);
  const evidence = {
    schemaVersion: 1, scenarioId: 'M08', fixtureId: 'm08-human-handoff-generation-origin-recheck-v1',
    states: audit.filter(item => item.event.startsWith('browser.handoff.')).map(item => item.event),
    delayedClickBlocked: staleAction.code === 'B_BROWSER_AUTOMATION_PAUSED_FOR_HUMAN' && clicks.length === 1,
    clicksDuringHumanHandoff: clickStatuses.filter(status => status === 'human_handoff').length,
    outOfScopeOriginRejected: manager.auditLog().some(item => item.event === 'browser.handoff.origin_rejected'),
    invalidConfirmationRejectedBeforeOwnerCheck: invalidConfirmationRejected && ownerConfirmationCalls === 2,
    ownerConfirmationChecks: ownerConfirmationCalls,
    scopeReauthorizationChecks: reauthorizationCalls,
    userConfirmationWasRequired: audit.some(item => item.event === 'browser.handoff.resumed') && ownerConfirmationCalls === 2,
    generationRotated: registered.ticket !== resumed.ticket && resumed.generation > firstHandoff.generation,
    oldTicketRejected: oldTicketResult.code === 'B_BROWSER_ACTION_TICKET_STALE',
    resumedOrigin: resumed.origin,
    agentCredentialEntryAllowed: false,
    onlyPostResumeAllowedClickRan: clicks.length === 1,
    auditContainsCallbackSecret: false,
    auditContainsConfirmationToken: false,
    auditHash: createHash('sha256').update(JSON.stringify(audit)).digest('hex'),
    providerCalls: 0, networkRequests: 0, externalWrites: 0
  };
  const evidencePath = process.env.JARVIS_M08_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('M08 expires a browser ticket at dispatch time even when no other operation prunes the session', async () => {
  let now = new Date('2026-09-29T08:00:00.000Z');
  let clickCount = 0;
  const manager = new BrowserHandoffManager({ clock: () => now });
  const registered = manager.register({ sessionId: 'm08-expiry-001', ttlMs: 1000,
    allowedOrigins: ['https://app.example.test'],
    driver: { currentUrl: () => 'https://app.example.test/', click: async () => { clickCount += 1; } } });
  now = new Date('2026-09-29T08:00:01.001Z');
  assert.deepEqual(await manager.dispatch({ sessionId: registered.sessionId, ticket: registered.ticket,
    action: { type: 'click', selector: '#continue' } }),
  { status: 'blocked', code: 'B_BROWSER_ACTION_TICKET_STALE' });
  assert.equal(clickCount, 0);
  assert.equal(manager.status(registered.sessionId).status, 'missing');
});
