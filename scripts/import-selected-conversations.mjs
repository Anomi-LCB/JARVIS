import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { selectedConversationDocumentHash } from '../apps/growth-memory/src/selected-conversation-archive.js';
import { convertChatGptExport } from '../apps/growth-memory/src/chatgpt-export-adapter.js';
import {readChatGptExportFile,exportFileLimits} from '../packages/shared/src/chatgpt-export-file.js';

let store;
try {
  const { values } = parseArgs({ options: { document: { type: 'string' }, select: { type: 'string', multiple: true },
    user: { type: 'string' }, workspace: { type: 'string' }, conversation: { type: 'string' },
    'source-ref': { type: 'string' }, store: { type: 'string' }, 'expected-hash': { type: 'string' },
    commit: { type: 'boolean', default: false }, withdraw: { type: 'string' },
    'chatgpt-export': { type: 'boolean', default: false }, 'expected-export-hash': { type: 'string' } } });
  if (!values.store || !values.user || !values.workspace) throw { code: 'F_CONVERSATION_EXPLICIT_DESTINATION_REQUIRED' };
  const scope = { userId: values.user, workspaceRoot: resolve(values.workspace), conversationId: values.conversation ?? null };
  let document,exportConversion,sourceBytesHash;
  if (!values.withdraw) {
    if (!values.document || !values['source-ref']) throw { code: 'F_CONVERSATION_DOCUMENT_REQUIRED' };
    let fd;
    try {
      fd = openSync(values.document, 'r');
      const stat = fstatSync(fd);
      const limit=values['chatgpt-export']?exportFileLimits.archiveBytes:4*1024*1024;
      if (!stat.isFile() || stat.size > limit) throw { code: 'F_CONVERSATION_IMPORT_TOO_LARGE' };
      const bytes = Buffer.alloc(Math.min(stat.size+1,limit+1));
      let count = 0, read;
      while (count < bytes.length && (read = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += read;
      if (count > limit) throw { code: 'F_CONVERSATION_IMPORT_TOO_LARGE' };
      const after=fstatSync(fd);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||count!==stat.size)throw {code:'F_CONVERSATION_EXPORT_CHANGED'};
      sourceBytesHash=createHash('sha256').update(bytes.subarray(0,count)).digest('hex');
      document = values['chatgpt-export']?(await readChatGptExportFile(bytes.subarray(0,count),{name:values.document})).document
        :JSON.parse(bytes.subarray(0,count).toString('utf8').replace(/^\uFEFF/u,''));
    } finally { if (fd !== undefined) closeSync(fd); }
    if(values['chatgpt-export']){
      exportConversion=convertChatGptExport(document,values.select);exportConversion.sourceExportHash=sourceBytesHash;document=exportConversion.document;
      if(values.commit&&values['expected-export-hash']!==exportConversion.sourceExportHash)
        throw {code:'F_CONVERSATION_EXPORT_CHANGED'};
    } else if(values['expected-export-hash'])throw {code:'F_CONVERSATION_EXPORT_FLAG_REQUIRED'};
    if (values.commit && !values['expected-hash']) throw { code: 'F_CONVERSATION_REVIEW_HASH_REQUIRED' };
  } else if (!values.commit) throw { code: 'F_CONVERSATION_WITHDRAW_COMMIT_REQUIRED' };
  const dbPath = resolve(values.store), root = dirname(dbPath);
  store = new SqliteMemoryStore({ dbPath, reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
  const runtime = new GrowthRuntime({ memoryStore: store, auditRoot: join(root, 'audit') });
  const result = values.withdraw ? runtime.withdrawImportedConversationMessage({ id: values.withdraw, scope })
    : runtime.importSelectedConversations({ document, scope, selectedConversationIds: values.select,
      sourceRef: exportConversion ? `${values['source-ref']}:export-sha256:${exportConversion.sourceExportHash}` : values['source-ref'],
      expectedDocumentHash: values['expected-hash'] ?? selectedConversationDocumentHash(document) }, { commit: values.commit });
  if(exportConversion){result.sourceExportHash=exportConversion.sourceExportHash;result.adapterVersion=exportConversion.adapterVersion;result.excludedMessageCounts=exportConversion.excludedMessageCounts;}
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'blocked', code: error.code ?? 'F_CONVERSATION_IMPORT_INVALID', executionAuthority: false })}\n`);
  process.exitCode = 1;
} finally { store?.close(); }
