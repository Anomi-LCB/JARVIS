import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NewsFetchHeadlinesToolAdapter } from '../apps/pc-agent/src/adapters/news/google-news-rss.js';
import { NewsFetchArticleToolAdapter } from '../apps/pc-agent/src/adapters/news/publisher-article-reader.js';
import { FileSystemToolAdapter, UndoJournal, VisualCreateCardsToolAdapter, WordCreateToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { classifyNewsArtifactPilotOutcome } from './lib/news-artifact-pilot-outcome.mjs';
import { createNewsArtifactProjections } from './lib/news-artifact-projections.mjs';
import { verifyArtifactConsistency } from '../packages/core/src/mission/artifact-consistency.js';
import { createNewsFactsWorkbookBuffer, verifyNewsFactsWorkbook } from './lib/news-workbook-verifier.mjs';
import { verifyNewsFactsDocx } from './lib/news-docx-verifier.mjs';
import { createAndVerifyNewsFactsCsv } from './lib/news-csv-workflow.mjs';
import { verifyNewsCardOcr } from './lib/news-card-ocr.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifactRoot = join(repositoryRoot, 'artifacts');
const pilotRoot = mkdtempSync(join(artifactRoot, 'news-research-pilot-20260928-'));
const cardsRoot = join(pilotRoot, 'cards');
mkdirSync(cardsRoot, { recursive: false });
const displayUtc = value => new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, ' UTC');

try {
  const newsResult = await new NewsFetchHeadlinesToolAdapter().execute({ category: 'top', maxResults: 3 });
  assert.equal(newsResult.status, 'success', `live news fetch failed: ${newsResult.errorCode ?? 'unknown'}`);
  const news = newsResult.news;
  assert.equal(news.live, true);
  assert.equal(news.replay, false);
  assert.equal(news.fixture, false);
  assert.ok(news.itemCount > 0 && news.itemCount <= 3);
  assert.ok(news.items.every(item => item.title && item.source && item.publishedAt && /^https:\/\//u.test(item.url)));
  assert.equal(new Set(news.items.map(item => item.url)).size, news.items.length, 'article URLs must be unique');

  const articleReader = new NewsFetchArticleToolAdapter();
  const articles = [];
  for (const item of news.items) {
    try {
      const result = await articleReader.execute({ url: item.url });
      assert.equal(result.readOnly, true);
      if (result.status !== 'success') throw Object.assign(new Error(result.summary), { code: result.errorCode,
        details: result.article });
      const article = result.article;
      articles.push({ status: 'read', finalUrl: article.finalUrl, finalHost: article.finalHost,
        httpStatus: article.httpStatus, byteLength: article.byteLength,
        textCharacters: article.textCharacters,
        extractedTextSha256: createHash('sha256').update(article.text).digest('hex'),
        textIsUntrustedSourceMaterial: article.textIsUntrustedSourceMaterial });
    } catch (error) {
      articles.push({ status: 'unavailable', code: error?.code ?? 'B_NEWS_ARTICLE_UNAVAILABLE',
        details: error?.details ?? {} });
    }
  }

  const reportPath = join(pilotRoot, 'today-headline-brief.md');
  const reportLines = [
    '# 오늘의 주요 뉴스 헤드라인 브리프',
    '',
    `- 수집 시각: ${displayUtc(news.retrievedAt)}`,
    `- 조회 출처: ${news.sourceProvider} (${news.sourceHost})`,
    `- 조회 기사 수: ${news.itemCount}`,
    '',
    '> 범위: RSS 제목·매체·게시 시각을 수집하고 공개 HTTPS 기사 본문을 안전하게 읽어 본문 텍스트 추출 가능 여부를 확인했습니다. 본문은 신뢰할 수 없는 원문 자료로 취급하며 이 파일에는 저장하지 않습니다. 외부 요약 모델을 호출하지 않았으므로 아래는 본문 요약이 아닙니다.',
    ''
  ];
  news.items.forEach((item, index) => {
    const article = articles[index];
    reportLines.push(`## ${index + 1}. ${item.title}`, '', `- 매체: ${item.source}`, `- 게시 시각: ${displayUtc(item.publishedAt)}`,
      `- 기사 링크 (Google News RSS 경유): ${item.url}`,
      `- RSS 설명: ${item.rssDescription ? '있음 (관련 기사 목록일 수 있어 요약에 사용하지 않음)' : '없음'}`,
      `- 본문 읽기: ${article.status === 'read' ? `성공 (${article.textCharacters}자 추출, ${article.finalHost})` : `미완료 (${article.code})`}`,
      '- AI 요약·사실 대조는 수행하지 않았습니다. RSS 설명은 기사 요약으로 취급하지 않았습니다.', '');
  });
  const reportContent = `${reportLines.join('\n')}\n`;
  const projections = createNewsArtifactProjections({ news, articles });
  const sourcePath = join(pilotRoot, 'source-facts.json');
  const reportFactsPath = join(pilotRoot, 'report-facts.json');
  const tableFactsPath = join(pilotRoot, 'table-facts.json');
  const cardFactsPath = join(pilotRoot, 'card-facts.json');
  const workbookPath = join(pilotRoot, 'headlines.xlsx');
  const documentPath = join(pilotRoot, 'headline-brief.docx');
  const csvPath = join(pilotRoot, 'headlines.csv');
  writeFileSync(sourcePath, `${JSON.stringify(projections.source, null, 2)}\n`, { flag: 'wx' });
  for (const [index, path] of [reportFactsPath, tableFactsPath, cardFactsPath].entries()) {
    writeFileSync(path, `${JSON.stringify(projections.artifacts[index], null, 2)}\n`, { flag: 'wx' });
  }
  const workbookData = createNewsFactsWorkbookBuffer(projections.source.facts.headlines);
  writeFileSync(workbookPath, workbookData.buffer, { flag: 'wx' });
  const workbookVerification = await verifyNewsFactsWorkbook(workbookPath, workbookData.rows);
  const workbookVerified = workbookVerification.status === 'passed';
  assert.equal(workbookVerified, true, 'independent ExcelJS reopen must match every source fact cell');
  const documentBlocks = [
    { type: 'paragraph', text: '이 문서는 Google News RSS 헤드라인 브리프입니다. 출판사 기사 본문은 확인되지 않아 기사 요약을 포함하지 않습니다.' },
    { type: 'table', columns: ['title', 'source', 'publishedAt', 'url', 'articleStatus'],
      rows: projections.source.facts.headlines.map(fact => ['title', 'source', 'publishedAt', 'url', 'articleStatus'].map(key => fact[key])) }
  ];
  const word = new WordCreateToolAdapter({ allowedRoots: [pilotRoot],
    undoJournal: new UndoJournal({ journalPath: join(pilotRoot, 'undo-journal.jsonl') }) });
  const documentResult = await word.execute({ path: documentPath, title: '오늘의 주요 뉴스 헤드라인 브리프 (기사 본문 요약 없음)',
    blocks: documentBlocks }, { taskId: 'news-research-artifact-pilot' });
  assert.equal(documentResult.status, 'success', `Word document generation failed: ${documentResult.error ?? 'unknown'}`);
  const expectedDocumentFacts = [
    '오늘의 주요 뉴스 헤드라인 브리프 (기사 본문 요약 없음)',
    '출판사 기사 본문은 확인되지 않아 기사 요약을 포함하지 않습니다.',
    ...projections.source.facts.headlines.flatMap(fact => ['title', 'source', 'publishedAt', 'url', 'articleStatus'].map(key => fact[key]))
  ];
  const documentVerification = verifyNewsFactsDocx(documentPath, expectedDocumentFacts);
  const documentVerified = documentVerification.status === 'passed';
  assert.equal(documentVerified, true, 'independent DOCX XML reopen must contain every headline fact');
  const csvWorkflow = await createAndVerifyNewsFactsCsv({ root: pilotRoot, headlines: projections.source.facts.headlines });
  const csvVerified = csvWorkflow.status === 'passed';
  assert.equal(csvVerified, true, 'Core local workflow must serialize, reopen, and compare every CSV fact');
  const reopenedSource = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const reopenedProjections = [reportFactsPath, tableFactsPath, cardFactsPath]
    .map(path => JSON.parse(readFileSync(path, 'utf8')));
  const consistency = verifyArtifactConsistency({ source: reopenedSource, artifacts: reopenedProjections });
  assert.equal(consistency.status, 'passed', `reopened typed facts diverged: ${JSON.stringify(consistency.checks)}`);
  assert.deepEqual(reopenedSource, projections.source, 'source facts must survive disk round trip');
  assert.deepEqual(reopenedProjections, projections.artifacts, 'typed projections must survive disk round trip');
  const writer = new FileSystemToolAdapter({ allowedRoots: [pilotRoot] });
  const reportWrite = await writer.execute({ path: reportPath, content: reportContent }, { taskId: 'news-research-artifact-pilot' });
  assert.equal(reportWrite.status, 'success', 'the existing scoped filesystem adapter must create the report');
  const rereadReport = readFileSync(reportPath, 'utf8');
  assert.equal(rereadReport, reportContent, 'reread report must match the requested content exactly');
  for (const item of news.items) assert.ok(rereadReport.includes(item.url), `report omitted article URL: ${item.url}`);
  assert.ok(rereadReport.includes('외부 요약 모델을 호출하지 않았으므로'));
  const reportFactsPresent = projections.source.facts.headlines.every(fact =>
    [fact.title, fact.source, displayUtc(fact.publishedAt), fact.url].every(value => rereadReport.includes(value)));

  const visual = new VisualCreateCardsToolAdapter({ allowedRoots: [pilotRoot] });
  const cards = news.items.map((item, index) => ({
    fileName: `news-${String(index + 1).padStart(2, '0')}.png`,
    label: `오늘의 헤드라인 ${String(index + 1).padStart(2, '0')}`,
    title: item.title,
    subtitle: `${item.source} · ${displayUtc(item.publishedAt)}`,
    body: [`본문 읽기: ${articles[index].status === 'read' ? '완료' : '미완료'}`,
      'AI 요약·사실 대조 미실행', '상세 근거는 동봉 보고서'],
    footer: '기사 링크는 동봉 보고서 참조 (Google News RSS 경유)',
    accent: ['#146C94', '#6C4AB6', '#168C74'][index % 3]
  }));
  const cardResult = await visual.execute({ outputDirectory: cardsRoot, width: 1200, height: 675, cards },
    { taskId: 'news-research-artifact-pilot' });
  assert.equal(cardResult.status, 'success', `PNG card generation failed: ${(cardResult.warnings ?? []).join(',')}`);
  assert.equal(cardResult.cardCount, news.items.length);

  const verifiedCards = cardResult.cards.map(card => {
    assert.ok(existsSync(card.path), `PNG is missing: ${card.path}`);
    const bytes = readFileSync(card.path);
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `invalid PNG signature: ${card.path}`);
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 675);
    return { fileName: card.name, relativePath: `cards/${card.name}`, width: 1200, height: 675,
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const cardContentOcr = await verifyNewsCardOcr({ allowedRoot: pilotRoot,
    cards: verifiedCards.map((card, index) => ({ id: card.fileName, path: join(pilotRoot, card.relativePath),
      title: news.items[index].title, source: news.items[index].source })) });
  if (cardContentOcr.status === 'passed' && cardContentOcr.cards.some((card, index) => card.sha256 !== verifiedCards[index].sha256)) {
    throw new Error('news-card-ocr:image-hash-does-not-match-generated-card');
  }
  const cardContentStatus = cardContentOcr.status === 'passed' ? 'passed'
    : cardContentOcr.status === 'blocked' ? 'blocked' : 'failed';
  const manifestPath = join(pilotRoot, 'verification-manifest.json');
  const manifest = {
    version: 'jarvis-news-headline-artifact-pilot-v1',
    generatedAt: new Date().toISOString(),
    source: { provider: news.sourceProvider, feedUrl: news.sourceUrl, host: news.sourceHost,
      retrievedAt: news.retrievedAt, live: news.live, fixture: news.fixture },
    report: { path: 'today-headline-brief.md', sha256: createHash('sha256').update(rereadReport).digest('hex'),
      rereadExactMatch: rereadReport === reportContent, requiredHeadlineFactsPresent: reportFactsPresent,
      articleUrlCount: news.items.length },
    artifactConsistency: { status: projections.verification.status, sourcePath: 'source-facts.json',
      projectionPaths: ['report-facts.json', 'table-facts.json', 'card-facts.json'],
      checks: projections.verification.checks, sourceSha256: projections.source.digest,
      reopenedFromDisk: true, limitation: 'typed fact consistency does not establish arbitrary prose truth' },
    tableWorkbook: { path: 'headlines.xlsx', parser: 'ExcelJS', reopened: true,
      exactHeaderAndCellMatch: workbookVerified, rowCount: workbookVerification.rowCount,
      columnCount: workbookVerification.columnCount },
    wordDocument: { path: 'headline-brief.docx', writer: 'Word COM', parser: 'Python zipfile + XML',
      reopened: true, exactRequiredFactPresence: documentVerified, expectedFactCount: documentVerification.expectedCount,
      matchedFactCount: documentVerification.matchedCount, documentXmlBytes: documentVerification.documentXmlBytes },
    csvWorkflow: { path: 'headlines.csv', workflowId: 'news-headlines-csv-source-roundtrip-v1',
      writerAndReader: 'LocalWorkflowToolAdapter write.csv → data.readCsv → assert.equals',
      exactSourceFactRoundTrip: csvVerified, columns: csvWorkflow.columns,
      verification: { nodeId: csvWorkflow.verification.nodeId, status: csvWorkflow.verification.status,
        resultSha256: csvWorkflow.verification.resultSha256 },
      publication: csvWorkflow.publication },
    cardContentOcr: { status: cardContentOcr.status, engine: cardContentOcr.engine ?? null,
      languageTag: cardContentOcr.cards?.[0]?.languageTag ?? null, rawOcrTextStored: cardContentOcr.rawOcrTextStored,
      reason: cardContentOcr.reason ?? null,
      cards: cardContentOcr.cards.map(card => ({ id: card.id, status: card.status, sha256: card.sha256,
        titleMatched: card.titleMatched, titleMatchRatio: card.titleMatchRatio, sourceMatched: card.sourceMatched,
        width: card.width, height: card.height, byteLength: card.byteLength, rawOcrTextStored: card.rawOcrTextStored })) },
    articles,
    cards: verifiedCards,
    limitations: ['publisher article bodies were fetched only when public HTTPS and safe response checks passed',
      'extracted body text was hashed and discarded rather than persisted',
      'RSS description may list related stories and is not treated as the article summary',
      'no provider model summarized or cross-checked the material',
      'no account, personal data, outbound message, or paid API was used']
  };
  const outcome = classifyNewsArtifactPilotOutcome({ articles,
    reportVerified: rereadReport === reportContent && reportFactsPresent,
    cardsVerified: verifiedCards.length === news.items.length,
    tableVerified: workbookVerified,
    documentVerified,
    csvVerified,
    cardContentStatus,
    consistencyVerified: consistency.status === 'passed' });
  Object.assign(manifest, { outcome });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...outcome, artifactDirectory: pilotRoot, report: reportPath,
    cards: verifiedCards.map(card => card.relativePath), manifest: manifestPath,
    liveReadOnlyNewsRequest: true, externalProviderRequests: 0, billingEvents: 0,
    articlesRead: articles.filter(article => article.status === 'read').length,
    articlesUnavailable: articles.filter(article => article.status !== 'read').length,
    articleBodyTextPersisted: false, independentlyRereadReport: true,
    independentlyCheckedPngSignaturesAndDimensions: true, cardContentOcrStatus: cardContentOcr.status }, null, 2));
  // Preserve the files for inspection, but make automation stop on a content-incomplete pilot.
  if (outcome.status !== 'passed') process.exitCode = outcome.status === 'partial' ? 2 : 1;
} catch (error) {
  console.error(error?.code ? `${error.code}: ${error.message}` : String(error?.stack ?? error));
  process.exitCode = 1;
}
