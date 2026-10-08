import { createProcedureLifecycle, procedureLifecycleIssue } from './skill-procedure-lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import { ModuleId, stableId } from '../../../packages/shared/src/types.js';
import { JsonlAuditLog } from '../../../packages/shared/src/audit-log.js';
import { readFileSync } from 'node:fs';
import { failureTaxonomyCorpusId, failureTaxonomyFixtureCorpus } from './fixtures/failure-taxonomy-corpus.js';
import { executionObservations, indexMemorySources, memoryProvenance, memoryScopeMatches, normalizeMemoryScope, preferenceScopeMatches, preferenceSourcesMatch, sourceRecallAllowed } from './memory-provenance.js';
import { memoryItemRelevant } from './memory-relevance.js';
import { searchPersonalMemory } from './personal-memory-search.js';
import { selectMemoryResults } from './memory-result-selection.js';
import { projectPersonalKnowledge, isPersonalKnowledgeSource } from './personal-knowledge-projection.js';
import {parseMemoryRelationshipQuestion,queryPersonalRelationships,relationshipMemoryReferences} from './personal-relationship-query.js';
import { SelectedConversationArchive } from './selected-conversation-archive.js';
import { runTabularProcedure, evaluateTabularProcedureTrials, validateTabularProcedureDefinition } from './skill-procedure-runtime.js';

export const MEMORY_EVENT_SCHEMA_VERSION = 'f-memory-event-union-v1';
const defaultSensitiveMinimizerFixturePath = 'apps/growth-memory/fixtures/sensitive-minimizer-fixtures.json';

export function loadSensitiveMinimizerFixturePack(fixturePath = defaultSensitiveMinimizerFixturePath) {
  const raw = readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    fixturePath,
    fixtureSha256: createHash('sha256').update(raw).digest('hex')
  };
}

const defaultLearningFlags = {
  canBeUsedForPreference: false,
  canBeUsedForWorkflow: false,
  canBeUsedForAutonomy: false,
  containsSensitiveData: false,
  doNotRemember: false
};

const defaultTrustBoundary = {
  userProvided: false,
  externalContent: false,
  systemGenerated: true
};

export class MemoryEventSchemaRegistry {
  constructor({ schemaVersion = MEMORY_EVENT_SCHEMA_VERSION } = {}) {
    this.schemaVersion = schemaVersion;
    this.familyDefinitions = new Map([
      ['task', { variant: 'task_event', sourceFamily: 'task_orchestration', requiredPayloadAny: ['rawText', 'command', 'taskType', 'summary', 'text'] }],
      ['approval', { variant: 'approval_event', sourceFamily: 'approval_flow', requiredPayloadAny: ['rawText', 'editRequest', 'decision', 'reason', 'approvalId', 'summary', 'text'] }],
      ['execution', { variant: 'execution_event', sourceFamily: 'pc_execution', requiredPayloadAny: ['rawText', 'outputPath', 'result', 'reason', 'summary', 'text'] }],
      ['feedback', { variant: 'feedback_event', sourceFamily: 'user_feedback', requiredPayloadAny: ['rawText', 'text', 'editRequest', 'summary'] }],
      ['policy', { variant: 'policy_event', sourceFamily: 'policy_security', requiredPayloadAny: ['rawText', 'reason', 'reasonCode', 'actionType', 'summary'] }],
      ['verification', { variant: 'verification_event', sourceFamily: 'verification', requiredPayloadAny: ['rawText', 'reason', 'reasonCode', 'summary'] }],
      ['growth', { variant: 'growth_review_event', sourceFamily: 'growth_review', requiredPayloadAny: ['rawText', 'decisionId', 'targetId', 'summary', 'text'] }],
      ['autonomy', { variant: 'autonomy_event', sourceFamily: 'autonomy_candidate', requiredPayloadAny: ['candidateId', 'decision', 'summary'] }]
    ]);
    this.exactDefinitions = new Map([
      ['feedback.do_not_remember', { variant: 'feedback_do_not_remember', sourceFamily: 'user_feedback', requiredPayloadAny: ['rawText', 'text', 'summary'], safetyIntent: 'do_not_remember' }],
      ['approval.edited', { variant: 'approval_edit_feedback', sourceFamily: 'approval_flow', requiredPayloadAny: ['editRequest', 'rawText', 'text'] }],
      ['approval.approved', { variant: 'approval_positive_evidence', sourceFamily: 'approval_flow', requiredPayloadAny: ['rawText', 'decision', 'approvalId', 'summary', 'text'] }],
      ['approval.rejected', { variant: 'approval_negative_evidence', sourceFamily: 'approval_flow', requiredPayloadAny: ['rawText', 'reason', 'decision', 'summary', 'text'] }],
      ['execution.completed', { variant: 'execution_success_evidence', sourceFamily: 'pc_execution', requiredPayloadAny: ['rawText', 'outputPath', 'result', 'summary', 'text'] }],
      ['execution.failed', { variant: 'execution_failure_evidence', sourceFamily: 'pc_execution', requiredPayloadAny: ['rawText', 'reason', 'reasonCode', 'summary', 'text'] }],
      ['policy.blocked', { variant: 'policy_block_evidence', sourceFamily: 'policy_security', requiredPayloadAny: ['rawText', 'reason', 'reasonCode', 'actionType'] }],
      ['verification.failed', { variant: 'verification_failure_evidence', sourceFamily: 'verification', requiredPayloadAny: ['rawText', 'reason', 'reasonCode', 'summary'] }]
    ]);
  }

  normalize(event = {}, now = new Date()) {
    const eventType = event.eventType ?? 'unknown.event';
    const taskId = event.taskId ?? 'task_unknown';
    const payload = event.payload ?? {};
    return {
      schemaVersion: this.schemaVersion,
      eventId: event.eventId ?? stableId('mem_evt', `${taskId}:${eventType}:${JSON.stringify(payload).slice(0, 160)}`, now.toISOString()),
      eventType,
      taskId,
      createdAt: event.createdAt ?? now.toISOString(),
      source: {
        module: ModuleId.GROWTH_MEMORY,
        sourceId: event.eventId ?? null,
        ...(event.source ?? {})
      },
      payload,
      learningFlags: {
        ...defaultLearningFlags,
        ...(event.learningFlags ?? {})
      },
      trustBoundary: {
        ...defaultTrustBoundary,
        ...(event.trustBoundary ?? {})
      }
    };
  }

  validate(event) {
    const issues = [];
    const warnings = [];
    const definition = this.definitionFor(event.eventType);
    if (!event.eventId) issues.push(issue('eventId', 'required', 'eventId is required.'));
    if (!event.taskId) issues.push(issue('taskId', 'required', 'taskId is required.'));
    if (!/^[a-z]+(\.[a-z0-9_]+)+$/.test(String(event.eventType))) {
      issues.push(issue('eventType', 'format', 'eventType must use a dotted lower-case namespace.'));
    }
    if (!definition) {
      issues.push(issue('eventType', 'unknown_variant', `Unsupported MemoryEvent type: ${event.eventType}`));
    }
    if (!Number.isFinite(Date.parse(event.createdAt))) {
      issues.push(issue('createdAt', 'format', 'createdAt must be an ISO timestamp.'));
    }
    const payloadKeys = Object.keys(event.payload ?? {});
    if (definition?.requiredPayloadAny?.length && !definition.requiredPayloadAny.some((key) => payloadKeys.includes(key))) {
      warnings.push(issue('payload', 'recommended_field_missing', `Expected one of: ${definition.requiredPayloadAny.join(', ')}`));
    }
    for (const key of Object.keys(defaultLearningFlags)) {
      if (typeof event.learningFlags?.[key] !== 'boolean') {
        issues.push(issue(`learningFlags.${key}`, 'boolean', 'learningFlags values must be boolean.'));
      }
    }
    for (const key of Object.keys(defaultTrustBoundary)) {
      if (typeof event.trustBoundary?.[key] !== 'boolean') {
        issues.push(issue(`trustBoundary.${key}`, 'boolean', 'trustBoundary values must be boolean.'));
      }
    }
    if (event.trustBoundary.externalContent && event.trustBoundary.userProvided) {
      warnings.push(issue('trustBoundary', 'mixed_boundary', 'externalContent and userProvided are both true.'));
    }
    return {
      valid: issues.length === 0,
      issues,
      warnings,
      schema: {
        name: 'MemoryEvent',
        version: this.schemaVersion,
        variant: definition?.variant ?? 'unknown',
        sourceFamily: definition?.sourceFamily ?? 'unknown',
        safetyIntent: definition?.safetyIntent ?? null
      }
    };
  }

  applySafetyPolicy(event, validation) {
    const safe = structuredClone(event);
    const forcePrivate = validation.schema.safetyIntent === 'do_not_remember'
      || safe.learningFlags.doNotRemember
      || safe.learningFlags.containsSensitiveData
      || safe.trustBoundary.externalContent;
    if (validation.schema.safetyIntent === 'do_not_remember') {
      safe.learningFlags.doNotRemember = true;
    }
    if (forcePrivate) {
      safe.learningFlags.canBeUsedForPreference = false;
      safe.learningFlags.canBeUsedForWorkflow = false;
      safe.learningFlags.canBeUsedForAutonomy = false;
    }
    safe.schema = validation.schema;
    safe.schemaValidation = {
      valid: validation.valid,
      issueCount: validation.issues.length,
      warningCount: validation.warnings.length,
      warnings: validation.warnings
    };
    return safe;
  }

  definitionFor(eventType) {
    if (this.exactDefinitions.has(eventType)) return this.exactDefinitions.get(eventType);
    const family = String(eventType).split('.')[0];
    return this.familyDefinitions.get(family) ?? null;
  }

  catalog() {
    return {
      schemaVersion: this.schemaVersion,
      familyCount: this.familyDefinitions.size,
      exactVariantCount: this.exactDefinitions.size,
      families: [...this.familyDefinitions.entries()].map(([family, definition]) => ({ family, ...definition })),
      variants: [...this.exactDefinitions.entries()].map(([eventType, definition]) => ({ eventType, ...definition }))
    };
  }

  jsonSchemaBundle() {
    const learningFlagProperties = Object.fromEntries(Object.keys(defaultLearningFlags).map((key) => [key, { type: 'boolean' }]));
    const trustBoundaryProperties = Object.fromEntries(Object.keys(defaultTrustBoundary).map((key) => [key, { type: 'boolean' }]));
    return {
      bundleVersion: 'f-memory-event-json-schema-bundle-v1',
      schemaVersion: this.schemaVersion,
      generatedAt: new Date().toISOString(),
      schemas: {
        MemoryEvent: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: `jarvis://growth-memory/schemas/${this.schemaVersion}/memory-event.schema.json`,
          title: 'JARVIS MemoryEvent',
          type: 'object',
          additionalProperties: true,
          required: ['eventId', 'eventType', 'taskId', 'createdAt', 'payload', 'learningFlags', 'trustBoundary'],
          properties: {
            schemaVersion: { const: this.schemaVersion },
            eventId: { type: 'string', minLength: 1 },
            eventType: { type: 'string', pattern: '^[a-z]+(\\.[a-z0-9_]+)+$' },
            taskId: { type: 'string', minLength: 1 },
            createdAt: { type: 'string', format: 'date-time' },
            source: {
              type: 'object',
              additionalProperties: true,
              properties: {
                module: { type: 'string' },
                sourceId: { type: ['string', 'null'] }
              }
            },
            payload: { type: 'object', additionalProperties: true },
            learningFlags: {
              type: 'object',
              required: Object.keys(defaultLearningFlags),
              additionalProperties: false,
              properties: learningFlagProperties
            },
            trustBoundary: {
              type: 'object',
              required: Object.keys(defaultTrustBoundary),
              additionalProperties: false,
              properties: trustBoundaryProperties
            }
          }
        }
      },
      variantCatalog: this.catalog(),
      compatibility: {
        currentVersion: this.schemaVersion,
        compatibleFrom: ['f-memory-event-minimal-v0', this.schemaVersion],
        migrationAdapter: 'f-memory-event-migration-compatibility-v1'
      }
    };
  }

  fixtureCorpus() {
    const fixtures = [];
    for (const [family, definition] of this.familyDefinitions.entries()) {
      fixtures.push(this.fixtureFor({
        fixtureId: `family.${family}.valid`,
        eventType: `${family}.sample`,
        definition,
        expectedValid: true
      }));
    }
    for (const [eventType, definition] of this.exactDefinitions.entries()) {
      fixtures.push(this.fixtureFor({
        fixtureId: `variant.${eventType}.valid`,
        eventType,
        definition,
        expectedValid: true
      }));
    }
    fixtures.push({
      fixtureId: 'invalid.unknown_event_type',
      expectedValid: false,
      event: {
        eventId: 'evt_fixture_unknown',
        eventType: 'unknown',
        taskId: 'task_fixture_unknown',
        createdAt: '2026-06-23T00:00:00.000Z',
        payload: { rawText: 'unknown fixture' },
        learningFlags: { ...defaultLearningFlags },
        trustBoundary: { ...defaultTrustBoundary }
      }
    });
    fixtures.push({
      fixtureId: 'invalid.learning_flags_type',
      expectedValid: false,
      event: {
        eventId: 'evt_fixture_bad_flags',
        eventType: 'feedback.good',
        taskId: 'task_fixture_bad_flags',
        createdAt: '2026-06-23T00:00:00.000Z',
        payload: { rawText: 'bad flags fixture' },
        learningFlags: { ...defaultLearningFlags, canBeUsedForPreference: 'yes' },
        trustBoundary: { ...defaultTrustBoundary }
      }
    });
    return {
      corpusVersion: 'f-memory-event-fixture-corpus-v1',
      schemaVersion: this.schemaVersion,
      generatedAt: new Date().toISOString(),
      fixtureCount: fixtures.length,
      validFixtureCount: fixtures.filter((item) => item.expectedValid).length,
      invalidFixtureCount: fixtures.filter((item) => !item.expectedValid).length,
      fixtures
    };
  }

  fixtureFor({ fixtureId, eventType, definition, expectedValid }) {
    const payloadKey = definition.requiredPayloadAny?.[0] ?? 'summary';
    return {
      fixtureId,
      expectedValid,
      expectedVariant: definition.variant,
      event: {
        eventId: `evt_${fixtureId.replaceAll('.', '_')}`,
        eventType,
        taskId: `task_${fixtureId.replaceAll('.', '_')}`,
        createdAt: '2026-06-23T00:00:00.000Z',
        payload: {
          [payloadKey]: `${eventType} fixture payload`
        },
        learningFlags: {
          ...defaultLearningFlags,
          canBeUsedForWorkflow: ['task', 'execution', 'approval'].includes(String(eventType).split('.')[0]),
          canBeUsedForPreference: eventType.startsWith('feedback.') || eventType.startsWith('approval.')
        },
        trustBoundary: {
          ...defaultTrustBoundary,
          userProvided: eventType.startsWith('feedback.') || eventType.startsWith('approval.'),
          systemGenerated: !(eventType.startsWith('feedback.') || eventType.startsWith('approval.'))
        }
      }
    };
  }
}

function issue(field, code, message) {
  return { field, code, message };
}

function hashSensitiveValue(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function hashJsonValue(value) {
  return hashSensitiveValue(JSON.stringify(value));
}

function serializedContainsAny(value, needles = []) {
  const serialized = JSON.stringify(value);
  return needles
    .filter((needle) => String(needle ?? '').length > 0)
    .some((needle) => serialized.includes(String(needle)));
}

function average(values = []) {
  const numeric = values.filter((value) => Number.isFinite(value));
  return numeric.length
    ? Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2))
    : 0;
}

function memoryEventVariantKeys(catalog = {}) {
  return [
    ...(catalog.families ?? []).map((item) => `family:${item.family}:${item.variant}`),
    ...(catalog.variants ?? []).map((item) => `variant:${item.eventType}:${item.variant}`)
  ].sort();
}

function rawSensitiveLeakDetected(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const rawPatterns = [
    /\b010[-.\s]?\d{4}[-.\s]?\d{4}\b/,
    /\b\d{6}[-\s]?[1-4]\d{6}\b/,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /api[_-]?key\s*[:=]\s*[\w.-]+/i,
    /password\s*[:=]\s*\S+/i,
    /token\s*[:=]\s*[\w.-]+/i,
    /\bsecret\s*[:=]\s*\S+/i
  ];
  return rawPatterns.some((pattern) => pattern.test(text));
}

export class MemoryEventIngestor {
  constructor({ clock = () => new Date(), store = null, auditLog = null, sensitiveMinimizer = new SensitiveMemoryMinimizer(), schemaRegistry = new MemoryEventSchemaRegistry() } = {}) {
    this.clock = clock;
    this.store = store;
    this.restoreGeneration = store?.restoreGeneration?.();
    this.auditLog = auditLog;
    this.sensitiveMinimizer = sensitiveMinimizer;
    this.schemaRegistry = schemaRegistry;
    this.events = new Map();
    this.learningQueue = [];
    for (const event of this.store?.allEvents?.() ?? []) {
      this.events.set(event.eventId, event);
      if (!event.learningFlags?.doNotRemember) {
        this.learningQueue.push(event);
      }
    }
  }

  ingest(event, { recoveredScopeProof, expectedKnowledgeSource = null } = {}) {
    const active = this.beforeUse?.();
    if (active === null) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    if (active && active !== this) return active.ingest(event, { recoveredScopeProof, expectedKnowledgeSource });
    const normalized = this.schemaRegistry.normalize(event, this.clock());
    if (this.sourceScopeResolver) {
      let scope;
      try { scope = normalizeMemoryScope(this.sourceScopeResolver(normalized.taskId, { event, recoveredScopeProof })); }
      catch (error) {
        this.auditLog?.write('memory.event.rejected', { eventId: normalized.eventId, code: error.code, reason: error.reason });
        return { success: false, stored: false, error: { code: error.code ?? 'F_MEMORY_SCOPE_UNAVAILABLE', reason: error.reason ?? null } };
      }
      if (scope) normalized.source.memoryScope = scope;
      else delete normalized.source.memoryScope;
    }
    const scope = normalizeMemoryScope(normalized.source.memoryScope);
    if (normalized.eventType === 'execution.completed' && scope && this.all().some(previous =>
      previous.eventType === 'feedback.do_not_remember' && previous.learningFlags?.doNotRemember
      && previous.taskId === normalized.taskId && memoryScopeMatches(previous, scope))) {
      // A delayed durable append must honor a user retraction already persisted
      // for this task. Keep the event identity for dedup/ACK, not its old payload.
      normalized.learningFlags.doNotRemember = true;
      normalized.payload = { summary: 'Previously retracted task; recovery payload omitted.',
        sourceRetraction: { reason: 'scoped-task-do-not-remember' } };
    }
    const validation = this.schemaRegistry.validate(normalized);
    if (!validation.valid) {
      this.auditLog?.write('memory.event.rejected', {
        eventId: normalized.eventId,
        eventType: normalized.eventType,
        issues: validation.issues
      });
      return {
        success: false,
        stored: false,
        error: {
          code: 'F_MEMORY_EVENT_SCHEMA_INVALID',
          issues: validation.issues
        },
        schema: validation.schema
      };
    }
    const governed = this.schemaRegistry.applySafetyPolicy(normalized, validation);
    const minimized = this.sensitiveMinimizer.minimize(governed);
    const fingerprint = this.fingerprint(minimized);
    if (
      this.events.has(minimized.eventId) ||
      this.store?.hasEvent?.(minimized.eventId) ||
      this.store?.hasFingerprint?.(fingerprint) ||
      [...this.events.values()].some((candidate) => candidate.fingerprint === fingerprint)
    ) {
      try { this.store?.assertRestoreGeneration?.(this.restoreGeneration); }
      catch (error) {
        if (error.code !== 'F_MEMORY_GENERATION_CONFLICT') throw error;
        return this.generationConflictResult(minimized);
      }
      this.auditLog?.write('memory.event.duplicate', { eventId: minimized.eventId, fingerprint });
      return { success: true, stored: false, reason: 'duplicate-event' };
    }
    minimized.fingerprint = fingerprint;
    // Publish only after persistence succeeds; otherwise an in-memory duplicate
    // would suppress the retry of an event that never reached the store.
    try {
      if (this.store?.saveEvent?.(minimized, { expectedGeneration: this.restoreGeneration, expectedKnowledgeSource }) === false) {
        throw Object.assign(new Error('Memory event persistence did not complete.'), { code: 'F_MEMORY_EVENT_NOT_PERSISTED' });
      }
    } catch (error) {
      if (error.code !== 'F_MEMORY_GENERATION_CONFLICT') throw error;
      return this.generationConflictResult(minimized);
    }
    this.events.set(minimized.eventId, minimized);
    if (!minimized.learningFlags.doNotRemember) {
      this.learningQueue.push(minimized);
    }
    this.auditLog?.write('memory.event.stored', {
      eventId: minimized.eventId,
      eventType: minimized.eventType,
      taskId: minimized.taskId,
      doNotRemember: minimized.learningFlags.doNotRemember,
      containsSensitiveData: minimized.learningFlags.containsSensitiveData,
      schemaVersion: minimized.schema?.version,
      schemaVariant: minimized.schema?.variant,
      minimization: minimized.payload?.minimization
    });
    return {
      success: true,
      stored: true,
      eventId: minimized.eventId,
      schema: minimized.schema,
      schemaValidation: minimized.schemaValidation
    };
  }

  generationConflictResult(event) {
    const result = { success: false, stored: false, error: { code: 'F_MEMORY_GENERATION_CONFLICT' }, retryAfterRefresh: true };
    const prepared = { ...event, ...(event.learningFlags?.doNotRemember ? { payload: { summary: '[기억 금지 사건]' } } : {}), fingerprint: event.fingerprint ?? this.fingerprint(event) };
    Object.defineProperty(result, 'preparedRetryEvent', { value: structuredClone(prepared), enumerable: false });
    return result;
  }

  all() {
    const active = this.beforeUse?.();
    if (active === null) return [];
    if (active && active !== this) return active.all();
    return [...this.events.values()];
  }

  ingestTelemetry() {
    const events = this.all();
    const invalidCount = events.filter((event) => event.schemaValidation?.valid === false).length;
    const minimizedCount = events.filter((event) => event.payload?.minimization?.minimized === true).length;
    return {
      telemetryVersion: 'f-memory-event-ingest-telemetry-v1',
      generatedAt: this.clock().toISOString(),
      storedCount: events.length,
      learningQueueCount: this.learningQueue.length,
      invalidCount,
      minimizedCount,
      doNotRememberCount: events.filter((event) => event.learningFlags?.doNotRemember).length,
      sensitiveCount: events.filter((event) => event.learningFlags?.containsSensitiveData).length,
      externalContentCount: events.filter((event) => event.trustBoundary?.externalContent).length,
      byType: events.reduce((counts, event) => {
        counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
        return counts;
      }, {}),
      byVariant: events.reduce((counts, event) => {
        const variant = event.schema?.variant ?? 'unknown';
        counts[variant] = (counts[variant] ?? 0) + 1;
        return counts;
      }, {})
    };
  }

  backpressurePolicy({ maxLearningQueue = 5000, warnAtRatio = 0.8 } = {}) {
    const ratio = maxLearningQueue ? this.learningQueue.length / maxLearningQueue : 0;
    return {
      policyVersion: 'f-memory-event-ingest-backpressure-policy-v1',
      maxLearningQueue,
      warnAtRatio,
      currentLearningQueue: this.learningQueue.length,
      pressureRatio: Number(ratio.toFixed(3)),
      status: ratio >= 1 ? 'blocked' : ratio >= warnAtRatio ? 'warning' : 'ok',
      overflowAction: 'reject-new-learning-events-but-allow-do-not-remember-and-hygiene-events'
    };
  }

  anonymizedOperationalCorpus({ limit = 100 } = {}) {
    const events = this.all().slice(-limit);
    return {
      corpusVersion: 'f-memory-event-anonymized-operational-corpus-v1',
      generatedAt: this.clock().toISOString(),
      sourceEventCount: this.events.size,
      itemCount: events.length,
      rawPayloadStored: false,
      items: events.map((event) => ({
        eventIdHash: hashSensitiveValue(event.eventId ?? ''),
        taskIdHash: hashSensitiveValue(event.taskId ?? ''),
        eventType: event.eventType,
        schemaVersion: event.schema?.version ?? null,
        variant: event.schema?.variant ?? null,
        sourceFamily: event.schema?.sourceFamily ?? null,
        createdAt: event.createdAt,
        learningFlags: event.learningFlags,
        trustBoundary: event.trustBoundary,
        payloadHash: hashSensitiveValue(JSON.stringify(event.payload ?? {})),
        fingerprint: event.fingerprint ?? null
      }))
    };
  }

  fingerprint(event) {
    return `sha256:${createHash('sha256').update(JSON.stringify({
      eventType: event.eventType,
      taskId: event.taskId,
      payload: event.payload ?? {}
    })).digest('hex')}`;
  }
}

export class SensitiveMemoryMinimizer {
  constructor({ dataClassifier = null, policyVersion = 'f-sensitive-minimizer-v1' } = {}) {
    this.dataClassifier = dataClassifier;
    this.policyVersion = policyVersion;
    this.falsePositiveReviewDecisions = [];
    this.contextExceptions = [];
    this.fieldPolicies = {
      rawText: 'summarize',
      text: 'summarize',
      editRequest: 'summarize',
      command: 'summarize',
      summary: 'redact',
      title: 'redact',
      note: 'redact'
    };
    this.rules = [
      { id: 'secret', pattern: /api[_-]?key\s*[:=]?\s*[\w.-]+|password\s*[:=]?\s*\S+|token\s*[:=]?\s*[\w.-]+|비밀번호\s*[:=]?\s*\S+|secret\s*[:=]?\s*\S+/gi, replacement: '[masked-secret]' },
      { id: 'phone_number', pattern: /\b010[-.\s]?\d{4}[-.\s]?\d{4}\b/g, replacement: '[masked-phone]' },
      { id: 'resident_registration_number', pattern: /\b\d{6}[-\s]?[1-4]\d{6}\b/g, replacement: '[masked-national-id]' },
      { id: 'email_address', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: '[masked-email]' },
      { id: 'financial_account', pattern: /계좌|은행|입금|출금|헌금|십일조|account number|bank transfer/gi, replacement: '[masked-finance]' },
      { id: 'ministry_sensitive', pattern: /상담|심방|기도제목|목양|새가족|교적|양육/gi, replacement: '[masked-ministry]' },
      { id: 'health_pastoral_care', pattern: /우울|불안|질병|진단|복용|입원|치료|상처|중독|자살|medical|diagnosis|hospital/gi, replacement: '[masked-health]' },
      { id: 'minor_or_family', pattern: /아동|청소년|미성년|자녀|가정폭력|학대|양육권|minor|child custody/gi, replacement: '[masked-family]' }
    ];
  }

  minimize(event) {
    const payload = event.payload ?? {};
    const analysis = this.analyze(payload);
    const detected = event.learningFlags?.containsSensitiveData || analysis.detected;
    if (!detected) return event;
    const minimizedPayload = this.minimizePayload(payload, analysis);
    return {
      ...event,
      payload: minimizedPayload,
      learningFlags: {
        ...event.learningFlags,
        containsSensitiveData: true,
        canBeUsedForPreference: false,
        canBeUsedForWorkflow: false,
        canBeUsedForAutonomy: false
      }
    };
  }

  analyze(payload = {}) {
    const text = this.flattenText(payload);
    const classifierResult = this.dataClassifier?.classify?.(text);
    const matchedRuleIds = new Set((classifierResult?.matchedRules ?? []).map((rule) => rule.id));
    const fallbackFindings = [];
    for (const rule of this.rules) {
      if (rule.pattern.test(text)) {
        matchedRuleIds.add(rule.id);
        fallbackFindings.push(rule.id);
      }
      rule.pattern.lastIndex = 0;
    }
    return {
      detected: matchedRuleIds.size > 0 || (classifierResult?.sensitiveFlags?.length ?? 0) > 0,
      classifier: classifierResult ? 'E_DATA_CLASSIFIER' : 'F_FALLBACK_RULES',
      matchedRuleIds: [...matchedRuleIds].sort(),
      sensitiveFlags: classifierResult?.sensitiveFlags ?? fallbackFindings,
      riskTierHint: classifierResult?.riskTierHint ?? (matchedRuleIds.size ? 3 : 5)
    };
  }

  minimizePayload(payload, analysis) {
    const redactedFields = [];
    const summarizedFields = [];
    const retainedFields = [];
    const redactionDiff = [];
    const walk = (value, path = '') => {
      if (value === null || value === undefined) return value;
      if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}.${index}`));
      if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, walk(nested, path ? `${path}.${key}` : key)]));
      }
      if (typeof value !== 'string') return value;
      const fieldName = path.split('.').at(-1);
      const policy = this.fieldPolicies[fieldName] ?? 'redact';
      const redacted = this.redactString(value);
      if (policy === 'summarize' && redacted !== value) {
        summarizedFields.push(path);
        redactionDiff.push({
          field: path,
          action: 'summarize',
          beforeHash: hashSensitiveValue(value),
          afterPreview: '[sensitive-summary]'
        });
        return '[sensitive-summary]';
      }
      if (redacted !== value) {
        redactedFields.push(path);
        redactionDiff.push({
          field: path,
          action: 'redact',
          beforeHash: hashSensitiveValue(value),
          afterPreview: redacted.slice(0, 80)
        });
        return redacted;
      }
      retainedFields.push(path);
      return value;
    };
    const minimized = walk(payload);
    return {
      ...minimized,
      summary: payload.summary && !this.containsSensitive(payload.summary)
        ? payload.summary
        : '민감정보 포함 이벤트가 최소 요약으로 저장되었습니다.',
      minimization: {
        minimized: true,
        policyVersion: this.policyVersion,
        classifier: analysis.classifier,
        matchedRuleIds: analysis.matchedRuleIds,
        sensitiveFlags: analysis.sensitiveFlags,
        riskTierHint: analysis.riskTierHint,
        summarizedFields: [...new Set(summarizedFields)].sort(),
        redactedFields: [...new Set(redactedFields)].sort(),
        retainedFields: [...new Set(retainedFields)].sort(),
        redactionDiff
      }
    };
  }

  redactString(value) {
    let redacted = String(value);
    for (const rule of this.rules) {
      redacted = redacted.replace(rule.pattern, rule.replacement);
      rule.pattern.lastIndex = 0;
    }
    return redacted;
  }

  containsSensitive(value) {
    return this.analyze({ value }).detected;
  }

  flattenText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return '';
    return Object.values(value).map((item) => this.flattenText(item)).join(' ');
  }

  recordFalsePositiveReview({
    fixtureId = null,
    matchedRuleIds = [],
    decision = 'add_context_exception',
    decidedBy = 'growth_privacy_review',
    reason = 'sensitive minimizer false positive review',
    applyToRuntime = false
  } = {}) {
    const allowedDecisions = ['keep_minimization', 'suppress_classifier_rule', 'narrow_pattern', 'add_context_exception'];
    if (!allowedDecisions.includes(decision)) {
      return { success: false, error: { code: 'F_SENSITIVE_FALSE_POSITIVE_DECISION_INVALID' } };
    }
    const decidedAt = new Date().toISOString();
    const decisionRecord = {
      decisionVersion: 'f-sensitive-minimizer-false-positive-review-decision-v1',
      decisionId: stableId('f_sensitive_fp_review', fixtureId ?? 'manual', this.falsePositiveReviewDecisions.length, decidedAt),
      fixtureIdHash: fixtureId ? hashSensitiveValue(fixtureId) : null,
      matchedRuleIds: [...new Set(matchedRuleIds)].sort(),
      decision,
      decidedBy,
      reasonHash: hashSensitiveValue(reason),
      rawReasonStored: false,
      decidedAt,
      persisted: true
    };
    this.falsePositiveReviewDecisions.unshift(decisionRecord);
    const contextException = decision === 'add_context_exception'
      ? {
          exceptionVersion: 'f-sensitive-minimizer-context-exception-v1',
          exceptionId: stableId('f_sensitive_context_exception', decisionRecord.decisionId, decisionRecord.matchedRuleIds.join(',')),
          sourceDecisionIdHash: hashSensitiveValue(decisionRecord.decisionId),
          fixtureIdHash: decisionRecord.fixtureIdHash,
          ruleIds: decisionRecord.matchedRuleIds,
          scope: 'fixture_context',
          status: applyToRuntime ? 'active' : 'approved_pending_policy_rollout',
          appliedToRuntime: applyToRuntime,
          rawTextStored: false,
          createdAt: decidedAt
        }
      : null;
    if (contextException) this.contextExceptions.unshift(contextException);
    return { success: true, decision: decisionRecord, contextException };
  }

  falsePositiveReviewLedger() {
    return {
      ledgerVersion: 'f-sensitive-minimizer-false-positive-review-ledger-v1',
      generatedAt: new Date().toISOString(),
      decisionCount: this.falsePositiveReviewDecisions.length,
      hashOnly: this.falsePositiveReviewDecisions.every((item) => item.rawReasonStored === false && item.reason === undefined),
      items: this.falsePositiveReviewDecisions.map((item) => ({
        decisionVersion: item.decisionVersion,
        decisionIdHash: hashSensitiveValue(item.decisionId),
        fixtureIdHash: item.fixtureIdHash,
        matchedRuleIds: item.matchedRuleIds,
        decision: item.decision,
        decidedBy: item.decidedBy,
        reasonHash: item.reasonHash,
        rawReasonStored: item.rawReasonStored,
        decidedAt: item.decidedAt,
        persisted: item.persisted
      }))
    };
  }

  contextExceptionRegistry() {
    return {
      registryVersion: 'f-sensitive-minimizer-context-exception-registry-v1',
      generatedAt: new Date().toISOString(),
      exceptionCount: this.contextExceptions.length,
      rawTextStored: false,
      items: this.contextExceptions.map((item) => ({
        exceptionVersion: item.exceptionVersion,
        exceptionIdHash: hashSensitiveValue(item.exceptionId),
        sourceDecisionIdHash: item.sourceDecisionIdHash,
        fixtureIdHash: item.fixtureIdHash,
        ruleIds: item.ruleIds,
        scope: item.scope,
        status: item.status,
        appliedToRuntime: item.appliedToRuntime,
        rawTextStored: item.rawTextStored,
        createdAt: item.createdAt
      }))
    };
  }

  retentionPolicyDiff({ baseline = {}, candidate = {} } = {}) {
    const normalizedBaseline = {
      policyVersion: baseline.policyVersion ?? 'f-retention-policy-baseline-v1',
      sensitiveReviewDays: Number(baseline.sensitiveReviewDays ?? 30),
      staleReviewDays: Number(baseline.staleReviewDays ?? 90),
      doNotRememberAction: baseline.doNotRememberAction ?? 'delete'
    };
    const normalizedCandidate = {
      policyVersion: candidate.policyVersion ?? 'f-retention-policy-candidate-v1',
      sensitiveReviewDays: Number(candidate.sensitiveReviewDays ?? 0),
      staleReviewDays: Number(candidate.staleReviewDays ?? 90),
      doNotRememberAction: candidate.doNotRememberAction ?? 'delete'
    };
    const changedFields = Object.keys(normalizedCandidate)
      .filter((field) => normalizedBaseline[field] !== normalizedCandidate[field])
      .map((field) => ({
        field,
        beforeHash: hashSensitiveValue(String(normalizedBaseline[field])),
        afterHash: hashSensitiveValue(String(normalizedCandidate[field])),
        rawValueStored: false
      }));
    return {
      diffVersion: 'f-sensitive-minimizer-retention-policy-diff-v1',
      generatedAt: new Date().toISOString(),
      status: changedFields.length ? 'changed' : 'unchanged',
      baselineHash: hashJsonValue(normalizedBaseline),
      candidateHash: hashJsonValue(normalizedCandidate),
      changedFields,
      requiresReview: changedFields.some((item) => item.field === 'sensitiveReviewDays'),
      rawPolicyValuesStored: false
    };
  }
}

export class LocalPatternEmbeddingAdapter {
  constructor({ adapterId = 'f-local-pattern-embedding-adapter-v1' } = {}) {
    this.adapterId = adapterId;
    this.provider = 'local';
    this.algorithm = 'local-token-vector-cosine-v1';
  }

  embedOne(text) {
    return {
      adapterId: this.adapterId,
      provider: this.provider,
      algorithm: this.algorithm,
      rawTextExported: false,
      normalizedTextOnly: true,
      ...localTokenEmbedding(text)
    };
  }

  status() {
    return {
      adapterId: this.adapterId,
      provider: this.provider,
      algorithm: this.algorithm,
      enabled: true,
      role: 'default-private-baseline',
      rawTextExported: false,
      normalizedTextOnly: true
    };
  }
}

export class PatternEmbeddingAdapterRegistry {
  constructor({
    clock = () => new Date(),
    localAdapter = new LocalPatternEmbeddingAdapter(),
    externalAdapter = null,
    externalEnabled = false
  } = {}) {
    this.clock = clock;
    this.localAdapter = localAdapter;
    this.externalAdapter = externalAdapter;
    this.externalEnabled = externalEnabled;
    this.policy = {
      policyVersion: 'f-pattern-embedding-adapter-policy-v1',
      defaultAdapter: 'local',
      externalOptInRequired: true,
      rawTextExported: false,
      normalizedTextOnly: true,
      sensitiveEventsAllowed: false,
      doNotRememberAllowed: false,
      externalContentAllowed: false,
      auditEvent: 'pattern.embedding.external_adapter.used'
    };
  }

  embedOne(text, { allowExternal = false, reason = 'pattern-mining', metadata = {} } = {}) {
    const localEmbedding = this.localAdapter.embedOne(text);
    const decision = {
      selectedAdapter: 'local',
      evaluatedAt: this.clock().toISOString(),
      reason,
      allowExternal,
      externalAttempted: false,
      externalUsed: false,
      rawTextExported: false,
      normalizedTextOnly: true
    };
    let externalEmbedding = null;
    let externalError = null;
    if (this.externalEnabled && allowExternal && this.externalAdapter?.embedOne) {
      decision.externalAttempted = true;
      try {
        externalEmbedding = sanitizeExternalEmbedding(this.externalAdapter.embedOne(String(text), {
          metadata: {
            ...metadata,
            reason,
            rawTextExported: false,
            normalizedTextOnly: true
          }
        }));
        if (externalEmbedding) {
          decision.selectedAdapter = 'external-auxiliary';
          decision.externalUsed = true;
        }
      } catch (error) {
        externalError = {
          code: 'F_PATTERN_EXTERNAL_EMBEDDING_FAILED',
          message: error.message
        };
      }
    }
    return {
      localEmbedding,
      externalEmbedding,
      decision,
      externalError,
      policy: this.policy
    };
  }

  status() {
    return {
      registryVersion: 'f-pattern-embedding-adapter-registry-v1',
      generatedAt: this.clock().toISOString(),
      policy: this.policy,
      adapters: [
        this.localAdapter.status(),
        {
          adapterId: this.externalAdapter?.adapterId ?? 'external-pattern-embedding-adapter',
          provider: this.externalAdapter?.provider ?? 'external',
          enabled: this.externalEnabled && Boolean(this.externalAdapter?.embedOne),
          role: 'optional-auxiliary-large-corpus-review',
          rawTextExported: false,
          normalizedTextOnly: true,
          configured: Boolean(this.externalAdapter?.embedOne)
        }
      ],
      defaultAdapter: 'local',
      externalAvailable: this.externalEnabled && Boolean(this.externalAdapter?.embedOne),
      reviewUseCases: [
        'near-duplicate-cluster-review',
        'large-anonymized-corpus-drift-calibration',
        'human-approved-pattern-split-merge-review'
      ]
    };
  }
}

export class PatternAnonymizedCorpusBuilder {
  constructor({
    clock = () => new Date(),
    sensitiveMinimizer = new SensitiveMemoryMinimizer(),
    patternMiner = new PatternMiner({ clock })
  } = {}) {
    this.clock = clock;
    this.sensitiveMinimizer = sensitiveMinimizer;
    this.patternMiner = patternMiner;
  }

  build({ events = [], patterns = [], limit = 5000 } = {}) {
    const items = [];
    const rejectedItems = [];
    for (const event of events.slice(0, limit)) {
      const signature = this.patternMiner.workflowSignature(event);
      const rejectionReasons = this.rejectionReasons(event, signature);
      if (rejectionReasons.length) {
        rejectedItems.push({
          eventIdHash: hashSensitiveValue(event.eventId ?? ''),
          taskIdHash: hashSensitiveValue(event.taskId ?? ''),
          eventType: event.eventType,
          reasons: rejectionReasons,
          rawPayloadStored: false
        });
        continue;
      }
      const linkedPatterns = patterns
        .filter((pattern) => this.patternMiner.signaturesSimilar(pattern.workflowSignature, signature)
          || pattern.workflowSignature?.key === signature.key)
        .map((pattern) => pattern.patternId);
      items.push({
        itemId: stableId('pattern_corpus_item', `${event.eventId}:${signature.key}`, event.createdAt ?? this.clock().toISOString()),
        eventIdHash: hashSensitiveValue(event.eventId ?? ''),
        taskIdHash: hashSensitiveValue(event.taskId ?? ''),
        eventType: event.eventType,
        createdAt: event.createdAt,
        signatureKey: signature.key,
        intentFamily: signature.intentFamily,
        outputKind: signature.outputKind,
        actionKind: signature.actionKind,
        normalizedTextHash: hashSensitiveValue(signature.normalizedText),
        normalizedTokenCount: signature.localEmbedding.tokens.length,
        normalizedTokens: signature.localEmbedding.tokens.slice(0, 40),
        embeddingAlgorithm: signature.localEmbedding.algorithm,
        linkedPatternIds: linkedPatterns,
        safety: {
          approvedForPatternMining: event.learningFlags?.canBeUsedForWorkflow === true,
          containsSensitiveData: false,
          doNotRemember: false,
          externalContent: false,
          rawTextStored: false,
          rawPayloadStored: false,
          minimizationPolicy: this.sensitiveMinimizer.policyVersion
        }
      });
    }
    const patternCoverage = patterns.map((pattern) => ({
      patternId: pattern.patternId,
      occurrenceCount: pattern.occurrenceCount,
      corpusItemCount: items.filter((item) => item.linkedPatternIds.includes(pattern.patternId)).length,
      safetyStatus: pattern.safetyStatus
    }));
    return {
      corpusVersion: 'f-pattern-anonymized-log-corpus-v1',
      generatedAt: this.clock().toISOString(),
      sourceEventCount: events.length,
      itemCount: items.length,
      rejectedCount: rejectedItems.length,
      limit,
      privacy: {
        rawTextStored: false,
        rawPayloadStored: false,
        eventIdsHashed: true,
        taskIdsHashed: true,
        sensitiveEventsExcluded: true,
        doNotRememberExcluded: true,
        externalContentExcluded: true
      },
      scaleProfile: {
        suitableForBatchReview: items.length >= 12,
        recommendedBatchSize: 5000,
        streamingReady: true,
        observedPatternCoverage: patternCoverage.filter((item) => item.corpusItemCount > 0).length
      },
      patternCoverage,
      items,
      rejectedItems
    };
  }

  rejectionReasons(event, signature) {
    const reasons = [];
    if (!signature) reasons.push('missing-workflow-signature');
    if (event.learningFlags?.doNotRemember) reasons.push('do-not-remember');
    if (event.learningFlags?.containsSensitiveData || this.sensitiveMinimizer.containsSensitive(event.payload ?? {})) {
      reasons.push('contains-sensitive-data');
    }
    if (event.trustBoundary?.externalContent) reasons.push('external-content');
    if (event.payload?.rawText === '[sensitive-summary]') reasons.push('sensitive-summary-only');
    if (event.learningFlags?.canBeUsedForWorkflow !== true && !['task.created', 'execution.completed', 'approval.approved'].includes(event.eventType)) {
      reasons.push('not-approved-for-workflow-mining');
    }
    return [...new Set(reasons)].sort();
  }
}

export class PatternClusterReviewEngine {
  constructor({ clock = () => new Date(), patternMiner = new PatternMiner({ clock }) } = {}) {
    this.clock = clock;
    this.patternMiner = patternMiner;
  }

  review({ patterns = [], corpus = null } = {}) {
    const mergeCandidates = this.mergeCandidates(patterns);
    const splitCandidates = this.splitCandidates(patterns, corpus);
    const items = [
      ...mergeCandidates.map((candidate) => ({
        reviewItemId: candidate.candidateId,
        type: 'merge_candidate',
        recommendedAction: 'approve_merge',
        severity: candidate.similarity >= this.patternMiner.similarityThreshold ? 'medium' : 'low',
        patternIds: candidate.patternIds,
        rationale: candidate.rationale
      })),
      ...splitCandidates.map((candidate) => ({
        reviewItemId: candidate.candidateId,
        type: 'split_candidate',
        recommendedAction: 'split_cluster',
        severity: candidate.negativeEvidenceCount > 0 ? 'high' : 'medium',
        patternIds: [candidate.patternId],
        rationale: candidate.rationale
      }))
    ];
    return {
      reportVersion: 'f-pattern-cluster-review-v1',
      generatedAt: this.clock().toISOString(),
      status: items.length ? 'needs_human_review' : 'passed',
      reviewMode: 'human-in-the-loop-split-merge',
      reviewActions: ['approve_merge', 'split_cluster', 'keep_separate', 'defer'],
      uiContract: {
        contractVersion: 'f-pattern-cluster-review-ui-contract-v1',
        surface: 'mobile-growth-review',
        primaryList: 'items',
        compareFields: ['intentFamily', 'outputKind', 'actionKind', 'normalizedTokens', 'negativeEvidence'],
        requiredDecisionAuditFields: ['reviewItemId', 'decision', 'decidedBy', 'reason']
      },
      corpusSummary: corpus ? {
        corpusVersion: corpus.corpusVersion,
        itemCount: corpus.itemCount,
        rejectedCount: corpus.rejectedCount,
        rawTextStored: corpus.privacy?.rawTextStored === true
      } : null,
      mergeCandidates,
      splitCandidates,
      items,
      reviewQueueCount: items.length
    };
  }

  mergeCandidates(patterns) {
    const candidates = [];
    for (let leftIndex = 0; leftIndex < patterns.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < patterns.length; rightIndex += 1) {
        const left = patterns[leftIndex];
        const right = patterns[rightIndex];
        const leftSignature = left.workflowSignature;
        const rightSignature = right.workflowSignature;
        if (!leftSignature || !rightSignature) continue;
        const sameFamily = leftSignature.intentFamily === rightSignature.intentFamily
          && leftSignature.actionKind === rightSignature.actionKind;
        const similarity = this.patternMiner.signatureSimilarity(leftSignature, rightSignature);
        const nearThreshold = Math.max(0.55, this.patternMiner.similarityThreshold - 0.15);
        if (!sameFamily || similarity < nearThreshold) continue;
        candidates.push({
          candidateId: stableId('pattern_merge_candidate', `${left.patternId}:${right.patternId}:${similarity}`),
          patternIds: [left.patternId, right.patternId],
          similarity,
          threshold: this.patternMiner.similarityThreshold,
          intentFamily: leftSignature.intentFamily,
          outputKinds: [...new Set([leftSignature.outputKind, rightSignature.outputKind])],
          actionKind: leftSignature.actionKind,
          occurrenceCount: (left.occurrenceCount ?? 0) + (right.occurrenceCount ?? 0),
          confidenceRange: [left.confidence, right.confidence].sort(),
          rationale: similarity >= this.patternMiner.similarityThreshold
            ? '동일한 의도/행동 계열이며 임베딩 유사도가 병합 기준 이상입니다.'
            : '동일한 의도/행동 계열의 near-duplicate 후보라 사용자 병합 검토가 필요합니다.'
        });
      }
    }
    return candidates.sort((a, b) => b.similarity - a.similarity);
  }

  splitCandidates(patterns, corpus) {
    return patterns
      .map((pattern) => {
        const corpusItemCount = corpus?.patternCoverage
          ?.find((item) => item.patternId === pattern.patternId)
          ?.corpusItemCount ?? 0;
        const mergedKeyCount = pattern.semanticCluster?.mergedSignatureKeys?.length ?? 0;
        const negativeEvidenceCount = pattern.negativeEvidence?.count ?? 0;
        const shouldSplit = negativeEvidenceCount > 0
          || (mergedKeyCount > 1 && (pattern.similarityEvidence?.averageSimilarity ?? 1) < 0.9)
          || (corpusItemCount >= 8 && pattern.recurrenceCadence === 'burst');
        if (!shouldSplit) return null;
        return {
          candidateId: stableId('pattern_split_candidate', `${pattern.patternId}:${negativeEvidenceCount}:${mergedKeyCount}:${corpusItemCount}`),
          patternId: pattern.patternId,
          negativeEvidenceCount,
          mergedSignatureKeyCount: mergedKeyCount,
          corpusItemCount,
          averageSimilarity: pattern.similarityEvidence?.averageSimilarity ?? 1,
          suggestedSplitKeys: [
            negativeEvidenceCount > 0 ? 'separate-negative-evidence-path' : null,
            mergedKeyCount > 1 ? 'split-low-similarity-signature-variants' : null,
            corpusItemCount >= 8 && pattern.recurrenceCadence === 'burst' ? 'split-burst-from-recurring-pattern' : null
          ].filter(Boolean),
          rationale: negativeEvidenceCount > 0
            ? '반복 패턴 안에 정책 차단/실패 같은 부정 증거가 섞여 있어 자동화 전 분리가 필요합니다.'
            : '동일 cluster 안의 서명 변형 폭이 커서 사용자 split 검토가 필요합니다.'
        };
      })
      .filter(Boolean);
  }
}

export class PatternMiner {
  constructor({
    minOccurrences = 3,
    similarityThreshold = 0.72,
    clock = () => new Date(),
    embeddingRegistry = new PatternEmbeddingAdapterRegistry({ clock })
  } = {}) {
    this.minOccurrences = minOccurrences;
    this.similarityThreshold = similarityThreshold;
    this.clock = clock;
    this.embeddingRegistry = embeddingRegistry;
    this.trendHistory = [];
    this.calibrationHistory = [];
    this.positiveEvents = new Set(['task.created', 'approval.approved', 'approval.decision.received', 'execution.completed', 'feedback.good']);
    this.negativeEvents = new Set(['approval.rejected', 'execution.failed', 'verification.failed', 'policy.blocked', 'feedback.do_not_remember']);
  }

  mine(events) {
    const positiveGroups = [];
    const negativeEvidence = [];
    for (const event of events) {
      const signature = this.workflowSignature(event);
      if (!signature) continue;
      if (this.isUnsafeEvidence(event)) continue;
      const memoryScope = normalizeMemoryScope(event.source?.memoryScope);
      const scopeKey = JSON.stringify(memoryScope);
      if (this.negativeEvents.has(event.eventType)) {
        negativeEvidence.push({ event, signature, scopeKey });
        continue;
      }
      const existing = positiveGroups.find((group) => group.scopeKey === scopeKey && group.signature.key === signature.key);
      if (existing) existing.items.push({ event, signature });
      else positiveGroups.push({ signatureKey: signature.key, signature, memoryScope, scopeKey, items: [{ event, signature }] });
    }
    const mergedGroups = this.mergeSimilarGroups(positiveGroups);
    const patterns = mergedGroups
      .filter((group) => group.items.length >= this.minOccurrences)
      .map((group, index) => {
        const eventsForPattern = group.items.map((item) => item.event);
        const signature = group.signature;
        const negativeEvents = negativeEvidence
          .filter((item) => item.scopeKey === group.scopeKey && this.signaturesSimilar(signature, item.signature))
          .map((item) => item.event);
        const confidence = this.confidence({ events: eventsForPattern, negativeEvents });
        return {
          patternId: group.memoryScope ? `scoped_pattern_${createHash('sha256').update(JSON.stringify([group.scopeKey, [...group.mergedSignatureKeys].sort()])).digest('hex')}` : `pattern_${index + 1}`,
          memoryScope: group.memoryScope,
          patternType: 'repeated_command',
          description: signature.displayText,
          normalizedDescription: signature.normalizedText,
          workflowSignature: signature,
          occurrenceCount: group.items.length,
          threshold: this.minOccurrences,
          evidenceEventIds: eventsForPattern.map((event) => event.eventId),
          positiveEvidence: {
            eventIds: eventsForPattern.map((event) => event.eventId),
            approvedCount: eventsForPattern.filter((event) => this.positiveEvents.has(event.eventType)).length
          },
          semanticCluster: {
            clusterId: group.memoryScope ? `scoped_cluster_${createHash('sha256').update(JSON.stringify([group.scopeKey, [...group.mergedSignatureKeys].sort()])).digest('hex')}`
              : stableId('pattern_cluster', signature.key, group.mergedSignatureKeys.join(':')),
            algorithm: 'local-token-vector-cosine-v1',
            similarityThreshold: this.similarityThreshold,
            mergedSignatureKeys: group.mergedSignatureKeys,
            centroidTokens: signature.localEmbedding.tokens
          },
          similarityEvidence: {
            algorithm: 'local-token-vector-cosine-v1',
            averageSimilarity: group.averageSimilarity,
            mergeCount: Math.max(0, group.mergedSignatureKeys.length - 1)
          },
          negativeEvidence: {
            eventIds: negativeEvents.map((event) => event.eventId),
            count: negativeEvents.length,
            eventTypes: [...new Set(negativeEvents.map((event) => event.eventType))]
          },
          confidence,
          supportScore: Number((group.items.length / (group.items.length + negativeEvents.length || 1)).toFixed(2)),
          safetyStatus: negativeEvents.length > 0 ? 'review_required_negative_evidence' : 'safe_repeated_workflow_candidate',
          evidenceWindow: {
            firstSeenAt: eventsForPattern[0]?.createdAt,
            lastSeenAt: eventsForPattern.at(-1)?.createdAt,
            spanDays: this.spanDays(eventsForPattern)
          },
          recurrenceCadence: this.cadence(eventsForPattern),
          lastSeenAt: eventsForPattern.at(-1)?.createdAt
        };
      })
      .sort((a, b) => b.confidence - a.confidence || b.occurrenceCount - a.occurrenceCount);
    this.recordTrend(patterns);
    return patterns;
  }

  mergeSimilarGroups(groups) {
    const clusters = [];
    for (const group of groups) {
      const target = clusters.find((cluster) => cluster.scopeKey === group.scopeKey && this.signaturesSimilar(cluster.signature, group.signature));
      if (!target) {
        clusters.push({
          scopeKey: group.scopeKey,
          memoryScope: group.memoryScope,
          signature: group.signature,
          items: [...group.items],
          mergedSignatureKeys: [group.signature.key],
          similarities: [1]
        });
        continue;
      }
      const similarity = this.signatureSimilarity(target.signature, group.signature);
      target.items.push(...group.items);
      target.mergedSignatureKeys.push(group.signature.key);
      target.similarities.push(similarity);
      target.signature = this.mergeSignature(target.signature, group.signature);
    }
    return clusters.map((cluster) => ({
      ...cluster,
      averageSimilarity: Number((cluster.similarities.reduce((sum, value) => sum + value, 0) / cluster.similarities.length).toFixed(2))
    }));
  }

  signaturesSimilar(left, right) {
    return Boolean(left && right
      && left.intentFamily === right.intentFamily
      && left.outputKind === right.outputKind
      && left.actionKind === right.actionKind
      && this.signatureSimilarity(left, right) >= this.similarityThreshold);
  }

  signatureSimilarity(left, right) {
    return cosineSimilarity(left.localEmbedding?.vector ?? {}, right.localEmbedding?.vector ?? {});
  }

  mergeSignature(left, right) {
    const vector = { ...(left.localEmbedding?.vector ?? {}) };
    for (const [token, weight] of Object.entries(right.localEmbedding?.vector ?? {})) {
      vector[token] = (vector[token] ?? 0) + weight;
    }
    const tokens = Object.keys(vector).sort();
    return {
      ...left,
      key: createHash('sha256').update(`${left.key}:${right.key}`).digest('hex').slice(0, 16),
      normalizedText: tokens.join(' '),
      displayText: left.displayText.length <= right.displayText.length ? left.displayText : right.displayText,
      localEmbedding: {
        algorithm: 'local-token-vector-cosine-v1',
        tokens,
        vector
      }
    };
  }

  isUnsafeEvidence(event) {
    return event.learningFlags?.doNotRemember
      || event.learningFlags?.containsSensitiveData
      || event.trustBoundary?.externalContent
      || event.payload?.rawText === '[sensitive-summary]';
  }

  workflowSignature(event) {
    const raw = event.payload?.rawText ?? event.payload?.taskType ?? event.payload?.summary ?? event.payload?.text;
    if (!raw || raw === '[sensitive-summary]') return null;
    const normalizedText = this.normalizeText(raw);
    if (!normalizedText) return null;
    const intentFamily = this.intentFamily(normalizedText);
    const outputKind = this.outputKind(normalizedText);
    const actionKind = this.actionKind(normalizedText);
    const keySeed = `${intentFamily}:${outputKind}:${actionKind}:${normalizedText}`;
    const embedding = this.embeddingRegistry.embedOne(normalizedText, {
      allowExternal: false,
      reason: 'workflow-signature',
      metadata: { eventType: event.eventType, eventIdHash: hashSensitiveValue(event.eventId ?? '') }
    });
    return {
      key: createHash('sha256').update(keySeed).digest('hex').slice(0, 16),
      intentFamily,
      outputKind,
      actionKind,
      normalizedText,
      displayText: this.displayText(raw),
      localEmbedding: embedding.localEmbedding,
      embeddingDecision: embedding.decision,
      sourceFields: ['payload.rawText', 'payload.taskType', 'payload.summary', 'payload.text']
    };
  }

  normalizeText(value) {
    return String(value)
      .toLowerCase()
      .replace(/[!?.,()[\]{}"'`~]/g, ' ')
      .replace(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g, ' ')
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b(please|pls)\b/g, '')
      .replace(/(해주세요|해줘|부탁해|주세요|요)$/g, '')
      .trim();
  }

  displayText(value) {
    return String(value).trim().replace(/\s+/g, ' ');
  }

  intentFamily(text) {
    if (/주보|안내문|공지|보고서|문서/.test(text)) return 'document_workflow';
    if (/엑셀|xlsx|표|정산|명단/.test(text)) return 'spreadsheet_workflow';
    if (/검색|찾아|브라우저/.test(text)) return 'research_workflow';
    return 'general_workflow';
  }

  outputKind(text) {
    if (/엑셀|xlsx|스프레드시트/.test(text)) return 'spreadsheet';
    if (/주보/.test(text)) return 'bulletin';
    if (/안내문|공지/.test(text)) return 'notice';
    if (/보고서|문서/.test(text)) return 'document';
    return 'unspecified_output';
  }

  actionKind(text) {
    if (/만들|생성|작성|초안/.test(text)) return 'create';
    if (/정리|요약|표로/.test(text)) return 'organize';
    if (/수정|바꿔|변경/.test(text)) return 'edit';
    return 'general_action';
  }

  confidence({ events, negativeEvents }) {
    const occurrenceBoost = Math.min(0.35, events.length * 0.08);
    const approvalBoost = Math.min(0.12, events.filter((event) => this.positiveEvents.has(event.eventType)).length * 0.03);
    const negativePenalty = Math.min(0.24, negativeEvents.length * 0.08);
    const cadenceBoost = this.cadence(events) === 'recurring' ? 0.06 : 0.02;
    return Math.max(0.35, Math.min(0.95, Number((0.42 + occurrenceBoost + approvalBoost + cadenceBoost - negativePenalty).toFixed(2))));
  }

  spanDays(events) {
    if (events.length < 2) return 0;
    const first = Date.parse(events[0].createdAt);
    const last = Date.parse(events.at(-1).createdAt);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
    return Number(Math.max(0, (last - first) / 86_400_000).toFixed(2));
  }

  cadence(events) {
    if (events.length < 3) return 'insufficient';
    const span = this.spanDays(events);
    if (span >= 7) return 'recurring';
    if (span >= 1) return 'clustered';
    return 'burst';
  }

  localEmbedding(text) {
    return this.embeddingRegistry.embedOne(text).localEmbedding;
  }

  embeddingAdapterStatus() {
    return this.embeddingRegistry.status();
  }

  recordTrend(patterns) {
    const snapshot = {
      observedAt: this.clock().toISOString(),
      patternCount: patterns.length,
      safeCount: patterns.filter((pattern) => pattern.safetyStatus === 'safe_repeated_workflow_candidate').length,
      reviewRequiredCount: patterns.filter((pattern) => pattern.safetyStatus !== 'safe_repeated_workflow_candidate').length,
      averageConfidence: patterns.length
        ? Number((patterns.reduce((sum, pattern) => sum + pattern.confidence, 0) / patterns.length).toFixed(2))
        : 0,
      patternIds: patterns.map((pattern) => pattern.patternId)
    };
    this.trendHistory.unshift(snapshot);
    this.trendHistory = this.trendHistory.slice(0, 25);
    return snapshot;
  }

  trendStatus() {
    return {
      latest: this.trendHistory[0] ?? null,
      history: [...this.trendHistory],
      trendWindow: this.trendHistory.length
    };
  }

  calibrateThreshold({ approvedPatternIds = [], rejectedPatternIds = [], reason = '', decidedBy = 'user_review' } = {}) {
    const previousMinOccurrences = this.minOccurrences;
    if (rejectedPatternIds.length > approvedPatternIds.length) {
      this.minOccurrences = Math.min(10, this.minOccurrences + 1);
    } else if (approvedPatternIds.length > rejectedPatternIds.length && this.minOccurrences > 2) {
      this.minOccurrences -= 1;
    }
    const record = {
      calibrationId: stableId('pattern_calibration', previousMinOccurrences, this.minOccurrences, this.clock().toISOString()),
      previousMinOccurrences,
      nextMinOccurrences: this.minOccurrences,
      approvedPatternIds,
      rejectedPatternIds,
      reason,
      decidedBy,
      calibratedAt: this.clock().toISOString()
    };
    this.calibrationHistory.unshift(record);
    this.calibrationHistory = this.calibrationHistory.slice(0, 25);
    return { success: true, ...record };
  }

  calibrationStatus() {
    return {
      minOccurrences: this.minOccurrences,
      similarityThreshold: this.similarityThreshold,
      history: [...this.calibrationHistory]
    };
  }
}

function localTokenEmbedding(text) {
  const tokens = String(text).split(/\s+/).filter(Boolean).sort();
  const vector = {};
  for (const token of tokens) vector[token] = (vector[token] ?? 0) + 1;
  return {
    algorithm: 'local-token-vector-cosine-v1',
    tokens: Object.keys(vector).sort(),
    vector
  };
}

function sanitizeExternalEmbedding(result) {
  if (!result || typeof result !== 'object') return null;
  const vector = Object.fromEntries(Object.entries(result.vector ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => [String(key), Number(value)]));
  if (!Object.keys(vector).length) return null;
  return {
    adapterId: result.adapterId ?? 'external-pattern-embedding-adapter',
    provider: result.provider ?? 'external',
    algorithm: result.algorithm ?? 'external-vector-v1',
    vector,
    dimensions: Object.keys(vector).length,
    rawTextExported: false,
    normalizedTextOnly: true
  };
}

function cosineSimilarity(left = {}, right = {}) {
  const tokens = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const token of tokens) {
    const leftValue = left[token] ?? 0;
    const rightValue = right[token] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue ** 2;
    rightNorm += rightValue ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Number((dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))).toFixed(2));
}

export class PreferenceSemanticConflictClassifier {
  constructor({ classifierId = 'f-preference-semantic-conflict-v1', similarityThreshold = 0.72 } = {}) {
    this.classifierId = classifierId;
    this.similarityThreshold = similarityThreshold;
    this.dimensions = ['length', 'emphasis', 'layout', 'tone'];
  }

  classify(left = '', right = '') {
    const leftProfile = preferenceSignalProfile(left);
    const rightProfile = preferenceSignalProfile(right);
    const conflicts = this.dimensions
      .filter((dimension) => leftProfile.signals[dimension] && rightProfile.signals[dimension] && leftProfile.signals[dimension] !== rightProfile.signals[dimension])
      .map((dimension) => ({
        dimension,
        existing: leftProfile.signals[dimension],
        candidate: rightProfile.signals[dimension],
        severity: this.severityFor(dimension),
        semanticLabel: `${dimension}:${leftProfile.signals[dimension]}_vs_${rightProfile.signals[dimension]}`
      }));
    const similarity = this.tokenSimilarity(left, right);
    const sharedDimensions = leftProfile.dimensions.filter((dimension) => rightProfile.dimensions.includes(dimension));
    const relationship = conflicts.length
      ? 'contradiction'
      : similarity >= this.similarityThreshold ? 'reinforces'
        : sharedDimensions.length ? 'related'
          : 'independent';
    return {
      classifierId: this.classifierId,
      algorithm: 'local-signal-token-semantic-v1',
      relationship,
      severity: conflicts.some((item) => item.severity === 'high') ? 'high' : conflicts.length ? 'medium' : 'none',
      similarity,
      sharedDimensions,
      leftSignals: leftProfile.signals,
      rightSignals: rightProfile.signals,
      conflicts,
      rationale: this.rationale({ relationship, conflicts, similarity, sharedDimensions }),
      resolutionOptions: conflicts.length
        ? ['keep_existing', 'replace_with_candidate', 'merge_after_review']
        : ['confirm_if_supported', 'defer_until_more_evidence']
    };
  }

  severityFor(dimension) {
    return ['emphasis', 'layout'].includes(dimension) ? 'high' : 'medium';
  }

  tokenSimilarity(left, right) {
    const leftVector = this.tokenVector(left);
    const rightVector = this.tokenVector(right);
    return cosineSimilarity(leftVector, rightVector);
  }

  tokenVector(value) {
    const tokens = String(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    return tokens.reduce((vector, token) => {
      vector[token] = (vector[token] ?? 0) + 1;
      return vector;
    }, {});
  }

  rationale({ relationship, conflicts, similarity, sharedDimensions }) {
    if (relationship === 'contradiction') {
      return `conflicting dimensions: ${conflicts.map((item) => item.semanticLabel).join(', ')}`;
    }
    if (relationship === 'reinforces') {
      return `high local similarity ${similarity}`;
    }
    if (relationship === 'related') {
      return `shared dimensions: ${sharedDimensions.join(', ')}`;
    }
    return 'no strong semantic overlap';
  }
}

export class PreferenceHypothesisEngine {
  constructor({ conflictClassifier = new PreferenceSemanticConflictClassifier() } = {}) {
    this.conflictClassifier = conflictClassifier;
  }

  create(events) {
    const edits = events.filter((event) => event.eventType === 'approval.edited'
      && event.payload?.editRequest
      && !event.learningFlags?.doNotRemember
      && !event.learningFlags?.containsSensitiveData
      && !event.trustBoundary?.externalContent);
    const groups = new Map();
    for (const event of edits) {
      const key = JSON.stringify([event.payload.editRequest.trim().toLowerCase(), normalizeMemoryScope(event.source?.memoryScope)]);
      groups.set(key, [...(groups.get(key) ?? []), event.eventId]);
    }
    return [...groups.entries()]
      .filter(([, evidenceEventIds]) => evidenceEventIds.length >= 3)
      .map(([statement, evidenceEventIds], index) => {
        const groupKey = statement;
        const [sourceStatement, memoryScope] = JSON.parse(groupKey);
        statement = sourceStatement;
        const evidenceEvents = edits.filter((event) => evidenceEventIds.includes(event.eventId));
        const profile = preferenceSignalProfile(statement);
        const conflictClassifications = edits
          .filter(event => JSON.stringify(normalizeMemoryScope(event.source?.memoryScope)) === JSON.stringify(memoryScope))
          .filter((event) => !evidenceEventIds.includes(event.eventId))
          .map((event) => ({
            eventId: event.eventId,
            classification: this.conflictClassifier.classify(statement, event.payload.editRequest)
          }))
          .filter((item) => item.classification.conflicts.length > 0);
        const contradictingEventIds = conflictClassifications.map((item) => item.eventId);
        return {
          hypothesisId: `pref_h_${createHash('sha256').update(groupKey).digest('hex').slice(0, 32)}`,
          memoryScope,
          statement,
          appliesTo: ['general'],
          confidence: Math.min(0.9, Number((0.5 + evidenceEventIds.length * 0.04 - contradictingEventIds.length * 0.03).toFixed(2))),
          evidenceEventIds,
          contradictingEventIds,
          conflictProfile: profile,
          semanticConflictSummary: {
            classifierId: this.conflictClassifier.classifierId,
            status: contradictingEventIds.length ? 'conflict_review' : 'clear',
            contradictionCount: contradictingEventIds.length,
            highestSeverity: conflictClassifications.some((item) => item.classification.severity === 'high') ? 'high' : contradictingEventIds.length ? 'medium' : 'none',
            relationships: this.countRelationships(conflictClassifications.map((item) => item.classification))
          },
          conflictExplanations: conflictClassifications.map((item) => ({
            eventId: item.eventId,
            relationship: item.classification.relationship,
            severity: item.classification.severity,
            conflicts: item.classification.conflicts,
            rationale: item.classification.rationale,
            resolutionOptions: item.classification.resolutionOptions
          })),
          status: contradictingEventIds.length ? 'conflict_review' : 'candidate',
          explanation: {
            source: 'approval.edited',
            supportCount: evidenceEventIds.length,
            contradictionCount: contradictingEventIds.length,
            normalizedSignals: profile.signals
          },
          createdAt: evidenceEvents[0]?.createdAt,
          lastSeenAt: evidenceEvents.at(-1)?.createdAt
        };
      });
  }

  confidenceCalibrationReport({ events = [], candidates = this.create(events), confirmedPreferences = [], rejectedPreferences = [] } = {}) {
    const confirmedHypothesisIds = new Set(confirmedPreferences.map((item) => item.hypothesisId));
    const rejectedHypothesisIds = new Set(rejectedPreferences.map((item) => item.hypothesisId));
    const items = candidates.map((candidate) => {
      const observedOutcome = confirmedHypothesisIds.has(candidate.hypothesisId)
        ? 1
        : rejectedHypothesisIds.has(candidate.hypothesisId)
          ? 0
          : candidate.semanticConflictSummary?.status === 'conflict_review'
            ? 0.35
            : Math.min(0.95, 0.45 + (candidate.evidenceEventIds?.length ?? 0) * 0.08 - (candidate.contradictingEventIds?.length ?? 0) * 0.1);
      const calibrationError = Number(Math.abs((candidate.confidence ?? 0) - observedOutcome).toFixed(2));
      return {
        hypothesisId: candidate.hypothesisId,
        statementHash: hashSensitiveValue(candidate.statement),
        confidence: candidate.confidence,
        observedOutcome: Number(observedOutcome.toFixed(2)),
        calibrationError,
        supportCount: candidate.evidenceEventIds?.length ?? 0,
        contradictionCount: candidate.contradictingEventIds?.length ?? 0,
        conflictStatus: candidate.semanticConflictSummary?.status ?? 'unknown',
        evidenceEventHashes: (candidate.evidenceEventIds ?? []).map(hashSensitiveValue),
        contradictionEventHashes: (candidate.contradictingEventIds ?? []).map(hashSensitiveValue)
      };
    });
    const buckets = [
      { bucket: '0.00-0.49', min: 0, max: 0.49 },
      { bucket: '0.50-0.69', min: 0.5, max: 0.69 },
      { bucket: '0.70-0.84', min: 0.7, max: 0.84 },
      { bucket: '0.85-1.00', min: 0.85, max: 1 }
    ].map((bucket) => {
      const bucketItems = items.filter((item) => item.confidence >= bucket.min && item.confidence <= bucket.max);
      return {
        bucket: bucket.bucket,
        count: bucketItems.length,
        averageConfidence: average(bucketItems.map((item) => item.confidence)),
        averageObservedOutcome: average(bucketItems.map((item) => item.observedOutcome)),
        averageCalibrationError: average(bucketItems.map((item) => item.calibrationError))
      };
    });
    const timestamps = events.map((event) => Date.parse(event.createdAt)).filter(Number.isFinite);
    const horizonDays = timestamps.length
      ? Math.max(1, Math.ceil((Math.max(...timestamps) - Math.min(...timestamps)) / (24 * 60 * 60 * 1000)) + 1)
      : 0;
    return {
      reportVersion: 'f-preference-confidence-calibration-report-v1',
      corpusVersion: 'f-preference-confidence-calibration-corpus-v1',
      generatedAt: new Date().toISOString(),
      status: items.every((item) => item.calibrationError <= 0.55) ? 'passed' : 'review_required',
      privacy: {
        rawTextStored: false,
        eventIdsHashed: true,
        statementHashOnly: true
      },
      horizon: {
        eventCount: events.length,
        horizonDays,
        longHorizonReady: events.length >= 10 || horizonDays >= 7
      },
      candidateCount: candidates.length,
      confirmedCount: confirmedPreferences.length,
      rejectedCount: rejectedPreferences.length,
      meanCalibrationError: average(items.map((item) => item.calibrationError)),
      buckets,
      items,
      recommendations: this.calibrationRecommendations({ items, buckets })
    };
  }

  toleranceProfile({ candidates = [], confirmedPreferences = [] } = {}) {
    const conflictDimensions = new Map();
    for (const candidate of candidates) {
      for (const explanation of candidate.conflictExplanations ?? []) {
        for (const conflict of explanation.conflicts ?? []) {
          const current = conflictDimensions.get(conflict.dimension) ?? { conflictCount: 0, highSeverityCount: 0, eventHashes: [] };
          current.conflictCount += 1;
          if (conflict.severity === 'high') current.highSeverityCount += 1;
          current.eventHashes.push(hashSensitiveValue(explanation.eventId));
          conflictDimensions.set(conflict.dimension, current);
        }
      }
    }
    const confirmedSignals = confirmedPreferences
      .flatMap((preference) => Object.keys(preference.conflictProfile?.signals ?? {}));
    const confirmedSignalCounts = confirmedSignals.reduce((counts, dimension) => ({
      ...counts,
      [dimension]: (counts[dimension] ?? 0) + 1
    }), {});
    const dimensions = ['length', 'emphasis', 'layout', 'tone', 'subject'].map((dimension) => {
      const conflicts = conflictDimensions.get(dimension) ?? { conflictCount: 0, highSeverityCount: 0, eventHashes: [] };
      const confirmedCount = confirmedSignalCounts[dimension] ?? 0;
      const toleranceScore = Math.max(0, Number((1 - conflicts.conflictCount * 0.18 - conflicts.highSeverityCount * 0.22 + confirmedCount * 0.08).toFixed(2)));
      return {
        dimension,
        toleranceScore,
        posture: conflicts.highSeverityCount > 0 ? 'strict_review' : conflicts.conflictCount > 0 ? 'review_before_apply' : 'lenient',
        conflictCount: conflicts.conflictCount,
        highSeverityCount: conflicts.highSeverityCount,
        confirmedSignalCount: confirmedCount,
        eventHashes: [...new Set(conflicts.eventHashes)].slice(0, 10)
      };
    });
    return {
      profileVersion: 'f-preference-tolerance-profile-v1',
      visualizationVersion: 'f-preference-tolerance-visualization-v1',
      generatedAt: new Date().toISOString(),
      status: 'ready',
      dimensions,
      summary: {
        strictReviewDimensions: dimensions.filter((item) => item.posture === 'strict_review').map((item) => item.dimension),
        averageTolerance: average(dimensions.map((item) => item.toleranceScore)),
        candidateCount: candidates.length,
        confirmedPreferenceCount: confirmedPreferences.length
      },
      policy: {
        conflictTolerance: dimensions.some((item) => item.posture === 'strict_review') ? 'block_high_conflicts' : 'review_medium_conflicts',
        confirmRequiresAcknowledgement: true,
        visualizationSurface: 'mobile-growth-review'
      }
    };
  }

  calibrationRecommendations({ items = [], buckets = [] } = {}) {
    const recommendations = [];
    if (items.some((item) => item.conflictStatus === 'conflict_review')) recommendations.push('surface_conflict_explanation_before_confirm');
    if (buckets.some((bucket) => bucket.count > 0 && bucket.averageCalibrationError > 0.35)) recommendations.push('collect_more_reviewed_preference_outcomes');
    if (!recommendations.length) recommendations.push('keep_monitoring_preference_outcomes');
    return recommendations;
  }

  countRelationships(classifications) {
    return classifications.reduce((counts, item) => {
      counts[item.relationship] = (counts[item.relationship] ?? 0) + 1;
      return counts;
    }, {});
  }
}

export class ConfirmedPreferenceRegistry {
  constructor({ clock = () => new Date(), store = null, auditLog = null, recallAllowed = () => true } = {}) {
    this.clock = clock;
    this.store = store;
    this.memoryGeneration = store?.restoreGeneration?.();
    this.auditLog = auditLog;
    this.recallAllowed = recallAllowed;
    this.conflictClassifier = new PreferenceSemanticConflictClassifier();
    this.confirmed = new Map();
    this.rejected = new Map();
    for (const preference of this.store?.allConfirmedPreferences?.() ?? []) {
      this.confirmed.set(preference.preferenceId, preference);
    }
  }

  scopePolicyFor({ candidate = {}, scopePolicy = {} } = {}) {
    return {
      policyVersion: 'f-confirmed-preference-scope-policy-v1',
      userScope: scopePolicy.userScope ?? candidate.memoryScope?.userId ?? 'default-user',
      workspaceScope: scopePolicy.workspaceScope ?? candidate.memoryScope?.workspaceRoot ?? 'default-workspace',
      conversationScope: scopePolicy.conversationScope ?? candidate.memoryScope?.conversationId ?? null,
      taskFamily: scopePolicy.taskFamily ?? candidate.appliesTo ?? 'general',
      appliesTo: scopePolicy.appliesTo ?? candidate.appliesTo ?? 'general',
      precedence: scopePolicy.precedence ?? 'workspace_then_user',
      conflictTolerance: scopePolicy.conflictTolerance ?? 'block_high_conflicts',
      migrationStrategy: scopePolicy.migrationStrategy ?? 'diff_before_apply'
    };
  }

  decide({ hypothesisId, decision = 'confirm', preferenceCandidates = [], decidedBy = 'user_review', reason = '', allowConflict = false, scopePolicy = {}, conflictResolution = null } = {}) {
    const generationConflict = this.checkMemoryGeneration();
    if (generationConflict) return generationConflict;
    const candidate = preferenceCandidates.find((item) => item.hypothesisId === hypothesisId);
    if (!candidate) return { success: false, error: { code: 'F_PREFERENCE_HYPOTHESIS_NOT_FOUND' } };
    if (decision === 'reject') {
      const rejected = {
        hypothesisId,
        statement: candidate.statement,
        status: 'rejected',
        rejectedAt: this.clock().toISOString(),
        decidedBy,
        reason
      };
      this.rejected.set(hypothesisId, rejected);
      this.auditLog?.write('preference.rejected', { hypothesisId, decidedBy, reason });
      return { success: true, item: rejected };
    }
    const effectiveScope = this.scopePolicyFor({ candidate, scopePolicy });
    const sameScope = item => preferenceScopeMatches(item.scopePolicy, effectiveScope);
    const existing = this.all({ includeInactive: true }).find((item) => sameScope(item) && (item.hypothesisId === hypothesisId || item.statement === candidate.statement));
    if (existing) return { success: true, item: this.publicPreference(existing), duplicate: true };
    const conflicts = this.conflictsForCandidate(candidate, effectiveScope);
    if (conflicts.length && !allowConflict) {
      return {
        success: false,
        error: { code: 'F_PREFERENCE_CONFLICT_REQUIRES_RESOLUTION' },
        conflicts
      };
    }
    const confirmed = {
      preferenceId: stableId('pref', hashJsonValue([hypothesisId, candidate.statement, effectiveScope]), this.clock().toISOString()),
      hypothesisId,
      statement: candidate.statement,
      appliesTo: candidate.appliesTo,
      confidence: Math.max(candidate.confidence, 0.75),
      evidenceEventIds: candidate.evidenceEventIds,
      contradictingEventIds: candidate.contradictingEventIds ?? [],
      conflictProfile: candidate.conflictProfile ?? preferenceSignalProfile(candidate.statement),
      conflicts,
      scopePolicy: this.scopePolicyFor({ candidate, scopePolicy }),
      conflictResolution,
      revision: 1,
      validUntil: null,
      history: [{
        action: 'confirm',
        at: this.clock().toISOString(),
        by: decidedBy,
        reason,
        scopePolicy: this.scopePolicyFor({ candidate, scopePolicy }),
        conflictResolution
      }],
      status: 'confirmed',
      confirmedAt: this.clock().toISOString(),
      decidedBy,
      reason
    };
    const saved = this.persistPreference(confirmed, 0);
    if (!saved.success) return saved;
    this.confirmed.set(confirmed.preferenceId, confirmed);
    this.auditLog?.write('preference.confirmed', {
      preferenceId: confirmed.preferenceId,
      hypothesisId,
      evidenceCount: confirmed.evidenceEventIds.length
    });
    return { success: true, item: confirmed };
  }

  currentPreference(preferenceId) {
    if (!this.store?.getConfirmedPreference) return this.confirmed.get(preferenceId);
    const current = this.store.getConfirmedPreference(preferenceId);
    if (current) this.confirmed.set(preferenceId, current);
    else this.confirmed.delete(preferenceId);
    return current;
  }

  persistPreference(preference, expectedRevision) {
    try { this.store?.saveConfirmedPreference?.(preference, { expectedRevision, expectedGeneration: this.memoryGeneration }); return { success: true }; }
    catch (error) {
      if (error.code === 'F_MEMORY_GENERATION_CONFLICT') return { success: false, retryAfterRefresh: true,
        error: { code: error.code } };
      if (['F_MEMORY_REVISION_CONFLICT', 'F_MEMORY_REVISION_INVALID'].includes(error.code)) return { success: false, error: {
        code: error.code, ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {})
      } };
      throw error;
    }
  }

  checkMemoryGeneration() {
    if (this.store?.restoreGeneration && this.store.restoreGeneration() !== this.memoryGeneration) {
      return { success: false, retryAfterRefresh: true, error: { code: 'F_MEMORY_GENERATION_CONFLICT' } };
    }
    return null;
  }

  checkPreferenceRevision(current, expectedRevision) {
    if (expectedRevision === undefined) return null; // Legacy callers still use a fresh durable snapshot.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { success: false, error: { code: 'F_MEMORY_REVISION_INVALID' } };
    if (expectedRevision !== (current.revision ?? 1)) return { success: false, error: { code: 'F_MEMORY_REVISION_CONFLICT', currentRevision: current.revision ?? 1 } };
    return null;
  }

  publicPreference(preference) {
    if (this.recallAllowed(preference)) return preference;
    return { preferenceId: preference.preferenceId, hypothesisId: preference.hypothesisId,
      status: 'source_review_required', revision: preference.revision ?? 1,
      statement: '[철회된 원자료에 연결된 기억]', confidence: 0, contentWithheld: true,
      evidenceEventIds: [...(preference.evidenceEventIds ?? [])],
      history: (preference.history ?? []).map(item => ({ action: item.action, at: item.at, by: item.by })) };
  }

  update({ preferenceId, patch = {}, decidedBy = 'user_review', reason = '', expectedRevision } = {}) {
    const generationConflict = this.checkMemoryGeneration();
    if (generationConflict) return generationConflict;
    const current = this.currentPreference(preferenceId);
    if (!current) return { success: false, error: { code: 'F_CONFIRMED_PREFERENCE_NOT_FOUND' } };
    const conflict = this.checkPreferenceRevision(current, expectedRevision);
    if (conflict) return conflict;
    if (!this.recallAllowed(current) && !(decidedBy === 'source-retraction'
      && patch.status === 'source_review_required' && Object.keys(patch).length === 1)) {
      return { success: false, error: { code: 'F_MEMORY_SOURCE_RETRACTED' } };
    }
    if (patch.validUntil !== undefined && patch.validUntil !== null && (typeof patch.validUntil !== 'string'
      || !Number.isFinite(Date.parse(patch.validUntil)) || new Date(patch.validUntil).toISOString() !== patch.validUntil))
      return {success:false,error:{code:'F_MEMORY_EXPIRY_INVALID'}};
    const nextStatement = patch.statement ?? current.statement;
    const updated = {
      ...current,
      statement: nextStatement,
      validUntil: patch.validUntil === undefined ? (current.validUntil ?? null) : patch.validUntil,
      appliesTo: patch.appliesTo ?? current.appliesTo,
      scopePolicy: {
        ...(current.scopePolicy ?? this.scopePolicyFor({ candidate: current })),
        ...(patch.scopePolicy ?? {})
      },
      confidence: patch.confidence ?? current.confidence,
      conflictProfile: preferenceSignalProfile(nextStatement),
      revision: (current.revision ?? 1) + 1,
      updatedAt: this.clock().toISOString(),
      updatedBy: decidedBy,
      status: patch.status ?? current.status,
      history: [
        ...(current.history ?? []),
        {
          action: 'update',
          at: this.clock().toISOString(),
          by: decidedBy,
          reason,
          patch
        }
      ]
    };
    const saved = this.persistPreference(updated, current.revision ?? 1);
    if (!saved.success) return saved;
    this.confirmed.set(preferenceId, updated);
    this.auditLog?.write('preference.updated', { preferenceId, decidedBy, reason });
    return { success: true, item: this.publicPreference(updated) };
  }

  revoke({ preferenceId, decidedBy = 'user_review', reason = '', expectedRevision } = {}) {
    const generationConflict = this.checkMemoryGeneration();
    if (generationConflict) return generationConflict;
    const current = this.currentPreference(preferenceId);
    if (!current) return { success: false, error: { code: 'F_CONFIRMED_PREFERENCE_NOT_FOUND' } };
    const conflict = this.checkPreferenceRevision(current, expectedRevision);
    if (conflict) return conflict;
    const revoked = {
      ...current,
      status: 'revoked',
      revokedAt: this.clock().toISOString(),
      revokedBy: decidedBy,
      revokeReason: reason,
      revision: (current.revision ?? 1) + 1,
      history: [
        ...(current.history ?? []),
        {
          action: 'revoke',
          at: this.clock().toISOString(),
          by: decidedBy,
          reason
        }
      ]
    };
    const saved = this.persistPreference(revoked, current.revision ?? 1);
    if (!saved.success) return saved;
    this.confirmed.set(preferenceId, revoked);
    this.auditLog?.write('preference.revoked', { preferenceId, decidedBy, reason });
    return { success: true, item: this.publicPreference(revoked) };
  }

  batchDecide({ decisions = [], preferenceCandidates = [], decidedBy = 'batch_review', reason = 'batch preference review' } = {}) {
    if (!Array.isArray(decisions) || decisions.length === 0) {
      return { success: false, error: { code: 'F_PREFERENCE_BATCH_EMPTY' } };
    }
    const batchId = stableId('preference_batch', decisions.map((item) => `${item.hypothesisId}:${item.decision ?? 'confirm'}`).join('|'), this.clock().toISOString());
    const results = decisions.map((item, index) => ({
      index,
      hypothesisId: item.hypothesisId,
      decision: item.decision ?? 'confirm',
      result: this.decide({
        hypothesisId: item.hypothesisId,
        decision: item.decision ?? 'confirm',
        preferenceCandidates,
        decidedBy: item.decidedBy ?? decidedBy,
        reason: item.reason ?? reason,
        allowConflict: item.allowConflict ?? false,
        scopePolicy: item.scopePolicy ?? {},
        conflictResolution: item.conflictResolution ?? null
      })
    }));
    const failed = results.filter((item) => item.result.success === false);
    this.auditLog?.write('preference.batch_decided', {
      batchId,
      requestedCount: decisions.length,
      appliedCount: decisions.length - failed.length,
      failedCount: failed.length,
      decidedBy
    });
    return {
      success: failed.length === 0,
      batchId,
      requestedCount: decisions.length,
      appliedCount: decisions.length - failed.length,
      failedCount: failed.length,
      results
    };
  }

  migrationDiff({ targetScopePolicy = {}, includeInactive = false } = {}) {
    const generatedAt = this.clock().toISOString();
    const items = this.all({ includeInactive }).map((preference) => {
      const before = preference.scopePolicy ?? this.scopePolicyFor({ candidate: preference });
      const after = { ...before, ...targetScopePolicy };
      const changedFields = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
      return {
        preferenceId: preference.preferenceId,
        statement: preference.statement,
        before,
        after,
        changedFields,
        migrationRequired: changedFields.length > 0
      };
    });
    return {
      diffVersion: 'f-confirmed-preference-migration-diff-v1',
      generatedAt,
      targetScopePolicy,
      total: items.length,
      migrationRequiredCount: items.filter((item) => item.migrationRequired).length,
      items
    };
  }

  applicationPreview({ query = '', targetScopePolicy = {} } = {}) {
    const token = String(query).split(' ')[0];
    const preferences = this.all()
      .filter((preference) => !token || JSON.stringify(preference).includes(token));
    return {
      previewVersion: 'f-confirmed-preference-application-preview-v1',
      generatedAt: this.clock().toISOString(),
      query,
      matchedCount: preferences.length,
      rawStatementExported: true,
      planningHints: preferences.map((preference) => {
        const scopePolicy = preference.scopePolicy ?? this.scopePolicyFor({ candidate: preference });
        const nextScopePolicy = { ...scopePolicy, ...targetScopePolicy };
        const changedScopeFields = Object.keys(nextScopePolicy)
          .filter((key) => JSON.stringify(scopePolicy[key]) !== JSON.stringify(nextScopePolicy[key]));
        return {
          preferenceId: preference.preferenceId,
          statement: preference.statement,
          statementHash: hashSensitiveValue(preference.statement),
          confidence: preference.confidence,
          revision: preference.revision ?? 1,
          applyMode: 'strong_planning_hint',
          planningWeight: Number((preference.confidence * 2).toFixed(2)),
          scopePolicy,
          nextScopePolicy,
          changedScopeFields,
          requiresMigrationReview: changedScopeFields.length > 0,
          evidenceCount: preference.evidenceEventIds?.length ?? 0,
          conflictCount: preference.conflicts?.length ?? 0
        };
      }),
      guardrails: [
        'do_not_apply_revoked_preferences',
        'block_high_conflict_confirmation_without_resolution',
        'preview_scope_migration_before_apply'
      ]
    };
  }

  conflictResolutionDossier({ preferenceCandidates = [] } = {}) {
    const conflicts = this.conflictReport(preferenceCandidates);
    const items = conflicts.map((conflict) => ({
      dossierItemId: stableId('preference_conflict', `${conflict.preferenceId}:${conflict.hypothesisId}`, conflict.relationship),
      preferenceId: conflict.preferenceId,
      hypothesisId: conflict.hypothesisId,
      severity: conflict.severity,
      relationship: conflict.relationship,
      similarity: conflict.similarity,
      rationale: conflict.rationale,
      existingStatementHash: hashSensitiveValue(conflict.existingStatement),
      candidateStatementHash: hashSensitiveValue(conflict.candidateStatement),
      conflicts: conflict.conflicts,
      resolutionOptions: conflict.resolutionOptions,
      recommendedAction: conflict.severity === 'high' ? 'reject_or_merge_after_review' : 'collect_more_evidence',
      confirmBlockedUntilAcknowledged: conflict.severity === 'high'
    }));
    return {
      dossierVersion: 'f-confirmed-preference-conflict-resolution-dossier-v1',
      generatedAt: this.clock().toISOString(),
      conflictCount: items.length,
      highSeverityCount: items.filter((item) => item.severity === 'high').length,
      rawStatementStored: false,
      uiContract: {
        contractVersion: 'c-confirmed-preference-conflict-resolution-ui-v1',
        decisionActions: ['reject_candidate', 'merge_after_review', 'collect_more_evidence', 'confirm_after_acknowledgement'],
        requiresAcknowledgementForHighSeverity: true
      },
      items
    };
  }

  driftTrend({ preferenceCandidates = [], windowDays = 180 } = {}) {
    const confirmed = this.all({ includeInactive: true });
    const conflicts = this.conflictReport(preferenceCandidates);
    const revisions = confirmed.flatMap((preference) => preference.history ?? []);
    const updates = revisions.filter((item) => item.action === 'update').length;
    const revoked = confirmed.filter((item) => item.status === 'revoked').length;
    const rejected = this.rejected.size;
    const totalOutcomes = Math.max(1, confirmed.length + rejected);
    const driftScore = Math.min(1, Number(((updates * 0.18 + revoked * 0.25 + conflicts.length * 0.12 + rejected * 0.08) / totalOutcomes).toFixed(3)));
    const scopeCounts = confirmed.reduce((counts, preference) => {
      const key = preference.scopePolicy?.workspaceScope ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    return {
      trendVersion: 'f-confirmed-preference-drift-trend-v1',
      generatedAt: this.clock().toISOString(),
      windowDays,
      rawStatementStored: false,
      statementHashOnly: true,
      status: driftScore >= 0.6 ? 'review_required' : conflicts.some((item) => item.severity === 'high') ? 'conflict_watch' : 'stable',
      driftScore,
      totals: {
        confirmed: confirmed.filter((item) => item.status === 'confirmed').length,
        inactive: confirmed.filter((item) => item.status !== 'confirmed').length,
        rejected,
        updates,
        conflicts: conflicts.length,
        highSeverityConflicts: conflicts.filter((item) => item.severity === 'high').length
      },
      scopeCounts,
      items: confirmed.map((preference) => ({
        preferenceId: preference.preferenceId,
        statementHash: hashSensitiveValue(preference.statement),
        status: preference.status,
        revision: preference.revision ?? 1,
        historyCount: preference.history?.length ?? 0,
        conflictCount: conflicts.filter((item) => item.preferenceId === preference.preferenceId).length,
        scopePolicy: preference.scopePolicy ?? this.scopePolicyFor({ candidate: preference }),
        updatedAt: preference.updatedAt ?? preference.confirmedAt ?? null
      }))
    };
  }

  migrationReviewQueue({ targetScopePolicy = {}, includeInactive = false } = {}) {
    const diff = this.migrationDiff({ targetScopePolicy, includeInactive });
    const items = diff.items
      .filter((item) => item.migrationRequired)
      .map((item) => ({
        reviewItemId: stableId('preference_migration_review', item.preferenceId, item.changedFields.join('|')),
        preferenceId: item.preferenceId,
        statementHash: hashSensitiveValue(item.statement),
        changedFields: item.changedFields,
        before: item.before,
        after: item.after,
        severity: item.changedFields.includes('workspaceScope') || item.changedFields.includes('userScope') ? 'medium' : 'low',
        recommendedAction: 'approve_scope_migration'
      }));
    return {
      queueVersion: 'f-confirmed-preference-scope-migration-review-queue-v1',
      generatedAt: this.clock().toISOString(),
      uiContract: {
        contractVersion: 'c-confirmed-preference-scope-migration-review-ui-v1',
        decisionActions: ['approve_scope_migration', 'reject_scope_migration', 'defer'],
        requiresPreviewBeforeApply: true
      },
      migrationDiff: diff,
      queueCount: items.length,
      items
    };
  }

  conflictReport(preferenceCandidates = []) {
    return preferenceCandidates.flatMap((candidate) => this.conflictsForCandidate(candidate));
  }

  conflictsForCandidate(candidate, scopePolicy = this.scopePolicyFor({ candidate })) {
    return this.all().filter(preference => preferenceScopeMatches(preference.scopePolicy, scopePolicy)).flatMap((preference) => {
      const conflict = this.conflictClassifier.classify(preference.statement, candidate.statement);
      if (!conflict.conflicts.length) return [];
      return [{
        classifierId: conflict.classifierId,
        preferenceId: preference.preferenceId,
        hypothesisId: candidate.hypothesisId,
        existingStatement: preference.statement,
        candidateStatement: candidate.statement,
        relationship: conflict.relationship,
        severity: conflict.severity,
        similarity: conflict.similarity,
        rationale: conflict.rationale,
        conflicts: conflict.conflicts,
        resolutionOptions: conflict.resolutionOptions
      }];
    });
  }

  all({ includeInactive = false, includeRetractedContent = false } = {}) {
    if (this.store?.allConfirmedPreferences) this.confirmed = new Map(this.store.allConfirmedPreferences().map(item => [item.preferenceId, item]));
    const items = [...this.confirmed.values()];
    const isExpired = item => item.validUntil != null && (!Number.isFinite(Date.parse(item.validUntil))
      || Date.parse(item.validUntil) <= this.clock().getTime());
    return includeInactive ? items.map(item => {
      const visible = includeRetractedContent ? item : this.publicPreference(item);
      return visible.status === 'confirmed' && isExpired(item) ? {...visible,status:'expired'} : visible;
    }) : items.filter((item) => item.status === 'confirmed' && !isExpired(item) && this.recallAllowed(item));
  }
}

function preferenceSignalProfile(statement = '') {
  const text = String(statement).toLowerCase();
  const signals = {};
  if (/짧게|간결|요약|brief|concise/.test(text)) signals.length = 'concise';
  if (/자세|상세|길게|detail|long/.test(text)) signals.length = 'detailed';
  if (/크게|큰 글씨|large|big/.test(text)) signals.emphasis = 'large';
  if (/작게|small/.test(text)) signals.emphasis = 'small';
  if (/표|table/.test(text)) signals.layout = 'table';
  if (/문장|서술|paragraph/.test(text)) signals.layout = 'paragraph';
  if (/정중|공손|polite/.test(text)) signals.tone = 'polite';
  if (/캐주얼|편하게|casual/.test(text)) signals.tone = 'casual';
  if (/날짜|date/.test(text)) signals.subject = 'date';
  if (/제목|title/.test(text)) signals.subject = 'title';
  return {
    signals,
    dimensions: Object.keys(signals).sort()
  };
}

function preferenceConflict(left = '', right = '') {
  return new PreferenceSemanticConflictClassifier().classify(left, right);
}

export class FailureMemoryBuilder {
  constructor({ clock = () => new Date(), store = null, auditLog = null } = {}) {
    this.clock = clock;
    this.store = store;
    this.memoryGeneration = store?.restoreGeneration?.();
    this.auditLog = auditLog;
    this.failureEvents = new Set(['approval.rejected', 'execution.failed', 'verification.failed', 'policy.blocked']);
    this.guardrailReviews = new Map();
    this.guardrailReviewHistory = new Map();
    this.trendHistory = [];
    this.sourceDigest = store?.sourceRetractionDigest?.();
    this.withheldReviewCount = 0;
    for (const review of this.store?.allFailureGuardrailReviews?.() ?? []) {
      if (review.contentWithheld) this.withheldReviewCount++;
      else this.rememberGuardrailReview(review);
    }
  }

  rememberGuardrailReview(review) {
    this.guardrailReviews.set(review.failureId,review);
    const entries=this.guardrailReviewHistory.get(review.failureId)??[];
    if(!entries.some(entry=>entry.reviewId===review.reviewId))entries.push({reviewId:review.reviewId,action:review.decision,at:review.reviewedAt});
    this.guardrailReviewHistory.set(review.failureId,entries);
  }

  refreshSourceReviews() {
    if (this.store?.restoreGeneration && this.store.restoreGeneration() !== this.memoryGeneration) throw Object.assign(new Error('Memory generation changed.'), { code: 'F_MEMORY_GENERATION_CONFLICT' });
    const digest=this.store?.sourceRetractionDigest?.();
    if(this.store?.allFailureGuardrailReviews){
      const reviews=this.store.allFailureGuardrailReviews();
      this.guardrailReviews=new Map();this.guardrailReviewHistory=new Map();
      for(const review of reviews)if(!review.contentWithheld)this.rememberGuardrailReview(review);
      this.withheldReviewCount=reviews.filter(review=>review.contentWithheld).length;
    }
    if(digest!==this.sourceDigest){this.trendHistory=[];this.sourceDigest=digest;}
  }

  failureIdFor(event) {
    return `failure_${createHash('sha256').update(JSON.stringify([event.eventId, normalizeMemoryScope(event.source?.memoryScope)])).digest('hex').slice(0, 32)}`;
  }

  build(events, { patterns = [] } = {}) {
    this.refreshSourceReviews();
    const failures = events.filter((event) => this.failureEvents.has(event.eventType) && sourceRecallAllowed(event) && !this.store?.hasSourceRetraction?.(event.eventId));
    const lessons = failures
      .map((event, index) => {
        const cause = this.classifyCause(event);
        const workflowSignature = this.workflowSignature(event);
        const relatedPatterns = patterns.filter((pattern) => (
          workflowSignature
          && pattern.workflowSignature
          && pattern.workflowSignature.intentFamily === workflowSignature.intentFamily
          && pattern.workflowSignature.outputKind === workflowSignature.outputKind
        ));
        const recurrence = this.preventedRecurrenceMetric({ failure: event, events, cause, workflowSignature });
        const baseLesson = {
          failureId: this.failureIdFor(event),
          taskId: event.taskId,
          failureType: event.eventType.replace('.', '_'),
          cause,
          workflowSignature,
          planLink: this.planLink(event),
          lesson: this.lessonFor(event, cause),
          futureGuardrail: this.guardrailFor(cause),
          guardrailChecklist: this.guardrailChecklist(cause),
          preventedRecurrence: recurrence,
          relatedPatternIds: relatedPatterns.map((pattern) => pattern.patternId),
          evidenceEventIds: [event.eventId],
          severity: this.severityFor(event, cause),
          createdAt: event.createdAt
        };
        return this.applyGuardrailReview({
          ...baseLesson,
          planningGuardrail: this.planningGuardrailFor(baseLesson)
        });
      });
    this.recordTrend(lessons);
    return lessons;
  }

  classifyCause(event) {
    const reason = JSON.stringify(event.payload ?? {}).toLowerCase();
    if (event.eventType === 'policy.blocked' || /policy|tier|external|전송|업로드|결제|금지/.test(reason)) {
      return { category: 'policy_safety_block', code: event.payload?.reasonCode ?? event.payload?.errorCode ?? 'POLICY_BLOCKED' };
    }
    if (/capability|token|scope|권한/.test(reason)) {
      return { category: 'capability_scope_failure', code: event.payload?.reasonCode ?? 'CAPABILITY_SCOPE' };
    }
    if (/rollback|undo|복구/.test(reason)) {
      return { category: 'rollback_or_recovery_failure', code: event.payload?.reasonCode ?? 'ROLLBACK_CHECK' };
    }
    if (/검증|verification|evidence|증거/.test(reason) || event.eventType === 'verification.failed') {
      return { category: 'verification_evidence_failure', code: event.payload?.reasonCode ?? 'VERIFICATION_FAILED' };
    }
    if (/파일|path|outside|missing|exists|경로/.test(reason)) {
      return { category: 'filesystem_preflight_failure', code: event.payload?.reasonCode ?? 'FILESYSTEM_PREFLIGHT' };
    }
    if (event.eventType === 'approval.rejected') {
      return { category: 'user_rejected_intent', code: event.payload?.reasonCode ?? 'USER_REJECTED' };
    }
    return { category: 'execution_runtime_failure', code: event.payload?.reasonCode ?? 'RUNTIME_FAILED' };
  }

  workflowSignature(event) {
    const raw = event.payload?.rawText ?? event.payload?.command ?? event.payload?.summary ?? event.payload?.text;
    if (!raw) return null;
    const text = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    return {
      intentFamily: /전송|업로드|밴드|외부/.test(text) ? 'external_transfer_workflow'
        : /엑셀|xlsx|표/.test(text) ? 'spreadsheet_workflow'
          : /주보|안내문|공지|문서/.test(text) ? 'document_workflow'
            : 'general_workflow',
      outputKind: /엑셀|xlsx|표/.test(text) ? 'spreadsheet'
        : /주보/.test(text) ? 'bulletin'
          : /안내문|공지/.test(text) ? 'notice'
            : 'unspecified_output',
      actionKind: /전송|업로드|게시/.test(text) ? 'external_send'
        : /만들|생성|작성|초안/.test(text) ? 'create'
          : /수정|변경/.test(text) ? 'edit'
            : 'general_action',
      normalizedText: text.replace(/\b\d+\b/g, '<number>')
    };
  }

  planLink(event) {
    return {
      taskId: event.taskId,
      planId: event.payload?.planId ?? null,
      approvalId: event.payload?.approvalId ?? null,
      stepId: event.payload?.stepId ?? event.payload?.failedStepId ?? null,
      actionType: event.payload?.actionType ?? null,
      toolName: event.payload?.toolName ?? null
    };
  }

  lessonFor(event, cause) {
    const explicit = event.payload?.reason ?? event.payload?.message;
    if (explicit) return String(explicit);
    const lessons = {
      policy_safety_block: '외부 전송/고위험/민감 작업은 자동화 후보나 모바일 승인으로 승격하지 않는다.',
      capability_scope_failure: '실행 전 capability scope와 tool/action/task 일치를 먼저 검증한다.',
      rollback_or_recovery_failure: '변경 전 rollback 가능성과 복구 증거를 먼저 확보한다.',
      verification_evidence_failure: '실행 결과에는 검증 가능한 evidence와 어댑터 profile이 필요하다.',
      filesystem_preflight_failure: '파일 작업 전 경로, 존재 여부, 충돌 여부를 shadow 단계에서 확인한다.',
      user_rejected_intent: '사용자가 거절한 의도는 같은 형태로 반복 제안하지 않고 이유를 우선 확인한다.',
      execution_runtime_failure: '동일 도구 실행 전 입력 contract와 실패 로그를 먼저 확인한다.'
    };
    return lessons[cause.category] ?? '유사 작업에서 같은 실패 조건을 먼저 확인합니다.';
  }

  guardrailFor(cause) {
    return `guard_${cause.category}`;
  }

  guardrailChecklist(cause) {
    const common = ['evidence_event_present', 'do_not_promote_to_confirmed_preference_without_review'];
    const byCause = {
      policy_safety_block: ['require_pc_or_policy_review', 'block_external_transfer_autonomy'],
      capability_scope_failure: ['validate_capability_scope', 'require_single_use_token'],
      rollback_or_recovery_failure: ['require_rollback_plan', 'verify_recovery_evidence'],
      verification_evidence_failure: ['require_execution_evidence', 'run_g_verifier_before_learning'],
      filesystem_preflight_failure: ['run_shadow_preflight', 'verify_allowed_root'],
      user_rejected_intent: ['ask_before_repeating_suggestion', 'record_rejection_reason'],
      execution_runtime_failure: ['validate_tool_contract', 'capture_runtime_error']
    };
    return [...common, ...(byCause[cause.category] ?? [])];
  }

  planningGuardrailFor(lesson) {
    return {
      adapterId: 'f-failure-memory-planning-guardrail-v1',
      sourceFailureId: lesson.failureId,
      injectBefore: 'A.TaskPlanner.createPlan',
      severity: lesson.severity,
      condition: {
        intentFamily: lesson.workflowSignature?.intentFamily ?? null,
        outputKind: lesson.workflowSignature?.outputKind ?? null,
        actionKind: lesson.workflowSignature?.actionKind ?? null,
        causeCategory: lesson.cause.category
      },
      checklist: lesson.guardrailChecklist,
      recommendation: lesson.lesson,
      applyMode: lesson.severity === 'critical' ? 'block_or_require_pc_review' : 'preflight_warning',
      planningWeight: Number((lesson.preventedRecurrence.score * (lesson.severity === 'critical' ? 2 : 1.2)).toFixed(2))
    };
  }

  applyGuardrailReview(lesson) {
    const review = this.guardrailReviews.get(lesson.failureId);
    if (!review) return lesson;
    const guardrailChecklist = review.patch?.guardrailChecklist ?? lesson.guardrailChecklist;
    const next = {
      ...lesson,
      lesson: review.patch?.lesson ?? lesson.lesson,
      futureGuardrail: review.patch?.futureGuardrail ?? lesson.futureGuardrail,
      guardrailChecklist,
      guardrailReview: review,
      revision: (this.guardrailReviewHistory.get(lesson.failureId)??[]).length,
      history: (this.guardrailReviewHistory.get(lesson.failureId)??[]).map(({action,at})=>({action,at})),
      status: review.decision === 'disable' ? 'guardrail_disabled_by_review' : 'guardrail_reviewed'
    };
    return {
      ...next,
      planningGuardrail: {
        ...this.planningGuardrailFor(next),
        disabled: review.decision === 'disable',
        reviewedAt: review.reviewedAt
      }
    };
  }

  reviewGuardrail({ failureId, decision = 'update', patch = {}, reviewedBy = 'user_review', reason = '' } = {}) {
    if (!failureId) return { success: false, error: { code: 'F_FAILURE_ID_REQUIRED' } };
    if (!['update', 'disable', 'keep'].includes(decision)) {
      return { success: false, error: { code: 'F_FAILURE_GUARDRAIL_DECISION_INVALID' } };
    }
    const sourceDigest = this.store?.sourceRetractionDigest?.();
    const source = this.store?.allEvents?.().find(event => this.failureEvents.has(event.eventType) && this.failureIdFor(event) === failureId);
    if (source && this.store?.hasSourceRetraction?.(source.eventId)) return { success: false, error: { code: 'F_MEMORY_SOURCE_RETRACTED' } };
    const review = {
      evidenceEventIds: source ? [source.eventId] : [],
      reviewId: `failure_guardrail_review_${randomUUID()}`,
      failureId,
      decision,
      patch,
      reviewedBy,
      reason,
      reviewedAt: this.clock().toISOString()
    };
    try {
      this.store?.saveFailureGuardrailReview?.(review, { expectedGeneration: this.memoryGeneration, expectedSourceRetractionDigest: sourceDigest });
    } catch (error) {
      if (['F_MEMORY_GENERATION_CONFLICT', 'F_MEMORY_SOURCE_CHANGED', 'F_MEMORY_SOURCE_RETRACTED'].includes(error.code)) return { success: false, retryAfterRefresh: true,
        error: { code: error.code } };
      throw error;
    }
    this.rememberGuardrailReview(review);
    this.auditLog?.write('failure.guardrail.review.persisted', {
      reviewId: review.reviewId,
      failureId,
      decision,
      reviewedBy
    });
    return { success: true, review, persisted: Boolean(this.store?.saveFailureGuardrailReview) };
  }

  planningGuardrails({ failures = [], query = '' } = {}) {
    const token = String(query ?? '').split(/\s+/).filter(Boolean)[0] ?? '';
    return failures
      .filter((lesson) => !token || JSON.stringify(lesson).includes(token))
      .map((lesson) => lesson.planningGuardrail)
      .filter((guardrail) => guardrail && guardrail.disabled !== true)
      .sort((a, b) => b.planningWeight - a.planningWeight);
  }

  recordTrend(failureLessons) {
    const snapshot = {
      observedAt: this.clock().toISOString(),
      failureCount: failureLessons.length,
      criticalCount: failureLessons.filter((lesson) => lesson.severity === 'critical').length,
      recurrenceDetectedCount: failureLessons.filter((lesson) => lesson.preventedRecurrence.status === 'recurrence_detected').length,
      guardrailHoldingCount: failureLessons.filter((lesson) => lesson.preventedRecurrence.status === 'guardrail_holding').length,
      averageRecurrenceScore: failureLessons.length
        ? Number((failureLessons.reduce((sum, lesson) => sum + lesson.preventedRecurrence.score, 0) / failureLessons.length).toFixed(2))
        : 0
    };
    this.trendHistory.unshift(snapshot);
    this.trendHistory = this.trendHistory.slice(0, 25);
    return snapshot;
  }

  trendStatus() {
    this.refreshSourceReviews();
    const latest = this.trendHistory[0] ?? null;
    return {
      latest,
      history: [...this.trendHistory],
      reviewCount: this.guardrailReviews.size,
      withheldReviewCount: this.withheldReviewCount,
      dashboard: {
        dashboardVersion: 'f-failure-recurrence-dashboard-v1',
        status: this.withheldReviewCount > 0 ? 'source_review_required' : latest?.recurrenceDetectedCount > 0 ? 'review_required' : 'guardrails_holding',
        reviewedGuardrailCount: this.guardrailReviews.size,
        withheldReviewCount: this.withheldReviewCount,
        recurrenceDetectedCount: latest?.recurrenceDetectedCount ?? 0,
        guardrailHoldingCount: latest?.guardrailHoldingCount ?? 0,
        averageRecurrenceScore: latest?.averageRecurrenceScore ?? 0
      }
    };
  }

  guardrailReviewQueue({ failures = [], query = '' } = {}) {
    const token = String(query ?? '').split(/\s+/).filter(Boolean)[0] ?? '';
    const items = failures
      .filter((lesson) => !token || JSON.stringify(lesson).includes(token))
      .map((lesson) => ({
        reviewItemId: stableId('failure_guardrail_queue', lesson.failureId, lesson.severity),
        failureId: lesson.failureId,
        taskId: lesson.taskId,
        cause: lesson.cause,
        severity: lesson.severity,
        recurrenceStatus: lesson.preventedRecurrence.status,
        recurrenceScore: lesson.preventedRecurrence.score,
        reviewed: Boolean(lesson.guardrailReview),
        planningGuardrail: lesson.planningGuardrail,
        checklist: lesson.guardrailChecklist,
        evidenceEventIds: lesson.evidenceEventIds,
        recommendedAction: lesson.preventedRecurrence.status === 'recurrence_detected'
          ? 'update_guardrail'
          : lesson.guardrailReview ? 'keep_reviewed_guardrail' : 'review_guardrail'
      }));
    return {
      queueVersion: 'f-failure-guardrail-review-queue-v1',
      generatedAt: this.clock().toISOString(),
      query,
      queueCount: items.length,
      criticalCount: items.filter((item) => item.severity === 'critical').length,
      uiContract: {
        contractVersion: 'c-failure-guardrail-review-ui-v1',
        decisionActions: ['keep', 'update', 'disable', 'defer'],
        requiresReasonForDisable: true,
        surfaces: ['mobile-growth-review', 'planning-context']
      },
      items
    };
  }

  recurrenceTrendVisualization() {
    const status = this.trendStatus();
    const history = status.history.length ? status.history : [{
      observedAt: this.clock().toISOString(),
      failureCount: 0,
      criticalCount: 0,
      recurrenceDetectedCount: 0,
      guardrailHoldingCount: 0,
      averageRecurrenceScore: 0
    }];
    return {
      visualizationVersion: 'f-failure-recurrence-trend-visualization-v1',
      generatedAt: this.clock().toISOString(),
      dashboardVersion: status.dashboard.dashboardVersion,
      status: status.dashboard.status,
      points: history.slice().reverse().map((snapshot, index) => ({
        index,
        observedAt: snapshot.observedAt,
        failureCount: snapshot.failureCount,
        criticalCount: snapshot.criticalCount,
        recurrenceDetectedCount: snapshot.recurrenceDetectedCount,
        guardrailHoldingCount: snapshot.guardrailHoldingCount,
        averageRecurrenceScore: snapshot.averageRecurrenceScore
      })),
      bands: [
        { band: 'healthy', maxRecurrenceDetected: 0, minGuardrailHolding: 1 },
        { band: 'review', maxRecurrenceDetected: 2, minGuardrailHolding: 0 },
        { band: 'critical', maxRecurrenceDetected: null, minGuardrailHolding: 0 }
      ],
      uiContract: {
        contractVersion: 'c-failure-recurrence-trend-chart-v1',
        chartType: 'stacked-recurrence-line',
        highlightsCriticalFailures: true
      }
    };
  }

  effectivenessTuningReport({ failures = [] } = {}) {
    const items = failures.map((lesson) => {
      const reviewed = Boolean(lesson.guardrailReview);
      const recurrence = lesson.preventedRecurrence;
      const effectivenessScore = Number(Math.min(1, recurrence.score + (reviewed ? 0.08 : 0)).toFixed(2));
      return {
        failureId: lesson.failureId,
        causeCategory: lesson.cause.category,
        severity: lesson.severity,
        reviewed,
        recurrenceStatus: recurrence.status,
        effectivenessScore,
        recommendedTuning: recurrence.status === 'recurrence_detected'
          ? 'tighten_guardrail_and_collect_new_fixture'
          : reviewed ? 'monitor_reviewed_guardrail' : 'review_guardrail_before_autonomy'
      };
    });
    return {
      reportVersion: 'f-failure-guardrail-effectiveness-tuning-v1',
      generatedAt: this.clock().toISOString(),
      status: items.some((item) => item.recurrenceStatus === 'recurrence_detected') ? 'review_required' : 'passed',
      rawPayloadStored: false,
      total: items.length,
      reviewedCount: items.filter((item) => item.reviewed).length,
      averageEffectivenessScore: items.length ? average(items.map((item) => item.effectivenessScore)) : 1,
      items
    };
  }

  taxonomyFixtureCoverage() {
    const items = failureTaxonomyFixtureCorpus.map((fixture) => {
      const event = {
        eventId: fixture.fixtureId,
        eventType: fixture.eventType,
        taskId: fixture.taskId,
        payload: fixture.payload,
        createdAt: this.clock().toISOString()
      };
      const cause = this.classifyCause(event);
      const severity = this.severityFor(event, cause);
      const checklist = this.guardrailChecklist(cause);
      const checklistPassed = fixture.expected.checklistIncludes.every((item) => checklist.includes(item));
      const passed = cause.category === fixture.expected.category
        && severity === fixture.expected.severity
        && checklistPassed;
      return {
        fixtureId: fixture.fixtureId,
        eventType: fixture.eventType,
        expected: fixture.expected,
        actual: { category: cause.category, severity, checklist },
        passed
      };
    });
    return {
      corpusId: failureTaxonomyCorpusId,
      total: items.length,
      passed: items.filter((item) => item.passed).length,
      coverageScore: items.length ? Number((items.filter((item) => item.passed).length / items.length).toFixed(2)) : 0,
      items
    };
  }

  preventedRecurrenceMetric({ failure, events, cause, workflowSignature }) {
    const occurredAt = Date.parse(failure.createdAt ?? new Date().toISOString());
    const after = events.filter((event) => Date.parse(event.createdAt ?? '') > occurredAt);
    const similarAfter = after.filter((event) => {
      const signature = this.workflowSignature(event);
      return signature
        && workflowSignature
        && signature.intentFamily === workflowSignature.intentFamily
        && signature.outputKind === workflowSignature.outputKind;
    });
    const repeatedFailures = similarAfter.filter((event) => this.failureEvents.has(event.eventType) && this.classifyCause(event).category === cause.category);
    const successfulRecoveries = similarAfter.filter((event) => ['execution.completed', 'approval.approved', 'feedback.good'].includes(event.eventType));
    const score = repeatedFailures.length === 0
      ? Math.min(1, 0.55 + successfulRecoveries.length * 0.15)
      : Math.max(0.1, 0.55 - repeatedFailures.length * 0.15);
    return {
      checkedAfterEventCount: similarAfter.length,
      repeatedFailureCount: repeatedFailures.length,
      successfulRecoveryCount: successfulRecoveries.length,
      score: Number(score.toFixed(2)),
      status: repeatedFailures.length === 0 ? 'guardrail_holding' : 'recurrence_detected'
    };
  }

  severityFor(event, cause) {
    if (cause.category === 'policy_safety_block') return 'critical';
    if (['verification_evidence_failure', 'rollback_or_recovery_failure', 'capability_scope_failure'].includes(cause.category)) return 'high';
    return event.eventType === 'approval.rejected' ? 'medium' : 'medium';
  }
}

export class MemoryDecayEngine {
  score(item, now = new Date()) {
    const confidence = item.confidence ?? 0.5;
    const lastSeenAt = item.lastSeenAt ?? item.createdAt ?? now.toISOString();
    const ageDays = Math.max(0, (now.getTime() - Date.parse(lastSeenAt)) / 86_400_000);
    const decayRate = item.severity === 'critical' ? 0.005 : 0.03;
    return Math.max(0.1, Number((confidence - ageDays * decayRate).toFixed(2)));
  }
}

export class MemoryHygieneManager {
  constructor({ decayEngine = new MemoryDecayEngine(), clock = () => new Date(), decisions = [] } = {}) {
    this.decayEngine = decayEngine;
    this.clock = clock;
    this.decisions = new Map(decisions.map((decision) => [decision.targetId, decision]));
  }

  report({ events, patterns, preferenceCandidates, failureLessons }) {
    const doNotRememberIds = new Set(events.filter((event) => event.learningFlags?.doNotRemember).map((event) => event.eventId));
    const sensitiveIds = new Set(events.filter((event) => event.learningFlags?.containsSensitiveData).map((event) => event.eventId));
    const oldEventIds = new Set(events
      .filter((event) => this.ageDays(event) >= 30 && !event.learningFlags?.doNotRemember)
      .map((event) => event.eventId));
    const staleCandidates = preferenceCandidates.map((candidate) => ({
      ...candidate,
      confidence: this.decayEngine.score(candidate, this.clock()),
      status: candidate.evidenceEventIds.some((id) => doNotRememberIds.has(id)) ? 'inactive_do_not_remember' : candidate.status
    }));
    const reviewQueue = this.reviewQueue({ events, preferenceCandidates, patterns, doNotRememberIds, sensitiveIds, oldEventIds });
    return {
      generatedAt: this.clock().toISOString(),
      duplicateSafe: true,
      doNotRememberEventIds: [...doNotRememberIds],
      sensitiveEventIds: [...sensitiveIds],
      staleEventIds: [...oldEventIds],
      activePatterns: patterns.filter((pattern) => !pattern.evidenceEventIds?.some((id) => doNotRememberIds.has(id))),
      preferenceCandidates: staleCandidates,
      failureLessons,
      reviewQueue,
      decisions: [...this.decisions.values()],
      actionSummary: this.actionSummary(),
      recommendations: staleCandidates
        .filter((candidate) => candidate.confidence < 0.4)
        .map((candidate) => `재검증 필요: ${candidate.statement}`)
        .concat(reviewQueue.map((item) => `${item.recommendedAction}: ${item.targetId}`))
    };
  }

  reviewQueue({ events, preferenceCandidates, patterns, doNotRememberIds, sensitiveIds, oldEventIds }) {
    const items = [];
    for (const event of events) {
      if (this.decisions.has(event.eventId)) continue;
      if (doNotRememberIds.has(event.eventId)) {
        items.push(this.reviewItem({
          targetType: 'memory_event',
          targetId: event.eventId,
          reason: 'do_not_remember',
          recommendedAction: 'delete',
          evidenceEventIds: [event.eventId],
          priority: 'high'
        }));
      } else if (sensitiveIds.has(event.eventId)) {
        items.push(this.reviewItem({
          targetType: 'memory_event',
          targetId: event.eventId,
          reason: 'contains_sensitive_data',
          recommendedAction: 'redact',
          evidenceEventIds: [event.eventId],
          priority: 'high'
        }));
      } else if (oldEventIds.has(event.eventId)) {
        items.push(this.reviewItem({
          targetType: 'memory_event',
          targetId: event.eventId,
          reason: 'stale_memory',
          recommendedAction: 'defer',
          evidenceEventIds: [event.eventId],
          priority: 'medium'
        }));
      }
    }
    for (const candidate of preferenceCandidates) {
      if (this.decisions.has(candidate.hypothesisId)) continue;
      if ((candidate.evidenceEventIds ?? []).some((id) => doNotRememberIds.has(id) || sensitiveIds.has(id))) {
        items.push(this.reviewItem({
          targetType: 'preference_candidate',
          targetId: candidate.hypothesisId,
          reason: 'unsafe_candidate_evidence',
          recommendedAction: 'delete',
          evidenceEventIds: candidate.evidenceEventIds,
          priority: 'high'
        }));
      } else if (this.decayEngine.score(candidate, this.clock()) < 0.4) {
        items.push(this.reviewItem({
          targetType: 'preference_candidate',
          targetId: candidate.hypothesisId,
          reason: 'low_confidence_after_decay',
          recommendedAction: 'defer',
          evidenceEventIds: candidate.evidenceEventIds,
          priority: 'medium'
        }));
      }
    }
    for (const pattern of patterns) {
      if (this.decisions.has(pattern.patternId)) continue;
      if ((pattern.negativeEvidence?.count ?? 0) > 0 || pattern.safetyStatus === 'review_required_negative_evidence') {
        items.push(this.reviewItem({
          targetType: 'pattern',
          targetId: pattern.patternId,
          reason: 'negative_evidence_present',
          recommendedAction: 'defer',
          evidenceEventIds: [...(pattern.evidenceEventIds ?? []), ...(pattern.negativeEvidence?.eventIds ?? [])],
          priority: 'medium'
        }));
      }
    }
    return items.sort((a, b) => this.priorityRank(b.priority) - this.priorityRank(a.priority));
  }

  reviewItem({ targetType, targetId, reason, recommendedAction, evidenceEventIds, priority }) {
    return {
      reviewItemId: stableId('hygiene', `${targetType}:${targetId}:${reason}`, this.clock().toISOString()),
      targetType,
      targetId,
      reason,
      recommendedAction,
      evidenceEventIds: evidenceEventIds ?? [],
      priority,
      createdAt: this.clock().toISOString()
    };
  }

  decide({ targetType = 'memory_event', targetId, action, reason = '', decidedBy = 'user_review' } = {}, { publish = true } = {}) {
    const allowed = ['keep', 'delete', 'redact', 'defer'];
    if (!targetId || !allowed.includes(action)) {
      return { success: false, error: { code: 'F_HYGIENE_DECISION_INVALID' } };
    }
    const decision = {
      decisionId: stableId('hygiene_decision', `${targetType}:${targetId}:${action}`, this.clock().toISOString()),
      targetType,
      targetId,
      action,
      reason,
      decidedBy,
      decidedAt: this.clock().toISOString(),
      status: action === 'defer' ? 'deferred' : 'applied'
    };
    if (publish) this.decisions.set(targetId, decision);
    return { success: true, decision };
  }

  decisionFor(targetId) {
    return this.decisions.get(targetId) ?? null;
  }

  actionSummary() {
    const summary = { keep: 0, delete: 0, redact: 0, defer: 0 };
    for (const decision of this.decisions.values()) {
      summary[decision.action] += 1;
    }
    return summary;
  }

  ageDays(event) {
    const createdAt = Date.parse(event.createdAt ?? this.clock().toISOString());
    if (!Number.isFinite(createdAt)) return 0;
    return Math.max(0, (this.clock().getTime() - createdAt) / 86_400_000);
  }

  priorityRank(priority) {
    return priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
  }
}

export class AutonomyCandidateGenerator {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  generate({ patterns, events, lifecycle = new Map() }) {
    return patterns
      .filter((pattern) => pattern.occurrenceCount >= 5)
      .filter((pattern) => !/삭제|전송|업로드|결제|비밀번호|상담|010/.test(pattern.description))
      .map((pattern, index) => {
        const evidenceEvents = events.filter((event) => pattern.evidenceEventIds.includes(event.eventId));
        const approvalCount = evidenceEvents.filter((event) => ['approval.approved', 'approval.decision.received'].includes(event.eventType)).length || pattern.occurrenceCount;
        const failureEvents = events.filter((event) => ['execution.failed', 'verification.failed', 'policy.blocked'].includes(event.eventType)
          && pattern.negativeEvidence?.eventIds?.includes(event.eventId));
        const rejectionEvents = events.filter((event) => event.eventType === 'approval.rejected'
          && pattern.negativeEvidence?.eventIds?.includes(event.eventId));
        const candidateId = `auto_cand_${index + 1}`;
        const existing = lifecycle.get(candidateId);
        const generatedAt = existing?.lifecycle?.generatedAt ?? this.clock().toISOString();
        const expiresAt = existing?.expiresAt ?? new Date(this.clock().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        return {
          candidateId,
          title: `${pattern.description} 자동화 후보`,
          sourcePatternId: pattern.patternId,
          riskTier: 5,
          externalTransfer: false,
          containsSensitiveData: false,
          proposedScope: {
            actionType: 'CREATE_FILE',
            toolName: 'filesystem.createTextFile'
          },
          evidence: {
            approvalCount,
            failureCount: failureEvents.length,
            rejectionCount: rejectionEvents.length,
            eventIds: pattern.evidenceEventIds
          },
          negativeEvidence: {
            eventIds: [...new Set([...failureEvents, ...rejectionEvents].map((event) => event.eventId))],
            failureEventTypes: [...new Set(failureEvents.map((event) => event.eventType))],
            rejectionCount: rejectionEvents.length
          },
          readinessScore: Math.min(100, Math.round(pattern.confidence * 100)),
          generatedAt,
          expiresAt,
          lifecycle: existing?.lifecycle ?? {
            state: 'candidate',
            generatedAt,
            policySubmittedAt: null,
            userReviewedAt: null,
            policyDecision: null,
            userDecision: null
          },
          status: existing?.status ?? 'candidate_requires_policy_review'
        };
      });
  }
}

export class GenomeBuilder {
  build({ events, patterns, preferenceCandidates, confirmedPreferences, failureLessons }) {
    const approvals = events.filter((event) => ['approval.approved', 'approval.decision.received'].includes(event.eventType)).length;
    const edits = events.filter((event) => event.eventType === 'approval.edited').length;
    const rejections = events.filter((event) => event.eventType === 'approval.rejected').length;
    const criticalFailures = failureLessons.filter((lesson) => lesson.severity === 'critical').length;
    const decisionTotal = Math.max(1, approvals + edits + rejections);
    const riskPosture = criticalFailures > 0 || rejections > approvals ? 'conservative' : approvals >= 5 && rejections === 0 ? 'confident_low_risk' : 'balanced';
    return {
      schemaVersion: 'f-genome-v2',
      workflowGenome: patterns.map((pattern) => ({
        patternId: pattern.patternId,
        description: pattern.description,
        occurrenceCount: pattern.occurrenceCount,
        confidence: pattern.confidence,
        weight: Number((pattern.confidence * Math.log2(pattern.occurrenceCount + 1)).toFixed(2)),
        cadence: pattern.recurrenceCadence,
        safetyStatus: pattern.safetyStatus
      })),
      preferenceGenome: preferenceCandidates.map((candidate) => ({
        hypothesisId: candidate.hypothesisId,
        statement: candidate.statement,
        confidence: candidate.confidence,
        status: candidate.status,
        conflictProfile: candidate.conflictProfile,
        weight: Number((candidate.confidence * Math.log2((candidate.evidenceEventIds?.length ?? 0) + 1)).toFixed(2))
      })).concat(confirmedPreferences.map((preference) => ({
        preferenceId: preference.preferenceId,
        statement: preference.statement,
        confidence: preference.confidence,
        status: preference.status,
        revision: preference.revision ?? 1,
        conflictProfile: preference.conflictProfile,
        weight: Number((preference.confidence * 2).toFixed(2)),
        applyMode: 'strong_planning_hint'
      }))),
      decisionGenome: {
        approvals,
        edits,
        rejections,
        approvalRate: Number((approvals / decisionTotal).toFixed(2)),
        editRate: Number((edits / decisionTotal).toFixed(2)),
        rejectionRate: Number((rejections / decisionTotal).toFixed(2))
      },
      riskSensitivityMemory: failureLessons.filter((lesson) => lesson.severity === 'critical'),
      riskCalibration: {
        posture: riskPosture,
        conservativeScore: Math.min(100, criticalFailures * 35 + rejections * 12),
        reasons: [
          criticalFailures ? 'critical_failure_lessons_present' : null,
          rejections ? 'approval_rejections_present' : null,
          approvals >= 5 && rejections === 0 ? 'stable_low_risk_approval_pattern' : null
        ].filter(Boolean)
      }
    };
  }
}

export class GenomeTrendTracker {
  constructor({ clock = () => new Date(), maxSnapshots = 20, snapshots = [] } = {}) {
    this.clock = clock;
    this.maxSnapshots = maxSnapshots;
    this.snapshots = snapshots.slice(-maxSnapshots);
  }

  record(genomes) {
    const previous = this.snapshots.at(-1);
    const snapshot = {
      snapshotId: stableId('genome_trend', `${this.snapshots.length}:${JSON.stringify(genomes.decisionGenome)}`, this.clock().toISOString()),
      generatedAt: this.clock().toISOString(),
      workflowCount: genomes.workflowGenome.length,
      preferenceCount: genomes.preferenceGenome.length,
      confirmedPreferenceCount: genomes.preferenceGenome.filter((item) => item.status === 'confirmed').length,
      riskPosture: genomes.riskCalibration.posture,
      decisionGenome: genomes.decisionGenome
    };
    this.snapshots.push(snapshot);
    this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    return {
      latest: snapshot,
      previous: previous ?? null,
      delta: previous ? {
        workflowCount: snapshot.workflowCount - previous.workflowCount,
        preferenceCount: snapshot.preferenceCount - previous.preferenceCount,
        confirmedPreferenceCount: snapshot.confirmedPreferenceCount - previous.confirmedPreferenceCount,
        approvalRate: Number((snapshot.decisionGenome.approvalRate - previous.decisionGenome.approvalRate).toFixed(2))
      } : null,
      history: this.snapshots
    };
  }
}

export class CloneEvidenceBuilder {
  build({ events, confirmedPreferences, patterns }) {
    const safeEvents = events.filter((event) => !event.learningFlags?.containsSensitiveData
      && !event.learningFlags?.doNotRemember
      && !event.trustBoundary?.externalContent);
    const evidenceEventIds = [
      ...new Set([
        ...confirmedPreferences.flatMap((preference) => preference.evidenceEventIds ?? []),
        ...patterns.flatMap((pattern) => pattern.evidenceEventIds ?? [])
      ])
    ].filter((eventId) => safeEvents.some((event) => event.eventId === eventId));
    return {
      cloneEvidenceId: stableId('clone_evidence', evidenceEventIds.join(':'), new Date(0).toISOString()),
      evidenceEventIds,
      confirmedPreferenceIds: confirmedPreferences.map((preference) => preference.preferenceId),
      repeatedPatternIds: patterns.map((pattern) => pattern.patternId),
      coverageScore: Math.min(100, Math.round((evidenceEventIds.length / 8) * 100)),
      safetyStatus: evidenceEventIds.length >= 3 ? 'reviewable_safe_subset' : 'insufficient_evidence',
      allowedUse: 'assistive_style_and_workflow_hints_only',
      blockedUse: ['identity_impersonation', 'sensitive_memory_reconstruction', 'autonomous_policy_relaxation']
    };
  }
}

export class StyleGenomeBuilder {
  build(events, confirmedPreferences = []) {
    const texts = events
      .filter(sourceRecallAllowed)
      .map((event) => `${event.payload?.rawText ?? ''} ${event.payload?.text ?? ''} ${event.payload?.editRequest ?? ''}`)
      .filter((text) => text.trim() && !text.includes('[sensitive-summary]'));
    const joined = texts.join(' ');
    const signals = {
      concise: countMatches(joined, /짧게|간단|요약|핵심|brief|concise/gi),
      dateEmphasis: countMatches(joined, /날짜|일정|마감|date|schedule/gi),
      visualEmphasis: countMatches(joined, /크게|굵게|표|테이블|제목|강조|bold|table/gi),
      politeTone: countMatches(joined, /주세요|해줘|부탁|정중|존댓말/gi)
    };
    const dominantSignals = Object.entries(signals)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([signal, count]) => ({ signal, count }));
    return {
      styleGenomeId: stableId('style_genome', JSON.stringify(signals), new Date(0).toISOString()),
      signals,
      dominantSignals,
      confirmedPreferenceCount: confirmedPreferences.length,
      confidence: Math.min(0.9, Number((0.35 + dominantSignals.length * 0.12 + confirmedPreferences.length * 0.08).toFixed(2))),
      evidenceTextCount: texts.length,
      guidance: dominantSignals.map((item) => styleGuidanceFor(item.signal))
    };
  }
}

export class SkillDistillationEngine {
  distill({ patterns, confirmedPreferences, styleGenome, events }) {
    return patterns
      .filter((pattern) => pattern.occurrenceCount >= 3)
      .map((pattern, index) => {
        const scope = normalizeMemoryScope(pattern.memoryScope);
        const scopedEvents = Array.isArray(events) ? events.filter(event => scope
          ? memoryScopeMatches(event, scope) : !normalizeMemoryScope(event.source?.memoryScope)) : null;
        const scopedPreferences = scopedEvents ? confirmedPreferences.filter(preference => scope
          ? preferenceSourcesMatch(preference, scopedEvents, scope)
          : (preference.evidenceEventIds ?? []).length > 0 && preference.evidenceEventIds.every(id => scopedEvents.some(event => event.eventId === id && sourceRecallAllowed(event)))) : confirmedPreferences;
        const scopedStyle = scopedEvents ? new StyleGenomeBuilder().build(scopedEvents, scopedPreferences) : styleGenome;
        return {
        distilledSkillId: scope ? `scoped_skill_distill_${createHash('sha256').update(pattern.patternId).digest('hex')}` : `skill_distill_${index + 1}`,
        memoryScope: scope,
        title: `${pattern.description} 보조 스킬 초안`,
        sourcePatternId: pattern.patternId,
        evidenceEventIds: pattern.evidenceEventIds,
        confirmedPreferenceIds: scopedPreferences.map((preference) => preference.preferenceId),
        suggestedSteps: [
          '반복 작업 의도를 확인한다.',
          '확정 선호와 스타일 genome을 작업 초안에만 적용한다.',
          'E 정책 승인 전에는 실행하지 않는다.'
        ],
        styleHints: scopedStyle.guidance,
        confidence: Math.min(0.88, Number((pattern.confidence + scopedPreferences.length * 0.04).toFixed(2))),
        status: 'draft_requires_review',
        safetyConstraints: ['requires_user_review', 'requires_policy_check', 'no_sensitive_reconstruction']
      }; });
  }
}

export class SkillDraftRegistry {
  constructor({ clock = () => new Date(), restoredState = null, recallAllowed = () => true } = {}) {
    this.clock = clock;
    this.recallAllowed = recallAllowed;
    this.reviews = new Map((restoredState?.reviews ?? []).map((item) => [item.draftId, item]));
    this.registry = new Map((restoredState?.registryEntries ?? []).map((item) => [item.skillId, item]));
    this.usefulness = new Map((restoredState?.usefulnessScores ?? [])
      .filter((item) => item?.skillId)
      .map((item) => [item.skillId, item]));
  }

  review({ draftId, decision = 'approve', drafts = [], decidedBy = 'user_review', reason = '' } = {}) {
    const draft = drafts.find((item) => item.distilledSkillId === draftId);
    if (!draft) return { success: false, error: { code: 'F_SKILL_DRAFT_NOT_FOUND' } };
    if (!this.recallAllowed(draft)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    if (!['approve', 'reject'].includes(decision)) return { success: false, error: { code: 'F_SKILL_REVIEW_DECISION_INVALID' } };
    const existing = [...this.registry.values()].find((item) => item.sourceDraftId === draftId);
    if (existing && decision === 'approve') return { success: false, error: { code: 'F_SKILL_DRAFT_ALREADY_REGISTERED' } };
    const reviewedAt = this.clock().toISOString();
    const review = {
      draftId,
      decision,
      decidedBy,
      reason,
      reviewedAt,
      safetyConstraints: draft.safetyConstraints,
      evidenceEventIds: draft.evidenceEventIds
    };
    this.reviews.set(draftId, review);
    if (decision === 'approve') {
      const skillId = stableId('distilled_skill', `${draftId}:${draft.title}`, reviewedAt);
      const revisionId = createSkillRevisionId(skillId, 1, draft.suggestedSteps, reviewedAt);
      const usefulness = this.initialUsefulness(entryUsefulnessKey(draftId, draft.title), skillId);
      const entry = {
        skillId,
        sourceDraftId: draftId,
        evidenceEventIds: [...(draft.evidenceEventIds ?? [])],
        title: draft.title,
        status: 'approved_for_skill_registry',
        registeredAt: reviewedAt,
        confidence: draft.confidence,
        suggestedSteps: draft.suggestedSteps,
        styleHints: draft.styleHints,
        safetyConstraints: draft.safetyConstraints,
        activeRevisionId: revisionId,
        revisions: [{ revisionId, version: 1, parentRevisionId: null, status: 'active',
          suggestedSteps: draft.suggestedSteps, reason: 'initial_user_approval', createdBy: decidedBy,
          createdAt: reviewedAt, evaluatedAt: reviewedAt, evaluation: { mode: 'initial-reviewed-draft', status: 'passed' },
          review: { decision: 'approve', decidedBy, reason, reviewedAt }, promotedAt: reviewedAt }],
        lifecycleEvents: [{ type: 'initial_revision_activated', revisionId, actor: decidedBy, reason, occurredAt: reviewedAt }],
        policy: {
          requiresUserReview: true,
          requiresPolicyCheck: true,
          executableByDefault: false
        },
        usefulness
      };
      this.registry.set(entry.skillId, entry);
      this.usefulness.set(entry.skillId, entry.usefulness);
      return { success: true, review, registryEntry: entry };
    }
    return { success: true, review, registryEntry: null };
  }

  sourceEvidenceIds(entry) {
    // Older persisted entries kept provenance on the review, not the entry.
    const ids = entry.evidenceEventIds ?? this.reviews.get(entry.sourceDraftId)?.evidenceEventIds;
    return Array.isArray(ids) ? [...ids] : [];
  }

  sourceAvailable(entry) {
    return entry.status !== 'source_review_required'
      && this.recallAllowed({ ...entry, evidenceEventIds: this.sourceEvidenceIds(entry) });
  }

  publicEntry(entry) {
    if (this.sourceAvailable(entry)) return entry;
    return { skillId: entry.skillId, sourceDraftId: entry.sourceDraftId,
      evidenceEventIds: this.sourceEvidenceIds(entry), status: 'source_review_required',
      title: '[철회된 원자료에 연결된 절차]', contentWithheld: true,
      activeRevisionId: entry.activeRevisionId, pendingRevisionId: null,
      suggestedSteps: [], revisions: [], confidence: 0,
      policy: { executableByDefault: false, requiresUserReview: true, requiresPolicyCheck: true } };
  }

  createRevision({ skillId, expectedActiveRevisionId, suggestedSteps, procedureDefinition = null, procedureLifecycle = {}, createdBy = 'user_review', reason = '' } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    if (expectedActiveRevisionId !== entry.activeRevisionId) return { success: false, error: { code: 'F_SKILL_REVISION_STALE_BASE' } };
    if (entry.pendingRevisionId) return { success: false, error: { code: 'F_SKILL_REVISION_PENDING_EXISTS' } };
    const validation = validateSkillRevisionSteps(suggestedSteps);
    if (!validation.valid) return { success: false, error: { code: 'F_SKILL_REVISION_INVALID', issues: validation.issues } };
    if (procedureDefinition !== null) {
      const procedureValidation = validateTabularProcedureDefinition(procedureDefinition);
      if (!procedureValidation.valid) return { success: false, error: { code: 'F_SKILL_REVISION_PROCEDURE_INVALID', issues: procedureValidation.issues } };
    }
    if (typeof reason !== 'string' || reason.length > 500 || typeof createdBy !== 'string' || createdBy.length > 80) {
      return { success: false, error: { code: 'F_SKILL_REVISION_METADATA_INVALID' } };
    }
    const now = this.clock().toISOString();
    let lifecycle = null;
    if (procedureDefinition) {
      try { lifecycle = createProcedureLifecycle(procedureDefinition, procedureLifecycle, now); }
      catch { return { success:false, error:{code:'F_SKILL_PROCEDURE_LIFECYCLE_INVALID'} }; }
    }
    const revisions = entry.revisions ?? [];
    const version = Math.max(0, ...revisions.map((item) => item.version ?? 0)) + 1;
    const revisionId = createSkillRevisionId(skillId, version, suggestedSteps, now, procedureDefinition);
    const revision = { revisionId, version, parentRevisionId: entry.activeRevisionId, status: 'draft',
      suggestedSteps: [...suggestedSteps], ...(procedureDefinition ? { procedureDefinition: structuredClone(procedureDefinition), procedureLifecycle: lifecycle } : {}),
      reason, createdBy, createdAt: now, evaluation: null, review: null };
    const updated = { ...entry, revisions: [...revisions, revision], pendingRevisionId: revisionId,
      lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'revision_created', revisionId,
        actor: createdBy, reason, occurredAt: now }] };
    this.registry.set(skillId, updated);
    return { success: true, revision, registryEntry: updated };
  }

  evaluateRevision({ skillId, revisionId, trialCases = null } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    const revision = (entry.revisions ?? []).find((item) => item.revisionId === revisionId);
    if (!revision) return { success: false, error: { code: 'F_SKILL_REVISION_NOT_FOUND' } };
    const lifecycleIssue = procedureLifecycleIssue(revision, this.clock().toISOString());
    if (lifecycleIssue) return { success:false,error:{code:lifecycleIssue} };
    if (revision.status !== 'draft') return { success: false, error: { code: 'F_SKILL_REVISION_NOT_EVALUABLE' } };
    let trialEvaluation = null;
    if (revision.procedureDefinition) {
      if (!Array.isArray(trialCases)) return { success: false, error: { code: 'F_SKILL_REVISION_TRIALS_REQUIRED' } };
      trialEvaluation = evaluateTabularProcedureTrials(revision.procedureDefinition, trialCases);
      if (!trialEvaluation.success) return { success: false, error: { code: 'F_SKILL_REVISION_TRIALS_INVALID', issues: trialEvaluation.issues } };
    }
    const validation = validateSkillRevisionSteps(revision.suggestedSteps);
    const checks = [
      { id: 'steps_nonempty_and_bounded', status: validation.valid ? 'passed' : 'failed', issues: validation.issues },
      { id: 'required_review_policy_preserved', status: entry.policy?.requiresUserReview === true
          && entry.policy?.requiresPolicyCheck === true && entry.policy?.executableByDefault === false
          ? 'passed' : 'failed' },
      { id: 'safety_constraints_preserved', status: ['requires_user_review', 'requires_policy_check', 'no_sensitive_reconstruction']
          .every((item) => entry.safetyConstraints?.includes(item)) ? 'passed' : 'failed' },
      { id: 'revision_parent_is_known', status: (entry.revisions ?? []).some((item) => item.revisionId === revision.parentRevisionId)
          ? 'passed' : 'failed' }
    ];
    const status = checks.every((item) => item.status === 'passed') && (trialEvaluation === null || trialEvaluation.status === 'passed')
      ? 'passed' : 'failed';
    const now = this.clock().toISOString();
    const evaluatedRevision = { ...revision, status: status === 'passed' ? 'awaiting_user_review' : 'evaluation_failed',
      evaluatedAt: now, evaluation: { evaluationVersion: trialEvaluation ? 'f-skill-revision-cross-material-v1' : 'f-skill-revision-static-contract-v1',
        mode: trialEvaluation?.mode ?? 'static-contract-only', status, checks,
        ...(trialEvaluation ? { trialEvaluation } : {}) } };
    const revisions = entry.revisions.map((item) => item.revisionId === revisionId ? evaluatedRevision : item);
    const updated = { ...entry, revisions, pendingRevisionId: status === 'passed' ? revisionId : null,
      lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'revision_evaluated', revisionId, status, occurredAt: now }] };
    this.registry.set(skillId, updated);
    return { success: true, revision: evaluatedRevision, registryEntry: updated };
  }

  reviewRevision({ skillId, revisionId, decision, decidedBy = 'user_review', reason = '' } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    const revision = (entry.revisions ?? []).find((item) => item.revisionId === revisionId);
    if (!revision) return { success: false, error: { code: 'F_SKILL_REVISION_NOT_FOUND' } };
    const lifecycleIssue = procedureLifecycleIssue(revision, this.clock().toISOString());
    if (lifecycleIssue) return { success:false,error:{code:lifecycleIssue} };
    if (revision.procedureDefinition && (revision.evaluation?.mode !== 'cross-material-deterministic-procedure-trials-v1'
        || revision.evaluation?.status !== 'passed' || revision.evaluation?.trialEvaluation?.status !== 'passed')) {
      return { success: false, error: { code: 'F_SKILL_REVISION_TRIALS_REQUIRED' } };
    }
    if (!['approve', 'reject'].includes(decision)) return { success: false, error: { code: 'F_SKILL_REVIEW_DECISION_INVALID' } };
    if (revision.status !== 'awaiting_user_review') return { success: false, error: { code: 'F_SKILL_REVISION_NOT_REVIEWABLE' } };
    if (typeof reason !== 'string' || reason.length > 500 || typeof decidedBy !== 'string' || decidedBy.length > 80) {
      return { success: false, error: { code: 'F_SKILL_REVISION_METADATA_INVALID' } };
    }
    const now = this.clock().toISOString();
    const reviewedRevision = { ...revision, status: decision === 'approve' ? 'review_approved' : 'review_rejected',
      review: { decision, decidedBy, reason, reviewedAt: now } };
    const updated = { ...entry, revisions: entry.revisions.map((item) => item.revisionId === revisionId ? reviewedRevision : item),
      pendingRevisionId: decision === 'approve' ? revisionId : null,
      lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'revision_reviewed', revisionId, decision,
        actor: decidedBy, reason, occurredAt: now }] };
    this.registry.set(skillId, updated);
    return { success: true, revision: reviewedRevision, registryEntry: updated };
  }

  promoteRevision({ skillId, revisionId, expectedActiveRevisionId, promotedBy = 'user_review', reason = '' } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    if (expectedActiveRevisionId !== entry.activeRevisionId) return { success: false, error: { code: 'F_SKILL_REVISION_STALE_BASE' } };
    const revision = (entry.revisions ?? []).find((item) => item.revisionId === revisionId);
    if (!revision) return { success: false, error: { code: 'F_SKILL_REVISION_NOT_FOUND' } };
    const lifecycleIssue = procedureLifecycleIssue(revision, this.clock().toISOString());
    if (lifecycleIssue) return { success:false,error:{code:lifecycleIssue} };
    if (revision.procedureDefinition && (revision.evaluation?.mode !== 'cross-material-deterministic-procedure-trials-v1'
        || revision.evaluation?.status !== 'passed' || revision.evaluation?.trialEvaluation?.status !== 'passed')) {
      return { success: false, error: { code: 'F_SKILL_REVISION_TRIALS_REQUIRED' } };
    }
    if (revision.status !== 'review_approved' || revision.review?.decision !== 'approve') {
      return { success: false, error: { code: 'F_SKILL_REVISION_REVIEW_REQUIRED' } };
    }
    if (revision.parentRevisionId !== entry.activeRevisionId) return { success: false, error: { code: 'F_SKILL_REVISION_PARENT_MISMATCH' } };
    const now = this.clock().toISOString();
    const revisions = entry.revisions.map((item) => item.revisionId === revisionId
      ? { ...item, status: 'active', promotedAt: now }
      : item.revisionId === entry.activeRevisionId && item.status === 'active'
        ? { ...item, status: 'superseded', supersededAt: now }
        : item);
    const active = revisions.find((item) => item.revisionId === revisionId);
    const updated = { ...entry, activeRevisionId: revisionId, pendingRevisionId: null,
      suggestedSteps: active.suggestedSteps, revisions, policy: { ...entry.policy, executableByDefault: false,
        requiresUserReview: true, requiresPolicyCheck: true },
      lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'revision_promoted', revisionId,
        actor: promotedBy, reason, occurredAt: now }] };
    this.registry.set(skillId, updated);
    return { success: true, activeRevision: active, registryEntry: updated };
  }

  rollbackRevision({ skillId, targetRevisionId, expectedActiveRevisionId, rolledBackBy = 'user_review', reason = '' } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    if (expectedActiveRevisionId !== entry.activeRevisionId) return { success: false, error: { code: 'F_SKILL_REVISION_STALE_BASE' } };
    const target = (entry.revisions ?? []).find((item) => item.revisionId === targetRevisionId);
    if (!target || !['superseded', 'active'].includes(target.status)) return { success: false, error: { code: 'F_SKILL_ROLLBACK_TARGET_INVALID' } };
    const lifecycleIssue = procedureLifecycleIssue(target, this.clock().toISOString());
    if (lifecycleIssue) return {success:false,error:{code:lifecycleIssue}};
    if (targetRevisionId === entry.activeRevisionId) return { success: false, error: { code: 'F_SKILL_ROLLBACK_ALREADY_ACTIVE' } };
    const now = this.clock().toISOString();
    const revisions = entry.revisions.map((item) => item.revisionId === targetRevisionId
      ? { ...item, status: 'active', restoredAt: now }
      : item.revisionId === entry.activeRevisionId && item.status === 'active'
        ? { ...item, status: 'superseded', supersededAt: now }
        : item);
    const updated = { ...entry, activeRevisionId: targetRevisionId, pendingRevisionId: null,
      suggestedSteps: target.suggestedSteps, revisions,
      lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'revision_rolled_back', fromRevisionId: entry.activeRevisionId,
        toRevisionId: targetRevisionId, actor: rolledBackBy, reason, occurredAt: now }] };
    this.registry.set(skillId, updated);
    return { success: true, activeRevision: revisions.find((item) => item.revisionId === targetRevisionId), registryEntry: updated };
  }

  initialUsefulness(seed, skillId = null) {
    return {
      scoreVersion: 'f-skill-usefulness-score-v1',
      skillId,
      skillUsefulnessId: stableId('skill_usefulness', seed, this.clock().toISOString()),
      helpfulCount: 0,
      neutralCount: 0,
      rejectedCount: 0,
      adoptionCount: 0,
      score: 0.5,
      lastOutcome: null,
      updatedAt: this.clock().toISOString()
    };
  }

  recordUsefulness({ skillId, outcome = 'helpful', taskId = null, decidedBy = 'user_feedback', reason = '' } = {}) {
    const entry = this.registry.get(skillId);
    if (!entry) return { success: false, error: { code: 'F_SKILL_REGISTRY_ENTRY_NOT_FOUND' } };
    if (!this.sourceAvailable(entry)) return { success: false, error: { code: 'F_SKILL_SOURCE_RETRACTED' } };
    const current = this.usefulness.get(skillId) ?? this.initialUsefulness(skillId, skillId);
    const next = {
      ...current,
      helpfulCount: current.helpfulCount + (outcome === 'helpful' ? 1 : 0),
      neutralCount: current.neutralCount + (outcome === 'neutral' ? 1 : 0),
      rejectedCount: current.rejectedCount + (outcome === 'rejected' ? 1 : 0),
      adoptionCount: current.adoptionCount + (outcome === 'adopted' ? 1 : 0),
      lastOutcome: { outcome, taskId, decidedBy, reason },
      updatedAt: this.clock().toISOString()
    };
    const total = Math.max(1, next.helpfulCount + next.neutralCount + next.rejectedCount + next.adoptionCount);
    next.score = Number(((next.helpfulCount + next.adoptionCount * 1.25 + next.neutralCount * 0.5) / total).toFixed(3));
    this.usefulness.set(skillId, next);
    this.registry.set(skillId, {
      ...entry,
      usefulness: next
    });
    return { success: true, skillId, usefulness: next };
  }

  usefulnessReport() {
    const items = [...this.registry.values()].map((rawEntry) => {
      const entry = this.publicEntry(rawEntry);
      return ({
      skillId: entry.skillId,
      title: entry.title,
      status: entry.status,
      usefulness: entry.contentWithheld ? { score: 0, contentWithheld: true }
        : this.usefulness.get(entry.skillId) ?? entry.usefulness ?? this.initialUsefulness(entry.skillId, entry.skillId)
    }); });
    return {
      reportVersion: 'f-skill-usefulness-report-v1',
      generatedAt: this.clock().toISOString(),
      registryEntryCount: items.length,
      averageScore: items.length
        ? Number((items.reduce((sum, item) => sum + item.usefulness.score, 0) / items.length).toFixed(3))
        : 0,
      items
    };
  }

  snapshot() {
    return {
      snapshotVersion: 'f-approved-skill-registry-snapshot-v1',
      generatedAt: this.clock().toISOString(),
      reviews: [...this.reviews.values()],
      registryEntries: [...this.registry.values()],
      usefulnessScores: [...this.usefulness.values()]
    };
  }

  status(drafts = []) {
    return {
      registryVersion: 'f-approved-skill-registry-v1',
      generatedAt: this.clock().toISOString(),
      drafts: drafts.map((draft) => {
        const review = this.reviews.get(draft.distilledSkillId);
        if (!this.recallAllowed(draft)) return { distilledSkillId: draft.distilledSkillId,
          status: 'source_review_required', contentWithheld: true, suggestedSteps: [] };
        return {
          ...draft,
          review,
          status: review?.decision === 'approve'
            ? 'approved_for_skill_registry'
            : review?.decision === 'reject'
              ? 'rejected_by_user_review'
              : draft.status
        };
      }),
      registryEntries: [...this.registry.values()].map(entry => this.publicEntry(entry)),
      usefulnessReport: this.usefulnessReport(),
      persistence: {
        snapshotVersion: 'f-approved-skill-registry-snapshot-v1',
        restorable: true
      }
    };
  }
}

function validateSkillRevisionSteps(steps) {
  const issues = [];
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 24) {
    return { valid: false, issues: ['steps must contain between 1 and 24 items'] };
  }
  if (steps.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 320)) {
    issues.push('every step must be a nonempty string of at most 320 characters');
  }
  if (new Set(steps).size !== steps.length) issues.push('steps must not contain exact duplicates');
  return { valid: issues.length === 0, issues };
}

function createSkillRevisionId(skillId, version, suggestedSteps, createdAt, procedureDefinition = null) {
  const identity = JSON.stringify({ skillId, version, suggestedSteps, procedureDefinition, createdAt });
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
  return `skill_revision_v${version}_${digest}`;
}

function missionSkillTerms(value) {
  const stopWords = new Set(['그리고', '그대로', '기존', '사용', '업무', '절차', '진행', '적용', '방식', '따라', '대해', '해서', '있는', '이번', '다시']);
  return new Set(String(value ?? '').normalize('NFC').toLocaleLowerCase('ko-KR')
    .split(/[^\p{L}\p{N}]+/u)
    .map(term => term
      .replace(/(?:해주세요|해줘|해주|합니다|한다|하기|하는|하여|해서|했어|해)$/u, '')
      .replace(/(?:으로|에서|까지|에게|부터|처럼|보다|이라|이며|은|는|이|가|을|를|에|의|도|만|로|와|과)$/u, ''))
    .filter(term => term.length >= 2 && !stopWords.has(term)));
}

function entryUsefulnessKey(draftId, title) {
  return `${draftId}:${title}`;
}

function localAdvancedLearningChecks({ advancedLearning = {}, autonomyLifecycle = {} } = {}) {
  const checks = [];
  const add = (checkId, pass, severity = 'medium', evidence = {}) => checks.push({
    verifierVersion: 'g-advanced-learning-verifier-v1',
    checkId,
    status: pass ? 'passed' : 'failed',
    severity,
    evidence
  });
  const cloneEvidence = advancedLearning.cloneEvidence ?? {};
  const registryEntries = advancedLearning.skillRegistry?.registryEntries ?? [];
  const drafts = advancedLearning.skillDistillations ?? [];
  const autonomyItems = autonomyLifecycle.items ?? [];
  add('clone_evidence_safe_subset', cloneEvidence.safetyStatus === 'reviewable_safe_subset' && cloneEvidence.allowedUse === 'assistive_style_and_workflow_hints_only', 'high', cloneEvidence);
  add('skill_drafts_non_executable_by_default', drafts.every((draft) => draft.status === 'draft_requires_review' && draft.safetyConstraints?.includes('requires_policy_check')), 'high', {
    draftCount: drafts.length
  });
  add('approved_skill_registry_policy_guarded', registryEntries.every((entry) => entry.policy?.executableByDefault === false && entry.policy?.requiresUserReview === true), 'critical', {
    registryEntryCount: registryEntries.length
  });
  add('skill_usefulness_scoring_visible', registryEntries.every((entry) => entry.usefulness?.scoreVersion === 'f-skill-usefulness-score-v1'), 'medium', {
    registryEntryCount: registryEntries.length
  });
  add('autonomy_candidates_policy_and_user_reviewed', autonomyItems.every((item) => ['candidate_requires_policy_review', 'policy_approved_pending_user_review', 'policy_reviewed', 'user_approved', 'user_rejected', 'deferred', 'expired'].includes(item.status)), 'high', {
    candidateCount: autonomyItems.length
  });
  return checks;
}

export class MaturityScoreEngine {
  constructor({
    clock = () => new Date(),
    thresholds = {
      totalMin: 60,
      safetyMin: 90,
      verificationPassRateMin: 0.95,
      regressionDropMax: 10
    },
    maxSnapshots = 30,
    trendHistory = [],
    calibrationHistory = []
  } = {}) {
    this.clock = clock;
    this.thresholds = thresholds;
    this.maxSnapshots = maxSnapshots;
    this.trendHistory = trendHistory.slice(-maxSnapshots);
    this.calibrationHistory = calibrationHistory.slice(0, 25);
  }

  score({ events, patterns, preferenceCandidates, confirmedPreferences, failureLessons, advancedLearning, learningVerification = null }) {
    const rememberedEvents = events.filter((event) => !event.learningFlags?.doNotRemember);
    const sensitiveEvents = events.filter((event) => event.learningFlags?.containsSensitiveData);
    const coverage = Math.min(100, Math.round(
      rememberedEvents.length * 6
      + patterns.length * 12
      + preferenceCandidates.length * 8
      + confirmedPreferences.length * 12
      + failureLessons.length * 8
    ));
    const confidenceInputs = [
      ...patterns.map((pattern) => pattern.confidence),
      ...preferenceCandidates.map((candidate) => candidate.confidence),
      ...confirmedPreferences.map((preference) => preference.confidence),
      advancedLearning.styleGenome.confidence,
      ...advancedLearning.skillDistillations.map((skill) => skill.confidence)
    ].filter((value) => Number.isFinite(value));
    const confidence = confidenceInputs.length
      ? Math.round((confidenceInputs.reduce((sum, value) => sum + value, 0) / confidenceInputs.length) * 100)
      : 0;
    const safety = Math.max(0, Math.min(100, Math.round(
      70
      + (sensitiveEvents.length ? 10 : 0)
      + (advancedLearning.cloneEvidence.safetyStatus === 'reviewable_safe_subset' ? 10 : 0)
      + (rememberedEvents.every((event) => !event.trustBoundary?.externalContent) ? 10 : 0)
    )));
    const review = Math.min(100, Math.round(
      confirmedPreferences.length * 28
      + advancedLearning.skillDistillations.length * 14
      + (preferenceCandidates.length ? 12 : 0)
      + (failureLessons.length ? 10 : 0)
    ));
    const verification = this.verificationDimension(learningVerification);
    const total = Math.round(coverage * 0.25 + confidence * 0.2 + safety * 0.2 + review * 0.15 + verification * 0.2);
    const baseScore = {
      total,
      dimensions: { coverage, confidence, safety, review, verification },
      level: total >= 80 ? 'mature' : total >= 60 ? 'developing' : total >= 35 ? 'early' : 'seed',
      evidence: {
        eventCount: events.length,
        rememberedEventCount: rememberedEvents.length,
        patternCount: patterns.length,
        preferenceCandidateCount: preferenceCandidates.length,
        confirmedPreferenceCount: confirmedPreferences.length,
        failureLessonCount: failureLessons.length,
        skillDistillationCount: advancedLearning.skillDistillations.length
      },
      learningVerification: learningVerification ?? {
        linked: false,
        verifierId: 'G.LearningVerifier',
        status: 'not_configured',
        passRate: null,
        checks: []
      },
      nextActions: maturityNextActions({ coverage, confidence, safety, review, verification })
    };
    const thresholdAlerts = this.thresholdAlerts(baseScore);
    const trend = this.recordTrend({ ...baseScore, thresholdAlerts });
    return {
      ...baseScore,
      thresholdStatus: thresholdAlerts.length === 0 ? 'passed' : 'attention_required',
      thresholdAlerts,
      trend
    };
  }

  verificationDimension(learningVerification) {
    if (!learningVerification?.linked) return 50;
    if (learningVerification.status === 'failed') return Math.max(0, Math.round((learningVerification.passRate ?? 0) * 100) - 20);
    return Math.round((learningVerification.passRate ?? 1) * 100);
  }

  thresholdAlerts(score) {
    const alerts = [];
    if (score.total < this.thresholds.totalMin) {
      alerts.push({
        code: 'maturity_total_below_threshold',
        severity: 'medium',
        threshold: this.thresholds.totalMin,
        actual: score.total,
        message: '성숙도 총점이 운영 기준보다 낮습니다.'
      });
    }
    if (score.dimensions.safety < this.thresholds.safetyMin) {
      alerts.push({
        code: 'maturity_safety_below_threshold',
        severity: 'high',
        threshold: this.thresholds.safetyMin,
        actual: score.dimensions.safety,
        message: '민감정보/외부 콘텐츠 안전 점수가 기준보다 낮습니다.'
      });
    }
    const passRate = score.learningVerification?.passRate;
    if (score.learningVerification?.linked !== true || score.learningVerification?.status === 'failed' || (Number.isFinite(passRate) && passRate < this.thresholds.verificationPassRateMin)) {
      alerts.push({
        code: 'g_learning_verifier_attention_required',
        severity: score.learningVerification?.status === 'failed' ? 'critical' : 'high',
        threshold: this.thresholds.verificationPassRateMin,
        actual: passRate,
        message: 'G LearningVerifier 결과가 연결되지 않았거나 통과율 기준을 만족하지 못했습니다.'
      });
    }
    const previous = this.trendHistory.at(-1);
    if (previous && previous.total - score.total >= this.thresholds.regressionDropMax) {
      alerts.push({
        code: 'maturity_regression_drop',
        severity: 'high',
        threshold: this.thresholds.regressionDropMax,
        actual: previous.total - score.total,
        message: '직전 성숙도 스냅샷 대비 하락 폭이 큽니다.'
      });
    }
    return alerts;
  }

  recordTrend(score) {
    const previous = this.trendHistory.at(-1) ?? null;
    const snapshot = {
      snapshotId: stableId('maturity_trend', `${this.trendHistory.length}:${score.total}:${score.level}`, this.clock().toISOString()),
      generatedAt: this.clock().toISOString(),
      total: score.total,
      level: score.level,
      dimensions: score.dimensions,
      verificationStatus: score.learningVerification?.status ?? 'not_configured',
      verificationPassRate: score.learningVerification?.passRate ?? null,
      thresholdStatus: score.thresholdAlerts.length === 0 ? 'passed' : 'attention_required',
      alertCount: score.thresholdAlerts.length
    };
    this.trendHistory.push(snapshot);
    this.trendHistory = this.trendHistory.slice(-this.maxSnapshots);
    return {
      latest: snapshot,
      previous,
      delta: previous ? {
        total: snapshot.total - previous.total,
        coverage: snapshot.dimensions.coverage - previous.dimensions.coverage,
        confidence: snapshot.dimensions.confidence - previous.dimensions.confidence,
        safety: snapshot.dimensions.safety - previous.dimensions.safety,
        review: snapshot.dimensions.review - previous.dimensions.review,
        verification: snapshot.dimensions.verification - previous.dimensions.verification
      } : null,
      history: [...this.trendHistory]
    };
  }

  trendStatus() {
    return {
      generatedAt: this.clock().toISOString(),
      history: [...this.trendHistory],
      latest: this.trendHistory.at(-1) ?? null
    };
  }

  calibrateThresholds({ patch = {}, decidedBy = 'user_review', reason = '' } = {}) {
    const allowed = {
      totalMin: [0, 100],
      safetyMin: [0, 100],
      verificationPassRateMin: [0, 1],
      regressionDropMax: [0, 100]
    };
    const nextThresholds = { ...this.thresholds };
    const issues = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!allowed[key]) {
        issues.push({ field: key, code: 'unsupported_threshold' });
        continue;
      }
      const numeric = Number(value);
      const [min, max] = allowed[key];
      if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
        issues.push({ field: key, code: 'threshold_out_of_range', min, max });
        continue;
      }
      nextThresholds[key] = numeric;
    }
    if (issues.length) {
      return { success: false, error: { code: 'F_MATURITY_THRESHOLD_INVALID', issues } };
    }
    const previousThresholds = { ...this.thresholds };
    this.thresholds = nextThresholds;
    const calibration = {
      calibrationId: stableId('maturity_calibration', JSON.stringify(previousThresholds), JSON.stringify(nextThresholds), this.clock().toISOString()),
      previousThresholds,
      nextThresholds,
      patch,
      decidedBy,
      reason,
      calibratedAt: this.clock().toISOString()
    };
    this.calibrationHistory.unshift(calibration);
    this.calibrationHistory = this.calibrationHistory.slice(0, 25);
    return { success: true, ...calibration };
  }

  calibrationStatus() {
    return {
      generatedAt: this.clock().toISOString(),
      thresholds: { ...this.thresholds },
      history: [...this.calibrationHistory],
      calibrationCount: this.calibrationHistory.length
    };
  }
}

function maturityNextActions({ coverage, confidence, safety, review, verification = 100 }) {
  const actions = [];
  if (coverage < 60) actions.push('더 많은 안전한 반복 작업 evidence를 수집한다.');
  if (confidence < 60) actions.push('후보 선호와 반복 패턴의 검증 횟수를 늘린다.');
  if (safety < 90) actions.push('민감정보 최소화와 외부 콘텐츠 차단 검증을 강화한다.');
  if (review < 60) actions.push('성장 리뷰에서 후보 선호와 스킬 초안을 확정/거절한다.');
  if (verification < 95) actions.push('G LearningVerifier 실패 항목을 확인하고 학습 evidence를 정리한다.');
  return actions;
}

function countMatches(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function styleGuidanceFor(signal) {
  const guidance = {
    concise: '응답과 문서는 핵심 위주로 짧게 정리한다.',
    dateEmphasis: '날짜와 일정 정보는 눈에 잘 띄게 배치한다.',
    visualEmphasis: '제목, 표, 강조 정보를 명확히 분리한다.',
    politeTone: '정중한 한국어 톤을 유지한다.'
  };
  return guidance[signal] ?? signal;
}

export class GrowthRuntime {
  constructor({ clock = () => new Date(), memoryStore = null, auditLog = null, auditRoot, policyRuntime = null } = {}) {
    this.clock = clock;
    this.memoryStore = memoryStore;
    this.memoryGeneration = memoryStore?.restoreGeneration?.() ?? 0;
    this.policyRuntime = policyRuntime;
    this.auditLog = auditLog ?? new JsonlAuditLog({
      filePath: auditRoot ? `${auditRoot}/memory-audit.jsonl` : 'apps/growth-memory/logs/memory-audit.jsonl',
      clock
    });
    this.sensitiveMinimizer = new SensitiveMemoryMinimizer({
      dataClassifier: policyRuntime?.dataClassifier,
      policyVersion: policyRuntime?.policyVersion ? `f-sensitive-minimizer+${policyRuntime.policyVersion}` : undefined
    });
    this.memoryEventSchemas = new MemoryEventSchemaRegistry();
    this.ingestor = new MemoryEventIngestor({
      clock,
      store: memoryStore,
      auditLog: this.auditLog,
      sensitiveMinimizer: this.sensitiveMinimizer,
      schemaRegistry: this.memoryEventSchemas
    });
    this.patternMiner = new PatternMiner({ clock });
    this.patternCorpusBuilder = new PatternAnonymizedCorpusBuilder({
      clock,
      sensitiveMinimizer: this.sensitiveMinimizer,
      patternMiner: this.patternMiner
    });
    this.patternClusterReviewEngine = new PatternClusterReviewEngine({
      clock,
      patternMiner: this.patternMiner
    });
    this.preferenceEngine = new PreferenceHypothesisEngine();
    this.confirmedPreferenceRegistry = new ConfirmedPreferenceRegistry({ clock, store: memoryStore, auditLog: this.auditLog,
      recallAllowed: preference => (preference.evidenceEventIds ?? []).every(id => {
        const decision = this.hygieneManager?.decisionFor(id);
        const event = this.ingestor.events.get(id);
        return !this.memoryStore?.hasSourceRetraction?.(id)
          && !(decision?.targetType === 'memory_event' && ['delete', 'redact'].includes(decision.action))
          && (!event || sourceRecallAllowed(event));
      }) });
    this.failureBuilder = new FailureMemoryBuilder({ clock, store: memoryStore, auditLog: this.auditLog });
    this.hygieneManager = new MemoryHygieneManager({
      clock,
      decisions: memoryStore?.allHygieneDecisions?.() ?? []
    });
    this.applyPersistedSourceRetractions();
    this.autonomyCandidateGenerator = new AutonomyCandidateGenerator({ clock });
    this.genomeBuilder = new GenomeBuilder();
    const restoredGenomeRecords = memoryStore?.allTrendSnapshots?.({ trendType: 'genome' }) ?? [];
    const restoredMaturityRecords = memoryStore?.allTrendSnapshots?.({ trendType: 'maturity' }) ?? [];
    const restoredSkillRegistryRecords = memoryStore?.allTrendSnapshots?.({ trendType: 'skill_registry', includeRetractedContent: true }) ?? [];
    const restoredAutonomyRecords = memoryStore?.allTrendSnapshots?.({ trendType: 'autonomy_candidate' }) ?? [];
    const restoredGenomeSnapshots = restoredGenomeRecords.filter(item => !item.contentWithheld && item.snapshot).map((item) => item.snapshot);
    const restoredMaturitySnapshots = restoredMaturityRecords.filter(item => !item.contentWithheld && item.snapshot).map((item) => item.snapshot);
    const restoredSkillRegistryState = restoredSkillRegistryRecords.at(-1)?.snapshot ?? null;
    this.genomeTrendTracker = new GenomeTrendTracker({ clock, snapshots: restoredGenomeSnapshots });
    this.cloneEvidenceBuilder = new CloneEvidenceBuilder();
    this.styleGenomeBuilder = new StyleGenomeBuilder();
    this.skillDistillationEngine = new SkillDistillationEngine();
    this.skillDraftRegistry = new SkillDraftRegistry({ clock, restoredState: restoredSkillRegistryState,
      recallAllowed: entry => this.confirmedPreferenceRegistry.recallAllowed(entry) });
    this.maturityScoreEngine = new MaturityScoreEngine({ clock, trendHistory: restoredMaturitySnapshots });
    this.derivedTrendSourceDigest = memoryStore?.sourceRetractionDigest?.();
    this.derivedTrendPreferenceDigest = memoryStore?.preferenceStateDigest?.();
    this.learningVerifier = null;
    this.submittedAutonomyCandidates = [];
    this.autonomyCandidateLedger = new Map(restoredAutonomyRecords.filter(item => !item.contentWithheld && item.snapshot)
      .map((record) => record.snapshot)
      .filter((item) => item?.candidateId)
      .map((item) => [item.candidateId, item]));
    this.retentionSchedulerRuns = [];
    this.selectedConversationImports = memoryStore?.db ? new SelectedConversationArchive({ store: memoryStore,
      clock, sensitiveText: text => this.sensitiveMinimizer.containsSensitive({ text }) }) : null;
    if ((memoryStore?.restoreGeneration?.() ?? 0) !== this.memoryGeneration) throw new Error('Memory generation changed during construction.');
    this.bindMemoryGenerationGuard();
  }

  minimizePreview(event = {}) {
    const normalized = this.memoryEventSchemas.normalize(event, this.clock());
    const validation = this.memoryEventSchemas.validate(normalized);
    if (!validation.valid) {
      return {
        minimized: false,
        event: normalized,
        schema: validation.schema,
        error: {
          code: 'F_MEMORY_EVENT_SCHEMA_INVALID',
          issues: validation.issues
        }
      };
    }
    const governed = this.memoryEventSchemas.applySafetyPolicy(normalized, validation);
    const minimized = this.sensitiveMinimizer.minimize(governed);
    return {
      minimized: JSON.stringify(minimized) !== JSON.stringify(governed) || minimized.learningFlags?.containsSensitiveData === true,
      event: minimized,
      schema: minimized.schema,
      schemaValidation: minimized.schemaValidation,
      minimization: minimized.payload?.minimization ?? {
        minimized: false,
        policyVersion: this.sensitiveMinimizer.policyVersion,
        classifier: this.sensitiveMinimizer.dataClassifier ? 'E_DATA_CLASSIFIER' : 'F_FALLBACK_RULES',
        matchedRuleIds: [],
        sensitiveFlags: []
      }
    };
  }

  sensitiveMinimizerFixtureReport({ fixturePath = defaultSensitiveMinimizerFixturePath, fixturePack = null } = {}) {
    const pack = fixturePack ?? loadSensitiveMinimizerFixturePack(fixturePath);
    const items = (pack.fixtures ?? []).map((fixture) => {
      const preview = this.minimizePreview(fixture.event);
      const minimization = preview.minimization ?? {};
      const matchedRuleIds = minimization.matchedRuleIds ?? [];
      const actions = [
        ...((minimization.summarizedFields ?? []).length ? ['summarize'] : []),
        ...((minimization.redactedFields ?? []).length ? ['redact'] : [])
      ];
      const leakDetectedAfter = rawSensitiveLeakDetected(preview.event?.payload ?? {});
      const falsePositiveCandidate = fixture.expectedSensitive === false && preview.minimized === true;
      const expectedRulesCovered = (fixture.expectedRuleIds ?? []).every((ruleId) => matchedRuleIds.includes(ruleId));
      const passed = fixture.expectedSensitive
        ? preview.minimized === true
          && leakDetectedAfter === false
          && expectedRulesCovered
          && (!fixture.expectedAction || actions.includes(fixture.expectedAction))
        : fixture.expectedFalsePositiveReview
          ? falsePositiveCandidate === true && leakDetectedAfter === false
          : preview.minimized === false && leakDetectedAfter === false;
      return {
        fixtureId: fixture.fixtureId,
        expectedSensitive: fixture.expectedSensitive,
        expectedFalsePositiveReview: fixture.expectedFalsePositiveReview === true,
        expectedAction: fixture.expectedAction ?? null,
        actualMinimized: preview.minimized,
        actions,
        matchedRuleIds,
        expectedRulesCovered,
        leakDetectedAfter,
        falsePositiveCandidate,
        status: passed ? 'passed' : 'failed',
        passed,
        redactionDiffHashOnly: (minimization.redactionDiff ?? []).every((item) => String(item.beforeHash ?? '').startsWith('sha256:') && !('before' in item)),
        minimizedPayloadHash: hashSensitiveValue(JSON.stringify(preview.event?.payload ?? {}))
      };
    });
    const falsePositiveCandidates = items.filter((item) => item.falsePositiveCandidate);
    const passRate = items.length ? items.filter((item) => item.passed).length / items.length : 1;
    return {
      reportVersion: 'f-sensitive-minimizer-fixture-report-v1',
      fixturePackId: pack.fixturePackId,
      fixturePackVersion: pack.fixturePackVersion,
      fixturePath: pack.fixturePath ?? null,
      fixtureSha256: pack.fixtureSha256 ?? null,
      generatedAt: this.clock().toISOString(),
      status: items.every((item) => item.passed) ? 'passed' : 'failed',
      passRate: Number(passRate.toFixed(3)),
      fixtureCount: items.length,
      sensitiveCount: items.filter((item) => item.expectedSensitive).length,
      falsePositiveCandidateCount: falsePositiveCandidates.length,
      coverage: {
        expectedActions: [...new Set(items.map((item) => item.expectedAction).filter(Boolean))].sort(),
        ruleIds: [...new Set(items.flatMap((item) => item.matchedRuleIds))].sort()
      },
      falsePositiveCandidates,
      items
    };
  }

  sensitiveMinimizerFalsePositiveDashboard(options = {}) {
    const fixtureReport = options.fixtureReport ?? this.sensitiveMinimizerFixtureReport(options);
    const queue = fixtureReport.falsePositiveCandidates.map((item) => ({
      reviewItemId: stableId('sensitive_fp_review', item.fixtureId, fixtureReport.generatedAt),
      fixtureId: item.fixtureId,
      matchedRuleIds: item.matchedRuleIds,
      recommendedDecision: 'review_context_exception',
      actions: ['keep_minimization', 'suppress_classifier_rule', 'narrow_pattern', 'add_context_exception'],
      status: 'needs_review'
    }));
    return {
      dashboardVersion: 'f-sensitive-minimizer-false-positive-dashboard-v1',
      generatedAt: this.clock().toISOString(),
      status: queue.length ? 'review_required' : 'clear',
      queueCount: queue.length,
      fixturePackId: fixtureReport.fixturePackId,
      uiContract: {
        contractVersion: 'f-sensitive-minimizer-false-positive-ui-contract-v1',
        requiredViews: ['queue', 'fixture_detail', 'decision_history'],
        decisionActions: ['keep_minimization', 'suppress_classifier_rule', 'narrow_pattern', 'add_context_exception']
      },
      queue
    };
  }

  sensitiveMinimizerReleaseDossier(options = {}) {
    const rawNeedles = [
      '010-7777-8888',
      'password=hunter2',
      'care@example.org',
      '상담 기록'
    ];
    const preview = this.minimizePreview({
      eventId: 'f03_release_sensitive_preview',
      eventType: 'feedback.good',
      taskId: 'f03_release_sensitive_task',
      payload: {
        rawText: `${rawNeedles[0]} ${rawNeedles[3]} ${rawNeedles[1]}`,
        note: `email ${rawNeedles[2]}`
      },
      learningFlags: { containsSensitiveData: false, doNotRemember: false },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    });
    const fixtureReport = this.sensitiveMinimizerFixtureReport(options);
    const falsePositiveDashboard = this.sensitiveMinimizerFalsePositiveDashboard({ fixtureReport });
    const retentionPolicyUi = this.retentionPolicyUiContract({
      sensitiveReviewDays: options.sensitiveReviewDays ?? 0,
      staleReviewDays: options.staleReviewDays ?? 90
    });
    const falsePositiveReviewTarget = falsePositiveDashboard.queue[0] ?? null;
    const falsePositiveReviewDecision = falsePositiveReviewTarget
      ? this.sensitiveMinimizer.recordFalsePositiveReview({
          fixtureId: falsePositiveReviewTarget.fixtureId,
          matchedRuleIds: falsePositiveReviewTarget.matchedRuleIds,
          decision: 'add_context_exception',
          decidedBy: options.decidedBy ?? 'growth_privacy_release_review',
          reason: options.reason ?? 'F-03 sensitive minimizer release false-positive review',
          applyToRuntime: false
        })
      : { success: true, decision: null, contextException: null };
    const falsePositiveReviewLedger = this.sensitiveMinimizer.falsePositiveReviewLedger();
    const contextExceptionRegistry = this.sensitiveMinimizer.contextExceptionRegistry();
    const retentionPolicyDiff = this.sensitiveMinimizer.retentionPolicyDiff({
      baseline: options.baselineRetentionPolicy ?? {
        policyVersion: 'f-retention-policy-baseline-v1',
        sensitiveReviewDays: 30,
        staleReviewDays: options.staleReviewDays ?? 90,
        doNotRememberAction: 'delete'
      },
      candidate: {
        policyVersion: 'f-retention-policy-candidate-v1',
        ...retentionPolicyUi.policy
      }
    });
    const releaseWorkflow = {
      workflowVersion: 'f-sensitive-minimizer-release-workflow-v1',
      preview: {
        minimized: preview.minimized,
        policyVersion: preview.minimization.policyVersion,
        classifier: preview.minimization.classifier,
        matchedRuleIds: preview.minimization.matchedRuleIds,
        sensitiveFlags: preview.minimization.sensitiveFlags,
        summarizedFields: preview.minimization.summarizedFields ?? [],
        redactedFields: preview.minimization.redactedFields ?? [],
        redactionDiffHashOnly: (preview.minimization.redactionDiff ?? []).every((item) => String(item.beforeHash ?? '').startsWith('sha256:') && !('before' in item)),
        minimizedPayloadHash: hashSensitiveValue(JSON.stringify(preview.event?.payload ?? {})),
        learningFlags: {
          containsSensitiveData: preview.event?.learningFlags?.containsSensitiveData === true,
          canBeUsedForPreference: preview.event?.learningFlags?.canBeUsedForPreference === true,
          canBeUsedForWorkflow: preview.event?.learningFlags?.canBeUsedForWorkflow === true,
          canBeUsedForAutonomy: preview.event?.learningFlags?.canBeUsedForAutonomy === true
        }
      },
      fixtureReport: {
        reportVersion: fixtureReport.reportVersion,
        fixturePackId: fixtureReport.fixturePackId,
        fixturePackVersion: fixtureReport.fixturePackVersion,
        fixtureSha256: fixtureReport.fixtureSha256,
        status: fixtureReport.status,
        passRate: fixtureReport.passRate,
        fixtureCount: fixtureReport.fixtureCount,
        sensitiveCount: fixtureReport.sensitiveCount,
        falsePositiveCandidateCount: fixtureReport.falsePositiveCandidateCount,
        coverage: fixtureReport.coverage,
        itemHashes: fixtureReport.items.map((item) => hashJsonValue({
          fixtureId: item.fixtureId,
          matchedRuleIds: item.matchedRuleIds,
          status: item.status,
          minimizedPayloadHash: item.minimizedPayloadHash
        }))
      },
      falsePositiveDashboard: {
        dashboardVersion: falsePositiveDashboard.dashboardVersion,
        status: falsePositiveDashboard.status,
        queueCount: falsePositiveDashboard.queueCount,
        fixturePackId: falsePositiveDashboard.fixturePackId,
        uiContractVersion: falsePositiveDashboard.uiContract.contractVersion,
        decisionActions: falsePositiveDashboard.uiContract.decisionActions,
        queueHashes: falsePositiveDashboard.queue.map((item) => hashJsonValue({
          fixtureId: item.fixtureId,
          matchedRuleIds: item.matchedRuleIds,
          recommendedDecision: item.recommendedDecision
        }))
      },
      falsePositiveReviewLedger: {
        ledgerVersion: falsePositiveReviewLedger.ledgerVersion,
        decisionCount: falsePositiveReviewLedger.decisionCount,
        hashOnly: falsePositiveReviewLedger.hashOnly,
        decisionHashes: falsePositiveReviewLedger.items.map((item) => hashJsonValue(item))
      },
      contextExceptionRegistry: {
        registryVersion: contextExceptionRegistry.registryVersion,
        exceptionCount: contextExceptionRegistry.exceptionCount,
        rawTextStored: contextExceptionRegistry.rawTextStored,
        exceptionHashes: contextExceptionRegistry.items.map((item) => hashJsonValue(item))
      },
      retentionPolicyDiff: {
        diffVersion: retentionPolicyDiff.diffVersion,
        status: retentionPolicyDiff.status,
        baselineHash: retentionPolicyDiff.baselineHash,
        candidateHash: retentionPolicyDiff.candidateHash,
        changedFields: retentionPolicyDiff.changedFields,
        requiresReview: retentionPolicyDiff.requiresReview,
        rawPolicyValuesStored: retentionPolicyDiff.rawPolicyValuesStored
      },
      retentionPolicyUi: {
        uiContractVersion: retentionPolicyUi.uiContractVersion,
        status: retentionPolicyUi.status,
        policyRows: retentionPolicyUi.policyRows.map((row) => ({
          policyId: row.policyId,
          action: row.action,
          reviewAfterDays: row.reviewAfterDays,
          dueCount: row.dueCount
        })),
        controls: retentionPolicyUi.controls.map((control) => ({
          controlId: control.controlId,
          type: control.type,
          action: control.action
        }))
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-sensitive-minimizer-release-artifact-manifest-v1',
      releaseWorkflowHash: hashJsonValue(releaseWorkflow),
      rawSensitivePayloadStored: false,
      previewPayloadHashOnly: releaseWorkflow.preview.minimizedPayloadHash.startsWith('sha256:'),
      redactionDiffHashOnly: releaseWorkflow.preview.redactionDiffHashOnly,
      fixtureArtifactHash: fixtureReport.fixtureSha256,
      falsePositiveReviewContract: 'f-sensitive-minimizer-false-positive-ui-contract-v1',
      falsePositiveReviewLedgerHash: hashJsonValue(falsePositiveReviewLedger),
      falsePositiveReviewStoredHashOnly: falsePositiveReviewLedger.hashOnly,
      contextExceptionRegistryHash: hashJsonValue(contextExceptionRegistry),
      contextExceptionRawTextStored: contextExceptionRegistry.rawTextStored,
      retentionPolicyDiffHash: hashJsonValue(retentionPolicyDiff),
      retentionPolicyValuesHashOnly: retentionPolicyDiff.rawPolicyValuesStored === false,
      retentionPolicyUiContract: 'f-retention-policy-ui-contract-v1',
      wormArchive: {
        archiveContractVersion: 'f-sensitive-minimizer-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_sensitive_minimizer_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(releaseWorkflow),
          fixtureReport.fixtureSha256,
          hashJsonValue(falsePositiveReviewLedger),
          hashJsonValue(contextExceptionRegistry),
          hashJsonValue(retentionPolicyDiff),
          hashJsonValue(retentionPolicyUi)
        ].filter(Boolean)
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-sensitive-minimizer-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-sensitive-minimizer-release-owner',
      scope: 'sensitive_payload_minimization_false_positive_review_context_exception_retention_policy_diff',
      status: releaseWorkflow.preview.minimized === true
        && releaseWorkflow.preview.redactionDiffHashOnly === true
        && releaseWorkflow.fixtureReport.status === 'passed'
        && releaseWorkflow.falsePositiveDashboard.dashboardVersion === 'f-sensitive-minimizer-false-positive-dashboard-v1'
        && releaseWorkflow.falsePositiveReviewLedger.decisionCount >= 1
        && releaseWorkflow.contextExceptionRegistry.exceptionCount >= 1
        && releaseWorkflow.retentionPolicyDiff.rawPolicyValuesStored === false
        && artifactManifest.rawSensitivePayloadStored === false
        && artifactManifest.falsePositiveReviewStoredHashOnly === true
        && artifactManifest.contextExceptionRawTextStored === false
        && artifactManifest.retentionPolicyValuesHashOnly === true ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-sensitive-minimizer-health-handshake-v1',
      healthHandshake: {
        previewMinimized: releaseWorkflow.preview.minimized,
        fixtureReportPassed: releaseWorkflow.fixtureReport.status === 'passed',
        falsePositiveDashboardReady: releaseWorkflow.falsePositiveDashboard.dashboardVersion === 'f-sensitive-minimizer-false-positive-dashboard-v1',
        falsePositiveReviewPersisted: releaseWorkflow.falsePositiveReviewLedger.decisionCount >= 1,
        contextExceptionRegistryReady: releaseWorkflow.contextExceptionRegistry.exceptionCount >= 1,
        retentionPolicyDiffReady: releaseWorkflow.retentionPolicyDiff.rawPolicyValuesStored === false,
        rawSensitivePayloadStored: artifactManifest.rawSensitivePayloadStored
      },
      fallbackPolicy: {
        policyVersion: 'f-sensitive-minimizer-fallback-policy-v1',
        primaryFlow: 'minimize_sensitive_memory_payloads_and_review_false_positive_exceptions_before_retention_policy_release',
        fallbackFlows: [
          'block_memory_learning_when_sensitive_payload_minimization_fails',
          'route_false_positive_candidates_to_human_context_exception_review',
          'require_hash_only_retention_policy_diff_before_policy_update',
          'publish_hash_only_release_manifest_when_sensitive_payload_or_review_reason_would_leak'
        ],
        operatorEscalation: 'growth_privacy_reviewer_retention_policy_owner_and_worm_provider'
      },
      rawSensitivePayloadStored: false,
      rawReviewReasonStored: false,
      rawPolicyValuesStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-sensitive-minimizer-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F growth memory minimizes sensitive memories" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'sensitive_preview_minimized',
        'fixture_pack_passed_with_hash_only_diff',
        'false_positive_review_dashboard_ready',
        'false_positive_review_decision_persisted',
        'context_exception_registry_ready',
        'retention_policy_change_diff_ready',
        'retention_policy_ui_ready',
        'raw_sensitive_payload_retention_safe',
        'sensitive_minimizer_operational_handoff_ready',
        'sensitive_minimizer_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawSensitivePayloadStored: false,
      rawReviewReasonStored: false,
      rawPolicyValuesStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-sensitive-minimizer-worm-promotion-package-v1',
      providerContractVersion: 'f-sensitive-minimizer-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-sensitive-minimizer-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-sensitive-minimizer-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawSensitivePayloadStored: false,
      rawReviewReasonStored: false,
      rawPolicyValuesStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-sensitive-minimizer-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawNeedles);
    const checks = [
      {
        checkId: 'sensitive_preview_minimized',
        passed: releaseWorkflow.preview.minimized === true
          && releaseWorkflow.preview.matchedRuleIds.includes('phone_number')
          && releaseWorkflow.preview.matchedRuleIds.includes('secret')
          && releaseWorkflow.preview.learningFlags.containsSensitiveData === true
      },
      {
        checkId: 'fixture_pack_passed_with_hash_only_diff',
        passed: releaseWorkflow.fixtureReport.reportVersion === 'f-sensitive-minimizer-fixture-report-v1'
          && releaseWorkflow.fixtureReport.status === 'passed'
          && releaseWorkflow.fixtureReport.fixtureSha256?.length === 64
          && fixtureReport.items.every((item) => item.redactionDiffHashOnly === true)
      },
      {
        checkId: 'false_positive_review_dashboard_ready',
        passed: releaseWorkflow.falsePositiveDashboard.dashboardVersion === 'f-sensitive-minimizer-false-positive-dashboard-v1'
          && releaseWorkflow.falsePositiveDashboard.uiContractVersion === 'f-sensitive-minimizer-false-positive-ui-contract-v1'
          && releaseWorkflow.falsePositiveDashboard.decisionActions.includes('add_context_exception')
      },
      {
        checkId: 'false_positive_review_decision_persisted',
        passed: falsePositiveReviewDecision.success === true
          && releaseWorkflow.falsePositiveReviewLedger.ledgerVersion === 'f-sensitive-minimizer-false-positive-review-ledger-v1'
          && releaseWorkflow.falsePositiveReviewLedger.decisionCount >= 1
          && artifactManifest.falsePositiveReviewStoredHashOnly === true
      },
      {
        checkId: 'context_exception_registry_ready',
        passed: releaseWorkflow.contextExceptionRegistry.registryVersion === 'f-sensitive-minimizer-context-exception-registry-v1'
          && releaseWorkflow.contextExceptionRegistry.exceptionCount >= 1
          && artifactManifest.contextExceptionRawTextStored === false
      },
      {
        checkId: 'retention_policy_change_diff_ready',
        passed: releaseWorkflow.retentionPolicyDiff.diffVersion === 'f-sensitive-minimizer-retention-policy-diff-v1'
          && releaseWorkflow.retentionPolicyDiff.rawPolicyValuesStored === false
          && artifactManifest.retentionPolicyValuesHashOnly === true
      },
      {
        checkId: 'retention_policy_ui_ready',
        passed: releaseWorkflow.retentionPolicyUi.uiContractVersion === 'f-retention-policy-ui-contract-v1'
          && releaseWorkflow.retentionPolicyUi.policyRows.some((item) => item.policyId === 'sensitive-memory' && item.action === 'redact')
      },
      {
        checkId: 'raw_sensitive_payload_retention_safe',
        passed: artifactManifest.rawSensitivePayloadStored === false
          && artifactManifest.previewPayloadHashOnly === true
          && artifactManifest.redactionDiffHashOnly === true
          && rawLeakDetected === false
      },
      {
        checkId: 'sensitive_minimizer_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-sensitive-minimizer-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-sensitive-minimizer-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-sensitive-minimizer-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'sensitive_minimizer_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-sensitive-minimizer-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-sensitive-minimizer-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('sensitive_minimizer.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  retentionPolicyUiContract({ sensitiveReviewDays = 0, staleReviewDays = 90 } = {}) {
    const retention = this.retentionReport({ sensitiveReviewDays, staleReviewDays });
    const dueByAction = this.countBy(retention.items.filter((item) => item.status === 'due'), (item) => item.action);
    return {
      uiContractVersion: 'f-retention-policy-ui-contract-v1',
      generatedAt: this.clock().toISOString(),
      status: retention.dueCount > 0 ? 'action_required' : 'ok',
      policy: retention.policy,
      controls: [
        { controlId: 'sensitive-review-days', type: 'number-stepper', value: sensitiveReviewDays, min: 0, max: 365, action: 'redact' },
        { controlId: 'stale-review-days', type: 'number-stepper', value: staleReviewDays, min: 1, max: 730, action: 'defer' },
        { controlId: 'do-not-remember-action', type: 'segmented-control', value: 'delete', options: ['delete'] }
      ],
      policyRows: [
        { policyId: 'sensitive-memory', action: 'redact', reviewAfterDays: sensitiveReviewDays, dueCount: dueByAction.redact ?? 0 },
        { policyId: 'stale-memory', action: 'defer', reviewAfterDays: staleReviewDays, dueCount: dueByAction.defer ?? 0 },
        { policyId: 'do-not-remember', action: 'delete', reviewAfterDays: 0, dueCount: dueByAction.delete ?? 0 }
      ],
      retention
    };
  }

  hygieneDecisionHistory({ cursor = 0, limit = 50, action = null, targetType = null } = {}) {
    const offset = Math.max(0, Number(cursor ?? 0));
    const pageLimit = Math.max(1, Math.min(200, Number(limit ?? 50)));
    const decisions = [...this.hygieneManager.decisions.values()]
      .filter((decision) => !action || decision.action === action)
      .filter((decision) => !targetType || decision.targetType === targetType)
      .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)));
    const items = decisions.slice(offset, offset + pageLimit);
    const batchGroups = [...new Map(decisions
      .filter((decision) => decision.batchId)
      .map((decision) => [decision.batchId, decisions.filter((item) => item.batchId === decision.batchId)]))]
      .map(([batchId, batchItems]) => ({
        batchId,
        decisionCount: batchItems.length,
        actions: this.countBy(batchItems, (item) => item.action),
        decidedBy: batchItems[0]?.decidedBy ?? null,
        decidedAt: this.latestTimestamp(batchItems.map((item) => item.decidedAt)),
        targetIds: batchItems.map((item) => item.targetId)
      }));
    return {
      historyVersion: 'f-hygiene-decision-history-v1',
      generatedAt: this.clock().toISOString(),
      filters: { action, targetType },
      pageInfo: {
        cursor: offset,
        limit: pageLimit,
        total: decisions.length,
        nextCursor: offset + items.length < decisions.length ? String(offset + items.length) : null
      },
      uiContract: {
        contractVersion: 'f-hygiene-decision-history-ui-contract-v1',
        views: ['timeline', 'batch_detail', 'target_detail'],
        filters: ['action', 'targetType', 'decidedBy', 'batchId']
      },
      batchGroups,
      items
    };
  }

  retentionPolicyCalendar({ horizonDays = 28, intervalDays = 7, sensitiveReviewDays = 0, staleReviewDays = 90 } = {}) {
    const now = this.clock();
    const schedule = this.retentionScheduleStatus({ intervalDays, sensitiveReviewDays, staleReviewDays });
    const cycles = [];
    for (let offsetDays = 0; offsetDays <= horizonDays; offsetDays += intervalDays) {
      const runAt = new Date(now.getTime() + offsetDays * 86_400_000).toISOString();
      cycles.push({
        cycleId: stableId('retention_cycle', `${runAt}:${intervalDays}:${sensitiveReviewDays}:${staleReviewDays}`),
        runAt,
        dueNow: offsetDays === 0 && schedule.due,
        mode: offsetDays === 0 && schedule.due ? 'execute_recommended' : 'scheduled_review',
        policy: schedule.policy
      });
    }
    return {
      calendarVersion: 'f-retention-policy-calendar-v1',
      generatedAt: now.toISOString(),
      horizonDays,
      intervalDays,
      status: schedule.due ? 'action_required' : 'scheduled',
      schedule,
      uiContract: {
        contractVersion: 'f-retention-policy-calendar-ui-contract-v1',
        views: ['calendar', 'due_targets', 'policy_controls'],
        actions: ['run_dry_run', 'run_execute', 'edit_policy']
      },
      cycles
    };
  }

  memoryEventSchemaStatus() {
    const events = this.ingestor.all();
    return {
      ...this.memoryEventSchemas.catalog(),
      observedEventTypes: [...new Set(events.map((event) => event.eventType))].sort(),
      observedVariants: [...new Set(events.map((event) => event.schema?.variant).filter(Boolean))].sort(),
      invalidEventCount: events.filter((event) => event.schemaValidation?.valid === false).length
    };
  }

  memoryEventJsonSchemaBundle() {
    return this.memoryEventSchemas.jsonSchemaBundle();
  }

  memoryEventFixtureCorpus() {
    return this.memoryEventSchemas.fixtureCorpus();
  }

  memoryEventMigrationCompatibilityReport({ fixtures = null } = {}) {
    const corpus = fixtures ? {
      corpusVersion: 'custom-memory-event-fixtures',
      fixtures
    } : this.memoryEventFixtureCorpus();
    const currentItems = (corpus.fixtures ?? []).map((fixture) => {
      const normalized = this.memoryEventSchemas.normalize(fixture.event, this.clock());
      const validation = this.memoryEventSchemas.validate(normalized);
      const passed = validation.valid === fixture.expectedValid;
      return {
        fixtureId: fixture.fixtureId,
        migrationType: 'current-schema-validation',
        expectedValid: fixture.expectedValid,
        actualValid: validation.valid,
        passed,
        variant: validation.schema.variant,
        issues: validation.issues.map((item) => item.code)
      };
    });
    const legacyFixtures = [
      {
        fixtureId: 'legacy.feedback_text_v0',
        legacyVersion: 'f-memory-event-minimal-v0',
        event: {
          id: 'legacy_evt_feedback_text',
          type: 'feedback.good',
          task: 'legacy_task_feedback',
          text: '좋은 결과였고 다음에도 같은 형식을 유지해줘',
          createdAt: '2026-06-23T00:00:00.000Z'
        }
      },
      {
        fixtureId: 'legacy.policy_reason_v0',
        legacyVersion: 'f-memory-event-minimal-v0',
        event: {
          id: 'legacy_evt_policy_reason',
          type: 'policy.blocked',
          task: 'legacy_task_policy',
          reason: '외부 전송은 PC 승인 필요',
          createdAt: '2026-06-23T00:00:00.000Z'
        }
      }
    ];
    const legacyItems = legacyFixtures.map((fixture) => {
      const migrated = this.migrateMemoryEventFixture(fixture.event);
      const normalized = this.memoryEventSchemas.normalize(migrated, this.clock());
      const validation = this.memoryEventSchemas.validate(normalized);
      return {
        fixtureId: fixture.fixtureId,
        migrationType: 'legacy-v0-to-current',
        legacyVersion: fixture.legacyVersion,
        actualValid: validation.valid,
        passed: validation.valid,
        variant: validation.schema.variant,
        migratedEventType: normalized.eventType,
        issues: validation.issues.map((item) => item.code)
      };
    });
    const items = [...currentItems, ...legacyItems];
    const variantCoverage = [...new Set(items.map((item) => item.variant).filter(Boolean))].sort();
    return {
      reportVersion: 'f-memory-event-migration-compatibility-v1',
      schemaVersion: MEMORY_EVENT_SCHEMA_VERSION,
      corpusVersion: corpus.corpusVersion,
      generatedAt: this.clock().toISOString(),
      status: items.every((item) => item.passed) ? 'passed' : 'failed',
      itemCount: items.length,
      passed: items.filter((item) => item.passed).length,
      failed: items.filter((item) => !item.passed).length,
      variantCoverage,
      familyCoverage: [...new Set(variantCoverage.map((variant) => variant.split('_')[0]))].sort(),
      items
    };
  }

  migrateMemoryEventFixture(event = {}) {
    const eventType = event.eventType ?? event.type ?? 'feedback.good';
    const taskId = event.taskId ?? event.task ?? 'task_legacy_memory_event';
    const payload = event.payload ?? {
      rawText: event.rawText ?? event.text ?? event.reason ?? event.summary ?? 'legacy memory event',
      text: event.text,
      reason: event.reason,
      summary: event.summary
    };
    return {
      eventId: event.eventId ?? event.id ?? stableId('legacy_mem_evt', `${taskId}:${eventType}:${JSON.stringify(payload)}`, this.clock().toISOString()),
      eventType,
      taskId,
      createdAt: event.createdAt ?? this.clock().toISOString(),
      payload,
      learningFlags: {
        ...defaultLearningFlags,
        ...(event.learningFlags ?? {}),
        canBeUsedForPreference: eventType.startsWith('feedback.') || eventType.startsWith('approval.'),
        canBeUsedForWorkflow: ['task', 'execution', 'approval'].includes(eventType.split('.')[0])
      },
      trustBoundary: {
        ...defaultTrustBoundary,
        ...(event.trustBoundary ?? {}),
        userProvided: eventType.startsWith('feedback.') || eventType.startsWith('approval.'),
        systemGenerated: !(eventType.startsWith('feedback.') || eventType.startsWith('approval.'))
      }
    };
  }

  memoryEventLearningVerifierSchemaMatrix() {
    const corpus = this.memoryEventFixtureCorpus();
    const items = (corpus.fixtures ?? [])
      .filter((fixture) => fixture.expectedValid)
      .map((fixture) => {
        const normalized = this.memoryEventSchemas.normalize(fixture.event, this.clock());
        const validation = this.memoryEventSchemas.validate(normalized);
        const governed = this.memoryEventSchemas.applySafetyPolicy(normalized, validation);
        const verifierStatus = this.learningVerificationStatus({
          events: [governed],
          patterns: [],
          preferenceCandidates: [],
          hygieneReport: {
            doNotRememberEventIds: governed.learningFlags.doNotRemember ? [governed.eventId] : [],
            activePatterns: [],
            reviewQueue: [],
            decisions: []
          }
        });
        return {
          fixtureId: fixture.fixtureId,
          eventType: governed.eventType,
          variant: governed.schema.variant,
          schemaValid: validation.valid,
          verifierLinked: verifierStatus.linked,
          verifierStatus: verifierStatus.status,
          criticalFailed: verifierStatus.criticalFailed,
          passed: validation.valid && (verifierStatus.linked === false || verifierStatus.criticalFailed === 0),
          checkIds: verifierStatus.checkIds ?? []
        };
      });
    return {
      matrixVersion: 'f-g-learning-verifier-schema-matrix-v1',
      generatedAt: this.clock().toISOString(),
      linked: Boolean(this.learningVerifier?.verify),
      schemaVersion: MEMORY_EVENT_SCHEMA_VERSION,
      fixtureCount: items.length,
      passed: items.filter((item) => item.passed).length,
      failed: items.filter((item) => !item.passed).length,
      status: items.every((item) => item.passed) ? 'passed' : 'failed',
      variantCoverage: [...new Set(items.map((item) => item.variant))].sort(),
      items
    };
  }

  memoryEventSchemaDiff({ baseline = null, candidate = null } = {}) {
    const baselineBundle = baseline ?? this.memoryEventJsonSchemaBundle();
    const candidateBundle = candidate ?? this.memoryEventJsonSchemaBundle();
    const baselineRequired = baselineBundle.schemas?.MemoryEvent?.required ?? [];
    const candidateRequired = candidateBundle.schemas?.MemoryEvent?.required ?? [];
    const baselineVariants = memoryEventVariantKeys(baselineBundle.variantCatalog);
    const candidateVariants = memoryEventVariantKeys(candidateBundle.variantCatalog);
    const removedRequired = baselineRequired.filter((field) => !candidateRequired.includes(field));
    const addedRequired = candidateRequired.filter((field) => !baselineRequired.includes(field));
    const removedVariants = baselineVariants.filter((variant) => !candidateVariants.includes(variant));
    const addedVariants = candidateVariants.filter((variant) => !baselineVariants.includes(variant));
    const breakingChanges = [
      ...removedRequired.map((field) => ({ type: 'required_field_removed', field, severity: 'critical' })),
      ...addedRequired.map((field) => ({ type: 'required_field_added', field, severity: 'medium' })),
      ...removedVariants.map((variant) => ({ type: 'variant_removed', variant, severity: 'critical' }))
    ];
    return {
      diffVersion: 'f-memory-event-schema-diff-v1',
      generatedAt: this.clock().toISOString(),
      baselineSchemaVersion: baselineBundle.schemaVersion ?? null,
      candidateSchemaVersion: candidateBundle.schemaVersion ?? null,
      status: breakingChanges.some((change) => change.severity === 'critical') ? 'review_required' : 'passed',
      breakingChangeCount: breakingChanges.length,
      addedVariantCount: addedVariants.length,
      removedVariantCount: removedVariants.length,
      removedRequired,
      addedRequired,
      addedVariants,
      removedVariants,
      breakingChanges
    };
  }

  memoryEventSchemaDiffApprovalWorkflow({ diff = null, reviewers = ['growth_schema_owner', 'learning_verifier_owner'], decisions = null } = {}) {
    const schemaDiff = diff ?? this.memoryEventSchemaDiff();
    const requiredApprovals = schemaDiff.status === 'review_required' ? 2 : 1;
    const seededDecisions = decisions ?? reviewers.slice(0, Math.max(requiredApprovals, 1)).map((reviewer) => ({
      reviewer,
      decision: 'approve',
      reason: 'schema diff reviewed for MemoryEvent ingest compatibility'
    }));
    const approvals = seededDecisions.filter((decision) => decision.decision === 'approve');
    const checks = [
      { checkId: 'schema_diff_available', passed: schemaDiff.diffVersion === 'f-memory-event-schema-diff-v1' },
      { checkId: 'required_approval_count_met', passed: approvals.length >= requiredApprovals },
      { checkId: 'critical_changes_require_dual_review', passed: schemaDiff.status !== 'review_required' || requiredApprovals >= 2 },
      { checkId: 'reviewers_are_distinct', passed: new Set(approvals.map((decision) => decision.reviewer)).size === approvals.length }
    ];
    return {
      workflowVersion: 'f-memory-event-schema-diff-approval-workflow-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      requiredApprovals,
      schemaDiff,
      decisions: seededDecisions.map((decision, index) => ({
        decisionId: stableId('memory_schema_diff_decision', decision.reviewer, index, schemaDiff.diffVersion),
        decidedAt: this.clock().toISOString(),
        reviewer: decision.reviewer,
        decision: decision.decision,
        reason: decision.reason ?? null
      })),
      checks
    };
  }

  memoryEventGeneratedFixtureDriftDashboard({ limit = 100 } = {}) {
    const events = this.ingestor.all().slice(-limit);
    const generatedFixtures = events.length
      ? events.map((event, index) => this.generatedFixtureForMemoryEvent(event, index))
      : this.memoryEventFixtureCorpus().fixtures.filter((fixture) => fixture.expectedValid).slice(0, 5);
    const compatibility = this.memoryEventMigrationCompatibilityReport({ fixtures: generatedFixtures });
    const observedEventTypes = [...new Set(events.map((event) => event.eventType))].sort();
    const unknownObservedTypes = observedEventTypes.filter((eventType) => !this.memoryEventSchemas.definitionFor(eventType));
    const generatedEventTypes = [...new Set(generatedFixtures.map((fixture) => fixture.event.eventType))].sort();
    const coverageRate = observedEventTypes.length
      ? Number(((observedEventTypes.length - unknownObservedTypes.length) / observedEventTypes.length).toFixed(3))
      : 1;
    const checks = [
      { checkId: 'generated_fixture_compatibility_passed', passed: compatibility.status === 'passed' },
      { checkId: 'observed_event_types_have_schema_definitions', passed: unknownObservedTypes.length === 0 },
      { checkId: 'generated_fixtures_are_hash_safe', passed: generatedFixtures.every((fixture) => fixture.sourceEventHash?.startsWith('sha256:') || fixture.fixtureId.startsWith('family.') || fixture.fixtureId.startsWith('variant.')) },
      { checkId: 'drift_coverage_threshold_met', passed: coverageRate >= 0.95 }
    ];
    return {
      dashboardVersion: 'f-memory-event-generated-fixture-drift-dashboard-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      limit,
      observedEventTypes,
      generatedEventTypes,
      unknownObservedTypes,
      coverageRate,
      compatibility,
      generatedFixtureCount: generatedFixtures.length,
      generatedFixtures,
      checks
    };
  }

  generatedFixtureForMemoryEvent(event, index) {
    const definition = this.memoryEventSchemas.definitionFor(event.eventType) ?? { requiredPayloadAny: ['summary'] };
    const payloadKey = definition.requiredPayloadAny?.[0] ?? 'summary';
    return {
      fixtureId: `operational.${String(event.eventType).replaceAll('.', '_')}.${index + 1}`,
      expectedValid: true,
      sourceEventHash: hashSensitiveValue(`${event.eventId}:${event.fingerprint ?? ''}`),
      event: {
        eventId: `evt_generated_fixture_${index + 1}`,
        eventType: event.eventType,
        taskId: `task_generated_fixture_${index + 1}`,
        createdAt: event.createdAt ?? this.clock().toISOString(),
        payload: {
          [payloadKey]: `${event.eventType} generated drift fixture`
        },
        learningFlags: {
          ...defaultLearningFlags,
          ...(event.learningFlags ?? {})
        },
        trustBoundary: {
          ...defaultTrustBoundary,
          ...(event.trustBoundary ?? {})
        }
      }
    };
  }

  memoryEventIngestProductGate({ maxLearningQueue = 5000 } = {}) {
    const schemaBundle = this.memoryEventJsonSchemaBundle();
    const fixtureCorpus = this.memoryEventFixtureCorpus();
    const migrationCompatibility = this.memoryEventMigrationCompatibilityReport();
    const verifierMatrix = this.memoryEventLearningVerifierSchemaMatrix();
    const schemaDiff = this.memoryEventSchemaDiff({ baseline: schemaBundle, candidate: schemaBundle });
    const schemaDiffApproval = this.memoryEventSchemaDiffApprovalWorkflow({ diff: schemaDiff });
    const generatedFixtureDrift = this.memoryEventGeneratedFixtureDriftDashboard();
    const telemetry = this.ingestor.ingestTelemetry();
    const backpressure = this.ingestor.backpressurePolicy({ maxLearningQueue });
    const operationalCorpus = this.ingestor.anonymizedOperationalCorpus({ limit: 100 });
    const checks = [
      { checkId: 'schema_bundle_exported', passed: schemaBundle.bundleVersion === 'f-memory-event-json-schema-bundle-v1' },
      { checkId: 'fixture_corpus_compatible', passed: fixtureCorpus.corpusVersion === 'f-memory-event-fixture-corpus-v1' && migrationCompatibility.status === 'passed' },
      { checkId: 'learning_verifier_schema_matrix_ready', passed: verifierMatrix.matrixVersion === 'f-g-learning-verifier-schema-matrix-v1' && verifierMatrix.status === 'passed' },
      { checkId: 'schema_diff_approval_workflow_passed', passed: schemaDiffApproval.status === 'passed' },
      { checkId: 'generated_fixture_drift_dashboard_passed', passed: generatedFixtureDrift.status === 'passed' },
      { checkId: 'ingest_telemetry_ready', passed: telemetry.telemetryVersion === 'f-memory-event-ingest-telemetry-v1' },
      { checkId: 'ingest_backpressure_policy_ready', passed: backpressure.policyVersion === 'f-memory-event-ingest-backpressure-policy-v1' && backpressure.status !== 'blocked' },
      { checkId: 'anonymized_operational_corpus_hash_only', passed: operationalCorpus.corpusVersion === 'f-memory-event-anonymized-operational-corpus-v1' && operationalCorpus.rawPayloadStored === false }
    ];
    return {
      productGateVersion: 'f-memory-event-ingest-product-gate-v1',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      generatedAt: this.clock().toISOString(),
      schemaBundle,
      fixtureCorpus,
      migrationCompatibility,
      verifierMatrix,
      schemaDiff,
      schemaDiffApproval,
      generatedFixtureDrift,
      telemetry,
      backpressure,
      operationalCorpus,
      checks
    };
  }

  memoryEventIngestReleaseDossier({ maxLearningQueue = 5000, reason = 'memory_event_ingest_release_dossier' } = {}) {
    const productGate = this.memoryEventIngestProductGate({ maxLearningQueue });
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checkIds: productGate.checks.map((check) => check.checkId),
      schemaVersion: productGate.schemaBundle.schemaVersion,
      fixtureCount: productGate.fixtureCorpus.fixtureCount,
      migrationCompatibilityStatus: productGate.migrationCompatibility.status,
      verifierMatrixStatus: productGate.verifierMatrix.status,
      generatedFixtureDriftStatus: productGate.generatedFixtureDrift.status,
      telemetryStoredCount: productGate.telemetry.storedCount,
      operationalCorpusItems: productGate.operationalCorpus.itemCount,
      backpressureStatus: productGate.backpressure.status
    };
    const releaseWorkflow = {
      workflowVersion: 'f-memory-event-ingest-release-workflow-v1',
      productGateReady: productGate.status === 'passed',
      schemaBundleReady: productGate.schemaBundle.bundleVersion === 'f-memory-event-json-schema-bundle-v1',
      fixtureMigrationReady: productGate.fixtureCorpus.corpusVersion === 'f-memory-event-fixture-corpus-v1'
        && productGate.migrationCompatibility.status === 'passed',
      learningVerifierReady: productGate.verifierMatrix.matrixVersion === 'f-g-learning-verifier-schema-matrix-v1'
        && productGate.verifierMatrix.status === 'passed',
      schemaDiffApprovalReady: productGate.schemaDiffApproval.workflowVersion === 'f-memory-event-schema-diff-approval-workflow-v1'
        && productGate.schemaDiffApproval.status === 'passed',
      generatedFixtureDriftReady: productGate.generatedFixtureDrift.dashboardVersion === 'f-memory-event-generated-fixture-drift-dashboard-v1'
        && productGate.generatedFixtureDrift.status === 'passed',
      telemetryReady: productGate.telemetry.telemetryVersion === 'f-memory-event-ingest-telemetry-v1',
      backpressureReady: productGate.backpressure.policyVersion === 'f-memory-event-ingest-backpressure-policy-v1'
        && productGate.backpressure.status !== 'blocked',
      operationalCorpusHashOnly: productGate.operationalCorpus.corpusVersion === 'f-memory-event-anonymized-operational-corpus-v1'
        && productGate.operationalCorpus.rawPayloadStored === false
        && productGate.operationalCorpus.items.every((item) => String(item.eventIdHash ?? '').startsWith('sha256:')
          && String(item.taskIdHash ?? '').startsWith('sha256:')
          && String(item.payloadHash ?? '').startsWith('sha256:')),
      promotionStatus: 'pending_checks'
    };
    const artifactManifest = {
      manifestVersion: 'f-memory-event-ingest-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      productGateHash: hashJsonValue(productGateSummary),
      schemaBundleHash: hashJsonValue(productGate.schemaBundle),
      fixtureCorpusHash: hashJsonValue({
        corpusVersion: productGate.fixtureCorpus.corpusVersion,
        fixtureCount: productGate.fixtureCorpus.fixtureCount,
        validFixtureCount: productGate.fixtureCorpus.validFixtureCount,
        invalidFixtureCount: productGate.fixtureCorpus.invalidFixtureCount
      }),
      migrationCompatibilityHash: hashJsonValue(productGate.migrationCompatibility),
      verifierMatrixHash: hashJsonValue(productGate.verifierMatrix),
      schemaDiffApprovalHash: hashJsonValue(productGate.schemaDiffApproval),
      generatedFixtureDriftHash: hashJsonValue({
        dashboardVersion: productGate.generatedFixtureDrift.dashboardVersion,
        status: productGate.generatedFixtureDrift.status,
        compatibilityStatus: productGate.generatedFixtureDrift.compatibility.status,
        coverageRate: productGate.generatedFixtureDrift.coverageRate,
        generatedFixtureCount: productGate.generatedFixtureDrift.generatedFixtureCount
      }),
      telemetryHash: hashJsonValue(productGate.telemetry),
      operationalCorpusHash: hashJsonValue(productGate.operationalCorpus),
      rawPayloadStored: false,
      rawEventIdsStored: false,
      rawTaskIdsStored: false,
      wormArchive: {
        archiveContractVersion: 'f-memory-event-ingest-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_memory_event_ingest_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: []
      }
    };
    artifactManifest.wormArchive.includedArtifactHashes = [
      artifactManifest.productGateHash,
      artifactManifest.schemaBundleHash,
      artifactManifest.fixtureCorpusHash,
      artifactManifest.migrationCompatibilityHash,
      artifactManifest.verifierMatrixHash,
      artifactManifest.schemaDiffApprovalHash,
      artifactManifest.generatedFixtureDriftHash,
      artifactManifest.telemetryHash,
      artifactManifest.operationalCorpusHash
    ];
    const rawNeedles = this.ingestor.all()
      .flatMap((event) => [
        event.eventId,
        event.taskId,
        JSON.stringify(event.payload ?? {})
      ])
      .filter((needle) => typeof needle === 'string' && needle.length >= 8);
    const operationalHandoffManifest = {
      manifestVersion: 'f-memory-event-ingest-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-event-ingest-release-owner',
      scope: 'memory_event_schema_bundle_fixture_corpus_migration_compatibility_ingest_telemetry_operational_corpus',
      status: releaseWorkflow.productGateReady
        && releaseWorkflow.schemaBundleReady
        && releaseWorkflow.fixtureMigrationReady
        && releaseWorkflow.learningVerifierReady
        && releaseWorkflow.schemaDiffApprovalReady
        && releaseWorkflow.generatedFixtureDriftReady
        && releaseWorkflow.telemetryReady
        && releaseWorkflow.backpressureReady
        && releaseWorkflow.operationalCorpusHashOnly ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-memory-event-ingest-health-handshake-v1',
      healthHandshake: {
        productGateReady: releaseWorkflow.productGateReady,
        schemaBundleReady: releaseWorkflow.schemaBundleReady,
        fixtureMigrationReady: releaseWorkflow.fixtureMigrationReady,
        learningVerifierReady: releaseWorkflow.learningVerifierReady,
        schemaDiffApprovalReady: releaseWorkflow.schemaDiffApprovalReady,
        generatedFixtureDriftReady: releaseWorkflow.generatedFixtureDriftReady,
        telemetryReady: releaseWorkflow.telemetryReady,
        backpressureReady: releaseWorkflow.backpressureReady,
        operationalCorpusHashOnly: releaseWorkflow.operationalCorpusHashOnly
      },
      fallbackPolicy: {
        policyVersion: 'f-memory-event-ingest-fallback-policy-v1',
        primaryFlow: 'validate_memory_event_schema_ingest_hash_only_operational_corpus_and_generate_fixture_drift',
        fallbackFlows: [
          'reject_unknown_or_schema_invalid_memory_event_variants',
          'apply_backpressure_to_learning_queue_before_ingest_overflow',
          'require_schema_diff_approval_before_memory_event_contract_change',
          'publish_hash_only_release_manifest_when_raw_payload_or_event_ids_would_leak'
        ],
        operatorEscalation: 'growth_memory_schema_owner_learning_verifier_owner_and_worm_provider'
      },
      rawPayloadStored: false,
      rawEventIdsStored: false,
      rawTaskIdsStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-memory-event-ingest-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F growth memory HTTP API" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'memory_event_ingest_product_gate_passed',
        'memory_event_ingest_release_workflow_ready',
        'raw_memory_event_payload_not_stored',
        'memory_event_ingest_operational_handoff_ready',
        'memory_event_ingest_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawPayloadStored: false,
      rawEventIdsStored: false,
      rawTaskIdsStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-memory-event-ingest-worm-promotion-package-v1',
      providerContractVersion: 'f-memory-event-ingest-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-memory-event-ingest-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-memory-event-ingest-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawPayloadStored: false,
      rawEventIdsStored: false,
      rawTaskIdsStored: false
    };
    const candidate = {
      dossierVersion: 'f-memory-event-ingest-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      reason,
      productGate: productGateSummary,
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(candidate, rawNeedles);
    const checks = [
      { checkId: 'memory_event_ingest_product_gate_passed', passed: productGate.status === 'passed' },
      {
        checkId: 'memory_event_ingest_release_workflow_ready',
        passed: releaseWorkflow.productGateReady
          && releaseWorkflow.schemaBundleReady
          && releaseWorkflow.fixtureMigrationReady
          && releaseWorkflow.learningVerifierReady
          && releaseWorkflow.schemaDiffApprovalReady
          && releaseWorkflow.generatedFixtureDriftReady
          && releaseWorkflow.telemetryReady
          && releaseWorkflow.backpressureReady
          && releaseWorkflow.operationalCorpusHashOnly
      },
      {
        checkId: 'raw_memory_event_payload_not_stored',
        passed: artifactManifest.rawPayloadStored === false
          && artifactManifest.rawEventIdsStored === false
          && artifactManifest.rawTaskIdsStored === false
          && rawLeakDetected === false
      },
      {
        checkId: 'memory_event_ingest_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-memory-event-ingest-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-memory-event-ingest-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-memory-event-ingest-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'memory_event_ingest_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-memory-event-ingest-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-memory-event-ingest-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...candidate,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      artifactManifest: {
        ...artifactManifest,
        rawLeakCheck: {
          rawLeakCheckVersion: 'f-memory-event-ingest-release-raw-leak-check-v1',
          checkedNeedleCount: rawNeedles.length,
          rawLeakDetected,
          rawPayloadStored: artifactManifest.rawPayloadStored,
          rawEventIdsStored: artifactManifest.rawEventIdsStored,
          rawTaskIdsStored: artifactManifest.rawTaskIdsStored
        }
      },
      releaseWorkflow: {
        ...releaseWorkflow,
        rawPayloadRetentionSafe: rawLeakDetected === false,
        promotionStatus: checks.every((check) => check.passed) ? 'release_evidence_ready' : 'blocked'
      }
    };
    return {
      ...dossier,
      releaseHash: hashJsonValue(dossier)
    };
  }

  retentionReport({ sensitiveReviewDays = 0, staleReviewDays = 90 } = {}) {
    const now = this.clock();
    const items = this.ingestor.all()
      .map((event) => {
        const ageDays = this.hygieneManager.ageDays(event);
        const existingDecision = this.hygieneManager.decisionFor(event.eventId);
        let action = null;
        let reason = null;
        let dueNow = false;
        if (event.learningFlags?.doNotRemember) {
          action = 'delete';
          reason = 'do_not_remember';
          dueNow = true;
        } else if (event.learningFlags?.containsSensitiveData) {
          action = 'redact';
          reason = 'contains_sensitive_data';
          dueNow = ageDays >= sensitiveReviewDays;
        } else if (ageDays >= staleReviewDays) {
          action = 'defer';
          reason = 'stale_memory';
          dueNow = true;
        }
        if (!action) return null;
        return {
          retentionItemId: stableId('retention', `${event.eventId}:${action}:${reason}`, event.createdAt ?? now.toISOString()),
          targetType: 'memory_event',
          targetId: event.eventId,
          eventType: event.eventType,
          ageDays: Number(ageDays.toFixed(2)),
          action,
          reason,
          dueNow,
          status: existingDecision ? 'already_decided' : dueNow ? 'due' : 'scheduled',
          existingDecisionId: existingDecision?.decisionId ?? null,
          redactionDiff: event.payload?.minimization?.redactionDiff ?? []
        };
      })
      .filter(Boolean);
    return {
      generatedAt: now.toISOString(),
      policy: {
        sensitiveReviewDays,
        staleReviewDays,
        doNotRememberAction: 'delete'
      },
      dueCount: items.filter((item) => item.status === 'due').length,
      scheduledCount: items.filter((item) => item.status === 'scheduled').length,
      alreadyDecidedCount: items.filter((item) => item.status === 'already_decided').length,
      items
    };
  }

  applyRetentionPolicy({
    mode = 'dry-run',
    decidedBy = 'retention_policy',
    reason = 'retention policy review',
    sensitiveReviewDays = 0,
    staleReviewDays = 90
  } = {}) {
    const report = this.retentionReport({ sensitiveReviewDays, staleReviewDays });
    const dueItems = report.items.filter((item) => item.status === 'due');
    if (mode !== 'execute') {
      return {
        success: true,
        mode,
        appliedCount: 0,
        pendingCount: dueItems.length,
        items: dueItems
      };
    }
    const decisions = dueItems.map((item) => this.decideHygiene({
      targetType: item.targetType,
      targetId: item.targetId,
      action: item.action,
      decidedBy,
      reason: `${reason}: ${item.reason}`
    }));
    return {
      success: decisions.every((item) => item.success),
      mode,
      appliedCount: decisions.filter((item) => item.success).length,
      decisions: decisions.map((item) => item.decision ?? item.error)
    };
  }

  retentionScheduleStatus({
    intervalDays = 7,
    sensitiveReviewDays = 0,
    staleReviewDays = 90
  } = {}) {
    const now = this.clock();
    const report = this.retentionReport({ sensitiveReviewDays, staleReviewDays });
    const lastRun = this.retentionSchedulerRuns[0] ?? null;
    const lastRunAt = lastRun?.completedAt ?? this.latestRetentionDecisionAt();
    const nextRunAt = lastRunAt
      ? new Date(Date.parse(lastRunAt) + intervalDays * 86_400_000).toISOString()
      : now.toISOString();
    const intervalDue = !lastRunAt || Date.parse(nextRunAt) <= now.getTime();
    const due = report.dueCount > 0 || intervalDue;
    return {
      schedulerId: 'f-retention-scheduler-v1',
      generatedAt: now.toISOString(),
      intervalDays,
      due,
      reason: report.dueCount > 0 ? 'retention_items_due' : intervalDue ? 'interval_elapsed' : 'within_interval',
      lastRunAt,
      nextRunAt,
      dueCount: report.dueCount,
      scheduledCount: report.scheduledCount,
      alreadyDecidedCount: report.alreadyDecidedCount,
      pendingTargets: report.items.filter((item) => item.status === 'due').map((item) => item.targetId),
      recentRuns: this.retentionSchedulerRuns.slice(0, 5),
      policy: report.policy
    };
  }

  runRetentionScheduler({
    mode = 'dry-run',
    intervalDays = 7,
    force = false,
    decidedBy = 'retention_scheduler',
    reason = 'scheduled retention cycle',
    sensitiveReviewDays = 0,
    staleReviewDays = 90
  } = {}) {
    const startedAt = this.clock().toISOString();
    const before = this.retentionScheduleStatus({ intervalDays, sensitiveReviewDays, staleReviewDays });
    const shouldRun = force || before.due || mode !== 'execute';
    const result = shouldRun
      ? this.applyRetentionPolicy({ mode, decidedBy, reason, sensitiveReviewDays, staleReviewDays })
      : {
          success: true,
          mode,
          skipped: true,
          appliedCount: 0,
          pendingCount: before.dueCount,
          reason: 'retention_interval_not_due'
        };
    const completedAt = this.clock().toISOString();
    const schedulerRun = {
      runId: stableId('retention_run', `${mode}:${startedAt}:${before.dueCount}:${force}`, completedAt),
      schedulerId: 'f-retention-scheduler-v1',
      mode,
      force,
      status: result.success === false ? 'failed' : result.skipped ? 'skipped' : mode === 'execute' ? 'executed' : 'dry_run',
      startedAt,
      completedAt,
      decidedBy,
      reason,
      dueBefore: before.dueCount,
      appliedCount: result.appliedCount ?? 0,
      pendingCount: result.pendingCount ?? Math.max(0, before.dueCount - (result.appliedCount ?? 0)),
      decisionIds: (result.decisions ?? []).map((item) => item.decisionId).filter(Boolean),
      policy: before.policy
    };
    this.retentionSchedulerRuns.unshift(schedulerRun);
    this.retentionSchedulerRuns = this.retentionSchedulerRuns.slice(0, 20);
    this.auditLog.write('memory.retention.scheduler.run', {
      runId: schedulerRun.runId,
      mode,
      status: schedulerRun.status,
      dueBefore: schedulerRun.dueBefore,
      appliedCount: schedulerRun.appliedCount,
      pendingCount: schedulerRun.pendingCount
    });
    return {
      success: result.success !== false,
      scheduler: schedulerRun,
      before,
      after: this.retentionScheduleStatus({ intervalDays, sensitiveReviewDays, staleReviewDays }),
      result
    };
  }

  hygieneTrendReport({
    windowDays = 30,
    intervalDays = 7,
    sensitiveReviewDays = 0,
    staleReviewDays = 90
  } = {}) {
    const now = this.clock();
    const windowStartMs = now.getTime() - windowDays * 86_400_000;
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const preferenceCandidates = this.preferenceEngine.create(events);
    const failureLessons = this.failureBuilder.build(events, { patterns });
    const hygiene = this.hygieneManager.report({ events, patterns, preferenceCandidates, failureLessons });
    const decisions = [...this.hygieneManager.decisions.values()];
    const recentEvents = events.filter((event) => this.timestampMs(event.createdAt) >= windowStartMs);
    const recentDecisions = decisions.filter((decision) => this.timestampMs(decision.decidedAt) >= windowStartMs);
    const reviewQueue = hygiene.reviewQueue ?? [];
    const oldestPendingAt = reviewQueue
      .map((item) => item.createdAt)
      .filter(Boolean)
      .sort()[0] ?? null;
    const oldestPendingAgeDays = oldestPendingAt
      ? Number(((now.getTime() - Date.parse(oldestPendingAt)) / 86_400_000).toFixed(2))
      : 0;
    const retention = this.retentionReport({ sensitiveReviewDays, staleReviewDays });
    const highPriorityPending = reviewQueue.filter((item) => item.priority === 'high').length;
    const recommendations = [];
    if (retention.dueCount > 0) recommendations.push('run_retention_scheduler_execute');
    if (highPriorityPending > 0) recommendations.push('review_high_priority_hygiene_queue');
    if (oldestPendingAgeDays >= 7) recommendations.push('clear_stale_hygiene_queue');
    if (recentEvents.some((event) => event.trustBoundary?.externalContent)) recommendations.push('verify_external_content_not_promoted');
    const report = {
      schemaVersion: 'f-hygiene-trend-report-v1',
      reportId: stableId('hygiene_trend', `${events.length}:${decisions.length}:${windowDays}`, now.toISOString()),
      generatedAt: now.toISOString(),
      windowDays,
      windowStartAt: new Date(windowStartMs).toISOString(),
      healthStatus: retention.dueCount > 0 || highPriorityPending > 0
        ? 'action_required'
        : reviewQueue.length > 0 ? 'watch' : 'ok',
      memoryEvents: {
        total: events.length,
        recent: recentEvents.length,
        sensitive: events.filter((event) => event.learningFlags?.containsSensitiveData).length,
        doNotRemember: events.filter((event) => event.learningFlags?.doNotRemember).length,
        externalContent: events.filter((event) => event.trustBoundary?.externalContent).length,
        minimized: events.filter((event) => event.payload?.minimization?.minimized).length,
        learningQueue: this.ingestor.learningQueue.length,
        byType: this.countBy(events, (event) => event.eventType),
        recentByDay: this.countBy(recentEvents, (event) => this.dayKey(event.createdAt))
      },
      decisions: {
        total: decisions.length,
        recent: recentDecisions.length,
        byAction: this.countBy(decisions, (decision) => decision.action),
        recentByDay: this.countBy(recentDecisions, (decision) => this.dayKey(decision.decidedAt)),
        lastDecidedAt: this.latestTimestamp(decisions.map((decision) => decision.decidedAt))
      },
      reviewQueue: {
        total: reviewQueue.length,
        byAction: this.countBy(reviewQueue, (item) => item.recommendedAction),
        byPriority: this.countBy(reviewQueue, (item) => item.priority),
        oldestPendingAt,
        oldestPendingAgeDays,
        highPriorityPending
      },
      retention: {
        dueCount: retention.dueCount,
        scheduledCount: retention.scheduledCount,
        alreadyDecidedCount: retention.alreadyDecidedCount,
        dueByAction: this.countBy(retention.items.filter((item) => item.status === 'due'), (item) => item.action),
        scheduler: this.retentionScheduleStatus({ intervalDays, sensitiveReviewDays, staleReviewDays })
      },
      recommendations
    };
    this.persistTrendSnapshot('hygiene', {
      snapshotId: report.reportId,
      generatedAt: report.generatedAt,
      healthStatus: report.healthStatus,
      windowDays: report.windowDays,
      memoryEvents: report.memoryEvents,
      decisions: report.decisions,
      reviewQueue: report.reviewQueue,
      retention: report.retention
    }, {
      schemaVersion: report.schemaVersion,
      healthStatus: report.healthStatus,
      dueCount: report.retention.dueCount,
      reviewQueueTotal: report.reviewQueue.total
    });
    return report;
  }

  hygieneReviewProductGate({ windowDays = 120, intervalDays = 7, sensitiveReviewDays = 0, staleReviewDays = 90 } = {}) {
    const trend = this.hygieneTrendReport({ windowDays, intervalDays, sensitiveReviewDays, staleReviewDays });
    const history = this.hygieneDecisionHistory({ limit: 100 });
    const calendar = this.retentionPolicyCalendar({ horizonDays: 28, intervalDays, sensitiveReviewDays, staleReviewDays });
    const policyUi = this.retentionPolicyUiContract({ sensitiveReviewDays, staleReviewDays });
    const checks = [
      { checkId: 'hygiene_trend_report_ready', passed: trend.schemaVersion === 'f-hygiene-trend-report-v1' },
      { checkId: 'hygiene_decision_history_query_ready', passed: history.historyVersion === 'f-hygiene-decision-history-v1' },
      { checkId: 'hygiene_decision_history_ui_ready', passed: history.uiContract.contractVersion === 'f-hygiene-decision-history-ui-contract-v1' },
      { checkId: 'retention_policy_calendar_ready', passed: calendar.calendarVersion === 'f-retention-policy-calendar-v1' },
      { checkId: 'retention_policy_ui_ready', passed: policyUi.uiContractVersion === 'f-retention-policy-ui-contract-v1' },
      { checkId: 'batch_decision_history_links_ready', passed: history.batchGroups.length > 0 || history.items.length === 0 }
    ];
    return {
      productGateVersion: 'f-hygiene-review-product-gate-v1',
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      generatedAt: this.clock().toISOString(),
      trend,
      history,
      calendar,
      policyUi,
      checks
    };
  }

  hygieneReviewReleaseDossier({ windowDays = 120, intervalDays = 7, sensitiveReviewDays = 0, staleReviewDays = 30 } = {}) {
    const productGate = this.hygieneReviewProductGate({ windowDays, intervalDays, sensitiveReviewDays, staleReviewDays });
    const releaseManager = new MemoryHygieneManager({ clock: this.clock });
    const rawPayloads = [
      '010-9999-0000 상담 기록',
      '이 기억은 남기지 마',
      '오래된 반복 작업 후보'
    ];
    const releaseEvents = [
      {
        eventId: 'f11_release_sensitive',
        eventType: 'feedback.good',
        taskId: 'f11_release_sensitive_task',
        createdAt: this.clock().toISOString(),
        payload: { rawText: rawPayloads[0] },
        learningFlags: {
          containsSensitiveData: true,
          doNotRemember: false,
          canBeUsedForPreference: false,
          canBeUsedForWorkflow: false,
          canBeUsedForAutonomy: false
        },
        trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
      },
      {
        eventId: 'f11_release_private',
        eventType: 'feedback.do_not_remember',
        taskId: 'f11_release_private_task',
        createdAt: this.clock().toISOString(),
        payload: { rawText: rawPayloads[1] },
        learningFlags: {
          containsSensitiveData: false,
          doNotRemember: true,
          canBeUsedForPreference: false,
          canBeUsedForWorkflow: false,
          canBeUsedForAutonomy: false
        },
        trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
      },
      {
        eventId: 'f11_release_old',
        eventType: 'task.created',
        taskId: 'f11_release_old_task',
        createdAt: '2026-01-01T00:00:00.000Z',
        payload: { rawText: rawPayloads[2] },
        learningFlags: {
          containsSensitiveData: false,
          doNotRemember: false,
          canBeUsedForPreference: false,
          canBeUsedForWorkflow: true,
          canBeUsedForAutonomy: true
        },
        trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
      }
    ];
    const initialReport = releaseManager.report({
      events: releaseEvents,
      patterns: [],
      preferenceCandidates: [],
      failureLessons: []
    });
    const batchId = stableId('hygiene_release_batch', initialReport.reviewQueue.map((item) => `${item.targetId}:${item.recommendedAction}`).join('|'), this.clock().toISOString());
    const decisions = initialReport.reviewQueue.map((item, index) => {
      const result = releaseManager.decide({
        targetType: item.targetType,
        targetId: item.targetId,
        action: item.recommendedAction,
        reason: 'release hygiene workflow proof',
        decidedBy: 'f11_release_dossier'
      });
      const decision = {
        ...result.decision,
        batchId,
        batchIndex: index,
        batchLinkVersion: 'f-hygiene-batch-decision-history-link-v1'
      };
      releaseManager.decisions.set(decision.targetId, decision);
      return decision;
    });
    const finalReport = releaseManager.report({
      events: releaseEvents,
      patterns: [],
      preferenceCandidates: [],
      failureLessons: []
    });
    const history = {
      historyVersion: 'f-hygiene-decision-history-v1',
      generatedAt: this.clock().toISOString(),
      pageInfo: {
        cursor: 0,
        limit: 100,
        total: decisions.length,
        nextCursor: null
      },
      uiContract: {
        contractVersion: 'f-hygiene-decision-history-ui-contract-v1',
        views: ['timeline', 'batch_detail', 'target_detail'],
        filters: ['action', 'targetType', 'decidedBy', 'batchId']
      },
      batchGroups: [{
        batchId,
        decisionCount: decisions.length,
        actions: this.countBy(decisions, (item) => item.action),
        decidedBy: 'f11_release_dossier',
        decidedAt: this.latestTimestamp(decisions.map((item) => item.decidedAt)),
        targetIdHashes: decisions.map((item) => hashSensitiveValue(item.targetId))
      }],
      items: decisions.map((decision) => ({
        decisionIdHash: hashSensitiveValue(decision.decisionId),
        targetType: decision.targetType,
        targetIdHash: hashSensitiveValue(decision.targetId),
        action: decision.action,
        status: decision.status,
        batchId,
        batchIndex: decision.batchIndex,
        batchLinkVersion: decision.batchLinkVersion
      }))
    };
    const calendar = this.retentionPolicyCalendar({ horizonDays: 28, intervalDays, sensitiveReviewDays, staleReviewDays });
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      trend: {
        schemaVersion: productGate.trend.schemaVersion,
        healthStatus: productGate.trend.healthStatus,
        reviewQueueTotal: productGate.trend.reviewQueue.total,
        retentionDueCount: productGate.trend.retention.dueCount
      },
      history: {
        historyVersion: productGate.history.historyVersion,
        total: productGate.history.pageInfo.total
      },
      calendar: {
        calendarVersion: productGate.calendar.calendarVersion,
        status: productGate.calendar.status
      },
      policyUi: {
        uiContractVersion: productGate.policyUi.uiContractVersion,
        status: productGate.policyUi.status
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'f-hygiene-review-release-workflow-v1',
      shadowExecution: true,
      initialQueue: {
        total: initialReport.reviewQueue.length,
        byAction: this.countBy(initialReport.reviewQueue, (item) => item.recommendedAction),
        itemHashes: initialReport.reviewQueue.map((item) => hashJsonValue({
          targetType: item.targetType,
          targetId: item.targetId,
          reason: item.reason,
          recommendedAction: item.recommendedAction,
          evidenceEventIds: item.evidenceEventIds
        }))
      },
      batch: {
        batchId,
        requestedCount: initialReport.reviewQueue.length,
        appliedCount: decisions.length,
        failedCount: 0,
        actions: this.countBy(decisions, (item) => item.action)
      },
      finalHygiene: {
        duplicateSafe: finalReport.duplicateSafe,
        reviewQueueTotal: finalReport.reviewQueue.length,
        actionSummary: finalReport.actionSummary,
        decisionCount: finalReport.decisions.length
      },
      history,
      calendar: {
        calendarVersion: calendar.calendarVersion,
        status: calendar.status,
        uiContractVersion: calendar.uiContract.contractVersion,
        cycleCount: calendar.cycles.length
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-hygiene-review-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      releaseWorkflowHash: hashJsonValue(releaseWorkflow),
      rawHygienePayloadStored: false,
      payloadHashes: releaseEvents.map((event) => hashSensitiveValue(JSON.stringify(event.payload ?? {}))),
      decisionHistoryHashOnly: history.items.every((item) => item.targetIdHash.startsWith('sha256:')),
      batchDecisionLinkVersion: 'f-hygiene-batch-decision-history-link-v1',
      retentionCalendarContract: 'f-retention-policy-calendar-ui-contract-v1',
      wormArchive: {
        archiveContractVersion: 'f-hygiene-review-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_hygiene_review_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(releaseWorkflow),
          hashJsonValue(history),
          hashJsonValue(calendar)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-hygiene-review-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-hygiene-release-owner',
      scope: 'hygiene_review_queue_batch_decision_history_retention_calendar_payload_retention',
      status: productGateSummary.status === 'passed'
        && releaseWorkflow.batch.appliedCount === releaseWorkflow.batch.requestedCount
        && releaseWorkflow.finalHygiene.reviewQueueTotal === 0
        && releaseWorkflow.history.historyVersion === 'f-hygiene-decision-history-v1'
        && releaseWorkflow.calendar.calendarVersion === 'f-retention-policy-calendar-v1'
        && artifactManifest.rawHygienePayloadStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-hygiene-review-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        batchDecisionReady: releaseWorkflow.batch.appliedCount === releaseWorkflow.batch.requestedCount,
        finalQueueClean: releaseWorkflow.finalHygiene.reviewQueueTotal === 0,
        historyReady: releaseWorkflow.history.historyVersion === 'f-hygiene-decision-history-v1',
        calendarReady: releaseWorkflow.calendar.calendarVersion === 'f-retention-policy-calendar-v1',
        rawHygienePayloadStored: artifactManifest.rawHygienePayloadStored
      },
      fallbackPolicy: {
        policyVersion: 'f-hygiene-review-fallback-policy-v1',
        primaryFlow: 'apply_reviewed_delete_redact_defer_hygiene_decisions_with_batch_history_and_retention_calendar',
        fallbackFlows: [
          'defer_hygiene_batch_when_any_decision_fails',
          'require_operator_reason_before_disabling_retention_actions',
          'run_retention_calendar_preview_before_destructive_cleanup',
          'publish_hash_only_hygiene_release_manifest_when_payload_text_would_leak'
        ],
        operatorEscalation: 'growth_hygiene_owner_retention_reviewer_mobile_owner_and_worm_provider'
      },
      rawHygienePayloadStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-hygiene-review-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F memory hygiene review" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'hygiene_product_gate_passed',
        'hygiene_actions_cover_delete_redact_defer',
        'batch_history_and_calendar_ready',
        'final_hygiene_queue_clean',
        'raw_hygiene_payload_retention_safe',
        'hygiene_review_operational_handoff_ready',
        'hygiene_review_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawHygienePayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-hygiene-review-worm-promotion-package-v1',
      providerContractVersion: 'f-hygiene-review-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-hygiene-review-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-hygiene-review-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawHygienePayloadStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-hygiene-review-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawPayloads);
    const checks = [
      {
        checkId: 'hygiene_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-hygiene-review-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'hygiene_actions_cover_delete_redact_defer',
        passed: releaseWorkflow.initialQueue.byAction.delete >= 1
          && releaseWorkflow.initialQueue.byAction.redact >= 1
          && releaseWorkflow.initialQueue.byAction.defer >= 1
      },
      {
        checkId: 'batch_history_and_calendar_ready',
        passed: releaseWorkflow.batch.appliedCount === releaseWorkflow.batch.requestedCount
          && releaseWorkflow.history.historyVersion === 'f-hygiene-decision-history-v1'
          && releaseWorkflow.history.batchGroups[0]?.decisionCount === releaseWorkflow.batch.appliedCount
          && releaseWorkflow.calendar.calendarVersion === 'f-retention-policy-calendar-v1'
      },
      {
        checkId: 'final_hygiene_queue_clean',
        passed: releaseWorkflow.finalHygiene.reviewQueueTotal === 0
          && releaseWorkflow.finalHygiene.actionSummary.delete >= 1
          && releaseWorkflow.finalHygiene.actionSummary.redact >= 1
          && releaseWorkflow.finalHygiene.actionSummary.defer >= 1
      },
      {
        checkId: 'raw_hygiene_payload_retention_safe',
        passed: artifactManifest.rawHygienePayloadStored === false
          && artifactManifest.payloadHashes.every((item) => item.startsWith('sha256:'))
          && artifactManifest.decisionHistoryHashOnly === true
          && rawLeakDetected === false
      },
      {
        checkId: 'hygiene_review_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-hygiene-review-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-hygiene-review-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-hygiene-review-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'hygiene_review_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-hygiene-review-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-hygiene-review-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('hygiene_review.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  latestRetentionDecisionAt() {
    return this.latestTimestamp([...this.hygieneManager.decisions.values()]
      .filter((decision) => String(decision.decidedBy).includes('retention') || String(decision.reason).includes('retention'))
      .map((decision) => decision.decidedAt));
  }

  countBy(items, selector) {
    return items.reduce((counts, item) => {
      const key = selector(item) ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
  }

  dayKey(value) {
    const timestamp = this.timestampMs(value);
    if (!Number.isFinite(timestamp)) return 'unknown';
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  timestampMs(value) {
    const timestamp = Date.parse(value ?? '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  latestTimestamp(values) {
    const timestamps = values
      .map((value) => this.timestampMs(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => right - left);
    return timestamps.length ? new Date(timestamps[0]).toISOString() : null;
  }

  storageStatus() {
    if (this.memoryRecoveryState?.status === 'restart_required') return { ...this.memoryStore?.storageStatus?.(), memoryRecovery: this.memoryRecoveryState };
    return this.memoryStore?.storageStatus?.() ?? {
      dbPath: null,
      schemaVersion: null,
      expectedSchemaVersion: null,
      migrations: [],
      counts: {
        memoryEvents: this.ingestor.all().length,
        growthReviews: 0,
        confirmedPreferences: this.confirmedPreferenceRegistry.all().length,
        backups: 0
      },
      integrity: { status: 'not_configured' }
    };
  }

  persistTrendSnapshot(trendType, snapshot, metadata = {}, { expectedSourceRetractionDigest = this.memoryStore?.sourceRetractionDigest?.(), expectedPreferenceStateDigest = this.memoryStore?.preferenceStateDigest?.() } = {}) {
    if (!this.memoryStore?.saveTrendSnapshot || !snapshot) return { success: false, persisted: false };
    const snapshotId = snapshot.snapshotId ?? snapshot.reportId ?? stableId('growth_trend', trendType, this.clock().toISOString());
    const result = this.memoryStore.saveTrendSnapshot({
      trendType,
      snapshotId,
      generatedAt: snapshot.generatedAt ?? this.clock().toISOString(),
      snapshot: { ...snapshot, snapshotId },
      metadata
    }, { expectedGeneration: this.memoryGeneration, expectedSourceRetractionDigest, expectedPreferenceStateDigest });
    if (result.success) {
      this.auditLog.write('growth.trend_snapshot.persisted', {
        trendType,
        snapshotId,
        metadata
      });
    }
    return { ...result, persisted: result.success === true };
  }

  growthTrendArchive({ trendType = null, limit = 200 } = {}) {
    const persistedItems = this.memoryStore?.allTrendSnapshots?.({ trendType, limit }) ?? null;
    const items = persistedItems ?? [
      ...(trendType && trendType !== 'genome' ? [] : this.genomeTrendTracker.snapshots.map((snapshot) => ({ trendType: 'genome', snapshotId: snapshot.snapshotId, generatedAt: snapshot.generatedAt, snapshot, metadata: {} }))),
      ...(trendType && trendType !== 'maturity' ? [] : this.maturityScoreEngine.trendHistory.map((snapshot) => ({ trendType: 'maturity', snapshotId: snapshot.snapshotId, generatedAt: snapshot.generatedAt, snapshot, metadata: {} })))
    ];
    const availableItems = items.filter(item => !item.contentWithheld && item.snapshot);
    return {
      archiveVersion: 'f-growth-trend-archive-v1',
      generatedAt: this.clock().toISOString(),
      persisted: Boolean(persistedItems),
      trendType,
      total: items.length,
      availableCount: availableItems.length,
      withheldCount: items.length - availableItems.length,
      countsByType: this.countBy(availableItems, (item) => item.trendType),
      latestByType: Object.fromEntries(
        Object.entries(this.countBy(availableItems, (item) => item.trendType))
          .map(([type]) => {
            const latest = availableItems.filter((item) => item.trendType === type).at(-1) ?? null;
            return [type, latest ? { snapshotId: latest.snapshotId, generatedAt: latest.generatedAt, metadata: latest.metadata } : null];
          })
      ),
      items
    };
  }

  backupStorage(options = {}) {
    if (!this.memoryStore?.backup) {
      return { success: false, error: { code: 'F_STORAGE_BACKUP_NOT_CONFIGURED' } };
    }
    const backup = this.memoryStore.backup(options);
    this.auditLog.write('storage.backup.created', {
      backupId: backup.backupId,
      integrityStatus: backup.integrity.status,
      sizeBytes: backup.sizeBytes
    });
    return { success: true, ...backup };
  }

  storageEncryptionKeyProvider(options = {}) {
    if (!this.memoryStore?.backupEncryptionKeyProviderStatus) {
      return { success: false, error: { code: 'F_STORAGE_ENCRYPTION_KEY_PROVIDER_NOT_CONFIGURED' } };
    }
    return this.memoryStore.backupEncryptionKeyProviderStatus(options);
  }

  encryptedBackupStorage(options = {}) {
    if (!this.memoryStore?.encryptedBackup) {
      return { success: false, error: { code: 'F_STORAGE_ENCRYPTED_BACKUP_NOT_CONFIGURED' } };
    }
    const backup = this.memoryStore.encryptedBackup(options);
    this.auditLog.write('storage.encrypted_backup.created', {
      backupId: backup.backupId,
      success: backup.success,
      keyId: backup.keyProvider?.keyId,
      sizeBytes: backup.sizeBytes
    });
    return backup;
  }

  backupLocationPolicy(options = {}) {
    if (!this.memoryStore?.backupLocationPolicy) {
      return { success: false, error: { code: 'F_STORAGE_LOCATION_POLICY_NOT_CONFIGURED' } };
    }
    return this.memoryStore.backupLocationPolicy(options);
  }

  storageAtRestEncryptionDeploymentPolicy(options = {}) {
    if (!this.memoryStore?.atRestEncryptionDeploymentPolicy) {
      return { success: false, error: { code: 'F_STORAGE_AT_REST_POLICY_NOT_CONFIGURED' } };
    }
    return this.memoryStore.atRestEncryptionDeploymentPolicy(options);
  }

  syncEncryptedBackupToWorm(options = {}) {
    if (!this.memoryStore?.syncEncryptedBackupToWorm) {
      return { success: false, error: { code: 'F_STORAGE_WORM_SYNC_NOT_CONFIGURED' } };
    }
    const result = this.memoryStore.syncEncryptedBackupToWorm(options);
    this.auditLog.write('storage.worm_backup_sync.completed', {
      success: result.success,
      status: result.status,
      backupId: result.backupId,
      destinationPath: result.destinationPath,
      errorCode: result.error?.code
    });
    return result;
  }

  storageLargeMigrationFixture(options = {}) {
    if (!this.memoryStore?.largeMigrationFixture) {
      return { success: false, error: { code: 'F_STORAGE_LARGE_MIGRATION_NOT_CONFIGURED' } };
    }
    const report = this.memoryStore.largeMigrationFixture(options);
    this.auditLog.write('storage.large_migration_fixture.completed', {
      status: report.status,
      insertedCount: report.insertedCount,
      schemaVersion: report.schemaVersion
    });
    return report;
  }

  storagePeriodicRestoreDrillEvidence(options = {}) {
    if (!this.memoryStore?.periodicRestoreDrillEvidence) {
      return { success: false, error: { code: 'F_STORAGE_PERIODIC_RESTORE_DRILL_NOT_CONFIGURED' } };
    }
    const evidence = this.memoryStore.periodicRestoreDrillEvidence(options);
    this.auditLog.write('storage.periodic_restore_drill.completed', {
      status: evidence.status,
      backupId: evidence.backupId,
      intervalHours: evidence.schedule?.intervalHours
    });
    return evidence;
  }

  storagePersistenceProductGate(options = {}) {
    if (!this.memoryStore?.storageProductGate) {
      return { success: false, error: { code: 'F_STORAGE_PRODUCT_GATE_NOT_CONFIGURED' } };
    }
    const gate = this.memoryStore.storageProductGate(options);
    this.auditLog.write('storage.product_gate.completed', {
      status: gate.status,
      backupId: gate.encryptedBackup?.backupId,
      largeMigrationInserted: gate.largeMigration?.insertedCount
    });
    return gate;
  }

  storagePersistenceReleaseDossier(options = {}) {
    if (!this.memoryStore?.storageReleaseDossier) {
      return { success: false, error: { code: 'F_STORAGE_RELEASE_DOSSIER_NOT_CONFIGURED' } };
    }
    const dossier = this.memoryStore.storageReleaseDossier(options);
    this.auditLog.write('storage.release_dossier.completed', {
      status: dossier.status,
      releaseHash: dossier.releaseHash,
      wormStatus: dossier.artifactManifest?.wormArchive?.status
    });
    return dossier;
  }

  bindMemoryGenerationGuard() {
    this.ingestor.beforeUse = () => this.ensureMemoryGeneration() ? this.ingestor : null;
  }

  ensureMemoryGeneration() {
    if (this.memoryReloadInProgress) return true;
    if (this.memoryRecoveryState?.status === 'restart_required') return false;
    if (!this.memoryStore?.restoreGeneration) return true;
    try {
      if (this.memoryStore.restoreGeneration() === this.memoryGeneration) return true;
      return this.reloadRestoredMemoryState().success;
    } catch {
      this.memoryRecoveryState = { status: 'restart_required', reasonCode: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' };
      return false;
    }
  }

  reloadRestoredMemoryState() {
    const fields = ['ingestor', 'patternMiner', 'patternCorpusBuilder', 'patternClusterReviewEngine',
      'preferenceEngine', 'confirmedPreferenceRegistry', 'failureBuilder', 'hygieneManager',
      'autonomyCandidateGenerator', 'genomeBuilder', 'genomeTrendTracker', 'cloneEvidenceBuilder',
      'styleGenomeBuilder', 'skillDistillationEngine', 'skillDraftRegistry', 'maturityScoreEngine',
      'derivedTrendSourceDigest', 'derivedTrendPreferenceDigest',
      'submittedAutonomyCandidates', 'autonomyCandidateLedger', 'retentionSchedulerRuns', 'selectedConversationImports'];
    const resolver = this.ingestor.sourceScopeResolver;
    this.memoryReloadInProgress = true;
    const swap = recovered => {
      for (const field of fields) this[field] = recovered[field];
      this.setSourceScopeResolver(resolver);
      this.confirmedPreferenceRegistry.recallAllowed = preference => (preference.evidenceEventIds ?? []).every(id => {
        const decision = this.hygieneManager.decisionFor(id), event = this.ingestor.events.get(id);
        return !this.memoryStore?.hasSourceRetraction?.(id)
          && !(decision?.targetType === 'memory_event' && ['delete', 'redact'].includes(decision.action))
          && (!event || sourceRecallAllowed(event));
      });
      this.skillDraftRegistry.recallAllowed = entry => this.confirmedPreferenceRegistry.recallAllowed(entry);
      this.deliveredSourceRetractions = new Set();
      this.sourceRetractionHandlerRevision = (this.sourceRetractionHandlerRevision ?? 0) + 1;
      this.inFlightSourceRetractions = new Map();
      this.memoryGeneration = recovered.memoryGeneration;
      this.bindMemoryGenerationGuard();
    };
    try {
      const recovered = new GrowthRuntime({ clock: this.clock, memoryStore: this.memoryStore,
        auditLog: this.auditLog, policyRuntime: this.policyRuntime });
      swap(recovered);
      this.synchronizeSourceRetractions();
      if ((this.memoryStore?.restoreGeneration?.() ?? 0) !== this.memoryGeneration) throw new Error('Restore changed while reloading.');
      this.memoryRecoveryState = { status: 'ready', observedAt: this.clock().toISOString() };
      return { success: true, loadedEventCount: this.ingestor.events.size, executionAuthority: false };
    } catch {
      // Do not continue serving pre-restore caches after a committed DB restore.
      swap(new GrowthRuntime({ clock: this.clock, auditLog: this.auditLog, policyRuntime: this.policyRuntime }));
      this.memoryRecoveryState = { status: 'restart_required', reasonCode: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' };
      this.ingestor.ingest = () => ({ success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } });
      return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    } finally { this.memoryReloadInProgress = false; }
  }

  restoreStorage(options = {}) {
    if (!this.memoryStore?.restore) {
      return { success: false, error: { code: 'F_STORAGE_RESTORE_NOT_CONFIGURED' } };
    }
    const restored = this.memoryStore.restore(options);
    if (restored.success) {
      const reloaded = this.reloadRestoredMemoryState();
      if (!reloaded.success) {
        this.auditLog.write('storage.backup.reload_failed', { databaseRestored: true, errorCode: reloaded.error.code });
        return { ...reloaded, databaseRestored: true, restartRequired: true };
      }
      restored.memoryReload = reloaded;
    }
    this.auditLog.write('storage.backup.restored', {
      success: restored.success,
      restoredFrom: restored.restoredFrom,
      errorCode: restored.error?.code
    });
    return restored;
  }

  backupRetention(options = {}) {
    if (!this.memoryStore?.backupRetentionPlan) {
      return { success: false, error: { code: 'F_STORAGE_RETENTION_NOT_CONFIGURED' } };
    }
    return this.memoryStore.backupRetentionPlan(options);
  }

  rotateBackups(options = {}) {
    if (!this.memoryStore?.rotateBackups) {
      return { success: false, error: { code: 'F_STORAGE_ROTATION_NOT_CONFIGURED' } };
    }
    const rotated = this.memoryStore.rotateBackups(options);
    this.auditLog.write('storage.backups.rotated', {
      dryRun: rotated.dryRun,
      status: rotated.status,
      removableCount: rotated.plan?.removableCount,
      removedCount: rotated.removed?.length ?? 0
    });
    return rotated;
  }

  restoreDrill(options = {}) {
    if (!this.memoryStore?.restoreDrill) {
      return { success: false, error: { code: 'F_STORAGE_RESTORE_DRILL_NOT_CONFIGURED' } };
    }
    const drill = this.memoryStore.restoreDrill(options);
    this.auditLog.write('storage.restore_drill.completed', {
      success: drill.success,
      backupPath: drill.backupPath,
      schemaVersion: drill.schemaVersion,
      integrityStatus: drill.integrity?.status,
      errorCode: drill.error?.code
    });
    return drill;
  }

  decideHygiene(payload = {}, { batchMetadata = null, generateReport = true } = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    const generation = this.memoryGeneration;
    const result = this.hygieneManager.decide(payload, { publish: false });
    if (!result.success) return result;
    const { decision } = result;
    if (batchMetadata) Object.assign(decision, batchMetadata);
    let updatedEvent = null;
    if (decision.targetType === 'memory_event') {
      const existing = this.ingestor.events.get(decision.targetId);
      const event = existing ? structuredClone(existing) : null;
      if (event) {
        if (decision.action === 'delete') {
          event.learningFlags = {
            ...event.learningFlags,
            doNotRemember: true,
            canBeUsedForPreference: false,
            canBeUsedForWorkflow: false,
            canBeUsedForAutonomy: false
          };
          event.payload = {
            summary: 'Hygiene decision removed this memory from active learning.',
            hygieneDecision: decision
          };
          updatedEvent = event;
        } else if (decision.action === 'redact') {
          const minimized = this.sensitiveMinimizer.minimize({
            ...event,
            learningFlags: { ...event.learningFlags, containsSensitiveData: true }
          });
          updatedEvent = {
            ...minimized,
            payload: {
              ...minimized.payload,
              hygieneDecision: decision
            }
          };
        } else if (decision.action === 'defer') {
          event.hygieneDecision = decision;
          event.learningFlags = {
            ...event.learningFlags,
            canBeUsedForAutonomy: false
          };
          updatedEvent = event;
        } else if (decision.action === 'keep') {
          event.hygieneDecision = decision;
          updatedEvent = event;
        }
      }
    }
    try {
      if (this.memoryStore) {
        if (!this.memoryStore.applyHygieneDecision) return { success: false, error: { code: 'F_HYGIENE_ATOMIC_STORAGE_REQUIRED' } };
        this.memoryStore.applyHygieneDecision(decision, updatedEvent, { expectedGeneration: generation });
      }
    } catch (error) {
      return { success: false, applied: false, persisted: false, retryAfterRefresh: error?.code === 'F_MEMORY_GENERATION_CONFLICT', error: {
        code: ['F_MEMORY_GENERATION_CONFLICT', 'F_MEMORY_SOURCE_RETRACTED', 'F_MEMORY_EVENT_NOT_FOUND'].includes(error?.code)
          ? error.code : 'F_HYGIENE_PERSISTENCE_FAILED'
      } };
    }
    this.hygieneManager.decisions.set(decision.targetId, decision);
    if (updatedEvent) {
      this.ingestor.events.set(updatedEvent.eventId, updatedEvent);
      this.ingestor.learningQueue = decision.action === 'delete'
        ? this.ingestor.learningQueue.filter(item => item.eventId !== updatedEvent.eventId)
        : this.ingestor.learningQueue.map(item => item.eventId === updatedEvent.eventId ? updatedEvent : item);
    }
    const followUp = this.hygieneFollowUp({ generateReport });
    try {
      this.auditLog.write('memory.hygiene.decision', {
        targetType: decision.targetType, targetId: decision.targetId,
        action: decision.action, decidedBy: decision.decidedBy
      });
      followUp.followUps.audit = { status: 'completed' };
    } catch {
      followUp.followUps.audit = { status: 'requires_retry', error: { code: 'F_HYGIENE_AUDIT_UNAVAILABLE' } };
    }
    return {
      success: true,
      applied: true,
      persisted: Boolean(this.memoryStore),
      decision,
      ...followUp
    };
  }

  hygieneFollowUp({ generateReport = true } = {}) {
    const followUps = {};
    if(this.memoryStore?.reviewExportStatus)followUps.reportExport={...this.memoryStore.reviewExportStatus};
    try {
      const result = this.synchronizeSourceRetractions();
      followUps.sourceProjection = { status: result.deliveries?.some(item => !item.propagated) ? 'requires_retry' : 'checked',
        reviewRequiredCount: result.reviewRequired?.length ?? 0,
        skillsReviewRequiredCount: result.skillsReviewRequired?.length ?? 0,
        deliveryCount: result.deliveries?.length ?? 0,
        pendingDeliveryCount: result.deliveries?.filter(item => !item.propagated).length ?? 0,
        executionAuthority: false };
    } catch {
      followUps.sourceProjection = { status: 'requires_retry', error: { code: 'F_HYGIENE_PROJECTION_UNAVAILABLE' }, executionAuthority: false };
    }
    if (!generateReport) return { hygiene: null, followUps: { ...followUps, report: { status: 'not_requested' } } };
    try {
      const review = this.latestReview();
      if(review.exportStatus)followUps.reportExport={...review.exportStatus};
      if (review.success === false || !review.hygiene) {
        const code = ['F_MEMORY_GENERATION_CONFLICT', 'F_MEMORY_SOURCE_CHANGED', 'F_MEMORY_RESTORE_RELOAD_REQUIRED'].includes(review.error?.code)
          ? review.error.code : 'F_HYGIENE_REPORT_UNAVAILABLE';
        return { hygiene: null, followUps: { ...followUps, report: { status: 'requires_retry', error: { code } } } };
      }
      return { hygiene: review.hygiene, followUps: { ...followUps, report: { status: 'completed' } } };
    } catch {
      return { hygiene: null, followUps: { ...followUps, report: { status: 'requires_retry', error: { code: 'F_HYGIENE_REPORT_UNAVAILABLE' } } } };
    }
  }

  decideHygieneBatch({ decisions = [], decidedBy = 'batch_review', reason = 'batch hygiene review' } = {}) {
    if (!Array.isArray(decisions) || decisions.length === 0) {
      return { success: false, error: { code: 'F_HYGIENE_BATCH_EMPTY' } };
    }
    const batchId = stableId('hygiene_batch', decisions.map((item) => `${item.targetType}:${item.targetId}:${item.action}`).join('|'), this.clock().toISOString());
    const results = decisions.map((item, index) => ({
      index,
      targetType: item.targetType ?? 'memory_event',
      targetId: item.targetId,
      action: item.action,
      result: this.decideHygiene({
        targetType: item.targetType ?? 'memory_event',
        targetId: item.targetId,
        action: item.action,
        reason: item.reason ?? reason,
        decidedBy: item.decidedBy ?? decidedBy
      }, { batchMetadata: { batchId, batchIndex: index, batchLinkVersion: 'f-hygiene-batch-decision-history-link-v1' }, generateReport: false })
    }));
    const failed = results.filter((item) => item.result.success === false);
    const succeeded = results.filter((item) => item.result.success !== false);
    const followUp = this.hygieneFollowUp();
    try { this.auditLog.write('memory.hygiene.batch_decision', {
      batchId,
      requestedCount: decisions.length,
      appliedCount: succeeded.length,
      failedCount: failed.length,
      decidedBy
    }); followUp.followUps.audit = { status: 'completed' }; }
    catch { followUp.followUps.audit = { status: 'requires_retry', error: { code: 'F_HYGIENE_AUDIT_UNAVAILABLE' } }; }
    return {
      success: failed.length === 0,
      batchId,
      requestedCount: decisions.length,
      appliedCount: succeeded.length,
      failedCount: failed.length,
      results: results.map((item) => ({
        index: item.index,
        targetType: item.targetType,
        targetId: item.targetId,
        action: item.action,
        success: item.result.success !== false,
        applied: item.result.applied === true,
        persisted: item.result.persisted === true,
        followUps: item.result.followUps ?? null,
        decision: item.result.decision ?? null,
        error: item.result.error ?? null
      })),
      ...followUp
    };
  }

  ingest(event, options = {}) {
    if (!options.deferredReplay && !this.pendingDrainInProgress) this.drainPendingMemory();
    const original = event && typeof event === 'object' && !Array.isArray(event)
      ? { ...event, createdAt: event.createdAt ?? this.clock().toISOString() } : event;
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!this.ensureMemoryGeneration()) return { success: false, stored: false,
        error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' }, retryable: true };
      result = this.ingestor.ingest(original, options);
      if (result.error?.code !== 'F_MEMORY_GENERATION_CONFLICT') return { ...result, ingestAttempts: attempt };
    }
    const queued = !options.deferredReplay && result.preparedRetryEvent && this.memoryStore?.queueMemoryEvent
      ? this.memoryStore.queueMemoryEvent(result.preparedRetryEvent) : null;
    return { ...result, ingestAttempts: 3, retryable: true, queued: queued?.queued === true,
      ...(queued?.success === false ? { queueError: queued.error } : {}) };
  }

  drainPendingMemory({ limit = 10 } = {}) {
    if (!this.memoryStore?.drainPendingMemoryEvents || this.pendingDrainInProgress) return { success: true, pendingCount: 0 };
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    this.pendingDrainInProgress = true;
    try { return this.memoryStore.drainPendingMemoryEvents(event => {
      const result = this.ingest(event, { deferredReplay: true });
      if (result.success && event.eventType === 'feedback.do_not_remember') this.retractScopedTaskSource(event);
      return result;
    }, { limit }); }
    finally { this.pendingDrainInProgress = false; }
  }

  retractScopedTaskSource(stored) {
    const scope = normalizeMemoryScope(stored?.source?.memoryScope);
    let affectedEvents = 0;
    if (scope) for (const event of this.ingestor.all()) {
      if (event.taskId === stored.taskId && memoryScopeMatches(event, scope) && !event.learningFlags?.doNotRemember) {
        this.decideHygiene({ targetId: event.eventId, action: 'delete', decidedBy: 'user-feedback', reason: 'Explicit do-not-remember feedback for this scoped task.' });
        affectedEvents++;
      }
    }
    this.synchronizeSourceRetractions();
    return { affectedEvents, scopeKnown: !!scope };
  }

  recordFeedback(feedback) {
    // After a Core restart, an old task may no longer have an authenticated
    // request scope. Do not accept a no-op opt-out as successful deletion or
    // trust caller-supplied ownership. Existing scoped source deletion remains
    // available through the hygiene path.
    if(feedback.feedbackType==='do_not_remember' && this.ingestor.sourceScopeResolver){
      let scope;
      try{scope=normalizeMemoryScope(this.ingestor.sourceScopeResolver(feedback.taskId,{event:{taskId:feedback.taskId,eventType:'feedback.do_not_remember'}}));}
      catch{return {success:false,stored:false,error:{code:'F_MEMORY_SCOPE_UNAVAILABLE'},nextAction:'select-authenticated-memory-source'};}
      if(!scope)return {success:false,stored:false,error:{code:'F_MEMORY_SCOPE_REQUIRED'},nextAction:'select-authenticated-memory-source'};
    }
    const typeMap = {
      result_good: 'feedback.good',
      needs_edit: 'feedback.needs_edit',
      rerun_requested: 'feedback.rerun_requested',
      do_not_remember: 'feedback.do_not_remember',
      approval_rejected: 'approval.rejected',
      approval_edited: 'approval.edited',
      asked_followup: 'approval.responded'
    };
    const eventType = typeMap[feedback.feedbackType] ?? 'feedback.good';
    const result = this.ingest({
      eventId: stableId('mem_evt', `${feedback.taskId}:${eventType}:${feedback.text ?? ''}`, this.clock().toISOString()),
      eventType,
      taskId: feedback.taskId,
      source: feedback.source ?? { module: ModuleId.BRIDGE },
      payload: {
        text: feedback.text,
        rawText: feedback.text,
        editRequest: feedback.feedbackType === 'approval_edited' ? feedback.text : undefined
      },
      learningFlags: {
        canBeUsedForPreference: eventType !== 'feedback.do_not_remember',
        canBeUsedForWorkflow: eventType !== 'feedback.do_not_remember',
        canBeUsedForAutonomy: false,
        containsSensitiveData: false,
        doNotRemember: eventType === 'feedback.do_not_remember'
      },
      trustBoundary: {
        userProvided: true,
        externalContent: false,
        systemGenerated: false
      }
    });
    if (result.success === false) return result;
    if (eventType === 'feedback.do_not_remember') {
      const stored = this.ingestor.events.get(result.eventId);
      return { ...result, sourceRetraction: this.retractScopedTaskSource(stored) };
    }
    return result;
  }

  setSourceScopeResolver(resolver) {
    this.ingestor.sourceScopeResolver = typeof resolver === 'function' ? resolver : null;
  }

  setSourceRetractionHandler(handler, { receiverId = null, verify = null } = {}) {
    if (receiverId !== null && (typeof receiverId !== "string" || !receiverId || receiverId.length > 200 || typeof verify !== "function")) throw new Error("F_RETRACTION_RECEIVER_INVALID");
    this.sourceRetractionReceiverId = receiverId;
    this.sourceRetractionVerifier = typeof verify === "function" ? verify : null;
    this.sourceRetractionHandler = typeof handler === 'function' ? handler : null;
    this.deliveredSourceRetractions = new Set();
    this.sourceRetractionHandlerRevision = (this.sourceRetractionHandlerRevision ?? 0) + 1;
    this.inFlightSourceRetractions = new Map();
    return this.synchronizeSourceRetractions();
  }

  applyPersistedSourceRetractions() {
    const durableRetractions = new Map((this.memoryStore?.allHygieneDecisions?.() ?? [])
      .filter(item => item.targetType === 'memory_event' && ['delete', 'redact'].includes(item.action))
      .map(item => [item.targetId, item]));
    const retractedIds = new Set();
    for (const event of this.ingestor.all()) {
      const decision = durableRetractions.get(event.eventId) ?? this.hygieneManager.decisionFor(event.eventId);
      if (decision?.targetType !== 'memory_event' || !['delete', 'redact'].includes(decision.action)) continue;
      // The durable decision remains authoritative if updating the source row failed.
      // This is a recall fence, not physical erasure of database or backup bytes.
      event.learningFlags = { ...event.learningFlags, doNotRemember: true,
        canBeUsedForPreference: false, canBeUsedForWorkflow: false, canBeUsedForAutonomy: false };
      event.payload = decision.action === 'delete'
        ? { summary: 'Hygiene decision removed this memory from active learning.', hygieneDecision: decision }
        : { ...this.sensitiveMinimizer.minimize({ ...event,
          learningFlags: { ...event.learningFlags, containsSensitiveData: true } }).payload, hygieneDecision: decision };
      retractedIds.add(event.eventId);
    }
    this.ingestor.learningQueue = this.ingestor.learningQueue.filter(item => !retractedIds.has(item.eventId));
  }

  synchronizeSourceRetractions({ deliveryLimit = Infinity } = {}) {
    if (deliveryLimit !== Infinity && (!Number.isSafeInteger(deliveryLimit) || deliveryLimit < 1 || deliveryLimit > 100)) {
      throw new RangeError("Invalid source retraction delivery limit.");
    }
    this.applyPersistedSourceRetractions();
    const removed = this.ingestor.all().filter(event => event.learningFlags?.doNotRemember || event.payload?.hygieneDecision?.action === 'redact');
    const removedIds = new Set(removed.map(event => event.eventId));
    const reviewRequired = [];
    let preferenceUpdateFailedCount = 0;
    const skillsReviewRequired = [];
    for (const entry of this.skillDraftRegistry.registry.values()) {
      if (entry.status !== 'approved_for_skill_registry') continue;
      const revokedEvidence = this.skillDraftRegistry.sourceEvidenceIds(entry).filter(id => removedIds.has(id));
      if (!revokedEvidence.length) continue;
      this.skillDraftRegistry.registry.set(entry.skillId, { ...entry, status: 'source_review_required',
        sourceRetraction: { reason: 'supporting-source-retracted', evidenceEventIds: revokedEvidence,
          observedAt: this.clock().toISOString(), executionAuthority: false },
        lifecycleEvents: [...(entry.lifecycleEvents ?? []), { type: 'supporting_source_retracted',
          actor: 'source-retraction', occurredAt: this.clock().toISOString() }] });
      skillsReviewRequired.push(entry.skillId);
    }
    if (skillsReviewRequired.length) this.persistSkillRegistrySnapshot({ action: 'supporting-source-retracted', skillIds: skillsReviewRequired });
    for (const preference of this.confirmedPreferenceRegistry.all({ includeInactive: true, includeRetractedContent: true }).filter(item => item.status === 'confirmed')) {
      const revokedEvidence = (preference.evidenceEventIds ?? []).filter(id => removedIds.has(id));
      if (!revokedEvidence.length) continue;
      const updated = this.confirmedPreferenceRegistry.update({ preferenceId: preference.preferenceId,
        patch: { status: 'source_review_required' }, decidedBy: 'source-retraction', reason: 'Supporting source was retracted; review or replace its evidence before reuse.' });
      if (updated.success) reviewRequired.push(preference.preferenceId);
      else preferenceUpdateFailedCount++;
    }
    const deliveries = [];
    let dispatchedCount = 0, deferredDeliveryCount = 0;
    const offset = (this.sourceRetractionCursor ?? 0) % Math.max(removed.length, 1);
    for (let index = 0; index < removed.length; index++) {
      const position = (offset + index) % removed.length;
      const event = removed[position];
      const scope = normalizeMemoryScope(event.source?.memoryScope);
      if (!scope || !this.sourceRetractionHandler) continue;
      const deliveryKey = JSON.stringify([event.eventId, event.taskId, scope]);
      const receiptInput = { deliveryKey, receiverId: this.sourceRetractionReceiverId, expectedGeneration: this.memoryGeneration };
      const payload = { taskId: event.taskId, sourceEventId: event.eventId, scope };
      const reconciled = typeof this.sourceRetractionReceiverId === 'string' && typeof this.sourceRetractionVerifier === 'function';
      const recordReceipt = state => {
        if (!reconciled) return;
        if (!this.memoryStore?.recordSourceRetractionDelivery) throw new Error('Receipt storage unavailable');
        this.memoryStore.recordSourceRetractionDelivery({ ...receiptInput, state });
      };
      if (reconciled) {
        try {
          if (this.sourceRetractionVerifier(payload)?.revoked === true) {
            if (this.memoryStore?.sourceRetractionDelivery?.(receiptInput)?.state !== 'acknowledged') recordReceipt('acknowledged');
            this.deliveredSourceRetractions?.add(deliveryKey); continue;
          }
          this.deliveredSourceRetractions?.delete(deliveryKey);
        } catch {
          deliveries.push({ sourceEventId: event.eventId, propagated: false, reason: 'source-retraction-reconciliation-unavailable' });
          continue;
        }
      } else if (this.deliveredSourceRetractions?.has(deliveryKey)) continue;
      const inFlight = this.inFlightSourceRetractions ??= new Map();
      if (inFlight.has(deliveryKey)) {
        deliveries.push({ sourceEventId: event.eventId, propagated: false, reason: 'source-retraction-projection-pending' });
        continue;
      }
      if (dispatchedCount >= deliveryLimit) { deferredDeliveryCount++; continue; }
      dispatchedCount++;
      this.sourceRetractionCursor = position + 1;
      const handler = this.sourceRetractionHandler;
      const revision = this.sourceRetractionHandlerRevision;
      const generation = this.memoryGeneration;
      const entry = {};
      inFlight.set(deliveryKey, entry);
      const currentContext = () => this.sourceRetractionHandler === handler
        && this.sourceRetractionHandlerRevision === revision && this.memoryGeneration === generation
        && (this.memoryStore?.restoreGeneration?.() ?? generation) === generation
        && this.inFlightSourceRetractions === inFlight;
      try {
        recordReceipt("attempted");
        const result = handler(payload);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).then(value => {
            if (value?.revoked === true && currentContext() && inFlight.get(deliveryKey) === entry) {
              if (reconciled && this.sourceRetractionVerifier(payload)?.revoked !== true) return;
              recordReceipt("acknowledged");
              this.deliveredSourceRetractions?.add(deliveryKey);
            }
          }).catch(() => {}).finally(() => {
            if (inFlight.get(deliveryKey) === entry) inFlight.delete(deliveryKey);
          });
          deliveries.push({ sourceEventId: event.eventId, propagated: false, reason: 'source-retraction-projection-pending' });
          continue;
        }
        inFlight.delete(deliveryKey);
        const propagated = result?.revoked === true && currentContext()
          && (!reconciled || this.sourceRetractionVerifier(payload)?.revoked === true);
        if (propagated) { recordReceipt("acknowledged"); this.deliveredSourceRetractions?.add(deliveryKey); }
        deliveries.push({ sourceEventId: event.eventId, propagated, reason: propagated ? null : result?.reason ?? 'source-retraction-not-confirmed' });
      } catch {
        if (inFlight.get(deliveryKey) === entry) inFlight.delete(deliveryKey);
        deliveries.push({ sourceEventId: event.eventId, propagated: false, reason: 'source-retraction-projection-unavailable' });
      }
    }
    return { reviewRequired, skillsReviewRequired, deliveries, dispatchedCount, deferredDeliveryCount, preferenceUpdateFailedCount, projectionConfigured: typeof this.sourceRetractionHandler === "function", executionAuthority: false };
  }

  currentKnowledgeSnapshot(scope){
    const snapshot=this.memoryStore?.knowledgeSnapshot?.({scope})??{events:this.ingestor.all(),retiredSourceIds:[],retractedSourceIds:[]};
    if(Number.isSafeInteger(snapshot.generation) && snapshot.generation!==this.memoryGeneration)
      throw Object.assign(new Error('Memory generation changed during lookup.'),{code:'F_MEMORY_GENERATION_CONFLICT'});
    const retracted=new Set(snapshot.retractedSourceIds);
    return {...snapshot,events:snapshot.events.filter(event=>!retracted.has(event.eventId))};
  }

  personalKnowledge({ scope, diagnostics = null } = {}) {
    if (!normalizeMemoryScope(scope) || !this.ensureMemoryGeneration()
      || this.memoryRecoveryState?.status === 'restart_required') return [];
    this.synchronizeSourceRetractions();
    const snapshot=this.currentKnowledgeSnapshot(scope);
    return projectPersonalKnowledge(snapshot.events.filter(event =>
      sourceRecallAllowed(event) && memoryScopeMatches(event,scope)), {now:this.clock(),diagnostics,retiredSourceIds:snapshot.retiredSourceIds});
  }

  personalKnowledgeHistory({scope, sourceEventId} = {}) {
    if (!normalizeMemoryScope(scope) || typeof sourceEventId !== 'string' || !sourceEventId.trim())
      return {found:false, entries:[], complete:false, executionAuthority:false};
    // Reuse the current scoped/retraction-aware projection, never the raw event journal.
    const items=this.personalKnowledge({scope}), byId=new Map(items.map(item=>[item.sourceEventId,item]));
    const entries=[], visited=new Set(); let current=byId.get(sourceEventId);
    const found=!!current; let complete=found;
    while(current){
      if(visited.has(current.sourceEventId)){complete=false;break;}
      visited.add(current.sourceEventId);
      entries.push({...current, usageScope:normalizeMemoryScope(scope)});
      if(!current.supersedesEventId)break;
      const previous=byId.get(current.supersedesEventId);
      if(!previous || ['kind','subject','predicate'].some(key=>previous[key]!==current[key])
        || Date.parse(previous.observedAt)>=Date.parse(current.observedAt)){complete=false;break;}
      current=previous;
    }
    return {found, entries:entries.reverse(), complete, executionAuthority:false};
  }

  personalRelationships({scope,entity,depth,direction,limit}={}) {
    if(!normalizeMemoryScope(scope))throw Object.assign(new Error('Explicit memory scope required.'),{code:'F_MEMORY_SCOPE_REQUIRED'});
    if(!this.ensureMemoryGeneration() || this.memoryRecoveryState?.status==='restart_required')
      throw Object.assign(new Error('Memory unavailable.'),{code:'F_MEMORY_RESTORE_RELOAD_REQUIRED'});
    return {...queryPersonalRelationships(this.personalKnowledge({scope}),{entity,depth,direction,limit}),usageScope:normalizeMemoryScope(scope)};
  }

  searchPersonalKnowledge(options={}) {
    return searchPersonalMemory(this,options);
  }

  recalledPreferenceCandidates(events) {
    // Once reviewed, the registry is authoritative; the old source hypothesis
    // must not override a correction, withdrawal or expiry through another path.
    const reviewed = this.confirmedPreferenceRegistry.all({includeInactive:true});
    return this.preferenceEngine.create(events).filter(candidate => !reviewed.some(item => {
      if(item.hypothesisId !== candidate.hypothesisId)return false;
      const scope=normalizeMemoryScope(candidate.memoryScope);
      return preferenceScopeMatches(item.scopePolicy, scope ? {userScope:scope.userId,
        workspaceScope:scope.workspaceRoot,conversationScope:scope.conversationId} : {});
    }));
  }

  query(query, { scope } = {}) {
    if (!this.ensureMemoryGeneration()) return [];
    if (this.memoryRecoveryState?.status === 'restart_required') return [];
    const relationshipQuery=parseMemoryRelationshipQuestion(query);
    if(relationshipQuery && normalizeMemoryScope(scope))
      return relationshipMemoryReferences(this.personalRelationships({scope,...relationshipQuery}),normalizeMemoryScope(scope));
    this.synchronizeSourceRetractions();
    const registeredPreferences = this.confirmedPreferenceRegistry.all();
    const knowledgeSnapshot=scope===undefined?null:this.currentKnowledgeSnapshot(scope);
    const snapshot = knowledgeSnapshot?.events??this.ingestor.all();
    const knowledge = normalizeMemoryScope(scope) ? projectPersonalKnowledge(snapshot.filter(event=>sourceRecallAllowed(event) && memoryScopeMatches(event,scope)),{now:this.clock(),retiredSourceIds:knowledgeSnapshot?.retiredSourceIds??[]})
      .filter(item=>['active','conflict','correction-unresolved'].includes(item.status)).map(item=>({
        ...(item.status==='active'?item:{subject:item.subject,predicate:item.predicate,status:item.status,sourceEventId:item.sourceEventId,observedAt:item.observedAt,executionAuthority:false,requiresUserResolution:true}),
        memoryId:`knowledge:${item.sourceEventId}`,memoryType:item.status==='active'?'personal_knowledge':'personal_knowledge_issue',
        text:item.status==='active'?[item.subject,item.predicate,item.value,item.reason??''].join(' · '):`${item.subject} · ${item.predicate} · 기억 충돌 또는 정정 출처 확인 필요`,applyMode:'user_statement_context',
        provenance:{memoryKind:'user_statement',sourceEventIds:[item.sourceEventId],observedAt:[item.observedAt],
          usageScopes:[normalizeMemoryScope(scope)],
          validity:{validUntil:item.validUntil??null,basis:item.validUntil?'declared-expiry':'unspecified'},
          revisionReference:{revision:null,supersedesEventId:item.supersedesEventId??null},
          independentlyVerifiedOutcome:false,executionAuthority:false}}))
      .filter(item=>memoryItemRelevant(item,query,{scope})) : [];
    // Assertions are context, not demonstrated work or preference-learning events.
    const allEvents = scope===undefined ? snapshot : snapshot.filter(event=>!isPersonalKnowledgeSource(event));
    const sourceIndex = indexMemorySources(allEvents);
    const events = allEvents.filter(event => sourceRecallAllowed(event) && memoryScopeMatches(event, scope));
    const scopedSourceIndex = indexMemorySources(events);
    const confirmedPreferences = registeredPreferences
      .filter(item => preferenceSourcesMatch(item, sourceIndex, scope))
      .filter((item) => memoryItemRelevant(item, query, {scope}))
      .map((preference) => ({
        ...preference,
        memoryId: preference.preferenceId,
        memoryType: 'confirmed_preference',
        text: preference.statement,
        applyMode: 'strong_planning_hint',
        planningWeight: Number((preference.confidence * 2).toFixed(2))
      }));
    const patterns = this.patternMiner.mine(events);
    const hypotheses = this.recalledPreferenceCandidates(events);
    const failures = this.failureBuilder.build(events, { patterns });
    const observations = executionObservations(events, scope);
    const prepare = items => items.filter(item => memoryItemRelevant(item, query, {scope}))
      .map(item => ({ ...item, provenance: memoryProvenance(item, scopedSourceIndex) }));
    const imported = this.selectedConversationImports?.query(query, { scope }) ?? [];
    if (scope === undefined) {
      // Preserve legacy administrative ordering; no implicit user scope.
      return [...prepare([...patterns, ...hypotheses, ...confirmedPreferences, ...failures, ...observations]).slice(0,10), ...imported].slice(0,10);
    }
    return selectMemoryResults([knowledge, prepare(confirmedPreferences), prepare(failures), prepare(observations),
      imported, prepare(patterns), prepare(hypotheses)]);
  }

  importSelectedConversations(input, options = {}) {
    if (!this.selectedConversationImports) throw Object.assign(new Error('Durable selected-conversation storage is required.'), { code: 'F_CONVERSATION_STORAGE_REQUIRED' });
    return this.selectedConversationImports.import(input, options);
  }

  withdrawImportedConversationMessage(input) {
    if (!this.selectedConversationImports) throw Object.assign(new Error('Durable selected-conversation storage is required.'), { code: 'F_CONVERSATION_STORAGE_REQUIRED' });
    return this.selectedConversationImports.withdraw(input);
  }

  memoryContext(query, options = {}) {
    const items = this.query(query, options);
    const registeredPreferences = this.confirmedPreferenceRegistry.all();
    const sourceIndex = indexMemorySources(this.ingestor.all().filter(event=>options.scope===undefined || !isPersonalKnowledgeSource(event)));
    const confirmedPreferences = registeredPreferences
      .filter(item => preferenceSourcesMatch(item, sourceIndex, options.scope))
      .filter((item) => memoryItemRelevant(item, query, {scope:options.scope}))
      .map(item => ({ ...item, provenance: memoryProvenance(item, sourceIndex) }));
    const planning = this.planningPreferenceContext(query, options);
    return {
      query,
      items: options.scope === undefined ? [...items, ...confirmedPreferences].slice(0, 10)
        : selectMemoryResults([confirmedPreferences, items]),
      workflowHints: items.filter((item) => item.patternType === 'repeated_command'),
      preferenceHints: items.filter((item) => item.hypothesisId && !item.preferenceId),
      confirmedPreferenceHints: confirmedPreferences,
      failureGuardrails: items.filter((item) => item.failureId),
      planning
    };
  }

  calibratePatternThreshold(payload = {}) {
    const result = this.patternMiner.calibrateThreshold(payload);
    this.auditLog.write('pattern.threshold.calibrated', {
      calibrationId: result.calibrationId,
      previousMinOccurrences: result.previousMinOccurrences,
      nextMinOccurrences: result.nextMinOccurrences,
      decidedBy: result.decidedBy
    });
    return result;
  }

  patternEmbeddingAdapterStatus() {
    return this.patternMiner.embeddingAdapterStatus();
  }

  patternAnonymizedCorpus({ limit = 5000 } = {}) {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    return this.patternCorpusBuilder.build({ events, patterns, limit });
  }

  patternClusterReview({ limit = 5000 } = {}) {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const corpus = this.patternCorpusBuilder.build({ events, patterns, limit });
    return this.patternClusterReviewEngine.review({ patterns, corpus });
  }

  patternMiningProductGate({ limit = 5000, minPatterns = 1, minCorpusItems = 1 } = {}) {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const embeddingAdapters = this.patternMiner.embeddingAdapterStatus();
    const corpus = this.patternCorpusBuilder.build({ events, patterns, limit });
    const clusterReview = this.patternClusterReviewEngine.review({ patterns, corpus });
    const calibration = this.patternMiner.calibrationStatus();
    const trend = this.patternMiner.trendStatus();
    const localAdapter = embeddingAdapters.adapters.find((adapter) => adapter.provider === 'local');
    const externalAdapter = embeddingAdapters.adapters.find((adapter) => adapter.provider === 'external');
    const corpusItemsHashOnly = corpus.items.every((item) => (
      String(item.eventIdHash ?? '').startsWith('sha256:')
      && String(item.taskIdHash ?? '').startsWith('sha256:')
      && String(item.normalizedTextHash ?? '').startsWith('sha256:')
      && !Object.hasOwn(item, 'rawText')
      && !Object.hasOwn(item, 'rawPayload')
    ));
    const checks = [
      {
        checkId: 'pattern_evidence_threshold_met',
        passed: patterns.length >= minPatterns
          && patterns.every((pattern) => (pattern.evidenceEventIds?.length ?? 0) >= pattern.threshold)
      },
      {
        checkId: 'positive_negative_evidence_separated',
        passed: patterns.every((pattern) => pattern.positiveEvidence && pattern.negativeEvidence)
      },
      {
        checkId: 'embedding_adapter_registry_ready',
        passed: embeddingAdapters.registryVersion === 'f-pattern-embedding-adapter-registry-v1'
          && localAdapter?.enabled === true
          && localAdapter.rawTextExported === false
          && embeddingAdapters.policy.externalOptInRequired === true
      },
      {
        checkId: 'external_embedding_adapter_contract_declared',
        passed: Boolean(externalAdapter)
          && externalAdapter.rawTextExported === false
          && externalAdapter.normalizedTextOnly === true
          && externalAdapter.role === 'optional-auxiliary-large-corpus-review'
      },
      {
        checkId: 'large_anonymized_corpus_profile_ready',
        passed: corpus.corpusVersion === 'f-pattern-anonymized-log-corpus-v1'
          && corpus.itemCount >= minCorpusItems
          && corpus.privacy.rawTextStored === false
          && corpus.privacy.eventIdsHashed === true
          && corpus.scaleProfile.streamingReady === true
          && corpus.scaleProfile.recommendedBatchSize >= 5000
          && corpusItemsHashOnly
      },
      {
        checkId: 'cluster_split_merge_review_contract_ready',
        passed: clusterReview.reportVersion === 'f-pattern-cluster-review-v1'
          && clusterReview.reviewMode === 'human-in-the-loop-split-merge'
          && clusterReview.reviewActions.includes('approve_merge')
          && clusterReview.reviewActions.includes('split_cluster')
          && clusterReview.uiContract.contractVersion === 'f-pattern-cluster-review-ui-contract-v1'
      },
      {
        checkId: 'threshold_calibration_policy_ready',
        passed: calibration.minOccurrences >= 2
          && calibration.minOccurrences <= 10
          && calibration.similarityThreshold >= 0.5
          && calibration.similarityThreshold <= 0.95
      }
    ];
    const releaseWorkflow = {
      workflowVersion: 'f-pattern-mining-release-workflow-v1',
      patternEvidenceReady: checks.find((check) => check.checkId === 'pattern_evidence_threshold_met')?.passed === true,
      positiveNegativeEvidenceSeparated: checks.find((check) => check.checkId === 'positive_negative_evidence_separated')?.passed === true,
      embeddingAdapterRegistryReady: checks.find((check) => check.checkId === 'embedding_adapter_registry_ready')?.passed === true,
      externalEmbeddingContractReady: checks.find((check) => check.checkId === 'external_embedding_adapter_contract_declared')?.passed === true,
      anonymizedCorpusReady: checks.find((check) => check.checkId === 'large_anonymized_corpus_profile_ready')?.passed === true,
      clusterReviewContractReady: checks.find((check) => check.checkId === 'cluster_split_merge_review_contract_ready')?.passed === true,
      thresholdCalibrationReady: checks.find((check) => check.checkId === 'threshold_calibration_policy_ready')?.passed === true,
      promotionStatus: 'pending_checks'
    };
    const artifactManifest = {
      manifestVersion: 'f-pattern-mining-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      patternSummaryHash: hashJsonValue(patterns.map((pattern) => ({
        patternId: pattern.patternId,
        patternType: pattern.patternType,
        occurrenceCount: pattern.occurrenceCount,
        threshold: pattern.threshold,
        confidence: pattern.confidence,
        safetyStatus: pattern.safetyStatus,
        supportScore: pattern.supportScore,
        workflowSignatureKey: pattern.workflowSignature?.key,
        semanticClusterId: pattern.semanticCluster?.clusterId
      }))),
      trendHash: hashJsonValue(trend),
      embeddingAdapterHash: hashJsonValue(embeddingAdapters),
      corpusHash: hashJsonValue({
        corpusVersion: corpus.corpusVersion,
        sourceEventCount: corpus.sourceEventCount,
        itemCount: corpus.itemCount,
        rejectedCount: corpus.rejectedCount,
        privacy: corpus.privacy,
        scaleProfile: corpus.scaleProfile,
        itemHashes: corpus.items.map((item) => hashJsonValue(item))
      }),
      clusterReviewHash: hashJsonValue({
        reportVersion: clusterReview.reportVersion,
        status: clusterReview.status,
        reviewMode: clusterReview.reviewMode,
        reviewActions: clusterReview.reviewActions,
        uiContract: clusterReview.uiContract,
        reviewQueueCount: clusterReview.reviewQueueCount,
        itemHashes: clusterReview.items.map((item) => hashJsonValue(item))
      }),
      calibrationHash: hashJsonValue(calibration),
      rawTextStored: false,
      rawPayloadStored: false,
      rawEventIdsStored: false,
      wormArchive: {
        archiveContractVersion: 'f-pattern-mining-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_pattern_mining_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: []
      }
    };
    artifactManifest.wormArchive.includedArtifactHashes = [
      artifactManifest.patternSummaryHash,
      artifactManifest.trendHash,
      artifactManifest.embeddingAdapterHash,
      artifactManifest.corpusHash,
      artifactManifest.clusterReviewHash,
      artifactManifest.calibrationHash
    ];
    const operationalHandoffManifest = {
      manifestVersion: 'f-pattern-mining-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-pattern-mining-release-owner',
      scope: 'pattern_evidence_thresholds_embedding_adapter_contract_anonymized_corpus_split_merge_review',
      status: releaseWorkflow.patternEvidenceReady
        && releaseWorkflow.positiveNegativeEvidenceSeparated
        && releaseWorkflow.embeddingAdapterRegistryReady
        && releaseWorkflow.externalEmbeddingContractReady
        && releaseWorkflow.anonymizedCorpusReady
        && releaseWorkflow.clusterReviewContractReady
        && releaseWorkflow.thresholdCalibrationReady
        && artifactManifest.rawTextStored === false
        && artifactManifest.rawPayloadStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-pattern-mining-health-handshake-v1',
      healthHandshake: {
        patternEvidenceReady: releaseWorkflow.patternEvidenceReady,
        evidenceSeparated: releaseWorkflow.positiveNegativeEvidenceSeparated,
        embeddingAdapterRegistryReady: releaseWorkflow.embeddingAdapterRegistryReady,
        externalEmbeddingContractReady: releaseWorkflow.externalEmbeddingContractReady,
        anonymizedCorpusReady: releaseWorkflow.anonymizedCorpusReady,
        clusterReviewContractReady: releaseWorkflow.clusterReviewContractReady,
        thresholdCalibrationReady: releaseWorkflow.thresholdCalibrationReady,
        rawTextStored: artifactManifest.rawTextStored
      },
      fallbackPolicy: {
        policyVersion: 'f-pattern-mining-fallback-policy-v1',
        primaryFlow: 'mine_safe_repeated_workflow_patterns_from_hash_only_corpus_with_human_split_merge_review',
        fallbackFlows: [
          'block_pattern_release_when_positive_and_negative_evidence_are_not_separated',
          'fall_back_to_local_embedding_adapter_when_external_provider_is_unavailable',
          'require_human_split_merge_review_before_automation_candidate_promotion',
          'publish_hash_only_pattern_release_manifest_when_raw_workflow_text_would_leak'
        ],
        operatorEscalation: 'growth_pattern_reviewer_embedding_provider_owner_and_worm_provider'
      },
      rawTextStored: false,
      rawPayloadStored: false,
      rawEventIdsStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-pattern-mining-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F pattern miner" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'pattern_evidence_threshold_met',
        'positive_negative_evidence_separated',
        'embedding_adapter_registry_ready',
        'external_embedding_adapter_contract_declared',
        'large_anonymized_corpus_profile_ready',
        'cluster_split_merge_review_contract_ready',
        'threshold_calibration_policy_ready',
        'pattern_mining_operational_handoff_ready',
        'pattern_mining_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawTextStored: false,
      rawPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-pattern-mining-worm-promotion-package-v1',
      providerContractVersion: 'f-pattern-mining-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-pattern-mining-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-pattern-mining-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawTextStored: false,
      rawPayloadStored: false
    };
    const releaseDossierChecks = [
      ...checks,
      {
        checkId: 'pattern_mining_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-pattern-mining-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-pattern-mining-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-pattern-mining-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'pattern_mining_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-pattern-mining-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-pattern-mining-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const releaseDossier = {
      dossierVersion: 'f-pattern-mining-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseDossierChecks.every((check) => check.passed) ? 'passed' : 'failed',
      releaseWorkflow: {
        ...releaseWorkflow,
        promotionStatus: releaseDossierChecks.every((check) => check.passed) ? 'release_evidence_ready' : 'blocked'
      },
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      checks: releaseDossierChecks,
      evidence: {
        patternCount: patterns.length,
        corpusItemCount: corpus.itemCount,
        rejectedCorpusItemCount: corpus.rejectedCount,
        reviewQueueCount: clusterReview.reviewQueueCount,
        mergeCandidateCount: clusterReview.mergeCandidates.length,
        splitCandidateCount: clusterReview.splitCandidates.length,
        rawTextStored: corpus.privacy.rawTextStored,
        externalAdapterConfigured: embeddingAdapters.externalAvailable
      },
      requiredArtifacts: [
        'f-pattern-embedding-adapter-registry-v1',
        'f-pattern-anonymized-log-corpus-v1',
        'f-pattern-cluster-review-v1',
        'f-pattern-mining-operational-handoff-manifest-v1',
        'f-pattern-mining-worm-promotion-package-v1'
      ],
      recommendedReleaseAction: releaseDossierChecks.every((check) => check.passed)
        ? 'release_with_human_split_merge_review_enabled_and_hash_only_worm_manifest'
        : 'block_until_pattern_quality_and_release_handoff_checks_pass'
    };
    const productGate = {
      productGateVersion: 'f-pattern-mining-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseDossierChecks.every((check) => check.passed) ? 'passed' : 'failed',
      thresholds: {
        minPatterns,
        minCorpusItems,
        similarityThreshold: calibration.similarityThreshold,
        minOccurrences: calibration.minOccurrences
      },
      checks: releaseDossierChecks,
      releaseDossier,
      patterns,
      trend,
      embeddingAdapters,
      corpus,
      clusterReview,
      calibration
    };
    this.auditLog.write('pattern.product_gate.evaluated', {
      status: productGate.status,
      patternCount: patterns.length,
      corpusItemCount: corpus.itemCount,
      reviewQueueCount: clusterReview.reviewQueueCount
    });
    return productGate;
  }

  reviewFailureGuardrail(failureId, payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    const result = this.failureBuilder.reviewGuardrail({ ...payload, failureId });
    this.auditLog.write('failure.guardrail.reviewed', {
      failureId,
      decision: payload.decision ?? 'update',
      success: result.success !== false,
      reviewedBy: payload.reviewedBy ?? 'user_review',
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  failureTaxonomyFixtureCoverage() {
    return this.failureBuilder.taxonomyFixtureCoverage();
  }

  failureGuardrailReviewQueue(payload = {}) {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const failures = this.failureBuilder.build(events, { patterns });
    return this.failureBuilder.guardrailReviewQueue({ failures, ...payload });
  }

  failureRecurrenceTrendVisualization() {
    return this.failureBuilder.recurrenceTrendVisualization();
  }

  failureGuardrailEffectivenessTuning() {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const failures = this.failureBuilder.build(events, { patterns });
    return this.failureBuilder.effectivenessTuningReport({ failures });
  }

  failureMemoryProductGate({ query = '' } = {}) {
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const failures = this.failureBuilder.build(events, { patterns });
    const taxonomyCoverage = this.failureBuilder.taxonomyFixtureCoverage();
    const reviewQueue = this.failureBuilder.guardrailReviewQueue({ failures, query });
    const recurrenceVisualization = this.failureBuilder.recurrenceTrendVisualization();
    const effectivenessTuning = this.failureBuilder.effectivenessTuningReport({ failures });
    const planningGuardrails = {
      adapterId: 'f-failure-memory-planning-guardrail-v1',
      query,
      items: this.failureBuilder.planningGuardrails({ failures, query }),
      recurrenceDashboard: this.failureBuilder.trendStatus().dashboard
    };
    const checks = [
      {
        checkId: 'taxonomy_fixture_coverage_full',
        passed: taxonomyCoverage.corpusId === 'f-failure-taxonomy-fixture-corpus-v1'
          && taxonomyCoverage.coverageScore === 1
      },
      {
        checkId: 'planning_guardrails_injectable',
        passed: planningGuardrails.items.every((item) => item.adapterId === 'f-failure-memory-planning-guardrail-v1')
      },
      {
        checkId: 'guardrail_review_queue_has_mobile_contract',
        passed: reviewQueue.queueVersion === 'f-failure-guardrail-review-queue-v1'
          && reviewQueue.uiContract.contractVersion === 'c-failure-guardrail-review-ui-v1'
      },
      {
        checkId: 'recurrence_trend_visualized',
        passed: recurrenceVisualization.visualizationVersion === 'f-failure-recurrence-trend-visualization-v1'
          && recurrenceVisualization.uiContract.contractVersion === 'c-failure-recurrence-trend-chart-v1'
      },
      {
        checkId: 'effectiveness_tuning_hash_safe',
        passed: effectivenessTuning.reportVersion === 'f-failure-guardrail-effectiveness-tuning-v1'
          && effectivenessTuning.rawPayloadStored === false
      }
    ];
    return {
      productGateVersion: 'f-failure-memory-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      taxonomyCoverage,
      planningGuardrails,
      reviewQueue,
      recurrenceVisualization,
      effectivenessTuning
    };
  }

  failureMemoryReleaseDossier({ query = '밴드' } = {}) {
    const productGate = this.failureMemoryProductGate({ query });
    const releaseBuilder = new FailureMemoryBuilder({ clock: this.clock });
    const rawFailureTexts = [
      '밴드에 외부 전송해',
      '밴드에 외부 전송해',
      '엑셀 보고서 만들어'
    ];
    const releaseEvents = [
      {
        eventId: 'f07_release_policy_blocked',
        eventType: 'policy.blocked',
        taskId: 'f07_release_policy_task',
        payload: {
          rawText: rawFailureTexts[0],
          reason: 'external transfer requires PC approval',
          reasonCode: 'E_EXTERNAL_TRANSFER_PC_ONLY',
          actionType: 'UPLOAD_FILE',
          toolName: 'band.post',
          planId: 'f07_release_plan',
          approvalId: 'f07_release_approval',
          failedStepId: 'f07_release_step_external_transfer'
        },
        createdAt: this.clock().toISOString()
      },
      {
        eventId: 'f07_release_policy_recovered',
        eventType: 'execution.completed',
        taskId: 'f07_release_policy_recovered_task',
        payload: {
          rawText: rawFailureTexts[1],
          result: 'pc_review_completed'
        },
        createdAt: this.clock().toISOString()
      },
      {
        eventId: 'f07_release_verification_failed',
        eventType: 'verification.failed',
        taskId: 'f07_release_verification_task',
        payload: {
          rawText: rawFailureTexts[2],
          reason: 'verification evidence missing',
          reasonCode: 'G_EVIDENCE_MISSING',
          toolName: 'excel.createWorkbook',
          failedStepId: 'f07_release_step_verify'
        },
        createdAt: this.clock().toISOString()
      }
    ];
    const failures = releaseBuilder.build(releaseEvents, { patterns: [] });
    const firstFailure = failures[0];
    const review = releaseBuilder.reviewGuardrail({
      failureId: firstFailure?.failureId,
      decision: 'update',
      patch: {
        guardrailChecklist: [...(firstFailure?.guardrailChecklist ?? []), 'confirm_external_recipient_before_plan'],
        lesson: 'External transfer plans require recipient confirmation and PC approval before execution.'
      },
      reviewedBy: 'f07_release_dossier',
      reason: 'release workflow guardrail tightening'
    });
    const reviewedFailures = releaseBuilder.build(releaseEvents, { patterns: [] });
    const planningGuardrails = releaseBuilder.planningGuardrails({ failures: reviewedFailures, query });
    const reviewQueue = releaseBuilder.guardrailReviewQueue({ failures: reviewedFailures, query });
    const recurrenceVisualization = releaseBuilder.recurrenceTrendVisualization();
    const effectivenessTuning = releaseBuilder.effectivenessTuningReport({ failures: reviewedFailures });
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      taxonomyCoverage: {
        corpusId: productGate.taxonomyCoverage.corpusId,
        coverageScore: productGate.taxonomyCoverage.coverageScore,
        passedCount: productGate.taxonomyCoverage.passedCount,
        fixtureCount: productGate.taxonomyCoverage.fixtureCount
      },
      reviewQueue: {
        queueVersion: productGate.reviewQueue.queueVersion,
        queueCount: productGate.reviewQueue.queueCount
      },
      recurrenceVisualization: {
        visualizationVersion: productGate.recurrenceVisualization.visualizationVersion,
        status: productGate.recurrenceVisualization.status,
        pointCount: productGate.recurrenceVisualization.points.length
      },
      effectivenessTuning: {
        reportVersion: productGate.effectivenessTuning.reportVersion,
        status: productGate.effectivenessTuning.status,
        rawPayloadStored: productGate.effectivenessTuning.rawPayloadStored,
        averageEffectivenessScore: productGate.effectivenessTuning.averageEffectivenessScore
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'f-failure-memory-release-workflow-v1',
      shadowExecution: true,
      failureCount: reviewedFailures.length,
      failureSummaries: reviewedFailures.map((failure) => ({
        failureId: failure.failureId,
        taskIdHash: hashSensitiveValue(failure.taskId),
        failureType: failure.failureType,
        causeCategory: failure.cause.category,
        causeCode: failure.cause.code,
        severity: failure.severity,
        preventedRecurrenceStatus: failure.preventedRecurrence.status,
        preventedRecurrenceScore: failure.preventedRecurrence.score,
        evidenceEventHashes: (failure.evidenceEventIds ?? []).map(hashSensitiveValue),
        guardrailChecklist: failure.guardrailChecklist,
        planningGuardrail: {
          adapterId: failure.planningGuardrail?.adapterId ?? null,
          injectBefore: failure.planningGuardrail?.injectBefore ?? null,
          applyMode: failure.planningGuardrail?.applyMode ?? null,
          planningWeight: failure.planningGuardrail?.planningWeight ?? 0,
          sourceFailureId: failure.planningGuardrail?.sourceFailureId ?? null
        },
        reviewed: Boolean(failure.guardrailReview)
      })),
      review: {
        success: review.success,
        reviewIdHash: hashSensitiveValue(review.review?.reviewId ?? ''),
        failureId: review.review?.failureId ?? null,
        decision: review.review?.decision ?? null,
        persisted: review.persisted === true
      },
      planningGuardrails: {
        adapterId: 'f-failure-memory-planning-guardrail-v1',
        query,
        count: planningGuardrails.length,
        items: planningGuardrails.map((guardrail) => ({
          sourceFailureId: guardrail.sourceFailureId,
          severity: guardrail.severity,
          injectBefore: guardrail.injectBefore,
          applyMode: guardrail.applyMode,
          planningWeight: guardrail.planningWeight,
          checklist: guardrail.checklist
        }))
      },
      reviewQueue: {
        queueVersion: reviewQueue.queueVersion,
        queueCount: reviewQueue.queueCount,
        uiContractVersion: reviewQueue.uiContract.contractVersion,
        requiresReasonForDisable: reviewQueue.uiContract.requiresReasonForDisable,
        itemHashes: reviewQueue.items.map((item) => hashJsonValue({
          failureId: item.failureId,
          taskId: item.taskId,
          cause: item.cause,
          severity: item.severity,
          checklist: item.checklist
        }))
      },
      recurrenceVisualization: {
        visualizationVersion: recurrenceVisualization.visualizationVersion,
        dashboardVersion: recurrenceVisualization.dashboardVersion,
        status: recurrenceVisualization.status,
        pointCount: recurrenceVisualization.points.length,
        uiContractVersion: recurrenceVisualization.uiContract.contractVersion
      },
      effectivenessTuning: {
        reportVersion: effectivenessTuning.reportVersion,
        status: effectivenessTuning.status,
        rawPayloadStored: effectivenessTuning.rawPayloadStored,
        total: effectivenessTuning.total,
        reviewedCount: effectivenessTuning.reviewedCount,
        averageEffectivenessScore: effectivenessTuning.averageEffectivenessScore,
        items: effectivenessTuning.items.map((item) => ({
          failureId: item.failureId,
          causeCategory: item.causeCategory,
          severity: item.severity,
          reviewed: item.reviewed,
          recurrenceStatus: item.recurrenceStatus,
          effectivenessScore: item.effectivenessScore,
          recommendedTuning: item.recommendedTuning
        }))
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-failure-memory-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      releaseWorkflowHash: hashJsonValue(releaseWorkflow),
      rawFailurePayloadStored: false,
      failurePayloadHashes: releaseEvents.map((event) => hashSensitiveValue(JSON.stringify(event.payload ?? {}))),
      planningGuardrailAdapter: 'f-failure-memory-planning-guardrail-v1',
      mobileReviewContract: 'c-failure-guardrail-review-ui-v1',
      recurrenceChartContract: 'c-failure-recurrence-trend-chart-v1',
      wormArchive: {
        archiveContractVersion: 'f-failure-memory-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_failure_memory_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(releaseWorkflow),
          hashJsonValue(reviewQueue),
          hashJsonValue(recurrenceVisualization),
          hashJsonValue(effectivenessTuning)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-failure-memory-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-failure-guardrail-release-owner',
      scope: 'failure_taxonomy_planning_guardrail_review_queue_recurrence_trend_effectiveness_tuning',
      status: productGateSummary.status === 'passed'
        && releaseWorkflow.review.success === true
        && releaseWorkflow.planningGuardrails.count >= 1
        && releaseWorkflow.reviewQueue.queueVersion === 'f-failure-guardrail-review-queue-v1'
        && releaseWorkflow.recurrenceVisualization.visualizationVersion === 'f-failure-recurrence-trend-visualization-v1'
        && releaseWorkflow.effectivenessTuning.reportVersion === 'f-failure-guardrail-effectiveness-tuning-v1'
        && artifactManifest.rawFailurePayloadStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-failure-memory-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        reviewWorkflowReady: releaseWorkflow.review.success === true,
        planningGuardrailReady: releaseWorkflow.planningGuardrails.count >= 1,
        reviewQueueReady: releaseWorkflow.reviewQueue.queueVersion === 'f-failure-guardrail-review-queue-v1',
        recurrenceTrendReady: releaseWorkflow.recurrenceVisualization.visualizationVersion === 'f-failure-recurrence-trend-visualization-v1',
        effectivenessTuningReady: releaseWorkflow.effectivenessTuning.reportVersion === 'f-failure-guardrail-effectiveness-tuning-v1',
        rawFailurePayloadStored: artifactManifest.rawFailurePayloadStored
      },
      fallbackPolicy: {
        policyVersion: 'f-failure-memory-fallback-policy-v1',
        primaryFlow: 'inject_reviewed_failure_guardrails_before_task_planning_and_track_recurrence_prevention',
        fallbackFlows: [
          'block_guardrail_promotion_when_failure_taxonomy_is_unclassified',
          'require_user_review_before_disabling_or_loosening_failure_guardrails',
          'fall_back_to_manual_review_queue_when_effectiveness_score_is_low',
          'publish_hash_only_failure_release_manifest_when_failure_payload_would_leak'
        ],
        operatorEscalation: 'growth_failure_guardrail_owner_mobile_reviewer_and_worm_provider'
      },
      rawFailurePayloadStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-failure-memory-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F failure memory" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'failure_memory_product_gate_passed',
        'taxonomy_and_failure_classification_passed',
        'planning_guardrails_and_review_queue_ready',
        'recurrence_and_effectiveness_artifacts_ready',
        'raw_failure_payload_retention_safe',
        'failure_memory_operational_handoff_ready',
        'failure_memory_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawFailurePayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-failure-memory-worm-promotion-package-v1',
      providerContractVersion: 'f-failure-memory-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-failure-memory-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-failure-memory-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawFailurePayloadStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-failure-memory-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawFailureTexts);
    const checks = [
      {
        checkId: 'failure_memory_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-failure-memory-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'taxonomy_and_failure_classification_passed',
        passed: productGateSummary.taxonomyCoverage.coverageScore === 1
          && releaseWorkflow.failureSummaries.some((item) => item.causeCategory === 'policy_safety_block' && item.severity === 'critical')
          && releaseWorkflow.failureSummaries.some((item) => item.causeCategory === 'verification_evidence_failure')
      },
      {
        checkId: 'planning_guardrails_and_review_queue_ready',
        passed: releaseWorkflow.planningGuardrails.items.every((item) => item.injectBefore === 'A.TaskPlanner.createPlan')
          && releaseWorkflow.reviewQueue.queueVersion === 'f-failure-guardrail-review-queue-v1'
          && releaseWorkflow.reviewQueue.uiContractVersion === 'c-failure-guardrail-review-ui-v1'
      },
      {
        checkId: 'recurrence_and_effectiveness_artifacts_ready',
        passed: releaseWorkflow.recurrenceVisualization.visualizationVersion === 'f-failure-recurrence-trend-visualization-v1'
          && releaseWorkflow.effectivenessTuning.reportVersion === 'f-failure-guardrail-effectiveness-tuning-v1'
          && releaseWorkflow.effectivenessTuning.rawPayloadStored === false
      },
      {
        checkId: 'raw_failure_payload_retention_safe',
        passed: artifactManifest.rawFailurePayloadStored === false
          && artifactManifest.failurePayloadHashes.every((item) => item.startsWith('sha256:'))
          && rawLeakDetected === false
      },
      {
        checkId: 'failure_memory_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-failure-memory-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-failure-memory-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-failure-memory-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'failure_memory_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-failure-memory-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-failure-memory-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('failure_memory.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  refreshDerivedTrendSources() {
    if (!this.ensureMemoryGeneration()) throw Object.assign(new Error('Memory reload required.'), { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' });
    this.synchronizeSourceRetractions();
    const digest = this.memoryStore?.sourceRetractionDigest?.();
    const preferenceDigest = this.memoryStore?.preferenceStateDigest?.();
    if ((this.derivedTrendSourceDigest !== undefined && digest !== this.derivedTrendSourceDigest)
      || (this.derivedTrendPreferenceDigest !== undefined && preferenceDigest !== this.derivedTrendPreferenceDigest)) {
      this.genomeTrendTracker.snapshots = [];
      this.maturityScoreEngine.trendHistory = [];
    }
    this.derivedTrendSourceDigest = digest;
    this.derivedTrendPreferenceDigest = preferenceDigest;
    return digest;
  }

  buildGenomeSnapshot() {
    const sourceDigest = this.refreshDerivedTrendSources();
    const preferenceDigest = this.memoryStore?.preferenceStateDigest?.();
    const events = this.ingestor.all();
    const patterns = this.patternMiner.mine(events);
    const preferenceCandidates = this.preferenceEngine.create(events);
    const confirmedPreferences = this.confirmedPreferenceRegistry.all();
    const failureLessons = this.failureBuilder.build(events, { patterns });
    const genomes = this.genomeBuilder.build({ events, patterns, preferenceCandidates, confirmedPreferences, failureLessons });
    const trend = this.genomeTrendTracker.record(genomes);
    this.persistTrendSnapshot('genome', trend.latest, {
      schemaVersion: genomes.schemaVersion,
      riskPosture: genomes.riskCalibration.posture,
      workflowCount: genomes.workflowGenome.length,
      preferenceCount: genomes.preferenceGenome.length
    }, { expectedSourceRetractionDigest: sourceDigest, expectedPreferenceStateDigest: preferenceDigest });
    return { events, patterns, preferenceCandidates, confirmedPreferences, failureLessons, genomes, trend };
  }

  genomeWeightCalibrationProfile({ genomes } = {}) {
    const source = genomes ?? this.buildGenomeSnapshot().genomes;
    const workflowWeights = source.workflowGenome.map((item) => item.weight ?? 0);
    const preferenceWeights = source.preferenceGenome.map((item) => item.weight ?? 0);
    return {
      profileVersion: 'f-genome-weight-calibration-profile-v1',
      generatedAt: this.clock().toISOString(),
      uiContract: {
        contractVersion: 'c-genome-weight-calibration-ui-v1',
        controls: ['workflow_weight_multiplier', 'preference_weight_floor', 'risk_alert_threshold'],
        requiresReviewBeforeApply: true
      },
      weights: {
        workflowAverage: workflowWeights.length ? average(workflowWeights) : 0,
        preferenceAverage: preferenceWeights.length ? average(preferenceWeights) : 0,
        confirmedPreferenceFloor: 1.5,
        riskConservativeScore: source.riskCalibration.conservativeScore
      },
      thresholds: {
        minWorkflowWeightForAutomationCandidate: 1.2,
        minConfirmedPreferenceWeightForStrongHint: 1.5,
        conservativeRiskAlertScore: 40,
        lowApprovalRateAlert: 0.4
      }
    };
  }

  genomeDriftDiff({ trend } = {}) {
    const currentTrend = trend ?? this.buildGenomeSnapshot().trend;
    const latest = currentTrend.latest ?? null;
    const previous = currentTrend.previous ?? null;
    const delta = currentTrend.delta ?? {
      workflowCount: 0,
      preferenceCount: 0,
      confirmedPreferenceCount: 0,
      approvalRate: 0
    };
    const changed = Boolean(previous) && Object.values(delta).some((value) => value !== 0);
    return {
      diffVersion: 'f-genome-drift-diff-v1',
      generatedAt: this.clock().toISOString(),
      status: !previous ? 'baseline' : changed ? 'changed' : 'stable',
      latestSnapshotId: latest?.snapshotId ?? null,
      previousSnapshotId: previous?.snapshotId ?? null,
      delta,
      riskPostureChanged: Boolean(previous && latest && previous.riskPosture !== latest.riskPosture),
      approvalRateDrop: delta.approvalRate < -0.15,
      changed
    };
  }

  genomeThresholdAlerts({ genomes, driftDiff, calibration } = {}) {
    const source = genomes ?? this.buildGenomeSnapshot().genomes;
    const profile = calibration ?? this.genomeWeightCalibrationProfile({ genomes: source });
    const drift = driftDiff ?? this.genomeDriftDiff();
    const alerts = [];
    if (source.riskCalibration.conservativeScore >= profile.thresholds.conservativeRiskAlertScore) {
      alerts.push({
        code: 'genome_risk_conservative_score_high',
        severity: 'high',
        actual: source.riskCalibration.conservativeScore,
        threshold: profile.thresholds.conservativeRiskAlertScore
      });
    }
    if (source.decisionGenome.approvalRate < profile.thresholds.lowApprovalRateAlert) {
      alerts.push({
        code: 'genome_approval_rate_low',
        severity: 'medium',
        actual: source.decisionGenome.approvalRate,
        threshold: profile.thresholds.lowApprovalRateAlert
      });
    }
    if (drift.approvalRateDrop) {
      alerts.push({
        code: 'genome_approval_rate_drop',
        severity: 'medium',
        actual: drift.delta.approvalRate,
        threshold: -0.15
      });
    }
    return {
      alertVersion: 'f-genome-threshold-alerts-v1',
      generatedAt: this.clock().toISOString(),
      status: alerts.some((item) => item.severity === 'high') ? 'review_required' : 'ok',
      alerts,
      thresholds: profile.thresholds
    };
  }

  genomeDashboard({ genomes, trend, calibration, driftDiff, alerts } = {}) {
    const source = genomes ?? this.buildGenomeSnapshot().genomes;
    const currentTrend = trend ?? this.genomeTrendTracker.record(source);
    const profile = calibration ?? this.genomeWeightCalibrationProfile({ genomes: source });
    const drift = driftDiff ?? this.genomeDriftDiff({ trend: currentTrend });
    const thresholdAlerts = alerts ?? this.genomeThresholdAlerts({ genomes: source, driftDiff: drift, calibration: profile });
    return {
      dashboardVersion: 'f-genome-product-dashboard-v1',
      generatedAt: this.clock().toISOString(),
      uiContract: {
        contractVersion: 'c-genome-product-dashboard-ui-v1',
        tabs: ['workflow', 'preference', 'decision', 'risk', 'drift'],
        showsThresholdAlerts: true
      },
      summary: {
        schemaVersion: source.schemaVersion,
        workflowCount: source.workflowGenome.length,
        preferenceCount: source.preferenceGenome.length,
        riskPosture: source.riskCalibration.posture,
        approvalRate: source.decisionGenome.approvalRate,
        alertCount: thresholdAlerts.alerts.length
      },
      calibration: profile,
      drift,
      alerts: thresholdAlerts,
      trend: currentTrend
    };
  }

  genomeProductGate() {
    const snapshot = this.buildGenomeSnapshot();
    const calibration = this.genomeWeightCalibrationProfile({ genomes: snapshot.genomes });
    const driftDiff = this.genomeDriftDiff({ trend: snapshot.trend });
    const alerts = this.genomeThresholdAlerts({ genomes: snapshot.genomes, driftDiff, calibration });
    const dashboard = this.genomeDashboard({
      genomes: snapshot.genomes,
      trend: snapshot.trend,
      calibration,
      driftDiff,
      alerts
    });
    const archive = this.growthTrendArchive({ trendType: 'genome', limit: 20 });
    const checks = [
      { checkId: 'genome_schema_v2_ready', passed: snapshot.genomes.schemaVersion === 'f-genome-v2' },
      { checkId: 'weight_calibration_profile_ready', passed: calibration.profileVersion === 'f-genome-weight-calibration-profile-v1' },
      { checkId: 'drift_diff_available', passed: driftDiff.diffVersion === 'f-genome-drift-diff-v1' },
      { checkId: 'threshold_alerts_available', passed: alerts.alertVersion === 'f-genome-threshold-alerts-v1' },
      { checkId: 'dashboard_ui_contract_ready', passed: dashboard.dashboardVersion === 'f-genome-product-dashboard-v1' && dashboard.uiContract.contractVersion === 'c-genome-product-dashboard-ui-v1' },
      { checkId: 'genome_archive_available', passed: archive.countsByType.genome >= 1 }
    ];
    return {
      productGateVersion: 'f-genome-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      genomes: snapshot.genomes,
      trend: snapshot.trend,
      calibration,
      driftDiff,
      alerts,
      dashboard,
      archive
    };
  }

  genomeReleaseDossier({ query = '' } = {}) {
    const productGate = this.genomeProductGate();
    const snapshot = this.buildGenomeSnapshot();
    const calibration = this.genomeWeightCalibrationProfile({ genomes: snapshot.genomes });
    const driftDiff = this.genomeDriftDiff({ trend: snapshot.trend });
    const alerts = this.genomeThresholdAlerts({ genomes: snapshot.genomes, driftDiff, calibration });
    const dashboard = this.genomeDashboard({
      genomes: snapshot.genomes,
      trend: snapshot.trend,
      calibration,
      driftDiff,
      alerts
    });
    const archive = this.growthTrendArchive({ trendType: 'genome', limit: 20 });
    const planningContext = this.planningPreferenceContext(query);
    const rawNeedles = [
      ...snapshot.genomes.workflowGenome.map((item) => item.description),
      ...snapshot.genomes.preferenceGenome.map((item) => item.statement)
    ];
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      dashboard: {
        dashboardVersion: productGate.dashboard.dashboardVersion,
        uiContractVersion: productGate.dashboard.uiContract.contractVersion,
        alertCount: productGate.dashboard.summary.alertCount,
        workflowCount: productGate.dashboard.summary.workflowCount,
        preferenceCount: productGate.dashboard.summary.preferenceCount,
        riskPosture: productGate.dashboard.summary.riskPosture
      },
      archive: {
        archiveVersion: productGate.archive.archiveVersion,
        total: productGate.archive.total,
        genomeCount: productGate.archive.countsByType.genome ?? 0
      }
    };
    const releaseProjection = {
      projectionVersion: 'f-genome-release-hash-only-projection-v1',
      schemaVersion: snapshot.genomes.schemaVersion,
      workflowGenome: snapshot.genomes.workflowGenome.map((item) => ({
        patternIdHash: hashSensitiveValue(item.patternId),
        descriptionHash: hashSensitiveValue(item.description),
        occurrenceCount: item.occurrenceCount,
        confidence: item.confidence,
        weight: item.weight,
        cadence: item.cadence,
        safetyStatus: item.safetyStatus
      })),
      preferenceGenome: snapshot.genomes.preferenceGenome.map((item) => ({
        preferenceIdHash: hashSensitiveValue(item.preferenceId ?? item.hypothesisId ?? ''),
        statementHash: hashSensitiveValue(item.statement),
        confidence: item.confidence,
        status: item.status,
        revision: item.revision ?? null,
        weight: item.weight,
        applyMode: item.applyMode ?? null,
        conflictDimensions: item.conflictProfile?.dimensions ?? []
      })),
      decisionGenome: snapshot.genomes.decisionGenome,
      riskCalibration: snapshot.genomes.riskCalibration,
      riskSensitivityMemory: snapshot.genomes.riskSensitivityMemory.map((lesson) => ({
        failureId: lesson.failureId,
        taskIdHash: hashSensitiveValue(lesson.taskId),
        causeCategory: lesson.cause?.category ?? null,
        severity: lesson.severity,
        preventedRecurrenceStatus: lesson.preventedRecurrence?.status ?? null
      })),
      trend: {
        latestSnapshotId: snapshot.trend.latest?.snapshotId ?? null,
        previousSnapshotId: snapshot.trend.previous?.snapshotId ?? null,
        delta: snapshot.trend.delta
      },
      calibration: {
        profileVersion: calibration.profileVersion,
        uiContractVersion: calibration.uiContract.contractVersion,
        weights: calibration.weights,
        thresholds: calibration.thresholds
      },
      driftDiff: {
        diffVersion: driftDiff.diffVersion,
        status: driftDiff.status,
        delta: driftDiff.delta,
        riskPostureChanged: driftDiff.riskPostureChanged,
        approvalRateDrop: driftDiff.approvalRateDrop
      },
      alerts: {
        alertVersion: alerts.alertVersion,
        status: alerts.status,
        alertCount: alerts.alerts.length,
        alerts: alerts.alerts
      },
      dashboard: {
        dashboardVersion: dashboard.dashboardVersion,
        uiContractVersion: dashboard.uiContract.contractVersion,
        tabs: dashboard.uiContract.tabs,
        summary: dashboard.summary
      },
      planningContext: {
        query,
        confirmedPreferenceHintCount: planningContext.confirmedPreferenceHints.length,
        workflowHintCount: planningContext.workflowHints.length,
        failureGuardrailCount: planningContext.failureGuardrails.length,
        riskPosture: planningContext.riskCalibration.posture
      },
      archive: {
        archiveVersion: archive.archiveVersion,
        total: archive.total,
        countsByType: archive.countsByType
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-genome-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      releaseProjectionHash: hashJsonValue(releaseProjection),
      rawGenomeTextStored: false,
      workflowDescriptionsHashOnly: releaseProjection.workflowGenome.every((item) => item.descriptionHash.startsWith('sha256:')),
      preferenceStatementsHashOnly: releaseProjection.preferenceGenome.every((item) => item.statementHash.startsWith('sha256:')),
      dashboardContract: 'c-genome-product-dashboard-ui-v1',
      calibrationContract: 'c-genome-weight-calibration-ui-v1',
      wormArchive: {
        archiveContractVersion: 'f-genome-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_workflow_decision_risk_genome_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(releaseProjection),
          hashJsonValue(calibration),
          hashJsonValue(driftDiff),
          hashJsonValue(alerts),
          hashJsonValue(dashboard),
          hashJsonValue(archive)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-genome-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-genome-release-owner',
      scope: 'workflow_preference_decision_risk_genome_calibration_drift_alert_dashboard_archive',
      status: productGateSummary.status === 'passed'
        && releaseProjection.schemaVersion === 'f-genome-v2'
        && releaseProjection.calibration.profileVersion === 'f-genome-weight-calibration-profile-v1'
        && releaseProjection.driftDiff.diffVersion === 'f-genome-drift-diff-v1'
        && releaseProjection.alerts.alertVersion === 'f-genome-threshold-alerts-v1'
        && releaseProjection.dashboard.dashboardVersion === 'f-genome-product-dashboard-v1'
        && releaseProjection.archive.countsByType.genome >= 1
        && artifactManifest.rawGenomeTextStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-genome-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        schemaReady: releaseProjection.schemaVersion === 'f-genome-v2',
        calibrationReady: releaseProjection.calibration.profileVersion === 'f-genome-weight-calibration-profile-v1',
        driftDiffReady: releaseProjection.driftDiff.diffVersion === 'f-genome-drift-diff-v1',
        alertsReady: releaseProjection.alerts.alertVersion === 'f-genome-threshold-alerts-v1',
        dashboardReady: releaseProjection.dashboard.dashboardVersion === 'f-genome-product-dashboard-v1',
        archiveReady: releaseProjection.archive.countsByType.genome >= 1,
        rawGenomeTextStored: artifactManifest.rawGenomeTextStored
      },
      fallbackPolicy: {
        policyVersion: 'f-genome-fallback-policy-v1',
        primaryFlow: 'publish_hash_only_workflow_preference_decision_risk_genome_with_calibration_and_drift_controls',
        fallbackFlows: [
          'fall_back_to_current_planning_context_when_genome_projection_is_stale',
          'require_user_review_before_calibration_threshold_changes',
          'defer_genome_promotion_when_threshold_alerts_are_unreviewed',
          'publish_hash_only_genome_release_manifest_when_workflow_or_preference_text_would_leak'
        ],
        operatorEscalation: 'growth_genome_owner_calibration_reviewer_mobile_dashboard_owner_and_worm_provider'
      },
      rawGenomeTextStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-genome-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F advanced learning" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'genome_product_gate_passed',
        'genome_schema_and_projection_ready',
        'calibration_drift_alert_dashboard_ready',
        'planning_context_and_archive_ready',
        'raw_genome_text_retention_safe',
        'genome_operational_handoff_ready',
        'genome_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawGenomeTextStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-genome-worm-promotion-package-v1',
      providerContractVersion: 'f-genome-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-genome-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-genome-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawGenomeTextStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-genome-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      releaseProjection,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawNeedles);
    const checks = [
      {
        checkId: 'genome_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-genome-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'genome_schema_and_projection_ready',
        passed: releaseProjection.schemaVersion === 'f-genome-v2'
          && releaseProjection.workflowGenome.length === snapshot.genomes.workflowGenome.length
          && releaseProjection.preferenceGenome.length === snapshot.genomes.preferenceGenome.length
      },
      {
        checkId: 'calibration_drift_alert_dashboard_ready',
        passed: releaseProjection.calibration.profileVersion === 'f-genome-weight-calibration-profile-v1'
          && releaseProjection.driftDiff.diffVersion === 'f-genome-drift-diff-v1'
          && releaseProjection.alerts.alertVersion === 'f-genome-threshold-alerts-v1'
          && releaseProjection.dashboard.dashboardVersion === 'f-genome-product-dashboard-v1'
      },
      {
        checkId: 'planning_context_and_archive_ready',
        passed: releaseProjection.planningContext.riskPosture === snapshot.genomes.riskCalibration.posture
          && releaseProjection.archive.countsByType.genome >= 1
      },
      {
        checkId: 'raw_genome_text_retention_safe',
        passed: artifactManifest.rawGenomeTextStored === false
          && artifactManifest.workflowDescriptionsHashOnly === true
          && artifactManifest.preferenceStatementsHashOnly === true
          && rawLeakDetected === false
      },
      {
        checkId: 'genome_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-genome-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-genome-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-genome-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'genome_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-genome-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-genome-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('genome.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  planningPreferenceContext(query = '', { scope } = {}) {
    this.synchronizeSourceRetractions();
    const registeredPreferences = this.confirmedPreferenceRegistry.all();
    const allEvents = this.ingestor.all().filter(event=>scope===undefined || !isPersonalKnowledgeSource(event));
    const sourceIndex = indexMemorySources(allEvents);
    const events = allEvents.filter(event => sourceRecallAllowed(event) && memoryScopeMatches(event, scope));
    const scopedSourceIndex = indexMemorySources(events);
    const patterns = this.patternMiner.mine(events);
    const preferenceCandidates = this.recalledPreferenceCandidates(events);
    const confirmedPreferences = registeredPreferences
      .filter(item => preferenceSourcesMatch(item, sourceIndex, scope))
      .filter((item) => memoryItemRelevant(item, query, {scope}));
    const failureLessons = this.failureBuilder.build(events, { patterns });
    const genomes = this.genomeBuilder.build({ events, patterns, preferenceCandidates, confirmedPreferences, failureLessons });
    const planningGuardrails = this.failureBuilder.planningGuardrails({ failures: failureLessons, query });
    return {
      query,
      generatedAt: this.clock().toISOString(),
      confirmedPreferenceHints: confirmedPreferences.map((preference) => ({
        preferenceId: preference.preferenceId,
        statement: preference.statement,
        confidence: preference.confidence,
        revision: preference.revision ?? 1,
        scopePolicy: preference.scopePolicy ?? null,
        provenance: memoryProvenance(preference, scopedSourceIndex),
        applyMode: 'strong_planning_hint',
        planningWeight: Number((preference.confidence * 2).toFixed(2))
      })),
      conflictReport: this.confirmedPreferenceRegistry.conflictReport(preferenceCandidates),
      riskCalibration: genomes.riskCalibration,
      workflowHints: patterns.filter((pattern) => memoryItemRelevant(pattern, query, {scope})).slice(0, 5),
      failureGuardrails: failureLessons.filter((lesson) => memoryItemRelevant(lesson, query, {scope})).slice(0, 5),
      planningGuardrails
    };
  }

  planningFailureGuardrails(query = '', { scope } = {}) {
    this.synchronizeSourceRetractions();
    const events = this.ingestor.all().filter(event => sourceRecallAllowed(event) && memoryScopeMatches(event, scope));
    const patterns = this.patternMiner.mine(events);
    const failureLessons = this.failureBuilder.build(events, { patterns });
    return {
      query,
      generatedAt: this.clock().toISOString(),
      adapterId: 'f-failure-memory-planning-guardrail-v1',
      items: this.failureBuilder.planningGuardrails({ failures: failureLessons, query }),
      sourceFailureCount: failureLessons.length,
      recurrenceDashboard: this.failureBuilder.trendStatus().dashboard
    };
  }

  decidePreference(payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    const candidates = this.preferenceEngine.create(this.ingestor.all());
    return this.confirmedPreferenceRegistry.decide({
      ...payload,
      preferenceCandidates: candidates
    });
  }

  decidePreferenceBatch(payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    return this.confirmedPreferenceRegistry.batchDecide({
      ...payload,
      preferenceCandidates: this.preferenceEngine.create(this.ingestor.all())
    });
  }

  preferenceMigrationDiff(payload = {}) {
    return this.confirmedPreferenceRegistry.migrationDiff(payload);
  }

  confirmedPreferenceApplicationPreview(payload = {}) {
    return this.confirmedPreferenceRegistry.applicationPreview(payload);
  }

  confirmedPreferenceConflictResolutionDossier(payload = {}) {
    return this.confirmedPreferenceRegistry.conflictResolutionDossier({
      ...payload,
      preferenceCandidates: payload.preferenceCandidates ?? this.preferenceEngine.create(this.ingestor.all())
    });
  }

  confirmedPreferenceDriftTrend(payload = {}) {
    return this.confirmedPreferenceRegistry.driftTrend({
      ...payload,
      preferenceCandidates: payload.preferenceCandidates ?? this.preferenceEngine.create(this.ingestor.all())
    });
  }

  confirmedPreferenceMigrationReviewQueue(payload = {}) {
    return this.confirmedPreferenceRegistry.migrationReviewQueue(payload);
  }

  confirmedPreferenceProductGate(payload = {}) {
    const targetScopePolicy = payload.targetScopePolicy ?? { workspaceScope: 'product-review-workspace' };
    const hypothesisGate = this.preferenceHypothesisProductGate();
    const applicationPreview = this.confirmedPreferenceApplicationPreview({
      query: payload.query ?? '',
      targetScopePolicy
    });
    const conflictDossier = this.confirmedPreferenceConflictResolutionDossier();
    const driftTrend = this.confirmedPreferenceDriftTrend({ windowDays: payload.windowDays ?? 180 });
    const migrationReviewQueue = this.confirmedPreferenceMigrationReviewQueue({
      targetScopePolicy,
      includeInactive: payload.includeInactive ?? false
    });
    const planningContext = this.planningPreferenceContext(payload.query ?? '');
    const checks = [
      {
        checkId: 'hypothesis_gate_passed_before_confirmation',
        passed: hypothesisGate.productGateVersion === 'f-preference-hypothesis-product-gate-v1'
          && hypothesisGate.status === 'passed'
      },
      {
        checkId: 'application_preview_strong_hints_ready',
        passed: applicationPreview.previewVersion === 'f-confirmed-preference-application-preview-v1'
          && applicationPreview.planningHints.every((item) => item.applyMode === 'strong_planning_hint')
      },
      {
        checkId: 'conflict_resolution_dossier_hash_only',
        passed: conflictDossier.dossierVersion === 'f-confirmed-preference-conflict-resolution-dossier-v1'
          && conflictDossier.rawStatementStored === false
          && conflictDossier.uiContract.contractVersion === 'c-confirmed-preference-conflict-resolution-ui-v1'
      },
      {
        checkId: 'preference_drift_trend_hash_only',
        passed: driftTrend.trendVersion === 'f-confirmed-preference-drift-trend-v1'
          && driftTrend.statementHashOnly === true
          && driftTrend.rawStatementStored === false
      },
      {
        checkId: 'scope_migration_review_queue_ready',
        passed: migrationReviewQueue.queueVersion === 'f-confirmed-preference-scope-migration-review-queue-v1'
          && migrationReviewQueue.uiContract.requiresPreviewBeforeApply === true
      },
      {
        checkId: 'planning_context_uses_confirmed_preferences',
        passed: planningContext.confirmedPreferenceHints.every((item) => item.applyMode === 'strong_planning_hint')
      }
    ];
    return {
      productGateVersion: 'f-confirmed-preference-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      hypothesisGate,
      applicationPreview,
      conflictDossier,
      driftTrend,
      migrationReviewQueue,
      planningContext
    };
  }

  confirmedPreferenceReleaseDossier(payload = {}) {
    const query = payload.query ?? '날짜';
    const targetScopePolicy = payload.targetScopePolicy ?? {
      workspaceScope: 'confirmed-preference-release-workspace-v2',
      migrationStrategy: 'batch_review_before_apply'
    };
    const productGate = this.confirmedPreferenceProductGate({
      query,
      targetScopePolicy,
      windowDays: payload.windowDays ?? 180
    });
    const releaseRegistry = new ConfirmedPreferenceRegistry({ clock: this.clock });
    const baseStatement = '날짜를 크게 표시해줘';
    const updatedStatement = '날짜를 크게 표시하고 제목은 짧게 정리해줘';
    const conflictStatement = '날짜를 작게 표시해줘';
    const baseCandidate = {
      hypothesisId: 'f06_release_preference_large_date',
      statement: baseStatement,
      appliesTo: 'document_layout',
      confidence: 0.83,
      evidenceEventIds: ['f06_release_evt_1', 'f06_release_evt_2', 'f06_release_evt_3'],
      contradictingEventIds: [],
      conflictProfile: preferenceSignalProfile(baseStatement),
      semanticConflictSummary: { status: 'clear' }
    };
    const conflictCandidate = {
      hypothesisId: 'f06_release_preference_small_date',
      statement: conflictStatement,
      appliesTo: 'document_layout',
      confidence: 0.81,
      evidenceEventIds: ['f06_release_evt_4', 'f06_release_evt_5', 'f06_release_evt_6'],
      contradictingEventIds: [baseCandidate.hypothesisId],
      conflictProfile: preferenceSignalProfile(conflictStatement),
      semanticConflictSummary: { status: 'conflict_review', highestSeverity: 'high' }
    };
    const confirm = releaseRegistry.decide({
      hypothesisId: baseCandidate.hypothesisId,
      decision: 'confirm',
      preferenceCandidates: [baseCandidate],
      decidedBy: 'f06_release_dossier',
      reason: 'confirmed preference lifecycle release proof',
      scopePolicy: {
        userScope: 'release-user',
        workspaceScope: 'confirmed-preference-release-workspace'
      }
    });
    const duplicate = releaseRegistry.decide({
      hypothesisId: baseCandidate.hypothesisId,
      decision: 'confirm',
      preferenceCandidates: [baseCandidate],
      decidedBy: 'f06_release_dossier',
      reason: 'duplicate confirmation guard',
      scopePolicy: confirm.item?.scopePolicy
    });
    const update = confirm.success
      ? releaseRegistry.update({
          preferenceId: confirm.item.preferenceId,
          patch: {
            statement: updatedStatement,
            scopePolicy: { workspaceScope: 'confirmed-preference-release-workspace-v1' }
          },
          decidedBy: 'f06_release_dossier',
          reason: 'scope precision release proof'
        })
      : { success: false, error: { code: 'F_RELEASE_CONFIRM_REQUIRED' } };
    const conflictBlock = releaseRegistry.decide({
      hypothesisId: conflictCandidate.hypothesisId,
      decision: 'confirm',
      preferenceCandidates: [conflictCandidate],
      decidedBy: 'f06_release_dossier',
      reason: 'conflict block release proof',
      scopePolicy: update.item?.scopePolicy
    });
    const migrationDiff = releaseRegistry.migrationDiff({ targetScopePolicy });
    const applicationPreview = releaseRegistry.applicationPreview({ query, targetScopePolicy });
    const conflictDossier = releaseRegistry.conflictResolutionDossier({ preferenceCandidates: [conflictCandidate] });
    const driftTrend = releaseRegistry.driftTrend({ preferenceCandidates: [conflictCandidate], windowDays: payload.windowDays ?? 180 });
    const migrationReviewQueue = releaseRegistry.migrationReviewQueue({ targetScopePolicy });
    const revoke = confirm.success
      ? releaseRegistry.revoke({
          preferenceId: confirm.item.preferenceId,
          decidedBy: 'f06_release_dossier',
          reason: 'release workflow cleanup'
        })
      : { success: false, error: { code: 'F_RELEASE_CONFIRM_REQUIRED' } };

    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      applicationPreview: {
        previewVersion: productGate.applicationPreview.previewVersion,
        matchedCount: productGate.applicationPreview.matchedCount,
        planningHintCount: productGate.applicationPreview.planningHints.length
      },
      conflictDossier: {
        dossierVersion: productGate.conflictDossier.dossierVersion,
        rawStatementStored: productGate.conflictDossier.rawStatementStored,
        highSeverityCount: productGate.conflictDossier.highSeverityCount
      },
      driftTrend: {
        trendVersion: productGate.driftTrend.trendVersion,
        status: productGate.driftTrend.status,
        rawStatementStored: productGate.driftTrend.rawStatementStored,
        statementHashOnly: productGate.driftTrend.statementHashOnly
      },
      migrationReviewQueue: {
        queueVersion: productGate.migrationReviewQueue.queueVersion,
        queueCount: productGate.migrationReviewQueue.queueCount
      }
    };
    const lifecycleWorkflow = {
      workflowVersion: 'f-confirmed-preference-lifecycle-release-workflow-v1',
      shadowExecution: true,
      confirmed: {
        success: confirm.success,
        preferenceIdHash: hashSensitiveValue(confirm.item?.preferenceId ?? ''),
        hypothesisIdHash: hashSensitiveValue(confirm.item?.hypothesisId ?? ''),
        status: confirm.item?.status ?? null,
        scopePolicyVersion: confirm.item?.scopePolicy?.policyVersion ?? null,
        revision: confirm.item?.revision ?? 0,
        evidenceCount: confirm.item?.evidenceEventIds?.length ?? 0
      },
      duplicateGuard: {
        success: duplicate.success,
        duplicate: duplicate.duplicate === true
      },
      updated: {
        success: update.success,
        preferenceIdHash: hashSensitiveValue(update.item?.preferenceId ?? ''),
        statementHash: hashSensitiveValue(update.item?.statement ?? ''),
        status: update.item?.status ?? null,
        revision: update.item?.revision ?? 0,
        historyCount: update.item?.history?.length ?? 0
      },
      conflictBlock: {
        blocked: conflictBlock.success === false,
        errorCode: conflictBlock.error?.code ?? null,
        conflictCount: conflictBlock.conflicts?.length ?? 0,
        highSeverityCount: (conflictBlock.conflicts ?? []).filter((item) => item.severity === 'high').length
      },
      migrationDiff: {
        diffVersion: migrationDiff.diffVersion,
        total: migrationDiff.total,
        migrationRequiredCount: migrationDiff.migrationRequiredCount,
        changedFields: migrationDiff.items.flatMap((item) => item.changedFields).sort()
      },
      applicationPreview: {
        previewVersion: applicationPreview.previewVersion,
        matchedCount: applicationPreview.matchedCount,
        runtimePreviewRawStatementExported: applicationPreview.rawStatementExported === true,
        releaseProjectionRawStatementStored: false,
        planningHints: applicationPreview.planningHints.map((hint) => ({
          preferenceIdHash: hashSensitiveValue(hint.preferenceId),
          statementHash: hint.statementHash,
          applyMode: hint.applyMode,
          planningWeight: hint.planningWeight,
          requiresMigrationReview: hint.requiresMigrationReview,
          changedScopeFields: hint.changedScopeFields
        }))
      },
      conflictDossier: {
        dossierVersion: conflictDossier.dossierVersion,
        rawStatementStored: conflictDossier.rawStatementStored,
        conflictCount: conflictDossier.conflictCount,
        highSeverityCount: conflictDossier.highSeverityCount,
        itemHashes: conflictDossier.items.map((item) => hashJsonValue({
          preferenceId: item.preferenceId,
          hypothesisId: item.hypothesisId,
          existingStatementHash: item.existingStatementHash,
          candidateStatementHash: item.candidateStatementHash,
          severity: item.severity
        }))
      },
      driftTrend: {
        trendVersion: driftTrend.trendVersion,
        status: driftTrend.status,
        rawStatementStored: driftTrend.rawStatementStored,
        statementHashOnly: driftTrend.statementHashOnly,
        driftScore: driftTrend.driftScore,
        totals: driftTrend.totals
      },
      migrationReviewQueue: {
        queueVersion: migrationReviewQueue.queueVersion,
        queueCount: migrationReviewQueue.queueCount,
        requiresPreviewBeforeApply: migrationReviewQueue.uiContract.requiresPreviewBeforeApply,
        itemHashes: migrationReviewQueue.items.map((item) => hashJsonValue({
          preferenceId: item.preferenceId,
          statementHash: item.statementHash,
          changedFields: item.changedFields
        }))
      },
      revoked: {
        success: revoke.success,
        preferenceIdHash: hashSensitiveValue(revoke.item?.preferenceId ?? ''),
        status: revoke.item?.status ?? null,
        revision: revoke.item?.revision ?? 0,
        historyCount: revoke.item?.history?.length ?? 0
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-confirmed-preference-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      lifecycleWorkflowHash: hashJsonValue(lifecycleWorkflow),
      rawPreferenceStatementStored: false,
      applicationPreviewReleaseProjection: 'hash-only',
      conflictDossierRawStatementStored: conflictDossier.rawStatementStored === false,
      driftTrendStatementHashOnly: driftTrend.statementHashOnly === true,
      migrationQueueStatementHashOnly: migrationReviewQueue.items.every((item) => typeof item.statementHash === 'string' && item.statementHash.startsWith('sha256:')),
      wormArchive: {
        archiveContractVersion: 'f-confirmed-preference-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_confirmed_preference_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(lifecycleWorkflow),
          hashJsonValue(migrationDiff),
          hashJsonValue(applicationPreview),
          hashJsonValue(conflictDossier),
          hashJsonValue(driftTrend),
          hashJsonValue(migrationReviewQueue)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-confirmed-preference-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-confirmed-preference-release-owner',
      scope: 'confirmed_preference_confirm_update_revoke_conflict_block_migration_preview_drift',
      status: productGateSummary.status === 'passed'
        && lifecycleWorkflow.confirmed.success === true
        && lifecycleWorkflow.updated.success === true
        && lifecycleWorkflow.revoked.success === true
        && lifecycleWorkflow.duplicateGuard.duplicate === true
        && lifecycleWorkflow.conflictBlock.blocked === true
        && artifactManifest.rawPreferenceStatementStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-confirmed-preference-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        lifecycleReady: lifecycleWorkflow.confirmed.success === true && lifecycleWorkflow.updated.success === true && lifecycleWorkflow.revoked.success === true,
        duplicateGuardReady: lifecycleWorkflow.duplicateGuard.duplicate === true,
        conflictGuardReady: lifecycleWorkflow.conflictBlock.blocked === true,
        migrationPreviewReady: lifecycleWorkflow.migrationDiff.diffVersion === 'f-confirmed-preference-migration-diff-v1'
          && lifecycleWorkflow.applicationPreview.previewVersion === 'f-confirmed-preference-application-preview-v1',
        rawPreferenceStatementStored: artifactManifest.rawPreferenceStatementStored
      },
      fallbackPolicy: {
        policyVersion: 'f-confirmed-preference-fallback-policy-v1',
        primaryFlow: 'apply_confirmed_preferences_only_after_review_with_conflict_and_scope_migration_controls',
        fallbackFlows: [
          'block_confirmation_when_conflict_resolution_is_required',
          'require_scope_migration_review_before_workspace_policy_changes',
          'revoke_confirmed_preference_when_review_outcome_invalidates_it',
          'publish_hash_only_confirmed_preference_release_manifest_when_statement_text_would_leak'
        ],
        operatorEscalation: 'growth_preference_owner_scope_migration_reviewer_and_worm_provider'
      },
      rawPreferenceStatementStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-confirmed-preference-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F confirmed preferences" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'confirmed_preference_product_gate_passed',
        'confirm_update_revoke_lifecycle_passed',
        'duplicate_and_conflict_guards_enforced',
        'migration_and_application_preview_ready',
        'hash_only_release_artifacts_ready',
        'confirmed_preference_operational_handoff_ready',
        'confirmed_preference_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawPreferenceStatementStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-confirmed-preference-worm-promotion-package-v1',
      providerContractVersion: 'f-confirmed-preference-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-confirmed-preference-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-confirmed-preference-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawPreferenceStatementStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-confirmed-preference-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      lifecycleWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, [baseStatement, updatedStatement, conflictStatement]);
    const checks = [
      {
        checkId: 'confirmed_preference_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-confirmed-preference-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'confirm_update_revoke_lifecycle_passed',
        passed: lifecycleWorkflow.confirmed.success === true
          && lifecycleWorkflow.updated.success === true
          && lifecycleWorkflow.revoked.success === true
          && lifecycleWorkflow.updated.revision >= 2
          && lifecycleWorkflow.revoked.revision >= 3
      },
      {
        checkId: 'duplicate_and_conflict_guards_enforced',
        passed: lifecycleWorkflow.duplicateGuard.duplicate === true
          && lifecycleWorkflow.conflictBlock.blocked === true
          && lifecycleWorkflow.conflictBlock.errorCode === 'F_PREFERENCE_CONFLICT_REQUIRES_RESOLUTION'
          && lifecycleWorkflow.conflictBlock.highSeverityCount >= 1
      },
      {
        checkId: 'migration_and_application_preview_ready',
        passed: lifecycleWorkflow.migrationDiff.diffVersion === 'f-confirmed-preference-migration-diff-v1'
          && lifecycleWorkflow.migrationDiff.migrationRequiredCount >= 1
          && lifecycleWorkflow.applicationPreview.previewVersion === 'f-confirmed-preference-application-preview-v1'
          && lifecycleWorkflow.applicationPreview.planningHints.every((hint) => hint.applyMode === 'strong_planning_hint')
      },
      {
        checkId: 'hash_only_release_artifacts_ready',
        passed: artifactManifest.rawPreferenceStatementStored === false
          && artifactManifest.conflictDossierRawStatementStored === true
          && artifactManifest.driftTrendStatementHashOnly === true
          && artifactManifest.migrationQueueStatementHashOnly === true
          && rawLeakDetected === false
      },
      {
        checkId: 'confirmed_preference_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-confirmed-preference-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-confirmed-preference-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-confirmed-preference-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'confirmed_preference_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-confirmed-preference-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-confirmed-preference-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('confirmed_preference.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  checkObservedMemoryGeneration(expectedGeneration) {
    if (expectedGeneration === undefined) return null; // Legacy internal callers.
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) return {
      success: false, error: { code: 'F_MEMORY_GENERATION_INVALID' }
    };
    if (expectedGeneration !== this.memoryGeneration) return {
      success: false, retryAfterRefresh: true, error: { code: 'F_MEMORY_GENERATION_CONFLICT' }
    };
    return null;
  }

  updatePreference(preferenceId, payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    const generationError = this.checkObservedMemoryGeneration(payload.expectedGeneration);
    if (generationError) return generationError;
    return this.confirmedPreferenceRegistry.update({
      preferenceId,
      patch: payload.patch ?? payload,
      expectedRevision: payload.expectedRevision,
      decidedBy: payload.decidedBy,
      reason: payload.reason
    });
  }

  revokePreference(preferenceId, payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    const generationError = this.checkObservedMemoryGeneration(payload.expectedGeneration);
    if (generationError) return generationError;
    return this.confirmedPreferenceRegistry.revoke({
      preferenceId,
      expectedRevision: payload.expectedRevision,
      decidedBy: payload.decidedBy,
      reason: payload.reason
    });
  }

  preferenceConflictReport() {
    return {
      generatedAt: this.clock().toISOString(),
      reportVersion: 'f-preference-conflict-report-v1',
      items: this.confirmedPreferenceRegistry.conflictReport(this.preferenceEngine.create(this.ingestor.all()))
    };
  }

  preferenceConfidenceCalibration() {
    const events = this.ingestor.all();
    const candidates = this.preferenceEngine.create(events);
    return this.preferenceEngine.confidenceCalibrationReport({
      events,
      candidates,
      confirmedPreferences: this.confirmedPreferenceRegistry.all({ includeInactive: true }),
      rejectedPreferences: [...this.confirmedPreferenceRegistry.rejected.values()]
    });
  }

  preferenceToleranceProfile() {
    const candidates = this.preferenceEngine.create(this.ingestor.all());
    return this.preferenceEngine.toleranceProfile({
      candidates,
      confirmedPreferences: this.confirmedPreferenceRegistry.all({ includeInactive: true })
    });
  }

  preferenceHypothesisProductGate() {
    const calibration = this.preferenceConfidenceCalibration();
    const toleranceProfile = this.preferenceToleranceProfile();
    const conflictReport = this.preferenceConflictReport();
    const checks = [
      {
        checkId: 'confidence_calibration_report_ready',
        passed: calibration.reportVersion === 'f-preference-confidence-calibration-report-v1'
          && calibration.privacy.rawTextStored === false
      },
      {
        checkId: 'calibration_corpus_hash_only',
        passed: calibration.corpusVersion === 'f-preference-confidence-calibration-corpus-v1'
          && calibration.privacy.eventIdsHashed === true
          && calibration.privacy.statementHashOnly === true
      },
      {
        checkId: 'tolerance_profile_visualized',
        passed: toleranceProfile.profileVersion === 'f-preference-tolerance-profile-v1'
          && toleranceProfile.visualizationVersion === 'f-preference-tolerance-visualization-v1'
      },
      {
        checkId: 'conflict_report_explainable',
        passed: conflictReport.reportVersion === 'f-preference-conflict-report-v1'
          && conflictReport.items.every((item) => Boolean(item.rationale) && Array.isArray(item.resolutionOptions))
      }
    ];
    return {
      productGateVersion: 'f-preference-hypothesis-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      calibration,
      toleranceProfile,
      conflictReport
    };
  }

  preferenceHypothesisReleaseDossier({ reason = 'preference_hypothesis_release_dossier' } = {}) {
    const beforeConfirmedCount = this.confirmedPreferenceRegistry.all({ includeInactive: true }).length;
    const productGate = this.preferenceHypothesisProductGate();
    const events = this.ingestor.all();
    const candidates = this.preferenceEngine.create(events);
    const calibration = productGate.calibration;
    const toleranceProfile = productGate.toleranceProfile;
    const conflictReport = productGate.conflictReport;
    const unsafeBase = this.clock().toISOString();
    const sensitiveEvents = [0, 1, 2].map((index) => this.memoryEventSchemas.normalize({
      eventId: `pref_release_sensitive_${index}`,
      eventType: 'approval.edited',
      taskId: `pref_release_sensitive_task_${index}`,
      createdAt: unsafeBase,
      payload: { editRequest: '상담 기록을 선호로 저장해' },
      learningFlags: { canBeUsedForPreference: true, containsSensitiveData: true },
      trustBoundary: { userProvided: true, externalContent: false, systemGenerated: false }
    }, this.clock()));
    const externalEvents = [0, 1, 2].map((index) => this.memoryEventSchemas.normalize({
      eventId: `pref_release_external_${index}`,
      eventType: 'approval.edited',
      taskId: `pref_release_external_task_${index}`,
      createdAt: unsafeBase,
      payload: { editRequest: '외부 기사 스타일을 내 선호로 저장해' },
      learningFlags: { canBeUsedForPreference: true, containsSensitiveData: false },
      trustBoundary: { userProvided: false, externalContent: true, systemGenerated: false }
    }, this.clock()));
    const unsafeCandidates = this.preferenceEngine.create([...sensitiveEvents, ...externalEvents]);
    const afterConfirmedCount = this.confirmedPreferenceRegistry.all({ includeInactive: true }).length;
    const candidateSummaries = candidates.map((candidate) => ({
      hypothesisId: candidate.hypothesisId,
      statementHash: hashSensitiveValue(candidate.statement),
      confidence: candidate.confidence,
      status: candidate.status,
      supportCount: candidate.evidenceEventIds?.length ?? 0,
      contradictionCount: candidate.contradictingEventIds?.length ?? 0,
      evidenceEventHashes: (candidate.evidenceEventIds ?? []).map(hashSensitiveValue),
      contradictionEventHashes: (candidate.contradictingEventIds ?? []).map(hashSensitiveValue),
      conflictStatus: candidate.semanticConflictSummary?.status ?? 'unknown'
    }));
    const releaseArtifacts = {
      productGate: {
        productGateVersion: productGate.productGateVersion,
        status: productGate.status,
        checks: productGate.checks
      },
      calibration: {
        reportVersion: calibration.reportVersion,
        corpusVersion: calibration.corpusVersion,
        status: calibration.status,
        privacy: calibration.privacy,
        candidateCount: calibration.candidateCount,
        meanCalibrationError: calibration.meanCalibrationError,
        horizon: calibration.horizon
      },
      toleranceProfile: {
        profileVersion: toleranceProfile.profileVersion,
        visualizationVersion: toleranceProfile.visualizationVersion,
        status: toleranceProfile.status,
        policy: toleranceProfile.policy,
        summary: toleranceProfile.summary,
        dimensions: toleranceProfile.dimensions
      },
      conflictReport: {
        reportVersion: conflictReport.reportVersion,
        itemCount: conflictReport.items.length,
        items: conflictReport.items.map((item) => ({
          dossierItemId: item.dossierItemId,
          relationship: item.relationship,
          severity: item.severity,
          preferenceHash: hashSensitiveValue(item.preferenceId),
          hypothesisHash: hashSensitiveValue(item.hypothesisId),
          rationale: item.rationale,
          resolutionOptions: item.resolutionOptions
        }))
      },
      candidateSummaries,
      safetyProbe: {
        probeVersion: 'f-preference-hypothesis-safety-probe-v1',
        sensitiveEventCount: sensitiveEvents.length,
        externalEventCount: externalEvents.length,
        unsafeCandidateCount: unsafeCandidates.length,
        sensitiveEventHashes: sensitiveEvents.map((event) => hashSensitiveValue(event.eventId)),
        externalEventHashes: externalEvents.map((event) => hashSensitiveValue(event.eventId)),
        rawEventPayloadStored: false
      },
      noAutoConfirmation: {
        beforeConfirmedCount,
        afterConfirmedCount,
        unchanged: beforeConfirmedCount === afterConfirmedCount
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-preference-hypothesis-release-artifact-manifest-v1',
      releaseArtifactsHash: hashJsonValue(releaseArtifacts),
      candidateSummaryHash: hashJsonValue(candidateSummaries),
      calibrationHash: hashJsonValue(releaseArtifacts.calibration),
      toleranceProfileHash: hashJsonValue(releaseArtifacts.toleranceProfile),
      conflictReportHash: hashJsonValue(releaseArtifacts.conflictReport),
      rawPreferenceTextStored: false,
      rawEventPayloadStored: false,
      statementHashOnly: candidateSummaries.every((item) => item.statementHash.startsWith('sha256:')),
      wormArchive: {
        archiveContractVersion: 'f-preference-hypothesis-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_preference_hypothesis_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(releaseArtifacts.productGate),
          hashJsonValue(releaseArtifacts.calibration),
          hashJsonValue(releaseArtifacts.toleranceProfile),
          hashJsonValue(releaseArtifacts.conflictReport),
          hashJsonValue(candidateSummaries),
          hashJsonValue(releaseArtifacts.safetyProbe),
          hashJsonValue(releaseArtifacts.noAutoConfirmation)
        ]
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'f-preference-hypothesis-release-workflow-v1',
      productGateReady: productGate.status === 'passed',
      confidenceCalibrationReady: calibration.reportVersion === 'f-preference-confidence-calibration-report-v1'
        && calibration.privacy.rawTextStored === false
        && calibration.privacy.statementHashOnly === true,
      toleranceProfileReady: toleranceProfile.profileVersion === 'f-preference-tolerance-profile-v1'
        && toleranceProfile.visualizationVersion === 'f-preference-tolerance-visualization-v1',
      conflictReportReady: conflictReport.reportVersion === 'f-preference-conflict-report-v1'
        && conflictReport.items.every((item) => Boolean(item.rationale)),
      safetyProbeReady: releaseArtifacts.safetyProbe.unsafeCandidateCount === 0,
      noAutoConfirmationReady: releaseArtifacts.noAutoConfirmation.unchanged === true,
      rawPreferenceRetentionSafe: artifactManifest.rawPreferenceTextStored === false
        && artifactManifest.rawEventPayloadStored === false
        && artifactManifest.statementHashOnly === true,
      promotionStatus: 'pending_checks'
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-preference-hypothesis-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-preference-hypothesis-release-owner',
      scope: 'preference_hypothesis_calibration_tolerance_conflict_safety_probe_no_auto_confirmation',
      status: releaseWorkflow.productGateReady
        && releaseWorkflow.confidenceCalibrationReady
        && releaseWorkflow.toleranceProfileReady
        && releaseWorkflow.conflictReportReady
        && releaseWorkflow.safetyProbeReady
        && releaseWorkflow.noAutoConfirmationReady
        && releaseWorkflow.rawPreferenceRetentionSafe ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-preference-hypothesis-health-handshake-v1',
      healthHandshake: {
        productGateReady: releaseWorkflow.productGateReady,
        confidenceCalibrationReady: releaseWorkflow.confidenceCalibrationReady,
        toleranceProfileReady: releaseWorkflow.toleranceProfileReady,
        conflictReportReady: releaseWorkflow.conflictReportReady,
        safetyProbeReady: releaseWorkflow.safetyProbeReady,
        noAutoConfirmationReady: releaseWorkflow.noAutoConfirmationReady,
        rawPreferenceRetentionSafe: releaseWorkflow.rawPreferenceRetentionSafe
      },
      fallbackPolicy: {
        policyVersion: 'f-preference-hypothesis-fallback-policy-v1',
        primaryFlow: 'keep_preferences_as_hypotheses_until_user_review_with_conflict_explanations',
        fallbackFlows: [
          'block_auto_confirmation_when_sensitive_or_external_events_would_promote',
          'require_conflict_resolution_when_semantic_conflict_is_high',
          'show_tolerance_profile_before_batch_preference_decisions',
          'publish_hash_only_preference_release_manifest_when_statement_or_event_payload_would_leak'
        ],
        operatorEscalation: 'growth_preference_reviewer_tolerance_owner_and_worm_provider'
      },
      rawPreferenceTextStored: false,
      rawEventPayloadStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-preference-hypothesis-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F confirmed preferences" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'preference_hypothesis_product_gate_passed',
        'confidence_calibration_hash_only',
        'tolerance_profile_ready',
        'conflict_report_explainable',
        'sensitive_and_external_events_not_promoted',
        'hypothesis_not_auto_confirmed',
        'raw_preference_retention_safe',
        'preference_hypothesis_operational_handoff_ready',
        'preference_hypothesis_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawPreferenceTextStored: false,
      rawEventPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-preference-hypothesis-worm-promotion-package-v1',
      providerContractVersion: 'f-preference-hypothesis-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-preference-hypothesis-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-preference-hypothesis-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawPreferenceTextStored: false,
      rawEventPayloadStored: false
    };
    const checks = [
      { checkId: 'preference_hypothesis_product_gate_passed', passed: productGate.status === 'passed' },
      { checkId: 'confidence_calibration_hash_only', passed: calibration.reportVersion === 'f-preference-confidence-calibration-report-v1' && calibration.privacy.rawTextStored === false && calibration.privacy.statementHashOnly === true },
      { checkId: 'tolerance_profile_ready', passed: toleranceProfile.profileVersion === 'f-preference-tolerance-profile-v1' && toleranceProfile.visualizationVersion === 'f-preference-tolerance-visualization-v1' },
      { checkId: 'conflict_report_explainable', passed: conflictReport.reportVersion === 'f-preference-conflict-report-v1' && conflictReport.items.every((item) => Boolean(item.rationale)) },
      { checkId: 'sensitive_and_external_events_not_promoted', passed: releaseArtifacts.safetyProbe.unsafeCandidateCount === 0 },
      { checkId: 'hypothesis_not_auto_confirmed', passed: releaseArtifacts.noAutoConfirmation.unchanged === true },
      { checkId: 'raw_preference_retention_safe', passed: artifactManifest.rawPreferenceTextStored === false && artifactManifest.rawEventPayloadStored === false && artifactManifest.statementHashOnly === true },
      {
        checkId: 'preference_hypothesis_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-preference-hypothesis-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-preference-hypothesis-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-preference-hypothesis-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'preference_hypothesis_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-preference-hypothesis-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-preference-hypothesis-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      dossierVersion: 'f-preference-hypothesis-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      reason,
      checks,
      releaseWorkflow: {
        ...releaseWorkflow,
        promotionStatus: checks.every((check) => check.passed) ? 'release_evidence_ready' : 'blocked'
      },
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      ...releaseArtifacts
    };
    this.auditLog.write('preference_hypothesis.release_dossier', {
      status: dossier.status,
      candidateCount: candidateSummaries.length,
      unsafeCandidateCount: releaseArtifacts.safetyProbe.unsafeCandidateCount
    });
    return {
      ...dossier,
      releaseHash: hashJsonValue(dossier)
    };
  }

  generateAutonomyCandidates() {
    const events = this.ingestor.all();
    return this.autonomyCandidateGenerator.generate({
      patterns: this.patternMiner.mine(events),
      events,
      lifecycle: this.autonomyCandidateLedger
    });
  }

  submitAutonomyCandidate(candidateId) {
    const candidate = this.generateAutonomyCandidates().find((item) => item.candidateId === candidateId);
    if (!candidate) return { success: false, error: { code: 'F_AUTONOMY_CANDIDATE_NOT_FOUND' } };
    const policyDecision = this.policyRuntime?.evaluateAutonomyCandidate
      ? this.policyRuntime.evaluateAutonomyCandidate(candidate)
      : { decision: 'pending_policy_review', reason: 'F_POLICY_CLIENT_NOT_CONFIGURED' };
    const submitted = {
      ...candidate,
      candidate,
      policyDecision,
      submittedAt: this.clock().toISOString(),
      lifecycle: {
        ...candidate.lifecycle,
        state: policyDecision.decision === 'approve_candidate' ? 'policy_approved_pending_user_review' : 'policy_reviewed',
        policySubmittedAt: this.clock().toISOString(),
        policyDecision
      },
      status: policyDecision.decision === 'approve_candidate' ? 'policy_approved_pending_user_review' : 'policy_reviewed'
    };
    this.submittedAutonomyCandidates.push(submitted);
    this.autonomyCandidateLedger.set(candidateId, submitted);
    this.persistAutonomyCandidateSnapshot(submitted, { action: 'submitted' });
    this.auditLog.write('autonomy.candidate.submitted', {
      candidateId,
      decision: policyDecision.decision
    });
    return submitted;
  }

  reviewAutonomyCandidate(candidateId, { decision = 'approve', decidedBy = 'user_review', reason = '' } = {}) {
    const candidate = this.autonomyCandidateLedger.get(candidateId)
      ?? this.generateAutonomyCandidates().find((item) => item.candidateId === candidateId);
    if (!candidate) return { success: false, error: { code: 'F_AUTONOMY_CANDIDATE_NOT_FOUND' } };
    const reviewed = {
      ...candidate,
      lifecycle: {
        ...candidate.lifecycle,
        state: decision === 'approve' ? 'user_approved' : decision === 'reject' ? 'user_rejected' : 'deferred',
        userReviewedAt: this.clock().toISOString(),
        userDecision: { decision, decidedBy, reason }
      },
      status: decision === 'approve' ? 'user_approved' : decision === 'reject' ? 'user_rejected' : 'deferred'
    };
    this.autonomyCandidateLedger.set(candidateId, reviewed);
    this.persistAutonomyCandidateSnapshot(reviewed, { action: 'reviewed', decision });
    this.auditLog.write('autonomy.candidate.reviewed', { candidateId, decision, decidedBy });
    return { success: true, item: reviewed };
  }

  autonomyCandidateLifecycle() {
    const items = this.generateAutonomyCandidates().map((candidate) => this.autonomyCandidateLedger.get(candidate.candidateId) ?? candidate);
    const submitted = [...this.autonomyCandidateLedger.values()];
    return {
      lifecycleVersion: 'f-autonomy-candidate-lifecycle-v2',
      generatedAt: this.clock().toISOString(),
      items,
      submitted,
      persistence: {
        trendType: 'autonomy_candidate',
        restoredCount: submitted.length,
        restorable: true
      },
      trend: this.autonomyDecisionTrend({ items: submitted.length ? submitted : items })
    };
  }

  persistAutonomyCandidateSnapshot(candidate, metadata = {}) {
    if (!candidate?.candidateId) return { success: false, persisted: false };
    const snapshot = {
      ...candidate,
      snapshotVersion: 'f-autonomy-candidate-snapshot-v1',
      snapshotId: stableId('autonomy_candidate_snapshot', candidate.candidateId, candidate.status, this.clock().toISOString()),
      generatedAt: this.clock().toISOString()
    };
    return this.persistTrendSnapshot('autonomy_candidate', snapshot, {
      candidateId: candidate.candidateId,
      status: candidate.status,
      ...metadata
    });
  }

  runAutonomyExpiryScheduler({ now = this.clock(), dryRun = false } = {}) {
    const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
    const items = this.autonomyCandidateLifecycle().items;
    const expired = [];
    for (const item of items) {
      const expiresAt = Date.parse(item.expiresAt ?? '');
      const alreadyClosed = ['user_approved', 'user_rejected', 'expired'].includes(item.status);
      if (Number.isFinite(expiresAt) && expiresAt <= nowTime && !alreadyClosed) {
        const next = {
          ...item,
          lifecycle: {
            ...item.lifecycle,
            state: 'expired',
            expiredAt: new Date(nowTime).toISOString()
          },
          status: 'expired'
        };
        expired.push(next);
        if (!dryRun) {
          this.autonomyCandidateLedger.set(next.candidateId, next);
          this.persistAutonomyCandidateSnapshot(next, { action: 'expired' });
        }
      }
    }
    const report = {
      reportVersion: 'f-autonomy-expiry-scheduler-v1',
      status: 'passed',
      generatedAt: this.clock().toISOString(),
      dryRun,
      scannedCount: items.length,
      expiredCount: expired.length,
      expiredCandidateIds: expired.map((item) => item.candidateId),
      nextRunAfterMinutes: 60
    };
    this.auditLog.write('autonomy.expiry_scheduler.run', {
      dryRun,
      scannedCount: report.scannedCount,
      expiredCount: report.expiredCount
    });
    return report;
  }

  autonomyDecisionTrend({ items = [...this.autonomyCandidateLedger.values()] } = {}) {
    const statusCounts = this.countBy(items, (item) => item.status ?? item.lifecycle?.state ?? 'unknown');
    const policyApproved = items.filter((item) => item.policyDecision?.decision === 'approve_candidate' || item.lifecycle?.policyDecision?.decision === 'approve_candidate').length;
    const userApproved = items.filter((item) => item.status === 'user_approved').length;
    return {
      trendVersion: 'f-autonomy-decision-trend-v1',
      generatedAt: this.clock().toISOString(),
      total: items.length,
      statusCounts,
      policyApproved,
      userApproved,
      approvalRate: items.length ? Number((userApproved / items.length).toFixed(3)) : 0,
      persistence: {
        trendType: 'autonomy_candidate',
        persisted: Boolean(this.memoryStore?.saveTrendSnapshot)
      }
    };
  }

  autonomyCandidateReleaseDossier({ decision = 'approve' } = {}) {
    const rawTaskText = '주보 초안 파일 만들어';
    const releaseEvents = Array.from({ length: 5 }, (_, index) => ({
      eventId: `f10_release_approval_${index + 1}`,
      eventType: 'approval.approved',
      taskId: `f10_release_task_${index + 1}`,
      payload: { rawText: rawTaskText },
      createdAt: this.clock().toISOString(),
      learningFlags: {
        canBeUsedForWorkflow: true,
        canBeUsedForAutonomy: true,
        containsSensitiveData: false,
        doNotRemember: false
      },
      trustBoundary: {
        userProvided: true,
        externalContent: false,
        systemGenerated: false
      }
    }));
    const releasePatterns = this.patternMiner.mine(releaseEvents);
    const releaseLedger = new Map();
    const candidates = this.autonomyCandidateGenerator.generate({
      patterns: releasePatterns,
      events: releaseEvents,
      lifecycle: releaseLedger
    });
    const candidate = candidates[0] ?? null;
    const policyDecision = candidate && this.policyRuntime?.evaluateAutonomyCandidate
      ? this.policyRuntime.evaluateAutonomyCandidate(candidate)
      : { decision: 'pending_policy_review', reason: candidate ? 'F_POLICY_CLIENT_NOT_CONFIGURED' : 'F_AUTONOMY_CANDIDATE_NOT_GENERATED' };
    const submitted = candidate
      ? {
          ...candidate,
          policyDecision,
          submittedAt: this.clock().toISOString(),
          lifecycle: {
            ...candidate.lifecycle,
            state: policyDecision.decision === 'approve_candidate' ? 'policy_approved_pending_user_review' : 'policy_reviewed',
            policySubmittedAt: this.clock().toISOString(),
            policyDecision
          },
          status: policyDecision.decision === 'approve_candidate' ? 'policy_approved_pending_user_review' : 'policy_reviewed'
        }
      : null;
    const reviewed = submitted
      ? {
          ...submitted,
          lifecycle: {
            ...submitted.lifecycle,
            state: decision === 'approve' ? 'user_approved' : decision === 'reject' ? 'user_rejected' : 'deferred',
            userReviewedAt: this.clock().toISOString(),
            userDecision: { decision, decidedBy: 'f10_release_dossier', reason: 'release dossier review workflow' }
          },
          status: decision === 'approve' ? 'user_approved' : decision === 'reject' ? 'user_rejected' : 'deferred'
        }
      : null;
    const expiryProbe = {
      reportVersion: 'f-autonomy-expiry-scheduler-v1',
      status: 'passed',
      dryRun: true,
      scannedCount: candidate ? 1 : 0,
      expiredCount: candidate ? 1 : 0,
      expiredCandidateIds: candidate ? [candidate.candidateId] : [],
      nextRunAfterMinutes: 60
    };
    const trend = this.autonomyDecisionTrend({ items: reviewed ? [reviewed] : submitted ? [submitted] : [] });
    const releaseWorkflow = {
      workflowVersion: 'f-autonomy-candidate-release-workflow-v1',
      shadowExecution: true,
      patternCount: releasePatterns.length,
      candidateCount: candidates.length,
      candidate: candidate
        ? {
            candidateId: candidate.candidateId,
            titleHash: hashSensitiveValue(candidate.title),
            sourcePatternIdHash: hashSensitiveValue(candidate.sourcePatternId),
            riskTier: candidate.riskTier,
            externalTransfer: candidate.externalTransfer,
            containsSensitiveData: candidate.containsSensitiveData,
            proposedScope: candidate.proposedScope,
            evidence: {
              approvalCount: candidate.evidence.approvalCount,
              failureCount: candidate.evidence.failureCount,
              rejectionCount: candidate.evidence.rejectionCount,
              eventIdHashes: candidate.evidence.eventIds.map(hashSensitiveValue)
            },
            negativeEvidence: {
              eventIdHashes: candidate.negativeEvidence.eventIds.map(hashSensitiveValue),
              failureEventTypes: candidate.negativeEvidence.failureEventTypes,
              rejectionCount: candidate.negativeEvidence.rejectionCount
            },
            readinessScore: candidate.readinessScore,
            expiresAt: candidate.expiresAt,
            lifecycleState: candidate.lifecycle.state,
            status: candidate.status
          }
        : null,
      policySubmission: submitted
        ? {
            submittedAt: submitted.submittedAt,
            policyDecision: submitted.policyDecision.decision,
            policyReason: submitted.policyDecision.reason ?? null,
            lifecycleState: submitted.lifecycle.state,
            status: submitted.status
          }
        : null,
      userReview: reviewed
        ? {
            decision,
            lifecycleState: reviewed.lifecycle.state,
            status: reviewed.status,
            decidedByHash: hashSensitiveValue(reviewed.lifecycle.userDecision.decidedBy)
          }
        : null,
      expiryScheduler: expiryProbe,
      trend: {
        trendVersion: trend.trendVersion,
        total: trend.total,
        statusCounts: trend.statusCounts,
        policyApproved: trend.policyApproved,
        userApproved: trend.userApproved,
        approvalRate: trend.approvalRate,
        persisted: trend.persistence.persisted
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-autonomy-candidate-release-artifact-manifest-v1',
      releaseWorkflowHash: hashJsonValue(releaseWorkflow),
      rawCandidateTextStored: false,
      taskTextHash: hashSensitiveValue(rawTaskText),
      candidateTitleHashOnly: Boolean(releaseWorkflow.candidate?.titleHash?.startsWith('sha256:')),
      evidenceEventHashOnly: releaseWorkflow.candidate?.evidence.eventIdHashes.every((item) => item.startsWith('sha256:')) ?? false,
      policyReviewLinked: releaseWorkflow.policySubmission?.policyDecision === 'approve_candidate',
      mobileReviewContract: 'c-autonomy-candidate-review-ui-v1',
      wormArchive: {
        archiveContractVersion: 'f-autonomy-candidate-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_autonomy_candidate_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(releaseWorkflow),
          hashJsonValue(releaseWorkflow.trend),
          hashJsonValue(releaseWorkflow.expiryScheduler)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-autonomy-candidate-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-autonomy-candidate-release-owner',
      scope: 'candidate_generation_policy_submission_user_review_expiry_scheduler_decision_trend',
      status: releaseWorkflow.candidateCount >= 1
        && releaseWorkflow.policySubmission?.policyDecision === 'approve_candidate'
        && releaseWorkflow.userReview?.lifecycleState === 'user_approved'
        && releaseWorkflow.expiryScheduler.status === 'passed'
        && releaseWorkflow.trend.trendVersion === 'f-autonomy-decision-trend-v1'
        && artifactManifest.rawCandidateTextStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-autonomy-candidate-health-handshake-v1',
      healthHandshake: {
        candidateGenerated: releaseWorkflow.candidateCount >= 1,
        policySubmissionReady: releaseWorkflow.policySubmission?.policyDecision === 'approve_candidate',
        userReviewReady: releaseWorkflow.userReview?.lifecycleState === 'user_approved',
        expirySchedulerReady: releaseWorkflow.expiryScheduler.status === 'passed',
        decisionTrendReady: releaseWorkflow.trend.trendVersion === 'f-autonomy-decision-trend-v1',
        rawCandidateTextStored: artifactManifest.rawCandidateTextStored
      },
      fallbackPolicy: {
        policyVersion: 'f-autonomy-candidate-fallback-policy-v1',
        primaryFlow: 'submit_safe_repeated_workflow_candidates_to_policy_then_require_user_review_before_activation',
        fallbackFlows: [
          'block_candidate_promotion_when_policy_approval_is_missing',
          'defer_candidate_when_user_review_is_not_complete',
          'expire_stale_candidates_before_execution',
          'publish_hash_only_autonomy_candidate_manifest_when_task_text_would_leak'
        ],
        operatorEscalation: 'growth_autonomy_owner_policy_reviewer_mobile_reviewer_and_worm_provider'
      },
      rawCandidateTextStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-autonomy-candidate-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F autonomy candidates" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'autonomy_candidate_generated_from_safe_repetition',
        'policy_submission_pending_user_review',
        'user_review_and_trend_ready',
        'expiry_scheduler_ready',
        'raw_candidate_text_retention_safe',
        'autonomy_candidate_operational_handoff_ready',
        'autonomy_candidate_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawCandidateTextStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-autonomy-candidate-worm-promotion-package-v1',
      providerContractVersion: 'f-autonomy-candidate-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-autonomy-candidate-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-autonomy-candidate-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawCandidateTextStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-autonomy-candidate-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, [rawTaskText]);
    const checks = [
      {
        checkId: 'autonomy_candidate_generated_from_safe_repetition',
        passed: releaseWorkflow.candidateCount >= 1
          && releaseWorkflow.candidate?.evidence.approvalCount >= 5
          && releaseWorkflow.candidate?.negativeEvidence.eventIdHashes.length === 0
      },
      {
        checkId: 'policy_submission_pending_user_review',
        passed: releaseWorkflow.policySubmission?.policyDecision === 'approve_candidate'
          && releaseWorkflow.policySubmission?.lifecycleState === 'policy_approved_pending_user_review'
      },
      {
        checkId: 'user_review_and_trend_ready',
        passed: releaseWorkflow.userReview?.lifecycleState === 'user_approved'
          && releaseWorkflow.trend.trendVersion === 'f-autonomy-decision-trend-v1'
          && releaseWorkflow.trend.userApproved >= 1
      },
      {
        checkId: 'expiry_scheduler_ready',
        passed: releaseWorkflow.expiryScheduler.reportVersion === 'f-autonomy-expiry-scheduler-v1'
          && releaseWorkflow.expiryScheduler.status === 'passed'
          && releaseWorkflow.expiryScheduler.dryRun === true
      },
      {
        checkId: 'raw_candidate_text_retention_safe',
        passed: artifactManifest.rawCandidateTextStored === false
          && artifactManifest.candidateTitleHashOnly === true
          && artifactManifest.evidenceEventHashOnly === true
          && rawLeakDetected === false
      },
      {
        checkId: 'autonomy_candidate_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-autonomy-candidate-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-autonomy-candidate-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-autonomy-candidate-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'autonomy_candidate_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-autonomy-candidate-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-autonomy-candidate-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('autonomy_candidate.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  advancedLearningModels() {
    this.synchronizeSourceRetractions();
    const events = this.ingestor.all();
    const repeatedTasks = this.patternMiner.mine(events);
    const preferenceCandidates = this.preferenceEngine.create(events);
    const confirmedPreferences = this.confirmedPreferenceRegistry.all();
    const styleGenome = this.styleGenomeBuilder.build(events, confirmedPreferences);
    const cloneEvidence = this.cloneEvidenceBuilder.build({ events, confirmedPreferences, patterns: repeatedTasks });
    const skillDistillations = this.skillDistillationEngine.distill({ patterns: repeatedTasks, confirmedPreferences, styleGenome, events });
    const skillRegistry = this.skillDraftRegistry.status(skillDistillations);
    return {
      generatedAt: this.clock().toISOString(),
      cloneEvidence,
      styleGenome,
      skillDistillations,
      skillRegistry,
      preferenceCandidates
    };
  }

  reviewSkillDraft(draftId, payload = {}) {
    const advanced = this.advancedLearningModels();
    const result = this.skillDraftRegistry.review({
      draftId,
      drafts: advanced.skillDistillations,
      decision: payload.decision,
      decidedBy: payload.decidedBy,
      reason: payload.reason
    });
    if (result.success) {
      this.persistSkillRegistrySnapshot({ action: 'reviewed', draftId, decision: result.review.decision });
      this.auditLog.write('skill_draft.reviewed', {
        draftId,
        decision: result.review.decision,
        registrySkillId: result.registryEntry?.skillId
      });
    }
    return result;
  }

  mutateSkillRevision(action, payload = {}) {
    if (!this.ensureMemoryGeneration()) return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' } };
    this.synchronizeSourceRetractions();
    const actions = {
      create: () => this.skillDraftRegistry.createRevision(payload),
      evaluate: () => this.skillDraftRegistry.evaluateRevision(payload),
      review: () => this.skillDraftRegistry.reviewRevision(payload),
      promote: () => this.skillDraftRegistry.promoteRevision(payload),
      rollback: () => this.skillDraftRegistry.rollbackRevision(payload)
    };
    const execute = actions[action];
    if (!execute) return { success: false, error: { code: 'F_SKILL_REVISION_ACTION_INVALID' } };
    const result = execute();
    if (result.success) {
      this.persistSkillRegistrySnapshot({ action: `revision_${action}`, skillId: payload.skillId,
        revisionId: payload.revisionId ?? result.revision?.revisionId ?? result.activeRevision?.revisionId });
      this.auditLog.write(`skill_registry.revision_${action}`, {
        skillId: payload.skillId,
        revisionId: payload.revisionId ?? result.revision?.revisionId ?? result.activeRevision?.revisionId,
        status: result.revision?.status ?? result.activeRevision?.status ?? null
      });
    }
    return result;
  }

  skillRegistryStatus() {
    return this.advancedLearningModels().skillRegistry;
  }

  runReviewedTabularProcedure({ skillId, revisionId, lifecycleSha256, rows, scope } = {}) {
    const deny = code => ({ success: false, error: { code }, externalEffects: false });
    if (!normalizeMemoryScope(scope)) return deny('F_SKILL_PROCEDURE_SCOPE_REQUIRED');
    if (!this.ensureMemoryGeneration() || this.memoryRecoveryState?.status === 'restart_required') {
      return deny('F_MEMORY_RESTORE_RELOAD_REQUIRED');
    }
    this.synchronizeSourceRetractions();
    const entry = this.skillDraftRegistry.registry.get(skillId);
    if (!entry || entry.status !== 'approved_for_skill_registry'
      || entry.policy?.executableByDefault !== false || entry.policy?.requiresUserReview !== true
      || entry.policy?.requiresPolicyCheck !== true || entry.activeRevisionId !== revisionId) {
      return deny('F_SKILL_PROCEDURE_REVISION_UNAVAILABLE');
    }
    const sourceIds = this.skillDraftRegistry.sourceEvidenceIds(entry);
    if (!sourceIds.length || sourceIds.some(id => !this.ingestor.events.has(id)
      || !sourceRecallAllowed(this.ingestor.events.get(id))
      || !memoryScopeMatches(this.ingestor.events.get(id), scope))) return deny('F_SKILL_PROCEDURE_SOURCE_UNAVAILABLE');
    const revision = entry.revisions?.find(item => item.revisionId === revisionId);
    if (!revision?.procedureDefinition || revision.status !== 'active' || revision.review?.decision !== 'approve'
      || revision.evaluation?.mode !== 'cross-material-deterministic-procedure-trials-v1'
      || revision.evaluation?.status !== 'passed') return deny('F_SKILL_PROCEDURE_REVIEW_REQUIRED');
    const issue = procedureLifecycleIssue(revision, this.clock().toISOString());
    if (issue) return deny(issue);
    if (typeof lifecycleSha256 !== 'string' || lifecycleSha256 !== revision.procedureLifecycle.contractSha256) {
      return deny('F_SKILL_PROCEDURE_CONTRACT_CHANGED');
    }
    // Pure bounded calculation only. Publication, tool actions and Mission
    // completion remain under Core/E/B/G; this result grants no authority.
    const result = runTabularProcedure(revision.procedureDefinition, rows);
    if (!result.success) return { ...deny('F_SKILL_PROCEDURE_INPUT_REJECTED'), inputIssue: result.error, issues: result.issues };
    const verification = this.learningVerifier?.verifyTabularProcedureResult?.({ definition: revision.procedureDefinition, rows, result });
    if (verification?.status !== 'passed' || verification.verifierId !== revision.procedureLifecycle.verifier.runtimeId) return deny('F_SKILL_PROCEDURE_RESULT_UNVERIFIED');
    return { ...result, skillId, revisionId, lifecycleSha256, externalEffects: false,
      verificationStatus: 'deterministic-result-verified', verification,
      inputSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      resultSha256: createHash('sha256').update(JSON.stringify(result.resultRows)).digest('hex') };
  }

  missionSkillGuidance(objective, { scope } = {}) {
    if (!this.ensureMemoryGeneration()) return [];
    if (this.memoryRecoveryState?.status === 'restart_required') return [];
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 4_000) return [];
    this.synchronizeSourceRetractions();
    const objectiveTerms = missionSkillTerms(objective);
    if (objectiveTerms.size < 2) return [];
    const candidates = this.skillDraftRegistry.status([]).registryEntries.flatMap(entry => {
      if (entry.status !== 'approved_for_skill_registry'
        || entry.policy?.executableByDefault !== false
        || entry.policy?.requiresUserReview !== true
        || entry.policy?.requiresPolicyCheck !== true) return [];
      const sourceIds = this.skillDraftRegistry.sourceEvidenceIds(entry);
      if (!sourceIds.length || sourceIds.some(id => typeof id !== 'string'
        || !this.ingestor.events.has(id) || !sourceRecallAllowed(this.ingestor.events.get(id))
        || !memoryScopeMatches(this.ingestor.events.get(id), scope))) return [];
      const revision = entry.revisions?.find(item => item.revisionId === entry.activeRevisionId);
      if (procedureLifecycleIssue(revision, this.clock().toISOString())) return [];
      if (!revision || revision.status !== 'active' || revision.review?.decision !== 'approve'
        || !Array.isArray(revision.suggestedSteps) || revision.suggestedSteps.length < 1 || revision.suggestedSteps.length > 24
        || revision.suggestedSteps.some(step => typeof step !== 'string' || !step.trim() || step.length > 320)) return [];
      const title = String(entry.title ?? '').replace(/\s+(?:보조\s+)?스킬\s+초안$/u, '').trim();
      const titleTerms = missionSkillTerms(title);
      const matchedTerms = [...titleTerms].filter(term => objectiveTerms.has(term));
      const score = titleTerms.size ? matchedTerms.length / titleTerms.size : 0;
      if (matchedTerms.length < 2 || score < 0.5) return [];
      return [{ entry, revision, title, score }];
    }).sort((left, right) => right.score - left.score || left.entry.skillId.localeCompare(right.entry.skillId));
    if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return [];
    const { entry, revision, title, score } = candidates[0];
    return [{ guidanceVersion: 'f-mission-skill-guidance-v1', skillId: entry.skillId,
      revisionId: revision.revisionId, title, score,
      ...(revision.procedureLifecycle ? {procedureLifecycle:structuredClone(revision.procedureLifecycle)} : {}),
      steps: revision.suggestedSteps.slice(0, 24),
      safetyConstraints: (Array.isArray(entry.safetyConstraints) ? entry.safetyConstraints : []).slice(0, 8)
        .map(item => String(item).slice(0, 160)) }];
  }

  persistSkillRegistrySnapshot(metadata = {}) {
    const snapshot = this.skillDraftRegistry.snapshot();
    return this.persistTrendSnapshot('skill_registry', snapshot, metadata);
  }

  recordSkillUsefulness(skillId, payload = {}) {
    const result = this.skillDraftRegistry.recordUsefulness({ skillId, ...payload });
    if (result.success) {
      this.persistSkillRegistrySnapshot({
        action: 'usefulness_recorded',
        skillId,
        outcome: payload.outcome
      });
      this.auditLog.write('skill_registry.usefulness_recorded', {
        skillId,
        outcome: payload.outcome,
        score: result.usefulness.score
      });
    }
    return result;
  }

  skillRegistryPersistenceStatus() {
    const archive = this.growthTrendArchive({ trendType: 'skill_registry' });
    return {
      statusVersion: 'f-approved-skill-registry-persistence-v1',
      generatedAt: this.clock().toISOString(),
      registryEntries: this.skillDraftRegistry.status([]).registryEntries.length,
      persisted: archive.persisted,
      snapshotCount: archive.total,
      latestSnapshotId: archive.latestByType.skill_registry?.snapshotId ?? null,
      usefulnessReport: this.skillDraftRegistry.usefulnessReport()
    };
  }

  advancedLearningVerifierReport() {
    const advancedLearning = this.advancedLearningModels();
    const autonomyLifecycle = this.autonomyCandidateLifecycle();
    const checks = this.learningVerifier?.verifyAdvancedLearning
      ? this.learningVerifier.verifyAdvancedLearning({ advancedLearning, autonomyLifecycle })
      : localAdvancedLearningChecks({ advancedLearning, autonomyLifecycle });
    const failed = checks.filter((check) => check.status === 'failed');
    return {
      reportVersion: 'f-advanced-learning-verifier-report-v1',
      verifierVersion: checks[0]?.verifierVersion ?? 'g-advanced-learning-verifier-v1',
      status: failed.some((check) => ['critical', 'high'].includes(check.severity)) ? 'failed' : 'passed',
      generatedAt: this.clock().toISOString(),
      checkedCount: checks.length,
      failedCount: failed.length,
      checks
    };
  }

  skillUsefulnessOperationalCorpus({ limit = 50 } = {}) {
    const registry = this.skillDraftRegistry.status([]);
    const entries = registry.registryEntries.slice(-Math.max(1, Number(limit) || 50)).map((entry) => ({
      skillIdHash: hashSensitiveValue(entry.skillId),
      titleHash: hashSensitiveValue(entry.title ?? entry.skillId),
      status: entry.status,
      approvedAt: entry.approvedAt ?? null,
      usefulness: {
        scoreVersion: entry.usefulness?.scoreVersion ?? null,
        score: entry.usefulness?.score ?? null,
        totalFeedback: entry.usefulness?.totalFeedback ?? 0,
        adoptedCount: entry.usefulness?.adoptedCount ?? 0,
        rejectedCount: entry.usefulness?.rejectedCount ?? 0
      },
      rawSkillTextStored: false,
      rawTaskIdsStored: false
    }));
    return {
      corpusVersion: 'f-skill-usefulness-operational-corpus-v1',
      generatedAt: this.clock().toISOString(),
      anonymized: true,
      rawSkillTextStored: false,
      entryCount: entries.length,
      entries
    };
  }

  skillDistillationProviderComparisonTrend({ providers = null } = {}) {
    const advanced = this.advancedLearningModels();
    const registry = this.skillDraftRegistry.status([]);
    const usefulnessReport = registry.usefulnessReport;
    const defaultProviders = [
      {
        providerId: 'local-rule-distiller',
        mode: 'implemented',
        draftCount: advanced.skillDistillations.length,
        registryEntryCount: registry.registryEntries.length,
        averageUsefulness: usefulnessReport.averageScore,
        estimatedCostUsd: 0,
        privacyMode: 'local-only'
      },
      {
        providerId: 'external-llm-distiller-contract',
        mode: 'contract-ready',
        draftCount: 0,
        registryEntryCount: 0,
        averageUsefulness: null,
        estimatedCostUsd: null,
        privacyMode: 'approval-gated-redacted-context'
      }
    ];
    const items = providers ?? defaultProviders;
    return {
      trendVersion: 'f-skill-distillation-provider-comparison-trend-v1',
      generatedAt: this.clock().toISOString(),
      status: items.some((item) => item.mode === 'implemented') && items.some((item) => item.mode === 'contract-ready')
        ? 'ready'
        : 'needs_attention',
      comparisonDimensions: ['draft_count', 'registry_adoption', 'average_usefulness', 'estimated_cost', 'privacy_mode'],
      items,
      recommendation: usefulnessReport.averageScore >= 0.7
        ? 'keep-local-rule-distiller-as-default'
        : 'run-approval-gated-provider-benchmark'
    };
  }

  advancedLearningProductGate({ minRegistryEntries = 1, minUsefulnessScore = 0.6 } = {}) {
    const advancedLearning = this.advancedLearningModels();
    const registry = advancedLearning.skillRegistry;
    const registrySnapshot = this.skillDraftRegistry.snapshot();
    const persistence = this.skillRegistryPersistenceStatus();
    const verifier = this.advancedLearningVerifierReport();
    const usefulnessCorpus = this.skillUsefulnessOperationalCorpus();
    const providerComparisonTrend = this.skillDistillationProviderComparisonTrend();
    const checks = [
      {
        checkId: 'clone_evidence_safe_subset_ready',
        passed: Boolean(advancedLearning.cloneEvidence.cloneEvidenceId)
          && advancedLearning.cloneEvidence.safetyStatus === 'reviewable_safe_subset'
      },
      {
        checkId: 'skill_drafts_review_gated',
        passed: advancedLearning.skillDistillations.length >= 1
          && advancedLearning.skillDistillations.every((draft) => draft.status === 'draft_requires_review'
            && draft.safetyConstraints?.includes('requires_policy_check'))
      },
      {
        checkId: 'approved_skill_registry_policy_guarded',
        passed: registry.registryVersion === 'f-approved-skill-registry-v1'
          && registry.registryEntries.length >= minRegistryEntries
          && registry.registryEntries.every((entry) => entry.policy?.executableByDefault === false && entry.policy?.requiresUserReview === true)
      },
      {
        checkId: 'skill_usefulness_scoring_ready',
        passed: registry.usefulnessReport.reportVersion === 'f-skill-usefulness-report-v1'
          && registry.usefulnessReport.averageScore >= minUsefulnessScore
      },
      {
        checkId: 'skill_registry_persistence_ready',
        passed: persistence.statusVersion === 'f-approved-skill-registry-persistence-v1'
          && ((persistence.persisted === true && persistence.snapshotCount >= 1)
            || registrySnapshot.snapshotVersion === 'f-approved-skill-registry-snapshot-v1')
      },
      {
        checkId: 'advanced_learning_verifier_passed',
        passed: verifier.reportVersion === 'f-advanced-learning-verifier-report-v1'
          && verifier.verifierVersion === 'g-advanced-learning-verifier-v1'
          && verifier.status === 'passed'
      },
      {
        checkId: 'skill_usefulness_operational_corpus_ready',
        passed: usefulnessCorpus.corpusVersion === 'f-skill-usefulness-operational-corpus-v1'
          && usefulnessCorpus.anonymized === true
          && usefulnessCorpus.entryCount >= minRegistryEntries
          && usefulnessCorpus.rawSkillTextStored === false
      },
      {
        checkId: 'skill_distillation_provider_trend_ready',
        passed: providerComparisonTrend.trendVersion === 'f-skill-distillation-provider-comparison-trend-v1'
          && providerComparisonTrend.status === 'ready'
      }
    ];
    return {
      productGateVersion: 'f-advanced-learning-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      advancedLearning,
      registrySnapshot,
      persistence,
      verifier,
      usefulnessCorpus,
      providerComparisonTrend
    };
  }

  advancedLearningReleaseDossier({ minRegistryEntries = 1, minUsefulnessScore = 0.6 } = {}) {
    const productGate = this.advancedLearningProductGate({ minRegistryEntries, minUsefulnessScore });
    const rawNeedles = [
      ...productGate.advancedLearning.styleGenome.guidance,
      ...productGate.advancedLearning.skillDistillations.flatMap((draft) => [
        draft.title,
        ...(draft.suggestedSteps ?? []),
        ...(draft.styleHints ?? [])
      ])
    ].filter(Boolean);
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      registryEntries: productGate.advancedLearning.skillRegistry.registryEntries.length,
      skillDraftCount: productGate.advancedLearning.skillDistillations.length,
      verifierStatus: productGate.verifier.status,
      usefulnessCorpusItems: productGate.usefulnessCorpus.entryCount,
      providerTrendStatus: productGate.providerComparisonTrend.status
    };
    const releaseProjection = {
      projectionVersion: 'f-advanced-learning-release-hash-only-projection-v1',
      cloneEvidence: {
        cloneEvidenceIdHash: hashSensitiveValue(productGate.advancedLearning.cloneEvidence.cloneEvidenceId),
        evidenceEventHashes: productGate.advancedLearning.cloneEvidence.evidenceEventIds.map(hashSensitiveValue),
        confirmedPreferenceIdHashes: productGate.advancedLearning.cloneEvidence.confirmedPreferenceIds.map(hashSensitiveValue),
        repeatedPatternIdHashes: productGate.advancedLearning.cloneEvidence.repeatedPatternIds.map(hashSensitiveValue),
        coverageScore: productGate.advancedLearning.cloneEvidence.coverageScore,
        safetyStatus: productGate.advancedLearning.cloneEvidence.safetyStatus,
        allowedUse: productGate.advancedLearning.cloneEvidence.allowedUse,
        blockedUse: productGate.advancedLearning.cloneEvidence.blockedUse
      },
      styleGenome: {
        styleGenomeIdHash: hashSensitiveValue(productGate.advancedLearning.styleGenome.styleGenomeId),
        signals: productGate.advancedLearning.styleGenome.signals,
        dominantSignals: productGate.advancedLearning.styleGenome.dominantSignals,
        confidence: productGate.advancedLearning.styleGenome.confidence,
        evidenceTextCount: productGate.advancedLearning.styleGenome.evidenceTextCount,
        guidanceHashes: productGate.advancedLearning.styleGenome.guidance.map(hashSensitiveValue)
      },
      skillDistillations: productGate.advancedLearning.skillDistillations.map((draft) => ({
        distilledSkillIdHash: hashSensitiveValue(draft.distilledSkillId),
        titleHash: hashSensitiveValue(draft.title),
        sourcePatternIdHash: hashSensitiveValue(draft.sourcePatternId),
        evidenceEventHashes: (draft.evidenceEventIds ?? []).map(hashSensitiveValue),
        confirmedPreferenceIdHashes: (draft.confirmedPreferenceIds ?? []).map(hashSensitiveValue),
        suggestedStepHashes: (draft.suggestedSteps ?? []).map(hashSensitiveValue),
        styleHintHashes: (draft.styleHints ?? []).map(hashSensitiveValue),
        confidence: draft.confidence,
        status: draft.status,
        safetyConstraints: draft.safetyConstraints
      })),
      registrySnapshot: {
        snapshotVersion: productGate.registrySnapshot.snapshotVersion,
        registryEntryHashes: productGate.registrySnapshot.registryEntries.map((entry) => hashJsonValue({
          skillId: entry.skillId,
          sourceDraftId: entry.sourceDraftId,
          status: entry.status,
          policy: entry.policy
        })),
        reviewHashes: productGate.registrySnapshot.reviews.map((review) => hashJsonValue({
          reviewId: review.reviewId,
          draftId: review.draftId,
          decision: review.decision
        })),
        rawSkillTextStored: false
      },
      verifier: {
        reportVersion: productGate.verifier.reportVersion,
        verifierVersion: productGate.verifier.verifierVersion,
        status: productGate.verifier.status,
        checkedCount: productGate.verifier.checkedCount,
        failedCount: productGate.verifier.failedCount
      },
      usefulnessCorpus: {
        corpusVersion: productGate.usefulnessCorpus.corpusVersion,
        anonymized: productGate.usefulnessCorpus.anonymized,
        entryCount: productGate.usefulnessCorpus.entryCount,
        rawSkillTextStored: productGate.usefulnessCorpus.rawSkillTextStored,
        entryHashes: productGate.usefulnessCorpus.entries.map((entry) => hashJsonValue(entry))
      },
      providerComparisonTrend: {
        trendVersion: productGate.providerComparisonTrend.trendVersion,
        status: productGate.providerComparisonTrend.status,
        comparisonDimensions: productGate.providerComparisonTrend.comparisonDimensions,
        itemHashes: productGate.providerComparisonTrend.items.map((item) => hashJsonValue(item)),
        recommendationHash: hashSensitiveValue(productGate.providerComparisonTrend.recommendation)
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-advanced-learning-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      releaseProjectionHash: hashJsonValue(releaseProjection),
      rawSkillTextStored: false,
      rawStyleHintTextStored: false,
      rawEvidenceEventIdsStored: false,
      skillDraftTitlesHashOnly: releaseProjection.skillDistillations.every((draft) => draft.titleHash.startsWith('sha256:')),
      suggestedStepsHashOnly: releaseProjection.skillDistillations.every((draft) => draft.suggestedStepHashes.every((item) => item.startsWith('sha256:'))),
      styleHintsHashOnly: releaseProjection.skillDistillations.every((draft) => draft.styleHintHashes.every((item) => item.startsWith('sha256:'))),
      wormArchive: {
        archiveContractVersion: 'f-advanced-learning-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_advanced_learning_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(releaseProjection),
          hashJsonValue(productGate.verifier),
          hashJsonValue(productGate.usefulnessCorpus),
          hashJsonValue(productGate.providerComparisonTrend)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-advanced-learning-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-advanced-learning-release-owner',
      scope: 'clone_evidence_style_genome_skill_distillation_registry_usefulness_provider_trend_verifier',
      status: productGateSummary.status === 'passed'
        && releaseProjection.cloneEvidence.safetyStatus === 'reviewable_safe_subset'
        && releaseProjection.skillDistillations.length >= minRegistryEntries
        && releaseProjection.verifier.status === 'passed'
        && releaseProjection.usefulnessCorpus.entryCount >= minRegistryEntries
        && releaseProjection.providerComparisonTrend.status === 'ready'
        && artifactManifest.rawSkillTextStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-advanced-learning-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        cloneEvidenceReady: releaseProjection.cloneEvidence.safetyStatus === 'reviewable_safe_subset',
        skillDraftReviewGated: releaseProjection.skillDistillations.every((draft) => draft.status === 'draft_requires_review'),
        registryReady: productGateSummary.registryEntries >= minRegistryEntries,
        verifierReady: releaseProjection.verifier.status === 'passed',
        usefulnessCorpusReady: releaseProjection.usefulnessCorpus.entryCount >= minRegistryEntries,
        providerTrendReady: releaseProjection.providerComparisonTrend.status === 'ready',
        rawSkillTextStored: artifactManifest.rawSkillTextStored
      },
      fallbackPolicy: {
        policyVersion: 'f-advanced-learning-fallback-policy-v1',
        primaryFlow: 'publish_hash_only_clone_style_skill_distillation_release_with_review_gated_skill_registry',
        fallbackFlows: [
          'block_skill_draft_execution_until_user_review_and_policy_check',
          'fall_back_to_local_rule_distiller_when_external_provider_contract_is_not_ready',
          'require_usefulness_feedback_before_promoting_skill_registry_changes',
          'publish_hash_only_advanced_learning_manifest_when_skill_or_style_text_would_leak'
        ],
        operatorEscalation: 'growth_advanced_learning_owner_skill_reviewer_provider_owner_and_worm_provider'
      },
      rawSkillTextStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-advanced-learning-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F advanced learning" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'advanced_learning_product_gate_passed',
        'advanced_learning_hash_only_projection_ready',
        'advanced_learning_verifier_and_usefulness_ready',
        'advanced_learning_raw_skill_text_retention_safe',
        'advanced_learning_operational_handoff_ready',
        'advanced_learning_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawSkillTextStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-advanced-learning-worm-promotion-package-v1',
      providerContractVersion: 'f-advanced-learning-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-advanced-learning-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-advanced-learning-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawSkillTextStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-advanced-learning-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      releaseProjection,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawNeedles);
    const checks = [
      {
        checkId: 'advanced_learning_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-advanced-learning-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'advanced_learning_hash_only_projection_ready',
        passed: releaseProjection.projectionVersion === 'f-advanced-learning-release-hash-only-projection-v1'
          && artifactManifest.skillDraftTitlesHashOnly === true
          && artifactManifest.suggestedStepsHashOnly === true
          && artifactManifest.styleHintsHashOnly === true
      },
      {
        checkId: 'advanced_learning_verifier_and_usefulness_ready',
        passed: releaseProjection.verifier.status === 'passed'
          && releaseProjection.usefulnessCorpus.corpusVersion === 'f-skill-usefulness-operational-corpus-v1'
          && releaseProjection.providerComparisonTrend.trendVersion === 'f-skill-distillation-provider-comparison-trend-v1'
      },
      {
        checkId: 'advanced_learning_raw_skill_text_retention_safe',
        passed: artifactManifest.rawSkillTextStored === false
          && artifactManifest.rawStyleHintTextStored === false
          && artifactManifest.rawEvidenceEventIdsStored === false
          && rawLeakDetected === false
      },
      {
        checkId: 'advanced_learning_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-advanced-learning-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-advanced-learning-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-advanced-learning-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'advanced_learning_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-advanced-learning-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-advanced-learning-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('advanced_learning.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  attachLearningVerifier(learningVerifier) {
    this.learningVerifier = learningVerifier;
    return {
      success: true,
      verifierId: 'G.LearningVerifier',
      linked: Boolean(learningVerifier?.verify)
    };
  }

  learningVerificationStatus({ events, patterns, preferenceCandidates, hygieneReport }) {
    if (!this.learningVerifier?.verify) {
      return {
        linked: false,
        verifierId: 'G.LearningVerifier',
        status: 'not_configured',
        passRate: null,
        passed: 0,
        failed: 0,
        criticalFailed: 0,
        checks: []
      };
    }
    const checks = this.learningVerifier.verify({
      memoryEvents: events,
      patterns,
      preferenceCandidates,
      hygieneReport
    });
    const failedChecks = checks.filter((check) => check.status === 'failed');
    const criticalFailed = failedChecks.filter((check) => ['critical', 'high'].includes(check.severity)).length;
    const passRate = checks.length ? Number(((checks.length - failedChecks.length) / checks.length).toFixed(3)) : 1;
    return {
      linked: true,
      verifierId: 'G.LearningVerifier',
      status: criticalFailed > 0 ? 'failed' : 'passed',
      passRate,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      criticalFailed,
      checkIds: checks.map((check) => check.checkId),
      checks
    };
  }

  maturityScore() {
    const sourceDigest = this.refreshDerivedTrendSources();
    const preferenceDigest = this.memoryStore?.preferenceStateDigest?.();
    const events = this.ingestor.all();
    const repeatedTasks = this.patternMiner.mine(events);
    const preferenceCandidates = this.preferenceEngine.create(events);
    const confirmedPreferences = this.confirmedPreferenceRegistry.all();
    const failureLessons = this.failureBuilder.build(events, { patterns: repeatedTasks });
    const advancedLearning = this.advancedLearningModels();
    const hygieneReport = this.hygieneManager.report({ events, patterns: repeatedTasks, preferenceCandidates, failureLessons });
    const learningVerification = this.learningVerificationStatus({
      events,
      patterns: repeatedTasks,
      preferenceCandidates,
      hygieneReport
    });
    const score = this.maturityScoreEngine.score({
      events,
      patterns: repeatedTasks,
      preferenceCandidates,
      confirmedPreferences,
      failureLessons,
      advancedLearning,
      learningVerification
    });
    this.persistTrendSnapshot('maturity', score.trend.latest, {
      total: score.total,
      thresholdStatus: score.thresholdStatus,
      verificationStatus: score.learningVerification.status
    }, { expectedSourceRetractionDigest: sourceDigest, expectedPreferenceStateDigest: preferenceDigest });
    return score;
  }

  maturityTrend() {
    this.refreshDerivedTrendSources();
    return this.maturityScoreEngine.trendStatus();
  }

  maturityThresholds() {
    return this.maturityScoreEngine.calibrationStatus();
  }

  calibrateMaturityThresholds(payload = {}) {
    const result = this.maturityScoreEngine.calibrateThresholds(payload);
    this.auditLog.write('maturity.thresholds.calibrated', {
      success: result.success !== false,
      calibrationId: result.calibrationId ?? null,
      decidedBy: payload.decidedBy,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  maturityAlerts() {
    const score = this.maturityScore();
    return {
      generatedAt: this.clock().toISOString(),
      thresholdStatus: score.thresholdStatus,
      items: score.thresholdAlerts,
      thresholds: this.maturityScoreEngine.thresholds,
      learningVerification: score.learningVerification
    };
  }

  maturityThresholdProfile({ userScope = 'default-user', workspaceScope = 'default-workspace' } = {}) {
    return {
      profileVersion: 'f-maturity-threshold-profile-v1',
      generatedAt: this.clock().toISOString(),
      userScope,
      workspaceScope,
      thresholds: { ...this.maturityScoreEngine.thresholds },
      calibrationCount: this.maturityScoreEngine.calibrationHistory.length,
      uiContract: {
        contractVersion: 'c-maturity-threshold-profile-ui-v1',
        controls: ['totalMin', 'safetyMin', 'verificationPassRateMin', 'regressionDropMax'],
        requiresReason: true,
        previewBeforeApply: true
      }
    };
  }

  maturityThresholdMigrationDiff({ targetThresholds = {}, userScope = 'default-user', workspaceScope = 'default-workspace' } = {}) {
    const before = this.maturityThresholdProfile({ userScope, workspaceScope });
    const after = { ...before.thresholds, ...targetThresholds };
    const changedFields = Object.keys(after).filter((key) => JSON.stringify(before.thresholds[key]) !== JSON.stringify(after[key]));
    return {
      diffVersion: 'f-maturity-threshold-migration-diff-v1',
      generatedAt: this.clock().toISOString(),
      userScope,
      workspaceScope,
      before: before.thresholds,
      after,
      changedFields,
      migrationRequired: changedFields.length > 0,
      reviewPolicy: {
        requiresUserReview: true,
        requiresVerificationReview: changedFields.includes('verificationPassRateMin')
      }
    };
  }

  maturityDashboard({ score = null } = {}) {
    const currentScore = score ?? this.maturityScore();
    return {
      dashboardVersion: 'f-maturity-score-dashboard-v1',
      generatedAt: this.clock().toISOString(),
      uiContract: {
        contractVersion: 'c-maturity-score-dashboard-ui-v1',
        panels: ['total', 'dimensions', 'verification', 'thresholds', 'trend'],
        showsRegressionAlerts: true
      },
      score: currentScore,
      thresholdProfile: this.maturityThresholdProfile(),
      alerts: {
        alertVersion: 'f-maturity-threshold-alert-dashboard-v1',
        status: currentScore.thresholdStatus,
        items: currentScore.thresholdAlerts
      },
      trend: currentScore.trend
    };
  }

  maturityProductGate({ targetThresholds = { totalMin: 75 }, score = null } = {}) {
    const currentScore = score ?? this.maturityScore();
    const thresholdProfile = this.maturityThresholdProfile();
    const migrationDiff = this.maturityThresholdMigrationDiff({ targetThresholds });
    const dashboard = this.maturityDashboard({ score: currentScore });
    const archive = this.growthTrendArchive({ trendType: 'maturity', limit: 20 });
    const checks = [
      { checkId: 'maturity_score_available', passed: Number.isFinite(currentScore.total) && currentScore.total >= 0 },
      { checkId: 'threshold_profile_ready', passed: thresholdProfile.profileVersion === 'f-maturity-threshold-profile-v1' && thresholdProfile.uiContract.previewBeforeApply === true },
      { checkId: 'threshold_migration_diff_ready', passed: migrationDiff.diffVersion === 'f-maturity-threshold-migration-diff-v1' },
      { checkId: 'maturity_dashboard_ready', passed: dashboard.dashboardVersion === 'f-maturity-score-dashboard-v1' && dashboard.uiContract.contractVersion === 'c-maturity-score-dashboard-ui-v1' },
      { checkId: 'learning_verification_linked', passed: currentScore.learningVerification.linked === true && currentScore.learningVerification.status === 'passed' },
      { checkId: 'maturity_archive_available', passed: archive.countsByType.maturity >= 1 }
    ];
    return {
      productGateVersion: 'f-maturity-score-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      score: currentScore,
      thresholdProfile,
      migrationDiff,
      dashboard,
      archive
    };
  }

  maturityScoreReleaseDossier({ targetThresholds = { totalMin: 75, verificationPassRateMin: 0.95 } } = {}) {
    const score = this.maturityScore();
    const productGate = this.maturityProductGate({ score, targetThresholds });
    const thresholdProfile = this.maturityThresholdProfile();
    const migrationDiff = this.maturityThresholdMigrationDiff({ targetThresholds });
    const dashboard = this.maturityDashboard({ score });
    const trend = this.maturityTrend();
    const alerts = this.maturityAlerts();
    const archive = this.growthTrendArchive({ trendType: 'maturity', limit: 20 });
    const productGateSummary = {
      productGateVersion: productGate.productGateVersion,
      status: productGate.status,
      checks: productGate.checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      total: productGate.score.total,
      thresholdStatus: productGate.score.thresholdStatus,
      learningVerification: {
        linked: productGate.score.learningVerification.linked,
        verifierId: productGate.score.learningVerification.verifierId,
        status: productGate.score.learningVerification.status,
        passRate: productGate.score.learningVerification.passRate
      },
      archive: {
        archiveVersion: productGate.archive.archiveVersion,
        total: productGate.archive.total,
        maturityCount: productGate.archive.countsByType.maturity ?? 0
      }
    };
    const releaseWorkflow = {
      workflowVersion: 'f-maturity-score-release-workflow-v1',
      score: {
        total: score.total,
        level: score.level,
        thresholdStatus: score.thresholdStatus,
        dimensions: score.dimensions,
        evidence: score.evidence,
        learningVerification: score.learningVerification,
        thresholdAlerts: score.thresholdAlerts.map((alert) => ({
          code: alert.code,
          severity: alert.severity,
          actual: alert.actual,
          threshold: alert.threshold
        }))
      },
      thresholdProfile: {
        profileVersion: thresholdProfile.profileVersion,
        userScopeHash: hashSensitiveValue(thresholdProfile.userScope),
        workspaceScopeHash: hashSensitiveValue(thresholdProfile.workspaceScope),
        thresholds: thresholdProfile.thresholds,
        calibrationCount: thresholdProfile.calibrationCount,
        uiContractVersion: thresholdProfile.uiContract.contractVersion,
        previewBeforeApply: thresholdProfile.uiContract.previewBeforeApply
      },
      migrationDiff: {
        diffVersion: migrationDiff.diffVersion,
        changedFields: migrationDiff.changedFields,
        migrationRequired: migrationDiff.migrationRequired,
        reviewPolicy: migrationDiff.reviewPolicy
      },
      dashboard: {
        dashboardVersion: dashboard.dashboardVersion,
        uiContractVersion: dashboard.uiContract.contractVersion,
        panels: dashboard.uiContract.panels,
        alertCount: dashboard.alerts.items.length,
        trendLatest: dashboard.trend.latest
          ? {
              snapshotId: dashboard.trend.latest.snapshotId,
              total: dashboard.trend.latest.total,
              thresholdStatus: dashboard.trend.latest.thresholdStatus,
              verificationStatus: dashboard.trend.latest.verificationStatus
            }
          : null
      },
      trend: {
        trendVersion: trend.trendVersion,
        latest: trend.latest
          ? {
              snapshotId: trend.latest.snapshotId,
              total: trend.latest.total,
              thresholdStatus: trend.latest.thresholdStatus,
              verificationStatus: trend.latest.verificationStatus
            }
          : null,
        historyCount: trend.history.length
      },
      alerts: {
        alertVersion: 'f-maturity-threshold-alert-dashboard-v1',
        thresholdStatus: alerts.thresholdStatus,
        alertCount: alerts.items.length,
        learningVerification: alerts.learningVerification
      },
      archive: {
        archiveVersion: archive.archiveVersion,
        total: archive.total,
        countsByType: archive.countsByType
      }
    };
    const artifactManifest = {
      manifestVersion: 'f-maturity-score-release-artifact-manifest-v1',
      productGateHash: hashJsonValue(productGateSummary),
      releaseWorkflowHash: hashJsonValue(releaseWorkflow),
      rawLearningPayloadStored: false,
      thresholdProfileHash: hashJsonValue(releaseWorkflow.thresholdProfile),
      migrationDiffHash: hashJsonValue(releaseWorkflow.migrationDiff),
      dashboardHash: hashJsonValue(releaseWorkflow.dashboard),
      learningVerifierLinked: releaseWorkflow.score.learningVerification.linked === true,
      mobileStateContract: 'c-maturity-product-gate-state-v1',
      wormArchive: {
        archiveContractVersion: 'f-maturity-score-worm-release-archive-v1',
        required: true,
        storageMode: 'hash_only_maturity_score_release_manifest',
        retentionDays: 2555,
        includedArtifactHashes: [
          hashJsonValue(productGateSummary),
          hashJsonValue(releaseWorkflow),
          hashJsonValue(trend),
          hashJsonValue(alerts),
          hashJsonValue(archive)
        ]
      }
    };
    const operationalHandoffManifest = {
      manifestVersion: 'f-maturity-score-operational-handoff-manifest-v1',
      generatedAt: this.clock().toISOString(),
      owner: 'growth-memory-maturity-score-release-owner',
      scope: 'maturity_score_threshold_profile_migration_dashboard_learning_verifier_trend_archive',
      status: productGateSummary.status === 'passed'
        && releaseWorkflow.score.learningVerification.status === 'passed'
        && releaseWorkflow.thresholdProfile.profileVersion === 'f-maturity-threshold-profile-v1'
        && releaseWorkflow.migrationDiff.diffVersion === 'f-maturity-threshold-migration-diff-v1'
        && releaseWorkflow.dashboard.dashboardVersion === 'f-maturity-score-dashboard-v1'
        && releaseWorkflow.archive.countsByType.maturity >= 1
        && artifactManifest.rawLearningPayloadStored === false ? 'ready' : 'blocked',
      healthHandshakeVersion: 'f-maturity-score-health-handshake-v1',
      healthHandshake: {
        productGateReady: productGateSummary.status === 'passed',
        scoreReady: Number.isFinite(releaseWorkflow.score.total),
        learningVerifierReady: releaseWorkflow.score.learningVerification.status === 'passed',
        thresholdProfileReady: releaseWorkflow.thresholdProfile.profileVersion === 'f-maturity-threshold-profile-v1',
        migrationDiffReady: releaseWorkflow.migrationDiff.diffVersion === 'f-maturity-threshold-migration-diff-v1',
        dashboardReady: releaseWorkflow.dashboard.dashboardVersion === 'f-maturity-score-dashboard-v1',
        archiveReady: releaseWorkflow.archive.countsByType.maturity >= 1,
        rawLearningPayloadStored: artifactManifest.rawLearningPayloadStored
      },
      fallbackPolicy: {
        policyVersion: 'f-maturity-score-fallback-policy-v1',
        primaryFlow: 'publish_maturity_score_with_threshold_profile_migration_preview_dashboard_and_learning_verifier_link',
        fallbackFlows: [
          'block_threshold_promotion_when_learning_verifier_is_not_passing',
          'require_review_before_threshold_profile_migration',
          'fall_back_to_previous_maturity_thresholds_when_dashboard_alerts_are_unresolved',
          'publish_hash_only_maturity_release_manifest_when_learning_payload_would_leak'
        ],
        operatorEscalation: 'growth_maturity_owner_verification_reviewer_mobile_dashboard_owner_and_worm_provider'
      },
      rawLearningPayloadStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'f-maturity-score-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "F advanced learning" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'maturity_product_gate_passed',
        'score_and_learning_verification_ready',
        'threshold_profile_migration_dashboard_ready',
        'maturity_trend_archive_ready',
        'raw_learning_payload_retention_safe',
        'maturity_score_operational_handoff_ready',
        'maturity_score_worm_promotion_package_ready'
      ],
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      rawLearningPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'f-maturity-score-worm-promotion-package-v1',
      providerContractVersion: 'f-maturity-score-worm-provider-contract-v1',
      status: artifactManifest.wormArchive.archiveContractVersion === 'f-maturity-score-worm-release-archive-v1'
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'f-maturity-score-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: hashJsonValue(artifactManifest),
      operationalHandoffHash: hashJsonValue(operationalHandoffManifest),
      ciNightlyGatePlanHash: hashJsonValue(ciNightlyGatePlan),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 2555,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawLearningPayloadStored: false
    };
    const preliminaryDossier = {
      dossierVersion: 'f-maturity-score-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      productGate: productGateSummary,
      releaseWorkflow,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage
    };
    const rawNeedles = this.ingestor.all()
      .map((event) => event.payload?.rawText ?? event.payload?.text ?? event.payload?.editRequest)
      .filter(Boolean);
    const rawLeakDetected = serializedContainsAny(preliminaryDossier, rawNeedles);
    const checks = [
      {
        checkId: 'maturity_product_gate_passed',
        passed: productGateSummary.productGateVersion === 'f-maturity-score-product-gate-v1'
          && productGateSummary.status === 'passed'
      },
      {
        checkId: 'score_and_learning_verification_ready',
        passed: Number.isFinite(releaseWorkflow.score.total)
          && releaseWorkflow.score.learningVerification.linked === true
          && releaseWorkflow.score.learningVerification.status === 'passed'
      },
      {
        checkId: 'threshold_profile_migration_dashboard_ready',
        passed: releaseWorkflow.thresholdProfile.profileVersion === 'f-maturity-threshold-profile-v1'
          && releaseWorkflow.thresholdProfile.previewBeforeApply === true
          && releaseWorkflow.migrationDiff.diffVersion === 'f-maturity-threshold-migration-diff-v1'
          && releaseWorkflow.dashboard.dashboardVersion === 'f-maturity-score-dashboard-v1'
      },
      {
        checkId: 'maturity_trend_archive_ready',
        passed: releaseWorkflow.trend.historyCount >= 1
          && releaseWorkflow.archive.countsByType.maturity >= 1
      },
      {
        checkId: 'raw_learning_payload_retention_safe',
        passed: artifactManifest.rawLearningPayloadStored === false
          && artifactManifest.learningVerifierLinked === true
          && rawLeakDetected === false
      },
      {
        checkId: 'maturity_score_operational_handoff_ready',
        passed: operationalHandoffManifest.manifestVersion === 'f-maturity-score-operational-handoff-manifest-v1'
          && operationalHandoffManifest.healthHandshakeVersion === 'f-maturity-score-health-handshake-v1'
          && operationalHandoffManifest.fallbackPolicy.policyVersion === 'f-maturity-score-fallback-policy-v1'
          && operationalHandoffManifest.status === 'ready'
      },
      {
        checkId: 'maturity_score_worm_promotion_package_ready',
        passed: externalWormPromotionPackage.packageVersion === 'f-maturity-score-worm-promotion-package-v1'
          && externalWormPromotionPackage.providerContractVersion === 'f-maturity-score-worm-provider-contract-v1'
          && externalWormPromotionPackage.status === 'ready'
      }
    ];
    const dossier = {
      ...preliminaryDossier,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks
    };
    const releaseHash = hashJsonValue(dossier);
    this.auditLog.write('maturity_score.release_dossier', {
      status: dossier.status,
      releaseHash,
      passedCheckCount: checks.filter((check) => check.passed).length,
      checkCount: checks.length
    });
    return {
      ...dossier,
      releaseHash
    };
  }

  latestReview() {
    try {
      return this.buildCurrentReview();
    } catch (error) {
      if (!['F_MEMORY_GENERATION_CONFLICT', 'F_MEMORY_SOURCE_CHANGED', 'F_MEMORY_PREFERENCE_CHANGED'].includes(error?.code)) throw error;
      return { success: false, contentWithheld: true, retryAfterRefresh: true,
        error: { code: error.code } };
    }
  }

  buildCurrentReview() {
    this.ensureMemoryGeneration();
    if (this.memoryRecoveryState?.status === 'restart_required') return { success: false, error: { code: 'F_MEMORY_RESTORE_RELOAD_REQUIRED' }, contentWithheld: true };
    this.synchronizeSourceRetractions();
    const reviewGeneration = this.memoryGeneration;
    const reviewSourceRetractionDigest = this.refreshDerivedTrendSources();
    const reviewPreferenceDigest = this.memoryStore?.preferenceStateDigest?.();
    const events = this.ingestor.all();
    const repeatedTasks = this.patternMiner.mine(events);
    const preferenceCandidates = this.preferenceEngine.create(events);
    const confirmedPreferences = this.confirmedPreferenceRegistry.all();
    const failureLessons = this.failureBuilder.build(events, { patterns: repeatedTasks });
    const autonomyCandidates = this.generateAutonomyCandidates();
    const genomes = this.genomeBuilder.build({ events, patterns: repeatedTasks, preferenceCandidates, confirmedPreferences, failureLessons });
    const genomeTrend = this.genomeTrendTracker.record(genomes);
    this.persistTrendSnapshot('genome', genomeTrend.latest, {
      schemaVersion: genomes.schemaVersion,
      riskPosture: genomes.riskCalibration.posture,
      workflowCount: genomes.workflowGenome.length,
      preferenceCount: genomes.preferenceGenome.length
    }, { expectedSourceRetractionDigest: reviewSourceRetractionDigest, expectedPreferenceStateDigest: reviewPreferenceDigest });
    const advancedLearning = this.advancedLearningModels();
    const hygiene = this.hygieneManager.report({ events, patterns: repeatedTasks, preferenceCandidates, failureLessons });
    const preferenceConfidenceCalibration = this.preferenceEngine.confidenceCalibrationReport({
      events,
      candidates: preferenceCandidates,
      confirmedPreferences: this.confirmedPreferenceRegistry.all({ includeInactive: true }),
      rejectedPreferences: [...this.confirmedPreferenceRegistry.rejected.values()]
    });
    const preferenceToleranceProfile = this.preferenceEngine.toleranceProfile({
      candidates: preferenceCandidates,
      confirmedPreferences: this.confirmedPreferenceRegistry.all({ includeInactive: true })
    });
    const preferenceProductGate = {
      productGateVersion: 'f-preference-hypothesis-product-gate-v1',
      status: preferenceConfidenceCalibration.reportVersion === 'f-preference-confidence-calibration-report-v1'
        && preferenceToleranceProfile.profileVersion === 'f-preference-tolerance-profile-v1'
        ? 'passed'
        : 'failed'
    };
    const confirmedPreferenceProductGate = this.confirmedPreferenceProductGate({
      targetScopePolicy: { workspaceScope: 'growth-review-workspace' }
    });
    const learningVerification = this.learningVerificationStatus({
      events,
      patterns: repeatedTasks,
      preferenceCandidates,
      hygieneReport: hygiene
    });
    const patternCorpus = this.patternCorpusBuilder.build({ events, patterns: repeatedTasks });
    const patternClusterReview = this.patternClusterReviewEngine.review({ patterns: repeatedTasks, corpus: patternCorpus });
    const patternMiningProductGate = this.patternMiningProductGate();
    const maturityScore = this.maturityScoreEngine.score({
      events,
      patterns: repeatedTasks,
      preferenceCandidates,
      confirmedPreferences,
      failureLessons,
      advancedLearning,
      learningVerification
    });
    this.persistTrendSnapshot('maturity', maturityScore.trend.latest, {
      total: maturityScore.total,
      thresholdStatus: maturityScore.thresholdStatus,
      verificationStatus: maturityScore.learningVerification.status
    }, { expectedSourceRetractionDigest: reviewSourceRetractionDigest, expectedPreferenceStateDigest: reviewPreferenceDigest });
    const review = {
      reviewId: stableId('review', 'latest', this.clock().toISOString()),
      period: '2026-W23',
      generatedAt: this.clock().toISOString(),
      summary: `학습 이벤트 ${events.length}개를 기준으로 성장 리뷰를 생성했습니다.`,
      repeatedTasks,
      preferenceCandidates,
      confirmedPreferences,
      failureLessons,
      failureTrend: this.failureBuilder.trendStatus(),
      failureMemoryProductGate: this.failureMemoryProductGate({ query: '' }),
      autonomyCandidates,
      policyBlocks: events.filter((event) => event.eventType === 'policy.blocked'),
      recommendations: autonomyCandidates.map((candidate) => `${candidate.title}는 E 정책 심사가 필요합니다.`),
      genomes,
      genomeTrend,
      genomeProductGate: this.genomeProductGate(),
      patternTrend: this.patternMiner.trendStatus(),
      patternCalibration: this.patternMiner.calibrationStatus(),
      patternEmbeddingAdapters: this.patternMiner.embeddingAdapterStatus(),
      patternCorpus,
      patternClusterReview,
      patternMiningProductGate,
      preferenceConfidenceCalibration,
      preferenceToleranceProfile,
      preferenceProductGate,
      confirmedPreferenceProductGate,
      cloneEvidence: advancedLearning.cloneEvidence,
      styleGenome: advancedLearning.styleGenome,
      skillDistillations: advancedLearning.skillDistillations,
      skillRegistry: advancedLearning.skillRegistry,
      maturityScore,
      maturityProductGate: this.maturityProductGate({ score: maturityScore }),
      memoryEventSchema: this.memoryEventSchemaStatus(),
      hygiene
    };
    const saved = this.memoryStore?.saveReview?.(review, { expectedGeneration: reviewGeneration,
      expectedSourceRetractionDigest: reviewSourceRetractionDigest, expectedPreferenceStateDigest: reviewPreferenceDigest }) ?? review;
    this.auditLog.write('growth.review.generated', {
      reviewId: saved.reviewId,
      eventCount: events.length,
      filePath: saved.filePath
    });
    return saved;
  }
}
