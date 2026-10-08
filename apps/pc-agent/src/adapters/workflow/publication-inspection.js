import { opendir, open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); };
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Observation only. A mutable local journal never grants execution authority or
// establishes a completed receipt; callers must bind the original dispatch.
export async function inspectWorkflowPublication(adapter, taskId) {
  if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 512) return { status: 'unavailable', reason: 'invalid-task-id' };
  const matches = []; let scanned = 0;
  try {
    for (const root of adapter.allowedRoots) {
      await adapter.assertSafePath(root, { mustExist: true });
      const directory = await opendir(root);
      for await (const entry of directory) {
        if (++scanned > 2048) fail('scan-limit');
        if (!/^\.jarvis-workflow-stage-[a-f0-9]{32}$/.test(entry.name) || !entry.isDirectory()) continue;
        const stage = join(root, entry.name), path = join(stage, 'publication-journal.jsonl');
        let bytes;
        try { bytes = await boundedBytes(adapter, path, 2 * 1024 * 1024); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const lines = bytes.toString('utf8').split('\n');
        // Interrupted append is observed as incomplete, never silently repaired.
        if (lines.pop() !== '') fail('truncated-journal');
        if (lines.length > 4096 || !lines.length) fail('journal-limit');
        const records = lines.map(line => JSON.parse(line));
        const intent = records[0];
        if (intent.taskId !== taskId) continue;
        if (matches.length) fail('ambiguous-journal');
        if (intent.version !== 'workflow-publication-journal-v1' || intent.phase !== 'prepared'
          || typeof intent.packetId !== 'string' || !/^[a-f0-9]{64}$/.test(intent.specSha256 ?? '')
          || resolve(intent.workspaceRoot) !== resolve(root) || !Array.isArray(intent.files)
          || intent.files.length > 128 || records.some(record => record.version !== intent.version
            || !['prepared', 'publishing', 'published', 'all-files-published'].includes(record.phase))) fail('invalid-journal');
        let measured = 0; const files = [], seen = new Set();
        for (const file of intent.files) {
          if (typeof file.path !== 'string' || !isAbsolute(file.path) || seen.has(resolve(file.path))
            || typeof file.stagePath !== 'string' || !inside(stage, resolve(file.stagePath))
            || !/^[a-f0-9]{64}$/.test(file.afterSha256 ?? '') || typeof file.existedBefore !== 'boolean'
            || (file.existedBefore && !/^[a-f0-9]{64}$/.test(file.beforeSha256 ?? ''))
            || (!file.existedBefore && file.beforeSha256 !== null)) fail('invalid-file-contract');
          seen.add(resolve(file.path));
          const read = async path => { const value = await boundedBytes(adapter, path, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - measured)); measured += value.length; return sha(value); };
          const stageSha = await read(file.stagePath);
          let currentSha = null;
          try { currentSha = await read(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          let backupValid = !file.existedBefore;
          if (file.existedBefore) {
            if (typeof file.backupPath !== 'string' || !inside(stage, resolve(file.backupPath))) fail('invalid-backup-path');
            backupValid = await read(file.backupPath) === file.beforeSha256;
          }
          const state = currentSha === file.afterSha256 ? 'after'
            : currentSha === file.beforeSha256 ? 'before' : 'conflict';
          files.push({ path: file.path, state, stagedValid: stageSha === file.afterSha256, backupValid });
        }
        matches.push({ taskId, packetId: intent.packetId, specSha256: intent.specSha256,
          resumable: Boolean(intent.recoveryRecipe && intent.files.length && intent.files.every(file => !file.existedBefore)),
          publicationOperationId: intent.publicationOperationId ?? null,
          intentSha256: sha(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(intent).filter(([key]) => key !== 'recordedAt'))))),
          workspaceRoot: intent.workspaceRoot, journalSha256: sha(bytes), files,
          lastPhase: records.at(-1).phase, completedReceipt: false, executionAuthority: false });
      }
    }
    if (!matches.length) return { status: 'unavailable', reason: 'journal-not-found', executionAuthority: false };
    const observation = matches[0];
    return { status: observation.files.some(file => file.state === 'conflict' || !file.stagedValid || !file.backupValid)
      ? 'conflict' : 'observed', ...observation };
  } catch (error) {
    return { status: 'unavailable', reason: error.code ?? 'invalid-journal', executionAuthority: false };
  }
}

async function boundedBytes(adapter, path, limit) {
  await adapter.assertSafePath(path, { mustExist: false });
  if ((await lstat(path)).isSymbolicLink()) fail('symlink');
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || limit < 0) fail('read-limit');
    const chunks = []; let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit - total + 1));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead; if (total > limit) fail('read-limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), published = await lstat(path);
    if (before.size !== total || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || published.isSymbolicLink() || published.ino !== after.ino || published.dev !== after.dev) fail('file-changed');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
