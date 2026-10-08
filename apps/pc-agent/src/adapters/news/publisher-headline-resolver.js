import { isNewsPublisherAiProcessingRestricted, newsPublisherFeedCatalog } from '../../../../../packages/core/src/routing/news-publisher-catalog.js';

/**
 * Resolves Google News intermediary links only when an explicitly catalogued
 * publisher feed has one unique, exact-title and close-time HTTPS article match.
 * The original Google URL is preserved; no fuzzy or model-generated links are used.
 */
export async function resolveCataloguedPublisherHeadlines(news, { feedClient, maxResults = 10,
  publisherCatalog = newsPublisherFeedCatalog } = {}) {
  if (!news || !Array.isArray(news.items)) throw new TypeError('publisher-headline-news-invalid');
  if (!feedClient || typeof feedClient.fetchFeed !== 'function') throw new TypeError('publisher-headline-feed-client-required');

  const items = news.items.map(item => ({ ...item }));
  const resolution = { version: 'publisher-headline-link-resolution-v1', status: 'not-applicable',
    checkedPublisherIds: [], matchedCount: 0, unmatchedCount: 0, unavailableCount: 0 };
  const candidates = publisherCatalog.flatMap(publisher => {
    const indexes = items.flatMap((item, index) => matchesPublisherSource(item, publisher) ? [index] : []);
    return indexes.length ? [{ publisher, indexes }] : [];
  });
  if (!candidates.length) return { ...news, items, publisherLinkResolution: resolution };
  resolution.status = 'checked';

  for (const { publisher, indexes } of candidates) {
    resolution.checkedPublisherIds.push(publisher.id);
    if (isNewsPublisherAiProcessingRestricted(publisher)) {
      for (const index of indexes) {
        items[index].publisherArticleResolution = { status: 'blocked', publisherId: publisher.id,
          reason: 'publisher-ai-use-rights-not-cleared' };
        resolution.blockedCount = (resolution.blockedCount ?? 0) + 1;
      }
      continue;
    }
    let feed;
    try {
      feed = await feedClient.fetchFeed(publisher.feedUrl, { maxResults: Math.max(1, Math.min(10, maxResults)) });
      if (feed?.live !== true || feed?.replay === true || feed?.fixture === true || feed?.fetched !== true) {
        throw Object.assign(new Error('publisher-feed-not-live'), { code: 'B_NEWS_NON_LIVE_SOURCE_REJECTED' });
      }
    } catch (error) {
      for (const index of indexes) {
        items[index].publisherArticleResolution = unavailableResolution(publisher, error?.code ?? 'B_NEWS_FEED_UNAVAILABLE');
        resolution.unavailableCount++;
      }
      continue;
    }

    const retrievedAt = Date.parse(feed.retrievedAt);
    const edgeLists = indexes.map(index => ({ index, matches: feed.items.filter(candidate =>
      exactTitle(items[index]?.title, candidate?.title, publisher)
      && closePublicationTime(items[index]?.publishedAt, candidate?.publishedAt, publisher.headlineMatchWindowMs)
      && Number.isFinite(retrievedAt) && Date.parse(candidate?.publishedAt) <= retrievedAt + 5 * 60 * 1000
      && safePublisherArticle(candidate?.url, publisher)) }));
    const reverseCounts = new Map();
    for (const edge of edgeLists) {
      if (edge.matches.length === 1) {
        const url = edge.matches[0].url;
        reverseCounts.set(url, (reverseCounts.get(url) ?? 0) + 1);
      }
    }

    for (const edge of edgeLists) {
      if (edge.matches.length !== 1 || reverseCounts.get(edge.matches[0]?.url) !== 1) {
        items[edge.index].publisherArticleResolution = { status: 'unmatched', publisherId: publisher.id,
          reason: edge.matches.length > 1 || reverseCounts.get(edge.matches[0]?.url) > 1 ? 'ambiguous-match' : 'no-exact-title-and-time-match' };
        resolution.unmatchedCount++;
        continue;
      }
      const candidate = edge.matches[0];
      const delta = Math.abs(Date.parse(items[edge.index].publishedAt) - Date.parse(candidate.publishedAt));
      items[edge.index].publisherArticleResolution = {
        status: 'matched', publisherId: publisher.id, method: 'exact-normalized-title-and-publication-window',
        feedUrl: publisher.feedUrl, finalFeedUrl: feed.finalFeedUrl, feedRetrievedAt: feed.retrievedAt,
        publisherHost: new URL(candidate.url).hostname.toLowerCase(), timeDifferenceMs: delta,
        article: { title: candidate.title, url: candidate.url, publishedAt: candidate.publishedAt }
      };
      resolution.matchedCount++;
    }
  }
  return { ...news, items, publisherLinkResolution: resolution };
}

function matchesPublisherSource(item, publisher) {
  if (!Array.isArray(publisher.publisherHosts)) return false;
  try {
    const host = new URL(item?.sourceUrl ?? item?.publisherHomepageUrl).hostname.toLowerCase();
    const source = normalizeTitle(item?.source);
    const aliasPresent = publisher.aliases.some(alias => source.includes(normalizeTitle(alias)));
    return publisher.publisherHosts.includes(host) && aliasPresent;
  } catch { return false; }
}

function exactTitle(left, right, publisher) {
  const a = normalizePublisherTitle(left, publisher), b = normalizePublisherTitle(right, publisher);
  return Boolean(a && b && a === b);
}

function normalizePublisherTitle(value, publisher) {
  let normalized = normalizeTitle(value);
  for (const alias of publisher.aliases) {
    const suffix = normalizeTitle(alias);
    for (const separator of [' - ', ' – ', ' — ', ' | ', ' · ', ': ']) {
      const normalizedSuffix = normalizeTitle(`${separator}${alias}`);
      if (normalized.endsWith(normalizedSuffix)) {
        normalized = normalized.slice(0, -normalizedSuffix.length).trim();
        break;
      }
    }
    if (normalized === suffix) return '';
  }
  return normalized;
}

function normalizeTitle(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ko-KR');
}

function closePublicationTime(left, right, windowMs) {
  const a = Date.parse(left), b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= windowMs;
}

function safePublisherArticle(value, publisher) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && publisher.publisherHosts.includes(url.hostname.toLowerCase()) && url.pathname !== '/';
  } catch { return false; }
}

function unavailableResolution(publisher, errorCode) {
  return { status: 'unavailable', publisherId: publisher.id, errorCode: String(errorCode).slice(0, 100) };
}
