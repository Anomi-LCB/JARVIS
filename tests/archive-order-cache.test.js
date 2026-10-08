import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SelectedConversationArchive,selectedConversationDocumentHash} from '../apps/growth-memory/src/selected-conversation-archive.js';

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const archive=new SelectedConversationArchive({db,sensitiveText:()=>false});
 const scope={userId:'synthetic-owner',workspaceRoot:'C:/synthetic/archive',conversationId:null};
 const document={format:'jarvis-selected-conversations-v1',provider:'jarvis',conversations:[{id:'chosen',messages:[1,2,3].map(i=>({id:`m${i}`,speaker:'user',text:`자료 원문 ${i}`,spokenAt:`2026-10-03T0${i}:00:00Z`}))}]};
 archive.import({document,scope,selectedConversationIds:['chosen'],sourceRef:'synthetic-cache',expectedDocumentHash:selectedConversationDocumentHash(document)},{commit:true});
 return {db,archive,scope};
}

test('order reuse never stores quote text, survives rollback, and refreshes changed time/content/withdrawal',t=>{
 const {db,archive,scope}=fixture(t);
 const first=archive.query('자료',{scope}),cached=archive.orderCache;
 assert.equal(first[0].sourceMessageId,'m3');
 assert.deepEqual(cached.entries.map(x=>Object.keys(x).sort()),Array(3).fill(['id','time']));
 assert.deepEqual(archive.query('자료',{scope}),first);assert.equal(archive.orderCache,cached);
 db.exec('BEGIN');db.prepare('UPDATE selected_conversation_messages SET spoken_at=? WHERE id=?').run('2026-10-04T00:00:00Z',first.at(-1).memoryId);
 assert.equal(archive.query('자료',{scope})[0].sourceMessageId,'m1');
 assert.equal(archive.orderCache,cached); // Caller-owned writes cannot publish a cache.
 db.exec('ROLLBACK');assert.deepEqual(archive.query('자료',{scope}),first);
 db.prepare('UPDATE selected_conversation_messages SET spoken_at=?,text=? WHERE id=?').run('2026-10-05T00:00:00Z','자료 변경된 내용',first.at(-1).memoryId);
 const changed=archive.query('자료',{scope});assert.equal(changed[0].sourceMessageId,'m1');assert.equal(changed[0].text,'자료 변경된 내용');
  const committedCache=archive.orderCache;
  db.exec('BEGIN');db.prepare('UPDATE selected_conversation_messages SET spoken_at=? WHERE id=?').run('2026-10-06T00:00:00Z',first[0].memoryId);
  assert.equal(archive.query('자료',{scope})[0].sourceMessageId,'m3');assert.equal(archive.orderCache,committedCache);
  db.exec('ROLLBACK');
  // No intervening read: the next committed write can reuse the rolled-back
  // revision number, but must not reuse that transaction's private ordering.
  db.prepare('UPDATE selected_conversation_messages SET spoken_at=? WHERE id=?').run('2026-10-07T00:00:00Z',first[1].memoryId);
  assert.equal(archive.query('자료',{scope})[0].sourceMessageId,'m2');
 archive.withdraw({scope,id:changed[0].memoryId});assert.ok(!archive.query('자료',{scope}).some(x=>x.memoryId===changed[0].memoryId));
 assert.deepEqual(archive.query('자료',{scope:{...scope,userId:'other'}}),[]);
 assert.equal(archive.orderCache.entries.length,0); // Only the current scope is retained.
});

test('archives beyond metadata cache budget retain complete late-match fallback and scoped snapshots',t=>{
 const {db,archive,scope}=fixture(t);
 const scopeKey=db.prepare('SELECT scope_key FROM selected_conversation_messages LIMIT 1').get().scope_key;
 db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<50000)
 INSERT INTO selected_conversation_messages
 SELECT printf('%064x',n+100),?,'large','large-'||n,'user',CASE WHEN n=50000 THEN '희귀 원문' ELSE '일정 초안' END,
 'synthetic-content','synthetic-source','synthetic-document','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z',0 FROM numbers`).run(scopeKey);
 const result=archive.queryPage('희귀',{scope,pageSize:20});
 assert.equal(result.items.length,1);assert.equal(result.items[0].sourceMessageId,'large-50000');
 assert.equal(result.hasMore,false);assert.equal(result.nextCursor,null);assert.equal(archive.orderCache,null);
 assert.equal(db.isTransaction,false);
});

test('invalid legacy time fails closed and releases owned read transaction',t=>{
 const {db,archive,scope}=fixture(t);
 db.prepare('UPDATE selected_conversation_messages SET spoken_at=?').run('not-a-declared-time');
 assert.throws(()=>archive.query('자료',{scope}),{code:'F_CONVERSATION_TIME_REQUIRED'});
 assert.equal(db.isTransaction,false);assert.equal(archive.orderCache,null);
});

test('actual batched quote reads use primary identity lookup instead of rescanning scope for every batch',t=>{
 const {db,archive,scope}=fixture(t);
 const scopeKey=db.prepare('SELECT scope_key FROM selected_conversation_messages LIMIT 1').get().scope_key;
 db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<69)
 INSERT INTO selected_conversation_messages
 SELECT printf('%064x',n+100),?,'batch','batch-'||n,'user','일정 초안','synthetic-content','synthetic-source','synthetic-document',
 '2026-10-03T00:00:00Z','2026-10-03T00:00:00Z',0 FROM numbers`).run(scopeKey);
 const originalPrepare=db.prepare.bind(db),observed=[];
 db.prepare=sql=>{if(sql.includes('INDEXED BY')&&sql.includes('id IN'))observed.push(sql);return originalPrepare(sql);};
 assert.deepEqual(archive.query('없는내용',{scope}),[]);
 const fullBatch=observed.find(sql=>(sql.match(/\?/gu)??[]).length===65);
 assert.ok(fullBatch,'Actual query must issue a full64-ID batch.');
 const plan=originalPrepare('EXPLAIN QUERY PLAN '+fullBatch).all(scopeKey,...Array(64).fill('synthetic-id'));
 assert.ok(plan.some(row=>row.detail.includes(`USING INDEX ${archive.identityIndex} (id=?)`)));
 assert.ok(!plan.some(row=>row.detail.includes('selected_conversation_scope_time')));
});
