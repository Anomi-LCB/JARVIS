import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateObservedArticleClaimEvidence } from '../packages/core/src/mission/news-article-provenance.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BODY = 'The council approved a flood barrier project.';
const ARTICLE_URL = 'https://publisher.example/news/123';
const QUOTE = 'The council approved a flood barrier project.';
const NOW = () => new Date().toISOString();

function objectiveFor(kind) {
  if (kind === 'summary-two') return '오늘 뉴스 기사 두 건을 요약해 brief.md에 저장해.';
  if (kind === 'fact-check') return '오늘 뉴스 기사 한 건을 요약하고 주장을 팩트체크해 brief.md에 저장해.';
  if (kind === 'unrelated') return '이 문장을 요약해 brief.md에 저장해.';
  return '오늘 뉴스 기사 한 건을 요약해 brief.md에 저장해.';
}

function claimRecord(url, quote, index) {
  return `요약 주장: 의회가 방재벽 사업을 승인했다 ${index + 1}.\n근거 원문: “${quote}”\n출처 URL: ${url}`;
}

function fixtureFor(evaluationCase) {
  const change = evaluationCase.mutation ?? {};
  const longQuote = Array.from({ length: 26 }, (_, index) => `word${index + 1}`).join(' ');
  const quote = change.longQuote ? longQuote : change.quote ?? QUOTE;
  const body = change.longQuote ? longQuote : BODY;
  const articleUrl = ARTICLE_URL;
  const itemUrl = ARTICLE_URL;
  const digest = change.digest === '0' ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex');
  const claimCount = change.claimCount ?? 1;
  const content = Array.from({ length: claimCount }, (_, index) => claimRecord(change.claimUrl ?? itemUrl, quote, index)).join('\n\n');
  const live = change.live !== false;
  const articleTool = change.articleTool ?? 'news.fetchArticle';
  const articleVerified = change.articleVerified !== false;
  const observations = [
    {
      actionId: 'feed-1', toolName: 'news.fetchPublisherFeed', outcome: 'success',
      verification: { status: 'passed' },
      data: { news: { live, replay: !live, fixture: !live, feedUrl: 'https://publisher.example/rss',
        items: [{ title: 'Flood barrier', source: 'Publisher', publishedAt: '2026-09-28T00:00:00Z', url: itemUrl }] } }
    },
    {
      actionId: 'article-1', toolName: articleTool, outcome: 'success',
      verification: { status: articleVerified ? 'passed' : 'failed' },
      data: { article: { live, requestedUrl: articleUrl, finalUrl: articleUrl, text: body,
        textCharacters: body.length + (change.characterCountDelta ?? 0), textSha256: digest,
        textIsUntrustedSourceMaterial: true } }
    }
  ];
  return { content, observations, objective: objectiveFor(evaluationCase.objective), outputPath: evaluationCase.output === 'png' ? 'brief.png' : 'brief.md' };
}

export async function runNewsSourceGroundingEvaluation({ workspaceRoot = ROOT, now = NOW } = {}) {
  const suitePath = resolve(workspaceRoot, 'config/news-source-grounding-evaluation.json');
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
  const results = suite.cases.map((evaluationCase) => {
    const input = fixtureFor(evaluationCase);
    const actual = evaluateObservedArticleClaimEvidence(input);
    const actualExpected = actual?.passed ?? null;
    const missingBlockers = (evaluationCase.expectedBlockers ?? [])
      .filter((reason) => !actual?.blockingReasons?.includes(reason));
    return {
      id: evaluationCase.id,
      expected: evaluationCase.expected,
      actual: actualExpected,
      blockerMatch: missingBlockers.length === 0,
      missingBlockers,
      passed: actualExpected === evaluationCase.expected && missingBlockers.length === 0,
      blockingReasons: actual?.blockingReasons ?? [],
      semanticEntailment: actual?.semanticEntailment ?? null
    };
  });
  const mismatches = results.filter((result) => !result.passed);
  const report = {
    version: 1,
    suiteId: suite.suiteId,
    evidenceClass: suite.evidenceClass,
    observedAt: now(),
    caseCount: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: mismatches.length,
    status: mismatches.length === 0 ? 'passed' : 'failed',
    providerCalls: 0,
    externalRequests: 0,
    costUsd: null,
    results,
    limitations: [
      'Cases are synthetic deterministic contract fixtures, not live news or model-quality evaluations.',
      'The suite checks expected source-linkage behavior, not semantic entailment or truth.',
      'The case set was authored alongside this implementation and is not an independent holdout.'
    ]
  };
  const outputPath = resolve(workspaceRoot, 'artifacts/agent-platform-20260928/publisher-source-grounding-evaluation.json');
  await mkdir(resolve(workspaceRoot, 'artifacts/agent-platform-20260928'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runNewsSourceGroundingEvaluation();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error?.code ?? error?.message ?? 'news-source-grounding-evaluation-failed');
    process.exitCode = 1;
  }
}
