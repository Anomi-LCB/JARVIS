import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

for (const boundary of ['prepared', 'completed-before-ack', 'b-receipt', 'file-effect']) {
  test(`actual routine process kill at ${boundary} reconciles receipts without repeating the file effect`, { timeout: 30000 }, async t => {
    const uncertain = boundary === 'file-effect';
    const root = mkdtempSync(join(tmpdir(), 'jarvis-routine-process-')), children = new Set();
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
    });
    const next = child => new Promise((done, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
      const onMessage = m => { cleanup(); m.type === 'error' ? reject(new Error(JSON.stringify(m))) : done(m); };
      const onExit = code => { cleanup(); reject(new Error(`child exited ${code}`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('child observation timed out')); }, 15000);
      child.once('message', onMessage); child.once('exit', onExit);
    });
    const launch = async mode => {
      const child = fork(new URL('./fixtures/routine-process-recovery-child.mjs', import.meta.url), [root, mode, boundary], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.add(child); let stderr = ''; child.stderr.on('data', b => { stderr += b; });
      try { assert.equal((await next(child)).type, 'ready'); } catch (error) { throw new Error(`${error.message}: ${stderr}`); }
      return child;
    };
    const first = await launch(boundary), waiting = next(first); first.send('run');
    assert.equal((await waiting).boundary, boundary);
    assert.equal(existsSync(join(root, 'workspace/result.txt')), boundary !== 'prepared');
    const ended = once(first, 'exit'); assert.equal(first.kill('SIGKILL'), true); await ended; children.delete(first);
    const resumed = await launch('resume'); assert.notEqual(resumed.pid, first.pid);
    const resultWaiting = next(resumed); resumed.send('run'); const result = await resultWaiting;
    assert.equal(result.routine.status, uncertain ? 'blocked' : 'completed', JSON.stringify(result));
    assert.equal(result.missionStatus, uncertain ? 'PAUSED' : 'COMPLETED'); assert.equal(result.recovered.recoveredDispatches, 1);
    assert.equal(result.effect.state, uncertain ? 'uncertain' : 'succeeded'); assert.equal(result.pendingFollowups, 0);
    assert.equal(result.growthEvents, uncertain ? 0 : 1); assert.equal(result.workEntries, uncertain ? 0 : 1); assert.equal(result.notices.length, 1);
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1); assert.equal(calls[0].operationId, result.effect.operation_id);
    assert.equal(result.actualText, '실제 프로세스 종료 후 예약 결과');
    const resumedExited = once(resumed, 'exit'); await resumedExited; children.delete(resumed);
    const again = await launch('resume'), againWaiting = next(again); again.send('run'); const stable = await againWaiting;
    assert.notEqual(again.pid, resumed.pid);
    assert.equal(stable.recovered.recoveredDispatches, 0);
    assert.equal(stable.routine.status, uncertain ? 'blocked' : 'completed'); assert.equal(stable.missionId, result.missionId);
    assert.equal(stable.notices.length, 0); assert.equal(stable.growthEvents, uncertain ? 0 : 1); assert.equal(stable.workEntries, uncertain ? 0 : 1);
    assert.equal(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(stable.effect.receipt, result.effect.receipt);
    const againExited = once(again, 'exit'); await againExited; children.delete(again);
    if (process.env.JARVIS_ROUTINE_PROCESS_EVIDENCE_PREFIX) writeFileSync(`${process.env.JARVIS_ROUTINE_PROCESS_EVIDENCE_PREFIX}-${boundary}.json`, JSON.stringify({ observedAt: new Date().toISOString(), boundary, actualProcessKill: true, oldPid: first.pid, resumedPid: resumed.pid, againPid: again.pid, calls, result, stable, scope: 'isolated-local-SQL-E-B-G-F; fixture-planner; synthetic-trust-key; no-cloud-or-private-data' }, null, 2), { flag: 'wx' });
  });
}
