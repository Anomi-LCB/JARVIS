const providers = new Set(['gmail', 'google-calendar']);
const invalid = () => { throw new Error('A_GOOGLE_READ_SCOPE_DENIED'); };
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)) invalid();
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString()!==value.replace(/(?<!\.\d{3})Z$/u,'.000Z')) invalid(); return time;
};
/** Extra source scope on the existing durable mandate. It never expands OAuth permissions. */
export class GoogleReadDelegation {
  constructor({ store, binding }) {
    this.store = store; this.binding = binding;
    store.db.exec('CREATE TABLE IF NOT EXISTS personal_google_read_scopes(mandate_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  }
  currentBinding() {
    const value = this.binding?.();
    if (!value || typeof value.connectionId !== 'string' || !value.connectionId || typeof value.revision !== 'string' || !value.revision) invalid();
    return { connectionId: value.connectionId, revision: value.revision };
  }
  define({ provider, readFrom, readUntil }) {
    if (!providers.has(provider) || timestamp(readFrom) >= timestamp(readUntil)
      || timestamp(readFrom)%1000 || timestamp(readUntil)%1000) invalid();
    return { provider, readFrom, readUntil, ...this.currentBinding() };
  }
  save(mandateId, scope) { this.store.db.prepare('INSERT INTO personal_google_read_scopes VALUES(?,?)').run(mandateId, JSON.stringify(scope)); }
  get(mandateId) {
    const row = this.store.db.prepare('SELECT body FROM personal_google_read_scopes WHERE mandate_id=?').get(mandateId);
    if (!row) invalid();
    try { return JSON.parse(row.body); } catch { invalid(); }
  }
  check(mandateId, job) {
    const scope = this.get(mandateId), current = this.currentBinding();
    if (scope.provider !== job.provider || scope.connectionId !== current.connectionId || scope.revision !== current.revision
      || timestamp(job.timeMin) < timestamp(scope.readFrom) || timestamp(job.timeMax) > timestamp(scope.readUntil)
      || timestamp(job.timeMin) >= timestamp(job.timeMax)) invalid();
    return scope;
  }
  window(mandateId, job) {
    const scope = this.get(mandateId), current = this.currentBinding();
    if (scope.provider !== job.provider || scope.connectionId !== current.connectionId || scope.revision !== current.revision) invalid();
    const timeMin = new Date(Math.max(timestamp(job.timeMin), timestamp(scope.readFrom))).toISOString();
    const timeMax = new Date(Math.min(timestamp(job.timeMax), timestamp(scope.readUntil))).toISOString();
    this.check(mandateId, { ...job, timeMin, timeMax }); return { timeMin, timeMax };
  }
}
