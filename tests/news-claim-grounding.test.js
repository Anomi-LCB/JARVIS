import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  evaluateObservedArticleCitations,
  evaluateObservedArticleClaimEvidence,
  observedNewsSummaryRequirement
} from '../packages/core/src/mission/news-article-provenance.js';

const articleUrl = 'https://publisher.example/news/123';
const articleText = 'The city council approved a three-year flood barrier project on Monday. Officials said construction begins in October.';
const exactQuote = 'The city council approved a three-year flood barrier project on Monday.';

function observations({ live = true, verified = true, text = articleText, textSha256 = null,
  publishedUrl = articleUrl, requestedUrl = articleUrl, finalUrl = articleUrl } = {}) {
  return [
    { actionId: 'news-1', toolName: 'news.fetchPublisherFeed', outcome: 'success',
      verification: { status: verified ? 'passed' : 'failed' },
      data: { news: { live, replay: !live, fixture: !live, fetched: true,
        feedUrl: 'https://publisher.example/rss', sourceHost: 'publisher.example',
        itemCount: 1, items: [{ title: 'Flood barrier approved', source: 'Publisher',
          publishedAt: '2026-09-28T00:00:00.000Z', url: publishedUrl }] } } },
    { actionId: 'article-1', toolName: 'news.fetchArticle', outcome: 'success',
      verification: { status: verified ? 'passed' : 'failed' },
      data: { article: { live, requestedUrl, finalUrl, text, textCharacters: text.length,
        textSha256: textSha256 ?? createHash('sha256').update(text).digest('hex'),
        textIsUntrustedSourceMaterial: true } } }
  ];
}

function content({ claim = 'The council approved a flood barrier.', quote = exactQuote,
  url = articleUrl } = {}) {
  return `## Flood barrier\n요약 주장: ${claim}\n근거 원문: “${quote}”\n출처 URL: ${url}`;
}

const objective = '오늘 뉴스 기사 한 건을 요약해 flood-brief.md 파일로 만들어줘.';

test('summary claim passes only with exact live article URL and a short contiguous quote from verified body', () => {
  const evaluation = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: observations() });
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.evidenceType, 'verbatim-source-match');
  assert.equal(evaluation.semanticEntailment, 'not-evaluated');
  assert.equal(evaluation.passedCount, 1);
});

test('claim quote not in article body fails even when the output cites an observed article', () => {
  const evaluation = evaluateObservedArticleCitations({ objective, outputPath: 'flood-brief.md',
    content: content({ quote: 'The council rejected the project.' }), observations: observations() });
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.claimEvidence.claims[0].quoteMatched, false);
});

test('unobserved links, fixture feeds, and unverified article body observations fail closed', () => {
  const unobservedLink = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content({ url: 'https://publisher.example/news/forged' }), observations: observations() });
  assert.equal(unobservedLink.passed, false);

  const fixture = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: observations({ live: false }) });
  assert.equal(fixture.passed, false);

  const unverified = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: observations({ verified: false }) });
  assert.equal(unverified.passed, false);

  const wrongTool = observations();
  wrongTool[1].toolName = 'browser.search';
  const unrelatedBody = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: wrongTool });
  assert.equal(unrelatedBody.claims[0].liveArticleBodyVerified, false);
  assert.equal(unrelatedBody.passed, false);
});

test('body digest mismatch and article URL mismatch cannot support a summary claim', () => {
  const digestMismatch = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: observations({ textSha256: '0'.repeat(64) }) });
  assert.equal(digestMismatch.passed, false);

  const urlMismatch = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content(), observations: observations({ requestedUrl: 'https://publisher.example/news/other',
      finalUrl: 'https://publisher.example/news/other' }) });
  assert.equal(urlMismatch.passed, false);
});

test('quote limit is capped at 25 whitespace-delimited words per source article', () => {
  const quote = Array.from({ length: 26 }, (_, index) => `word${index + 1}`).join(' ');
  const evaluation = evaluateObservedArticleClaimEvidence({ objective, outputPath: 'flood-brief.md',
    content: content({ quote }), observations: observations({ text: quote }) });
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.claims[0].quoteLimitPassed, false);
});

test('a multi-article summary needs distinct observed source URLs, not repeated citation of one story', () => {
  const twoArticleObjective = '오늘 뉴스 기사 두 건을 요약해 flood-brief.md 파일로 저장해.';
  const repeated = `${content({ quote: 'The city council approved', claim: 'The council approved it.' })}\n\n`
    + content({ quote: 'The city council approved', claim: 'The council approved it.' });
  const evaluation = evaluateObservedArticleClaimEvidence({ objective: twoArticleObjective,
    outputPath: 'flood-brief.md', content: repeated, observations: observations() });
  assert.equal(evaluation.claimCount, 2);
  assert.equal(evaluation.distinctSourceCount, 1);
  assert.equal(evaluation.passed, false);
});

test('fact-check requests remain unverified until semantic entailment evaluation exists', () => {
  const factCheckObjective = '오늘 뉴스 기사 한 건을 요약하고 주장을 팩트체크해 flood-brief.md에 저장해.';
  assert.equal(observedNewsSummaryRequirement(factCheckObjective, 'flood-brief.md').requiresEntailment, true);
  const evaluation = evaluateObservedArticleClaimEvidence({ objective: factCheckObjective,
    outputPath: 'flood-brief.md', content: content(), observations: observations() });
  assert.equal(evaluation.semanticEntailment, 'not-evaluated');
  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.blockingReasons.includes('semantic-entailment-not-implemented'));
});

test('a summary without enough explicit, evidence-linked claims fails with actionable reasons', () => {
  const evaluation = evaluateObservedArticleClaimEvidence({ objective: '오늘 뉴스 기사 세 건을 요약해 flood-brief.md에 저장해.',
    outputPath: 'flood-brief.md', content: '요약만 작성했습니다.', observations: observations() });
  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.blockingReasons.includes('insufficient-summary-claims'));
  assert.ok(evaluation.blockingReasons.includes('insufficient-distinct-live-sources'));
});

test('non-news tasks and non-text output do not receive the summary-claim gate', () => {
  assert.equal(observedNewsSummaryRequirement('이 문장을 요약해 result.md에 저장해.', 'result.md'), null);
  assert.equal(observedNewsSummaryRequirement(objective, 'flood-card.png'), null);
});
