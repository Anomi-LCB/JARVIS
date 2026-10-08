import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workerPath = fileURLToPath(new URL('./fixtures/mission-role-session-pool-child.mjs', import.meta.url));

function launch(mode, root, clockIso) {
  const child = spawn(process.execPath, [workerPath, mode, root, clockIso], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function waitFor(predicate, processInfo, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (processInfo.child.exitCode !== null) return reject(new Error(`child exited early: ${processInfo.stderr}\n${processInfo.stdout}`));
      if (Date.now() >= deadline) return reject(new Error(`timed out: ${processInfo.stderr}\n${processInfo.stdout}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitExit(child) { return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); }

test('a killed role worker resumes only its fixed role session and replays the durable message idempotently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-role-session-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = new Date('2026-09-28T10:00:00.000Z');
  const first = launch('bind', root, before.toISOString());
  const firstExit = waitExit(first.child);
  await waitFor(() => first.stdout.includes('ATTEMPT:'), first);
  assert.equal(first.child.exitCode, null, 'the worker must still be alive after the provider accepted the request');
  assert.equal(first.stdout.includes('RESULT:'), false, 'the remote request is unresolved before forced termination');
  const firstAttempt = first.stdout.match(/ATTEMPT:([a-f0-9]{64}):researcher/u)?.[1];
  assert.ok(firstAttempt, first.stdout);
  first.child.kill('SIGTERM');
  const killed = await firstExit;
  assert.notEqual(killed.code, 0, 'the first worker must actually terminate mid-request');

  const journalPath = join(root, 'provider-journal.jsonl');
  const beforeRestart = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(beforeRestart.length, 1);
  assert.equal(beforeRestart[0].workerRole, 'researcher');
  assert.equal(beforeRestart[0].sessionId, 'remote-researcher');
  const inspector = new DatabaseSync(join(root, 'researcher.sqlite'));
  const event = inspector.prepare('SELECT state,claim_owner,claim_expires_ms,payload_json,idempotency_key FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(event.state, 'submitting');
  assert.ok(event.claim_owner);
  assert.equal(JSON.parse(event.payload_json).text, 'role-scoped durable content');
  assert.equal(event.idempotency_key, firstAttempt);
  inspector.close();
  const editorDb = new DatabaseSync(join(root, 'editor.sqlite'));
  assert.equal(editorDb.prepare('SELECT COUNT(*) AS count FROM managed_agent_session_events').get().count, 0,
    'the unrelated editor session must have no queued message');
  editorDb.close();

  const after = new Date(before.getTime() + 60_000);
  const restarted = launch('retry', root, after.toISOString());
  const restartedExit = await waitExit(restarted.child);
  assert.equal(restartedExit.code, 0, restarted.stderr);
  assert.match(restarted.stdout, /RESULT:accepted/u);
  const attempts = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(item => item.workerRole), ['researcher', 'researcher']);
  assert.deepEqual(attempts.map(item => item.sessionId), ['remote-researcher', 'remote-researcher']);
  assert.deepEqual(attempts.map(item => item.text), ['role-scoped durable content', 'role-scoped durable content']);
  assert.deepEqual(attempts.map(item => item.idempotencyKey), [firstAttempt, firstAttempt]);
  assert.equal(attempts[1].duplicateKey, true, 'the provider journal recognizes the stable idempotency key');

  const finalDb = new DatabaseSync(join(root, 'researcher.sqlite'));
  const finalEvent = finalDb.prepare('SELECT state,payload_json FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(finalEvent.state, 'submitted');
  assert.equal(finalEvent.payload_json, null);
  finalDb.close();
});

test('a killed role worker never repeats a tool effect whose outcome is uncertain after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-role-tool-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = new Date('2026-09-28T11:00:00.000Z');
  const first = launch('tool-hold', root, before.toISOString());
  const firstExit = waitExit(first.child);
  await waitFor(() => first.stdout.includes('EFFECT:researcher'), first);
  assert.equal(first.child.exitCode, null, 'the tool worker must still be alive after starting its effect');
  assert.equal(first.stdout.includes('TOOL_RESULT:'), false, 'the tool call result is unresolved before termination');
  first.child.kill('SIGTERM');
  const killed = await firstExit;
  assert.notEqual(killed.code, 0);

  const effectPath = join(root, 'tool-effects.jsonl');
  const firstEffects = (await readFile(effectPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(firstEffects.length, 1);
  assert.equal(firstEffects[0].assignedRole, 'researcher');
  const pendingDb = new DatabaseSync(join(root, 'researcher.sqlite'));
  const pendingCall = pendingDb.prepare('SELECT state,tool_name,arguments_sha256 FROM managed_agent_tool_calls').get();
  assert.equal(pendingCall.state, 'claimed');
  assert.equal(pendingCall.tool_name, 'fixture.read');
  pendingDb.close();

  const after = new Date(before.getTime() + 60_000);
  const restarted = launch('tool-recover', root, after.toISOString());
  const restartedExit = await waitExit(restarted.child);
  assert.equal(restartedExit.code, 0, restarted.stderr);
  const resultLine = restarted.stdout.match(/TOOL_RESULT:(.+)/u)?.[1];
  assert.ok(resultLine, restarted.stdout);
  const outcomes = JSON.parse(resultLine);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'blocked');
  assert.equal(outcomes[0].reason, 'execution-outcome-uncertain');
  const allEffects = (await readFile(effectPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(allEffects.length, 1, 'the restart must not dispatch the uncertain effect a second time');
  assert.equal(allEffects[0].assignedRole, 'researcher');
  const finalDb = new DatabaseSync(join(root, 'researcher.sqlite'));
  assert.equal(finalDb.prepare('SELECT state FROM managed_agent_tool_calls').get().state, 'uncertain');
  finalDb.close();
});
