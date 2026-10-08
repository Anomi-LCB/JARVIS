import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkMemory } from '../packages/core/src/conversation-memory.js';
import { workReferenceScope, resolveWorkReferenceContext } from '../packages/core/src/work-reference-context.js';

test('conversation and user scope boundaries do not collide on a long shared prefix', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-reference-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'private.txt');
  await writeFile(path, 'test-only conversation A');
  const memory = new WorkMemory({ journalPath: join(root, 'journal.jsonl') });
  const prefix = 'same-prefix-'.repeat(14);
  const scopeA = workReferenceScope({ workspaceRoot: root, userId: `${prefix}user-A`, metadata: { conversationId: `${prefix}conversation-A` } });
  memory.record({ scope: scopeA, taskId: 'A', outputPaths: [path] });
  for (const [userId, conversationId] of [[`${prefix}user-A`, `${prefix}conversation-B`], [`${prefix}user-B`, `${prefix}conversation-A`]]) {
    const scopeB = workReferenceScope({ workspaceRoot: root, userId, metadata: { conversationId } });
    const result = resolveWorkReferenceContext(memory, '그 파일 읽어줘', { scope: scopeB });
    assert.equal(result.status, 'not_found');
    assert.deepEqual(result.issue.candidates, []);
    assert.equal(result.binding, undefined);
  }
});
