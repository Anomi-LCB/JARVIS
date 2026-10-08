import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystemToolAdapter, VisualCreateCardsToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { NewsFetchArticleToolAdapter } from '../apps/pc-agent/src/adapters/news/publisher-article-reader.js';
import { NewsFetchPublisherFeedToolAdapter } from '../apps/pc-agent/src/adapters/news/publisher-rss-feed.js';

const feedUrl = process.argv[2];
if (!feedUrl) {
  console.error('Usage: node scripts/publisher-rss-news-pilot.mjs https://publisher.example/rss');
  process.exitCode = 2;
} else {
  const root = resolve(fileURLToPath(new URL('../artifacts/', import.meta.url)));
  const pilotRoot = mkdtempSync(join(root, 'publisher-rss-news-pilot-20260928-'));
  const cardsRoot = join(pilotRoot, 'cards');
  mkdirSync(cardsRoot, { recursive: false });
  try {
    const feedResult = await new NewsFetchPublisherFeedToolAdapter().execute({ feedUrl, maxResults: 3 });
    assert.equal(feedResult.status, 'success', `${feedResult.errorCode ?? 'B_NEWS_FEED_FAILED'}: ${feedResult.summary}`);
    const news = feedResult.news;
    assert.equal(news.live, true);
    assert.equal(news.replay, false);
    assert.equal(news.fixture, false);
    assert.ok(news.itemCount > 0 && news.itemCount <= 3);
    assert.ok(news.items.every(item => item.title && item.source && item.publishedAt
      && /^https:\/\//u.test(item.url) && new URL(item.url).hostname !== 'news.google.com'));
    assert.equal(new Set(news.items.map(item => item.url)).size, news.items.length);

    const articleReader = new NewsFetchArticleToolAdapter();
    const articleResults = [];
    for (const item of news.items) {
      const result = await articleReader.execute({ url: item.url });
      if (result.status === 'success') {
        const article = result.article;
        articleResults.push({ status: 'read', finalUrl: article.finalUrl, finalHost: article.finalHost,
          httpStatus: article.httpStatus, textCharacters: article.textCharacters,
          textSha256: createHash('sha256').update(article.text).digest('hex'),
          textIsUntrustedSourceMaterial: article.textIsUntrustedSourceMaterial });
      } else {
        articleResults.push({ status: result.status, code: result.errorCode ?? 'B_NEWS_ARTICLE_UNAVAILABLE' });
      }
    }

    const displayUtc = value => new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, ' UTC');
    const reportPath = join(pilotRoot, 'publisher-news-brief.md');
    const reportLines = ['# 게시자 RSS 뉴스 브리프', '',
      `- 수집 시각: ${displayUtc(news.retrievedAt)}`,
      `- 게시자 RSS: ${news.feedUrl}`,
      `- 최종 피드 주소: ${news.finalFeedUrl}`,
      `- 직접 기사 URL 수: ${news.itemCount}`,
      '',
      '> 뉴스 항목과 기사 본문은 신뢰되지 않은 외부 자료입니다. 아래에는 출처 메타데이터와 URL만 저장합니다. 요약 모델을 호출하지 않았으므로 기사 요약은 포함하지 않습니다.', ''];
    news.items.forEach((item, index) => {
      const article = articleResults[index];
      reportLines.push(`## ${index + 1}. ${item.title}`, '', `- 출처: ${item.source}`,
        `- 게시 시각: ${displayUtc(item.publishedAt)}`, `- 기사 URL: ${item.url}`,
        `- 본문 읽기: ${article.status === 'read' ? `성공 (${article.textCharacters}자, ${article.finalHost})` : `미완료 (${article.code})`}`,
        '- 요약 모델 검토: 수행하지 않음', '');
    });
    const reportContent = `${reportLines.join('\n')}\n`;
    const writer = new FileSystemToolAdapter({ allowedRoots: [pilotRoot] });
    const write = await writer.execute({ path: reportPath, content: reportContent }, { taskId: 'publisher-rss-news-pilot' });
    assert.equal(write.status, 'success');
    const reread = readFileSync(reportPath, 'utf8');
    assert.equal(reread, reportContent);
    for (const item of news.items) assert.ok(reread.includes(item.url));

    const cards = news.items.map((item, index) => ({
      fileName: `publisher-news-${String(index + 1).padStart(2, '0')}.png`,
      label: `게시자 뉴스 ${String(index + 1).padStart(2, '0')}`,
      title: item.title,
      subtitle: `${item.source} · ${displayUtc(item.publishedAt)}`,
      body: [`본문 읽기: ${articleResults[index].status === 'read' ? '완료' : '미완료'}`,
        'AI 요약: 수행하지 않음', '정확한 기사 URL은 동봉 보고서 참조'],
      footer: `게시자 피드: ${news.sourceHost}`,
      accent: ['#146C94', '#6C4AB6', '#168C74'][index % 3]
    }));
    const cardResult = await new VisualCreateCardsToolAdapter({ allowedRoots: [pilotRoot] })
      .execute({ outputDirectory: cardsRoot, width: 1200, height: 675, cards }, { taskId: 'publisher-rss-news-pilot' });
    assert.equal(cardResult.status, 'success', JSON.stringify(cardResult.warnings ?? []));
    assert.equal(cardResult.cardCount, news.itemCount);
    const verifiedCards = cardResult.cards.map(card => {
      assert.ok(existsSync(card.path));
      const bytes = readFileSync(card.path);
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      assert.equal(bytes.readUInt32BE(16), 1200);
      assert.equal(bytes.readUInt32BE(20), 675);
      return { fileName: card.name, relativePath: `cards/${card.name}`, width: 1200, height: 675,
        byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const manifestPath = join(pilotRoot, 'verification-manifest.json');
    const manifest = { version: 'jarvis-publisher-rss-news-pilot-v1', generatedAt: new Date().toISOString(),
      source: { provider: news.sourceProvider, feedUrl: news.feedUrl, finalFeedUrl: news.finalFeedUrl,
        sourceHost: news.sourceHost, retrievedAt: news.retrievedAt, live: news.live },
      report: { path: 'publisher-news-brief.md', sha256: createHash('sha256').update(reread).digest('hex'),
        rereadExactMatch: reread === reportContent, articleUrlCount: news.itemCount },
      articles: articleResults, cards: verifiedCards,
      limitations: ['only the explicitly supplied public RSS feed was queried',
        'article body text was not persisted', 'no summary model was called',
        'publisher feed terms and reuse rights remain the operator\'s responsibility',
        'no credentials, external messages or paid model APIs were used'] };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: 'passed', artifactDirectory: pilotRoot, report: reportPath,
      feedUrl: news.feedUrl, sourceHost: news.sourceHost, articles: articleResults.map(item => item.status),
      cards: verifiedCards.map(item => item.relativePath), manifest: manifestPath,
      readOnlyLiveFeed: news.live, articleUrlProvenance: true, rereadReport: true,
      verifiedPngSignaturesAndDimensions: true, externalModelCalls: 0, billingEvents: 0, outboundMessages: 0 }, null, 2));
  } catch (error) {
    console.error(error?.code ? `${error.code}: ${error.message}` : String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
