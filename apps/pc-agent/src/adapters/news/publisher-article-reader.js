import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import { findNewsPublisherByUrl, isNewsPublisherAiProcessingRestricted } from '../../../../../packages/core/src/routing/news-publisher-catalog.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

/**
 * Read a small amount of public publisher HTML without allowing the response to
 * choose a destination outside public HTTPS. DNS results are checked and the
 * socket is pinned to one of those exact checked addresses for each hop.
 */
export class PublisherArticleReader {
  constructor({ lookupImpl = dnsLookup, requestImpl = httpsRequest, timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumBytes = DEFAULT_MAXIMUM_BYTES, maximumRedirects = MAX_REDIRECTS } = {}) {
    if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function') {
      throw new TypeError('PublisherArticleReader requires DNS lookup and HTTPS request functions.');
    }
    this.lookupImpl = lookupImpl;
    this.requestImpl = requestImpl;
    this.timeoutMs = clampInteger(timeoutMs, 500, 30_000, DEFAULT_TIMEOUT_MS);
    this.maximumBytes = clampInteger(maximumBytes, 16_384, 4_000_000, DEFAULT_MAXIMUM_BYTES);
    this.maximumRedirects = clampInteger(maximumRedirects, 0, 6, MAX_REDIRECTS);
    this.live = lookupImpl === dnsLookup && requestImpl === httpsRequest;
  }

  async fetchArticle(inputUrl) {
    const visited = new Set();
    let currentUrl = validateArticleUrl(inputUrl);
    for (let hop = 0; ; hop += 1) {
      if (isNewsPublisherAiProcessingRestricted(findNewsPublisherByUrl(currentUrl.href))) {
        throw articleError('B_NEWS_ARTICLE_AI_USE_RESTRICTED');
      }
      if (visited.has(currentUrl.href)) throw articleError('B_NEWS_ARTICLE_REDIRECT_LOOP');
      visited.add(currentUrl.href);
      const addresses = await this.resolvePublicAddresses(currentUrl.hostname);
      const response = await requestOnce({
        url: currentUrl,
        address: addresses[0],
        requestImpl: this.requestImpl,
        timeoutMs: this.timeoutMs,
        maximumBytes: this.maximumBytes
      });
      if (isRedirect(response.statusCode)) {
        if (hop >= this.maximumRedirects) throw articleError('B_NEWS_ARTICLE_REDIRECT_LIMIT');
        const location = response.headers.location;
        if (!location) throw articleError('B_NEWS_ARTICLE_REDIRECT_INVALID');
        currentUrl = validateArticleUrl(new URL(location, currentUrl).href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw articleError('B_NEWS_ARTICLE_HTTP_ERROR', { httpStatus: response.statusCode });
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!['text/html', 'application/xhtml+xml'].includes(contentType)) {
        throw articleError('B_NEWS_ARTICLE_CONTENT_TYPE_REJECTED', { contentType: contentType.slice(0, 100) });
      }
      const decodedBody=decodeArticleBody(response.body,response.headers['content-encoding'],this.maximumBytes);
      const text = extractArticleText(decodedBody.toString('utf8'));
      if (text.length < 160) throw articleError('B_NEWS_ARTICLE_TEXT_UNAVAILABLE', {
        extractedCharacters: text.length, httpStatus: response.statusCode, contentType,
        title: extractTitle(decodedBody.toString('utf8')), finalUrl: currentUrl.href,
        finalHost: currentUrl.hostname,
        linkedHosts: extractExternalHosts(decodedBody.toString('utf8'), currentUrl.hostname)
      });
      return {
        status: 'success',
        live: this.live,
        requestedUrl: validateArticleUrl(inputUrl).href,
        finalUrl: currentUrl.href,
        finalHost: currentUrl.hostname,
        fetchedAt: new Date().toISOString(),
        httpStatus: response.statusCode,
        contentType,
        byteLength: response.body.length,
        decodedByteLength: decodedBody.length,
        title: extractTitle(decodedBody.toString('utf8')),
        text,
        textCharacters: text.length,
        textSha256: createHash('sha256').update(text).digest('hex'),
        textIsUntrustedSourceMaterial: true
      };
    }
  }

  async resolvePublicAddresses(hostname) {
    if (isIP(hostname)) {
      if (!isPublicAddress(hostname)) throw articleError('B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED');
      return [hostname];
    }
    let records;
    try {
      records = await withTimeout(this.lookupImpl(hostname, { all: true, order: 'verbatim' }), this.timeoutMs);
    } catch (error) {
      if (error?.code === 'B_NEWS_ARTICLE_DNS_TIMEOUT') throw error;
      throw articleError('B_NEWS_ARTICLE_DNS_FAILED');
    }
    if (!Array.isArray(records) || records.length === 0 || records.some(record => !isPublicAddress(record.address))) {
      throw articleError('B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED');
    }
    return records.map(record => record.address);
  }
}

function decodeArticleBody(body,encoding,maximumBytes){
 const name=String(encoding??'identity').trim().toLowerCase();
 if(name==='identity'||!name)return body;
 const decode={gzip:gunzipSync,deflate:inflateSync,br:brotliDecompressSync}[name];
 if(!decode)throw articleError('B_NEWS_ARTICLE_CONTENT_ENCODING_REJECTED');
 try{return decode(body,{maxOutputLength:maximumBytes});}
 catch(error){throw articleError(error?.code==='ERR_BUFFER_TOO_LARGE'
  ?'B_NEWS_ARTICLE_RESPONSE_TOO_LARGE':'B_NEWS_ARTICLE_CONTENT_DECODING_FAILED');}
}

export class NewsFetchArticleToolAdapter {
  constructor({ reader = new PublisherArticleReader() } = {}) {
    this.reader = reader;
    this.contract = {
      toolName: 'news.fetchArticle', readOnly: true, mutatesSystem: false, externalNetwork: true,
      externalTransfer: false, preview: true, execute: true, rollback: false,
      trustBoundary: 'WEB_CONTENT', evidence: ['article.live', 'article.finalUrl', 'article.textSha256', 'article.textCharacters'],
      blockedOperations: ['post', 'downloadToDisk', 'formSubmit', 'credentialEntry', 'privateAddress', 'nonHttps', 'publisherAiUseWithoutRights'],
      modes: ['shadow', 'execute']
    };
  }

  shadow(args = {}) {
    try {
      const url = validateArticleUrl(args.url);
      if (isNewsPublisherAiProcessingRestricted(findNewsPublisherByUrl(url.href))) {
        return { mode: 'shadow', expectedChangesCount: 0, readOnly: true, externalNetwork: true,
          method: 'GET', url: null, blockedOperations: [...this.contract.blockedOperations],
          warnings: ['B_NEWS_ARTICLE_AI_USE_RESTRICTED'] };
      }
      return { mode: 'shadow', expectedChangesCount: 0, readOnly: true, externalNetwork: true,
        method: 'GET', url: url.href, blockedOperations: [...this.contract.blockedOperations], warnings: [] };
    } catch (error) {
      return { mode: 'shadow', expectedChangesCount: 0, readOnly: true, externalNetwork: true,
        url: null, blockedOperations: [...this.contract.blockedOperations], warnings: [error.code ?? 'B_NEWS_ARTICLE_URL_REJECTED'] };
    }
  }

  async execute(args = {}) {
    const preview = this.shadow(args);
    if (preview.warnings.length) return articleFailure('blocked', preview.warnings[0],
      preview.warnings[0] === 'B_NEWS_ARTICLE_AI_USE_RESTRICTED'
        ? '게시자가 AI 학습·활용 제한을 고지한 출처라, 사용권한이 확인될 때까지 JARVIS가 기사 내용을 읽거나 요약하지 않습니다.'
        : '안전하지 않은 기사 주소라 읽기를 차단했습니다.');
    try {
      const article = await this.reader.fetchArticle(preview.url);
      return {
        status: 'success', summary: `공개 기사 본문을 읽었습니다 (${article.textCharacters}자). 외부 페이지의 내용은 신뢰되지 않은 원문입니다.`,
        outputPaths: [], changedItems: [], rollbackAvailable: false, readOnly: true, externalNetwork: true,
        article, evidence: { article }
      };
    } catch (error) {
      const code = error?.code ?? 'B_NEWS_ARTICLE_UNAVAILABLE';
      return articleFailure(isUnsafeArticleFailure(code) ? 'blocked' : 'failed', code,
        '기사 본문을 읽지 못했습니다. 본문 요약을 완료로 표시하지 않았습니다.', error?.details ?? {});
    }
  }
}

export function validateArticleUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw articleError('B_NEWS_ARTICLE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !url.hostname) {
    throw articleError('B_NEWS_ARTICLE_URL_REJECTED');
  }
  if (isIP(url.hostname) && !isPublicAddress(url.hostname)) throw articleError('B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED');
  url.hash = '';
  return url;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
    if (a === 192 && (b === 0 || b === 2) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0) return false;
    return true;
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  // Permit globally routed 2000::/3 only. Reject mapped/compatible addresses,
  // documentation, protocol-assignment, 6to4 and other transition ranges.
  if (!/^[23]/u.test(normalized) || normalized.startsWith('2001:db8:') || normalized.startsWith('2002:')) return false;
  if (/^2001:(?:0|0:[0-9a-f]*|0:0:)/u.test(normalized)) return false;
  return true;
}

export function extractArticleText(html) {
  let source = String(html ?? '').slice(0, DEFAULT_MAXIMUM_BYTES);
  source = source
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|template|svg|noscript|iframe|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ');
  const focused = source.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/iu)?.[1] ?? source;
  return decodeHtmlEntities(focused.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 12_000);
}

function extractTitle(html) {
  const match = String(html ?? '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu);
  return match ? decodeHtmlEntities(match[1].replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 300) : null;
}

function extractExternalHosts(html, currentHost) {
  const hosts = new Set();
  for (const match of String(html ?? '').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    try {
      const link = new URL(match[1] ?? match[2], `https://${currentHost}/`);
      if (link.protocol === 'https:' && link.hostname !== currentHost && !link.username && !link.password) hosts.add(link.hostname);
    } catch { /* ignore malformed publisher metadata */ }
    if (hosts.size >= 12) break;
  }
  return [...hosts];
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, decimal) => codePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/\s+/gu, ' ').trim();
}

function codePoint(value) {
  try { return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''; }
  catch { return ''; }
}

function requestOnce({ url, address, requestImpl, timeoutMs, maximumBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let absoluteTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      error ? reject(error) : resolve(value);
    };
    const request = requestImpl({
      protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
      path: `${url.pathname}${url.search}`, method: 'GET', timeout: timeoutMs, maxHeaderSize: 16_384,
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [{ address, family: isIP(address) }])
        : callback(null, address, isIP(address)),
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9', 'accept-encoding': 'identity',
        'user-agent': 'JARVIS-Local-Assistant/1.0 (bounded read-only public article retrieval)' }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maximumBytes) {
          request.destroy(articleError('B_NEWS_ARTICLE_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(null, {
        statusCode: Number(response.statusCode ?? 0), headers: response.headers ?? {}, body: Buffer.concat(chunks)
      }));
    });
    absoluteTimer = setTimeout(() => request.destroy(articleError('B_NEWS_ARTICLE_TIMEOUT')), timeoutMs);
    request.once('timeout', () => request.destroy(articleError('B_NEWS_ARTICLE_TIMEOUT')));
    request.once('error', error => finish(error?.code?.startsWith?.('B_NEWS_ARTICLE_') ? error : articleError('B_NEWS_ARTICLE_NETWORK_ERROR')));
    request.end();
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(articleError('B_NEWS_ARTICLE_DNS_TIMEOUT')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function isRedirect(statusCode) { return [301, 302, 303, 307, 308].includes(statusCode); }
function isUnsafeArticleFailure(code) {
  return /_(?:URL_INVALID|URL_REJECTED|PRIVATE_ADDRESS_REJECTED|REDIRECT_LOOP|REDIRECT_LIMIT|REDIRECT_INVALID|CONTENT_TYPE_REJECTED|CONTENT_ENCODING_REJECTED|RESPONSE_TOO_LARGE)$/u.test(code);
}
function articleFailure(status, code, summary, details = {}) {
  const article = { live: false, fetched: false, finalUrl: null, text: null, ...details };
  return { status, error: code, errorCode: code, summary, outputPaths: [], changedItems: [],
    rollbackAvailable: false, readOnly: true, externalNetwork: true, article, evidence: { article } };
}
function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}
function articleError(code, details = {}) { return Object.assign(new Error(code), { code, details }); }
