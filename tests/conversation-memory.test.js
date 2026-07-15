import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkMemory } from '../packages/core/src/conversation-memory.js';

async function withMemory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-workmem-'));
  const memory = new WorkMemory({ journalPath: join(dir, 'work-journal.jsonl') });
  try {
    await run(memory);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('WorkMemory records and lists recent outputs newest-first', async () => {
  await withMemory(async (memory) => {
    memory.record({ taskId: 't1', rawText: '보고서 만들어줘', actionType: 'CREATE_FILE', outputPaths: ['C:/tmp/보고서.docx'], status: 'success' });
    memory.record({ taskId: 't2', rawText: '가계부 엑셀 만들어줘', actionType: 'CREATE_FILE', outputPaths: ['C:/tmp/가계부.xlsx'], status: 'success' });
    memory.record({ taskId: 't3', rawText: '실패한 작업', actionType: 'CREATE_FILE', outputPaths: [], status: 'failed' });
    const outputs = memory.recentOutputs(10);
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].taskId, 't2');
    assert.equal(outputs[1].taskId, 't1');
  });
});

test('WorkMemory resolves "그거" to the most recent output', async () => {
  await withMemory(async (memory) => {
    memory.record({ taskId: 't1', rawText: '보고서 만들어줘', outputPaths: ['C:/tmp/보고서.docx'], status: 'success' });
    const hit = memory.resolveReference('그거 메일로 보내줘');
    assert.ok(hit);
    assert.equal(hit.path, 'C:/tmp/보고서.docx');
  });
});

test('WorkMemory honors file-type hints when resolving', async () => {
  await withMemory(async (memory) => {
    memory.record({ taskId: 't1', rawText: '엑셀 만들어줘', outputPaths: ['C:/tmp/정산.xlsx'], status: 'success' });
    memory.record({ taskId: 't2', rawText: '보고서 만들어줘', outputPaths: ['C:/tmp/보고서.docx'], status: 'success' });
    const hit = memory.resolveReference('방금 만든 엑셀 열어줘');
    assert.ok(hit);
    assert.equal(hit.path, 'C:/tmp/정산.xlsx');
  });
});

test('WorkMemory ignores non-reference sentences', async () => {
  await withMemory(async (memory) => {
    memory.record({ taskId: 't1', rawText: '보고서 만들어줘', outputPaths: ['C:/tmp/보고서.docx'], status: 'success' });
    assert.equal(memory.resolveReference('주간 보고서 만들어줘'), null);
    assert.equal(memory.resolveReference('방금 목록 보여줘'), null);
    assert.equal(memory.resolveReference('파일 정리 좀 해줘'), null);
  });
});

test('WorkMemory returns null when journal is empty', async () => {
  await withMemory(async (memory) => {
    assert.equal(memory.resolveReference('그거 메일로 보내줘'), null);
  });
});

test('WorkMemory rewrites the deictic phrase into the file name', async () => {
  await withMemory(async (memory) => {
    memory.record({ taskId: 't1', rawText: '보고서 만들어줘', outputPaths: ['C:/tmp/주간-보고서.docx'], status: 'success' });
    const hit = memory.rewriteWithReference('방금 만든 보고서 메일로 보내줘');
    assert.ok(hit);
    assert.match(hit.rewritten, /"주간-보고서\.docx"/);
    assert.match(hit.rewritten, /\[파일 경로: C:\/tmp\/주간-보고서\.docx\]/);
  });
});
