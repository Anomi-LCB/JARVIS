import { writeFile } from 'node:fs/promises';
import { FileSystemToolAdapter, UndoJournal } from '../../apps/pc-agent/src/pc-agent-runtime.js';

const [workspace, targetPath, journalPath, startPath, readyPath, taskId, content, expectedSha256] = process.argv.slice(2);
if ([workspace, targetPath, journalPath, startPath, readyPath, taskId, content, expectedSha256].some(value => !value)) {
  throw new Error('G02 cross-process fixture arguments required');
}
await writeFile(readyPath, 'ready', { flag: 'wx' });
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try {
    await (await import('node:fs/promises')).access(startPath);
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
try { await (await import('node:fs/promises')).access(startPath); }
catch { throw new Error('G02 cross-process start barrier timed out'); }
const adapter = new FileSystemToolAdapter({ allowedRoots: [workspace],
  undoJournal: new UndoJournal({ journalPath }) });
const result = await adapter.execute({ path: targetPath, content, allowOverwrite: true, expectedSha256 }, { taskId });
process.stdout.write(`${JSON.stringify({ taskId, processId: process.pid, status: result.status,
  conflictDetected: result.evidence?.conflictDetected === true,
  expectedSha256: result.evidence?.expectedSha256 ?? null,
  currentSha256: result.evidence?.currentSha256 ?? null,
  proposedSha256: result.evidence?.proposedSha256 ?? null,
  changedItemCount: result.changedItems?.length ?? null })}\n`);
