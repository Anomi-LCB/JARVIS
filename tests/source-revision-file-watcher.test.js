import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceRevisionFileWatcher } from '../packages/core/src/runtime/source-revision-file-watcher.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-source-watch-'));
  const file = join(root, 'notes.json');
  await writeFile(file, '{"revision":1}', 'utf8');
  const registrations = [];
  const inboxRows = [];
  const inbox = { ingest(event) { inboxRows.push(event); return { accepted: true, duplicate: false, current: { revision: inboxRows.length } }; } };
  const watcher = new SourceRevisionFileWatcher({ inbox, allowedRoots: [root], debounceMs: 25,
    clock: () => new Date('2026-09-30T01:00:00.000Z'), eventId: () => `event-${inboxRows.length + 1}`,
    watchFactory(directory, options, listener) {
      const item = { directory, options, listener, closed: false, on() { return this; }, close() { this.closed = true; } };
      registrations.push(item); return item;
    } });
  return { root, file, registrations, inboxRows, watcher, close: async () => { await watcher.close(); await rm(root, { recursive: true, force: true }); } };
}

test('file watcher scopes registration beneath allowed roots and rejects symlinks', async t => {
  const f = await fixture(); t.after(f.close);
  const registered = await f.watcher.register({ sourceKey: 'research:notes', sourcePath: f.file });
  assert.equal(registered.status, 'watching');
  assert.equal(f.watcher.status().registrations.length, 1);
  const outside = join(tmpdir(), `jarvis-outside-${process.pid}.txt`);
  await writeFile(outside, 'outside', 'utf8');
  try { await assert.rejects(f.watcher.register({ sourceKey: 'outside', sourcePath: outside }), { code: 'A_SOURCE_WATCH_PATH_OUTSIDE_ALLOWED_ROOT' }); }
  finally { await rm(outside, { force: true }); }
  const link = join(f.root, 'link.json');
  try {
    await symlink(f.file, link);
    await assert.rejects(f.watcher.register({ sourceKey: 'linked', sourcePath: link }), { code: 'A_SOURCE_WATCH_FILE_TYPE_REJECTED' });
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    t.diagnostic('Symlink creation is unavailable on this test host; regular-file and root checks still ran.');
  }
});

test('file watcher filters unrelated names, coalesces bursts and ingests only changed bytes', async t => {
  const f = await fixture(); t.after(f.close);
  await f.watcher.register({ sourceKey: 'research:notes', sourcePath: f.file, quietPeriodMs: 50 });
  const emit = f.registrations[0].listener;
  emit('change', 'other.json');
  await writeFile(f.file, '{"revision":2}', 'utf8');
  emit('change', 'notes.json');
  await writeFile(f.file, '{"revision":3}', 'utf8');
  emit('change', 'notes.json');
  emit('rename', null); // Windows and some providers report null on directory replacement/overflow; resnapshot exact file.
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.inboxRows.length, 1);
  assert.equal(f.inboxRows[0].sourceKey, 'research:notes');
  assert.equal(f.inboxRows[0].sourcePath, f.file);
  assert.equal(f.inboxRows[0].quietPeriodMs, 50);
  assert.match(f.inboxRows[0].sourceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(f.watcher.status().registrations[0].pending, false);
});

test('watcher shutdown closes OS handles and refuses later registration', async t => {
  const f = await fixture(); t.after(f.close);
  await f.watcher.register({ sourceKey: 'research:notes', sourcePath: f.file });
  const handle = f.registrations[0];
  await f.watcher.close();
  assert.equal(handle.closed, true);
  assert.equal(f.watcher.status().active, false);
  await assert.rejects(f.watcher.register({ sourceKey: 'again', sourcePath: f.file }), { code: 'A_SOURCE_WATCHER_CLOSED' });
});

test('watcher refuses oversized inputs before reading them into memory', async t => {
  const f = await fixture(); t.after(f.close);
  const bounded = new SourceRevisionFileWatcher({ inbox: f.watcher.inbox, allowedRoots: [f.root], maxFileBytes: 1024,
    watchFactory: f.watcher.watchFactory });
  t.after(() => bounded.close());
  await writeFile(f.file, 'x'.repeat(2048), 'utf8');
  await assert.rejects(bounded.register({ sourceKey: 'large', sourcePath: f.file }), { code: 'A_SOURCE_WATCH_FILE_TOO_LARGE' });
});
