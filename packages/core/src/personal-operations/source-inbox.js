import { createHash } from 'node:crypto';
import {normalizeStrictIsoInstant} from '../../../shared/src/strict-iso-instant.js';

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function text(value, max=2000) {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/u.test(value))throw new Error('A_SOURCE_INVALID_TEXT');
  return value;
}

export function normalizeConnectorPage({provider,account,scope,observedAt,cursor=null,result}) {
  const rows=provider==='gmail'?result?.emails:provider==='google-calendar'?result?.events:null;
  if(!Array.isArray(rows))throw new Error('A_SOURCE_CONNECTOR_PAGE_INVALID');
  return {provider,account,scope,observedAt,cursor,nextCursor:result.next_page_token??null,items:rows.map(row=>({id:row.id,title:(provider==='gmail'?row.subject:row.summary)||'(제목 없음)',start:provider==='google-calendar'?row.start??null:null,withdrawn:provider==='google-calendar'?(row.status==='cancelled'||row.my_response_status==='declined'):false}))};
}

/** Imported text is observation data. It never supplies execution grants or commands. */
export class PersonalSourceInbox {
  constructor(store) {
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_source_streams(id TEXT PRIMARY KEY,cursor TEXT,last_hash TEXT);
      CREATE TABLE IF NOT EXISTS personal_source_pages(stream_id TEXT NOT NULL,batch_hash TEXT NOT NULL,PRIMARY KEY(stream_id,batch_hash));
      CREATE TABLE IF NOT EXISTS personal_source_items(id TEXT PRIMARY KEY,stream_id TEXT NOT NULL REFERENCES personal_source_streams(id),provider_id TEXT NOT NULL,body TEXT NOT NULL,observed_at TEXT NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0,commitment_id TEXT REFERENCES personal_commitments(id),UNIQUE(stream_id,provider_id));`);
    if(!store.db.prepare('PRAGMA table_info(personal_source_streams)').all().some(column=>column.name==='provider'))
      store.db.exec('ALTER TABLE personal_source_streams ADD COLUMN provider TEXT');
    if(!store.db.prepare('PRAGMA table_info(personal_source_items)').all().some(column=>column.name==='accepted_source_hash'))
      store.db.exec('ALTER TABLE personal_source_items ADD COLUMN accepted_source_hash TEXT');
  }
  ingest({provider,account,scope,cursor=null,nextCursor=null,observedAt,items}, {onCommit} = {}) {
    if(!['gmail','google-calendar','outlook','teams-chat'].includes(provider))throw new Error('A_SOURCE_PROVIDER_INVALID');
    text(account,200);text(scope,1000);
    for(const c of [cursor,nextCursor])if(c!==null)text(c,2000);
    observedAt=normalizeStrictIsoInstant(observedAt,{requireSeconds:false});
    if(observedAt===null)throw new Error('A_SOURCE_TIME_INVALID');
    if(!Array.isArray(items)||items.length>500)throw new Error('A_SOURCE_PAGE_INVALID');
    const normalized=items.map(item=>{
      if(!item||Object.keys(item).some(k=>!['id','title','start','withdrawn'].includes(k)))throw new Error('A_SOURCE_FIELDS_INVALID');
      text(item.id,500);text(item.title);
      if(item.start!=null)text(item.start,100);
      if(item.withdrawn!==undefined&&typeof item.withdrawn!=='boolean')throw new Error('A_SOURCE_STATE_INVALID');
      return {id:item.id,title:item.title,start:item.start??null,withdrawn:item.withdrawn??false};
    });
    if(new Set(normalized.map(x=>x.id)).size!==normalized.length)throw new Error('A_SOURCE_DUPLICATE_IN_PAGE');
    const stream=hash([provider,account,scope]),batch=hash({cursor,nextCursor,observedAt,normalized}),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO personal_source_streams(id,provider) VALUES(?,?)').run(stream,provider);
      db.prepare('UPDATE personal_source_streams SET provider=? WHERE id=? AND provider IS NULL').run(provider,stream);
      const prior=db.prepare('SELECT * FROM personal_source_streams WHERE id=?').get(stream);
      if(prior.provider!==provider)throw new Error('A_SOURCE_STREAM_PROVIDER_MISMATCH');
      if(prior.last_hash===batch||db.prepare('SELECT 1 FROM personal_source_pages WHERE stream_id=? AND batch_hash=?').get(stream,batch)){onCommit?.();db.exec('COMMIT');return {stream,replayed:true,imported:0};}
      if(prior.cursor!==cursor)throw new Error('A_SOURCE_CURSOR_CONFLICT');
      for(const item of normalized){
        const id=hash([stream,item.id]),old=db.prepare('SELECT * FROM personal_source_items WHERE id=?').get(id);
        if(old&&old.observed_at>observedAt)throw new Error('A_SOURCE_STALE_PAGE');
        const body=JSON.stringify({provider,title:item.title,start:item.start,timeInterpretation:item.start&&!/(Z|[+-]\d\d:\d\d)$/.test(item.start)?'unresolved-local-or-all-day':'as-provided'});
        if(old&&old.observed_at===observedAt&&(old.body!==body||old.withdrawn!==Number(item.withdrawn)))throw new Error('A_SOURCE_REVISION_CONFLICT');
        db.prepare(`INSERT INTO personal_source_items(id,stream_id,provider_id,body,observed_at,withdrawn) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,observed_at=excluded.observed_at,withdrawn=excluded.withdrawn`).run(id,stream,item.id,body,observedAt,Number(item.withdrawn));
      }
      db.prepare('UPDATE personal_source_streams SET cursor=?,last_hash=? WHERE id=?').run(nextCursor,batch,stream);
      db.prepare('INSERT INTO personal_source_pages VALUES(?,?)').run(stream,batch);
      onCommit?.();
      db.exec('COMMIT');return {stream,replayed:false,imported:normalized.length,executionAuthority:false};
    } catch(error){db.exec('ROLLBACK');throw error;}
  }
  /** Re-read the actual SQLite result; an ingest acknowledgement is not proof. */
  collectionCursor({provider,account,scope}) {
    if(!['outlook','teams-chat'].includes(provider))throw Error('A_SOURCE_PROVIDER_INVALID');
    text(account,200);text(scope,1000);
    const stream=hash([provider,account,scope]),row=this.store.db.prepare('SELECT provider,cursor FROM personal_source_streams WHERE id=?').get(stream);
    if(row&&row.provider!==provider)throw Error('A_SOURCE_STREAM_PROVIDER_MISMATCH');
    return {version:'personal-source-cursor-v1',present:!!row,nextCursor:row?.cursor??null,
      proof:'current-sqlite-cursor',providerObservationVerified:false,executionAuthority:false};
  }
  verifyCollection(pages) {
    const denied=()=>{throw Error('A_SOURCE_COLLECTION_OUTCOME_MISMATCH');};
    if(!Array.isArray(pages)||!pages.length||pages.length>100)denied();
    const first=pages[0],ids=new Set();let expected=first.cursor??null;
    for(const page of pages){
      if(page.provider!==first.provider||page.account!==first.account||page.scope!==first.scope||(page.cursor??null)!==expected)denied();
      expected=page.nextCursor??null;
      for(const item of page.items??[]){if(ids.has(item.id))denied();ids.add(item.id);}
      this.#verifyPage(page,{historical:true});
    }
    const last=this.verifyPage(pages.at(-1));
    return {version:'personal-source-collection-verification-v1',status:'passed',streamRef:last.streamRef,
      pageCount:pages.length,observedItemCount:ids.size,proof:'current-sqlite-chain-and-items',
      providerObservationVerified:false,snapshotVerified:false,executionAuthority:false};
  }
  verifyPage(page) { return this.#verifyPage(page); }
  // Explicit historical page membership, never proof of the current stream tail.
  verifyStoredPage(page) { return this.#verifyPage(page,{historical:true}); }
  #verifyPage(page,{historical=false}={}) {
    const denied = () => { throw new Error('A_SOURCE_PAGE_OUTCOME_MISMATCH'); };
    if (!page || !['gmail','google-calendar','outlook','teams-chat'].includes(page.provider)
      || typeof page.account !== 'string' || typeof page.scope !== 'string'
      || !Array.isArray(page.items) || page.items.length > 500) denied();
    const observedAt = normalizeStrictIsoInstant(page.observedAt,{requireSeconds:false});
    if (observedAt === null) denied();
    const cursor=page.cursor??null,nextCursor=page.nextCursor??null;
    const expected = page.items.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.title !== 'string'
        || (item.start!=null && typeof item.start!=='string')
        || (item.withdrawn!==undefined && typeof item.withdrawn!=='boolean')) denied();
      return {id:item.id,title:item.title,start:item.start??null,withdrawn:item.withdrawn??false};
    });
    if (new Set(expected.map(item=>item.id)).size !== expected.length) denied();
    const stream=hash([page.provider,page.account,page.scope]),batch=hash({cursor,nextCursor,observedAt,normalized:expected}),db=this.store.db;
    const current=db.prepare('SELECT cursor,last_hash,provider FROM personal_source_streams WHERE id=?').get(stream);
    if (!current || current.provider!==page.provider || (!historical&&(current.cursor!==nextCursor || current.last_hash!==batch))
      || !db.prepare('SELECT 1 FROM personal_source_pages WHERE stream_id=? AND batch_hash=?').get(stream,batch)) denied();
    const itemRefs=[];
    for (const item of expected) {
      const id=hash([stream,item.id]);
      const row=db.prepare('SELECT stream_id,provider_id,body,observed_at,withdrawn FROM personal_source_items WHERE id=?').get(id);
      let body;try {body=JSON.parse(row?.body);}catch {denied();}
      const interpretation=item.start&&!/(Z|[+-]\d\d:\d\d)$/.test(item.start)?'unresolved-local-or-all-day':'as-provided';
      if (!row || row.stream_id!==stream || row.provider_id!==item.id || row.observed_at!==observedAt
        || row.withdrawn!==Number(item.withdrawn) || !body || Object.keys(body).length!==4
        || body.provider!==page.provider || body.title!==item.title || body.start!==item.start
        || body.timeInterpretation!==interpretation) denied();
      itemRefs.push(id);
    }
    return {version:'personal-source-page-verification-v1',status:'passed',streamRef:stream,
      batchRef:batch,itemRefs,observedAt,observedItemCount:expected.length,
      verifiedWithdrawnCount:expected.filter(item=>item.withdrawn).length,proof:historical?'current-sqlite-historical-page-and-items':'current-sqlite-page-and-items',
      providerObservationVerified:false,executionAuthority:false};
  }
  list() {
    return this.store.db.prepare('SELECT * FROM personal_source_items ORDER BY observed_at DESC,id').all().map(row=>({id:row.id,...JSON.parse(row.body),observedAt:row.observed_at,withdrawn:!!row.withdrawn,commitmentId:row.commitment_id,requiresReview:!row.commitment_id,executionAuthority:false}));
  }
  selectedStreams() {
    return this.store.db.prepare(`SELECT s.id AS streamRef,s.provider,COUNT(i.id) AS itemCount,MAX(i.observed_at) AS lastObservedAt
      FROM personal_source_streams s LEFT JOIN personal_source_items i ON i.stream_id=s.id
      WHERE s.provider IN ('gmail','google-calendar','outlook','teams-chat') GROUP BY s.id,s.provider ORDER BY s.provider,s.id`).all()
      .map(row=>({...row,itemCount:Number(row.itemCount),providerObservationVerified:false,executionAuthority:false}));
  }
  accept({id,dueAt}) {
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try {
      const row=db.prepare('SELECT * FROM personal_source_items WHERE id=?').get(text(id,64));
      if(!row||row.withdrawn)throw new Error('A_SOURCE_NOT_AVAILABLE');
      if(row.commitment_id){db.exec('COMMIT');return {id:row.commitment_id,replayed:true};}
      const item=JSON.parse(row.body);
      // A concrete deadline is chosen by the caller, never inferred from email prose.
      const commitment=this.store.createCommitment({title:item.title,dueAt,sourceRef:`source-inbox:${id}`});
      db.prepare('UPDATE personal_source_items SET commitment_id=?,accepted_source_hash=? WHERE id=?').run(commitment.id,hash({body:row.body,withdrawn:row.withdrawn}),id);
      db.exec('COMMIT');return commitment;
    } catch(error){db.exec('ROLLBACK');throw error;}
  }
}
