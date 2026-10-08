import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { CapabilityTokenService } from '../apps/policy-security/src/policy-runtime.js';
import { PcAgentExecutionClient } from '../packages/core/src/client/pc-agent-execution-client.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

test('Core delegates a signed execution packet to an isolated PC Agent process boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-pc-delegation-'));
  const signingSecret = 'test-cross-process-capability-secret-with-sufficient-entropy';
  const executionToken = 'test_core_execution_token_1234567890';
  const runtime = createAgRuntime({
    allowedRoots: [root],
    auditRoot: join(root, 'audit'),
    signingSecret,
    workerDaemonEnabled: false
  });
  const apiGuard = new PcAgentApiGuard({
    apiToken: 'test_admin_token_1234567890',
    executionToken
  });
  const server = createPcAgentServer(runtime.pcAgent, { apiGuard });
  await listen(server);
  const address = server.address();
  const client = new PcAgentExecutionClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    executionToken
  });
  const issuer = new CapabilityTokenService({ signingSecret });
  const taskId = 'task_remote_file_create';
  const action = {
    actionType: ActionType.CREATE_FILE,
    toolName: 'filesystem.createTextFile',
    arguments: {
      path: join(root, 'delegated.txt'),
      content: 'delegated execution passed'
    }
  };
  const capabilityToken = issuer.issue({
    taskId,
    planId: 'plan_remote_file_create',
    approvalId: 'approval_remote_file_create',
    action,
    allowedPaths: [root]
  });
  try {
    const result = await client.receiveExecutionPacket({
      packetId: 'packet_remote_file_create',
      taskId,
      planId: 'plan_remote_file_create',
      action,
      capabilityToken,
      requestedMode: 'execute',
      userConfirmation: {
        approvalId: 'approval_remote_file_create',
        confirmed: true,
        confirmedAt: new Date().toISOString()
      }
    });
    assert.equal(result.status, TaskStatus.COMPLETED);
    assert.equal(await readFile(action.arguments.path, 'utf8'), 'delegated execution passed');
    const recoveredReceipt = await client.taskResult(taskId);
    assert.equal(recoveredReceipt.status, TaskStatus.COMPLETED);
    assert.equal(recoveredReceipt.executionResult.taskId, taskId);
    assert.equal(recoveredReceipt.executionResult.outputPaths[0], action.arguments.path);
    assert.deepEqual(recoveredReceipt.evidence, result.evidence);
    const deniedReceipt = await fetch(`http://127.0.0.1:${address.port}/tasks/${taskId}`);
    assert.equal(deniedReceipt.status, 401);
    const adopted = runtime.policyRuntime.capabilities.tokens.get(capabilityToken.tokenId);
    assert.equal(adopted.delegated, true);
    assert.equal(adopted.consumed, true);
    assert.equal(adopted.plaintextTokenStored, false);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('execution delegation token cannot access PC Agent administration APIs', async () => {
  const executionToken = 'test_core_execution_token_1234567890';
  const guard = new PcAgentApiGuard({
    apiToken: 'test_admin_token_1234567890',
    executionToken
  });
  const delegatedRequest = requestWithToken(executionToken);
  assert.equal(guard.check(delegatedRequest, {
    action: 'execution-packet',
    executionDelegationAllowed: true
  }).allowed, true);
  assert.equal(guard.check(delegatedRequest, { action: 'logs-read' }).allowed, false);
  assert.equal(guard.check(delegatedRequest, { action: 'security-status' }).allowed, false);
});

test('PC Agent rejects a tampered delegated capability before adapter execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-pc-delegation-tamper-'));
  const signingSecret = 'test-cross-process-capability-secret-with-sufficient-entropy';
  const runtime = createAgRuntime({
    allowedRoots: [root],
    auditRoot: join(root, 'audit'),
    signingSecret,
    workerDaemonEnabled: false
  });
  const issuer = new CapabilityTokenService({ signingSecret });
  const action = {
    actionType: ActionType.CREATE_FILE,
    toolName: 'filesystem.createTextFile',
    arguments: { path: join(root, 'must-not-exist.txt'), content: 'blocked' }
  };
  const issued = issuer.issue({
    taskId: 'task_tampered',
    planId: 'plan_tampered',
    approvalId: 'approval_tampered',
    action,
    allowedPaths: [root]
  });
  const tamperedBearer = `${issued.capabilityToken.slice(0, -1)}${issued.capabilityToken.endsWith('a') ? 'b' : 'a'}`;
  try {
    const result = await runtime.pcAgent.receiveDelegatedExecutionPacket({
      packetId: 'packet_tampered',
      taskId: 'task_tampered',
      planId: 'plan_tampered',
      action,
      capabilityToken: { ...issued, capabilityToken: tamperedBearer },
      userConfirmation: { confirmed: true }
    });
    assert.notEqual(result.status, TaskStatus.COMPLETED);
    assert.equal(result.blockedReason, 'E_CAPABILITY_TOKEN_SIGNATURE_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function requestWithToken(token) {
  return {
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' }
  };
}

async function listen(server) {
  await listenOnFetchSafePort(server);
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}
