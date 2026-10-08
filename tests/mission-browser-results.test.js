import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSearchToolAdapter, createLiveResultPreview } from '../apps/pc-agent/src/pc-agent-runtime.js';

test('Live search exposes captured source links instead of synthetic search fragments', () => {
  const url='https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all';
  const results=createLiveResultPreview({query:'Promise.all',searchEngine:'duckduckgo',title:'Search',url:'https://duckduckgo.com/',bodyText:'search body',maxResults:5,links:[
    {url:'https://duckduckgo.com/settings',title:'Settings'},
    {url:`https://duckduckgo.com/l/?uddg=${encodeURIComponent(url)}`,title:'Promise.all - MDN',snippet:'Rejects on the first rejection.'},
    {url,title:'duplicate'},
    {url:'javascript:alert(1)',title:'Invalid'}
  ]});
  assert.equal(results.length,1);
  assert.equal(results[0].url,url);
  assert.equal(results[0].snippet,'Rejects on the first rejection.');
});

test('Direct documentation navigation is restricted to known HTTPS origins', () => {
  const adapter=new BrowserSearchToolAdapter();
  const url='https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all';
  assert.equal(adapter.searchUrl({query:url}),url);
  for(const blocked of ['http://developer.mozilla.org/','https://localhost/','https://developer.mozilla.org.evil.example/','https://u:p@developer.mozilla.org/','https://developer.mozilla.org:8443/']) assert.match(adapter.searchUrl({query:blocked}),/^https:\/\/duckduckgo\.com/);
  assert.deepEqual(createLiveResultPreview({query:url,url,title:'Promise.all()',bodyText:'Actual official body'}),[{rank:1,title:'Promise.all()',url,snippet:'Actual official body'}]);
});
