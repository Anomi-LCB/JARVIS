import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { watch as watchDirectory } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** Watches only explicitly registered regular files beneath configured roots. File bodies are never retained. */
export class SourceRevisionFileWatcher {
  constructor({ inbox, allowedRoots, watchFactory = watchDirectory, clock = () => new Date(), debounceMs = 250,
    maxFileBytes = 16 * 1024 * 1024, maxWatches = 64, eventId = randomUUID, onError = () => {} } = {}) {
    if (typeof inbox?.ingest !== 'function' || !Array.isArray(allowedRoots) || !allowedRoots.length) fail('A_SOURCE_WATCHER_CONFIG_INVALID');
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 25 || debounceMs > 10_000) fail('A_SOURCE_WATCHER_DEBOUNCE_INVALID');
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1_024 || maxFileBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(maxWatches) || maxWatches < 1 || maxWatches > 256) fail('A_SOURCE_WATCHER_LIMIT_INVALID');
    this.inbox = inbox;
    this.allowedRoots = allowedRoots.map(path => resolve(path));
    this.watchFactory = watchFactory;
    this.clock = clock;
    this.debounceMs = debounceMs;
    this.maxFileBytes = maxFileBytes;
    this.maxWatches = maxWatches;
    this.eventId = eventId;
    this.onError = onError;
    this.sources = new Map();
    this.closed = false;
  }

  async register({ sourceKey, sourcePath, quietPeriodMs = 750 } = {}) {
    if (this.closed) fail('A_SOURCE_WATCHER_CLOSED');
    if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/u.test(sourceKey)) fail('A_SOURCE_WATCHER_KEY_INVALID');
    const path = resolve(sourcePath ?? '');
    if (this.sources.size >= this.maxWatches) fail('A_SOURCE_WATCH_LIMIT_REACHED');
    if ([...this.sources.values()].some(item => item.path === path || item.sourceKey === sourceKey)) fail('A_SOURCE_WATCHER_DUPLICATE');
    const stored = this.inbox.listWatches?.().find(item => item.sourceKey === sourceKey);
    if (stored?.sourcePath && resolve(stored.sourcePath) !== path) fail('A_SOURCE_REVISION_PATH_CONFLICT');
    const snapshot = await this.readSnapshot(path);
    const root = snapshot.root;
    const directory = dirname(path);
    const fileName = basename(path);
    const state = { sourceKey, path, root, fileName, quietPeriodMs, knownSha256: snapshot.sha256, watcher: null, timer: null, pending: false, chain: Promise.resolve() };
    const watcher = this.watchFactory(directory, { persistent: true }, (eventType, changedName) => {
      if (changedName !== null && changedName !== undefined && String(changedName) !== fileName) return;
      state.pending = true;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.timer = null; state.chain = state.chain.then(() => this.flush(state)).catch(error => this.onError(error, { sourceKey })); }, this.debounceMs);
      state.timer.unref?.();
    });
    watcher.on?.('error', error => this.onError(error, { sourceKey }));
    try { this.inbox.registerWatch?.({ sourceKey, sourcePath: path, quietPeriodMs }); }
    catch (error) { watcher.close?.(); throw error; }
    this.sources.set(sourceKey, state);
    state.watcher = watcher;
    return { sourceKey, sourcePath: path, allowedRoot: root, status: 'watching', initialSha256: snapshot.sha256 };
  }

  async startRegistered() {
    const registrations = this.inbox.listWatches?.({ activeOnly: true }) ?? [];
    const results = [];
    for (const registration of registrations) {
      try { results.push(await this.register(registration)); }
      catch (error) { this.onError(error, { sourceKey: registration.sourceKey, startup: true }); results.push({ sourceKey: registration.sourceKey, status: 'failed', code: error?.code ?? 'A_SOURCE_WATCH_START_FAILED' }); }
    }
    return { attempted: registrations.length, watching: results.filter(item => item.status === 'watching').length, results };
  }

  async unregister(sourceKey) {
    const state = this.sources.get(sourceKey);
    if (!state) return { removed: false, reason: 'watch-not-active' };
    clearTimeout(state.timer);
    state.watcher?.close?.();
    await state.chain.catch(() => {});
    this.sources.delete(sourceKey);
    this.inbox.removeWatch?.(sourceKey);
    return { removed: true, sourceKey };
  }

  async reconcileCurrent(sourceKey) {
    const state = this.sources.get(sourceKey);
    if (!state) fail('A_SOURCE_WATCH_NOT_ACTIVE');
    const snapshot = await this.readSnapshot(state.path);
    if (snapshot.sha256 === state.knownSha256) return { changed: false, sha256: snapshot.sha256 };
    const observedAt = this.clock().toISOString();
    const result = this.inbox.ingest({ sourceKey, eventId: this.eventId(), sourcePath: state.path,
      sourceSha256: snapshot.sha256, observedAt, quietPeriodMs: state.quietPeriodMs });
    if (result.accepted || result.duplicate) state.knownSha256 = snapshot.sha256;
    return { changed: result.accepted, sha256: snapshot.sha256, result };
  }

  async readSnapshot(path) {
    let lexical;
    try { lexical = await lstat(path); } catch (error) { fail(error?.code === 'ENOENT' ? 'A_SOURCE_WATCH_FILE_MISSING' : 'A_SOURCE_WATCH_FILE_UNAVAILABLE'); }
    if (lexical.isSymbolicLink() || !lexical.isFile()) fail('A_SOURCE_WATCH_FILE_TYPE_REJECTED');
    const actualPath = await realpath(path).catch(() => fail('A_SOURCE_WATCH_FILE_UNAVAILABLE'));
    const actualRoots = await Promise.all(this.allowedRoots.map(root => realpath(root).catch(() => null)));
    const root = actualRoots.find(candidate => candidate && inside(candidate, actualPath));
    if (!root) fail('A_SOURCE_WATCH_PATH_OUTSIDE_ALLOWED_ROOT');
    const handle = await open(path, constants.O_RDONLY).catch(() => fail('A_SOURCE_WATCH_FILE_UNAVAILABLE'));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== lexical.dev || opened.ino !== lexical.ino || opened.size !== lexical.size) fail('A_SOURCE_WATCH_FILE_CHANGED_DURING_READ');
      if (opened.size > this.maxFileBytes) fail('A_SOURCE_WATCH_FILE_TOO_LARGE');
      const bytes = await handle.readFile();
      const [after, finalRealPath] = await Promise.all([lstat(path), realpath(path)]);
      if (bytes.length > this.maxFileBytes || after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || finalRealPath !== actualPath) fail('A_SOURCE_WATCH_FILE_CHANGED_DURING_READ');
      return { root, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle.close(); }
  }

  async flush(state) {
    if (this.closed || !state.pending) return { accepted: false, reason: 'watcher-closed-or-idle' };
    state.pending = false;
    const snapshot = await this.readSnapshot(state.path);
    if (snapshot.sha256 === state.knownSha256) return { accepted: false, reason: 'content-unchanged' };
    const observedAt = this.clock().toISOString();
    const result = this.inbox.ingest({ sourceKey: state.sourceKey, eventId: this.eventId(), sourcePath: state.path,
      sourceSha256: snapshot.sha256, observedAt, quietPeriodMs: state.quietPeriodMs });
    if (result.accepted || result.duplicate) state.knownSha256 = snapshot.sha256;
    return { ...result, sourceKey: state.sourceKey, observedAt, sourceSha256: snapshot.sha256 };
  }

  status() {
    return { version: 'a-source-revision-file-watcher-v1', active: !this.closed,
      registrations: [...this.sources.values()].map(({ sourceKey, path, root, pending }) => ({ sourceKey, sourcePath: path, allowedRoot: root, pending })) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.sources.values()) { clearTimeout(state.timer); state.watcher?.close?.(); }
    await Promise.all([...this.sources.values()].map(state => state.chain.catch(() => {})));
    this.sources.clear();
  }
}
