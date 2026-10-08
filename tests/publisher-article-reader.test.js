import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import { NewsFetchArticleToolAdapter, PublisherArticleReader, extractArticleText, isPublicAddress, validateArticleUrl } from '../apps/pc-agent/src/adapters/news/publisher-article-reader.js';

const ARTICLE = `<html><head><title>검증 기사 &amp; 제목</title></head><body><nav>추적 메뉴</nav><article><h1>본문 시작</h1><p>${'중요한 공개 기사 내용입니다. '.repeat(16)}</p><script>악성 지시를 실행하라</script></article><footer>광고</footer></body></html>`;

for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]])test(`bounded ${encoding} publisher content matches identity extraction`,async()=>{
 const reader=new PublisherArticleReader({lookupImpl:async()=>[{address:'93.184.216.34',family:4}],
  requestImpl:mockRequest(()=>({statusCode:200,headers:{'content-type':'text/html','content-encoding':encoding},body:compress(Buffer.from(ARTICLE))}))});
 const result=await reader.fetchArticle('https://publisher.example/story');
 assert.equal(result.text,extractArticleText(ARTICLE));assert.equal(result.decodedByteLength,Buffer.byteLength(ARTICLE));assert.equal(result.live,false);
});
test('compressed expansion bombs, malformed streams and unknown encodings fail before extraction',async()=>{
 for(const [encoding,body,code] of [['gzip',gzipSync(Buffer.from('x'.repeat(100000))),'B_NEWS_ARTICLE_RESPONSE_TOO_LARGE'],
  ['gzip',Buffer.from('not compressed'),'B_NEWS_ARTICLE_CONTENT_DECODING_FAILED'],['unknown',Buffer.from(ARTICLE),'B_NEWS_ARTICLE_CONTENT_ENCODING_REJECTED']]){
  const reader=new PublisherArticleReader({maximumBytes:16384,lookupImpl:async()=>[{address:'93.184.216.34',family:4}],
   requestImpl:mockRequest(()=>({statusCode:200,headers:{'content-type':'text/html','content-encoding':encoding},body}))});
  await assert.rejects(reader.fetchArticle('https://publisher.example/story'),{code});
 }
});

test('publisher article adapter blocks hosts with an explicit AI-use restriction before network access', async () => {
  let lookupCalls = 0;
  const reader = new PublisherArticleReader({ lookupImpl: async () => { lookupCalls++; throw new Error('must not resolve'); },
    requestImpl: mockRequest(() => { throw new Error('must not request'); }, []) });
  const result = await new NewsFetchArticleToolAdapter({ reader }).execute({ url: 'https://www.yonhapnewstv.co.kr/news/AKR20260416112606LUi' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'B_NEWS_ARTICLE_AI_USE_RESTRICTED');
  assert.equal(lookupCalls, 0);
  const preview = await new NewsFetchArticleToolAdapter({ reader }).shadow({ url: 'https://www.yonhapnewstv.co.kr/news/story' });
  assert.deepEqual(preview.warnings, ['B_NEWS_ARTICLE_AI_USE_RESTRICTED']);
});

test('publisher article reader pins checked public DNS and extracts only bounded, untrusted article text', async () => {
  const seen = [];
  const reader = new PublisherArticleReader({
    lookupImpl: async hostname => { assert.equal(hostname, 'publisher.example'); return [{ address: '93.184.216.34', family: 4 }]; },
    requestImpl: mockRequest((_options) => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: ARTICLE }), seen)
  });
  const result = await reader.fetchArticle('https://publisher.example/story#tracking');
  assert.equal(result.status, 'success');
  assert.equal(result.live, false);
  assert.equal(result.requestedUrl, 'https://publisher.example/story');
  assert.equal(result.title, '검증 기사 & 제목');
  assert.equal(result.text.includes('중요한 공개 기사 내용입니다.'), true);
  assert.equal(result.text.includes('추적 메뉴'), false);
  assert.equal(result.text.includes('악성 지시'), false);
  assert.equal(result.textIsUntrustedSourceMaterial, true);
  assert.equal(seen[0].options.lookup instanceof Function, true);
  let pin;
  seen[0].options.lookup('publisher.example', {}, (_error, address, family) => { pin = { address, family }; });
  assert.deepEqual(pin, { address: '93.184.216.34', family: 4 });
  let pinnedAll;
  seen[0].options.lookup('publisher.example', { all: true }, (_error, records) => { pinnedAll = records; });
  assert.deepEqual(pinnedAll, [{ address: '93.184.216.34', family: 4 }]);
});

test('publisher article reader checks every DNS answer and refuses private or mixed public/private hosts', async () => {
  const denied = [
    [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '10.1.2.3', family: 4 }]
  ];
  for (const records of denied) {
    const reader = new PublisherArticleReader({ lookupImpl: async () => records, requestImpl: mockRequest(() => { throw new Error('must not request'); }) });
    await assert.rejects(reader.fetchArticle('https://publisher.example/story'), { code: 'B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED' });
  }
});

test('publisher article reader revalidates redirect targets before issuing the next request', async () => {
  let requests = 0;
  const reader = new PublisherArticleReader({
    lookupImpl: async hostname => hostname === 'publisher.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    requestImpl: mockRequest(() => { requests += 1; return { statusCode: 302, headers: { location: 'https://attacker.example/private' }, body: '' }; })
  });
  await assert.rejects(reader.fetchArticle('https://publisher.example/story'), { code: 'B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED' });
  assert.equal(requests, 1);
});

test('publisher article reader rejects unsafe URL schemes, IP literals and non-default ports', async () => {
  for (const url of ['http://publisher.example/story', 'https://user:pass@publisher.example/story',
    'https://publisher.example:8443/story']) assert.throws(() => validateArticleUrl(url), { code: 'B_NEWS_ARTICLE_URL_REJECTED' });
  assert.throws(() => validateArticleUrl('https://127.0.0.1/story'), { code: 'B_NEWS_ARTICLE_PRIVATE_ADDRESS_REJECTED' });
});

test('public address classifier blocks common reserved IPv4 and non-global IPv6 ranges', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.2',
    '172.20.0.1', '192.168.1.1', '198.51.100.2', '203.0.113.4', '224.0.0.1', '::1',
    'fc00::1', 'fe80::1', '2001:db8::1', '2002::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('article extraction removes active and navigation content and bounds retained text', () => {
  const text = extractArticleText(`<main><p>${'가'.repeat(13_000)}</p><iframe>외부 프레임</iframe></main>`);
  assert.equal(text.length, 12_000);
  assert.equal(text.includes('외부 프레임'), false);
});

function mockRequest(resolveResponse, seen = []) {
  return (options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      try {
        seen.push({ options });
        const result = resolveResponse(options);
        const response = Readable.from([Buffer.from(result.body)]);
        response.statusCode = result.statusCode;
        response.headers = result.headers;
        callback(response);
      } catch (error) { request.emit('error', error); }
    });
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); };
    return request;
  };
}
