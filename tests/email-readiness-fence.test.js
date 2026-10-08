import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

for (const mode of ['missing-binding', 'ready', 'revoked-during-load', 'missing-final-channel']) test(`email account prerequisite and final send fence: ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-email-readiness-'));
  let now = Date.now(), sends = 0, packets = 0;
  const binding = { capabilityId: 'workflow.execute', providerId: 'isolated-smtp', accountRef: 'synthetic-smtp',
    deviceRef: null, scopes: ['synthetic.send'] };
  const env = { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
  const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), workerDaemonEnabled: false,
    env, taskEnv: env, clock: () => new Date(now),
    ...(mode === 'missing-binding' ? {} : { capabilityBindingResolver: ({ toolName }) => toolName === 'email.send'
      ? { required: true, binding, permissionRevision: 'smtp-1' } : { required: false } }) });
  t.after(async () => { runtime.coreFacade.cognition?.close(); await rm(root, { recursive: true, force: true }); });
  const observe = accountStatus => runtime.capabilityPackageRegistry.recordAvailability({ ...binding,
    codeVersion: runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion, permissionRevision: 'smtp-1',
    observedAt: new Date(++now).toISOString(), accountStatus, observedAccountRef: binding.accountRef,
    deviceStatus: 'not-required', grantedScopes: binding.scopes, verificationLevel: 'live-probe', evidenceRef: 'isolated-smtp' });
  if (mode !== 'missing-binding') observe('connected');
  const adapter = runtime.pcAgent.registry.get('email.send');
  // No real credentials, SMTP transport or network calls are used by this fixture.
  adapter.smtpConfig = () => ({ user: 'sender@example.test', pass: 'synthetic-only', service: 'isolated' });
  adapter.loadNodemailer = async () => {
    if (mode === 'revoked-during-load') observe('revoked');
    return { createTransport: () => ({ sendMail: async () => {
      sends++; return { accepted: ['recipient@example.test'], rejected: [], pending: [], response: '250 accepted', messageId: 'synthetic-message' };
    } }) };
  };
  const receive = runtime.pcAgent.receiveExecutionPacket.bind(runtime.pcAgent);
  runtime.pcAgent.receiveExecutionPacket = (...args) => { packets++; return mode === 'missing-final-channel' ? receive(args[0]) : receive(...args); };
  const task = runtime.coreFacade.createTask('이메일로 보내줘');
  assert.equal(task.plan.action.toolName, 'email.send');
  task.plan.action.arguments = { to: 'recipient@example.test', subject: 'synthetic', body: 'synthetic', idempotencyKey: `smtp-${mode}` };
  const run = await runtime.orchestrationWorker.runTask(task.taskId);
  const diagnostic = JSON.stringify({success:run.success,status:run.status,error:run.error,executionError:run.execution?.executionResult?.error});
  if (mode === 'ready') {
    assert.equal(sends, 1, diagnostic); assert.equal(run.success, true, diagnostic);
    assert.equal(run.executionVerification.status, 'passed');
  } else {
    assert.equal(sends, 0, diagnostic); assert.equal(run.success, false);
    if (mode === 'missing-binding') {
      assert.equal(packets, 0); assert.equal(run.capabilityReadiness.reasons[0].code, 'binding-required');
    } else assert.match(JSON.stringify(run), mode === 'missing-final-channel' ? /B_REQUIRED_CAPABILITY_FENCE_MISSING/ : /A_WORKER_CAPABILITY_REVOKED/);
  }
});
