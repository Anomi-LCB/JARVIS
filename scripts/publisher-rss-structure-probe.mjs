import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublisherRssFeedClient } from '../apps/pc-agent/src/adapters/news/publisher-rss-feed.js';

const targets = [
  { id: 'khan', feedUrl: 'https://www.khan.co.kr/rss/rssdata/total_news.xml' },
  { id: 'mss', feedUrl: 'https://mss.go.kr/rss/smba/board/86.do' }
];
const diagnostics = [];
const observedAt = new Date().toISOString();
const observingRequest = (options, callback) => request(options, incoming => {
  const chunks = [];
  incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
  incoming.once('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const tagCount = name => (body.match(new RegExp(`<${name}(?:\\s|>)`, 'giu')) ?? []).length;
    diagnostics.push({ httpStatus: Number(incoming.statusCode ?? 0),
      contentType: String(incoming.headers?.['content-type'] ?? '').slice(0, 100),
      responseBytes: Buffer.byteLength(body),
      xmlDeclaration: /^\s*(?:\uFEFF)?<\?xml\b/iu.test(body),
      root: body.match(/<([A-Za-z_:][\w:.-]*)\b/u)?.[1] ?? null,
      counts: Object.fromEntries(['rss', 'feed', 'channel', 'item', 'entry', 'title', 'link', 'pubDate', 'date', 'updated', 'published', 'source', 'author']
        .map(name => [name, tagCount(name)])),
      channelHasTitle: Boolean(body.match(/<channel\b[^>]*>[\s\S]*?<title\b[^>]*>\s*[^<]/iu)),
      namespaceDateTagCount: (body.match(/<dc:date\b/giu) ?? []).length,
      itemFieldProfile: (() => {
        const blocks = body.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/giu) ?? [];
        const counts = { total: blocks.length, titlePresent: 0, linkPresent: 0, linkHttps: 0,
          pubDatePresent: 0, pubDateNonEmpty: 0, pubDateParseable: 0, pubDateIsoLike: 0,
          pubDateRfcLike: 0, pubDateLength6To16: 0, pubDateLength17Plus: 0,
          pubDateCompact8Digits: 0, pubDateYearDotDate: 0, pubDateYearSlashDate: 0,
          pubDateDigitsOnly: 0, pubDateKoreanDateLike: 0,
          sourcePresent: 0, sourceUrlPresent: 0 };
        const numericDateLengths = {};
        for (const block of blocks) {
          const field = name => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'iu'))?.[1] ?? '';
          const title = field('title').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1').trim();
          const link = field('link').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1').trim();
          const date = field('pubDate').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1').trim();
          const source = field('source').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1').trim();
          counts.titlePresent += Number(Boolean(title));
          counts.linkPresent += Number(Boolean(link));
          try { counts.linkHttps += Number(new URL(link).protocol === 'https:' && !new URL(link).username && !new URL(link).password && new URL(link).hostname !== 'news.google.com'); }
          catch { /* report only aggregate link classification */ }
          counts.pubDatePresent += Number(Boolean(date));
          counts.pubDateNonEmpty += Number(Boolean(date));
          counts.pubDateParseable += Number(Number.isFinite(Date.parse(date)));
          counts.pubDateIsoLike += Number(/^\d{4}-\d\d-\d\d(?:T|\s)/u.test(date));
          counts.pubDateRfcLike += Number(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s/u.test(date));
          counts.pubDateLength6To16 += Number(date.length >= 6 && date.length <= 16);
          counts.pubDateLength17Plus += Number(date.length >= 17);
          counts.pubDateCompact8Digits += Number(/^\d{8}$/u.test(date));
          counts.pubDateYearDotDate += Number(/^\d{4}\.\d{1,2}\.\d{1,2}$/u.test(date));
          counts.pubDateYearSlashDate += Number(/^\d{4}\/\d{1,2}\/\d{1,2}$/u.test(date));
          counts.pubDateDigitsOnly += Number(/^\d+$/u.test(date));
          if (/^\d+$/u.test(date)) numericDateLengths[date.length] = (numericDateLengths[date.length] ?? 0) + 1;
          counts.pubDateKoreanDateLike += Number(/^\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/u.test(date));
          counts.sourcePresent += Number(Boolean(source));
          counts.sourceUrlPresent += Number(/<source\b[^>]*\burl\s*=/iu.test(block));
        }
        return { ...counts, numericDateLengths };
      })(),
      containsAtomHrefLinks: /<link\b[^>]*\bhref\s*=/iu.test(body),
      containsCdata: /<!\[CDATA\[/iu.test(body),
      encoding: body.startsWith('\uFEFF') ? 'UTF-8-BOM' : 'utf8-decoded',
      contentPersisted: false, titlesPersisted: false });
  });
  callback(incoming);
});
const client = new PublisherRssFeedClient({ lookupImpl: lookup, requestImpl: observingRequest, timeoutMs: 9000 });
const results = [];
for (const target of targets) {
  const before = diagnostics.length;
  try { await client.fetchFeed(target.feedUrl, { maxResults: 10 }); results.push({ id: target.id, outcome: 'parsed' }); }
  catch (error) { results.push({ id: target.id, outcome: 'failed', code: error?.code ?? 'B_NEWS_FEED_UNAVAILABLE' }); }
  results[results.length - 1].responseProfile = diagnostics[before] ?? null;
}
const artifact = { schema: 'jarvis-publisher-rss-redacted-structure-probe-v1', observedAt,
  purpose: 'Diagnose zero-item parser outcomes from official feeds without retaining titles, descriptions, item values, or body text.',
  transportNote: 'The production request path and DNS-pinned lookup were used through an observation wrapper; the wrapper means adapter evidence is marked non-live and is not product success evidence.',
  targets: results,
  limitations: ['two endpoints only', 'single observation per endpoint', 'tag counts do not establish feed semantics or publisher permissions'] };
const outDir = resolve('artifacts/agent-platform-20260928');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'publisher-rss-redacted-structure-probe-followup5-20260928.json');
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ observedAt, evidencePath: outPath, targets: results }, null, 2));
