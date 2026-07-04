import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';

const defaultEventReplayMaxBytes = 16 * 1024 * 1024;
const defaultEventReplayMaxRecords = 5_000;

export class EventBus {
  constructor({ clock = () => new Date(), eventLogPath = null, deliveryLogPath = null, projectionLeasePath = null, replayOnStart = true, topicPolicies = {}, projectionLeaseTtlMs = 30_000, brokerAdapter = null, eventReplayMaxBytes = defaultEventReplayMaxBytes, eventReplayMaxRecords = defaultEventReplayMaxRecords } = {}) {
    this.clock = clock;
    this.eventLogPath = eventLogPath;
    this.deliveryLogPath = deliveryLogPath ?? (eventLogPath ? eventLogPath.replace(/\.jsonl$/i, '-delivery.jsonl') : null);
    this.projectionLeasePath = projectionLeasePath ?? (eventLogPath ? eventLogPath.replace(/\.jsonl$/i, '-projection-leases.jsonl') : null);
    this.projectionLeaseTtlMs = projectionLeaseTtlMs;
    this.eventReplayMaxBytes = eventReplayMaxBytes;
    this.eventReplayMaxRecords = eventReplayMaxRecords;
    this.brokerAdapter = brokerAdapter;
    this.brokerDeliveries = [];
    this.events = [];
    this.sequence = 0;
    this.eventReplayStatus = null;
    this.subscribers = new Map();
    this.pendingAcks = new Map();
    this.deliveryRecords = [];
    this.deadLetters = [];
    this.backpressureRecords = [];
    this.topicPolicies = new Map(Object.entries(topicPolicies).map(([eventType, policy]) => [eventType, normalizeTopicPolicy(policy)]));
    this.projectionLeases = new Map();
    if (replayOnStart && this.eventLogPath) {
      this.loadEventLog();
    }
    if (replayOnStart && this.projectionLeasePath) {
      this.loadProjectionLeaseLog();
    }
  }

  loadEventLog() {
    if (!existsSync(this.eventLogPath)) {
      this.eventReplayStatus = {
        replayVersion: 'a-event-log-bounded-replay-v1',
        path: this.eventLogPath,
        exists: false,
        loadedCount: 0,
        skippedCount: 0,
        truncated: false
      };
      return [];
    }
    const tail = readTailText(this.eventLogPath, this.eventReplayMaxBytes);
    const lines = tail.text.split(/\r?\n/).filter(Boolean);
    if (tail.truncated && lines.length > 0) lines.shift();
    const parsed = [];
    let skippedCount = 0;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.eventType) parsed.push(event);
      } catch {
        skippedCount += 1;
      }
    }
    const maxRecords = normalizePositiveInteger(this.eventReplayMaxRecords, defaultEventReplayMaxRecords);
    const loaded = parsed.slice(-maxRecords);
    this.events = [...loaded].reverse();
    this.sequence = loaded.reduce((max, event) => Math.max(max, this.sequenceFor(event)), 0);
    this.eventReplayStatus = {
      replayVersion: 'a-event-log-bounded-replay-v1',
      path: this.eventLogPath,
      exists: true,
      fileSizeBytes: tail.fileSizeBytes,
      bytesRead: tail.bytesRead,
      maxBytes: tail.maxBytes,
      maxRecords,
      truncated: tail.truncated,
      parsedCount: parsed.length,
      loadedCount: loaded.length,
      skippedCount,
      latestSequence: this.sequence
    };
    return loaded;
  }

  publish(eventType, payload = {}, source = 'A_CORE', options = {}) {
    const pressure = this.checkBackpressure(eventType);
    if (pressure.blocked) {
      return this.recordBackpressure({
        eventType,
        source,
        payloadPreview: previewPayload(payload),
        reason: pressure.reason,
        policy: pressure.policy,
        pressure: pressure.pressure,
        overflowAction: pressure.policy?.overflow ?? 'reject'
      });
    }
    this.sequence += 1;
    const event = {
      eventId: `evt_${this.sequence}`,
      sequence: this.sequence,
      eventType,
      source,
      payload,
      durable: Boolean(this.eventLogPath),
      createdAt: this.clock().toISOString()
    };
    this.events.unshift(event);
    if (this.eventLogPath) {
      appendJsonlSync(this.eventLogPath, event);
    }
    this.forwardToBroker(event);
    this.deliver(event, options);
    this.enforceTopicRetention(eventType);
    return event;
  }

  deliver(event, options = {}) {
    const deliveries = [
      ...(this.subscribers.get(event.eventType) ?? []),
      ...(this.subscribers.get('*') ?? [])
    ];
    for (const subscription of deliveries) {
      this.deliverToSubscriber(event, subscription, options);
    }
  }

  deliverToSubscriber(event, subscription, options = {}) {
    const requireAck = options.requireAck ?? subscription.requireAck;
    const delivery = {
      deliveryId: `delivery_${event.eventId}_${subscription.subscriberId}`,
      eventId: event.eventId,
      subscriberId: subscription.subscriberId,
      eventType: event.eventType,
      status: requireAck ? 'pending_ack' : 'delivered',
      deliveredAt: this.clock().toISOString()
    };
    if (requireAck) {
      this.pendingAcks.set(this.ackKey(event.eventId, subscription.subscriberId), delivery);
    }
    try {
      subscription.handler(event, {
        ack: () => this.ack(event.eventId, subscription.subscriberId),
        subscriberId: subscription.subscriberId
      });
      this.recordDelivery(delivery);
      return delivery;
    } catch (error) {
      const failed = {
        ...delivery,
        status: 'failed',
        error: error?.message ?? String(error),
        failedAt: this.clock().toISOString()
      };
      this.deadLetters.unshift({ ...failed, event });
      this.pendingAcks.delete(this.ackKey(event.eventId, subscription.subscriberId));
      this.recordDelivery(failed);
      return failed;
    }
  }

  subscribe(eventType, handler, options = {}) {
    const subscriberId = options.subscriberId ?? `subscriber_${eventType}_${(this.subscribers.get(eventType)?.length ?? 0) + 1}`;
    const subscription = {
      subscriberId,
      eventType,
      handler,
      requireAck: Boolean(options.requireAck)
    };
    const handlers = this.subscribers.get(eventType) ?? [];
    handlers.push(subscription);
    this.subscribers.set(eventType, handlers);
    if (options.replayFrom) {
      for (const event of this.replay({ eventType, sinceEventId: options.replayFrom, oldestFirst: true })) {
        this.deliverToSubscriber(event, subscription, { requireAck: subscription.requireAck });
      }
    }
    return () => {
      this.subscribers.set(
        eventType,
        (this.subscribers.get(eventType) ?? []).filter((candidate) => candidate !== subscription)
      );
    };
  }

  ack(eventId, subscriberId) {
    const key = this.ackKey(eventId, subscriberId);
    const pending = this.pendingAcks.get(key);
    if (!pending) return { acked: false, eventId, subscriberId, reason: 'not-pending' };
    this.pendingAcks.delete(key);
    const ack = {
      ...pending,
      status: 'acked',
      ackedAt: this.clock().toISOString()
    };
    this.recordDelivery(ack);
    return { acked: true, eventId, subscriberId };
  }

  replay({ eventType = null, sinceEventId = null, limit = 50, oldestFirst = false } = {}) {
    let events = this.events;
    if (eventType && eventType !== '*') {
      events = events.filter((event) => event.eventType === eventType);
    }
    if (sinceEventId) {
      const marker = this.events.find((event) => event.eventId === sinceEventId);
      if (marker) {
        events = events.filter((event) => event.sequence > marker.sequence);
      }
    }
    const ordered = oldestFirst ? [...events].reverse() : [...events];
    return ordered.slice(0, limit);
  }

  recent(limit = 20) {
    return this.events.slice(0, limit);
  }

  deliveryStatus() {
    return {
      pendingAcks: [...this.pendingAcks.values()],
      deadLetters: this.deadLetters.slice(0, 20),
      deliveryRecords: this.deliveryRecords.slice(0, 50),
      backpressure: this.backpressureStatus(),
      projectionLeases: this.projectionLeaseStatus()
    };
  }

  configureTopicPolicy(eventType, policy = {}) {
    const normalized = normalizeTopicPolicy(policy);
    this.topicPolicies.set(eventType, normalized);
    return {
      policyVersion: 'a-event-topic-backpressure-policy-v1',
      eventType,
      policy: normalized
    };
  }

  topicPolicy(eventType) {
    return this.topicPolicies.get(eventType) ?? this.topicPolicies.get('*') ?? null;
  }

  topicPressure(eventType) {
    return {
      eventType,
      pendingAckCount: [...this.pendingAcks.values()].filter((delivery) => delivery.eventType === eventType).length,
      recentEventCount: this.events.filter((event) => event.eventType === eventType).length,
      deadLetterCount: this.deadLetters.filter((delivery) => delivery.eventType === eventType).length
    };
  }

  checkBackpressure(eventType) {
    const policy = this.topicPolicy(eventType);
    if (!policy) return { blocked: false, pressure: this.topicPressure(eventType), policy: null };
    const pressure = this.topicPressure(eventType);
    if (Number.isFinite(policy.maxPendingAcks) && pressure.pendingAckCount >= policy.maxPendingAcks) {
      return {
        blocked: ['reject', 'drop', 'dead-letter', 'retry'].includes(policy.overflow),
        reason: 'max-pending-acks',
        policy,
        pressure
      };
    }
    return { blocked: false, pressure, policy };
  }

  enforceTopicRetention(eventType) {
    const policy = this.topicPolicy(eventType);
    if (!policy || !Number.isFinite(policy.maxRecentEvents)) return;
    const matching = this.events.filter((event) => event.eventType === eventType);
    if (matching.length <= policy.maxRecentEvents) return;
    const retainedMatchingIds = new Set(matching.slice(0, policy.maxRecentEvents).map((event) => event.eventId));
    this.events = this.events.filter((event) => event.eventType !== eventType || retainedMatchingIds.has(event.eventId));
  }

  recordBackpressure(record) {
    const overflowAction = record.overflowAction ?? record.policy?.overflow ?? 'reject';
    const statusByAction = {
      reject: 'backpressure_rejected',
      drop: 'backpressure_dropped',
      'dead-letter': 'backpressure_dead_lettered',
      retry: 'backpressure_retry_scheduled'
    };
    const item = {
      recordVersion: 'a-event-backpressure-record-v1',
      eventId: `backpressure_${this.sequence + 1}`,
      status: statusByAction[overflowAction] ?? 'backpressure_rejected',
      recordedAt: this.clock().toISOString(),
      ...record
    };
    this.backpressureRecords.unshift(item);
    if (overflowAction === 'dead-letter') {
      this.deadLetters.unshift({
        deliveryId: item.eventId,
        eventId: item.eventId,
        subscriberId: 'event-bus-overflow',
        eventType: item.eventType,
        status: 'failed',
        error: item.reason,
        failedAt: item.recordedAt,
        event: item
      });
    }
    this.recordDelivery({
      deliveryId: item.eventId,
      eventId: item.eventId,
      subscriberId: 'event-bus',
      eventType: item.eventType,
      status: item.status,
      reason: item.reason,
      recordedAt: item.recordedAt
    });
    return item;
  }

  backpressureStatus() {
    const topics = new Set([
      ...this.events.map((event) => event.eventType),
      ...[...this.pendingAcks.values()].map((delivery) => delivery.eventType)
    ]);
    return {
      policyVersion: 'a-event-topic-backpressure-policy-v1',
      configuredTopics: [...this.topicPolicies.keys()],
      records: this.backpressureRecords.slice(0, 20),
      overflowDashboard: this.overflowPolicyDashboard(),
      pressureByTopic: [...topics].map((eventType) => this.topicPressure(eventType))
    };
  }

  overflowPolicyDashboard() {
    const topics = [...this.topicPolicies.entries()].map(([eventType, policy]) => ({
      eventType,
      policy,
      pressure: this.topicPressure(eventType),
      action: policy.overflow,
      uiState: policy.overflow === 'reject'
        ? 'block-new-events'
        : policy.overflow === 'drop'
          ? 'drop-and-count'
          : policy.overflow === 'dead-letter'
            ? 'quarantine-overflow'
            : policy.overflow === 'retry'
              ? 'schedule-redrive'
              : 'monitor-only',
      operatorAction: policy.overflow === 'retry' ? 'watch-redrive-queue' : 'review-pressure'
    }));
    return {
      dashboardVersion: 'a-event-overflow-policy-dashboard-v1',
      generatedAt: this.clock().toISOString(),
      status: topics.every((topic) => ['reject', 'drop', 'dead-letter', 'retry', 'allow'].includes(topic.action)) ? 'passed' : 'needs-policy',
      topics
    };
  }

  redrivePendingAcks({ olderThanMs = 0, limit = 50 } = {}) {
    const now = this.clock();
    const candidates = [...this.pendingAcks.values()]
      .filter((delivery) => now.getTime() - Date.parse(delivery.deliveredAt) >= olderThanMs)
      .slice(0, limit);
    const results = [];
    for (const delivery of candidates) {
      const event = this.events.find((item) => item.eventId === delivery.eventId);
      const subscription = this.findSubscription(delivery.eventType, delivery.subscriberId);
      if (!event || !subscription) {
        results.push({ ...delivery, redriven: false, reason: event ? 'subscriber-not-found' : 'event-not-found' });
        continue;
      }
      const redrive = this.deliverToSubscriber(event, subscription, { requireAck: true });
      this.recordDelivery({
        deliveryId: `redrive_${delivery.deliveryId}`,
        eventId: delivery.eventId,
        subscriberId: delivery.subscriberId,
        eventType: delivery.eventType,
        status: this.pendingAcks.has(this.ackKey(delivery.eventId, delivery.subscriberId)) ? 'pending_ack' : 'acked',
        redriveType: 'pending_ack',
        redrivenAt: this.clock().toISOString()
      });
      results.push({ ...delivery, redriven: true, status: redrive.status });
    }
    return {
      redriven: results.filter((item) => item.redriven).length,
      remainingPendingAcks: this.pendingAcks.size,
      results
    };
  }

  redriveDeadLetters({ eventType = null, subscriberId = null, limit = 50 } = {}) {
    const snapshot = [...this.deadLetters];
    const candidates = snapshot
      .filter((deadLetter) => !eventType || deadLetter.eventType === eventType)
      .filter((deadLetter) => !subscriberId || deadLetter.subscriberId === subscriberId)
      .slice(0, limit);
    const recovered = [];
    const retained = [];
    for (const deadLetter of snapshot) {
      if (!candidates.includes(deadLetter)) {
        retained.push(deadLetter);
        continue;
      }
      const subscription = this.findSubscription(deadLetter.eventType, deadLetter.subscriberId);
      if (!subscription) {
        retained.push(deadLetter);
        recovered.push({ ...deadLetter, redriven: false, reason: 'subscriber-not-found' });
        continue;
      }
      const result = this.deliverToSubscriber(deadLetter.event, subscription, { requireAck: subscription.requireAck });
      this.recordDelivery({
        deliveryId: `deadletter_redrive_${deadLetter.deliveryId}`,
        eventId: deadLetter.eventId,
        subscriberId: deadLetter.subscriberId,
        eventType: deadLetter.eventType,
        status: result.status === 'failed' ? 'failed' : 'recovered',
        redriveType: 'dead_letter',
        redrivenAt: this.clock().toISOString()
      });
      if (result.status === 'failed') {
        retained.push(deadLetter);
      }
      recovered.push({ ...deadLetter, redriven: result.status !== 'failed', status: result.status });
    }
    const newlyFailed = this.deadLetters.filter((deadLetter) => !snapshot.includes(deadLetter));
    this.deadLetters = [...newlyFailed, ...retained];
    return {
      redriven: recovered.filter((item) => item.redriven).length,
      remainingDeadLetters: this.deadLetters.length,
      results: recovered
    };
  }

  projectionRecovery({ olderThanMs = 0, limit = 50 } = {}) {
    const pending = this.redrivePendingAcks({ olderThanMs, limit });
    const deadLetters = this.redriveDeadLetters({ limit });
    const leases = this.recoverProjectionLeases();
    return {
      recoveredAt: this.clock().toISOString(),
      pending,
      deadLetters,
      leases,
      status: this.deliveryStatus()
    };
  }

  acquireProjectionLease(projectionId, {
    ownerId = 'projection-worker',
    ttlMs = this.projectionLeaseTtlMs,
    now = this.clock().toISOString(),
    metadata = {}
  } = {}) {
    const existing = this.projectionLeases.get(projectionId);
    if (existing && Date.parse(existing.expiresAt) > Date.parse(now) && existing.ownerId !== ownerId) {
      return { acquired: false, reason: 'projection-lease-active', lease: existing };
    }
    const lease = {
      leaseVersion: 'a-event-projection-lease-v1',
      projectionId,
      ownerId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      ttlMs,
      metadata
    };
    this.projectionLeases.set(projectionId, lease);
    this.recordProjectionLease('acquired', lease);
    this.recordDelivery({
      deliveryId: `projection_lease_${projectionId}`,
      eventId: `projection_lease_${projectionId}`,
      subscriberId: ownerId,
      eventType: 'projection.lease',
      status: 'lease_acquired',
      deliveredAt: now
    });
    return { acquired: true, lease };
  }

  releaseProjectionLease(projectionId, {
    ownerId = 'projection-worker',
    now = this.clock().toISOString(),
    reason = 'projection-finished'
  } = {}) {
    const lease = this.projectionLeases.get(projectionId);
    if (!lease) return { released: false, reason: 'projection-lease-not-found' };
    if (lease.ownerId !== ownerId) return { released: false, reason: 'projection-lease-owner-mismatch', lease };
    this.projectionLeases.delete(projectionId);
    const released = { ...lease, releasedAt: now, releaseReason: reason };
    this.recordProjectionLease('released', released);
    this.recordDelivery({
      deliveryId: `projection_lease_release_${projectionId}`,
      eventId: `projection_lease_${projectionId}`,
      subscriberId: ownerId,
      eventType: 'projection.lease',
      status: 'lease_released',
      deliveredAt: now
    });
    return { released: true, lease: released };
  }

  recoverProjectionLeases({ now = this.clock().toISOString() } = {}) {
    const recovered = [];
    for (const lease of this.projectionLeases.values()) {
      if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
        this.projectionLeases.delete(lease.projectionId);
        const item = { ...lease, recoveredAt: now, recoveryReason: 'projection-lease-expired' };
        recovered.push(item);
        this.recordProjectionLease('recovered', item);
        this.recordDelivery({
          deliveryId: `projection_lease_recovery_${lease.projectionId}`,
          eventId: `projection_lease_${lease.projectionId}`,
          subscriberId: lease.ownerId,
          eventType: 'projection.lease',
          status: 'lease_recovered',
          deliveredAt: now
        });
      }
    }
    return {
      recoveryVersion: 'a-event-projection-lease-recovery-v1',
      now,
      recoveredCount: recovered.length,
      recovered
    };
  }

  projectionLeaseStatus({ now = this.clock().toISOString() } = {}) {
    const leases = [...this.projectionLeases.values()].map((lease) => ({
      ...lease,
      expired: Date.parse(lease.expiresAt) <= Date.parse(now)
    }));
    return {
      leaseVersion: 'a-event-projection-lease-v1',
      activeLeaseCount: leases.filter((lease) => !lease.expired).length,
      expiredLeaseCount: leases.filter((lease) => lease.expired).length,
      leases
    };
  }

  projectionLeaseBackendStatus() {
    return {
      backendVersion: 'a-event-projection-lease-file-backend-v1',
      durable: Boolean(this.projectionLeasePath),
      path: this.projectionLeasePath,
      activeLeaseCount: this.projectionLeases.size,
      replayOnStart: Boolean(this.projectionLeasePath)
    };
  }

  externalBrokerStatus() {
    return {
      adapterVersion: 'a-event-external-broker-adapter-contract-v1',
      attached: Boolean(this.brokerAdapter),
      adapterName: this.brokerAdapter?.adapterName ?? null,
      supportsPublish: typeof this.brokerAdapter?.publish === 'function',
      deliveries: this.brokerDeliveries.slice(0, 20)
    };
  }

  operationalProductGate() {
    const broker = this.externalBrokerStatus();
    const leaseBackend = this.projectionLeaseBackendStatus();
    const overflowDashboard = this.overflowPolicyDashboard();
    const checks = [
      { checkId: 'event_external_broker_adapter_ready', passed: broker.attached === true && broker.supportsPublish === true },
      { checkId: 'event_external_broker_delivery_observed', passed: broker.deliveries.some((delivery) => delivery.status === 'published') },
      { checkId: 'event_projection_lease_backend_durable', passed: leaseBackend.durable === true },
      { checkId: 'event_projection_lease_recovery_observed', passed: this.deliveryRecords.some((record) => record.status === 'lease_recovered') },
      { checkId: 'event_overflow_policy_dashboard_ready', passed: overflowDashboard.dashboardVersion === 'a-event-overflow-policy-dashboard-v1' && overflowDashboard.status === 'passed' },
      { checkId: 'event_delivery_records_available', passed: Array.isArray(this.deliveryRecords) }
    ];
    const releaseDossier = this.operationalReleaseDossier({
      checks,
      broker,
      leaseBackend,
      overflowDashboard
    });
    checks.push({
      checkId: 'event_bus_operational_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-event-bus-operational-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
    });
    checks.push({
      checkId: 'event_bus_operational_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-event-bus-operational-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-event-bus-operational-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    });
    checks.push({
      checkId: 'event_bus_operational_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'a-event-bus-operational-release-dossier-v1'
        && releaseDossier.status === 'passed'
    });
    return {
      productGateVersion: 'a-event-bus-operational-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      broker,
      leaseBackend,
      overflowDashboard,
      releaseDossier
    };
  }

  operationalReleaseDossier({
    checks = [],
    broker = this.externalBrokerStatus(),
    leaseBackend = this.projectionLeaseBackendStatus(),
    overflowDashboard = this.overflowPolicyDashboard()
  } = {}) {
    const releaseChecks = checks.map((check) => ({
      checkId: check.checkId,
      passed: check.passed === true
    }));
    const artifactManifest = createEventBusOperationalReleaseArtifactManifest({
      checks: releaseChecks,
      broker,
      leaseBackend,
      overflowDashboard,
      deliveryRecords: this.deliveryRecords,
      backpressureRecords: this.backpressureRecords,
      deadLetters: this.deadLetters,
      eventLogPath: this.eventLogPath,
      deliveryLogPath: this.deliveryLogPath,
      projectionLeasePath: this.projectionLeasePath,
      generatedAt: this.clock().toISOString()
    });
    const ciNightlyGatePlan = createEventBusOperationalCiNightlyGatePlan({ artifactManifest });
    const externalWormPromotionPackage = createEventBusOperationalExternalWormPromotionPackage({
      artifactManifest,
      ciNightlyGatePlan,
      releaseChecks
    });
    const status = checks.every((check) => check.passed)
      && broker.deliveries.some((delivery) => delivery.status === 'published')
      && this.deliveryRecords.some((record) => record.status === 'lease_recovered')
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'failed';
    const dossier = {
      dossierVersion: 'a-event-bus-operational-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status,
      brokerAdapterVersion: broker.adapterVersion,
      brokerDeliveryCount: broker.deliveries.length,
      leaseBackendVersion: leaseBackend.backendVersion,
      durableProjectionLeaseBackend: leaseBackend.durable,
      overflowDashboardVersion: overflowDashboard.dashboardVersion,
      deliveryRecordCount: this.deliveryRecords.length,
      deadLetterCount: this.deadLetters.length,
      backpressureRecordCount: this.backpressureRecords.length,
      releaseChecks,
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: status === 'passed'
        ? 'attach_event_bus_hash_only_release_manifest_and_worm_promotion_package'
        : 'block_event_bus_release_until_manifest_and_worm_gate_pass'
    };
    return {
      ...dossier,
      dossierSha256: sha256Json(dossier)
    };
  }

  findSubscription(eventType, subscriberId) {
    return [
      ...(this.subscribers.get(eventType) ?? []),
      ...(this.subscribers.get('*') ?? [])
    ].find((subscription) => subscription.subscriberId === subscriberId) ?? null;
  }

  ackKey(eventId, subscriberId) {
    return `${eventId}:${subscriberId}`;
  }

  sequenceFor(event) {
    if (Number.isFinite(event.sequence)) return event.sequence;
    const parsed = Number(String(event.eventId ?? '').replace(/^evt_/, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  recordDelivery(record) {
    this.deliveryRecords.unshift(record);
    if (this.deliveryLogPath) {
      appendJsonlSync(this.deliveryLogPath, { ...record, recordType: 'event_delivery' });
    }
    return record;
  }

  loadProjectionLeaseLog() {
    if (!existsSync(this.projectionLeasePath)) return [];
    const records = readFileSync(this.projectionLeasePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const record of records) {
      if (record.recordType === 'projection_lease_acquired') {
        this.projectionLeases.set(record.lease.projectionId, record.lease);
      } else if (record.lease?.projectionId && ['projection_lease_released', 'projection_lease_recovered'].includes(record.recordType)) {
        this.projectionLeases.delete(record.lease.projectionId);
      }
    }
    return records;
  }

  recordProjectionLease(action, lease) {
    if (!this.projectionLeasePath) return null;
    const record = {
      recordType: `projection_lease_${action}`,
      recordedAt: this.clock().toISOString(),
      lease
    };
    appendJsonlSync(this.projectionLeasePath, record);
    return record;
  }

  forwardToBroker(event) {
    if (!this.brokerAdapter || typeof this.brokerAdapter.publish !== 'function') return null;
    const delivery = {
      brokerDeliveryVersion: 'a-event-external-broker-delivery-v1',
      eventId: event.eventId,
      eventType: event.eventType,
      adapterName: this.brokerAdapter.adapterName ?? 'external-broker',
      deliveredAt: this.clock().toISOString()
    };
    try {
      const result = this.brokerAdapter.publish(event);
      const delivered = { ...delivery, status: 'published', result };
      this.brokerDeliveries.unshift(delivered);
      this.recordDelivery({
        deliveryId: `broker_${event.eventId}`,
        eventId: event.eventId,
        subscriberId: delivery.adapterName,
        eventType: event.eventType,
        status: 'broker_published',
        deliveredAt: delivery.deliveredAt
      });
      return delivered;
    } catch (error) {
      const failed = { ...delivery, status: 'failed', error: error?.message ?? String(error) };
      this.brokerDeliveries.unshift(failed);
      this.deadLetters.unshift({
        deliveryId: `broker_${event.eventId}`,
        eventId: event.eventId,
        subscriberId: delivery.adapterName,
        eventType: event.eventType,
        status: 'failed',
        error: failed.error,
        failedAt: delivery.deliveredAt,
        event
      });
      return failed;
    }
  }
}

export class InMemoryEventBrokerAdapter {
  constructor({ adapterName = 'in-memory-external-broker-adapter' } = {}) {
    this.adapterName = adapterName;
    this.events = [];
  }

  publish(event) {
    this.events.unshift({
      brokerRecordVersion: 'a-event-external-broker-record-v1',
      eventId: event.eventId,
      eventType: event.eventType,
      source: event.source,
      receivedAt: new Date().toISOString()
    });
    return { accepted: true, depth: this.events.length };
  }

  status() {
    return {
      adapterName: this.adapterName,
      depth: this.events.length,
      recent: this.events.slice(0, 20)
    };
  }
}

function normalizeTopicPolicy(policy = {}) {
  return {
    maxPendingAcks: Number.isFinite(policy.maxPendingAcks) ? policy.maxPendingAcks : Infinity,
    maxRecentEvents: Number.isFinite(policy.maxRecentEvents) ? policy.maxRecentEvents : Infinity,
    overflow: ['reject', 'drop', 'dead-letter', 'retry', 'allow'].includes(policy.overflow) ? policy.overflow : 'reject'
  };
}

function readTailText(path, maxBytes = defaultEventReplayMaxBytes) {
  const fileSizeBytes = statSync(path).size;
  const normalizedMaxBytes = normalizePositiveInteger(maxBytes, defaultEventReplayMaxBytes);
  const bytesRead = Math.min(fileSizeBytes, normalizedMaxBytes);
  if (bytesRead <= 0) {
    return {
      text: '',
      fileSizeBytes,
      bytesRead: 0,
      maxBytes: normalizedMaxBytes,
      truncated: fileSizeBytes > 0
    };
  }
  const buffer = Buffer.alloc(bytesRead);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, bytesRead, fileSizeBytes - bytesRead);
  } finally {
    closeSync(fd);
  }
  return {
    text: buffer.toString('utf8'),
    fileSizeBytes,
    bytesRead,
    maxBytes: normalizedMaxBytes,
    truncated: fileSizeBytes > bytesRead
  };
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function previewPayload(payload) {
  const text = JSON.stringify(payload ?? {});
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function createEventBusOperationalReleaseArtifactManifest({
  checks,
  broker,
  leaseBackend,
  overflowDashboard,
  deliveryRecords,
  backpressureRecords,
  deadLetters,
  eventLogPath,
  deliveryLogPath,
  projectionLeasePath,
  generatedAt
}) {
  const manifestCore = {
    artifactManifestVersion: 'a-event-bus-operational-release-artifact-manifest-v1',
    generatedAt,
    brokerContractManifest: {
      manifestVersion: 'a-event-broker-provider-contract-manifest-v1',
      adapterVersion: broker.adapterVersion,
      attached: broker.attached === true,
      supportsPublish: broker.supportsPublish === true,
      deliveryCount: broker.deliveries.length,
      rawBrokerPayloadStored: false
    },
    projectionLeaseManifest: {
      manifestVersion: 'a-event-projection-lease-operational-manifest-v1',
      backendVersion: leaseBackend.backendVersion,
      durable: leaseBackend.durable === true,
      replayOnStart: leaseBackend.replayOnStart === true,
      activeLeaseCount: leaseBackend.activeLeaseCount,
      rawProjectionLeaseIdsStored: false
    },
    overflowManifest: {
      manifestVersion: 'a-event-overflow-operational-manifest-v1',
      dashboardVersion: overflowDashboard.dashboardVersion,
      dashboardStatus: overflowDashboard.status,
      configuredTopicCount: overflowDashboard.topics.length,
      rawEventPayloadStored: false
    },
    releaseEvidenceHashes: {
      checksHash: sha256Json(checks),
      brokerDeliveryHash: sha256Json(broker.deliveries.map((delivery) => ({
        brokerDeliveryVersion: delivery.brokerDeliveryVersion,
        eventType: delivery.eventType,
        adapterName: delivery.adapterName,
        status: delivery.status
      }))),
      deliveryRecordHash: sha256Json(deliveryRecords.map((record) => ({
        eventType: record.eventType,
        status: record.status,
        redriveType: record.redriveType ?? null
      }))),
      overflowDashboardHash: sha256Json({
        dashboardVersion: overflowDashboard.dashboardVersion,
        status: overflowDashboard.status,
        topicCount: overflowDashboard.topics.length
      }),
      backpressureHash: sha256Json(backpressureRecords.map((record) => ({
        eventType: record.eventType,
        status: record.status,
        reason: record.reason,
        overflowAction: record.overflowAction
      }))),
      deadLetterHash: sha256Json(deadLetters.map((deadLetter) => ({
        eventType: deadLetter.eventType,
        status: deadLetter.status,
        subscriberIdHash: sha256Text(deadLetter.subscriberId ?? '')
      })))
    },
    eventLogPathHash: sha256Text(eventLogPath ?? 'not-configured'),
    deliveryLogPathHash: sha256Text(deliveryLogPath ?? 'not-configured'),
    projectionLeasePathHash: sha256Text(projectionLeasePath ?? 'not-configured'),
    rawEventPayloadStored: false,
    rawBrokerPayloadStored: false,
    rawDeliveryLogPathStored: false,
    rawProjectionLeasePathStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-event-bus-operational-release-raw-leak-check-v1',
      rawLeakDetected: containsEventBusOperationalRawLeak(JSON.stringify(manifestCore)),
      checkedHashes: Object.keys(manifestCore.releaseEvidenceHashes).length,
      checkedRawPayloadFlags: [
        'rawEventPayloadStored',
        'rawBrokerPayloadStored',
        'rawDeliveryLogPathStored',
        'rawProjectionLeasePathStored'
      ]
    }
  };
}

function createEventBusOperationalCiNightlyGatePlan({ artifactManifest }) {
  return {
    planVersion: 'a-event-bus-operational-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "A EventBus enforces topic backpressure and recovers projection leases" tests/ag-runtime.test.js',
    requiredForPullRequests: true,
    requiredForNightly: true,
    requiredChecks: [
      'event_external_broker_adapter_ready',
      'event_external_broker_delivery_observed',
      'event_projection_lease_backend_durable',
      'event_projection_lease_recovery_observed',
      'event_overflow_policy_dashboard_ready',
      'event_delivery_records_available',
      'event_bus_operational_release_artifact_manifest_ready',
      'event_bus_operational_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    retentionPolicy: {
      keepLatestPerBranch: 20,
      keepNightlyDays: 90,
      promotePassedReleaseDossierToWorm: true
    },
    rawEventPayloadStored: false,
    rawBrokerPayloadStored: false,
    rawProjectionLeasePayloadStored: false
  };
}

function createEventBusOperationalExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  releaseChecks
}) {
  const status = artifactManifest?.artifactManifestVersion === 'a-event-bus-operational-release-artifact-manifest-v1'
    && artifactManifest.rawLeakCheck?.rawLeakDetected === false
    && ciNightlyGatePlan?.planVersion === 'a-event-bus-operational-ci-nightly-gate-plan-v1'
    && releaseChecks.every((check) => check.passed)
    ? 'ready'
    : 'blocked';
  return {
    packageVersion: 'a-event-bus-operational-worm-promotion-package-v1',
    providerContractVersion: 'a-event-bus-operational-worm-provider-contract-v1',
    status,
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    releaseChecksHash: sha256Json(releaseChecks),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawEventPayloadStored: false,
    rawBrokerPayloadStored: false,
    rawDeliveryLogPathStored: false,
    rawProjectionLeasePathStored: false
  };
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value ?? null));
}

function containsEventBusOperationalRawLeak(value) {
  const text = String(value ?? '');
  return /"payload"\s*:|"eventLogPath"\s*:|"deliveryLogPath"\s*:|"projectionLeasePath"\s*:|rawText|commandText|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}
