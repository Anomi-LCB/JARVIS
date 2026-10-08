import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const successStatuses = new Set(['success', 'succeeded', 'completed', 'passed']);

export class ExecutionHealthRegistry {
  constructor({
    clock = () => new Date(),
    storePath = null,
    sampleLimit = 64,
    failureThreshold = 3,
    cooldownMs = 60_000
  } = {}) {
    this.clock = clock;
    this.storePath = storePath ? String(storePath) : null;
    this.sampleLimit = clampInteger(sampleLimit, 8, 512, 64);
    this.failureThreshold = clampInteger(failureThreshold, 2, 20, 3);
    this.cooldownMs = clampInteger(cooldownMs, 1_000, 3_600_000, 60_000);
    this.records = new Map();
    this.load();
  }

  record({ toolName, status, success, durationMs = 0, errorCode = null, source = 'core-worker' } = {}) {
    const normalizedToolName = cleanToolName(toolName);
    if (!normalizedToolName) return null;
    const now = this.clock().toISOString();
    const succeeded = success === true || (success !== false && successStatuses.has(String(status ?? '').toLowerCase()));
    const record = this.records.get(normalizedToolName) ?? emptyRecord(normalizedToolName);
    record.samples.push({
      outcome: succeeded ? 'success' : 'failure',
      durationMs: finiteDuration(durationMs),
      errorCode: succeeded ? null : cleanErrorCode(errorCode),
      source: cleanSource(source),
      recordedAt: now
    });
    if (record.samples.length > this.sampleLimit) {
      record.samples.splice(0, record.samples.length - this.sampleLimit);
    }
    record.lastOutcome = succeeded ? 'success' : 'failure';
    record.lastRecordedAt = now;
    if (succeeded) {
      record.consecutiveFailures = 0;
      record.circuitOpenedAt = null;
    } else {
      record.consecutiveFailures += 1;
      if (record.consecutiveFailures >= this.failureThreshold) record.circuitOpenedAt = now;
    }
    this.records.set(normalizedToolName, record);
    this.persist();
    return this.statusFor(normalizedToolName);
  }

  statusFor(toolName) {
    const normalizedToolName = cleanToolName(toolName);
    const record = this.records.get(normalizedToolName) ?? emptyRecord(normalizedToolName);
    const nowMs = this.clock().getTime();
    const openedAtMs = Date.parse(record.circuitOpenedAt ?? '');
    let circuitState = 'closed';
    let cooldownRemainingMs = 0;
    if (Number.isFinite(openedAtMs)) {
      const elapsedMs = Math.max(0, nowMs - openedAtMs);
      circuitState = elapsedMs >= this.cooldownMs ? 'half_open' : 'open';
      cooldownRemainingMs = circuitState === 'open' ? Math.max(0, this.cooldownMs - elapsedMs) : 0;
    }
    const successes = record.samples.filter((sample) => sample.outcome === 'success').length;
    const failures = record.samples.length - successes;
    const durations = record.samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
    return {
      healthVersion: 'a-execution-tool-health-v1',
      toolName: normalizedToolName,
      circuitState,
      eligible: circuitState !== 'open',
      sampleCount: record.samples.length,
      successCount: successes,
      failureCount: failures,
      observedReliability: record.samples.length > 0 ? round(successes / record.samples.length, 6) : null,
      averageLatencyMs: durations.length > 0 ? round(sum(durations) / durations.length) : null,
      p50LatencyMs: durations.length > 0 ? round(percentile(durations, 0.5)) : null,
      p95LatencyMs: durations.length > 0 ? round(percentile(durations, 0.95)) : null,
      consecutiveFailures: record.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      cooldownRemainingMs,
      lastOutcome: record.lastOutcome,
      lastRecordedAt: record.lastRecordedAt,
      lastErrorCode: record.samples.at(-1)?.errorCode ?? null
    };
  }

  snapshot(toolNames = []) {
    const names = [...new Set([
      ...this.records.keys(),
      ...(Array.isArray(toolNames) ? toolNames.map(cleanToolName).filter(Boolean) : [])
    ])].sort();
    const tools = names.map((toolName) => this.statusFor(toolName));
    return {
      registryVersion: 'a-adaptive-execution-health-registry-v1',
      generatedAt: this.clock().toISOString(),
      persistence: {
        enabled: Boolean(this.storePath),
        storePathConfigured: Boolean(this.storePath),
        rawCommandStored: false,
        rawArgumentsStored: false
      },
      policy: {
        sampleLimit: this.sampleLimit,
        failureThreshold: this.failureThreshold,
        cooldownMs: this.cooldownMs
      },
      summary: {
        toolCount: tools.length,
        observedToolCount: tools.filter((tool) => tool.sampleCount > 0).length,
        openCircuitCount: tools.filter((tool) => tool.circuitState === 'open').length,
        halfOpenCircuitCount: tools.filter((tool) => tool.circuitState === 'half_open').length,
        healthyObservedToolCount: tools.filter((tool) => tool.sampleCount > 0 && tool.circuitState === 'closed').length
      },
      tools
    };
  }

  reset(toolName = null) {
    if (toolName) this.records.delete(cleanToolName(toolName));
    else this.records.clear();
    this.persist();
  }

  load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const payload = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of payload?.records ?? []) {
        const toolName = cleanToolName(item?.toolName);
        if (!toolName) continue;
        this.records.set(toolName, {
          toolName,
          samples: Array.isArray(item.samples) ? item.samples.slice(-this.sampleLimit).map(normalizeSample).filter(Boolean) : [],
          consecutiveFailures: clampInteger(item.consecutiveFailures, 0, this.failureThreshold, 0),
          circuitOpenedAt: validIso(item.circuitOpenedAt),
          lastOutcome: ['success', 'failure'].includes(item.lastOutcome) ? item.lastOutcome : null,
          lastRecordedAt: validIso(item.lastRecordedAt)
        });
      }
    } catch {
      this.records.clear();
    }
  }

  persist() {
    if (!this.storePath) return;
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify({
        registryVersion: 'a-adaptive-execution-health-store-v1',
        updatedAt: this.clock().toISOString(),
        records: [...this.records.values()]
      }, null, 2), 'utf8');
      try {
        renameSync(tempPath, this.storePath);
      } catch {
        rmSync(this.storePath, { force: true });
        renameSync(tempPath, this.storePath);
      }
    } catch {
      rmSync(tempPath, { force: true });
    }
  }
}

function emptyRecord(toolName) {
  return {
    toolName,
    samples: [],
    consecutiveFailures: 0,
    circuitOpenedAt: null,
    lastOutcome: null,
    lastRecordedAt: null
  };
}

function normalizeSample(sample) {
  if (!sample || !['success', 'failure'].includes(sample.outcome)) return null;
  return {
    outcome: sample.outcome,
    durationMs: finiteDuration(sample.durationMs),
    errorCode: sample.outcome === 'failure' ? cleanErrorCode(sample.errorCode) : null,
    source: cleanSource(sample.source),
    recordedAt: validIso(sample.recordedAt) ?? new Date(0).toISOString()
  };
}

function cleanToolName(value) {
  const normalized = String(value ?? '').trim().slice(0, 160);
  return normalized || null;
}

function cleanErrorCode(value) {
  const normalized = String(value ?? 'EXECUTION_FAILED').trim().replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 160);
  return normalized || 'EXECUTION_FAILED';
}

function cleanSource(value) {
  return String(value ?? 'core-worker').trim().replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 80) || 'core-worker';
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function finiteDuration(value) {
  const parsed = Number(value);
  return round(Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
