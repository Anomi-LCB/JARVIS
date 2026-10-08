import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { findNewsPublisherByUrl, isNewsPublisherAiProcessingRestricted, newsPublisherFeedCatalog } from '../routing/news-publisher-catalog.js';

const textArtifactPattern = /\.(?:md|txt|json|jsonl|csv|html?|xml|ya?ml|log)$/iu;
const observedUrlRequirementPattern = /(?:(?:실제로|직접)\s*(?:읽은|조회한|확인한|방문한)|관찰(?:된|한)|확인된)\s*(?:기사\s*)?(?:출처\s*)?URL|(?:exact|actually|directly)\s+(?:read|observed|visited)[^\n.]{0,40}(?:source|article)?\s*URL/iu;
const koreanCounts = Object.freeze({
  한: 1,
  하나: 1,
  두: 2,
  둘: 2,
  세: 3,
  셋: 3,
  네: 4,
  넷: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10
});

export function boundNewsProvenance(news, { maxItems = 10, publisherCatalog = newsPublisherFeedCatalog } = {}) {
  if (!news || typeof news !== 'object') return null;
  const items = boundNewsArticles(news, { maxItems, publisherCatalog });
  const rightsRestrictedPublisherIds = [...new Set((Array.isArray(news.rightsRestrictedPublisherIds)
    ? news.rightsRestrictedPublisherIds : []).filter(id => {
    const publisher = publisherCatalog.find(entry => entry.id === id);
    return publisher && isNewsPublisherAiProcessingRestricted(publisher);
  }))].sort();
  const feedUrl = cleanText(news.feedUrl ?? news.sourceUrl, 1200);
  return {
    feedVersion: cleanText(news.feedVersion, 120),
    sourceProvider: cleanText(news.sourceProvider, 120),
    sourceHost: cleanText(news.sourceHost, 200),
    // sourceUrl is retained for compatibility. feedUrl gives the planner and
    // completion records an unambiguous name for the provider feed itself.
    sourceUrl: feedUrl,
    feedUrl,
    finalFeedUrl: cleanText(news.finalFeedUrl, 1200),
    retrievedAt: cleanText(news.retrievedAt, 80),
    httpStatus: Number(news.httpStatus ?? news.responseStatus ?? 0),
    query: cleanText(news.query, 240),
    category: cleanText(news.category, 40),
    maxResults: Number(news.maxResults ?? 0),
    itemCount: items.length,
    sourceContentWithheldCount: Math.max(0, Math.trunc(Number(news.sourceContentWithheldCount) || 0)),
    rightsRestrictedPublisherIds,
    live: news.live === true,
    replay: news.replay === true,
    fixture: news.fixture === true,
    fetched: news.fetched === true,
    items
  };
}

export function boundNewsArticles(news, { maxItems = 10, publisherCatalog = newsPublisherFeedCatalog } = {}) {
  const feedUrl = cleanText(news?.feedUrl ?? news?.sourceUrl, 1200);
  const seen = new Set();
  const articles = [];
  for (const item of Array.isArray(news?.items) ? news.items : []) {
    if (articles.length >= maxItems) break;
    const article = {
      title: cleanText(item?.title, 500),
      url: cleanText(item?.url, 1200),
      publishedAt: cleanText(item?.publishedAt, 80),
      source: cleanText(item?.source, 240),
      sourceUrl: cleanText(item?.publisherHomepageUrl ?? item?.sourceUrl, 1200),
      publisherHomepageUrl: cleanText(item?.publisherHomepageUrl ?? item?.sourceUrl, 1200)
    };
    const publisherArticle = verifyPublisherArticleResolution(item, article, publisherCatalog);
    if (publisherArticle) article.publisherArticle = publisherArticle;
    if (!article.title || !article.url || !article.publishedAt || !article.source) continue;
    if (!isArticleUrl(article.url, { feedUrl, publisherHomepageUrl: article.publisherHomepageUrl })) continue;
    if (seen.has(article.url)) continue;
    seen.add(article.url);
    articles.push(article);
  }
  return articles;
}

export function observedNewsArticles(observations, { requireVerified = true, requireLive = false,
  publisherCatalog = newsPublisherFeedCatalog } = {}) {
  const seen = new Set();
  const articles = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.outcome && observation.outcome !== 'success') continue;
    if (requireVerified && observation?.verification?.status !== 'passed') continue;
    const news = observation?.data?.news;
    if (!news || typeof news !== 'object') continue;
    if (requireLive && (news.live !== true || news.replay === true || news.fixture === true)) continue;
    for (const article of boundNewsArticles(news, { maxItems: 100, publisherCatalog })) {
      if (!seen.has(article.url)) {
        seen.add(article.url);
        articles.push({
          title: article.title,
          source: article.source,
          publishedAt: article.publishedAt,
          url: article.url,
          observationActionId: cleanText(observation.actionId, 240)
        });
      }
      if (article.publisherArticle && !seen.has(article.publisherArticle.url)) {
        seen.add(article.publisherArticle.url);
        articles.push({ title: article.title, source: article.source, publishedAt: article.publishedAt,
          url: article.publisherArticle.url, publisherId: article.publisherArticle.publisherId,
          publisherFeedUrl: article.publisherArticle.feedUrl,
          observationActionId: cleanText(observation.actionId, 240) });
      }
    }
  }
  return articles;
}

/** Independently bounds the adapter's alternate link before planners can use it. */
export function verifyPublisherArticleResolution(item, headline = item, publisherCatalog = newsPublisherFeedCatalog) {
  const resolution = item?.publisherArticleResolution;
  if (resolution?.status !== 'matched' || resolution.method !== 'exact-normalized-title-and-publication-window') return null;
  const publisher = publisherCatalog.find(entry => entry.id === resolution.publisherId);
  if (!publisher || isNewsPublisherAiProcessingRestricted(publisher)
    || resolution.feedUrl !== publisher.feedUrl || !Array.isArray(publisher.publisherHosts)) return null;
  const hostOf = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
        ? url.hostname.toLowerCase() : null;
    } catch { return null; }
  };
  const feedHost = hostOf(resolution.finalFeedUrl);
  const articleHost = hostOf(resolution.article?.url);
  const sourceHost = hostOf(headline?.publisherHomepageUrl ?? headline?.sourceUrl);
  const title = exactPublisherNewsTitle(headline?.title, publisher);
  const matchedTitle = exactPublisherNewsTitle(resolution.article?.title, publisher);
  const headlineTime = Date.parse(headline?.publishedAt);
  const articleTime = Date.parse(resolution.article?.publishedAt);
  const observedAt = Date.parse(resolution.feedRetrievedAt);
  const delta = Math.abs(headlineTime - articleTime);
  if (!feedHost || !articleHost || !sourceHost || !publisher.publisherHosts.includes(feedHost)
    || !publisher.publisherHosts.includes(articleHost) || !publisher.publisherHosts.includes(sourceHost)
    || !title || title !== matchedTitle || !Number.isFinite(headlineTime) || !Number.isFinite(articleTime)
    || !Number.isFinite(observedAt) || articleTime > observedAt + 5 * 60 * 1000
    || delta > publisher.headlineMatchWindowMs || resolution.timeDifferenceMs !== delta
    || !isArticleUrl(resolution.article?.url, { feedUrl: resolution.finalFeedUrl,
      publisherHomepageUrl: headline?.publisherHomepageUrl ?? headline?.sourceUrl })) return null;
  const aliasMatch = publisher.aliases.some(alias => String(headline?.source ?? '').normalize('NFKC')
    .replace(/\s+/gu, '').toLocaleLowerCase('ko-KR').includes(alias.replace(/\s+/gu, '').toLocaleLowerCase('ko-KR')));
  if (!aliasMatch) return null;
  return { publisherId: publisher.id, feedUrl: publisher.feedUrl, finalFeedUrl: resolution.finalFeedUrl,
    feedRetrievedAt: resolution.feedRetrievedAt, method: resolution.method, title: resolution.article.title,
    publishedAt: resolution.article.publishedAt, url: resolution.article.url, timeDifferenceMs: delta };
}

export function observedArticleCitationRequirement(objective, outputPath = null) {
  const text = String(objective ?? '');
  if (!observedUrlRequirementPattern.test(text) || !/(?:뉴스|기사|headline|news)/iu.test(text)) return null;
  const fileName = outputPath ? basename(String(outputPath)).trim() : null;
  if (fileName && !textArtifactPattern.test(fileName)) return null;
  const fragments = text
    // Do not split on a plain period: it is part of artifact names and URLs.
    .split(/(?:^|\s)(?:\d{1,2}[.)]|[①-⑳])\s*|[。\n]+/u)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  const relevant = fragments.filter((fragment) => observedUrlRequirementPattern.test(fragment));
  const targetFileNames = relevant.map(firstTextArtifactAfterRequirement).filter(Boolean);
  if (fileName && !targetFileNames.some((target) => target.toLocaleLowerCase() === fileName.toLocaleLowerCase())) return null;
  const inferredFileName = fileName ?? targetFileNames[0] ?? null;
  if (!inferredFileName) return null;
  const counts = [...text.matchAll(/(?:기사|뉴스|헤드라인|(?:출처\s*)?URL)\s*(?:은|는|이|가|을|를)?\s*(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열|\d{1,2})\s*(?:개|건)/giu)]
    .map((match) => countValue(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0);
  return {
    fileName: inferredFileName,
    minimum: counts.length ? Math.max(...counts) : 1,
    requirement: 'exact-observed-news-article-urls'
  };
}

function firstTextArtifactAfterRequirement(fragment) {
  const requirement = String(fragment ?? '').match(observedUrlRequirementPattern);
  if (!requirement) return null;
  const tail = String(fragment).slice(Number(requirement.index ?? 0) + requirement[0].length);
  return tail.match(/(?:[A-Za-z0-9가-힣_.-]+[\\/])*([A-Za-z0-9가-힣_.-]+\.(?:md|txt|json|jsonl|csv|html?|xml|ya?ml|log))(?![A-Za-z0-9])/iu)?.[1] ?? null;
}

export function evaluateObservedArticleCitations({ objective, outputPath, content, observations, requireLive = false }) {
  const summaryRequirement = observedNewsSummaryRequirement(objective, outputPath);
  const requirement = observedArticleCitationRequirement(objective, outputPath) ?? summaryRequirement;
  if (!requirement) return null;
  const articles = observedNewsArticles(observations, { requireVerified: true, requireLive });
  const citedUrls = extractExactUrls(content);
  const citedArticles = articles.filter((article) => citedUrls.has(article.url));
  const claimEvidence = summaryRequirement
    ? evaluateObservedArticleClaimEvidence({ objective, outputPath, content, observations })
    : null;
  return {
    requirement,
    passed: citedArticles.length >= requirement.minimum && (!claimEvidence || claimEvidence.passed),
    availableArticleCount: articles.length,
    citedArticles,
    ...(claimEvidence ? { claimEvidence } : {})
  };
}

/**
 * Verify summary claim records against exact text from a previously verified live article read.
 * This proves quote-to-source linkage only; it does not prove the quote entails the claim.
 */
export function evaluateObservedArticleClaimEvidence({ objective, outputPath, content, observations }) {
  const citationRequirement = observedNewsSummaryRequirement(objective, outputPath);
  if (!citationRequirement) return null;
  const claims = parseClaimEvidenceRecords(content);
  const publishedArticles = observedNewsArticles(observations, { requireVerified: true, requireLive: true });
  const articleBodies = observedVerifiedArticleBodies(observations, publishedArticles);
  const wordCountsByUrl = new Map();
  const results = claims.map((claim, index) => {
    const published = publishedArticles.find(article => article.url === claim.url);
    const body = articleBodies.get(claim.url);
    const normalizedQuote = normalizeEvidenceText(claim.quote);
    const normalizedBody = body ? normalizeEvidenceText(body.text) : '';
    const quoteMatched = Boolean(normalizedQuote && normalizedBody.includes(normalizedQuote));
    const quoteWords = normalizedQuote ? normalizedQuote.split(' ').filter(Boolean).length : 0;
    const usedWords = wordCountsByUrl.get(claim.url) ?? 0;
    const quoteLimitPassed = usedWords + quoteWords <= 25;
    if (quoteMatched && quoteLimitPassed) wordCountsByUrl.set(claim.url, usedWords + quoteWords);
    return {
      claimIndex: index + 1,
      citedArticleObserved: Boolean(published),
      liveArticleBodyVerified: Boolean(body),
      quoteMatched,
      quoteLimitPassed,
      sourceUrl: published ? claim.url : null,
      passed: Boolean(published && body && quoteMatched && quoteLimitPassed)
    };
  });
  const passedCount = results.filter(result => result.passed).length;
  const distinctSourceCount = new Set(results.filter(result => result.passed).map(result => result.sourceUrl)).size;
  const blockingReasons = [];
  if (citationRequirement.requiresEntailment) blockingReasons.push('semantic-entailment-not-implemented');
  if (claims.length < citationRequirement.minimum) blockingReasons.push('insufficient-summary-claims');
  if (distinctSourceCount < citationRequirement.minimum) blockingReasons.push('insufficient-distinct-live-sources');
  if (results.some(result => !result.passed)) blockingReasons.push('claim-source-evidence-incomplete');
  return {
    requirement: citationRequirement,
    evidenceType: 'verbatim-source-match',
    semanticEntailment: 'not-evaluated',
    requiredClaimCount: citationRequirement.minimum,
    claimCount: claims.length,
    passedCount,
    failedCount: results.length - passedCount,
    distinctSourceCount,
    blockingReasons,
    passed: blockingReasons.length === 0 && results.length > 0 && passedCount === results.length,
    claims: results
  };
}

export function observedNewsSummaryRequirement(objective, outputPath = null) {
  const text = String(objective ?? '');
  if (!/(?:뉴스|기사|headline|news)/iu.test(text)
    || !/(?:요약|요약문|핵심\s*정리|summari[sz](?:e|y|ing)|brief)/iu.test(text)) return null;
  const fileName = outputPath ? basename(String(outputPath)).trim() : null;
  if (fileName && !textArtifactPattern.test(fileName)) return null;
  const explicit = observedArticleCitationRequirement(text, outputPath);
  const minimum = explicit?.minimum ?? extractRequestedNewsCount(text) ?? 1;
  return {
    fileName,
    minimum,
    requirement: 'summary-claims-with-verbatim-source-evidence',
    requiresEntailment: /(?:팩트\s*체크|사실\s*검증|주장.{0,12}(?:근거|검증|입증)|fact[\s-]?check|verify\s+claims)/iu.test(text)
  };
}

function extractRequestedNewsCount(text) {
  const counts = [...String(text).matchAll(/(?:뉴스|기사|헤드라인)\s*(?:은|는|이|가|을|를)?\s*(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열|\d{1,2})\s*(?:개|건)/giu)]
    .map(match => countValue(match[1])).filter(value => Number.isInteger(value) && value > 0);
  return counts.length ? Math.max(...counts) : null;
}

function parseClaimEvidenceRecords(content) {
  const records = [];
  let current = null;
  const flush = () => { if (current) records.push(current); current = null; };
  for (const rawLine of String(content ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    const claim = line.match(/^(?:[-*]\s*)?(?:요약\s*주장|summary\s*claim)\s*:\s*(.+)$/iu);
    const quote = line.match(/^(?:[-*]\s*)?(?:근거\s*원문|supporting\s*quote)\s*:\s*[“”"']?(.+?)[“”"']?\s*$/iu);
    const source = line.match(/^(?:[-*]\s*)?(?:출처\s*URL|source\s*URL)\s*:\s*(https:\/\/\S+)\s*$/iu);
    if (claim) { flush(); current = { text: claim[1].trim(), quote: '', url: '' }; continue; }
    if (!current) continue;
    if (quote) current.quote = quote[1].trim();
    else if (source) current.url = source[1].replace(/[),.;:!?]+$/gu, '');
    else if (/^#{1,6}\s/u.test(line)) flush();
  }
  flush();
  return records.filter(record => record.text && record.quote && record.url);
}

function observedVerifiedArticleBodies(observations, publishedArticles) {
  const allowedUrls = new Set(publishedArticles.map(article => article.url));
  const bodies = new Map();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.toolName !== 'news.fetchArticle') continue;
    if (observation?.outcome !== 'success' || observation?.verification?.status !== 'passed') continue;
    const article = observation?.data?.article;
    if (article?.live !== true || article?.textIsUntrustedSourceMaterial !== true) continue;
    const requestedUrl = safeHttpsArticleUrl(article.requestedUrl);
    const finalUrl = safeHttpsArticleUrl(article.finalUrl);
    const boundUrl = requestedUrl && allowedUrls.has(requestedUrl) ? requestedUrl
      : finalUrl && allowedUrls.has(finalUrl) ? finalUrl : null;
    if (!boundUrl || typeof article.text !== 'string' || !article.text.trim()) continue;
    const digest = createHash('sha256').update(article.text).digest('hex');
    if (digest !== String(article.textSha256 ?? '').toLowerCase()) continue;
    if (article.textCharacters !== article.text.length) continue;
    bodies.set(boundUrl, { text: article.text, actionId: cleanText(observation.actionId, 240) });
  }
  return bodies;
}

function safeHttpsArticleUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function normalizeEvidenceText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function extractExactUrls(content) {
  return new Set((String(content ?? '').match(/https?:\/\/[^\s<>"'\]]+/giu) ?? [])
    .map((value) => value.replace(/[),.;:!?]+$/gu, ''))
    .filter(Boolean));
}

function isArticleUrl(value, { feedUrl = null, publisherHomepageUrl = null } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const identity = urlIdentity(url);
    if (feedUrl && identity === safeUrlIdentity(feedUrl)) return false;
    if (publisherHomepageUrl && identity === safeUrlIdentity(publisherHomepageUrl)) return false;
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    if (path === '/') return false;
    if (/\/(?:rss|feed|feeds)$/iu.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function exactNewsTitle(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ko-KR');
}

function exactPublisherNewsTitle(value, publisher) {
  let normalized = exactNewsTitle(value);
  for (const alias of publisher.aliases) {
    for (const separator of [' - ', ' – ', ' — ', ' | ', ' · ', ': ']) {
      const suffix = exactNewsTitle(`${separator}${alias}`);
      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length).trim();
        break;
      }
    }
  }
  return normalized;
}

function safeUrlIdentity(value) {
  try {
    return urlIdentity(new URL(value));
  } catch {
    return null;
  }
}

function urlIdentity(url) {
  const normalized = new URL(url.href);
  normalized.hash = '';
  return normalized.href;
}

function countValue(value) {
  const text = String(value ?? '');
  return koreanCounts[text] ?? Number(text);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}
