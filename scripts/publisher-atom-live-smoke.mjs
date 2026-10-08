import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublisherRssFeedClient } from '../apps/pc-agent/src/adapters/news/publisher-rss-feed.js';

const source = { feedUrl: 'https://github.com/google/artemis/commits/main.atom',
  officialInfo: 'https://github.com/google/artemis' };
const observedAt = new Date().toISOString();
const outDir = resolve('artifacts/agent-platform-20260928');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `publisher-atom-live-smoke-${observedAt.replace(/[-:.]/gu, '')}.json`);
try {
  const feed = await new PublisherRssFeedClient({ timeoutMs: 10_000 }).fetchFeed(source.feedUrl, { maxResults: 10 });
  const evidence = { schema: 'jarvis-publisher-atom-live-smoke-v1', observedAt,
    officialInfo: source.officialInfo, feedUrl: source.feedUrl, finalFeedUrl: feed.finalFeedUrl,
    httpStatus: feed.httpStatus, liveTransport: feed.live, itemCount: feed.itemCount,
    directHttpsLinkCount: feed.items.filter(item => item.url.startsWith('https://')).length,
    articlePagesOpened: false, titlesOrDescriptionsPersisted: false,
    scope: 'one read-only official repository Atom feed observation; not a news-summary or product readiness test' };
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'parsed', evidencePath: outPath, httpStatus: evidence.httpStatus,
    itemCount: evidence.itemCount, directHttpsLinkCount: evidence.directHttpsLinkCount }, null, 2));
} catch (error) {
  const evidence = { schema: 'jarvis-publisher-atom-live-smoke-v1', observedAt,
    officialInfo: source.officialInfo, feedUrl: source.feedUrl, status: 'failed',
    errorCode: error?.code ?? 'B_NEWS_FEED_UNAVAILABLE', articlePagesOpened: false,
    titlesOrDescriptionsPersisted: false };
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'failed', evidencePath: outPath, errorCode: evidence.errorCode }, null, 2));
  process.exitCode = 1;
}
