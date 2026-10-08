import { createHash } from 'node:crypto';
import { canonicalJson, verifyArtifactConsistency } from '../../packages/core/src/mission/artifact-consistency.js';

/** Build machine-checkable facts shared by the news brief, table, and card payload. */
export function createNewsArtifactProjections({ news, articles } = {}) {
  if (!news || !Array.isArray(news.items) || !Array.isArray(articles) || articles.length !== news.items.length) {
    throw new TypeError('news-article-count-mismatch');
  }
  const facts = {
    headlines: news.items.map((item, index) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      url: item.url,
      articleStatus: articles[index]?.status === 'read' ? 'read' : 'unavailable'
    }))
  };
  const digest = createHash('sha256').update(canonicalJson(facts)).digest('hex');
  const source = { sourceId: `news:${news.sourceProvider}:${news.retrievedAt}`, revision: 1, facts, digest };
  const sourceRef = { sourceId: source.sourceId, revision: source.revision, digest };
  const artifacts = ['report', 'table', 'card'].map(kind => ({
    artifactId: `${kind}:${digest.slice(0, 16)}`,
    kind,
    sourceRef,
    facts
  }));
  const verification = verifyArtifactConsistency({ source, artifacts });
  if (verification.status !== 'passed') throw new Error(`news-artifact-consistency:${verification.checks.filter(item => item.status !== 'passed').map(item => item.id).join(',')}`);
  return { source, artifacts, verification };
}
