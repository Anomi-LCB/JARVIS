import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createNewsFactsWorkbookBuffer, verifyNewsFactsWorkbook } from '../scripts/lib/news-workbook-verifier.mjs';

test('news facts survive XLSX creation and independent ExcelJS reopen with Unicode, commas, and quotes', async () => {
  const headlines = [
    { title: '한국어, “인용” 제목', source: '매체 A', publishedAt: '2026-09-29T01:02:03.000Z', url: 'https://example.test/a', articleStatus: 'read' },
    { title: 'comma, quote " and ampersand &', source: 'Publisher, B', publishedAt: '2026-09-29T04:05:06.000Z', url: 'https://example.test/b?x=1&y=2', articleStatus: 'unavailable' }
  ];
  const generated = createNewsFactsWorkbookBuffer(headlines);
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-news-xlsx-'));
  const path = join(directory, 'headlines.xlsx');
  try {
    await writeFile(path, generated.buffer, { flag: 'wx' });
    const result = await verifyNewsFactsWorkbook(path, generated.rows);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.headers, generated.columns);
    assert.deepEqual(result.rows, generated.rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('news workbook writer rejects non-facts and oversized batches', () => {
  assert.throws(() => createNewsFactsWorkbookBuffer([{ title: 'missing fields' }]), /news-workbook-fact-invalid/u);
  assert.throws(() => createNewsFactsWorkbookBuffer(Array(101).fill({})), /news-workbook-row-limit/u);
});
