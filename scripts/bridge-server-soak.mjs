import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import {
  createBridgeReverseProxyLabDossier,
  createBridgeServer,
  createBridgeServerReleaseDossier,
  createBridgeServerProductGate
} from '../apps/bridge/src/main.mjs';
import { BridgeClient } from '../apps/mobile/src/api/BridgeClient.js';

const defaultArtifactDir = 'dist';
const defaultCycles = 4;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function addCheck(report, id, passed, evidence = {}) {
  const check = {
    id,
    passed: Boolean(passed),
    evidence
  };
  report.checks.push(check);
  return check;
}

async function readSseOpenFrame(url, { timeoutMs = 2500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    controller.abort();
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text,
      opened: response.status === 200 && text.includes('event: stream.opened')
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForWebSocketOpen(socket, { timeoutMs = 2500 } = {}) {
  if (socket.readyState === WebSocket.OPEN) return true;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('websocket-open-timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve(true);
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(event?.message ?? 'websocket-open-error'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

async function waitForWebSocketMessage(socket, predicate, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('websocket-message-timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate || predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(event?.message ?? 'websocket-message-error'));
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

async function probeWebSocket(url) {
  if (typeof WebSocket === 'undefined') {
    return {
      available: false,
      opened: false,
      reason: 'global-websocket-unavailable'
    };
  }
  const socket = new WebSocket(url, 'jarvis-events.v1');
  try {
    await waitForWebSocketOpen(socket);
    const opened = await waitForWebSocketMessage(socket, (message) => message.type === 'stream.opened');
    socket.send(JSON.stringify({ type: 'ping', requestId: 'bridge-soak-ping' }));
    const pong = await waitForWebSocketMessage(socket, (message) => message.type === 'pong' && message.requestId === 'bridge-soak-ping');
    return {
      available: true,
      opened: true,
      streamId: opened.streamId,
      channel: opened.channel,
      pong
    };
  } finally {
    socket.close();
  }
}

export async function runBridgeServerSoak({
  cycles = Number(process.env.JARVIS_BRIDGE_SOAK_CYCLES ?? defaultCycles),
  artifactDir = defaultArtifactDir,
  auditRoot = join(artifactDir, 'bridge-server-soak-audit')
} = {}) {
  await mkdir(artifactDir, { recursive: true });
  const report = {
    reportVersion: 'd-bridge-server-soak-report-v1',
    generatedAt: new Date().toISOString(),
    status: 'running',
    mode: 'user-process-bridge-server-soak',
    cycles,
    checks: [],
    iterations: [],
    metrics: {
      httpSuccesses: 0,
      sseSuccesses: 0,
      webSocketSuccesses: 0,
      rateLimitOperationalChecks: 0,
      cacheOperationalChecks: 0,
      deploymentProfileSuccesses: 0
    },
    artifacts: {
      directory: artifactDir
    }
  };
  const { bridgeRuntime } = createAgRuntime({
    auditRoot,
    outputPath: join(artifactDir, 'bridge-server-soak-output.txt')
  });
  const server = createBridgeServer(bridgeRuntime);
  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    report.bridge = {
      baseUrl,
      address
    };
    let activeToken = null;
    const client = new BridgeClient({ bridgeUrl: baseUrl, tokenProvider: () => activeToken });
    const health = await client.getHealth();
    const serverProfile = await client.getServerProfile();
    const deploymentProfile = await client.getDeploymentProfile();
    addCheck(report, 'health-ok', health.status === 'ok' && health.module === 'D_BRIDGE', health);
    addCheck(report, 'server-profile-websocket', serverProfile.frameworkCompatibility?.websocket === true && serverProfile.webSocketChannel?.enabled === true, serverProfile.webSocketChannel);
    addCheck(report, 'deployment-profile-tls-reverse-proxy-ready', deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1' && deploymentProfile.tls?.strategy === 'reverse-proxy-termination', deploymentProfile.tls);
    addCheck(report, 'deployment-profile-process-manager-ready', Boolean(deploymentProfile.processManager?.entrypoint) && deploymentProfile.processManager?.soakCommand === 'npm run bridge:server-soak', deploymentProfile.processManager);
    if (deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1') report.metrics.deploymentProfileSuccesses += 1;

    const pairing = await client.startPairing();
    const confirmed = await client.confirmPairing({
      deviceId: 'mobile_bridge_soak_001',
      deviceName: 'Bridge Soak Phone',
      pairingCode: pairing.pairingCode
    });
    activeToken = confirmed.deviceToken;
    addCheck(report, 'device-pairing-token-issued', confirmed.success === true && Boolean(activeToken), {
      deviceId: confirmed.deviceId,
      tokenVersion: confirmed.token?.tokenVersion
    });
    const rateLimitStatus = await client.getRateLimitStatus();
    const rateLimitAbuse = await client.getRateLimitAbuseCorpus();
    const rateLimitProductGate = await client.runRateLimitProductGate();
    addCheck(report, 'rate-limit-policy-shared-backend-ready', rateLimitStatus.success === true
      && rateLimitStatus.snapshot?.policySource?.policyVersion === 'd-rate-limit-policy-v1'
      && rateLimitStatus.snapshot?.sharedBackend?.backendVersion === 'd-rate-limit-shared-backend-v1', {
      policySource: rateLimitStatus.snapshot?.policySource,
      sharedBackend: rateLimitStatus.snapshot?.sharedBackend
    });
    addCheck(report, 'rate-limit-abuse-corpus-passed', rateLimitAbuse.report?.reportVersion === 'd-rate-limit-abuse-corpus-report-v1'
      && rateLimitAbuse.report?.status === 'passed', rateLimitAbuse.report);
    addCheck(report, 'rate-limit-product-gate-passed', rateLimitProductGate.productGateVersion === 'd-rate-limit-product-gate-v1'
      && rateLimitProductGate.status === 'passed', rateLimitProductGate);
    if (rateLimitStatus.success === true) report.metrics.rateLimitOperationalChecks += 1;
    if (rateLimitAbuse.report?.status === 'passed') report.metrics.rateLimitOperationalChecks += 1;
    if (rateLimitProductGate.status === 'passed') report.metrics.rateLimitOperationalChecks += 1;
    const cacheSchema = await client.getCacheSchemaSnapshot();
    const cacheSchemaDiff = await client.diffCacheSchema(cacheSchema.snapshot);
    const cacheProductGate = await client.runCacheProductGate({
      baseline: cacheSchema.snapshot,
      reason: 'bridge_soak_cache_product_gate'
    });
    addCheck(report, 'cache-schema-snapshot-diff-passed', cacheSchema.snapshot?.snapshotVersion === 'd-state-cache-schema-snapshot-v1'
      && cacheSchemaDiff.diff?.status === 'passed'
      && cacheSchema.externalStore?.backendVersion === 'd-state-cache-external-store-contract-v1', {
      snapshotHash: cacheSchema.snapshot?.snapshotHash,
      diff: cacheSchemaDiff.diff,
      externalStore: cacheSchema.externalStore
    });
    addCheck(report, 'cache-product-gate-passed', cacheProductGate.productGateVersion === 'd-state-cache-product-gate-v1'
      && cacheProductGate.status === 'passed'
      && cacheProductGate.rotationDrill?.drillVersion === 'd-state-cache-rotation-archive-drill-v1', cacheProductGate);
    if (cacheSchemaDiff.diff?.status === 'passed') report.metrics.cacheOperationalChecks += 1;
    if (cacheProductGate.status === 'passed') report.metrics.cacheOperationalChecks += 1;

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const startedAt = new Date().toISOString();
      const iteration = {
        cycle,
        startedAt,
        status: 'running',
        checks: {}
      };
      const created = await client.createTask({
        requestId: `req_bridge_soak_${cycle}_${Date.now()}`,
        command: { rawText: `bridge soak cycle ${cycle}` }
      });
      iteration.checks.taskCreated = created.status === 'WAITING_APPROVAL';
      const events = await client.getEvents();
      const cursor = events.cursor?.eventId ?? events.items.at(-1)?.eventId ?? null;
      const ack = cursor ? await client.acknowledgeEvent(cursor, { streamId: `bridge-soak-${cycle}` }) : { success: false };
      iteration.checks.httpEventAck = ack.success === true;
      const sse = await readSseOpenFrame(client.eventStreamUrl({ sinceEventId: cursor }));
      iteration.sse = {
        status: sse.status,
        opened: sse.opened
      };
      iteration.checks.sseOpened = sse.opened === true;
      const ws = await probeWebSocket(client.eventWebSocketUrl({ sinceEventId: cursor }));
      iteration.websocket = {
        available: ws.available,
        opened: ws.opened,
        streamId: ws.streamId ?? null
      };
      iteration.checks.websocketOpened = ws.available === true && ws.opened === true && ws.channel?.authRequired === true;
      const loopHealth = await client.heartbeat();
      iteration.checks.heartbeat = loopHealth.status === 'connected';
      if (cycle === cycles) {
        const compacted = await client.compactCache({ reason: `bridge_soak_cycle_${cycle}` });
        iteration.cacheCompaction = {
          success: compacted.success,
          archiveVersion: compacted.archive?.archiveVersion ?? null,
          archiveSha256: compacted.archive?.archiveSha256 ?? null
        };
        iteration.checks.cacheCompactionArchived = compacted.success === true
          && compacted.archive?.archiveVersion === 'd-state-cache-journal-rotation-archive-v1';
        if (iteration.checks.cacheCompactionArchived) report.metrics.cacheOperationalChecks += 1;
      }
      iteration.status = Object.values(iteration.checks).every(Boolean) ? 'passed' : 'failed';
      iteration.finishedAt = new Date().toISOString();
      report.iterations.push(iteration);
      if (iteration.checks.heartbeat && iteration.checks.httpEventAck) report.metrics.httpSuccesses += 1;
      if (iteration.checks.sseOpened) report.metrics.sseSuccesses += 1;
      if (iteration.checks.websocketOpened) report.metrics.webSocketSuccesses += 1;
      await delay(25);
    }

    addCheck(report, 'all-cycles-http-passed', report.metrics.httpSuccesses === cycles, report.metrics);
    addCheck(report, 'all-cycles-sse-passed', report.metrics.sseSuccesses === cycles, report.metrics);
    addCheck(report, 'all-cycles-websocket-passed', report.metrics.webSocketSuccesses === cycles, report.metrics);
    const eventReleaseDossier = await client.runEventStreamReleaseDossier({
      cycles: Math.max(1, Math.min(3, cycles)),
      reason: 'bridge_soak_event_release_dossier'
    });
    report.eventReleaseDossier = eventReleaseDossier;
    addCheck(report, 'event-release-dossier-passed', eventReleaseDossier.dossierVersion === 'd-event-stream-release-dossier-v1'
      && eventReleaseDossier.status === 'passed'
      && eventReleaseDossier.productGate?.status === 'passed'
      && eventReleaseDossier.releaseExercise?.status === 'passed'
      && eventReleaseDossier.releaseWorkflow?.releaseExerciseReady === true
      && eventReleaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
      && eventReleaseDossier.artifactManifest?.wormArchive?.archiveContractVersion === 'd-event-stream-worm-release-archive-v1'
      && /^[a-f0-9]{64}$/.test(eventReleaseDossier.releaseHash ?? ''), eventReleaseDossier);
    const cacheReleaseDossier = await client.runCacheReleaseDossier({
      baseline: cacheSchema.snapshot,
      reason: 'bridge_soak_cache_release_dossier'
    });
    report.cacheReleaseDossier = cacheReleaseDossier;
    addCheck(report, 'cache-release-dossier-passed', cacheReleaseDossier.dossierVersion === 'd-state-cache-release-dossier-v1'
      && cacheReleaseDossier.status === 'passed'
      && cacheReleaseDossier.archiveRestoreDrill?.status === 'passed', cacheReleaseDossier);
    if (cacheReleaseDossier.status === 'passed') report.metrics.cacheOperationalChecks += 1;
    const auditReleaseDossier = await client.runAuditReleaseDossier({
      reason: 'bridge_soak_audit_release_dossier'
    });
    report.auditReleaseDossier = auditReleaseDossier;
    addCheck(report, 'audit-release-dossier-passed', auditReleaseDossier.dossierVersion === 'd-bridge-audit-log-release-dossier-v1'
      && auditReleaseDossier.status === 'passed'
      && auditReleaseDossier.productGate?.status === 'passed', auditReleaseDossier);
    report.reverseProxyLab = createBridgeReverseProxyLabDossier({
      deploymentProfile,
      soakReport: {
        reportVersion: report.reportVersion,
        status: report.checks.every((check) => check.passed) ? 'passed' : 'failed'
      }
    });
    report.productGate = createBridgeServerProductGate({
      deploymentProfile,
      reverseProxyLab: report.reverseProxyLab,
      soakReport: {
        reportVersion: report.reportVersion,
        status: report.checks.every((check) => check.passed) ? 'passed' : 'failed'
      }
    });
    report.releaseDossier = createBridgeServerReleaseDossier({
      deploymentProfile,
      reverseProxyLab: report.reverseProxyLab,
      serverProductGate: report.productGate,
      cacheReleaseDossier: report.cacheReleaseDossier,
      soakReport: {
        reportVersion: report.reportVersion,
        status: report.checks.every((check) => check.passed) ? 'passed' : 'failed'
      }
    });
    addCheck(report, 'reverse-proxy-lab-dossier-passed', report.reverseProxyLab.status === 'passed', report.reverseProxyLab);
    addCheck(report, 'bridge-server-product-gate-required-passed', report.productGate.requiredStatus === 'passed', report.productGate);
    addCheck(report, 'bridge-server-release-dossier-required-passed', report.releaseDossier.requiredStatus === 'passed', report.releaseDossier);
    addCheck(report, 'bridge-server-worm-promotion-package-ready', report.releaseDossier.externalWormPromotionPackage?.status === 'ready', report.releaseDossier.externalWormPromotionPackage);
    report.status = report.checks.every((check) => check.passed) ? 'passed' : 'failed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error.code ?? error.message;
    return report;
  } finally {
    await close(server);
  }
}

export function renderBridgeServerSoakMarkdown(report) {
  const lines = [
    '# JARVIS D Bridge Server Soak',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Cycles: ${report.cycles}`,
    `Bridge: ${report.bridge?.baseUrl ?? 'not-started'}`,
    '',
    '## Checks',
    ...report.checks.map((check) => `- ${check.passed ? 'passed' : 'failed'}: ${check.id}`),
    '',
    '## Metrics',
    `- HTTP successes: ${report.metrics.httpSuccesses}/${report.cycles}`,
    `- SSE successes: ${report.metrics.sseSuccesses}/${report.cycles}`,
    `- WebSocket successes: ${report.metrics.webSocketSuccesses}/${report.cycles}`,
    `- Cache operational checks: ${report.metrics.cacheOperationalChecks}`,
    '',
    '## Release Dossier',
    `- Bridge release: ${report.releaseDossier?.dossierVersion ?? 'missing'} / ${report.releaseDossier?.status ?? 'missing'}`,
    `- Cache release: ${report.cacheReleaseDossier?.dossierVersion ?? 'missing'} / ${report.cacheReleaseDossier?.status ?? 'missing'}`,
    `- Event release: ${report.eventReleaseDossier?.dossierVersion ?? 'missing'} / ${report.eventReleaseDossier?.status ?? 'missing'}`,
    `- Audit release: ${report.auditReleaseDossier?.dossierVersion ?? 'missing'} / ${report.auditReleaseDossier?.status ?? 'missing'}`,
    '',
    '## Iterations',
    ...report.iterations.map((item) => `- cycle ${item.cycle}: ${item.status}`)
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeBridgeServerSoakArtifacts(report, {
  jsonPath = 'dist/bridge-server-soak-report.json',
  markdownPath = 'dist/bridge-server-soak-report.md'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderBridgeServerSoakMarkdown(report), 'utf8');
  return { jsonPath, markdownPath };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cycles') args.cycles = Number(argv[++index]);
    else if (arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--artifact-dir') args.artifactDir = argv[++index];
  }
  return {
    cycles: Number.isFinite(args.cycles) ? args.cycles : defaultCycles,
    artifactDir: args.artifactDir ?? defaultArtifactDir,
    jsonPath: args.jsonPath ?? 'dist/bridge-server-soak-report.json',
    markdownPath: args.markdownPath ?? 'dist/bridge-server-soak-report.md'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBridgeServerSoak({
    cycles: args.cycles,
    artifactDir: args.artifactDir
  });
  const artifacts = await writeBridgeServerSoakArtifacts(report, {
    jsonPath: args.jsonPath,
    markdownPath: args.markdownPath
  });
  console.log('# JARVIS D Bridge Server Soak');
  console.log(`Status: ${report.status}`);
  console.log(`Cycles: ${report.cycles}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
