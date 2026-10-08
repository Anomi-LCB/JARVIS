import {getRecoveredCognitionObservation} from '../mission/mission-action-recovery.js';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DecisionGraphProof, actionNodes } from './decision-graph-proof.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const present = value => typeof value === 'string' && value.length > 0;
const ref = value => present(value) ? hash(value) : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const kinds = new Set(['request', 'replan', 'approve', 'reject']);
const excluded = (task, run) => task?.request?.metadata?.doNotRemember === true
  || task?.request?.metadata?.learningFlags?.doNotRemember === true
  || run?.learning?.memoryEvent?.learningFlags?.doNotRemember === true
  || run?.execution?.memoryEvent?.learningFlags?.doNotRemember === true;
const verificationShape = report => [report?.taskId, report?.verificationId, report?.status, report?.checks, report?.nodeVerifications];
const executionShape = execution => [execution?.status, execution?.evidence, execution?.executionResult, execution?.dryRun];

// This projection stores references, not a second copy of personal memory. The WeakMap
// binds a G result to the execution the worker actually submitted, not to user metadata.
export class DecisionTrace {
  constructor({ db, clock }) {
    this.db = db;
    this.clock = clock;
    this.tasks = new WeakMap();
    this.verifications = new WeakMap();
    this.workerDecisions = new WeakSet();
    this.graphProof = new DecisionGraphProof();
    db.exec(`CREATE TABLE IF NOT EXISTS cognitive_decisions (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, task TEXT NOT NULL, plan TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cognitive_decisions_scope ON cognitive_decisions(scope,task);
      CREATE TABLE IF NOT EXISTS cognitive_decision_outcomes (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, task TEXT NOT NULL, plan TEXT NOT NULL, outcome TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cognitive_decision_outcomes_scope ON cognitive_decision_outcomes(scope,task);`);
  }

  scope(taskRequest, workspaceRoot) {
    if (!present(workspaceRoot) || !present(taskRequest?.userId)) return null;
    const conversation = taskRequest.metadata?.conversationId ?? null;
    if (conversation !== null && !present(conversation)) return null;
    return hash([resolve(workspaceRoot), taskRequest.userId, conversation]);
  }

  context(task, workspaceRoot) {
    const scope = this.scope(task?.request, workspaceRoot);
    if (!scope || !present(task?.taskId) || !present(task.request?.requestId) || !present(task.plan?.planId)) return null;
    return { scopeRef: scope, taskRef: ref(task.taskId), requestRef: ref(task.request.requestId),
      planRef: ref(task.plan.planId), approvalRef: ref(task.approvalCard?.approvalId) };
  }

  markWorkerDecision(decision) {
    if (decision && typeof decision === 'object') this.workerDecisions.add(decision);
  }

  forget(context) {
    this.db.exec('SAVEPOINT decision_trace_forget');
    try {
      for (const table of ['cognitive_decision_outcomes', 'cognitive_decisions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE scope=? AND task=?`).run(context.scopeRef, context.taskRef);
      }
      this.db.exec('RELEASE decision_trace_forget');
    } catch (error) {
      this.db.exec('ROLLBACK TO decision_trace_forget; RELEASE decision_trace_forget');
      throw error;
    }
    return { recorded: false, reason: 'do-not-remember' };
  }

  recordDecision(task, { kind = 'request', decision = null, workspaceRoot } = {}) {
    const context = this.context(task, workspaceRoot);
    if (!context || !kinds.has(kind)) return { recorded: false, reason: 'source-context-required' };
    this.tasks.set(task, { workspaceRoot });
    if (excluded(task)) return this.forget(context);
    if (kind !== 'request' && (!decision || decision.taskId !== task.taskId)) {
      return { recorded: false, reason: 'decision-source-required' };
    }
    const sourceRef = kind === 'request' ? context.requestRef : hash(decision);
    const id = hash([context.scopeRef, context.taskRef, context.planRef, kind, sourceRef]);
    if (this.db.prepare('SELECT id FROM cognitive_decisions WHERE id=?').get(id)) return { recorded: false, duplicate: true };
    const previous = this.db.prepare('SELECT id FROM cognitive_decisions WHERE scope=? AND task=? ORDER BY rowid DESC LIMIT 1')
      .get(context.scopeRef, context.taskRef);
    const row = { id, ...context, kind, sourceRef,
      statementRef: ref(task.request.command?.rawText),
      // Explicit supplied response/edit reference, never a guessed motive.
      responseRef: ref(decision?.responseText ?? decision?.editRequest?.rawText ?? decision?.editRequest?.text),
      origin: kind === 'request' ? 'request-input' : this.workerDecisions.has(decision) ? 'worker-generated' : 'applied-submission',
      previousRef: previous?.id ?? null,
      occurredAt: timestamp(decision?.decidedAt ?? task.request.requestedAt ?? task.request.createdAt),
      recordedAt: this.clock().toISOString() };
    this.db.prepare('INSERT INTO cognitive_decisions VALUES (?,?,?,?,?)')
      .run(id, context.scopeRef, context.taskRef, context.planRef, JSON.stringify(row));
    return { recorded: true, id };
  }

  bindVerification(report, { task, execution, packet = task?.executionPacket, workspaceRoot } = {}) {
    const context = this.context(task, workspaceRoot);
    if (!context || !report || typeof report !== 'object' || !execution || typeof execution !== 'object'
      || !packet || packet.taskId !== task.taskId || packet.planId !== task.plan.planId || !present(packet.packetId)
      || packet.packetId !== task.executionPacket?.packetId || packet.planId !== task.executionPacket?.planId
      || report.taskId !== task.taskId || excluded(task)) return false;
    this.verifications.set(report, { context, task, execution, packetRef: ref(packet.packetId),
      reportHash: hash(verificationShape(report)), executionHash: hash(executionShape(execution)) });
    this.tasks.set(task, { workspaceRoot });
    return true;
  }

  bindNodeVerification(report, options) {
    const context = this.context(options.task, options.workspaceRoot);
    if (!context) return false;
    if (excluded(options.task, { execution: options.execution })) this.forget(context);
    return this.graphProof.captureNode(report, options, context);
  }

  beginGraph(task, { packet, workspaceRoot }) {
    return this.graphProof.begin(task, packet, this.context(task, workspaceRoot));
  }

  bindGraphVerification(report, options) {
    const context = this.context(options.task, options.workspaceRoot);
    if (!context) return false;
    if (excluded(options.task, { execution: options.execution })
      || options.verificationTargets?.some(t => excluded(options.task, { execution: t.execution }))) {
      this.forget(context);
      return false;
    }
    const graph = this.graphProof.captureAggregate(report, options, context);
    if (!graph || !this.bindVerification(report, options)) return false;
    this.verifications.get(report).graph = graph;
    return true;
  }

  observeRun(run, task) {
    const workspaceRoot = task && this.tasks.get(task)?.workspaceRoot;
    const context = this.context(task, workspaceRoot);
    if (!context) return { recorded: false, reason: 'source-context-required' };
    if (excluded(task, run)) return this.forget(context);
    const report = run?.executionVerification;
    const execution = run?.execution;
    const binding = report && this.verifications.get(report);
    const packet = run?.packet;
    const currentPacket = task.executionPacket;
    const capability = run?.capability ?? packet?.capabilityToken;
    if (binding?.graph?.bindings.some(b => excluded(task, { execution: b.execution }))) return this.forget(context);
    if ((actionNodes(task).length > 1 && !binding?.graph)
      || (binding?.graph && !this.graphProof.matches(binding.graph, { task, packet, context }))) {
      return { recorded: false, reason: 'complete-current-node-proofs-required' };
    }
    if (!binding || binding.task !== task || binding.execution !== execution
      || hash(context) !== hash(binding.context)
      || binding.reportHash !== hash(verificationShape(report)) || binding.executionHash !== hash(executionShape(execution))
      || run.taskId !== task.taskId || packet?.taskId !== task.taskId || packet?.planId !== task.plan.planId
      || ref(packet?.packetId) !== binding.packetRef || ref(currentPacket?.packetId) !== binding.packetRef
      || currentPacket?.planId !== task.plan.planId || currentPacket?.taskId !== task.taskId
      || capability?.taskId !== task.taskId || capability?.planId !== task.plan.planId
      || capability?.approvalId !== task.approvalCard?.approvalId || !context.approvalRef
      || report.taskId !== task.taskId || !present(report.verificationId) || !present(execution?.evidence?.evidenceId)) {
      return { recorded: false, reason: 'current-worker-verification-required' };
    }
    if (run.dryRun || packet.dryRun || execution.dryRun || execution.executionResult?.dryRun || execution.evidence?.dryRun
      || task.request?.requestedMode === 'preview' || task.request?.metadata?.requestedMode === 'preview') {
      return { recorded: false, reason: 'preview' };
    }
    if (!Array.isArray(report.checks) || !report.checks.length || !['COMPLETED', 'FAILED'].includes(execution.status)
      || !['passed', 'failed'].includes(report.status)
      || (report.status === 'passed' && (execution.status !== 'COMPLETED' || run.success !== true || report.checks.some(c => c.status !== 'passed')))
      || (report.status === 'failed' && !report.checks.some(c => c.status === 'failed'))) {
      return { recorded: false, reason: 'inconsistent-verification' };
    }
    const source = this.db.prepare('SELECT payload FROM cognitive_decisions WHERE scope=? AND task=? AND plan=? ORDER BY rowid DESC LIMIT 1')
      .get(context.scopeRef, context.taskRef, context.planRef);
    if (!source) return { recorded: false, reason: 'source-decision-required' };
    const decision = JSON.parse(source.payload);
    if (decision.kind === 'reject' || decision.requestRef !== context.requestRef || decision.approvalRef !== context.approvalRef) {
      return { recorded: false, reason: 'current-decision-required' };
    }
    const id = hash([context.scopeRef, context.taskRef, context.planRef, binding.packetRef, ref(report.verificationId)]);
    const row = { id, ...context, decisionRef: decision.id, packetRef: binding.packetRef,
      verificationRef: ref(report.verificationId), evidenceRef: ref(execution.evidence.evidenceId),
      verificationContentRef: binding.reportHash, executionContentRef: binding.executionHash,
      outcome: report.status, recordedAt: this.clock().toISOString() };
    if (binding.graph) Object.assign(row, { executionKind: 'plan-graph', graphRef: binding.graph.graphRef, nodeProofs: binding.graph.nodeProofs });
    const existing = this.db.prepare('SELECT payload FROM cognitive_decision_outcomes WHERE id=?').get(id);
    if (existing) {
      const saved = JSON.parse(existing.payload);
      const consistent = ['decisionRef', 'verificationContentRef', 'executionContentRef', 'outcome', 'executionKind', 'graphRef', 'nodeProofs']
        .every(key => hash(saved[key] ?? null) === hash(row[key] ?? null));
      return consistent ? { recorded: false, duplicate: true } : { recorded: false, reason: 'conflicting-verification-identity' };
    }
    const result = this.db.prepare('INSERT OR IGNORE INTO cognitive_decision_outcomes VALUES (?,?,?,?,?,?)')
      .run(id, context.scopeRef, context.taskRef, context.planRef, report.status, JSON.stringify(row));
    return { recorded: result.changes === 1, duplicate: result.changes === 0 };
  }

  observeRecovered(recovered) {
    const observation=getRecoveredCognitionObservation(recovered);
    if(!observation)return {recorded:false,reason:'live-durable-recovery-required'};
    const {request,workspaceRoot,requestSha256}=observation,report=recovered.verification,execution=recovered.execution;
    const scopeRef=this.scope(request.taskRequest,workspaceRoot),taskRef=ref(request.taskId);
    if(!scopeRef||!taskRef||report.status!=='passed'||report.taskId!==request.taskId
      ||execution.status!=='COMPLETED'||!present(report.verificationId)||!present(execution.evidence?.evidenceId))return {recorded:false,reason:'recovery-context-required'};
    const source=this.db.prepare('SELECT payload FROM cognitive_decisions WHERE scope=? AND task=? ORDER BY rowid DESC LIMIT 1').get(scopeRef,taskRef);
    if(!source)return {recorded:false,reason:'source-decision-required'};
    const decision=JSON.parse(source.payload),context={scopeRef,taskRef,planRef:decision.planRef,requestRef:ref(request.taskRequest.requestId),approvalRef:decision.approvalRef};
    if(excluded({request:request.taskRequest},{execution}))return {...this.forget(context),context};
    if(decision.kind==='reject'||decision.requestRef!==context.requestRef||!context.approvalRef
      ||context.planRef!==ref(request.cognitionPlanId)||context.approvalRef!==ref(request.cognitionApprovalId))return {recorded:false,reason:'current-decision-required'};
    const row={id:hash([scopeRef,taskRef,'durable-recovery',requestSha256]),...context,decisionRef:decision.id,
      packetRef:ref(recovered.packetId),verificationRef:ref(report.verificationId),evidenceRef:ref(execution.evidence.evidenceId),
      verificationContentRef:hash(verificationShape(report)),executionContentRef:hash(executionShape(execution)),
      requestSha256,executionKind:'durable-artifact-recovery',outcome:'passed',recordedAt:this.clock().toISOString()};
    const result=this.db.prepare('INSERT OR IGNORE INTO cognitive_decision_outcomes VALUES (?,?,?,?,?,?)')
      .run(row.id,scopeRef,taskRef,context.planRef,'passed',JSON.stringify(row));
    return {recorded:result.changes===1,duplicate:result.changes===0,context,taskId:request.taskId,tool:request.toolName,verificationRef:row.verificationRef,requestSha256};
  }

  query({ taskId, taskRequest, workspaceRoot } = {}) {
    const scopeRef = this.scope(taskRequest, workspaceRoot);
    const taskRef = ref(taskId);
    if (!scopeRef || !taskRef) return { error: 'scope-and-task-required' };
    const load = table => this.db.prepare(`SELECT payload FROM ${table} WHERE scope=? AND task=? ORDER BY rowid LIMIT 257`)
      .all(scopeRef, taskRef).map(row => JSON.parse(row.payload));
    const decisions = load('cognitive_decisions');
    const outcomes = load('cognitive_decision_outcomes');
    const counts = this.db.prepare('SELECT outcome,COUNT(*) AS n FROM cognitive_decision_outcomes WHERE scope=? AND task=? GROUP BY outcome')
      .all(scopeRef, taskRef);
    return { version: 'decision-trace-v1', scopeRef, taskRef, decisions: decisions.slice(0, 256), outcomes: outcomes.slice(0, 256),
      counts: { verifiedPass: counts.find(row => row.outcome === 'passed')?.n ?? 0, verifiedFail: counts.find(row => row.outcome === 'failed')?.n ?? 0 },
      truncated: decisions.length > 256 || outcomes.length > 256,
      boundaries: { sourceBodiesStored: false, executionAuthority: false, inferredRationale: false,
        supportedExecution: 'single-action-and-verified-plan-graph', historicalBackfill: false, sourceLogErasure: false } };
  }
}
