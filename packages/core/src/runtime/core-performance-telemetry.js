export class CorePerformanceTelemetry {
  constructor({ clock = () => new Date(), sampleLimit = 256, durabilityBatching = true } = {}) {
    this.clock = clock;
    this.sampleLimit = normalizeSampleLimit(sampleLimit);
    this.durabilityBatching = durabilityBatching !== false;
    this.samples = [];
  }

  record({ operation, durationMs, status = 'completed', durability = null } = {}) {
    const sample = {
      sampleVersion: 'a-core-operation-performance-sample-v1',
      operation: String(operation ?? 'unknown'),
      status,
      durationMs: finiteDuration(durationMs),
      durability: normalizeDurability(durability),
      recordedAt: this.clock().toISOString(),
      rawCommandStored: false
    };
    this.samples.push(sample);
    if (this.samples.length > this.sampleLimit) {
      this.samples.splice(0, this.samples.length - this.sampleLimit);
    }
    return sample;
  }

  snapshot() {
    const operationNames = [...new Set(this.samples.map((sample) => sample.operation))];
    const logicalRecordCount = sum(this.samples.map((sample) => sample.durability.logicalRecordCount));
    const physicalWriteCount = sum(this.samples.map((sample) => sample.durability.physicalWriteCount));
    const fileCount = sum(this.samples.map((sample) => sample.durability.fileCount));
    return {
      telemetryVersion: 'a-core-performance-telemetry-v1',
      generatedAt: this.clock().toISOString(),
      mode: this.durabilityBatching ? 'operation-scoped-durable-batching' : 'legacy-immediate-durability',
      sampleLimit: this.sampleLimit,
      sampleCount: this.samples.length,
      aggregate: summarizeSamples(this.samples),
      operations: Object.fromEntries(operationNames.map((operation) => [
        operation,
        summarizeSamples(this.samples.filter((sample) => sample.operation === operation))
      ])),
      durability: {
        logicalRecordCount,
        physicalWriteCount,
        fileCount,
        writeReductionRatio: logicalRecordCount > 0
          ? round(1 - physicalWriteCount / logicalRecordCount, 6)
          : 0
      },
      privacy: {
        rawCommandStored: false,
        rawContextStored: false,
        sampledFields: ['operation', 'status', 'durationMs', 'durability-counts', 'recordedAt']
      },
      recent: this.samples.slice(-20)
    };
  }
}

function summarizeSamples(samples) {
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const totalDurationMs = sum(durations);
  const completedCount = samples.filter((sample) => sample.status === 'completed').length;
  const failedCount = samples.length - completedCount;
  const averageMs = durations.length > 0 ? totalDurationMs / durations.length : 0;
  return {
    count: samples.length,
    completedCount,
    failedCount,
    averageMs: round(averageMs),
    minMs: round(durations[0] ?? 0),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    p99Ms: round(percentile(durations, 0.99)),
    maxMs: round(durations.at(-1) ?? 0),
    estimatedThroughputPerSecond: averageMs > 0 ? round(1000 / averageMs, 3) : 0
  };
}

function normalizeDurability(durability) {
  return {
    enabled: durability?.enabled === true,
    logicalRecordCount: nonNegativeInteger(durability?.logicalRecordCount),
    physicalWriteCount: nonNegativeInteger(durability?.physicalWriteCount),
    fileCount: nonNegativeInteger(durability?.fileCount),
    writeReductionRatio: Number.isFinite(durability?.writeReductionRatio)
      ? round(Math.max(0, Math.min(1, durability.writeReductionRatio)), 6)
      : 0,
    flushDurationMs: finiteDuration(durability?.flushDurationMs)
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function finiteDuration(value) {
  return round(Number.isFinite(value) ? Math.max(0, value) : 0);
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeSampleLimit(value) {
  return Number.isFinite(value) ? Math.max(16, Math.min(4096, Math.floor(value))) : 256;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
