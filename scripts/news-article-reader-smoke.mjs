import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NewsFetchArticleToolAdapter } from '../apps/pc-agent/src/adapters/news/publisher-article-reader.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/news-article-reader-smoke.mjs https://publisher.example/article');
  process.exitCode = 2;
} else {
  const startedAt = Date.now();
  const result = await new NewsFetchArticleToolAdapter().execute({ url });
  assert.equal(result.status, 'success', result.errorCode ?? 'article read failed');
  const article = result.article;
  assert.equal(article.live, true, 'injected transports cannot be reported as live');
  const evidence = { status: article.status, live: article.live,
    requestedUrl: article.requestedUrl, finalHost: article.finalHost, httpStatus: article.httpStatus,
    contentType: article.contentType, byteLength: article.byteLength,
    extractedTextCharacters: article.textCharacters,
    extractedTextSha256: createHash('sha256').update(article.text).digest('hex'),
    observedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
    bodyPersisted: false, textSentToProvider: false, toolName: 'news.fetchArticle' };
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = join(root, 'artifacts', `news-article-reader-smoke-20260928-${randomBytes(3).toString('hex')}`);
  mkdirSync(directory, { recursive: false });
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}
