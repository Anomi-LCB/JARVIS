import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createClaudeCliRunner,
  extractJsonObject,
  runnerMetadataFor
} from '../packages/core/src/intent/claude-cli-intent-adapter.js';
import { resolveOpenAiApi } from '../packages/core/src/intent/openai-api-protocol.js';

function configured(value) {
  return ![undefined, null, ''].includes(value) && String(value).trim().length > 0;
}

export function probeClaudeCli() {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'claude';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'claude --version'] : ['--version'];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const version = String(result.stdout ?? result.stderr ?? '').trim().split(/\r?\n/)[0] || null;
  return {
    available: result.status === 0 && Boolean(version),
    version,
    errorCode: result.error?.code ?? (result.status === 0 ? null : 'cli-version-check-failed')
  };
}

export function createLlmProviderReadiness({ env = process.env, cliProbe = { available: false, version: null } } = {}) {
  const openAiApi = resolveOpenAiApi(env.JARVIS_OPENAI_API ?? 'chat-completions');
  const anthropicConfigured = configured(env.JARVIS_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY);
  const openAiConfigured = configured(env.JARVIS_OPENAI_API_KEY ?? env.OPENAI_API_KEY);
  const providers = [
    ...(anthropicConfigured ? [{ provider: 'anthropic-api', ready: true }] : []),
    ...(openAiConfigured ? [{ provider: 'openai-api', ready: true }] : []),
    { provider: 'claude-cli', ready: cliProbe.available === true, version: cliProbe.version ?? null }
  ];
  return {
    readinessVersion: 'a-llm-provider-readiness-v1',
    ready: providers.some((provider) => provider.ready),
    providerOrder: providers.filter((provider) => provider.ready).map((provider) => provider.provider),
    providers,
    credentials: {
      anthropicApiConfigured: anthropicConfigured,
      openAiApiConfigured: openAiConfigured,
      rawCredentialStored: false
    },
    openAiTransport: {
      api: openAiApi,
      requestStore: openAiApi === 'responses' ? false : null,
      toolExecutionEnabled: false,
      liveVerified: false
    },
    openAiModelPolicy: {
      fast: 'gpt-5.4-mini',
      balanced: 'gpt-5.6-terra',
      frontier: 'gpt-5.6-sol',
      explicitOverride: env.JARVIS_OPENAI_MODEL ?? null
    },
    privacy: {
      rawCredentialStored: false,
      rawPromptStored: false,
      rawResponseStored: false
    }
  };
}

const PUBLIC_LLM_PROVIDER_IDS = new Set(['anthropic-api', 'openai-api', 'claude-cli']);
const PUBLIC_LLM_STATUSES = new Set([
  'passed',
  'ready-unverified',
  'running',
  'blocked-authentication',
  'blocked',
  'failed'
]);

function publicProviderId(value) {
  const provider = typeof value === 'string' ? value : '';
  return PUBLIC_LLM_PROVIDER_IDS.has(provider) ? provider : null;
}

export function createPublicLlmProviderStatus(report) {
  const reportStatus = typeof report?.status === 'string' ? report.status : 'not-generated';
  const status = PUBLIC_LLM_STATUSES.has(reportStatus) ? reportStatus : 'not-generated';
  const liveProbe = report?.liveProbe ?? {};
  const providerOrder = [...new Set(
    (report?.readiness?.providerOrder ?? []).map(publicProviderId).filter(Boolean)
  )];
  const attemptedProviders = [...new Set(
    (liveProbe.attemptedProviders ?? []).map(publicProviderId).filter(Boolean)
  )];
  const effectiveProvider = publicProviderId(liveProbe.provider);
  const providerCandidates = [...new Set([
    ...attemptedProviders,
    ...(effectiveProvider ? [effectiveProvider] : []),
    ...providerOrder
  ])];
  const authenticationBlocked = status === 'blocked-authentication' || liveProbe.category === 'authentication';
  const claudeCliAffected = providerCandidates.includes('claude-cli');
  const liveVerified = status === 'passed' && liveProbe.passed === true;

  let recoveryCommand = null;
  if (!liveVerified && authenticationBlocked) {
    recoveryCommand = claudeCliAffected ? 'claude auth login' : 'npm run llm:configure-key';
  } else if (!liveVerified && status !== 'running') {
    recoveryCommand = 'npm run llm:diagnose -- --live';
  }

  return {
    contractVersion: 'a-llm-public-status-v1',
    generatedAt: typeof report?.generatedAt === 'string' ? report.generatedAt : null,
    status,
    providerReady: report?.readiness?.ready === true,
    liveVerified,
    providerOrder,
    effectiveProvider,
    issue: {
      category: typeof liveProbe.category === 'string' ? liveProbe.category : null,
      retryable: liveProbe.retryable === true,
      requiresUserAction: liveProbe.requiresUserAction === true
    },
    recovery: {
      required: Boolean(recoveryCommand),
      command: recoveryCommand,
      verificationCommand: recoveryCommand && recoveryCommand !== 'npm run llm:diagnose -- --live'
        ? 'npm run llm:diagnose -- --live'
        : null
    },
    rawReportsExposed: false
  };
}

export function classifyLlmProviderFailure({ error, failures = [] } = {}) {
  const attemptedProviders = [...new Set(
    failures.map((failure) => failure?.provider).filter(Boolean)
  )];
  const diagnosticText = [
    error?.code,
    error?.message,
    ...failures.flatMap((failure) => [failure?.code, failure?.message])
  ].filter(Boolean).join(' ');
  const includesProvider = (provider) => attemptedProviders.includes(provider);

  if (/\b401\b|oauth.{0,40}expired|access token.{0,40}expired|failed to authenticate|authentication(?:-| )required|unauthorized|invalid api key|api key.{0,40}invalid/i.test(diagnosticText)) {
    const nextAction = includesProvider('claude-cli')
      ? 'Run "claude auth login", then rerun "npm run llm:diagnose -- --live".'
      : 'Refresh the configured provider credential, restart JARVIS, then rerun the live diagnostic.';
    return {
      category: 'authentication',
      errorCode: 'provider-authentication-required',
      retryable: false,
      requiresUserAction: true,
      attemptedProviders,
      nextAction
    };
  }
  if (/\b429\b|rate.?limit|quota exceeded|insufficient_quota/i.test(diagnosticText)) {
    return {
      category: 'rate-limit',
      errorCode: 'provider-rate-limited',
      retryable: true,
      requiresUserAction: false,
      attemptedProviders,
      nextAction: 'Wait for the provider retry window, then rerun the live diagnostic.'
    };
  }
  if (/timed?\s*out|timeout|etimedout/i.test(diagnosticText)) {
    return {
      category: 'timeout',
      errorCode: 'provider-timeout',
      retryable: true,
      requiresUserAction: false,
      attemptedProviders,
      nextAction: 'Check provider connectivity and rerun the live diagnostic.'
    };
  }
  if (/invalid json|malformed|unexpected response|fixture response/i.test(diagnosticText)) {
    return {
      category: 'response-format',
      errorCode: 'provider-invalid-response',
      retryable: true,
      requiresUserAction: false,
      attemptedProviders,
      nextAction: 'Rerun the live diagnostic; inspect the provider adapter if the response remains invalid.'
    };
  }
  return {
    category: 'provider-call',
    errorCode: error?.code && error.code !== 'runner-error' ? error.code : 'provider-call-failed',
    retryable: true,
    requiresUserAction: false,
    attemptedProviders,
    nextAction: 'Rerun the live diagnostic and inspect local provider connectivity if it fails again.'
  };
}

function runnerFailureEvidence(runner, error) {
  if (Array.isArray(runner?.lastFailures) && runner.lastFailures.length > 0) {
    return runner.lastFailures;
  }
  const provider = runner?.lastProvider ?? runner?.provider;
  return provider ? [{ provider, code: error?.code, message: error?.message }] : [];
}

export async function runLlmProviderDiagnostics({
  env = process.env,
  live = false,
  cliProbe = probeClaudeCli(),
  runnerFactory = createClaudeCliRunner,
  clock = () => new Date()
} = {}) {
  const readiness = createLlmProviderReadiness({ env, cliProbe });
  const report = {
    reportVersion: 'a-llm-provider-diagnostics-v1',
    generatedAt: clock().toISOString(),
    status: readiness.ready ? (live ? 'running' : 'ready-unverified') : 'blocked',
    readiness,
    liveProbe: {
      requested: live,
      passed: null,
      fixedNonSensitiveFixture: true,
      rawPromptStored: false,
      rawResponseStored: false
    }
  };

  if (!live || !readiness.ready) return report;

  const runner = runnerFactory({
    apiKey: env.JARVIS_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY,
    openAiApiKey: env.JARVIS_OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    openAiApi: env.JARVIS_OPENAI_API ?? 'chat-completions',
    openAiModel: env.JARVIS_OPENAI_MODEL,
    model: 'haiku',
    timeoutMs: 90_000
  });
  const startedAt = Date.now();
  try {
    const output = runner('Return exactly one JSON object and no markdown: {"ok":true}');
    const wrapper = extractJsonObject(output);
    const payload = wrapper && typeof wrapper.result === 'string'
      ? extractJsonObject(wrapper.result)
      : wrapper;
    const metadata = runnerMetadataFor(runner, 'diagnostic-default');
    const passed = payload?.ok === true;
    report.liveProbe = {
      ...report.liveProbe,
      passed,
      latencyMs: Date.now() - startedAt,
      provider: runner.lastProvider ?? metadata.provider,
      externalService: runner.lastExternalService ?? metadata.externalService,
      model: runner.lastModel ?? metadata.model,
      api: (runner.lastProvider ?? metadata.provider) === 'openai-api'
        ? runner.lastApi ?? runner.api ?? null
        : null,
      providerFallbackCount: runner.lastFailures?.length ?? 0,
      usage: runner.lastUsage ?? null,
      providerCostUsd: runner.lastCostUsd ?? null,
      outputFingerprint: createHash('sha256').update(String(output)).digest('hex').slice(0, 16)
    };
    if (passed) {
      report.status = 'passed';
    } else {
      const failure = classifyLlmProviderFailure({
        error: new Error('invalid diagnostic fixture response'),
        failures: runnerFailureEvidence(runner)
      });
      report.liveProbe = { ...report.liveProbe, ...failure };
      report.status = 'failed';
    }
  } catch (error) {
    const failure = classifyLlmProviderFailure({ error, failures: runnerFailureEvidence(runner, error) });
    report.liveProbe = {
      ...report.liveProbe,
      passed: false,
      latencyMs: Date.now() - startedAt,
      ...failure,
      errorFingerprint: createHash('sha256').update(String(error?.message ?? error)).digest('hex').slice(0, 16)
    };
    report.status = failure.requiresUserAction ? 'blocked-authentication' : 'failed';
  }
  return report;
}

export async function writeLlmProviderDiagnostics(report, {
  jsonPath = 'dist/llm-provider-diagnostics.json',
  markdownPath = 'dist/llm-provider-diagnostics.md'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, [
    '# JARVIS LLM Provider Diagnostics',
    '',
    `Status: ${report.status}`,
    `Provider order: ${report.readiness.providerOrder.join(' -> ') || 'none'}`,
    `OpenAI API configured: ${report.readiness.credentials.openAiApiConfigured}`,
    `Selected OpenAI transport: ${report.readiness.openAiTransport?.api ?? 'not-reported'}`,
    `Anthropic API configured: ${report.readiness.credentials.anthropicApiConfigured}`,
    `Live probe: ${report.liveProbe.requested ? report.liveProbe.passed : 'not-requested'}`,
    `Effective provider: ${report.liveProbe.provider ?? 'none'}`,
    `Effective model: ${report.liveProbe.model ?? 'none'}`,
    `Effective API: ${report.liveProbe.api ?? 'not-reported'}`,
    `Input tokens: ${report.liveProbe.usage?.inputTokens ?? 'not-reported'}`,
    `Output tokens: ${report.liveProbe.usage?.outputTokens ?? 'not-reported'}`,
    `Provider cost USD: ${report.liveProbe.providerCostUsd ?? 'not-reported'}`,
    `Failure category: ${report.liveProbe.category ?? 'none'}`,
    `Requires user action: ${report.liveProbe.requiresUserAction ?? false}`,
    `Next action: ${report.liveProbe.nextAction ?? 'none'}`,
    'Raw credentials/prompts/responses stored: false',
    ''
  ].join('\n'), 'utf8');
  return { jsonPath, markdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runLlmProviderDiagnostics({ live: process.argv.includes('--live') });
  const artifacts = await writeLlmProviderDiagnostics(report);
  console.log('# JARVIS LLM Provider Diagnostics');
  console.log(`Status: ${report.status}`);
  console.log(`Provider order: ${report.readiness.providerOrder.join(' -> ') || 'none'}`);
  console.log(`Live probe: ${report.liveProbe.requested ? report.liveProbe.passed : 'not-requested'}`);
  if (report.liveProbe.nextAction) console.log(`Next action: ${report.liveProbe.nextAction}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}`);
  if (!['passed', 'ready-unverified'].includes(report.status)) process.exitCode = 1;
}
