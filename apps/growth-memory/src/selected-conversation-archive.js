import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeMemoryScope } from './memory-provenance.js';
import { createMemoryTextMatcher } from './memory-relevance.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) fail('F_CONVERSATION_IDENTIFIER_INVALID');
  return value;
}

/** Explicitly selected archival observations. Never tasks, grants or learned procedures. */
export class SelectedConversationArchive {
  constructor({ db, store, sensitiveText, clock = () => new Date() }) {
    if (typeof sensitiveText !== 'function') fail('F_CONVERSATION_SENSITIVE_CHECK_REQUIRED');
    this.store = store ?? { db }; this.sensitiveText = sensitiveText; this.clock = clock;
    this.cursorKey = randomBytes(32);
    this.ensureSchema();
  }
  ensureSchema() {
    if (this.initializedDb === this.db) return;
    if (this.initializedDb) this.cursorKey = randomBytes(32);
    this.orderCache = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS selected_conversation_messages (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL,
      content_hash TEXT NOT NULL, source_ref TEXT NOT NULL, source_document_hash TEXT NOT NULL,
      spoken_at TEXT NOT NULL, imported_at TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope_key, conversation_id, message_id));`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS selected_conversation_scope_time
      ON selected_conversation_messages(scope_key,withdrawn,spoken_at DESC,id);`);
    this.identityIndex=this.db.prepare('PRAGMA index_list(selected_conversation_messages)').all().find(index=>index.origin==='pk')?.name;
    if (!this.identityIndex) fail('F_CONVERSATION_STORAGE_REQUIRED');
    // SQLite triggers cover other connections and older writers too. The
    // revision changes atomically with archive writes, without copying text
    // or scanning all scoped metadata on every page.
    this.db.exec(`CREATE TABLE IF NOT EXISTS selected_conversation_scope_revisions (
      scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS selected_conversation_revision_insert
      AFTER INSERT ON selected_conversation_messages BEGIN
        INSERT INTO selected_conversation_scope_revisions VALUES(NEW.scope_key,1)
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS selected_conversation_revision_delete
      AFTER DELETE ON selected_conversation_messages BEGIN
        INSERT INTO selected_conversation_scope_revisions VALUES(OLD.scope_key,1)
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS selected_conversation_revision_update
      AFTER UPDATE ON selected_conversation_messages BEGIN
        INSERT INTO selected_conversation_scope_revisions VALUES(OLD.scope_key,1)
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
        INSERT INTO selected_conversation_scope_revisions SELECT NEW.scope_key,1 WHERE NEW.scope_key!=OLD.scope_key
        ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
      END;`);
    // Preserve raw declarations and legacy rows. Use the same parser accepted
    // at ingestion instead of lexicographic timestamp ordering or a second copy.
    this.db.function('jarvis_selected_conversation_epoch',{deterministic:true},value=>{
      const instant=Date.parse(value);if(!Number.isFinite(instant))fail('F_CONVERSATION_TIME_REQUIRED');
      return instant;
    });
    this.initializedDb = this.db;
  }
  get db() { return this.store.db; }
  prepare({ document, selectedConversationIds, scope, expectedDocumentHash, sourceRef }) {
    const normalizedScope = normalizeMemoryScope(scope);
    if (!normalizedScope) fail('F_CONVERSATION_SCOPE_REQUIRED');
    identifier(sourceRef);
    if (this.sensitiveText(sourceRef)) fail('F_CONVERSATION_SENSITIVE_REVIEW_REQUIRED');
    if (!document || document.format !== 'jarvis-selected-conversations-v1' || !['chatgpt', 'jarvis'].includes(document.provider)
      || !Array.isArray(document.conversations) || document.conversations.length > 500) fail('F_CONVERSATION_FORMAT_UNSUPPORTED');
    if (Object.keys(document).some(key => !['format', 'provider', 'conversations'].includes(key))) fail('F_CONVERSATION_FIELDS_UNSUPPORTED');
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) fail('F_CONVERSATION_IMPORT_TOO_LARGE');
    const documentHash = digest(serialized);
    if (expectedDocumentHash !== documentHash) fail('F_CONVERSATION_DOCUMENT_CHANGED');
    if (!Array.isArray(selectedConversationIds) || !selectedConversationIds.length || selectedConversationIds.length > 20
      || new Set(selectedConversationIds).size !== selectedConversationIds.length) fail('F_CONVERSATION_SELECTION_REQUIRED');
    selectedConversationIds.forEach(identifier);
    const allIds = document.conversations.map(item => identifier(item?.id));
    if (new Set(allIds).size !== allIds.length || selectedConversationIds.some(id => !allIds.includes(id))) fail('F_CONVERSATION_SELECTION_INVALID');
    const scopeKey = JSON.stringify(normalizedScope), messages = [];
    for (const conversation of document.conversations.filter(item => selectedConversationIds.includes(item.id))) {
      if (Object.keys(conversation).some(key => !['id', 'messages'].includes(key))) fail('F_CONVERSATION_FIELDS_UNSUPPORTED');
      if (!Array.isArray(conversation.messages) || conversation.messages.length > 500) fail('F_CONVERSATION_MESSAGES_INVALID');
      const seen = new Set();
      for (const message of conversation.messages) {
        identifier(message?.id);
        if (Object.keys(message).some(key => !['id', 'speaker', 'text', 'spokenAt'].includes(key))) fail('F_CONVERSATION_FIELDS_UNSUPPORTED');
        if (seen.has(message.id)) fail('F_CONVERSATION_MESSAGE_DUPLICATE');
        seen.add(message.id);
        if (!['user', 'assistant'].includes(message.speaker)) fail('F_CONVERSATION_SPEAKER_UNSUPPORTED');
        if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 20_000
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.text)) fail('F_CONVERSATION_TEXT_INVALID');
        if (this.sensitiveText(message.text)) fail('F_CONVERSATION_SENSITIVE_REVIEW_REQUIRED');
        if (typeof message.spokenAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/u.test(message.spokenAt)
          || !Number.isFinite(Date.parse(message.spokenAt))) fail('F_CONVERSATION_TIME_REQUIRED');
        const contentHash = digest(JSON.stringify([message.speaker, message.text, message.spokenAt]));
        messages.push({ id: digest(JSON.stringify([scopeKey, conversation.id, message.id])), scopeKey,
          conversationId: conversation.id, messageId: message.id, speaker: message.speaker, text: message.text,
          spokenAt: message.spokenAt, contentHash, sourceRef, documentHash });
      }
    }
    if (!messages.length || messages.length > 1_000) fail('F_CONVERSATION_MESSAGE_BUDGET');
    return { documentHash, messages };
  }
  import(input, { commit = false } = {}) {
    if (typeof commit !== 'boolean') fail('F_CONVERSATION_COMMIT_INVALID');
    this.ensureSchema();
    const prepared = this.prepare(input);
    const prior = this.db.prepare('SELECT content_hash, withdrawn FROM selected_conversation_messages WHERE id=?');
    const inspect = () => {
      for (const message of prepared.messages) {
        const row = prior.get(message.id);
        if (row && row.content_hash !== message.contentHash) fail('F_CONVERSATION_REVISION_CONFLICT');
      }
    };
    if (!commit) { inspect(); return { documentHash: prepared.documentHash, selectedMessages: prepared.messages.length,
      preview: true, executionAuthority: false }; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      inspect();
      let imported = 0, replayed = 0, withdrawn = 0;
      const insert = this.db.prepare('INSERT INTO selected_conversation_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,0)');
      for (const message of prepared.messages) {
        const old = prior.get(message.id);
        if (old) { if (old.withdrawn) withdrawn++; else replayed++; continue; }
        insert.run(message.id, message.scopeKey, message.conversationId, message.messageId, message.speaker,
          message.text, message.contentHash, message.sourceRef, message.documentHash, message.spokenAt, this.clock().toISOString());
        imported++;
      }
      this.db.exec('COMMIT');
      return { documentHash: prepared.documentHash, imported, replayed, withdrawn, executionAuthority: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  query(query, { scope, limit = 5, after = null } = {}) {
    const normalizedScope = normalizeMemoryScope(scope);
    if (!normalizedScope || typeof query !== 'string' || !query.trim() || query.length > 4_000) return [];
    this.ensureSchema();
    if (!Number.isInteger(limit) || limit < 1 || limit > 51) fail('F_CONVERSATION_PAGE_INVALID');
    const ownsSnapshot = !this.db.isTransaction;
    if (ownsSnapshot) this.db.exec('BEGIN');
    try {
      const result=this.#readQuotes(query,normalizedScope,{limit,after,reuseOrder:ownsSnapshot});
      if (ownsSnapshot) this.db.exec('COMMIT');
      return result;
    } catch(error) {if (ownsSnapshot) this.db.exec('ROLLBACK');throw error;}
  }
  *#orderedRows(scopeKey,after,reuseOrder) {
    const revision=this.db.prepare('SELECT revision FROM selected_conversation_scope_revisions WHERE scope_key=?').get(scopeKey)?.revision ?? 0;
    if (reuseOrder) {
      if (this.orderCache?.scopeKey!==scopeKey || this.orderCache?.revision!==revision) {
        this.orderCache=null;
        const metadata=this.db.prepare('SELECT id,spoken_at FROM selected_conversation_messages WHERE scope_key=? AND withdrawn=0 LIMIT 50001').all(scopeKey);
        // Bounded, one-scope metadata only. Larger archives retain the complete
        // uncached path rather than losing rows or keeping an unbounded cache.
        if (metadata.length<=50000) {
          const entries=metadata.map(row=>{
            const time=Date.parse(row.spoken_at);if(!Number.isFinite(time))fail('F_CONVERSATION_TIME_REQUIRED');
            return {id:row.id,time};
          }).sort((a,b)=>b.time-a.time||(a.id<b.id?-1:a.id>b.id?1:0));
          this.orderCache={scopeKey,revision,entries};
        }
      }
      if (this.orderCache) {
        const entries=this.orderCache.entries;
        let start=0;
        if (after) {
          let high=entries.length;
          while(start<high){const mid=(start+high)>>>1,item=entries[mid];
            if(item.time<after.time||(item.time===after.time&&item.id>after.id))high=mid;else start=mid+1;}
        }
        const lookups=new Map();
        for(let i=start;i<entries.length;i+=64){
          const ids=entries.slice(i,i+64).map(item=>item.id);
          if (!lookups.has(ids.length)) lookups.set(ids.length,this.db.prepare(`SELECT * FROM selected_conversation_messages INDEXED BY "${this.identityIndex.replace(/"/gu,'""')}"
            WHERE scope_key=? AND withdrawn=0 AND id IN (${ids.map(()=>'?').join(',')})`));
          const rows=new Map(lookups.get(ids.length).all(scopeKey,...ids).map(row=>[row.id,row]));
          for(const id of ids){
            const row=rows.get(id);if(!row)fail('F_CONVERSATION_PAGE_CHANGED');
            yield row;
          }
        }
        return;
      }
    }
    const condition = after ? ' AND (jarvis_selected_conversation_epoch(spoken_at) < ? OR (jarvis_selected_conversation_epoch(spoken_at)=? AND id>?))' : '';
    const parameters = after ? [scopeKey,after.time,after.time,after.id] : [scopeKey];
    yield* this.db.prepare(`SELECT * FROM selected_conversation_messages WHERE scope_key=? AND withdrawn=0${condition}
      ORDER BY jarvis_selected_conversation_epoch(spoken_at) DESC,id`).iterate(...parameters);
  }
  #readQuotes(query, normalizedScope, { limit, after, reuseOrder = true }) {
    const matcher=createMemoryTextMatcher(query);if(!matcher.hasTerms)return [];
    const results=[];
    // Every quote still comes from the current scoped SQLite read snapshot;
    // the reusable order contains no source text or remembered preferences.
    for(const row of this.#orderedRows(JSON.stringify(normalizedScope),after,reuseOrder)) {
      const match=matcher.findMatch(row.text);if(!match)continue;
      let start=row.text.length<=2000?0:Math.max(0,match.start-400);
      if(start>0&&/[\uDC00-\uDFFF]/u.test(row.text[start]))start--;
      let end=Math.min(row.text.length,start+2000);
      if(end<row.text.length&&/[\uDC00-\uDFFF]/u.test(row.text[end]))end--;
      results.push({
      memoryId: row.id, memoryType: 'selected_conversation_quote', text: row.text.slice(start,end),
      sourceTextStart:start,sourceTextEnd:end,sourceTextLength:row.text.length,
      matchFullyIncluded:match.start>=start&&match.end<=end,
      truncated: start>0||end<row.text.length, speaker: row.speaker, sourceConversationId: row.conversation_id,
      sourceMessageId: row.message_id, sourceRef: row.source_ref, observedAt: row.spoken_at, importedAt: row.imported_at,
      applyMode: 'untrusted_archival_reference_only', executionAuthority: false,
      provenance: { memoryKind: row.speaker === 'user' ? 'imported_user_statement' : 'imported_assistant_statement',
        sourceDocumentHash: row.source_document_hash, sourceContentHash: row.content_hash,
        sourceEventIds:[row.id], observedAt:[row.spoken_at], usageScopes:[structuredClone(normalizedScope)],
        validity:{validUntil:null,basis:'unspecified'},
        revisionReference:{revision:null,supersedesEventId:null},
        revisionMode:'immutable-import', revisionHistory:[{action:'import',at:row.imported_at}],
        authenticity: 'user-selected-document; speaker and dates declared by file', independentlyVerifiedOutcome: false,
        procedureValidated: false, executionAuthority: false, externalContent: true }
      });
      if(results.length===limit)break;
    }
    return results;
  }
  queryPage(query, { scope, pageSize = 20, cursor = null } = {}) {
    const normalizedScope = normalizeMemoryScope(scope);
    if (!normalizedScope || typeof query !== 'string' || !query.trim() || query.length > 4000
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) fail('F_CONVERSATION_PAGE_INVALID');
    this.ensureSchema();
    const binding = digest(JSON.stringify([normalizedScope,query,pageSize]));
    let previous = null;
    if (cursor !== null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error();
        const [payload,signature,...extra] = cursor.split('.');
        const expected = createHmac('sha256',this.cursorKey).update(payload).digest();
        const actual = Buffer.from(signature ?? '', 'base64url');
        if (extra.length || actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new Error();
        previous = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
        if (previous.binding !== binding || !Number.isFinite(previous.time) || !/^[a-f0-9]{64}$/u.test(previous.id)) throw new Error();
      } catch { fail('F_CONVERSATION_CURSOR_INVALID'); }
    }
    this.db.exec('BEGIN');
    try {
      // Persistent revision and rows share one SQLite snapshot. A new page
      // cannot silently mix imports/withdrawals from different archive states.
      const revision = this.db.prepare('SELECT revision FROM selected_conversation_scope_revisions WHERE scope_key=?').get(JSON.stringify(normalizedScope))?.revision ?? 0;
      const snapshot = `scope-revision-v1:${revision}`;
      if (previous && previous.snapshot !== snapshot) fail('F_CONVERSATION_PAGE_CHANGED');
      const rows = this.#readQuotes(query,normalizedScope,{limit:pageSize+1,after:previous});
      const hasMore = rows.length > pageSize, items = rows.slice(0,pageSize);
      let nextCursor = null;
      if (hasMore) {
        const last = items.at(-1);
        const payload = Buffer.from(JSON.stringify({binding,snapshot,time:Date.parse(last.observedAt),id:last.memoryId})).toString('base64url');
        nextCursor = payload+'.'+createHmac('sha256',this.cursorKey).update(payload).digest('base64url');
      }
      this.db.exec('COMMIT');
      return { items, pageSize, hasMore, nextCursor, executionAuthority:false };
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  withdraw({ id, scope }) {
    identifier(id);
    const normalizedScope = normalizeMemoryScope(scope);
    if (!normalizedScope) fail('F_CONVERSATION_SCOPE_REQUIRED');
    this.ensureSchema();
    const result = this.db.prepare('UPDATE selected_conversation_messages SET withdrawn=1,text=? WHERE id=? AND scope_key=?')
      .run('[withdrawn archival text]', id, JSON.stringify(normalizedScope));
    return { withdrawn: result.changes > 0, executionAuthority: false };
  }
}

export const selectedConversationDocumentHash = document => digest(JSON.stringify(document));
