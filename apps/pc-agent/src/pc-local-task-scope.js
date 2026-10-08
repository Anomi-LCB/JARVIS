import { DatabaseSync } from 'node:sqlite';

const validId = value => typeof value === 'string' && /^[\p{L}\p{N}._-]{1,128}$/u.test(value);
const fail = code => { const error = new Error(`B_PC_LOCAL_SCOPE_${code}`); error.code = error.message; throw error; };

/** PC-owned permission, independent of Core enrollment and E capabilities.
 * Leases are process-local objects; a received command cannot manufacture one.
 */
export class PcLocalTaskScope {
  #db; #clock; #leases = new WeakMap(); #catalogLeases = new WeakMap(); #managedCatalog;
  constructor({ dbPath, clock = Date.now, managedCatalog = false } = {}) {
    if (typeof dbPath !== 'string' || !dbPath || typeof clock !== 'function'||typeof managedCatalog!=='boolean') fail('CONFIG_INVALID');
    this.#managedCatalog=managedCatalog;
    this.#clock = clock;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pc_local_task_scope(id INTEGER PRIMARY KEY CHECK(id=1),
        revision INTEGER NOT NULL, tasks TEXT NOT NULL, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO pc_local_task_scope VALUES(1,0,'[]',0);
      CREATE TABLE IF NOT EXISTS pc_local_scope_clock(id INTEGER PRIMARY KEY CHECK(id=1),time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pc_local_task_catalog(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,
        read_tasks TEXT NOT NULL,artifact_tasks TEXT NOT NULL,command_tasks TEXT NOT NULL);
      INSERT OR IGNORE INTO pc_local_task_catalog VALUES(1,0,'[]','[]','[]');`);
    if(managedCatalog&&this.#read().allowedTaskIds.some(id=>!this.catalog().allowedCommandTaskIds.includes(id))){this.#db.close();fail('CONFIG_INVALID');}
  }
  get catalogEnabled(){return this.#managedCatalog;}
  commandReadiness(taskId){
    if(!this.#managedCatalog)fail('NOT_CONFIGURED');
    if(!validId(taskId))fail('INPUT_INVALID');
    const now=this.#now();this.#db.exec('BEGIN IMMEDIATE');
    try{
      const catalog=this.catalog(),scope=this.#read();
      const registered=catalog.allowedCommandTaskIds.includes(taskId),granted=scope.allowedTaskIds.includes(taskId);
      const reason=!registered?'B_PC_COMMAND_LOCAL_CATALOG_MISSING':!granted?'B_PC_COMMAND_LOCAL_PERMISSION_MISSING'
        :scope.expiresAt<=now?'B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED':null;
      const result={taskId,catalogRevision:catalog.revision,permissionRevision:scope.revision,registered,granted,
        expiresAt:scope.expiresAt,locallyReady:reason===null,reason,executionAuthority:false,verifiedCompletion:false};
      this.#db.exec('COMMIT');return result;
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  catalog(){
    if(!this.#managedCatalog)fail('NOT_CONFIGURED');
    const row=this.#db.prepare('SELECT * FROM pc_local_task_catalog WHERE id=1').get();
    return {revision:row.revision,allowedTaskIds:JSON.parse(row.read_tasks),allowedArtifactTaskIds:JSON.parse(row.artifact_tasks),allowedCommandTaskIds:JSON.parse(row.command_tasks)};
  }
  replaceCatalog(input){
    if(!this.#managedCatalog)fail('NOT_CONFIGURED');
    const keys=['expectedRevision','allowedTaskIds','allowedArtifactTaskIds','allowedCommandTaskIds'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
      ||keys.slice(1).some(key=>!Array.isArray(input[key])||input[key].length>1000||!input[key].every(validId)||new Set(input[key]).size!==input[key].length)
      ||input.allowedArtifactTaskIds.some(id=>!input.allowedTaskIds.includes(id))
      ||input.allowedCommandTaskIds.some(id=>!input.allowedArtifactTaskIds.includes(id)))fail('INPUT_INVALID');
    this.#now();this.#db.exec('BEGIN IMMEDIATE');
    try{
      const catalog=this.catalog(),scope=this.#read();
      if(catalog.revision!==input.expectedRevision)fail('REVISION_CONFLICT');
      if(catalog.revision===Number.MAX_SAFE_INTEGER||scope.revision===Number.MAX_SAFE_INTEGER)fail('REVISION_EXHAUSTED');
      this.#db.prepare('UPDATE pc_local_task_catalog SET revision=?,read_tasks=?,artifact_tasks=?,command_tasks=? WHERE id=1')
        .run(catalog.revision+1,...keys.slice(1).map(key=>JSON.stringify([...input[key]].sort())));
      const retained=scope.allowedTaskIds.filter(id=>input.allowedCommandTaskIds.includes(id));
      // Catalog edits never grant execution; removal revokes and fences atomically.
      this.#db.prepare('UPDATE pc_local_task_scope SET revision=?,tasks=?,expires=? WHERE id=1')
        .run(scope.revision+1,JSON.stringify(retained),retained.length?scope.expiresAt:0);
      const result=this.catalog();this.#db.exec('COMMIT');return result;
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  captureCatalog(taskId,kind){
    const key={read:'allowedTaskIds',artifact:'allowedArtifactTaskIds',command:'allowedCommandTaskIds'}[kind];
    const catalog=this.catalog();if(!key||!validId(taskId)||!catalog[key].includes(taskId))fail('DENIED');
    const lease=Object.freeze({revision:catalog.revision});this.#catalogLeases.set(lease,{taskId,kind});return lease;
  }
  assertCatalogCurrent(taskId,kind,lease){
    const captured=this.#catalogLeases.get(lease);if(!captured||captured.taskId!==taskId||captured.kind!==kind)fail('LEASE_INVALID');
    if(this.catalog().revision!==lease.revision)fail('CHANGED');
  }
  #now() {
    const current = this.#clock();
    if (!Number.isSafeInteger(current) || current < 0) fail('CLOCK_INVALID');
    this.#db.prepare(`INSERT INTO pc_local_scope_clock VALUES(1,?) ON CONFLICT(id)
      DO UPDATE SET time=MAX(pc_local_scope_clock.time,excluded.time)`).run(current);
    return this.#db.prepare('SELECT time FROM pc_local_scope_clock WHERE id=1').get().time;
  }
  #read() {
    const row = this.#db.prepare('SELECT revision,tasks,expires FROM pc_local_task_scope WHERE id=1').get();
    return { revision: row.revision, allowedTaskIds: JSON.parse(row.tasks), expiresAt: row.expires };
  }
  snapshot() {
    const now = this.#now(), value = this.#read();
    return { ...value, active: value.allowedTaskIds.length > 0 && value.expiresAt > now };
  }
  replace({ expectedRevision, allowedTaskIds, expiresAt } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !Array.isArray(allowedTaskIds) || allowedTaskIds.length > 1000
      || !allowedTaskIds.every(validId) || new Set(allowedTaskIds).size !== allowedTaskIds.length
      || !Number.isSafeInteger(expiresAt) || expiresAt < 0) fail('INPUT_INVALID');
    // Rejected changes must not roll back the observed clock and revive a grant.
    const now = this.#now();
    if (allowedTaskIds.length > 0 && expiresAt <= now) fail('EXPIRY_INVALID');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#read();
      if (current.revision !== expectedRevision) fail('REVISION_CONFLICT');
      if(this.#managedCatalog&&allowedTaskIds.some(id=>!this.catalog().allowedCommandTaskIds.includes(id)))fail('TARGET_NOT_CONFIGURED');
      if (current.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED');
      this.#db.prepare('UPDATE pc_local_task_scope SET revision=?,tasks=?,expires=? WHERE id=1')
        .run(current.revision + 1, JSON.stringify([...allowedTaskIds].sort()), allowedTaskIds.length ? expiresAt : 0);
      const updated = this.snapshot();
      this.#db.exec('COMMIT');
      return updated;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  capture(taskId) {
    const value = this.snapshot();
    if (!validId(taskId) || !value.allowedTaskIds.includes(taskId)) fail('DENIED');
    if (!value.active) fail('EXPIRED');
    const lease = Object.freeze({ revision: value.revision, expiresAt: value.expiresAt });
    this.#leases.set(lease, taskId);
    return lease;
  }
  assertCurrent(taskId, lease) {
    if (!lease || this.#leases.get(lease) !== taskId) fail('LEASE_INVALID');
    const value = this.snapshot();
    if (value.revision !== lease.revision) fail('CHANGED');
    if (!value.allowedTaskIds.includes(taskId)) fail('DENIED');
    if (!value.active || value.expiresAt !== lease.expiresAt) fail('EXPIRED');
  }
  close() { this.#db.close(); }
}
