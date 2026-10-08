import { createHash } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, closeSync, fstatSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 'jarvis-research-ledger-v1';
const KINDS = new Set(['source-review', 'contract-test', 'runtime-connection', 'workflow-test', 'comparison']);
const OUTCOMES = new Set(['passed', 'failed', 'blocked', 'inconclusive']);
const MAX_EVIDENCE_BYTES_PER_ATTEMPT = 4 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const stable = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
function text(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('RESEARCH_INVALID_TEXT');
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value)) fail('RESEARCH_INVALID_ID');
  return value;
}
function url(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('RESEARCH_INVALID_SOURCE'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) fail('RESEARCH_INVALID_SOURCE');
  return parsed.href;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) fail('RESEARCH_INVALID_DATE');
  return value;
}
function candidate(input) {
  if (!input || !Number.isInteger(input.priority) || input.priority < 1 || input.priority > 3 ||
      !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 8) fail('RESEARCH_INVALID_CANDIDATE');
  const sources = input.sources.map(source => ({ url: url(source.url), checkedAt: date(source.checkedAt), revision: text(source.revision, 200) })).sort((a, b) => a.url.localeCompare(b.url));
  if (new Set(sources.map(source => source.url)).size !== sources.length) fail('RESEARCH_DUPLICATE_SOURCE');
  return { id: id(input.id), title: text(input.title, 200), problem: text(input.problem), priority: input.priority,
    sources, nextExperiment: text(input.nextExperiment) };
}
function contained(root, path) {
  const rel = relative(root, path);
  return Boolean(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// Development research records are separate from F/cognition's verified user-task memory.
// File integrity supports traceability, not the truth of a reported experimental conclusion.
export class ResearchLedger {
  constructor({ workspaceRoot, storePath = null, clock = () => new Date().toISOString() } = {}) {
    this.root = realpathSync(workspaceRoot);
    this.clock = clock;
    if (storePath) mkdirSync(dirname(resolve(storePath)), { recursive: true });
    this.db = new DatabaseSync(storePath ?? ':memory:');
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.db.exec('CREATE TABLE IF NOT EXISTS research_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const version = this.db.prepare("SELECT value FROM research_meta WHERE key='version'").get()?.value;
      if (version && version !== VERSION) fail('RESEARCH_SCHEMA_UNSUPPORTED');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS research_definitions (
          candidate_id TEXT NOT NULL, revision TEXT NOT NULL, definition_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
          PRIMARY KEY(candidate_id,revision));
        CREATE TABLE IF NOT EXISTS research_candidates (
          candidate_id TEXT PRIMARY KEY, revision TEXT NOT NULL,
          FOREIGN KEY(candidate_id,revision) REFERENCES research_definitions(candidate_id,revision));
        CREATE TABLE IF NOT EXISTS research_attempts (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT UNIQUE NOT NULL, candidate_id TEXT NOT NULL,
          candidate_revision TEXT NOT NULL, record_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
          FOREIGN KEY(candidate_id,candidate_revision) REFERENCES research_definitions(candidate_id,revision));
        CREATE INDEX IF NOT EXISTS research_attempt_candidate ON research_attempts(candidate_id,seq DESC);
        CREATE TABLE IF NOT EXISTS research_watches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE NOT NULL, observed_at TEXT NOT NULL, record_json TEXT NOT NULL);`);
      this.db.prepare('INSERT OR IGNORE INTO research_meta VALUES (?,?)').run('version', VERSION);
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  syncCandidates(config) {
    if (config?.version !== 1 || !Array.isArray(config.candidates) || !config.candidates.length || config.candidates.length > 128) fail('RESEARCH_INVALID_CATALOG');
    const values = config.candidates.map(candidate);
    if (new Set(values.map(value => value.id)).size !== values.length) fail('RESEARCH_DUPLICATE_CANDIDATE');
    return this.transaction(() => values.map(value => {
      const json = stable(value), revision = hash(json);
      const previous = this.db.prepare('SELECT revision FROM research_candidates WHERE candidate_id=?').get(value.id);
      this.db.prepare('INSERT OR IGNORE INTO research_definitions VALUES (?,?,?,?)').run(value.id, revision, json, this.clock());
      this.db.prepare('INSERT INTO research_candidates VALUES (?,?) ON CONFLICT(candidate_id) DO UPDATE SET revision=excluded.revision').run(value.id, revision);
      return { id: value.id, revision, changed: previous?.revision !== revision };
    }));
  }

  definition(candidateId) {
    const row = this.db.prepare(`SELECT d.* FROM research_candidates c JOIN research_definitions d
      ON c.candidate_id=d.candidate_id AND c.revision=d.revision WHERE c.candidate_id=?`).get(id(candidateId));
    if (!row) fail('RESEARCH_CANDIDATE_NOT_FOUND');
    return { ...JSON.parse(row.definition_json), revision: row.revision };
  }

  fingerprintEvidence(inputPath) {
    return this.readEvidence(inputPath).metadata;
  }

  readEvidence(inputPath) {
    const requested = resolve(this.root, text(inputPath, 1500));
    const path = relative(this.root, requested).split(sep).join('/');
    if (!contained(this.root, requested) || !/^(artifacts\/|docs\/|dist\/verification\/)/.test(path)) fail('RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
    const actual = realpathSync(requested);
    const actualRelative = relative(this.root, actual).split(sep).join('/');
    if (!contained(this.root, actual) || !/^(artifacts\/|docs\/|dist\/verification\/)/.test(actualRelative)) fail('RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
    const fd = openSync(actual, 'r');
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 4 * 1024 * 1024) fail('RESEARCH_EVIDENCE_INVALID_FILE');
      const body = readFileSync(fd);
      const after = fstatSync(fd);
      if (body.length > 4 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('RESEARCH_EVIDENCE_CHANGED_DURING_READ');
      return { metadata: { path, resolvedPath: actualRelative, sha256: hash(body), byteLength: body.length }, body };
    } finally { closeSync(fd); }
  }

  archiveEvidence(inputPath, expected, attemptId, index) {
    const captured = this.readEvidence(inputPath);
    if (stable(captured.metadata) !== stable(expected)) fail('RESEARCH_EVIDENCE_CHANGED_DURING_ARCHIVE');
    const relativePath = `artifacts/research-evidence-snapshots/${attemptId}/${String(index + 1).padStart(2, '0')}-${expected.sha256}.snapshot`;
    const absolutePath = resolve(this.root, relativePath);
    // Validate each archive directory before descending; recursive mkdir can
    // otherwise create descendants through a pre-existing directory junction.
    let archiveParent = this.root;
    for (const segment of ['artifacts', 'research-evidence-snapshots', attemptId]) {
      archiveParent = resolve(archiveParent, segment);
      try { mkdirSync(archiveParent); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const entry = lstatSync(archiveParent);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
    }
    const archiveDirectory = realpathSync(dirname(absolutePath));
    const archiveDirectoryRelative = relative(this.root, archiveDirectory).split(sep).join('/');
    if (!contained(this.root, archiveDirectory) || !archiveDirectoryRelative.startsWith('artifacts/research-evidence-snapshots/')) {
      fail('RESEARCH_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
    }
    try { writeFileSync(absolutePath, captured.body, { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingStat = lstatSync(absolutePath);
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) fail('RESEARCH_EVIDENCE_SNAPSHOT_CONFLICT');
      const existing = readFileSync(absolutePath);
      if (hash(existing) !== expected.sha256 || existing.length !== expected.byteLength) fail('RESEARCH_EVIDENCE_SNAPSHOT_CONFLICT');
    }
    const snapshot = this.fingerprintEvidence(relativePath);
    if (snapshot.sha256 !== expected.sha256 || snapshot.byteLength !== expected.byteLength) fail('RESEARCH_EVIDENCE_SNAPSHOT_MISMATCH');
    return { ...expected, snapshotPath: relativePath, snapshotSha256: snapshot.sha256, snapshotByteLength: snapshot.byteLength };
  }

  recordAttempt(input) {
    if (!input || !KINDS.has(input.kind) || !OUTCOMES.has(input.reportedOutcome) || !Array.isArray(input.evidencePaths) || input.evidencePaths.length > 16 ||
        (input.reportedOutcome !== 'blocked' && !input.evidencePaths.length)) fail('RESEARCH_INVALID_ATTEMPT');
    const attemptId = id(input.id);
    const definition = this.definition(input.candidateId);
    const sourceEvidence = input.evidencePaths.map(path => this.fingerprintEvidence(path)).sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(sourceEvidence.map(item => item.path)).size !== sourceEvidence.length) fail('RESEARCH_DUPLICATE_EVIDENCE');
    const record = {
      id: attemptId, candidateId: definition.id, candidateRevision: definition.revision,
      kind: input.kind, reportedOutcome: input.reportedOutcome, hypothesis: text(input.hypothesis),
      observedAt: input.observedAt == null ? null : date(input.observedAt),
      lesson: text(input.lesson), limitations: text(input.limitations), evidence: sourceEvidence,
      // Structured references only: never duplicate the G or F records themselves.
      relatedIds: (input.relatedIds ?? []).map(value => text(value, 200))
    };
    if (record.relatedIds.length > 16) fail('RESEARCH_TOO_MANY_REFERENCES');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT record_json FROM research_attempts WHERE attempt_id=?').get(record.id);
      if (old) {
        const previous = JSON.parse(old.record_json);
        // Archive metadata is an additive storage detail. Legacy records remain
        // idempotent without rewriting their JSON or creating new snapshots.
        previous.evidence = previous.evidence.map(({ path, resolvedPath, sha256, byteLength }) => ({ path, resolvedPath, sha256, byteLength }));
        if (stable(previous) !== stable(record)) fail('RESEARCH_ATTEMPT_ID_CONFLICT');
        return { recorded: false, duplicate: true, id: record.id };
      }
      // Another writer may revise the candidate while evidence is being read.
      if (sourceEvidence.reduce((sum, item) => sum + item.byteLength, 0) > MAX_EVIDENCE_BYTES_PER_ATTEMPT) fail('RESEARCH_EVIDENCE_TOTAL_TOO_LARGE');
      if (this.definition(record.candidateId).revision !== record.candidateRevision) fail('RESEARCH_CANDIDATE_CHANGED');
      record.evidence = sourceEvidence.map((item, index) => this.archiveEvidence(item.path, item, attemptId, index));
      const json = stable(record);
      this.db.prepare(`INSERT INTO research_attempts (attempt_id,candidate_id,candidate_revision,record_json,recorded_at)
        VALUES (?,?,?,?,?)`).run(record.id, record.candidateId, record.candidateRevision, json, this.clock());
      return { recorded: true, duplicate: false, id: record.id };
    });
  }

  importWatch(report) {
    if (report?.version !== 1 || !Array.isArray(report.sources) || report.sources.length > 64) fail('RESEARCH_INVALID_WATCH');
    const record = { observedAt: date(report.observedAt), sources: report.sources.map(source => {
      if (!['new_source', 'baseline_reset', 'changed', 'unchanged', 'error'].includes(source.status) ||
          (source.contentHash != null && !/^[a-f0-9]{64}$/.test(source.contentHash)) ||
          (source.comparisonHash != null && !/^[a-f0-9]{64}$/.test(source.comparisonHash))) fail('RESEARCH_INVALID_WATCH_SOURCE');
      return { id: id(source.id), url: url(source.url), status: source.status, contentHash: source.contentHash ?? null,
        comparisonHash: source.comparisonHash ?? null, comparisonMethod: source.comparisonMethod ?? null };
    }) };
    const json = stable(record);
    const result = this.db.prepare('INSERT OR IGNORE INTO research_watches (fingerprint,observed_at,record_json) VALUES (?,?,?)')
      .run(hash(json), record.observedAt, json);
    return { recorded: result.changes === 1, duplicate: result.changes === 0 };
  }

  assessEvidence(attempt) {
    return attempt.evidence.map(recorded => {
      let sourceIntegrity;
      try {
        const current = this.fingerprintEvidence(recorded.path);
        const expected = { path: recorded.path, resolvedPath: recorded.resolvedPath, sha256: recorded.sha256, byteLength: recorded.byteLength };
        sourceIntegrity = stable(current) === stable(expected) ? 'intact' : 'changed';
      } catch (error) { sourceIntegrity = error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
      if (typeof recorded.snapshotPath !== 'string') return { ...recorded, integrity: sourceIntegrity, sourceIntegrity, snapshotIntegrity: 'not-archived' };
      try {
        const snapshot = this.fingerprintEvidence(recorded.snapshotPath);
        const matches = snapshot.sha256 === recorded.snapshotSha256 && snapshot.byteLength === recorded.snapshotByteLength
          && snapshot.sha256 === recorded.sha256 && snapshot.byteLength === recorded.byteLength;
        const snapshotIntegrity = matches ? 'intact' : 'changed';
        return { ...recorded, integrity: snapshotIntegrity, sourceIntegrity, snapshotIntegrity };
      } catch (error) {
        const snapshotIntegrity = error.code === 'ENOENT' ? 'missing' : 'unavailable';
        return { ...recorded, integrity: snapshotIntegrity, sourceIntegrity, snapshotIntegrity };
      }
    });
  }

  snapshot() {
    const candidates = this.db.prepare('SELECT candidate_id FROM research_candidates ORDER BY candidate_id').all().map(row => {
      const definition = this.definition(row.candidate_id);
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM research_attempts WHERE candidate_id=?').get(definition.id).n;
      const attempts = this.db.prepare('SELECT record_json,recorded_at FROM research_attempts WHERE candidate_id=? ORDER BY seq DESC LIMIT 20').all(definition.id).map(row => {
        const record = JSON.parse(row.record_json);
        return { ...record, recordedAt: row.recorded_at, currentDefinition: record.candidateRevision === definition.revision,
          evidence: this.assessEvidence(record) };
      });
      const latest = attempts[0];
      const reason = !latest ? 'experiment-needed' : !latest.currentDefinition ? 'definition-changed' :
        latest.evidence.some(item => item.integrity !== 'intact') ? 'evidence-needs-recheck' :
        latest.reportedOutcome === 'blocked' ? 'conditions-missing' : latest.reportedOutcome === 'failed' ? 'revise-hypothesis' :
        latest.reportedOutcome === 'inconclusive' ? 'more-evidence-needed' : 'independent-evaluation-needed';
      return { ...definition, attemptCount: count, historyTruncated: count > attempts.length, attempts, nextReason: reason };
    }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const watch = this.db.prepare('SELECT record_json FROM research_watches ORDER BY seq DESC LIMIT 1').get();
    return { version: VERSION, generatedAt: this.clock(), candidateCount: candidates.length,
      latestWatch: watch ? JSON.parse(watch.record_json) : null, candidates,
      boundaries: { recordPurpose: 'development-research', evidenceChecks: 'file-integrity-only',
        reportedOutcomesIndependentlyVerified: false, productionActivation: false, externalActions: false } };
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}
