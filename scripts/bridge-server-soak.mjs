import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const defaultArtifactDir = 'dist';
const defaultCycles = 4;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server, { host = '127.0.0.1', port = 0 } = {}) {
  return await listenOnFetchSafePort(server, { host, port });
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

async function readSseOpenFrame(connection, { timeoutMs = 2500 } = {}) {
  const { url, headers = {} } = typeof connection === 'string'
    ? { url: connection, headers: {} }
    : connection;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
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

async function probeWebSocket(connection) {
  const socket = await openBridgeWebSocketConnection(connection);
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

export async function openBridgeWebSocketConnection(connection, {
  protocol = 'jarvis-events.v1',
  timeoutMs = 2500
} = {}) {
  const target = new URL(connection?.url ?? '');
  if (!['ws:', 'wss:'].includes(target.protocol)) {
    throw bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_URL_INVALID', 'WebSocket URL must use ws: or wss:.');
  }
  if (target.searchParams.has('token') || connection?.credentialsInUrl === true) {
    throw bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_URL_CREDENTIAL_REJECTED', 'WebSocket credentials must be sent in headers.');
  }
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const requestImpl = target.protocol === 'wss:' ? httpsRequest : httpRequest;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const request = requestImpl({
      protocol: target.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        ...(connection?.headers ?? {}),
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        'sec-websocket-protocol': protocol
      }
    });
    const timeout = setTimeout(() => {
      request.destroy(bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_OPEN_TIMEOUT', 'WebSocket upgrade timed out.'));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    request.once('error', fail);
    request.once('response', (response) => {
      response.resume();
      fail(bridgeWebSocketClientError(
        'D_WEBSOCKET_CLIENT_UPGRADE_REJECTED',
        `WebSocket upgrade was rejected with HTTP ${response.statusCode}.`
      ));
    });
    request.once('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy();
        fail(bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_HANDSHAKE_INVALID', 'WebSocket upgrade response was invalid.'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const client = new HeaderAuthenticatedWebSocketClient(socket);
      resolve(client);
      queueMicrotask(() => client.start(head));
    });
    request.end();
  });
}

class HeaderAuthenticatedWebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this.buffer = Buffer.alloc(0);
    this.listeners = new Map();
    this.pendingMessages = [];
    this.lastError = null;
    this.started = false;
  }

  start(head = Buffer.alloc(0)) {
    if (this.started) return;
    this.started = true;
    this.socket.on('data', (chunk) => this.consume(chunk));
    this.socket.once('error', (error) => {
      this.lastError = error;
      this.dispatch('error', { message: error.message, error });
    });
    this.socket.once('close', () => {
      this.readyState = 3;
      this.dispatch('close', {});
    });
    if (head.length > 0) this.consume(head);
    this.socket.resume();
    this.dispatch('open', {});
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    if (type === 'message' && this.pendingMessages.length > 0) {
      queueMicrotask(() => this.flushPendingMessages());
    }
    if (type === 'error' && this.lastError) {
      queueMicrotask(() => listener({ message: this.lastError.message, error: this.lastError }));
    }
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    if (type === 'message' && listeners.length === 0) {
      this.pendingMessages.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  }

  flushPendingMessages() {
    if ((this.listeners.get('message')?.size ?? 0) === 0) return;
    const pending = this.pendingMessages.splice(0);
    for (const event of pending) this.dispatch('message', event);
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.socket.destroy(bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_FRAME_INVALID', 'WebSocket frame is too large.'));
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      const masked = (second & 0x80) === 0x80;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payloadStart = offset + maskLength;
      const payload = Buffer.from(this.buffer.subarray(payloadStart, payloadStart + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(payloadStart + length);
      if (opcode === 0x1) this.dispatch('message', { data: payload.toString('utf8') });
      else if (opcode === 0x8) {
        this.readyState = 3;
        this.socket.end();
        this.dispatch('close', {});
        return;
      } else if (opcode === 0x9) {
        this.socket.write(encodeMaskedWebSocketFrame(payload, 0xA));
      }
    }
  }

  send(value) {
    if (this.readyState !== 1) throw bridgeWebSocketClientError('D_WEBSOCKET_CLIENT_NOT_OPEN', 'WebSocket is not open.');
    this.socket.write(encodeMaskedWebSocketFrame(Buffer.from(String(value)), 0x1));
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.socket.write(encodeMaskedWebSocketFrame(Buffer.alloc(0), 0x8));
    this.socket.end();
  }
}

function encodeMaskedWebSocketFrame(value, opcode) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) maskedPayload[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, maskedPayload]);
}

function bridgeWebSocketClientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
      const sse = await readSseOpenFrame(await client.eventStreamConnection({ sinceEventId: cursor }));
      iteration.sse = {
        status: sse.status,
        opened: sse.opened
      };
      iteration.checks.sseOpened = sse.opened === true;
      const ws = await probeWebSocket(await client.eventWebSocketConnection({ sinceEventId: cursor }));
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
