import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagedAgentSessionBroker } from '../../packages/core/src/mission/managed-agent-session-broker.js';
import { MissionRoleAgentSessionPool } from '../../packages/core/src/mission/mission-role-agent-session-pool.js';

const [mode, root, clockIso] = process.argv.slice(2);
const now = () => new Date(clockIso);
const readJournal = () => {
  try { return readFileSync(`${root}/provider-journal.jsonl`, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
const providers = Object.fromEntries(['researcher', 'editor'].map(workerRole => [workerRole, {
  async retrieveSession(sessionId) { return { id: sessionId,
    required_actions: mode.startsWith('tool-') && workerRole === 'researcher'
      ? [{ type: 'function_call', turn_id: 'process-turn', call_id: 'process-call', name: 'fixture.read', arguments: { scope: 'source' } }]
      : [], status: 'waiting' }; },
  async submitToolResult() { return { status: 'accepted' }; },
  async cancelTurn() { return { status: 'accepted' }; },
  async submitMessage(sessionId, text, { idempotencyKey }) {
    const previous = readJournal();
    appendFileSync(`${root}/provider-journal.jsonl`, `${JSON.stringify({ workerRole, sessionId, text, idempotencyKey,
      duplicateKey: previous.some(item => item.idempotencyKey === idempotencyKey) })}\n`);
    process.stdout.write(`ATTEMPT:${idempotencyKey}:${workerRole}\n`);
    if (mode === 'bind') {
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    return { accepted: true, status: 202 };
  }
}]));
const db = name => {
  const handle = new DatabaseSync(`${root}/${name}.sqlite`);
  handle.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;');
  return handle;
};
const roleBrokers = Object.fromEntries(['researcher', 'editor'].map(workerRole => [workerRole,
  new ManagedAgentSessionBroker({ db: db(workerRole), provider: providers[workerRole],
    dispatchVerifiedTool: async ({ role, workerRole: assignedRole, idempotencyKey }) => {
      appendFileSync(`${root}/tool-effects.jsonl`, `${JSON.stringify({ role, assignedRole, idempotencyKey })}\n`);
      process.stdout.write(`EFFECT:${assignedRole}\n`);
      if (mode === 'tool-hold') {
        setInterval(() => {}, 1_000);
        await new Promise(() => {});
      }
      return { success: true, verified: true };
    },
    allowedToolNames: ['fixture.read'], workerRole, ownerId: `fixture-${workerRole}`, clock: now })]));
const pool = new MissionRoleAgentSessionPool({ db: db('registry'), roles: roleBrokers,
  authorizeRoleMessage: async ({ authorization }) => authorization === 'approved', clock: now });

try {
  if (mode === 'bind') {
    pool.bindSession({ missionId: 'process-role-mission', sessionId: 'remote-researcher', workerRole: 'researcher', collaborationGroupId: 'process-group' });
    pool.bindSession({ missionId: 'process-role-mission', sessionId: 'remote-editor', workerRole: 'editor', collaborationGroupId: 'process-group' });
  } else if (mode === 'tool-hold') {
    pool.bindSession({ missionId: 'process-role-mission', sessionId: 'remote-researcher', workerRole: 'researcher', collaborationGroupId: 'process-group' });
  }
  if (mode.startsWith('tool-')) {
    const result = await pool.reconcileMission('process-role-mission', { workerRole: 'researcher', collaborationGroupId: 'process-group' });
    process.stdout.write(`TOOL_RESULT:${JSON.stringify(result.outcomes)}\n`);
  } else {
    const result = await pool.sendMissionMessage({ missionId: 'process-role-mission', messageId: 'process-message',
      text: 'role-scoped durable content', workerRole: 'researcher', collaborationGroupId: 'process-group', messageAuthorization: 'approved' });
    process.stdout.write(`RESULT:${result.status}\n`);
  }
} catch (error) {
  process.stderr.write(`ERROR:${error.code ?? 'unknown'}\n`);
  process.exitCode = 1;
}
