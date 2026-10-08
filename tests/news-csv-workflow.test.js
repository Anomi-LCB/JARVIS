import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAndVerifyNewsFactsCsv } from '../scripts/lib/news-csv-workflow.mjs';

test('news CSV workflow round-trips quoted commas, quotes, newlines, and Unicode through the local adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-news-csv-'));
  try {
    const headlines = [{
      title: '쉼표, 따옴표 "인용"과\n두 번째 줄',
      source: '언론사, 한국어',
      publishedAt: '2026-09-29T09:00:00.000Z',
      url: 'https://example.test/story?a=1,2&b="quoted"',
      articleStatus: 'unavailable'
    }];
    await writeFile(join(root, 'source-facts.json'), `${JSON.stringify({ facts: { headlines } })}\n`);
    const result = await createAndVerifyNewsFactsCsv({ root, headlines });
    assert.equal(result.status, 'passed');
    assert.equal(result.result.status, 'success');
    assert.match(await readFile(join(root, 'headlines.csv'), 'utf8'), /"쉼표, 따옴표 ""인용""과\n두 번째 줄"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
