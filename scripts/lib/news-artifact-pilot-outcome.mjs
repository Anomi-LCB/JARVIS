/**
 * Keep artifact-integrity success separate from content-research completeness.
 * A rendered title card is not evidence that the underlying article was read.
 */
export function classifyNewsArtifactPilotOutcome({ articles, reportVerified, cardsVerified, consistencyVerified = true,
  tableVerified = true, documentVerified = true, csvVerified = true, cardContentStatus } = {}) {
  if (!Array.isArray(articles) || typeof reportVerified !== 'boolean' || typeof cardsVerified !== 'boolean'
    || typeof consistencyVerified !== 'boolean' || typeof tableVerified !== 'boolean'
    || typeof documentVerified !== 'boolean' || typeof csvVerified !== 'boolean'
    || !['passed', 'failed', 'blocked'].includes(cardContentStatus)) {
    throw new TypeError('News artifact pilot outcome requires article and artifact evidence.');
  }
  const articleCount = articles.length;
  const articlesRead = articles.filter(article => article?.status === 'read').length;
  const articlesUnavailable = articleCount - articlesRead;
  const artifactIntegrityPassed = reportVerified && cardsVerified && consistencyVerified && tableVerified && documentVerified
    && csvVerified && cardContentStatus === 'passed';
  const complete = artifactIntegrityPassed && articleCount > 0 && articlesUnavailable === 0;
  return {
    status: complete ? 'passed' : cardContentStatus === 'blocked' ? 'blocked' : artifactIntegrityPassed ? 'partial' : 'failed',
    contentStatus: articlesUnavailable === 0 && articleCount > 0 ? 'all-articles-read' : 'headline-only-or-incomplete',
    artifactIntegrityPassed,
    articleCount,
    articlesRead,
    articlesUnavailable,
    blockingReasons: [
      ...(!reportVerified ? ['report-reread-mismatch'] : []),
      ...(!cardsVerified ? ['card-integrity-check-failed'] : []),
      ...(!consistencyVerified ? ['source-projection-consistency-mismatch'] : []),
      ...(!tableVerified ? ['spreadsheet-reopen-mismatch'] : []),
      ...(!documentVerified ? ['document-reopen-mismatch'] : []),
      ...(!csvVerified ? ['csv-workflow-roundtrip-mismatch'] : []),
      ...(cardContentStatus === 'failed' ? ['card-content-ocr-mismatch'] : []),
      ...(cardContentStatus === 'blocked' ? ['card-content-ocr-unavailable'] : []),
      ...(articleCount === 0 ? ['no-articles-retrieved'] : []),
      ...(articlesUnavailable > 0 ? ['publisher-article-content-unavailable'] : [])
    ]
  };
}
