import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyNewsFactsDocx } from '../scripts/lib/news-docx-verifier.mjs';

test('bounded DOCX parser independently reopens text runs and detects missing required source facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-news-docx-'));
  const path = join(directory, 'brief.docx');
  const xml = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>오늘의 뉴스</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>한국어 제목, 인용</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>https://example.test/news</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const xmlBase64 = Buffer.from(xml, 'utf8').toString('base64');
  const source = `import base64,sys,zipfile\nxml=base64.b64decode('${xmlBase64}')\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive: archive.writestr('word/document.xml', xml)`;
  try {
    execFileSync('python', ['-c', source, path], { timeout: 10_000, windowsHide: true });
    const passed = verifyNewsFactsDocx(path, ['오늘의 뉴스', '한국어 제목, 인용', 'https://example.test/news']);
    assert.equal(passed.status, 'passed');
    assert.equal(passed.expectedCount, 3);
    assert.equal(passed.matchedCount, 3);
    const missing = verifyNewsFactsDocx(path, ['오늘의 뉴스', 'missing article']);
    assert.equal(missing.status, 'failed');
    assert.equal(missing.matchedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
