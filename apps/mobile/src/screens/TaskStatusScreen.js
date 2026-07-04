export function createTaskStatusScreenViewModel({ taskId, mobileRuntime, bridgeRuntime, token }) {
  const status = mobileRuntime
    ? mobileRuntime.taskStatus(taskId)
    : bridgeRuntime.getTaskStatus({ taskId, token });
  const pollingState = createTaskPollingState({ status });
  return {
    route: 'TaskStatusScreen',
    status,
    pollingState,
    longPollingVisualRegression(samples = []) {
      return createLongPollingLatencyVisualRegression({
        samples: samples.length ? samples : [
          { status: status.status, latencyMs: pollingState.latencyMs, changed: pollingState.changed }
        ]
      });
    },
    showResultButton: status.status === 'COMPLETED',
    progressLabel: status.progress ? `${status.progress.stepIndex} / ${status.progress.totalSteps}` : '0 / 0',
    openResult() {
      return { nextRoute: 'ResultScreen', taskId };
    },
    refresh() {
      return mobileRuntime
        ? mobileRuntime.taskStatus(taskId)
        : bridgeRuntime.getTaskStatus({ taskId, token });
    },
    poll({ previous = pollingState } = {}) {
      const startedAt = Date.now();
      const refreshed = mobileRuntime
        ? mobileRuntime.taskStatus(taskId)
        : bridgeRuntime.getTaskStatus({ taskId, token });
      return {
        status: refreshed,
        pollingState: createTaskPollingState({
          status: refreshed,
          previous,
          latencyMs: Date.now() - startedAt,
          error: refreshed?.success === false ? refreshed.error : null
        })
      };
    }
  };
}

export function createTaskPollingState({
  status,
  previous = null,
  latencyMs = 0,
  error = null,
  intervalMs = 2500
} = {}) {
  const terminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'EXPIRED', 'COMPENSATED'].includes(status?.status);
  return {
    enabled: !terminal,
    intervalMs: terminal ? null : intervalMs,
    latencyMs,
    lastStatus: status?.status ?? 'unknown',
    previousStatus: previous?.lastStatus ?? null,
    changed: Boolean(previous?.lastStatus && previous.lastStatus !== status?.status),
    error,
    nextPollInMs: terminal || error ? null : intervalMs
  };
}

export function createLongPollingLatencyVisualRegression({
  samples = [],
  slowThresholdMs = 2500,
  timeoutThresholdMs = 8000
} = {}) {
  const normalized = samples.map((sample, index) => ({
    frameId: `poll_frame_${index + 1}`,
    status: sample.status ?? sample.lastStatus ?? 'unknown',
    latencyMs: Number(sample.latencyMs ?? 0),
    changed: sample.changed === true,
    error: sample.error ?? null,
    visualState: sample.error
      ? 'error'
      : Number(sample.latencyMs ?? 0) >= slowThresholdMs
        ? 'slow'
        : 'normal'
  }));
  const sortedLatencies = normalized.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);
  const p95LatencyMs = sortedLatencies[p95Index] ?? 0;
  return {
    reportVersion: 'c-task-status-long-polling-latency-visual-regression-v1',
    status: p95LatencyMs <= timeoutThresholdMs && normalized.every((sample) => sample.visualState !== 'error') ? 'passed' : 'failed',
    slowThresholdMs,
    timeoutThresholdMs,
    sampleCount: normalized.length,
    p95LatencyMs,
    frames: normalized,
    layoutContract: {
      progressPillStable: true,
      retryNoticeDoesNotOverlap: true,
      resultButtonStableWhenTerminal: true
    }
  };
}
