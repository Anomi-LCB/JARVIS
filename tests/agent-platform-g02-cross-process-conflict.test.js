import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { FileSystemToolAdapter, UndoJournal } from '../apps/pc-agent/src/pc-agent-runtime.js';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const workerPath = resolve('tests/fixtures/g02-cross-process-writer.mjs');
const processLockPath = (journalPath, targetPath) => {
  const lockKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  return join(`${journalPath}.file-write-locks`, `${hash(lockKey)}.lock`);
};

function findDeadPid(excluded = []) {
  for (let pid = process.pid + 10_000; pid < process.pid + 10_100; pid += 1) {
    if (excluded.includes(pid)) continue;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code !== 'EPERM') return pid; }
  }
  throw new Error('could not find a dead process id for the G02X fixture');
}

function runWriter(args) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`G02 writer failed (${code ?? signal}): ${stderr.slice(-2000)}`));
      const line = stdout.trim().split(/\r?\n/u).at(-1);
      try { resolvePromise(JSON.parse(line)); }
      catch { reject(new Error(`G02 writer returned invalid evidence: ${stdout.slice(-1000)} ${stderr.slice(-1000)}`)); }
    });
  });
}

async function waitForReady(paths) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(paths.map(path => access(path).then(() => true, () => false)));
    if (ready.every(Boolean)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error('G02 writer processes did not reach the start barrier');
}

test('G02 separate processes cannot both overwrite the same baseline revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-agent-platform-g02-cross-process-'));
  const workspace = join(root, 'workspace');
  const targetPath = join(workspace, 'report.md');
  const journalPath = join(root, 'undo.jsonl');
  const barrierPath = join(root, 'start');
  const readyPaths = [join(root, 'writer-a.ready'), join(root, 'writer-b.ready')];
  const initial = '# 초안\n기준 내용';
  const proposals = ['# 보고서\n프로세스 A 수정', '# 보고서\n프로세스 B 수정'];
  await mkdir(workspace, { recursive: true });
  await writeFile(targetPath, initial, 'utf8');
  const expectedSha256 = hash(initial);
  const writers = proposals.map((content, index) => runWriter([
    workspace, targetPath, journalPath, barrierPath, readyPaths[index], `g02-process-${index + 1}`, content, expectedSha256
  ]));

  try {
    await waitForReady(readyPaths);
    await writeFile(barrierPath, 'go', { flag: 'wx' });
    const results = await Promise.all(writers);
    const finalText = await readFile(targetPath, 'utf8');
    const undo = (await readFile(journalPath, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const winnerIndex = proposals.indexOf(finalText);

    assert.equal(results.filter(item => item.status === 'success').length, 1, JSON.stringify(results));
    assert.equal(results.filter(item => item.status === 'blocked').length, 1, JSON.stringify(results));
    assert.ok(winnerIndex >= 0, `unexpected final content: ${finalText}`);
    const conflict = results.find(item => item.status === 'blocked');
    assert.equal(conflict.conflictDetected, true, JSON.stringify(conflict));
    assert.equal(conflict.expectedSha256, expectedSha256);
    assert.equal(conflict.currentSha256, hash(finalText));
    assert.equal(conflict.proposedSha256, hash(proposals[1 - winnerIndex]));
    assert.equal(conflict.changedItemCount, 0);
    assert.equal(undo.filter(item => item.recordType === 'undo').length, 1);
    assert.notEqual(results[0].processId, results[1].processId);

    const staleTarget = join(workspace, 'stale-lock.md');
    const staleBaseline = 'stale lock baseline';
    const staleProposal = 'stale lock recovered';
    await writeFile(staleTarget, staleBaseline, 'utf8');
    const staleLock = processLockPath(journalPath, staleTarget);
    await mkdir(dirname(staleLock), { recursive: true });
    const deadPid = findDeadPid(results.map(item => item.processId));
    await writeFile(staleLock, JSON.stringify({ pid: deadPid, acquiredAt: new Date(Date.now() - 60_000).toISOString() }), { flag: 'wx' });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(staleLock, staleTime, staleTime);
    const staleResult = await new FileSystemToolAdapter({ allowedRoots: [workspace],
      undoJournal: new UndoJournal({ journalPath }) }).execute({
      path: staleTarget, content: staleProposal, allowOverwrite: true, expectedSha256: hash(staleBaseline)
    }, { taskId: 'g02x-stale-lock-recovery' });
    assert.equal(staleResult.status, 'success', JSON.stringify(staleResult));
    assert.equal(await readFile(staleTarget, 'utf8'), staleProposal);
    assert.equal(await access(staleLock).then(() => false, () => true), true);

    const activeTarget = join(workspace, 'active-lock.md');
    const activeBaseline = 'active lock baseline';
    const activeLock = processLockPath(journalPath, activeTarget);
    await writeFile(activeTarget, activeBaseline, 'utf8');
    await writeFile(activeLock, JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 60_000).toISOString() }), { flag: 'wx' });
    await utimes(activeLock, staleTime, staleTime);
    const activeAdapter = new FileSystemToolAdapter({ allowedRoots: [workspace],
      undoJournal: new UndoJournal({ journalPath }), processWriteLockTimeoutMs: 120 });
    let activeLockError = null;
    try {
      await activeAdapter.execute({
        path: activeTarget, content: 'must stay blocked', allowOverwrite: true, expectedSha256: hash(activeBaseline)
      }, { taskId: 'g02x-active-lock-timeout' });
    } catch (error) { activeLockError = error?.code ?? null; }
    assert.equal(activeLockError, 'B_FILE_WRITE_LOCK_TIMEOUT');
    assert.equal(await readFile(activeTarget, 'utf8'), activeBaseline);
    assert.equal(await access(activeLock).then(() => true, () => false), true);

    const capturePath = process.env.JARVIS_G02X_ORACLE_EVIDENCE_PATH;
    if (capturePath) {
      await writeFile(capturePath, `${JSON.stringify({
        schemaVersion: 1,
        scenarioId: 'G02X',
        fixtureScope: 'synthetic-separate-processes-same-host-shared-undo-journal',
        sharedUndoJournal: true,
        baselineSha256: expectedSha256,
        processIds: results.map(item => item.processId),
        attempts: results.map((item, index) => ({ taskId: item.taskId, proposedContent: proposals[index],
          proposedSha256: hash(proposals[index]),
          baseSha256: expectedSha256, status: item.status, conflictDetected: item.conflictDetected,
          expectedSha256: item.expectedSha256, currentSha256: item.currentSha256,
          reportedProposedSha256: item.proposedSha256, changedItemCount: item.changedItemCount })),
        finalSha256: hash(finalText),
        undoRecordCount: undo.filter(item => item.recordType === 'undo').length,
        lockRecovery: {
          deadOwnerPid: deadPid,
          deadOwnerWasConfirmedDead: true,
          staleAgeMs: 60_000,
          staleTargetBaselineContent: staleBaseline,
          staleTargetBaselineSha256: hash(staleBaseline),
          deadOwnerStaleLockReclaimed: true,
          staleTargetFinalContent: await readFile(staleTarget, 'utf8'),
          staleTargetProposedContent: staleProposal,
          staleTargetProposedSha256: hash(staleProposal),
          staleLockExistsAfterWrite: await access(staleLock).then(() => true, () => false),
          activeOwnerPid: process.pid,
          activeTargetBaselineContent: activeBaseline,
          activeTargetFinalContent: await readFile(activeTarget, 'utf8'),
          activeOwnerErrorCode: activeLockError,
          activeLockExistsAfterTimeout: await access(activeLock).then(() => true, () => false),
          activeLockTimeoutMs: 120
        }
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
  } finally {
    await Promise.allSettled(writers);
    await rm(root, { recursive: true, force: true });
  }
});
