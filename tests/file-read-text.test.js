import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileReadTextToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { SkillRouter } from '../packages/core/src/routing/skill-router.js';

test('text read intent selects the bounded read-only adapter while a find request stays a file search', () => {
  const parser = new IntentParser();
  const router = new SkillRouter();
  assert.equal(router.route(parser.parse('sales.csv 내용을 읽어줘')).skill.toolName, 'filesystem.readText');
  assert.equal(router.route(parser.parse('sales.csv 파일을 UTF-8로 읽어줘')).skill.toolName, 'filesystem.readText');
  assert.equal(router.route(parser.parse('workspace에서 sales.csv 파일을 찾아줘')).skill.toolName, 'filesystem.searchFiles');
  assert.notEqual(router.route(parser.parse('fast-proof.txt 파일이 존재하는지 읽기 전용으로 확인한다.')).skill.toolName, 'filesystem.readText');
});

test('text read adapter returns verified bounded content without changing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-read-text-'));
  try {
    const path = join(root, 'source.csv');
    const source = 'name,value\nalpha,10\nbeta,20\n';
    await writeFile(path, source, 'utf8');
    const adapter = new FileReadTextToolAdapter({ allowedRoots: [root] });
    const result = await adapter.execute({ path, maxChars: 12 });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.readOnly, true);
    assert.equal(result.stdoutPreview, source.slice(0, 12));
    assert.equal(result.truncated, true);
    assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.outputPaths, []);
    assert.deepEqual(result.changedItems, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
