import { availableParallelism, freemem, platform, totalmem } from 'node:os';
import { existsSync } from 'node:fs';

export function createExecutionEnvironmentProfile({
  env = process.env,
  system = {},
  requested = {},
  browserDriverConfigured = false,
  desktopControlConfigured = false,
  desktopVisionConfigured = false
} = {}) {
  const logicalProcessors = positiveInteger(system.logicalProcessors, safeParallelism());
  const totalMemoryBytes = positiveNumber(system.totalMemoryBytes, totalmem());
  const freeMemoryBytes = positiveNumber(system.freeMemoryBytes, freemem());
  const memoryGiB = round(totalMemoryBytes / 1024 ** 3, 2);
  const freeMemoryGiB = round(freeMemoryBytes / 1024 ** 3, 2);
  const memoryPressure = totalMemoryBytes > 0 ? 1 - freeMemoryBytes / totalMemoryBytes : 0;
  const performanceTier = selectTier({ logicalProcessors, memoryGiB, memoryPressure });
  const recommended = recommendationsFor({ logicalProcessors, performanceTier, memoryPressure });
  const explicit = {
    workerMaxQueueConcurrency: firstInteger(requested.workerMaxQueueConcurrency, env.JARVIS_WORKER_MAX_QUEUE_CONCURRENCY),
    workerMaxPlanParallelism: firstInteger(requested.workerMaxPlanParallelism, env.JARVIS_WORKER_MAX_PLAN_PARALLELISM),
    workerDefaultTimeoutMs: firstInteger(requested.workerDefaultTimeoutMs, env.JARVIS_WORKER_DEFAULT_TIMEOUT_MS),
    missionMaxPlannerTools: firstInteger(requested.missionMaxPlannerTools, env.JARVIS_MISSION_MAX_TOOLS)
  };
  const applied = Object.fromEntries(Object.entries(recommended).map(([key, value]) => [key, {
    value: explicit[key] ?? value,
    source: explicit[key] == null ? 'environment-recommendation' : 'explicit-configuration'
  }]));
  const providerReadiness = providerStatus(env);
  const mcpConfigured = Boolean(env.JARVIS_MCP_SERVER_URLS || env.JARVIS_MCP_CONFIG_JSON || configuredPathExists(env.JARVIS_MCP_CONFIG_PATH));
  const hostedAiConfigured = providerReadiness.some((provider) => provider.credentialConfigured);
  const platformName = String(system.platform ?? platform());
  const channels = {
    localExecution: readiness('ready', 'Built-in deterministic and structured local adapters are registered.'),
    hostedAi: hostedAiConfigured
      ? readiness('configured-unverified', 'At least one hosted model credential is configured; live calls remain independently verified.')
      : readiness('not-configured', 'No hosted model credential is configured.'),
    mcp: mcpConfigured
      ? readiness('configured-unverified', 'MCP configuration is present; individual servers still require handshake verification.')
      : readiness('not-configured', 'No MCP server configuration is present.'),
    webDom: readiness(browserDriverConfigured ? 'configured-unverified' : 'registered', browserDriverConfigured
      ? 'A browser driver was injected and will be verified per task.'
      : 'The built-in read-only browser adapter is registered; live engine availability is verified per task.'),
    desktopUia: readiness(desktopControlConfigured || platformName === 'win32' ? 'registered' : 'not-configured',
      desktopControlConfigured ? 'A desktop control adapter was injected.' : platformName === 'win32'
        ? 'Windows UI Automation is registered and requires an interactive user session.'
        : 'Windows UI Automation is unavailable on this platform.'),
    desktopVision: desktopVisionConfigured || env.JARVIS_DESKTOP_VISION_ENABLED === '1'
      ? readiness('configured-unverified', 'Desktop vision recovery is enabled and requires a live foreground-window check.')
      : readiness('not-configured', 'Desktop vision recovery is not enabled.')
  };
  return {
    profileVersion: 'a-execution-environment-profile-v1',
    generatedAt: new Date().toISOString(),
    system: {
      platform: platformName,
      architecture: String(system.architecture ?? process.arch),
      nodeVersion: String(system.nodeVersion ?? process.version),
      logicalProcessors,
      totalMemoryGiB: memoryGiB,
      freeMemoryGiB,
      memoryPressure: round(memoryPressure, 4),
      performanceTier
    },
    applied,
    providers: providerReadiness,
    channels,
    recommendations: recommendationNotes({ performanceTier, memoryPressure, mcpConfigured, hostedAiConfigured }),
    privacy: {
      credentialValuesStored: false,
      environmentValuesStored: false,
      rawPathsStored: false
    }
  };
}

function selectTier({ logicalProcessors, memoryGiB, memoryPressure }) {
  if (logicalProcessors <= 4 || memoryGiB < 8 || memoryPressure >= 0.92) return 'constrained';
  if (logicalProcessors >= 8 && memoryGiB >= 16 && memoryPressure < 0.85) return 'performance';
  return 'balanced';
}

function recommendationsFor({ logicalProcessors, performanceTier, memoryPressure }) {
  if (performanceTier === 'constrained') {
    return {
      workerMaxQueueConcurrency: 2,
      workerMaxPlanParallelism: 2,
      workerDefaultTimeoutMs: 45_000,
      missionMaxPlannerTools: 8
    };
  }
  if (performanceTier === 'performance') {
    return {
      workerMaxQueueConcurrency: Math.min(6, Math.max(4, Math.floor(logicalProcessors / 2))),
      workerMaxPlanParallelism: Math.min(4, Math.max(3, Math.floor(logicalProcessors / 3))),
      workerDefaultTimeoutMs: memoryPressure > 0.8 ? 45_000 : 30_000,
      missionMaxPlannerTools: 12
    };
  }
  return {
    workerMaxQueueConcurrency: 4,
    workerMaxPlanParallelism: 3,
    workerDefaultTimeoutMs: 35_000,
    missionMaxPlannerTools: 10
  };
}

function providerStatus(env) {
  return [
    provider('anthropic-api', Boolean(env.JARVIS_ANTHROPIC_API_KEY)),
    provider('openai-api', Boolean(env.JARVIS_OPENAI_API_KEY)),
    {
      provider: 'claude-cli',
      credentialConfigured: false,
      candidate: env.JARVIS_CLAUDE_CLI_ENABLED !== '0',
      verification: 'runtime-probe-required'
    }
  ];
}

function provider(name, configured) {
  return {
    provider: name,
    credentialConfigured: configured,
    candidate: configured,
    verification: configured ? 'live-probe-required' : 'not-configured'
  };
}

function recommendationNotes({ performanceTier, memoryPressure, mcpConfigured, hostedAiConfigured }) {
  const notes = [{
    code: `environment-tier:${performanceTier}`,
    priority: 'applied',
    message: 'Queue concurrency, plan parallelism, timeout, and planner catalog size were selected for this machine tier.'
  }];
  if (memoryPressure >= 0.85) notes.push({
    code: 'memory-pressure-high',
    priority: 'watch',
    message: 'Free memory is low; avoid adding browser or vision workers until pressure falls.'
  });
  if (!hostedAiConfigured) notes.push({
    code: 'hosted-ai-not-configured',
    priority: 'optional',
    message: 'Local and CLI routes remain active; hosted AI routes stay unavailable until an API credential is configured.'
  });
  if (!mcpConfigured) notes.push({
    code: 'mcp-not-configured',
    priority: 'optional',
    message: 'MCP remains deferred until a concrete server and permission scope are configured.'
  });
  return notes;
}

function readiness(status, reason) {
  return { status, reason };
}

function configuredPathExists(value) {
  if (!value) return false;
  try {
    return existsSync(String(value));
  } catch {
    return false;
  }
}

function safeParallelism() {
  try {
    return availableParallelism();
  } catch {
    return 4;
  }
}

function firstInteger(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
