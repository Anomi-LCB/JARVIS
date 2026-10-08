import { findNewsPublisherForHeadline, isNewsPublisherAiProcessingRestricted } from '../../../../../packages/core/src/routing/news-publisher-catalog.js';

const GOOGLE_NEWS_RSS_ENDPOINT = 'https://news.google.com/rss';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const CATEGORY_TERMS = Object.freeze({
  top: '',
  world: '국제',
  business: '경제',
  technology: '기술 OR IT',
  science: '과학',
  health: '건강',
  entertainment: '연예',
  sports: '스포츠'
});

const CATEGORY_ALIASES = Object.freeze({
  top: 'top', general: 'top', headlines: 'top', '주요': 'top', '종합': 'top', '핫뉴스': 'top',
  world: 'world', international: 'world', '세계': 'world', '국제': 'world',
  business: 'business', economy: 'business', finance: 'business', '경제': 'business', '금융': 'business',
  technology: 'technology', tech: 'technology', it: 'technology', '기술': 'technology', '테크': 'technology',
  science: 'science', '과학': 'science',
  health: 'health', '건강': 'health', '의료': 'health',
  entertainment: 'entertainment', culture: 'entertainment', '연예': 'entertainment', '문화': 'entertainment',
  sports: 'sports', sport: 'sports', '스포츠': 'sports'
});

export class GoogleNewsRssClient {
  constructor({
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    endpoint = GOOGLE_NEWS_RSS_ENDPOINT
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Google News RSS client requires fetchImpl.');
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.timeoutMs = clampInteger(timeoutMs, 1_000, 60_000, DEFAULT_TIMEOUT_MS);
    this.endpoint = validateEndpoint(endpoint);
    // An injected transport is useful for deterministic parser tests, but it is never
    // promoted to live evidence. Production uses the platform fetch function directly.
    this.transportMode = fetchImpl === globalThis.fetch ? 'live' : 'fixture';
  }

  buildUrl({ query = '', category = 'top' } = {}) {
    const normalizedCategory = normalizeNewsCategory(category);
    if (!normalizedCategory) {
      throw newsError('B_NEWS_CATEGORY_UNSUPPORTED', `지원하지 않는 뉴스 카테고리입니다: ${String(category ?? '').slice(0, 80)}`);
    }
    const normalizedQuery = cleanQuery(query);
    const categoryTerm = CATEGORY_TERMS[normalizedCategory];
    const terms = [normalizedQuery, categoryTerm].filter(Boolean);
    const url = new URL(terms.length ? `${this.endpoint}/search` : this.endpoint);
    if (terms.length) url.searchParams.set('q', `${terms.map((term) => `(${term})`).join(' AND ')} when:1d`);
    url.searchParams.set('hl', 'ko');
    url.searchParams.set('gl', 'KR');
    url.searchParams.set('ceid', 'KR:ko');
    return {
      url,
      query: normalizedQuery,
      category: normalizedCategory
    };
  }

  async fetchHeadlines({ query = '', category = 'top', maxResults = 5 } = {}) {
    const requestedAt = this.clock().toISOString();
    let request;
    try {
      request = this.buildUrl({ query, category });
    } catch (error) {
      if (error?.code?.startsWith?.('B_NEWS_')) throw error;
      throw newsError('B_NEWS_REQUEST_INVALID', '뉴스 조회 조건이 올바르지 않습니다.');
    }
    const resultLimit = clampInteger(maxResults, 1, 10, 5);
    const sourceUrl = request.url.href;
    const sourceHost = request.url.hostname;
    const baseEvidence = {
      feedVersion: 'jarvis-google-news-rss-v1',
      sourceProvider: 'Google News RSS',
      sourceUrl,
      sourceHost,
      query: request.query,
      category: request.category,
      maxResults: resultLimit,
      freshnessWindow: '1d',
      method: 'GET',
      requestedAt,
      transportMode: this.transportMode,
      live: false,
      replay: this.transportMode !== 'live',
      fixture: this.transportMode === 'fixture',
      fetched: false,
      retrievedAt: null,
      httpStatus: null,
      responseStatus: null,
      itemCount: 0,
      items: []
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: 'GET',
        headers: {
          accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
          'user-agent': 'JARVIS-Local-Assistant/1.0 (read-only public news feed)'
        },
        redirect: 'error',
        signal: controller.signal
      });
      const responseStatus = Number(response?.status ?? 0) || null;
      if (!response?.ok) {
        throw newsError(
          'B_NEWS_UPSTREAM_HTTP_ERROR',
          `뉴스 RSS 요청이 실패했습니다. (${responseStatus ?? 'unknown'})`,
          { ...baseEvidence, httpStatus: responseStatus, responseStatus }
        );
      }
      if (response?.url) assertGoogleNewsResponseUrl(response.url);
      const xml = await response.text();
      const responseBytes = Buffer.byteLength(xml, 'utf8');
      if (responseBytes > MAX_RESPONSE_BYTES) {
        throw newsError('B_NEWS_UPSTREAM_RESPONSE_TOO_LARGE', '뉴스 RSS 응답이 허용 크기를 초과했습니다.', {
          ...baseEvidence,
          httpStatus: responseStatus,
          responseStatus,
          responseBytes
        });
      }
      const items = parseGoogleNewsRss(xml, { maxResults: resultLimit });
      if (items.length === 0) {
        throw newsError('B_NEWS_UPSTREAM_FEED_EMPTY', '뉴스 RSS에서 검증 가능한 기사를 찾지 못했습니다.', {
          ...baseEvidence,
          httpStatus: responseStatus,
          responseStatus,
          responseBytes
        });
      }
      const retrievedAt = this.clock().toISOString();
      const live = this.transportMode === 'live';
      return {
        ...baseEvidence,
        live,
        replay: !live,
        fixture: !live,
        fetched: true,
        retrievedAt,
        httpStatus: responseStatus,
        responseStatus,
        responseBytes,
        contentType: cleanText(response?.headers?.get?.('content-type'), 160),
        finalSourceUrl: cleanUrl(response?.url) ?? sourceUrl,
        itemCount: items.length,
        items
      };
    } catch (error) {
      if (error?.code?.startsWith?.('B_NEWS_')) {
        if (!error.evidence) error.evidence = baseEvidence;
        throw error;
      }
      if (error?.name === 'AbortError') {
        throw newsError('B_NEWS_UPSTREAM_TIMEOUT', '뉴스 RSS 요청 시간이 초과되었습니다.', baseEvidence);
      }
      throw newsError('B_NEWS_UPSTREAM_UNAVAILABLE', '뉴스 RSS 서비스에 연결하지 못했습니다.', {
        ...baseEvidence,
        networkError: cleanText(error?.message, 240)
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class NewsFetchHeadlinesToolAdapter {
  constructor({ client = new GoogleNewsRssClient(), publisherLinkResolver = null } = {}) {
    this.client = client;
    this.publisherLinkResolver = publisherLinkResolver;
    this.contract = {
      toolName: 'news.fetchHeadlines',
      readOnly: true,
      mutatesSystem: false,
      preview: true,
      execute: true,
      rollback: false,
      evidence: [
        'news.live',
        'news.retrievedAt',
        'news.sourceUrl',
        'news.sourceHost',
        'news.items',
        'news.publisherLinkResolution',
        'news.sourceContentWithheldCount'
      ],
      blockedOperations: ['post', 'download', 'formSubmit', 'credentialEntry', 'fixturePromotion'],
      modes: ['shadow', 'execute']
    };
  }

  normalizedArgs(args = {}) {
    return {
      query: cleanQuery(args.query),
      category: normalizeNewsCategory(args.category ?? 'top'),
      maxResults: clampInteger(args.maxResults, 1, 10, 5)
    };
  }

  async shadow(args = {}) {
    const normalized = this.normalizedArgs(args);
    const warnings = [];
    if (!normalized.category) warnings.push('unsupported-news-category');
    let sourceUrl = null;
    if (!warnings.length) sourceUrl = this.client.buildUrl(normalized).url.href;
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      readOnly: true,
      externalNetwork: true,
      method: 'GET',
      sourceUrl,
      query: normalized.query,
      category: normalized.category,
      maxResults: normalized.maxResults,
      blockedOperations: [...this.contract.blockedOperations],
      warnings
    };
  }

  async execute(args = {}) {
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return failureResult({
        status: 'blocked',
        code: 'B_NEWS_CATEGORY_UNSUPPORTED',
        summary: '지원하지 않는 뉴스 카테고리라 조회를 중단했습니다.',
        news: {
          live: false,
          replay: false,
          fixture: false,
          fetched: false,
          retrievedAt: null,
          sourceUrl: shadow.sourceUrl,
          sourceHost: 'news.google.com',
          query: shadow.query,
          category: shadow.category,
          maxResults: shadow.maxResults,
          itemCount: 0,
          items: []
        }
      });
    }
    try {
      let news = await this.client.fetchHeadlines(shadow);
      if (news.live !== true || news.replay === true || news.fixture === true) {
        return failureResult({
          status: 'blocked',
          code: 'B_NEWS_NON_LIVE_SOURCE_REJECTED',
          summary: 'Fixture RSS 파싱은 검증했지만 실제 최신 뉴스 조회 성공으로 기록하지 않았습니다.',
          news
        });
      }
      if (typeof this.publisherLinkResolver === 'function') {
        try {
          const resolved = await this.publisherLinkResolver(news);
          if (resolved && Array.isArray(resolved.items) && resolved.items.length === news.items.length) news = resolved;
        } catch (error) {
          news = { ...news, publisherLinkResolution: { version: 'publisher-headline-link-resolution-v1',
            status: 'unavailable', checkedPublisherIds: [], matchedCount: 0, unmatchedCount: 0,
            unavailableCount: 0, errorCode: String(error?.code ?? 'B_NEWS_PUBLISHER_RESOLUTION_FAILED').slice(0, 100) } };
        }
      }
      const restrictedPublisherIds = new Set();
      const visibleItems = news.items.filter(item => {
        const publisher = findNewsPublisherForHeadline(item);
        if (!isNewsPublisherAiProcessingRestricted(publisher)) return true;
        restrictedPublisherIds.add(publisher.id);
        return false;
      });
      const withheldCount = news.items.length - visibleItems.length;
      if (withheldCount > 0) news = { ...news, providerItemCount: news.itemCount, itemCount: visibleItems.length,
        items: visibleItems, sourceContentWithheldCount: withheldCount,
        rightsRestrictedPublisherIds: [...restrictedPublisherIds].sort() };
      return {
        status: 'success',
        summary: `${news.sourceProvider}에서 안전하게 제공할 수 있는 최신 뉴스 ${news.itemCount}건을 읽기 전용으로 조회했습니다.${withheldCount ? ` 이용 조건 미확인 출처 ${withheldCount}건은 내용 전달을 제한했습니다.` : ''}`,
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        readOnly: true,
        headlines: news.items,
        news,
        evidence: { news }
      };
    } catch (error) {
      return failureResult({
        status: 'failed',
        code: error?.code ?? 'B_NEWS_FETCH_FAILED',
        summary: cleanText(error?.message, 300) ?? '뉴스를 가져오지 못했습니다.',
        news: error?.evidence ?? {
          live: false,
          replay: false,
          fixture: false,
          fetched: false,
          retrievedAt: null,
          sourceUrl: shadow.sourceUrl,
          sourceHost: 'news.google.com',
          query: shadow.query,
          category: shadow.category,
          maxResults: shadow.maxResults,
          itemCount: 0,
          items: []
        }
      });
    }
  }
}

export function parseGoogleNewsRss(xml, { maxResults = 5 } = {}) {
  const text = String(xml ?? '');
  if (!/<(?:rss|feed)\b/iu.test(text)) {
    throw newsError('B_NEWS_UPSTREAM_XML_INVALID', '뉴스 RSS 응답 XML이 올바르지 않습니다.');
  }
  const limit = clampInteger(maxResults, 1, 10, 5);
  const itemBlocks = text.match(/<item\b[^>]*>[\s\S]*?<\/item>/giu) ?? [];
  const parsed = itemBlocks.map((block) => parseRssItem(block)).filter(Boolean);
  parsed.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return parsed.slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
}

/** Parse public publisher RSS 2.0 or Atom feeds, requiring safe direct HTTPS article links. */
export function parsePublisherRss(xml, { maxResults = 5, fallbackSource = null } = {}) {
  const text = String(xml ?? '');
  const limit = clampInteger(maxResults, 1, 10, 5);
  let parsed;
  if (/<rss\b/iu.test(text)) {
    const channel = text.match(/<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/iu)?.[1] ?? '';
    const channelTitle = cleanText(xmlTagText(channel, 'title'), 240) ?? cleanText(fallbackSource, 240);
    const itemBlocks = channel.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/giu) ?? [];
    parsed = itemBlocks.map((block) => parseRssItem(block, channelTitle, { requireDirectHttps: true }))
      .filter(Boolean);
  } else if (/<(?:[A-Za-z_][\w.-]*:)?feed\b/iu.test(text)) {
    parsed = parseAtomPublisherFeed(text, fallbackSource);
  } else {
    throw newsError('B_NEWS_UPSTREAM_XML_INVALID', '게시자 RSS 또는 Atom 응답이 아닙니다.');
  }
  parsed.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return parsed.slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
}

function parseAtomPublisherFeed(text, fallbackSource) {
  const feed = text.match(/<(?:[A-Za-z_][\w.-]*:)?feed\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?feed\s*>/iu)?.[1] ?? '';
  const feedTitle = cleanText(xmlLocalTagText(feed, 'title'), 240) ?? cleanText(fallbackSource, 240);
  const entries = feed.match(/<(?:[A-Za-z_][\w.-]*:)?entry\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?entry\s*>/giu) ?? [];
  return entries.map(entry => {
    const title = cleanText(xmlLocalTagText(entry, 'title'), 500);
    const url = parseAtomAlternateUrl(entry);
    const published = xmlLocalTagText(entry, 'published') || xmlLocalTagText(entry, 'updated');
    const publishedTime = parsePublishedTimestamp(published);
    if (!title || !url || !Number.isFinite(publishedTime) || !feedTitle || !isSafePublisherArticleUrl(url)) return null;
    const rssDescription = cleanText(xmlLocalTagText(entry, 'summary') || xmlLocalTagText(entry, 'content'), 1_000);
    return { title, url, publishedAt: new Date(publishedTime).toISOString(), source: feedTitle, sourceUrl: null,
      ...(rssDescription ? { rssDescription } : {}) };
  }).filter(Boolean);
}

function parseAtomAlternateUrl(entry) {
  const tags = entry.match(/<(?:[A-Za-z_][\w.-]*:)?link\b[^>]*\/?>/giu) ?? [];
  for (const tag of tags) {
    const attributes = tag.replace(/^<[^\s>]+/u, '').replace(/\/?\s*>$/u, '');
    const rel = xmlAttribute(attributes, 'rel') || 'alternate';
    if (rel !== 'alternate') continue;
    const url = cleanUrl(xmlAttribute(attributes, 'href'));
    if (url && isSafePublisherArticleUrl(url)) return url;
  }
  return null;
}

function xmlLocalTagText(block, localName) {
  const match = String(block ?? '').match(new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${localName}>`, 'iu'));
  if (!match) return '';
  return decodeXml(match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1'));
}

export function normalizeNewsCategory(value) {
  const normalized = String(value ?? 'top').trim().toLowerCase();
  return CATEGORY_ALIASES[normalized] ?? null;
}

function parseRssItem(block, defaultSource = null, { requireDirectHttps = false } = {}) {
  const title = cleanText(xmlTagText(block, 'title'), 500);
  const url = cleanUrl(xmlTagText(block, 'link'));
  const published = xmlTagText(block, 'pubDate') || xmlTagText(block, 'dc:date');
  const publishedTime = parsePublishedTimestamp(published);
  const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/iu);
  const source = cleanText(decodeXml(sourceMatch?.[2] ?? ''), 240) ?? defaultSource;
  const sourceUrl = cleanUrl(xmlAttribute(sourceMatch?.[1] ?? '', 'url'));
  const rssDescription = cleanText(xmlTagText(block, 'description'), 1_000);
  if (!title || !url || !Number.isFinite(publishedTime) || !source) return null;
  if (requireDirectHttps && (!isSafePublisherArticleUrl(url))) return null;
  return {
    title,
    url,
    publishedAt: new Date(publishedTime).toISOString(),
    source,
    sourceUrl,
    ...(rssDescription ? { rssDescription } : {})
  };
}

function parsePublishedTimestamp(value) {
  const timestamp = String(value ?? '').trim();
  if (!timestamp || !/(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT))$/iu.test(timestamp)) return Number.NaN;
  return Date.parse(timestamp);
}

function isSafePublisherArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && url.hostname.toLowerCase() !== 'news.google.com';
  } catch { return false; }
}

function xmlTagText(block, tagName) {
  const match = String(block ?? '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'iu'));
  if (!match) return '';
  return decodeXml(match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1'));
}

function xmlAttribute(attributes, name) {
  const match = String(attributes ?? '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'));
  return decodeXml(match?.[1] ?? match?.[2] ?? '');
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, decimal) => safeCodePoint(Number(decimal)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, hexadecimal) => safeCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&amp;/g, '&')
    .replace(/<(script|style|iframe|object|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(value) {
  try {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
  } catch {
    return '';
  }
}

function cleanQuery(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cleanText(value, maxLength) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function validateEndpoint(value) {
  const url = new URL(String(value ?? ''));
  if (url.protocol !== 'https:' || url.hostname !== 'news.google.com' || url.username || url.password || url.port) {
    throw new TypeError('Google News RSS endpoint must be https://news.google.com/.');
  }
  return url.href.replace(/\/$/u, '');
}

function assertGoogleNewsResponseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.hostname !== 'news.google.com' || url.username || url.password) {
    throw newsError('B_NEWS_UPSTREAM_REDIRECT_REJECTED', '뉴스 RSS가 허용되지 않은 호스트로 이동했습니다.');
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function newsError(code, message, evidence = null) {
  const error = new Error(message);
  error.code = code;
  error.evidence = evidence;
  return error;
}

function failureResult({ status, code, summary, news }) {
  return {
    status,
    error: code,
    errorCode: code,
    summary,
    outputPaths: [],
    changedItems: [],
    rollbackAvailable: false,
    readOnly: true,
    headlines: news?.items ?? [],
    news,
    evidence: { news }
  };
}
