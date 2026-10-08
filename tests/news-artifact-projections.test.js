import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsArtifactProjections } from '../scripts/lib/news-artifact-projections.mjs';

test('news report, table, and card payloads share source identity and article facts', () => {
  const result = createNewsArtifactProjections({
    news: { sourceProvider: 'test-rss', retrievedAt: '2026-09-29T00:00:00.000Z', items: [
      { title: 'Headline A', source: 'Publisher A', publishedAt: '2026-09-28T20:00:00.000Z', url: 'https://example.test/a' },
      { title: 'Headline B', source: 'Publisher B', publishedAt: '2026-09-28T21:00:00.000Z', url: 'https://example.test/b' }
    ] },
    articles: [{ status: 'read' }, { status: 'unavailable' }]
  });
  assert.equal(result.verification.status, 'passed');
  assert.deepEqual(result.artifacts.map(item => item.kind), ['report', 'table', 'card']);
  assert.equal(new Set(result.artifacts.map(item => item.artifactId)).size, 3);
  assert.equal(result.source.facts.headlines[1].articleStatus, 'unavailable');
});

test('news projections reject missing article observations instead of fabricating facts', () => {
  assert.throws(() => createNewsArtifactProjections({
    news: { sourceProvider: 'test', retrievedAt: '2026-09-29T00:00:00Z', items: [{ title: 'A' }] }, articles: []
  }), /news-article-count-mismatch/u);
});
