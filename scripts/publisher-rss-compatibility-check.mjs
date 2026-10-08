import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublisherRssFeedClient } from '../apps/pc-agent/src/adapters/news/publisher-rss-feed.js';

const feeds = [
  { id: 'newsis', feedUrl: 'https://nwww.newsis.com/RSS/sokbo.xml', officialInfo: 'https://nwww.newsis.com/RSS/', terms: 'official_feed_terms_not_independently_verified' },
  { id: 'sbs', feedUrl: 'https://news.sbs.co.kr/news/newsflashRssFeed.do?plink=RSSREADER', officialInfo: 'https://news.sbs.co.kr/news/rss.do', terms: 'personal_noncommercial_only_prior_agreement_for_commercial_use' },
  { id: 'khan', feedUrl: 'https://www.khan.co.kr/rss/rssdata/total_news.xml', officialInfo: 'https://www.khan.co.kr/help/help_rss.html', terms: 'personal_subscription_only_public_or_commercial_redistribution_requires_permission' },
  { id: 'mk', feedUrl: 'https://www.mk.co.kr/rss/30000001/', officialInfo: 'https://www.mk.co.kr/rss', terms: 'rss_listed_official_reuse_rights_not_independently_verified' },
  { id: 'korea-net', feedUrl: 'https://www.korea.net/koreanet/rss/news/2', officialInfo: 'https://www.korea.net/Others/Subscribe-to-Koreanet/RSS-Service', terms: 'official_feed_terms_not_independently_verified' },
  { id: 'kosis', feedUrl: 'https://kosis.kr/rss/notice_rss.jsp', officialInfo: 'https://kosis.kr/serviceInfo/rssGuide.do', terms: 'official_statistics_rss_use_conditions_review_required' },
  { id: 'mss', feedUrl: 'https://mss.go.kr/rss/smba/board/86.do', officialInfo: 'https://www.mss.go.kr/site/smba/contents/view.do?menuCd=20905000000002024122902&siteCd=smba', terms: 'public_ministry_feed_reuse_conditions_review_required' },
  { id: 'bok', feedUrl: 'https://www.bok.or.kr/portal/bbs/P0000559/news.rss?menuNo=200690', officialInfo: 'https://www.bok.or.kr/static/guide/portal/popup/rss_popup.html', terms: 'official_bank_feed_reuse_conditions_review_required' }
];

const client = new PublisherRssFeedClient({ timeoutMs: 9000, maximumBytes: 1_000_000 });
const observedAt = new Date().toISOString();
const results = [];
for (const feed of feeds) {
  try {
    const result = await client.fetchFeed(feed.feedUrl, { maxResults: 10 });
    const directHttpsArticleLinks = result.items.filter(item => {
      try { const url = new URL(item.url); return url.protocol === 'https:' && url.hostname !== 'news.google.com'; }
      catch { return false; }
    }).length;
    results.push({ ...feed, outcome: 'parsed', live: result.live, httpStatus: result.httpStatus,
      finalHost: result.sourceHost, itemCount: result.itemCount, directHttpsArticleLinks,
      responseBytes: result.responseBytes, articleBodiesFetched: false, titlesOrSnippetsPersisted: false });
  } catch (error) {
    results.push({ ...feed, outcome: 'failed', code: error?.code ?? 'B_NEWS_FEED_UNAVAILABLE',
      httpStatus: error?.details?.httpStatus ?? null, itemCount: 0, articleBodiesFetched: false,
      titlesOrSnippetsPersisted: false });
  }
}
const artifact = { schema: 'jarvis-publisher-rss-compatibility-v1', observedAt,
  method: 'bounded read-only HTTPS GET using production PublisherRssFeedClient; no article pages opened',
  limits: ['one observation per feed', '10 items maximum held transiently in memory',
    'no titles, descriptions, article body, or credentials written to evidence',
    'feed reachability and parser acceptance do not establish republication rights or publisher-wide compatibility'],
  results };
const outDir = resolve('artifacts/agent-platform-20260928');
mkdirSync(outDir, { recursive: true });
const runId = observedAt.replace(/[-:.]/gu, '');
const outPath = join(outDir, `publisher-rss-compatibility-${runId}.json`);
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ observedAt, evidencePath: outPath,
  results: results.map(({ id, outcome, code, httpStatus, finalHost, itemCount, directHttpsArticleLinks }) =>
    ({ id, outcome, ...(code ? { code } : {}), httpStatus, finalHost, itemCount, directHttpsArticleLinks })) }, null, 2));
