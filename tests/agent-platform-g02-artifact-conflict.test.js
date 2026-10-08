import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileSystemToolAdapter, UndoJournal } from '../apps/pc-agent/src/pc-agent-runtime.js';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

test('G02 same-revision concurrent editors serialize and preserve the winner while reporting the losing proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-agent-platform-g02-'));
  const workspace = join(root, 'workspace');
  const targetPath = join(workspace, 'report.md');
  const journalPath = join(root, 'undo.jsonl');
  const initial = '# 초안\n기준 내용';
  const proposals = ['# 보고서\n작성자 A의 수정', '# 보고서\n작성자 B의 수정'];
  await mkdir(workspace, { recursive: true });
  await writeFile(targetPath, initial, 'utf8');
  const adapter = new FileSystemToolAdapter({ allowedRoots: [workspace], undoJournal: new UndoJournal({ journalPath }) });
  const expectedSha256 = hash(initial);
  const results = await Promise.all(proposals.map((content, index) => adapter.execute({
    path: targetPath, content, allowOverwrite: true, expectedSha256
  }, { taskId: `g02-writer-${index + 1}` })));
  const finalText = await readFile(targetPath, 'utf8');
  const capturePath = process.env.JARVIS_G02_ORACLE_EVIDENCE_PATH;
  try {
    assert.equal(results.filter(item => item.status === 'success').length, 1, JSON.stringify(results));
    assert.equal(results.filter(item => item.status === 'blocked').length, 1, JSON.stringify(results));
    const winnerIndex = proposals.indexOf(finalText);
    assert.ok(winnerIndex >= 0, `unexpected final content: ${finalText}`);
    const conflict = results.find(item => item.status === 'blocked');
    assert.match(conflict.summary, /revision changed/u);
    assert.equal(conflict.evidence?.conflictPolicy, 'blocked-by-revision-conflict');
    assert.equal(conflict.evidence?.conflictDetected, true);
    assert.equal(conflict.evidence?.contentPreserved, true);
    assert.equal(conflict.evidence?.expectedSha256, expectedSha256);
    assert.equal(conflict.evidence?.currentSha256, hash(finalText));
    assert.equal(conflict.evidence?.proposedSha256, hash(proposals[1 - winnerIndex]));
    assert.equal(conflict.changedItems.length, 0);

    if (capturePath) {
      const finalBytes = await readFile(targetPath);
      const capture = {
        schemaVersion: 1,
        scenarioId: 'G02',
        baseline: { content: initial, sha256: expectedSha256 },
        attempts: proposals.map((content, index) => ({ writerId: `g02-writer-${index + 1}`, baseSha256: expectedSha256,
          proposedContent: content, proposedSha256: hash(content), status: results[index].status,
          changedItems: results[index].changedItems, evidence: results[index].evidence })),
        final: { relativePath: 'report.md', content: finalText, byteLength: finalBytes.length,
          sha256: createHash('sha256').update(finalBytes).digest('hex') },
        undoRecords: adapter.undoJournal.records.map(item => ({ taskId: item.taskId, action: item.action, path: 'report.md' }))
      };
      await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
