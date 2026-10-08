import {getRecoveredCognitionObservation} from '../mission/mission-action-recovery.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DecisionTrace } from './decision-trace.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : null;
const evidenceId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const terminal = new Set(['COMPLETED', 'CANCELLED', 'COMPENSATED', 'EXPIRED']);
const clamp = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
const noMemory = (task, run) => task?.request?.metadata?.doNotRemember === true || task?.request?.metadata?.learningFlags?.doNotRemember === true
  || run?.learning?.memoryEvent?.learningFlags?.doNotRemember === true || run?.execution?.memoryEvent?.learningFlags?.doNotRemember === true;
const validEpisodeProof = `EXISTS (SELECT 1 FROM cognitive_decision_outcomes o WHERE o.scope=e.scope AND o.task=e.task_id
  AND json_extract(o.payload,'$.verificationRef')=e.verification_id AND o.outcome=CASE e.outcome WHEN 1 THEN 'passed' ELSE 'failed' END)`;

// Hash references remain bound to the persisted decision proof; no raw private
// command, user identifier or workspace path is copied into advisory memory.
const episodeReference = row => ({
  memoryId:row.id, sourceTaskRef:row.task_id, sourceVerificationRef:row.verification_id,
  usageScopeRef:row.scope, observedAt:row.created_at,
  validity:{validUntil:null,basis:'unspecified'}, revisionMode:'append-only-observation',
  revisionHistory:[{action:'observe-verification',at:row.created_at}],
  historicalVerificationStatus:row.outcome===1?'passed':'failed',
  currentArtifactVerified:false, executionAuthority:false
});

// A functional self-model: measurements and remembered outcomes, not a claim of experience.
// Persist only structured runtime evidence. Command text, model prose and credentials never enter this store.
export class CognitiveRuntime {
  constructor({ storePath = null, clock = () => new Date(), attentionLimit = 8 } = {}) {
    this.clock = clock;
    this.persistent = Boolean(storePath);
    this.attentionLimit = Math.max(1, Math.min(32, Math.trunc(attentionLimit) || 8));
    this.lastError = null;
    this.pendingSourceRetractions = new Map();
    if (storePath) mkdirSync(dirname(storePath), { recursive: true });
    this.db = new DatabaseSync(storePath ?? ':memory:');
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS cognitive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cognitive_goals (
        task_id TEXT PRIMARY KEY, scope TEXT NOT NULL, tool TEXT, status TEXT NOT NULL,
        confidence REAL NOT NULL, prediction REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cognitive_episodes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT NOT NULL, tool TEXT NOT NULL,
        verification_id TEXT NOT NULL, outcome INTEGER NOT NULL, prediction REAL NOT NULL,
        prediction_error REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cognitive_episode_scope ON cognitive_episodes(scope,tool,created_at);`);
    const version = this.db.prepare("SELECT value FROM cognitive_meta WHERE key='schema'").get()?.value;
    if (version && version !== '1') { this.db.close(); throw new Error('A_COGNITION_SCHEMA_UNSUPPORTED'); }
    this.db.prepare('INSERT OR IGNORE INTO cognitive_meta VALUES (?,?)').run('schema', '1');
    this.db.prepare('INSERT OR IGNORE INTO cognitive_meta VALUES (?,?)').run('identity', randomUUID());
    this.db.prepare('INSERT OR IGNORE INTO cognitive_meta VALUES (?,?)').run('createdAt', this.clock().toISOString());
    this.identity = this.db.prepare("SELECT value FROM cognitive_meta WHERE key='identity'").get().value;
    this.decisionProjection = new DecisionTrace({ db: this.db, clock: this.clock });
  }

  scopeFor(request, workspaceRoot) {
    return digest([workspaceRoot ? resolve(workspaceRoot) : '', request?.userId ?? 'local_user', request?.metadata?.conversationId ?? null]);
  }

  taskKey(taskId) { return digest(taskId); }

  markWorkerDecision(decision) { this.decisionProjection.markWorkerDecision(decision); }
  recordDecision(task, options) {
    return this.safely(() => {
      this._flushSourceRetractions();
      const context = this.decisionProjection.context(task, options?.workspaceRoot);
      if (context && noMemory(task)) { this._retract(context); return { recorded: false, reason: 'do-not-remember' }; }
      if (context && this._isRetracted(context.scopeRef, context.taskRef)) return { recorded: false, reason: 'source-retracted' };
      return this.decisionProjection.recordDecision(task, options);
    });
  }
  bindDecisionVerification(report, context) { return this.safely(() => this.decisionProjection.bindVerification(report, context)); }
  bindDecisionNodeVerification(report, context) { return this.safely(() => this.decisionProjection.bindNodeVerification(report, context)); }
  beginDecisionGraph(task, context) { return this.safely(() => this.decisionProjection.beginGraph(task, context)); }
  bindDecisionGraphVerification(report, context) { return this.safely(() => this.decisionProjection.bindGraphVerification(report, context)); }
  decisionTrace(query) { return this.safely(() => { this._flushSourceRetractions(); return this.decisionProjection.query(query); }); }

  relationshipEvidence(query) {
    return this.safely(() => {
      this.db.exec('SAVEPOINT cognitive_relationship_read');
      try {
        this._flushSourceRetractions();
        const trace=this.decisionProjection.query(query);
        if(trace.error)throw new Error('Relationship evidence scope required.');
        const goal=this.db.prepare('SELECT task_id,scope,status,created_at,updated_at FROM cognitive_goals WHERE scope=? AND task_id=?')
          .get(trace.scopeRef,trace.taskRef);
        this.db.exec('RELEASE cognitive_relationship_read');
        return {trace,goal:goal?{taskRef:goal.task_id,scopeRef:goal.scope,status:goal.status,
          createdAt:goal.created_at,updatedAt:goal.updated_at}:null};
      }catch(error){this.db.exec('ROLLBACK TO cognitive_relationship_read; RELEASE cognitive_relationship_read');throw error;}
    });
  }

  _isRetracted(scopeRef, taskRef) {
    return !!this.db.prepare('SELECT 1 FROM cognitive_meta WHERE key=?').get(`source-retracted:${scopeRef}:${taskRef}`);
  }
  _retract({ scopeRef, taskRef, sourceRef = null }) {
    const pendingKey = `${scopeRef}:${taskRef}`;
    this.pendingSourceRetractions.set(pendingKey, { scopeRef, taskRef, sourceRef });
    this.db.exec('SAVEPOINT cognitive_source_retraction');
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO cognitive_meta VALUES(?,?)').run(`source-retracted:${scopeRef}:${taskRef}`,
        JSON.stringify({ sourceRef, recordedAt: this.clock().toISOString(), reason: 'source-retracted', executionAuthority: false }));
      this.db.prepare('DELETE FROM cognitive_episodes WHERE scope=? AND task_id=?').run(scopeRef, taskRef);
      this.db.prepare('DELETE FROM cognitive_goals WHERE scope=? AND task_id=?').run(scopeRef, taskRef);
      this.decisionProjection.forget({ scopeRef, taskRef });
      this.db.exec('RELEASE cognitive_source_retraction');
      this.pendingSourceRetractions.delete(pendingKey);
      return { revoked: true, duplicate: inserted.changes === 0, taskRef, scopeRef, sourceBodiesStored: false, historicalLogsErased: false, executionAuthority: false };
    } catch (error) {
      this.db.exec('ROLLBACK TO cognitive_source_retraction; RELEASE cognitive_source_retraction');
      throw error;
    }
  }
  sourceRetractionStatus({ taskId, sourceEventId, scope } = {}) {
    if (!evidenceId(taskId) || !evidenceId(sourceEventId) || !scope || !evidenceId(scope.userId)
      || !evidenceId(scope.workspaceRoot) || (scope.conversationId != null && !evidenceId(scope.conversationId))) return { revoked: false };
    return this.safely(() => {
      this.db.exec("SAVEPOINT cognitive_retraction_observation");
      try {
        const scopeRef = this.scopeFor({ userId: scope.userId, metadata: { conversationId: scope.conversationId ?? null } }, scope.workspaceRoot);
        const taskRef = this.taskKey(taskId);
        if (!this._isRetracted(scopeRef, taskRef)) return { revoked: false };
        for (const [table, column] of [['cognitive_episodes','task_id'],['cognitive_goals','task_id'],
          ['cognitive_decisions','task'],['cognitive_decision_outcomes','task']]) {
          if (this.db.prepare(`SELECT 1 FROM ${table} WHERE scope=? AND ${column}=? LIMIT 1`).get(scopeRef,taskRef)) return { revoked: false };
        }
        return { revoked: true, executionAuthority: false };
      } finally { this.db.exec("RELEASE cognitive_retraction_observation"); }
    });
  }

  revokeSource({ taskId, sourceEventId, scope } = {}) {
    if (!evidenceId(taskId) || !evidenceId(sourceEventId) || !scope || !evidenceId(scope.userId) || !evidenceId(scope.workspaceRoot)
      || (scope.conversationId != null && !evidenceId(scope.conversationId))) return { revoked: false, reason: 'explicit-source-scope-required' };
    const context = { scopeRef: this.scopeFor({ userId: scope.userId, metadata: { conversationId: scope.conversationId ?? null } }, scope.workspaceRoot), taskRef: this.taskKey(taskId), sourceRef: digest(sourceEventId) };
    const key = `${context.scopeRef}:${context.taskRef}`;
    this.pendingSourceRetractions.set(key, context);
    return this.safely(() => {
      const result = this._retract(context);
      this.pendingSourceRetractions.delete(key);
      return result;
    });
  }
  _flushSourceRetractions() {
    for (const [key, context] of this.pendingSourceRetractions) {
      this._retract(context);
      this.pendingSourceRetractions.delete(key);
    }
  }

  safely(callback) {
    try { return callback(); }
    catch {
      // An auxiliary persistence error must never turn a completed external action into a retry.
      this.lastError = { code: 'A_COGNITION_STORAGE_FAILED', at: this.clock().toISOString() };
      return null;
    }
  }

  planningContext({ taskRequest, intent, route, workspaceRoot }) {
    return this.safely(() => {
      this._flushSourceRetractions();
      const tool = identifier(route?.skill?.toolName);
      const scope = this.scopeFor(taskRequest, workspaceRoot);
      const retracted = this._isRetracted(scope, this.taskKey(taskRequest.taskId));
      const rows = tool ? this.db.prepare(`SELECT e.* FROM cognitive_episodes e WHERE scope=? AND tool=? AND ${validEpisodeProof} ORDER BY e.rowid DESC LIMIT 32`).all(scope, tool) : [];
      const failed = rows.filter(row => row.outcome === 0);
      const confidence = clamp(intent?.confidence);
      const prediction = rows.length ? (rows.length - failed.length + 1) / (rows.length + 2) : confidence;
      const mode = !tool || confidence < 0.8 || failed.length ? 'evidence-sensitive' : 'routine';
      const now = this.clock().toISOString();
      if (!retracted && !noMemory({ request: taskRequest })) this.db.prepare(`INSERT INTO cognitive_goals VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET tool=excluded.tool,scope=excluded.scope,status=excluded.status,
        confidence=excluded.confidence,prediction=excluded.prediction,updated_at=excluded.updated_at`)
        .run(this.taskKey(taskRequest.taskId), scope, tool, 'PLANNING', confidence, prediction, now, now);
      return {
        cognition: {
          version: 'functional-self-model-v1', mode, tool,
          observedAttempts: rows.length, verificationFailures: failed.length,
          expectedVerificationPass: prediction, predictionBasis: rows.length ? 'smoothed-recent-verification-history' : 'intent-confidence-proxy',
          calibratedProbability: false,
          meanPredictionError: rows.length ? rows.reduce((sum, row) => sum + row.prediction_error, 0) / rows.length : null,
          source: 'internal-verified-execution-history', authority: 'advisory-only',
          memoryEvidence:rows.map(episodeReference)
        },
        planningGuardrails: failed.length ? [{
          adapterId: 'cognitive-outcome-reflection-v1', sourceFailureId: failed[0].verification_id,
          severity: 'medium', applyMode: 'preflight_warning', planningWeight: 1,
          condition: { toolName: tool },
          checklist: ['현재 입력과 대상의 상태를 다시 확인한다.', '실행 성공과 결과 검증 통과를 구분한다.'],
          recommendation: '같은 도구의 검증 실패 이력이 있어 현재 조건과 결과 확인 방법을 계획에 명시한다.'
        }] : []
      };
    });
  }

  updateTask(task) {
    if (!task?.taskId) return;
    this.safely(() => this.db.prepare('UPDATE cognitive_goals SET status=?,updated_at=? WHERE task_id=?')
      .run(identifier(task.status) ?? 'UNKNOWN', this.clock().toISOString(), this.taskKey(task.taskId)));
  }

  observeRun(run, task) {
    if (!this.safely(() => { this._flushSourceRetractions(); return true; })) return { recorded: false, reason: 'source-retraction-pending' };
    return this.safely(() => {
      this.db.exec('SAVEPOINT cognitive_verified_outcome');
      try {
        const traceResult = this.decisionProjection.observeRun(run, task);
        const result = this.#observeVerifiedOutcome(run, task, traceResult);
        this.db.exec('RELEASE cognitive_verified_outcome');
        if (result?.recorded || result?.duplicate) this.lastError = null;
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK TO cognitive_verified_outcome; RELEASE cognitive_verified_outcome');
        throw error;
      }
    });
  }

  observeRecovered(recovered) {
    return this.safely(()=>{
      this._flushSourceRetractions();
      const observation=getRecoveredCognitionObservation(recovered);
      if(!observation)return {recorded:false,reason:'live-durable-recovery-required'};
      const {request,workspaceRoot}=observation,scope=this.decisionProjection.scope(request.taskRequest,workspaceRoot),taskId=this.taskKey(request.taskId);
      if(!scope)return {recorded:false,reason:'recovery-context-required'};
      if(noMemory({request:request.taskRequest},{execution:recovered.execution})||this._isRetracted(scope,taskId))return {recorded:false,excluded:true,reason:'source-retracted-or-excluded'};
      const prior=this.db.prepare(`SELECT e.id FROM cognitive_episodes e WHERE e.scope=? AND e.task_id=? AND e.tool=? AND ${validEpisodeProof}`).get(scope,taskId,request.toolName);
      if(prior){this.lastError=null;return {duplicate:true,recorded:false};}
      const goal=this.db.prepare('SELECT * FROM cognitive_goals WHERE task_id=? AND scope=? AND tool=?').get(taskId,scope,request.toolName);
      if(!goal)return {recorded:false,reason:'source-goal-required'};
      this.db.exec('SAVEPOINT cognitive_recovered_outcome');
      try{
        const result=this.decisionProjection.observeRecovered(recovered);
        if(!result.recorded&&!result.duplicate){this.db.exec('ROLLBACK TO cognitive_recovered_outcome; RELEASE cognitive_recovered_outcome');return result;}
        this.db.prepare("UPDATE cognitive_goals SET status='COMPLETED',updated_at=? WHERE task_id=? AND scope=?").run(this.clock().toISOString(),taskId,scope);
        this.db.prepare('INSERT OR IGNORE INTO cognitive_episodes VALUES (?,?,?,?,?,?,?,?,?)')
          .run(digest([taskId,'durable-recovery',result.requestSha256]),taskId,scope,request.toolName,result.verificationRef,1,goal.prediction,Math.abs(goal.prediction-1),this.clock().toISOString());
        this.db.exec('RELEASE cognitive_recovered_outcome');this.lastError=null;return {recorded:true,recovered:true};
      }catch(error){this.db.exec('ROLLBACK TO cognitive_recovered_outcome; RELEASE cognitive_recovered_outcome');throw error;}
    });
  }

  #observeVerifiedOutcome(run, task, traceResult) {
      const report = run.executionVerification;
      const execution = run.execution;
      const tool = identifier(task?.plan?.action?.toolName);
      const goal = this.db.prepare('SELECT * FROM cognitive_goals WHERE task_id=?').get(this.taskKey(task?.taskId ?? ''));
      const sourceRoot = this.decisionProjection.tasks.get(task)?.workspaceRoot;
      const boundScope = this.decisionProjection.context(task, sourceRoot)?.scopeRef;
      if (goal && boundScope && goal.scope !== boundScope) return { recorded: false, reason: 'source-scope-mismatch' };
      if (goal && (noMemory(task, run) || traceResult?.reason === 'do-not-remember')) {
        this._retract({ scopeRef: goal.scope, taskRef: this.taskKey(task.taskId) });
        return { recorded: false, reason: 'do-not-remember' };
      }
      if (goal && this._isRetracted(goal.scope, this.taskKey(task.taskId))) return { recorded: false, reason: 'source-retracted' };
      if (!traceResult || (!traceResult.recorded && !traceResult.duplicate)) return { recorded: false, reason: 'current-worker-verification-required' };
      // Failure here must abort the outcome transaction rather than be swallowed
      // by the advisory updateTask wrapper used outside completion recording.
      this.db.prepare('UPDATE cognitive_goals SET status=?,updated_at=? WHERE task_id=?')
        .run(identifier(task.status) ?? 'UNKNOWN', this.clock().toISOString(), this.taskKey(task.taskId));
      const dryRun = run.dryRun || run.packet?.dryRun || execution?.dryRun || execution?.executionResult?.dryRun || execution?.evidence?.dryRun;
      if (!goal || !tool || goal.tool !== tool || dryRun || !['passed', 'failed'].includes(report?.status)
        || report.taskId !== task.taskId || !evidenceId(report.verificationId)
        || !evidenceId(execution?.evidence?.evidenceId) || !report.checks?.length
        || !['COMPLETED', 'FAILED'].includes(execution?.status)) return { recorded: false, reason: 'verified-execution-required' };
      if (report.status === 'passed' && (execution.status !== 'COMPLETED' || run.success !== true
        || report.checks.some(check => check.status !== 'passed'))) return { recorded: false, reason: 'inconsistent-verification' };
      if (report.status === 'failed' && !report.checks.some(check => check.status === 'failed')) return { recorded: false, reason: 'inconsistent-verification' };
      const outcome = Number(report.status === 'passed');
      const id = digest([task.taskId, run.packet?.packetId ?? '', report.verificationId]);
      const result = this.db.prepare('INSERT OR IGNORE INTO cognitive_episodes VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, this.taskKey(task.taskId), goal.scope, tool, digest(report.verificationId), outcome, goal.prediction, Math.abs(goal.prediction - outcome), this.clock().toISOString());
      this.db.exec('DELETE FROM cognitive_episodes WHERE rowid NOT IN (SELECT rowid FROM cognitive_episodes ORDER BY rowid DESC LIMIT 512)');
      return { recorded: result.changes === 1, duplicate: result.changes === 0 };
  }

  snapshot({ tasks = [], registeredTools = [], growthStorage = null } = {}) {
    const stored = this.safely(() => { this._flushSourceRetractions(); return ({
      goals: this.db.prepare(`SELECT * FROM cognitive_goals WHERE status NOT IN ('COMPLETED','CANCELLED','COMPENSATED','EXPIRED')
        ORDER BY CASE WHEN status IN ('BLOCKED','FAILED','RETRY_PENDING') THEN 1 ELSE 0 END DESC, confidence ASC, updated_at DESC LIMIT 256`).all(),
      episodes: this.db.prepare(`SELECT e.* FROM cognitive_episodes e WHERE ${validEpisodeProof} ORDER BY e.rowid DESC LIMIT 32`).all().map(row=>({tool:row.tool,outcome:row.outcome,prediction:row.prediction,prediction_error:row.prediction_error,created_at:row.created_at,provenance:episodeReference(row)})),
      episodeCount: this.db.prepare(`SELECT COUNT(*) AS n FROM cognitive_episodes e WHERE ${validEpisodeProof}`).get().n,
      unboundEpisodeCount: this.db.prepare(`SELECT COUNT(*) AS n FROM cognitive_episodes e WHERE NOT ${validEpisodeProof}`).get().n
    }); });
    const current = new Map(tasks.map(task => [this.taskKey(task.taskId), task]));
    const active = (stored?.goals ?? []).map(goal => {
      const live = current.get(goal.task_id);
      const status = live?.status ?? goal.status;
      const uncertainty = 1 - goal.confidence;
      const blocked = ['BLOCKED', 'FAILED', 'RETRY_PENDING'].includes(status);
      return { taskId: goal.task_id, tool: goal.tool, status,
        continuity: live ? 'current-runtime' : 'remembered-needs-reconciliation',
        priority: (blocked ? 2 : 0) + uncertainty,
        reason: blocked ? '실패 또는 차단 원인 확인' : uncertainty > 0.2 ? '불확실한 해석 확인' : '진행 중인 목표 유지' };
    }).filter(goal => !terminal.has(goal.status)).sort((a, b) => b.priority - a.priority);
    return {
      version: 'functional-self-model-v1', identity: { id: this.identity, name: 'JARVIS' },
      implementation: 'persistent-functional-self-model', consciousness: 'unestablished',
      storage: { persistent: this.persistent, status: this.lastError ? 'degraded' : 'ready', error: this.lastError },
      memory: { episodeCount: stored?.episodeCount ?? null, unboundHistoricalEpisodeCount: stored?.unboundEpisodeCount ?? null, retentionLimit: 512, rawContentStored: false, growth: growthStorage },
      attention: { limit: this.attentionLimit, activeConsidered: active.length, focus: active.slice(0, this.attentionLimit), effect: 'inspection-and-planning-context', executionSchedulingChanged: false },
      capabilityAwareness: { registeredToolCount: new Set(registeredTools).size, registrationIsLiveConnection: false },
      recentOutcomes: stored?.episodes ?? [],
      boundaries: { executionAuthority: false, selfModification: false, backgroundModelCalls: false }
    };
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}
