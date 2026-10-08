import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parsePublisherRss } from '../apps/pc-agent/src/adapters/news/google-news-rss.js';
import { NewsFetchPublisherFeedToolAdapter, PublisherRssFeedClient } from '../apps/pc-agent/src/adapters/news/publisher-rss-feed.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { sanitizeMissionArguments } from '../packages/core/src/planning/mission-action-arguments.js';
import { SkillRouter } from '../packages/core/src/routing/skill-router.js';
import { newsPublisherFeedCatalog } from '../packages/core/src/routing/news-publisher-catalog.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';

const fixture = `<?xml version="1.0"?><rss version="2.0"><channel><title>공식 게시자</title>
<item><title>오래된 기사</title><link>https://publisher.example/old-story</link><pubDate>Mon, 21 Sep 2026 08:00:00 GMT</pubDate></item>
<item><title>최신 기사</title><link>https://publisher.example/latest-story</link><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate></item>
<item><title>Google News 중간 링크</title><link>https://news.google.com/rss/articles/token</link><pubDate>Mon, 28 Sep 2026 07:00:00 GMT</pubDate></item>
<item><title>HTTP 링크</title><link>http://publisher.example/http-story</link><pubDate>Mon, 28 Sep 2026 06:00:00 GMT</pubDate></item>
</channel></rss>`;

test('publisher RSS parser retains newest direct HTTPS publisher articles and drops intermediary or unsafe links', () => {
  const items = parsePublisherRss(fixture, { maxResults: 10 });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.title), ['최신 기사', '오래된 기사']);
  assert.ok(items.every(item => item.source === '공식 게시자' && item.url.startsWith('https://publisher.example/')));
});

test('publisher RSS accepts namespaced dc:date but does not invent timezone for compact local timestamps', () => {
  const namespacedDate = `<rss><channel><title>경향신문</title><item><title>fixture article</title>
    <link>https://www.khan.co.kr/article/fixture</link><dc:date>2026-09-28T07:00:00Z</dc:date></item></channel></rss>`;
  const [khanItem] = parsePublisherRss(namespacedDate);
  assert.equal(khanItem.publishedAt, '2026-09-28T07:00:00.000Z');
  assert.equal(khanItem.source, '경향신문');

  const compactLocalDate = `<rss><channel><item><title>fixture article</title>
    <link>https://mss.go.kr/article/fixture</link><pubDate>20260928123000</pubDate></item></channel></rss>`;
  assert.deepEqual(parsePublisherRss(compactLocalDate, { fallbackSource: 'mss.go.kr' }), [],
    'a timestamp without an explicit timezone must not be silently converted');
});

test('Atom feeds retain only direct HTTPS alternate links and timezone-qualified dates', () => {
  const atom = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>기관 피드</atom:title>
    <atom:entry><atom:title>safe story</atom:title><atom:link rel="self" href="https://publisher.example/feed" />
      <atom:link rel="alternate" type="text/html" href="https://publisher.example/story" />
      <atom:updated>2026-09-28T09:00:00+09:00</atom:updated></atom:entry>
    <atom:entry><atom:title>local time story</atom:title><atom:link href="https://publisher.example/local" />
      <atom:published>2026-09-28T09:00:00</atom:published></atom:entry>
    <atom:entry><atom:title>insecure story</atom:title><atom:link href="http://publisher.example/insecure" />
      <atom:updated>2026-09-28T00:00:00Z</atom:updated></atom:entry>
  </atom:feed>`;
  const items = parsePublisherRss(atom, { fallbackSource: 'publisher.example' });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://publisher.example/story');
  assert.equal(items[0].publishedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(items[0].source, '기관 피드');
});

test('publisher RSS client performs bounded pinned GET and preserves direct feed provenance', async () => {
  const seen = [];
  const lookupImpl = async host => { assert.equal(host, 'official.example'); return [{ address: '93.184.216.34', family: 4 }]; };
  const requestImpl = (options, callback) => {
    seen.push(options);
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/rss+xml; charset=utf-8' };
      callback(response);
      queueMicrotask(() => { response.emit('data', Buffer.from(fixture)); response.emit('end'); });
    };
    request.destroy = error => request.emit('error', error);
    return request;
  };
  const client = new PublisherRssFeedClient({ lookupImpl, requestImpl, clock: () => new Date('2026-09-28T08:01:00.000Z') });
  const feed = await client.fetchFeed('https://official.example/rss', { maxResults: 5 });
  assert.equal(feed.live, false, 'injected DNS/transport must never be promoted to live evidence');
  assert.equal(feed.replay, true);
  assert.equal(feed.feedUrl, 'https://official.example/rss');
  assert.equal(feed.finalFeedUrl, 'https://official.example/rss');
  assert.equal(feed.sourceHost, 'official.example');
  assert.equal(feed.itemCount, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].hostname, 'official.example');
  assert.equal(seen[0].servername, 'official.example');
  assert.equal(seen[0].headers.authorization, undefined);
  let pinnedAddress = null;
  seen[0].lookup('official.example', { all: true }, (_error, values) => { pinnedAddress = values?.[0]?.address; });
  assert.equal(pinnedAddress, '93.184.216.34');
});

test('publisher feed client accepts the standard Atom media type and applies the bounded parser', async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Official feed</title><entry>
    <title>Article</title><link rel="alternate" href="https://official.example/story" />
    <updated>2026-09-28T00:00:00Z</updated></entry></feed>`;
  const client = new PublisherRssFeedClient({ lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: (_options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter(); response.statusCode = 200;
        response.headers = { 'content-type': 'application/atom+xml; charset=utf-8' }; callback(response);
        queueMicrotask(() => { response.emit('data', Buffer.from(atom)); response.emit('end'); });
      };
      request.destroy = error => request.emit('error', error);
      return request;
    } });
  const feed = await client.fetchFeed('https://official.example/atom', { maxResults: 1 });
  assert.equal(feed.itemCount, 1);
  assert.equal(feed.items[0].url, 'https://official.example/story');
});

test('publisher RSS rejects private DNS and rechecks redirect destinations before requesting them', async () => {
  let requests = 0;
  const blocked = new PublisherRssFeedClient({ lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    requestImpl: () => { requests++; throw new Error('must not request private IP'); } });
  await assert.rejects(() => blocked.fetchFeed('https://private.example/rss'), { code: 'B_NEWS_FEED_PRIVATE_ADDRESS_REJECTED' });
  assert.equal(requests, 0);

  let lookupCalls = 0;
  const redirect = new PublisherRssFeedClient({
    lookupImpl: async host => {
      lookupCalls++;
      return [{ address: host === 'official.example' ? '93.184.216.34' : '10.0.0.2', family: 4 }];
    },
    requestImpl: (_options, callback) => {
      requests++;
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter(); response.statusCode = 302;
        response.headers = { location: 'https://internal.example/rss' }; callback(response);
        queueMicrotask(() => response.emit('end'));
      };
      request.destroy = error => request.emit('error', error);
      return request;
    }
  });
  await assert.rejects(() => redirect.fetchFeed('https://official.example/rss'), { code: 'B_NEWS_FEED_PRIVATE_ADDRESS_REJECTED' });
  assert.equal(lookupCalls, 2);
});

test('publisher feed adapter and Mission route expose a read-only untrusted source capability', async () => {
  const intent = new IntentParser().parse('이 게시자 RSS에서 새 기사를 확인해 https://official.example/rss');
  const route = new SkillRouter().route(intent);
  assert.equal(route.skill.toolName, 'news.fetchPublisherFeed');
  assert.deepEqual(sanitizeMissionArguments('news.fetchPublisherFeed', {
    feedUrl: 'https://official.example/rss', maxResults: 7, executionAuthorized: true
  }), { feedUrl: 'https://official.example/rss', maxResults: 7 });

  const runtime = createAgRuntime({ env: {}, workerDaemonEnabled: false });
  const contract = runtime.pcAgent.registry.contractFor('news.fetchPublisherFeed');
  assert.equal(contract.readOnly, true);
  assert.equal(contract.externalTransfer, false);
  assert.equal(runtime.missionRuntime.capabilityCatalog().some(item => item.toolName === 'news.fetchPublisherFeed'
    && item.externalNetwork === true && item.readOnly === true), true);
  const planned = runtime.coreFacade.createTask('이 게시자 RSS에서 새 기사를 확인해 https://official.example/rss');
  assert.equal(planned.plan.action.toolName, 'news.fetchPublisherFeed');
  assert.equal(planned.plan.action.arguments.feedUrl, 'https://official.example/rss');

  const adapter = new NewsFetchPublisherFeedToolAdapter({ client: { fetchFeed: async feedUrl => ({
    feedVersion: 'jarvis-publisher-rss-v1', sourceProvider: 'Publisher RSS', sourceUrl: feedUrl, feedUrl,
    finalFeedUrl: feedUrl, sourceHost: 'official.example', retrievedAt: '2026-09-28T08:00:00.000Z',
    live: true, replay: false, fixture: false, fetched: true, httpStatus: 200, itemCount: 1,
    items: [{ title: '기사', source: '공식 게시자', publishedAt: '2026-09-28T07:00:00.000Z', url: 'https://official.example/story' }]
  }) } });
  const result = await adapter.execute({ feedUrl: 'https://official.example/rss' });
  assert.equal(result.status, 'success');
  assert.equal(result.news.live, true);
  assert.equal(result.news.items[0].url, 'https://official.example/story');
  assert.equal((await adapter.execute({ feedUrl: 'http://127.0.0.1/private' })).status, 'blocked');

  const observation = runtime.missionRuntime.successObservation({ actionId: 'feed', taskId: 'task',
    actualToolName: 'news.fetchPublisherFeed', arguments: { feedUrl: 'https://official.example/rss' } },
  { taskId: 'task' }, { execution: { executionResult: result } });
  assert.equal(observation.trustBoundary, 'WEB_CONTENT');
  assert.equal(observation.untrusted, true);
  assert.equal(observation.data.news.finalFeedUrl, 'https://official.example/rss');
});

test('a natural-language publisher name selects only its verified official feed and unknown publishers are not guessed', async () => {
  const parser = new IntentParser();
  const command = '연합뉴스TV에서 오늘 뉴스 3건을 확인하고 요약해줘';
  const intent = parser.parse(command);
  assert.equal(intent.slots.workflow, 'publisher-news-feed');
  assert.equal(intent.slots.publisherId, 'yonhapnewstv-latest');
  assert.equal(intent.slots.feedUrl, 'https://www.yonhapnewstv.co.kr/browse/feed/');
  assert.equal(intent.slots.maxResults, 3);
  assert.equal(newsPublisherFeedCatalog[0].usageRestrictions.commercialUse, 'prohibited-pending-rights-review');
  assert.equal(newsPublisherFeedCatalog[0].usageRestrictions.sourceUrl, 'https://www.yonhapnewstv.co.kr/add/rss');
  assert.equal(newsPublisherFeedCatalog[0].usageRestrictions.aiProcessing,
    'prohibited-by-publisher-notice-pending-rights-review');

  const route = new SkillRouter().route(intent);
  assert.equal(route.skill.toolName, 'news.fetchPublisherFeed');
  const planned = createAgRuntime({ env: {}, workerDaemonEnabled: false }).coreFacade.createTask(command);
  assert.equal(planned.plan.action.toolName, 'news.fetchPublisherFeed');
  assert.deepEqual(planned.plan.action.arguments, {
    feedUrl: 'https://www.yonhapnewstv.co.kr/browse/feed/', maxResults: 3, readOnly: true
  });

  let feedFetchCalls = 0;
  const restrictedAdapter = new NewsFetchPublisherFeedToolAdapter({ client: { fetchFeed: async () => {
    feedFetchCalls++;
    throw new Error('restricted source must not be fetched');
  } } });
  const blocked = await restrictedAdapter.execute({ feedUrl: 'https://www.yonhapnewstv.co.kr/browse/feed/', maxResults: 3 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.errorCode, 'B_NEWS_SOURCE_AI_USE_RESTRICTED');
  assert.equal(feedFetchCalls, 0);

  const unsupported = parser.parse('KBS에서 오늘 뉴스 3건을 요약해줘');
  assert.equal(unsupported.slots.workflow, 'news-headlines');
  assert.equal(unsupported.slots.publisherId, undefined);
  assert.equal(unsupported.slots.feedUrl, undefined,
    'publisher feeds without verified catalog entries must not be guessed');

  const comparison = parser.parse('연합뉴스TV와 KBS 뉴스를 비교해줘');
  assert.equal(comparison.slots.workflow, 'news-headlines');
  assert.equal(comparison.slots.publisherId, undefined,
    'mentioning a catalogued publisher as one side of a comparison must not silently narrow the request');
  const exclusion = parser.parse('연합뉴스TV 말고 KBS 뉴스에서 오늘 기사를 찾아줘');
  assert.equal(exclusion.slots.publisherId, undefined,
    'an explicitly excluded publisher must not be selected from the catalogue');
});

test('G accepts consistent publisher-feed provenance and rejects mismatched feed or article hosts', async () => {
  const verifier = new ExecutionResultVerifier();
  const news = {
    feedUrl: 'https://official.example/rss', finalFeedUrl: 'https://cdn.official.example/rss',
    sourceHost: 'cdn.official.example', retrievedAt: '2026-09-28T08:00:00.000Z', live: true,
    replay: false, fixture: false, fetched: true, httpStatus: 200, itemCount: 1,
    items: [{ title: '기사', source: '공식 게시자', publishedAt: '2026-09-28T07:00:00.000Z',
      url: 'https://www.official.example/story' }]
  };
  const verifyNews = async (value) => {
    const checks = await verifier.verify({ executionResult: {
      status: 'success', readOnly: true, outputPaths: [], changedItems: [], news: value,
      executedBy: { toolName: 'news.fetchPublisherFeed' }
    }, evidence: {} });
    return checks.find(check => check.checkId === 'news_fetch_provenance_complete');
  };

  assert.equal((await verifyNews(news)).status, 'passed');
  assert.equal((await verifyNews({ ...news, sourceHost: 'attacker.example' })).status, 'failed');
  assert.equal((await verifyNews({ ...news, items: [{ ...news.items[0], url: 'http://www.official.example/story' }] })).status, 'failed');
  assert.equal((await verifyNews({ ...news, finalFeedUrl: 'https://news.google.com/rss' })).status, 'failed');
});

test('a direct-feed request passes the real Mission E→B→G path with an injected read-only feed source', async () => {
  const feedUrl = 'https://official.example/rss';
  const articleUrl = 'https://official.example/story';
  const news = { feedVersion: 'jarvis-publisher-rss-v1', sourceProvider: 'Publisher RSS', sourceUrl: feedUrl,
    feedUrl, finalFeedUrl: feedUrl, sourceHost: 'official.example', retrievedAt: '2026-09-28T08:00:00.000Z',
    live: true, replay: false, fixture: false, fetched: true, httpStatus: 200, itemCount: 1,
    items: [{ title: '검증 기사', source: '공식 게시자', publishedAt: '2026-09-28T07:00:00.000Z', url: articleUrl }] };
  let plannerCalls = 0;
  const runtime = createAgRuntime({ env: { JARVIS_TEST_MODE: '1' }, taskEnv: { JARVIS_TEST_MODE: '1' },
    allowedRoots: [process.cwd()], auditRoot: undefined, workerDaemonEnabled: false,
    publisherRssClient: { fetchFeed: async () => news },
    missionPlanner: { async planNextWave(context) {
      plannerCalls++;
      const requirementIds = context.mission.goalContract.requirements.map(item => item.requirementId);
      if (plannerCalls === 1) return { decision: 'continue', summary: '지정된 게시자 피드를 읽습니다.',
        actions: [{ id: 'publisher_feed', title: '공식 게시자 RSS 읽기',
          command: `이 게시자 RSS에서 기사를 확인해 ${feedUrl}`, expectedToolName: 'news.fetchPublisherFeed',
          arguments: { feedUrl, maxResults: 1 }, dependencies: [], requirementIds,
          successSignal: '직접 기사 URL과 라이브 조회 증거' }], criteriaAssessment: [] };
      const observation = context.observations.find(item => item.toolName === 'news.fetchPublisherFeed' && item.outcome === 'success');
      return { decision: 'complete', summary: '피드 출처와 기사 URL 확인을 G에 제출합니다.', actions: [],
        criteriaAssessment: [{ criterionId: 'publisher-feed', status: 'satisfied',
          evidenceActionIds: observation ? [observation.actionId] : [], reason: '실제 도구 관찰에 출처와 URL이 있습니다.' }] };
    } } });
  try {
    const created = runtime.missionRuntime.createMission({ objective: `이 게시자 RSS에서 기사를 확인해 ${feedUrl}`,
      successCriteria: [{ criterionId: 'publisher-feed', statement: '오늘 최신 뉴스의 출처와 조회 시점이 확인된다.' }] });
    const mission = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(mission.status, 'COMPLETED', JSON.stringify({ status: mission.status, stopReason: mission.stopReason,
      completion: mission.completion, goalCoverage: mission.goalCompletionCoverage, criteria: mission.criteriaAssessment, keys: Object.keys(mission),
      criterionEvidence: runtime.missionRuntime.verifyCriterionEvidence(mission, mission.successCriteria[0], mission.waves.flatMap(wave => wave.actions).map(action => action.actionId)),
      observations: mission.observations.map(item => ({ toolName: item.toolName, outcome: item.outcome, summary: item.summary,
        data: item.data, verification: item.verification })) }));
    const observation = mission.observations.find(item => item.toolName === 'news.fetchPublisherFeed');
    assert.equal(observation?.verification?.status, 'passed');
    assert.equal(observation?.trustBoundary, 'WEB_CONTENT');
    assert.equal(observation?.untrusted, true);
    assert.equal(observation?.data?.news?.items?.[0]?.url, articleUrl);
    assert.equal(mission.verificationSummary?.status, 'passed');
    const tampered = structuredClone(mission);
    tampered.observations.find(item => item.toolName === 'news.fetchPublisherFeed').data.news.items[0].url = 'http://official.example/story';
    const criterionProof = runtime.missionRuntime.verifyCriterionEvidence(tampered, tampered.successCriteria[0], [observation.actionId]);
    assert.equal(criterionProof.passed, false, 'criterion evidence must reject a tampered insecure publisher URL');
  } finally { runtime.workerDaemon.stop({ reason: 'publisher-rss-mission-test-finished' }); runtime.coreFacade.cognition.close(); }
});
