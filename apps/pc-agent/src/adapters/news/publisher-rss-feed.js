import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { isPublicAddress, validateArticleUrl } from './publisher-article-reader.js';
import { parsePublisherRss } from './google-news-rss.js';
import { findNewsPublisherByUrl, isNewsPublisherAiProcessingRestricted } from '../../../../../packages/core/src/routing/news-publisher-catalog.js';

const MAXIMUM_FEED_BYTES = 2 * 1024 * 1024;
const MAXIMUM_REDIRECTS = 4;

/** A bounded, unauthenticated RSS reader with DNS pinning and public-address checks per hop. */
export class PublisherRssFeedClient {
  constructor({ lookupImpl = dnsLookup, requestImpl = httpsRequest, clock = () => new Date(),
    timeoutMs = 10_000, maximumBytes = MAXIMUM_FEED_BYTES, maximumRedirects = MAXIMUM_REDIRECTS } = {}) {
    if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function' || typeof clock !== 'function') {
      throw new TypeError('PublisherRssFeedClient requires DNS, HTTPS and clock functions.');
    }
    this.lookupImpl = lookupImpl;
    this.requestImpl = requestImpl;
    this.clock = clock;
    this.timeoutMs = integerLimit(timeoutMs, 500, 30_000, 10_000);
    this.maximumBytes = integerLimit(maximumBytes, 16_384, MAXIMUM_FEED_BYTES, MAXIMUM_FEED_BYTES);
    this.maximumRedirects = integerLimit(maximumRedirects, 0, MAXIMUM_REDIRECTS, MAXIMUM_REDIRECTS);
    this.live = lookupImpl === dnsLookup && requestImpl === httpsRequest;
  }

  async fetchFeed(inputUrl, { maxResults = 5 } = {}) {
    let requestedUrl;
    try { requestedUrl = validateArticleUrl(inputUrl); }
    catch (error) { throw feedError('B_NEWS_FEED_URL_REJECTED', error?.code); }
    const itemsLimit = integerLimit(maxResults, 1, 10, 5);
    const retrievedAt = this.clock().toISOString();
    let currentUrl = requestedUrl;
    const visited = new Set();
    let response;
    for (let hop = 0; ; hop += 1) {
      if (visited.has(currentUrl.href)) throw feedError('B_NEWS_FEED_REDIRECT_LOOP');
      visited.add(currentUrl.href);
      const addresses = await this.resolvePublicAddresses(currentUrl.hostname);
      response = await pinnedGet({ url: currentUrl, address: addresses[0], requestImpl: this.requestImpl,
        timeoutMs: this.timeoutMs, maximumBytes: this.maximumBytes });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
      if (hop >= this.maximumRedirects) throw feedError('B_NEWS_FEED_REDIRECT_LIMIT');
      const location = response.headers.location;
      if (!location) throw feedError('B_NEWS_FEED_REDIRECT_INVALID');
      try { currentUrl = validateArticleUrl(new URL(location, currentUrl).href); }
      catch (error) { throw feedError('B_NEWS_FEED_REDIRECT_REJECTED', error?.code); }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw feedError('B_NEWS_FEED_HTTP_ERROR', null, { httpStatus: response.statusCode });
    }
    const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'].includes(contentType)) {
      throw feedError('B_NEWS_FEED_CONTENT_TYPE_REJECTED', null, { contentType: contentType.slice(0, 100) });
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      throw feedError('B_NEWS_FEED_CONTENT_ENCODING_REJECTED');
    }
    const body = response.body.toString('utf8');
    let items;
    try { items = parsePublisherRss(body, { maxResults: itemsLimit, fallbackSource: currentUrl.hostname }); }
    catch (error) { throw feedError(error?.code ?? 'B_NEWS_FEED_INVALID'); }
    if (!items.length) throw feedError('B_NEWS_FEED_EMPTY');
    return {
      feedVersion: 'jarvis-publisher-rss-v1', sourceProvider: 'Publisher RSS',
      sourceUrl: requestedUrl.href, feedUrl: requestedUrl.href, finalFeedUrl: currentUrl.href,
      sourceHost: currentUrl.hostname, requestedAt: retrievedAt, retrievedAt,
      method: 'GET', live: this.live, replay: !this.live, fixture: !this.live, fetched: true,
      httpStatus: response.statusCode, responseBytes: response.body.length,
      maxResults: itemsLimit, itemCount: items.length, items
    };
  }

  async resolvePublicAddresses(hostname) {
    if (isIP(hostname)) {
      if (!isPublicAddress(hostname)) throw feedError('B_NEWS_FEED_PRIVATE_ADDRESS_REJECTED');
      return [hostname];
    }
    let records;
    try { records = await bounded(this.lookupImpl(hostname, { all: true, order: 'verbatim' }), this.timeoutMs); }
    catch (error) {
      if (error?.code === 'B_NEWS_FEED_DNS_TIMEOUT') throw error;
      throw feedError('B_NEWS_FEED_DNS_FAILED');
    }
    if (!Array.isArray(records) || records.length === 0 || records.some(record => !isPublicAddress(record.address))) {
      throw feedError('B_NEWS_FEED_PRIVATE_ADDRESS_REJECTED');
    }
    return records.map(record => record.address);
  }
}

export class NewsFetchPublisherFeedToolAdapter {
  constructor({ client = new PublisherRssFeedClient() } = {}) {
    this.client = client;
    this.contract = {
      toolName: 'news.fetchPublisherFeed', readOnly: true, mutatesSystem: false, externalNetwork: true,
      externalTransfer: false, preview: true, execute: true, rollback: false,
      trustBoundary: 'WEB_CONTENT', evidence: ['news.live', 'news.feedUrl', 'news.finalFeedUrl', 'news.items'],
      blockedOperations: ['post', 'downloadToDisk', 'formSubmit', 'credentialEntry', 'privateAddress', 'nonHttps', 'publisherAiUseWithoutRights'],
      modes: ['shadow', 'execute']
    };
  }

  shadow(args = {}) {
    const warnings = [];
    let url = null;
    try { url = validateArticleUrl(args.feedUrl).href; }
    catch { warnings.push('invalid-public-feed-url'); }
    if (url && isNewsPublisherAiProcessingRestricted(findNewsPublisherByUrl(url))) warnings.push('publisher-ai-use-rights-not-cleared');
    if (!url) return { mode: 'shadow', expectedChangesCount: 0, readOnly: true, externalNetwork: true,
      method: 'GET', feedUrl: null, blockedOperations: [...this.contract.blockedOperations], warnings };
    return { mode: 'shadow', expectedChangesCount: 0, readOnly: true, externalNetwork: true,
      method: 'GET', feedUrl: url, blockedOperations: [...this.contract.blockedOperations], warnings };
  }

  async execute(args = {}) {
    const preview = this.shadow(args);
    if (preview.warnings.includes('publisher-ai-use-rights-not-cleared')) {
      return feedFailure('blocked', 'B_NEWS_SOURCE_AI_USE_RESTRICTED',
        '게시자가 AI 학습·활용 제한을 고지한 출처라, 사용권한이 확인될 때까지 JARVIS가 내용을 읽거나 요약하지 않습니다.');
    }
    if (preview.warnings.length) return feedFailure('blocked', 'B_NEWS_FEED_URL_REJECTED', '공개 HTTPS RSS 주소만 읽을 수 있습니다.');
    try {
      const news = await this.client.fetchFeed(preview.feedUrl, { maxResults: args.maxResults });
      if (news.live !== true || news.replay === true || news.fixture === true) {
        return feedFailure('blocked', 'B_NEWS_NON_LIVE_SOURCE_REJECTED', '격리 피드 응답은 실시간 뉴스 조회로 기록하지 않았습니다.', news);
      }
      return { status: 'success', summary: `게시자 RSS에서 기사 ${news.itemCount}건을 읽기 전용으로 조회했습니다.`,
        outputPaths: [], changedItems: [], rollbackAvailable: false, readOnly: true, externalNetwork: true,
        headlines: news.items, news, evidence: { news } };
    } catch (error) {
      return feedFailure('failed', error?.code ?? 'B_NEWS_FEED_UNAVAILABLE', '게시자 RSS를 읽지 못했습니다.', error?.evidence ?? null);
    }
  }
}

function pinnedGet({ url, address, requestImpl, timeoutMs, maximumBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = requestImpl({ protocol: 'https:', hostname: url.hostname, servername: url.hostname,
      port: 443, path: `${url.pathname}${url.search}`, method: 'GET', timeout: timeoutMs, maxHeaderSize: 16_384,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [{ address, family: isIP(address) }]) : callback(null, address, isIP(address)),
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'accept-encoding': 'identity', 'user-agent': 'JARVIS-Local-Assistant/1.0 (bounded public RSS read)' }
    }, incoming => {
      const chunks = [];
      let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > maximumBytes) { request.destroy(feedError('B_NEWS_FEED_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      incoming.once('error', error => finish(error));
      incoming.once('end', () => finish(null, { statusCode: Number(incoming.statusCode ?? 0),
        headers: incoming.headers ?? {}, body: Buffer.concat(chunks) }));
    });
    timer = setTimeout(() => request.destroy(feedError('B_NEWS_FEED_TIMEOUT')), timeoutMs);
    request.once('timeout', () => request.destroy(feedError('B_NEWS_FEED_TIMEOUT')));
    request.once('error', error => finish(error?.code?.startsWith?.('B_NEWS_FEED_') ? error : feedError('B_NEWS_FEED_NETWORK_ERROR')));
    request.end();
  });
}

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(feedError('B_NEWS_FEED_DNS_TIMEOUT')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function integerLimit(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}
function feedError(code, _cause, details = {}) { return Object.assign(new Error(code), { code, details }); }
function feedFailure(status, code, summary, news = null) {
  const evidence = news && typeof news === 'object' ? news : { live: false, fetched: false, feedUrl: null, itemCount: 0, items: [] };
  return { status, error: code, errorCode: code, summary, outputPaths: [], changedItems: [], rollbackAvailable: false,
    readOnly: true, externalNetwork: true, headlines: evidence.items ?? [], news: evidence, evidence: { news: evidence } };
}
