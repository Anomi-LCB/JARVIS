import test from 'node:test';import assert from 'node:assert/strict';
import {LocalExportStore} from '../packages/shared/src/local-export-store.js';
test('exports expire, have fixed filenames, preserve exact content and never accept paths',()=>{
  let now=100;const store=new LocalExportStore({clock:()=>now,ttlMs:1000});const result=store.create({kind:'document-brief',content:'원문\n<script>untrusted</script>'});
  assert.equal(store.get(result.url.split('/').at(-1)).content,'원문\n<script>untrusted</script>');assert.equal(result.filename,'jarvis-document-brief.md');
  assert.throws(()=>store.create({kind:'document-brief',content:'x',path:'C:/private'}));now=1100;assert.equal(store.get(result.url.split('/').at(-1)),null);
});
test('memory downloads are bounded by entry count, content size and explicit kinds',()=>{
  const store=new LocalExportStore({maxEntries:1});for(const input of [{kind:'html',content:'x'},{kind:'document-brief',content:'x'.repeat(300000)}])assert.throws(()=>store.create(input));
  store.create({kind:'document-brief',content:'x'});assert.throws(()=>store.create({kind:'document-brief',content:'y'}),error=>error.statusCode===429);
});
