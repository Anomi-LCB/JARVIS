import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workerPath = fileURLToPath(new URL('./fixtures/managed-agent-outbox-child.mjs', import.meta.url));
function launch(args) {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
function waitFor(predicate, proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (proc.child.exitCode !== null) return reject(new Error(`child exited early: ${proc.stderr}\n${proc.stdout}`));
      if (Date.now() >= deadline) return reject(new Error(`timed out: ${proc.stderr}\n${proc.stdout}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}
function waitExit(child) { return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); }

test('tool result process killed after acceptance keeps lease and restores exact result without redispatch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jarvis-tool-result-process-'));
  const dbPath=join(root,'broker.sqlite'),journalPath=join(root,'provider.jsonl');
  let hold;
  t.after(async()=>{if(hold?.child.exitCode===null)hold.child.kill('SIGTERM');await rm(root,{recursive:true,force:true});});
  const before=new Date('2026-10-07T04:00:00Z');hold=launch(['tool-hold',dbPath,journalPath,before.toISOString()]);
  const stopped=waitExit(hold.child);await waitFor(()=>hold.stdout.includes('ATTEMPT:'),hold);
  const check=new DatabaseSync(dbPath);const pending=check.prepare('SELECT * FROM managed_agent_tool_calls').get();check.close();
  assert.equal(pending.state,'result_ready');assert.match(pending.claim_owner,/^result-submit:/);
  assert.ok(pending.claim_expires_ms>before.getTime());assert.equal(JSON.parse(pending.result_json).output,'durable verified result');
  hold.child.kill('SIGTERM');await stopped;
  const retry=launch(['tool-retry',dbPath,journalPath,new Date(before.getTime()+60_000).toISOString()]);const exit=await waitExit(retry.child);
  assert.equal(exit.code,0,retry.stderr);assert.doesNotMatch(retry.stdout,/DISPATCH:/);
  const journal=(await readFile(journalPath,'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(journal.length,2);assert.equal(journal[1].duplicateKey,true);
  assert.equal(journal[0].idempotencyKey,journal[1].idempotencyKey);assert.deepEqual(journal[0].payload,journal[1].payload);
  const final=new DatabaseSync(dbPath);const done=final.prepare('SELECT state,claim_owner FROM managed_agent_tool_calls').get();final.close();
  assert.equal(done.state,'submitted');assert.equal(done.claim_owner,null);
});

test('a separate worker process killed after provider acceptance reopens the SQLite outbox and retries the exact idempotency request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-agent-outbox-process-'));
  const dbPath = join(root, 'broker.sqlite'), journalPath = join(root, 'provider-journal.jsonl');
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = new Date('2026-09-27T15:00:00.000Z');
  const hold = launch(['hold', dbPath, journalPath, before.toISOString()]);
  const holdExit = waitExit(hold.child);
  await waitFor(() => hold.stdout.includes('ATTEMPT:'), hold);
  const firstKey = hold.stdout.match(/ATTEMPT:([a-f0-9]{64})/u)?.[1];
  assert.ok(firstKey);
  hold.child.kill('SIGTERM');
  const killed = await holdExit;
  assert.notEqual(killed.code, 0);

  const check = new DatabaseSync(dbPath);
  const pending = check.prepare('SELECT state,claim_owner,claim_expires_ms,payload_json FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(pending.state, 'submitting');
  assert.ok(pending.claim_owner);
  assert.equal(JSON.parse(pending.payload_json).text, 'durable content');
  check.close();

  const after = new Date(before.getTime() + 60_000);
  const retry = launch(['retry', dbPath, journalPath, after.toISOString()]);
  const retryExit = await waitExit(retry.child);
  assert.equal(retryExit.code, 0, retry.stderr);
  assert.match(retry.stdout, /RESULT:accepted/u);
  const journal = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(journal.length, 2);
  assert.equal(journal[0].idempotencyKey, journal[1].idempotencyKey);
  assert.equal(journal[0].text, journal[1].text);
  assert.equal(journal[1].duplicateKey, true);
  const finalDb = new DatabaseSync(dbPath);
  const done = finalDb.prepare('SELECT state,payload_json FROM managed_agent_session_events WHERE event_type=?').get('message');
  assert.equal(done.state, 'submitted');
  assert.equal(done.payload_json, null);
  finalDb.close();
});
