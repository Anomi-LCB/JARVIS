import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runIsolatedNaturalWorkflowPilot({ definitions, secrets, tempRoot, restart }) {
  const core = definitions.find(service => service.id === 'core').endpoint;
  const request = async (path, body) => {
    const response = await fetch(core + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${secrets.coreToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
    const result = await response.json();
    assert.ok(response.ok, `HTTP ${response.status}: ${result.error?.code ?? 'unknown'}`); return result;
  };
  const workspace = join(tempRoot, 'workspace'), destination = join(workspace, 'result.json');
  const rows = [{ total: 3 }, { total: 7 }];
  await writeFile(join(workspace, 'input.json'), JSON.stringify(rows));
  const authorize = async () => {
    const owner = await request('/owner-session/activate', { durationMinutes: 5, requestedBy: 'isolated-workflow-pilot', grants: ['read_only', 'local_reversible'] });
    return { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: ['read_only', 'local_reversible'] };
  };
  const authorization = await authorize();
  const input = { objective: "'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 2인지 검증하고; '원본'을 'result.json' JSON으로 저장해",
    successCriteria: [{ statement: '저장한 둘째 행의 total은 7이다.', verificationSpec: { version: 1, kind: 'json.value', path: 'result.json', pointer: '/1/total', equals: 7 } }],
    authorization, metadata: { userId: 'synthetic-pilot-owner' } };
  const created = await request('/missions', input);
  const started = performance.now(), result = await request(`/missions/${created.missionId}/run`, {});
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 'COMPLETED', JSON.stringify({ status: result.status, stopReason: result.stopReason,
    errors: result.observations?.filter(item => item.error).map(item => item.error?.code) }));
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), rows, 'independent oracle reads actual output bytes');
  const journal = join(tempRoot, 'pc', 'packets.jsonl'), bDb = join(tempRoot, 'pc', 'remote-operations.sqlite');
  assert.ok(existsSync(journal), 'separate remote B process must record its actual execution packet');
  const taskId = result.waves[0]?.actions[0]?.taskId;
  assert.ok(taskId && (await readFile(journal, 'utf8')).includes(taskId), 'B journal contains the exact Core Mission action task');
  const operationSnapshot = () => {
    if (!existsSync(bDb)) return null;
    const db = new DatabaseSync(bDb, { readOnly: true });
    try { return db.prepare('SELECT operation_id,state,generation,fingerprint FROM remote_operations ORDER BY operation_id').all(); }
    finally { db.close(); }
  };
  const operations = operationSnapshot();
  // The current durable operation protocol is createTextFile-only. This workflow uses
  // the existing remote execution-packet route; never label it a SQL operation receipt.
  assert.equal(operations, null, 'record the current unsupported durable workflow boundary explicitly');
  const effectSnapshot = async () => ({ bytes: sha(await readFile(destination)), mtime: (await stat(destination)).mtimeMs,
    packetJournal: existsSync(journal) ? sha(await readFile(journal)) : null, operations: operationSnapshot() });
  const before = await effectSnapshot();
  const missionDb = new DatabaseSync(join(tempRoot, 'personal.sqlite'), { readOnly: true });
  let coreSqliteSnapshotCount;
  try { coreSqliteSnapshotCount = missionDb.prepare('SELECT COUNT(*) AS n FROM mission_sqlite_snapshot').get().n; }
  finally { missionDb.close(); }
  assert.ok(coreSqliteSnapshotCount > 0, 'Core owns the persistent SQL Mission snapshot');
  const replay = await request(`/missions/${created.missionId}/run`, {});
  assert.equal(replay.status, 'COMPLETED'); assert.deepEqual(await effectSnapshot(), before);
  const restartStatus = await restart();
  const restored = await request(`/missions/${created.missionId}`);
  assert.equal(restored.status, 'COMPLETED');
  const afterRestartReplay = await request(`/missions/${created.missionId}/run`, {});
  assert.equal(afterRestartReplay.status, 'COMPLETED'); assert.deepEqual(await effectSnapshot(), before);
  const negative = await request('/missions', { ...input, authorization: await authorize(),
    objective: "'input.json' JSON을 '원본'으로 읽고; '원본'의 개수가 3인지 검증하고; '원본'을 'forbidden-result.json' JSON으로 저장해",
    successCriteria: [{ statement: '검증된 결과 파일이 존재한다.', verificationSpec: { version: 1, kind: 'json.value', path: 'forbidden-result.json', pointer: '/1/total', equals: 7 } }] });
  const failedAssertion = await request(`/missions/${negative.missionId}/run`, {});
  assert.notEqual(failedAssertion.status, 'COMPLETED');
  assert.equal(existsSync(join(workspace, 'forbidden-result.json')), false);
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), rows);
  return { observedAt: new Date().toISOString(), status: 'passed', execution: 'natural Korean objective -> real Core HTTP/planner/E -> separate PC process -> actual file/G -> Core SQLite Mission persistence',
    missionId: created.missionId, objective: input.objective, checks: ['independent file content oracle', 'remote B packet journal bound to exact Core task',
      'same-Mission replay preserves file timestamp and B packet journal', 'stack restart restores completed Mission',
      'post-restart replay preserves effect snapshot', 'failed assertion publishes no output'],
    completedStatus: result.status, negativeStatus: failedAssertion.status, elapsedMs, fileSha256: before.bytes,
    operations, coreSqliteSnapshotCount, protocol: 'legacy-remote-execution-packet', durableSqlWorkflowProtocol: 'not-implemented',
    restartOperational: restartStatus.operational, providerCalls: 0, providerCostUsd: 0,
    limits: 'Deterministic supported grammar and synthetic JSON only. Same Mission replay, not new independent requests with fresh identities. SQL durable effect protocol currently createTextFile-only; workflow response-loss/restart during execution unverified. No long-term/device/account evidence.' };
}
