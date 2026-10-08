import http from 'node:http';
import { createCoreBridgeGateway } from './core-gateway.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgRuntime } from '../../runtime-compose/src/create-runtime.js';
import { createCoreGrowthReviewAuthorizer } from './core-growth-review-authorizer.js';
import { allBridgeRouteContracts, bridgeRouteContracts, BridgeRequestValidator, createBridgeOpenApiSpec } from './request-validator.js';
import { createBridgeReverseProxyDeploymentGuide, LocalNetworkGuard } from './network-guard.js';
import { bearerToken, readJsonBody, routeParams, routePath, safeHandle, sendJson } from '../../../packages/shared/src/http.js';
import { ModuleId } from '../../../packages/shared/src/types.js';

const jarvisWebSocketProtocol = 'jarvis-events.v1';
const webSocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const maximumBridgeWebSocketFrameBytes = 64 * 1024;
export const maximumBridgeWebSocketBufferBytes = 128 * 1024;

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isAllowedBridgeCorsOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return isLocalOrPrivateCorsHost(url.hostname);
  } catch {
    return false;
  }
}

function createBridgeCorsHeaders(request) {
  const origin = request.headers.origin;
  if (!isAllowedBridgeCorsOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

function applyBridgeCorsHeaders(response, request) {
  const headers = createBridgeCorsHeaders(request);
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  return headers;
}

function isLocalOrPrivateCorsHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const matchCgnat = /^100\.(\d{1,3})\./.exec(host);
  if (matchCgnat && Number(matchCgnat[1]) >= 64 && Number(matchCgnat[1]) <= 127
    && (process.env.JARVIS_BRIDGE_ALLOW_TAILSCALE === '1' || process.env.JARVIS_BRIDGE_ALLOW_TAILSCALE === 'true')) {
    return true;
  }
  const match172 = /^172\.(\d{1,2})\./.exec(host);
  return Boolean(match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31);
}

export function createBridgeServer(bridgeRuntime, {
  networkGuard = new LocalNetworkGuard({
    allowedHostnames: parseEnvList(process.env.JARVIS_BRIDGE_ALLOWED_HOSTS),
    trustedProxyHosts: parseEnvList(process.env.JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS),
    allowForwardedHeaders: process.env.JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS !== 'false',
    allowCgnat: process.env.JARVIS_BRIDGE_ALLOW_TAILSCALE === '1' || process.env.JARVIS_BRIDGE_ALLOW_TAILSCALE === 'true'
  })
} = {}) {
  const requestValidator = new BridgeRequestValidator({ auditLog: bridgeRuntime.auditLog });
  const serverProfile = createBridgeServerProfile();
  const deploymentProfile = createBridgeDeploymentProfile({ serverProfile });
  const server = http.createServer((request, response) => {
    safeHandle(response, async () => {
      applyBridgeCorsHeaders(response, request);
      const network = networkGuard.evaluate({
        hostHeader: request.headers.host,
        remoteAddress: request.socket.remoteAddress,
        headers: request.headers
      });
      if (!network.allowed) {
        const networkRateLimit = bridgeRuntime.checkHttpRateLimit({
          action: 'network.public_request',
          ip: request.socket.remoteAddress
        });
        setRateLimitHeaders(response, networkRateLimit.rateLimit);
        bridgeRuntime.auditLog.write('network.public_request.blocked', {
          host: network.host,
          remoteAddress: network.remoteAddress,
          blockedBy: network.blockedBy,
          dnsRebindingSuspected: network.dnsRebindingSuspected,
          proxyPolicy: network.proxyPolicy,
          rateLimit: networkRateLimit.rateLimit,
          method: request.method,
          url: request.url
        });
        return sendJson(response, 403, {
          success: false,
          error: { code: 'D_PUBLIC_NETWORK_BLOCKED', message: 'Bridge accepts only localhost or private LAN requests in MVP.' },
          network,
          rateLimit: networkRateLimit.rateLimit
        }, rateLimitHeaders(networkRateLimit.rateLimit));
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return undefined;
      }
      const path = routePath(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      const token = bearerToken(request) ?? url.searchParams.get('token');
      const routeContract = matchBridgeRouteContract(request.method, path);
      if (routeContract) {
        const headerValidation = requestValidator.validateHeaders(routeContract.routeName, request.headers);
        if (!headerValidation.success) return sendJson(response, headerValidation.statusCode ?? 400, headerValidation);
        if (routeContract.params && Object.keys(routeContract.params).length > 0) {
          const pathValidation = requestValidator.validatePath(routeContract.routeName, routeContract.params);
          if (!pathValidation.success) return sendJson(response, pathValidation.statusCode ?? 400, pathValidation);
        }
      }
      const action = rateLimitActionFor(request.method, path);
      if (action) {
        const limited = bridgeRuntime.checkHttpRateLimit({
          action,
          ip: request.socket.remoteAddress,
          token
        });
        setRateLimitHeaders(response, limited.rateLimit);
        if (!limited.success) return sendJson(response, 429, limited, rateLimitHeaders(limited.rateLimit));
      }

      if (request.method === 'GET' && path === '/health') return sendJson(response, 200, bridgeRuntime.health());
      if (request.method === 'GET' && path === '/openapi.json') return sendJson(response, 200, createBridgeOpenApiSpec());
      if (request.method === 'GET' && path === '/server/profile') return sendJson(response, 200, serverProfile);
      if (request.method === 'GET' && path === '/server/deployment-profile') return sendJson(response, 200, deploymentProfile);
      if (request.method === 'GET' && path === '/server/reverse-proxy-lab') {
        return sendJson(response, 200, createBridgeReverseProxyLabDossier({
          deploymentProfile
        }));
      }
      if (request.method === 'POST' && path === '/server/product-gate') {
        const bodyResult = await readValidatedBody(request, response, requestValidator, 'server.product_gate');
        if (!bodyResult.success) return undefined;
        const body = bodyResult.value;
        const reverseProxyLab = createBridgeReverseProxyLabDossier({
          deploymentProfile,
          soakReport: body.soakReport,
          mobileLiveBridgeReport: body.mobileLiveBridgeReport
        });
        return sendJson(response, 200, createBridgeServerProductGate({
          deploymentProfile,
          reverseProxyLab,
          soakReport: body.soakReport,
          mobileLiveBridgeReport: body.mobileLiveBridgeReport
        }));
      }
      if (request.method === 'GET' && path === '/events') {
        const query = readValidatedQuery(response, requestValidator, 'events.feed', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventFeed({
          token,
          sinceEventId: query.value.sinceEventId,
          eventType: query.value.eventType
        }));
      }
      if (request.method === 'GET' && path === '/events/stream') {
        const query = readValidatedQuery(response, requestValidator, 'events.stream', url.searchParams);
        if (!query.success) return undefined;
        const session = bridgeRuntime.openEventStream({
          token,
          sinceEventId: query.value.sinceEventId,
          eventType: query.value.eventType
        });
        if (!session.authenticated) return sendJson(response, 401, session);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        response.write(`event: stream.opened\n`);
        response.write(`data: ${JSON.stringify({
          streamId: session.streamId,
          heartbeatIntervalMs: session.heartbeatIntervalMs,
          reconnect: session.reconnect,
          replay: {
            sinceEventId: session.replay.sinceEventId,
            sinceFound: session.replay.sinceFound,
            replayedCount: session.replay.replayedCount,
            lastEventId: session.replay.lastEventId
          }
        })}\n\n`);
        const writeEvent = (event) => {
          response.write(`id: ${event.eventId}\n`);
          response.write(`event: ${event.eventType}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        for (const event of session.replay.items) {
          writeEvent(event);
        }
        const unsubscribe = bridgeRuntime.eventRelay.subscribe(writeEvent, {
          streamId: session.streamId,
          eventType: query.value.eventType
        });
        const heartbeat = setInterval(() => {
          const payload = bridgeRuntime.eventRelay.heartbeat(session.streamId);
          response.write(`event: heartbeat\n`);
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
        }, session.heartbeatIntervalMs);
        request.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
          bridgeRuntime.eventRelay.closeStream(session.streamId);
        });
        return undefined;
      }
      if (request.method === 'GET' && path === '/events/stream/status') {
        return sendJson(response, 200, bridgeRuntime.eventStreamStatus({ token }));
      }
      if (request.method === 'GET' && path === '/events/ws') {
        const query = readValidatedQuery(response, requestValidator, 'events.websocket', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 426, {
          success: false,
          error: {
            code: 'D_WEBSOCKET_UPGRADE_REQUIRED',
            message: 'Use an authenticated WebSocket upgrade for /events/ws.'
          },
          channel: serverProfile.webSocketChannel,
          query: {
            sinceEventId: query.value.sinceEventId ?? null,
            eventType: query.value.eventType ?? null
          }
        }, {
          upgrade: 'websocket',
          connection: 'Upgrade'
        });
      }
      if (request.method === 'GET' && path === '/events/reconnect-plan') {
        const query = readValidatedQuery(response, requestValidator, 'events.reconnect_plan', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventReconnectPlan({
          token,
          sinceEventId: query.value.sinceEventId,
          eventType: query.value.eventType,
          attempt: query.value.attempt ?? 0,
          lastError: query.value.lastError
        }));
      }
      if (request.method === 'GET' && path === '/events/fallback-ux') {
        return sendJson(response, 200, bridgeRuntime.eventFallbackUxContract({ token }));
      }
      if (request.method === 'POST' && path === '/events/ack') {
        const body = await readValidatedBody(request, response, requestValidator, 'events.ack');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.acknowledgeEvent({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/events/cursors/compact') {
        const body = await readValidatedBody(request, response, requestValidator, 'events.cursor_compact');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventCursorCompaction({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/events/chaos-drill') {
        const body = await readValidatedBody(request, response, requestValidator, 'events.chaos_drill');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventNetworkChaosDrill({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/events/product-gate') {
        const body = await readValidatedBody(request, response, requestValidator, 'events.product_gate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventStreamProductGate({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/events/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'events.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.eventStreamReleaseDossier({ token, ...body.value }));
      }
      if (request.method === 'GET' && path === '/rate-limit/status') {
        return sendJson(response, 200, bridgeRuntime.rateLimitStatus({ token }));
      }
      if (request.method === 'GET' && path === '/rate-limit/abuse-corpus') {
        return sendJson(response, 200, bridgeRuntime.rateLimitAbuseCorpus({ token }));
      }
      if (request.method === 'POST' && path === '/rate-limit/product-gate') {
        const body = await readValidatedBody(request, response, requestValidator, 'rate_limit.product_gate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.rateLimitProductGate({ token }));
      }
      if (request.method === 'POST' && path === '/rate-limit/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'rate_limit.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.rateLimitReleaseDossier({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/pairing/start') return sendJson(response, 200, bridgeRuntime.pairing.start());
      if (request.method === 'POST' && path === '/pairing/confirm') {
        const body = await readValidatedBody(request, response, requestValidator, 'pairing.confirm');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.pairing.confirm(body.value));
      }
      if (request.method === 'POST' && path === '/pairing/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'pairing.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.pairingReleaseDossier({
          token,
          ...body.value
        }));
      }
      if (request.method === 'GET' && path === '/devices') {
        return sendJson(response, 200, bridgeRuntime.listDevices({ token }));
      }
      if (request.method === 'GET' && path === '/devices/inventory') {
        return sendJson(response, 200, bridgeRuntime.deviceInventory({ token }));
      }
      if (request.method === 'GET' && path === '/devices/token/policy') {
        return sendJson(response, 200, bridgeRuntime.deviceTokenDeploymentPolicy({ token }));
      }
      if (request.method === 'POST' && path === '/devices/token/rotate') {
        const body = await readValidatedBody(request, response, requestValidator, 'device.token.rotate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.rotateDeviceToken({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/devices/token/rotation-drill') {
        const body = await readValidatedBody(request, response, requestValidator, 'device.token.rotation_drill');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.deviceTokenKeyRotationDrill({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/devices/token/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'device.token.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.deviceTokenReleaseDossier({
          token,
          ...body.value
        }));
      }
      if (request.method === 'GET' && path === '/request-nonces/policy') {
        return sendJson(response, 200, bridgeRuntime.requestNoncePolicy({ token }));
      }
      if (request.method === 'POST' && path === '/request-nonces/compact') {
        const body = await readValidatedBody(request, response, requestValidator, 'request_nonce.compact');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.compactRequestNonces({
          token,
          ...body.value
        }));
      }
      if (request.method === 'GET' && path === '/request-nonces/clock-skew-fixtures') {
        return sendJson(response, 200, bridgeRuntime.requestNonceClockSkewFixtures({ token }));
      }
      if (request.method === 'POST' && path === '/request-nonces/product-gate') {
        const body = await readValidatedBody(request, response, requestValidator, 'request_nonce.product_gate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.requestNonceProductGate({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/request-nonces/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'request_nonce.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.requestNonceReleaseDossier({
          token,
          ...body.value
        }));
      }
      const deviceParams = routeParams('/devices/:deviceId', path);
      if (request.method === 'DELETE' && deviceParams) {
        return sendJson(response, 200, bridgeRuntime.revokeDevice({ deviceId: deviceParams.deviceId, token }));
      }
      if (request.method === 'POST' && path === '/connection/heartbeat') {
        return sendJson(response, 200, bridgeRuntime.heartbeat({ token }));
      }
      if (request.method === 'POST' && path === '/task-approval-result/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'task_approval_result.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, await bridgeRuntime.taskApprovalResultReleaseDossier({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/tasks') {
        const bodyResult = await readValidatedBody(request, response, requestValidator, 'task.create');
        if (!bodyResult.success) return undefined;
        const body = bodyResult.value;
        return sendJson(response, 200, bridgeRuntime.createTask({ rawText: body.rawText, taskRequest: body.requestId ? body : null, token }));
      }
      if (request.method === 'GET' && path === '/tasks') {
        const query = readValidatedQuery(response, requestValidator, 'tasks.list', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.listTasks({ token, status: query.value.status }));
      }
      const taskParams = routeParams('/tasks/:taskId', path);
      if (request.method === 'GET' && taskParams) {
        return sendJson(response, 200, bridgeRuntime.getTaskStatus({ taskId: taskParams.taskId, token }));
      }
      if (request.method === 'GET' && path === '/approvals') return sendJson(response, 200, bridgeRuntime.listApprovals({ token }));
      const approvalHistoryParams = routeParams('/approvals/:approvalId/history', path);
      if (request.method === 'GET' && approvalHistoryParams) {
        return sendJson(response, 200, bridgeRuntime.getApprovalHistory({ approvalId: approvalHistoryParams.approvalId, token }));
      }
      const approvalParams = routeParams('/approvals/:approvalId', path);
      if (request.method === 'GET' && approvalParams) {
        return sendJson(response, 200, bridgeRuntime.getApproval({ approvalId: approvalParams.approvalId, token }));
      }
      const decisionParams = routeParams('/approvals/:approvalId/decision', path);
      if (request.method === 'POST' && decisionParams) {
        const bodyResult = await readValidatedBody(request, response, requestValidator, 'approval.decision');
        if (!bodyResult.success) return undefined;
        const body = bodyResult.value;
        return sendJson(
          response,
          200,
          await bridgeRuntime.decideApproval({
            approvalId: decisionParams.approvalId,
            decision: body.decision,
            editRequest: body.editRequest,
            responseText: body.responseText,
            token
          })
        );
      }
      const renewParams = routeParams('/approvals/:approvalId/renew', path);
      if (request.method === 'POST' && renewParams) {
        return sendJson(response, 200, bridgeRuntime.renewApproval({ approvalId: renewParams.approvalId, token }));
      }
      const pcHandoffParams = routeParams('/approvals/:approvalId/pc-handoff', path);
      if (request.method === 'POST' && pcHandoffParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'approval.pc_handoff');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.requestPcConfirmation({
          approvalId: pcHandoffParams.approvalId,
          token,
          ...body.value
        }));
      }
      const cancelParams = routeParams('/approvals/:approvalId/cancel', path);
      if (request.method === 'POST' && cancelParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'approval.cancel');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.cancelApproval({
          approvalId: cancelParams.approvalId,
          token,
          ...body.value
        }));
      }
      const reRequestParams = routeParams('/approvals/:approvalId/re-request', path);
      if (request.method === 'POST' && reRequestParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'approval.re_request');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.requestApprovalReplacement({
          approvalId: reRequestParams.approvalId,
          token,
          ...body.value
        }));
      }
      const handoffParams = routeParams('/execution-handoffs/:handoffId/confirm', path);
      if (request.method === 'POST' && handoffParams) {
        return sendJson(response, 200, await bridgeRuntime.confirmExecutionHandoff({ handoffId: handoffParams.handoffId, token }));
      }
      const resultParams = routeParams('/results/:taskId', path);
      if (request.method === 'GET' && resultParams) {
        return sendJson(response, 200, bridgeRuntime.getResult({ taskId: resultParams.taskId, token }));
      }
      const rollbackParams = routeParams('/results/:taskId/rollback', path);
      if (request.method === 'POST' && rollbackParams) {
        const body = await readJsonBody(request).catch(() => ({}));
        return sendJson(response, 200, await bridgeRuntime.rollbackResult({
          taskId: rollbackParams.taskId,
          token,
          reason: body.reason,
          confirmed: body.confirmed === true
        }));
      }
      if (request.method === 'GET' && path === '/pc-agent/poison-packets') {
        const query = readValidatedQuery(response, requestValidator, 'pc_agent.poison_queue.read', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.poisonQueue({
          token,
          includeIgnored: query.value.includeIgnored === true
        }));
      }
      if (request.method === 'GET' && path === '/pc-console/approval-handoffs') {
        const query = readValidatedQuery(response, requestValidator, 'pc_console.handoff.read', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.listPcConfirmationHandoffs({
          token,
          status: query.value.status,
          requestContext: { remoteAddress: request.socket.remoteAddress }
        }));
      }
      const pcConsoleDecisionParams = routeParams('/pc-console/approval-handoffs/:handoffId/decision', path);
      if (request.method === 'POST' && pcConsoleDecisionParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_console.handoff.decision');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.decidePcConfirmationHandoff({
          token,
          handoffId: pcConsoleDecisionParams.handoffId,
          requestContext: { remoteAddress: request.socket.remoteAddress },
          ...body.value
        }));
      }
      if (request.method === 'GET' && path === '/pc-agent/queue-policy') {
        return sendJson(response, 200, bridgeRuntime.queueRetryPolicy({ token }));
      }
      if (request.method === 'POST' && path === '/pc-agent/queue/drain') {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_agent.queue.drain');
        if (!body.success) return undefined;
        return sendJson(response, 200, await bridgeRuntime.drainPcAgentQueue({
          token,
          limit: body.value.limit
        }));
      }
      if (request.method === 'POST' && path === '/pc-agent/queue-policy') {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_agent.queue_policy.update');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.updateQueueRetryPolicy({
          token,
          ...body.value
        }));
      }
      const poisonReviewParams = routeParams('/pc-agent/poison-packets/:queueId/review', path);
      if (request.method === 'POST' && poisonReviewParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_agent.poison_packet.review');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.reviewPoisonPacket({
          token,
          queueId: poisonReviewParams.queueId,
          ...body.value
        }));
      }
      const poisonRequeueParams = routeParams('/pc-agent/poison-packets/:queueId/requeue', path);
      if (request.method === 'POST' && poisonRequeueParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_agent.poison_packet.requeue');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.requeuePoisonPacket({
          token,
          queueId: poisonRequeueParams.queueId,
          ...body.value
        }));
      }
      const poisonIgnoreParams = routeParams('/pc-agent/poison-packets/:queueId/ignore', path);
      if (request.method === 'POST' && poisonIgnoreParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'pc_agent.poison_packet.ignore');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.ignorePoisonPacket({
          token,
          queueId: poisonIgnoreParams.queueId,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/feedback') {
        const body = await readValidatedBody(request, response, requestValidator, 'feedback');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.recordFeedback({ feedback: body.value, token }));
      }
      if (request.method === 'GET' && path === '/growth/review/latest') {
        return sendJson(response, 200, bridgeRuntime.latestGrowthReview({ token }));
      }
      if (request.method === 'GET' && path === '/growth/decisions/history') {
        const query = readValidatedQuery(response, requestValidator, 'growth.routing.history', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.growthDecisionHistory({
          token,
          routeName: query.value.routeName,
          kind: query.value.kind,
          limit: query.value.limit
        }));
      }
      if (request.method === 'GET' && path === '/growth/decisions/trends') {
        const query = readValidatedQuery(response, requestValidator, 'growth.routing.trend', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.growthRoutingTrend({
          token,
          windowMinutes: query.value.windowMinutes
        }));
      }
      if (request.method === 'POST' && path === '/growth/routing/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'growth.routing.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.growthRoutingReleaseDossier({
          token,
          ...body.value
        }));
      }
      const growthPreferenceParams = routeParams('/growth/preferences/:hypothesisId/decision', path);
      if (request.method === 'POST' && growthPreferenceParams) {
        const body = await readValidatedBody(request, response, requestValidator, 'growth.preference.decision');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.decideGrowthPreference({
          token,
          hypothesisId: growthPreferenceParams.hypothesisId,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/growth/hygiene/decisions') {
        const body = await readValidatedBody(request, response, requestValidator, 'growth.hygiene.decision');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.decideGrowthHygiene({
          token,
          ...body.value
        }));
      }
      if (request.method === 'POST' && path === '/growth/hygiene/decisions/batch') {
        const body = await readValidatedBody(request, response, requestValidator, 'growth.hygiene.batch_decision');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.decideGrowthHygieneBatch({
          token,
          ...body.value
        }));
      }
      const growthSkillRevisionRoutes = [
        { action: 'create', pattern: '/growth/skills/:skillId/revisions' },
        { action: 'evaluate', pattern: '/growth/skills/:skillId/revisions/:revisionId/evaluate' },
        { action: 'review', pattern: '/growth/skills/:skillId/revisions/:revisionId/review' },
        { action: 'promote', pattern: '/growth/skills/:skillId/revisions/:revisionId/promote' },
        { action: 'rollback', pattern: '/growth/skills/:skillId/revisions/:revisionId/rollback' }
      ];
      for (const route of growthSkillRevisionRoutes) {
        const params = routeParams(route.pattern, path);
        if (request.method !== 'POST' || !params) continue;
        const body = await readValidatedBody(request, response, requestValidator, `growth.skill_revision.${route.action}`);
        if (!body.success) return undefined;
        return sendJson(response, 200, await bridgeRuntime.mutateGrowthSkillRevision({
          token,
          action: route.action,
          skillId: params.skillId,
          revisionId: params.revisionId ?? null,
          payload: body.value
        }));
      }
      if (request.method === 'GET' && path === '/cache/snapshot') {
        return sendJson(response, 200, bridgeRuntime.cacheSnapshot({ token }));
      }
      if (request.method === 'GET' && path === '/cache/schema-snapshot') {
        return sendJson(response, 200, bridgeRuntime.cacheSchemaSnapshot({ token }));
      }
      if (request.method === 'POST' && path === '/cache/schema-diff') {
        const body = await readValidatedBody(request, response, requestValidator, 'cache.schema_diff');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.cacheSchemaDiff({ token, baseline: body.value.baseline }));
      }
      if (request.method === 'POST' && path === '/cache/compact') {
        const body = await readValidatedBody(request, response, requestValidator, 'cache.compact');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.compactCache({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/cache/product-gate') {
        const body = await readValidatedBody(request, response, requestValidator, 'cache.product_gate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.cacheProductGate({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/cache/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'cache.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.cacheReleaseDossier({ token, ...body.value }));
      }
      if (request.method === 'GET' && path === '/audit/summary') {
        const query = readValidatedQuery(response, requestValidator, 'audit.summary', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditSummary({
          token,
          category: query.value.category,
          severity: query.value.severity,
          cursor: query.value.cursor,
          limit: query.value.limit
        }));
      }
      if (request.method === 'GET' && path === '/audit/export') {
        const query = readValidatedQuery(response, requestValidator, 'audit.export', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditExport({
          token,
          category: query.value.category,
          severity: query.value.severity,
          cursor: query.value.cursor,
          limit: query.value.limit,
          reason: query.value.reason
        }));
      }
      if (request.method === 'GET' && path === '/audit/siem-export') {
        const query = readValidatedQuery(response, requestValidator, 'audit.siem_export', url.searchParams);
        if (!query.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditSiemExport({
          token,
          category: query.value.category,
          severity: query.value.severity,
          cursor: query.value.cursor,
          limit: query.value.limit,
          reason: query.value.reason,
          format: query.value.format
        }));
      }
      if (request.method === 'POST' && path === '/audit/rotate') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.rotate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditRotate({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/audit/retention/run') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.retention_run');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditRetentionRun({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/audit/archive/sync') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.archive_sync');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditArchiveSync({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/audit/archive/restore-drill') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.archive_restore_drill');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditArchiveRestoreDrill({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/audit/product-gate') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.product_gate');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditProductGate({ token, ...body.value }));
      }
      if (request.method === 'POST' && path === '/audit/release-dossier') {
        const body = await readValidatedBody(request, response, requestValidator, 'audit.release_dossier');
        if (!body.success) return undefined;
        return sendJson(response, 200, bridgeRuntime.auditReleaseDossier({ token, ...body.value }));
      }
      sendJson(response, 404, { success: false, error: { code: 'D_ROUTE_NOT_FOUND' } });
    });
  });
  server.on('upgrade', (request, socket) => {
    handleEventWebSocketUpgrade({
      request,
      socket,
      bridgeRuntime,
      networkGuard,
      requestValidator,
      serverProfile
    });
  });
  return server;
}

export function createBridgeServerProfile() {
  const contracts = allBridgeRouteContracts();
  const routes = Object.entries(contracts)
    .map(([routeName, contract]) => ({
      routeName,
      method: contract.method,
      path: contract.path,
      public: Boolean(contract.public),
      params: contract.params ?? [],
      required: contract.required ?? [],
      optional: contract.optional ?? [],
      response: contract.response ?? 'SuccessEnvelope'
    }))
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  return {
    module: ModuleId.BRIDGE,
    serverStack: 'node:http contract-first middleware pipeline',
    frameworkCompatibility: {
      fastifyCompatible: true,
      openApi: '3.1.0',
      typedErrorEnvelope: true,
      routeContracts: true,
      sse: true,
      websocket: true,
      websocketPlanned: true,
      websocketProtocol: jarvisWebSocketProtocol
    },
    localOnly: true,
    webSocketChannel: createBridgeWebSocketChannelProfile(),
    rateLimitPolicy: createBridgeRateLimitProfile(),
    middleware: [
      'localNetworkGuard',
      'routeContractMatcher',
      'headerValidator',
      'pathParameterValidator',
      'actionRateLimiter',
      'bodyQueryValidator',
      'runtimeRouter',
      'typedJsonResponder',
      'auditWriter'
    ],
    routes,
    routeCount: routes.length,
    validationCoverage: {
      bodyRoutes: Object.keys(bridgeRouteContracts.body).length,
      queryRoutes: Object.keys(bridgeRouteContracts.query).length,
      pathRoutes: Object.keys(bridgeRouteContracts.path).length
    }
  };
}

function createBridgeRateLimitProfile() {
  return {
    profileVersion: 'd-rate-limit-product-profile-v1',
    policyFile: {
      supported: true,
      hotReload: true,
      env: 'JARVIS_BRIDGE_RATE_LIMIT_POLICY'
    },
    sharedBackend: {
      supported: true,
      defaultType: 'jsonl-shared-file',
      multiProcessSafe: true,
      journal: 'bridge-rate-limits.jsonl'
    },
    reputation: {
      supported: true,
      identities: ['device', 'token', 'ip'],
      tiers: ['trusted', 'normal', 'watch', 'restricted']
    },
    abuseCorpus: {
      supported: true,
      reportVersion: 'd-rate-limit-abuse-corpus-report-v1',
      endpoint: '/rate-limit/abuse-corpus'
    },
    productGate: {
      supported: true,
      productGateVersion: 'd-rate-limit-product-gate-v1',
      endpoint: '/rate-limit/product-gate'
    },
    releaseDossier: {
      supported: true,
      dossierVersion: 'd-rate-limit-release-dossier-v1',
      endpoint: '/rate-limit/release-dossier'
    }
  };
}

export function createBridgeDeploymentProfile({
  env = process.env,
  serverProfile = createBridgeServerProfile()
} = {}) {
  const { host, port } = resolveBridgeListenOptions(env);
  const allowedHostnames = parseEnvList(env.JARVIS_BRIDGE_ALLOWED_HOSTS);
  const trustedProxyHosts = parseEnvList(env.JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS);
  const publicUrl = String(env.JARVIS_BRIDGE_PUBLIC_URL ?? '').trim() || null;
  const reverseProxyEnabled = trustedProxyHosts.length > 0 || Boolean(publicUrl);
  const upstreamUrl = `http://${host}:${port}`;
  return {
    profileVersion: 'd-bridge-deployment-profile-v1',
    module: ModuleId.BRIDGE,
    generatedAt: new Date().toISOString(),
    topology: {
      mode: reverseProxyEnabled ? 'tls-terminated-reverse-proxy' : 'local-loopback-or-private-lan',
      upstreamUrl,
      publicUrl,
      localOnly: serverProfile.localOnly === true,
      allowedHostnames,
      trustedProxyHosts
    },
    tls: {
      strategy: 'reverse-proxy-termination',
      directNodeTls: false,
      requiredForLanPairing: true,
      certificateOwner: 'operator-managed-local-proxy',
      publicUrlHttpsReady: publicUrl ? publicUrl.startsWith('https://') : false,
      requiredHeaders: ['Host', 'X-Forwarded-For', 'X-Forwarded-Proto']
    },
    reverseProxy: {
      enabled: reverseProxyEnabled,
      trustedProxyHosts,
      forwardedHeadersAllowed: env.JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS !== 'false',
      websocketUpgrade: true,
      sseBufferingDisabled: true,
      upstream: upstreamUrl,
      healthProbePath: '/health',
      readinessProbePaths: ['/server/profile', '/server/deployment-profile', '/openapi.json'],
      caddyfile: [
        'jarvis.local {',
        '  tls internal',
        `  reverse_proxy ${host}:${port} {`,
        '    header_up X-Forwarded-Proto {scheme}',
        '    header_up X-Forwarded-For {remote_host}',
        '  }',
        '}'
      ],
      deploymentGuide: createBridgeReverseProxyDeploymentGuide({
        publicHostname: publicHostnameFromUrl(publicUrl) ?? 'jarvis.local',
        upstreamHost: host,
        upstreamPort: port,
        allowedHostnames,
        trustedProxyHosts,
        allowForwardedHeaders: env.JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS !== 'false'
      })
    },
    processManager: {
      mode: 'windows-service-or-user-process-supervisor',
      entrypoint: 'apps/bridge/src/main.mjs',
      command: 'npm run bridge:dev',
      soakCommand: 'npm run bridge:server-soak',
      restartPolicy: {
        onFailure: 'restart',
        maxRestartsPerHour: 6,
        healthCheck: '/health'
      },
      environment: [
        'JARVIS_BRIDGE_HOST',
        'JARVIS_BRIDGE_PORT',
        'JARVIS_BRIDGE_ALLOWED_HOSTS',
        'JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS',
        'JARVIS_BRIDGE_PUBLIC_URL',
        'JARVIS_DEVICE_TOKEN_SECRET'
      ]
    },
    channels: {
      http: { enabled: true, contract: '/openapi.json' },
      sse: { enabled: true, path: '/events/stream', authenticated: true, replay: true, heartbeat: true },
      websocket: serverProfile.webSocketChannel
    },
    readinessChecklist: [
      { id: 'health-probe', path: '/health', required: true },
      { id: 'route-contracts', path: '/openapi.json', required: true },
      { id: 'server-profile', path: '/server/profile', required: true },
      { id: 'deployment-profile', path: '/server/deployment-profile', required: true },
      { id: 'sse-stream', path: '/events/stream', required: true },
      { id: 'websocket-auxiliary-channel', path: '/events/ws', required: true },
      { id: 'soak-report', artifact: 'dist/bridge-server-soak-report.json', required: true }
    ],
    runbook: [
      'Set JARVIS_DEVICE_TOKEN_SECRET to a long random value before pairing real devices.',
      'Bind the Node process to 127.0.0.1 behind a TLS reverse proxy, or to a private LAN interface for lab device pairing.',
      'Configure JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS when forwarded headers are accepted.',
      'Run npm run bridge:server-soak after changing network, proxy, or process-manager settings.'
    ]
  };
}

export function createBridgeReverseProxyLabDossier({
  deploymentProfile = createBridgeDeploymentProfile(),
  networkGuard = null,
  soakReport = null,
  mobileLiveBridgeReport = null,
  clock = () => new Date()
} = {}) {
  const publicHostname = publicHostnameFromUrl(deploymentProfile.topology?.publicUrl)
    ?? deploymentProfile.reverseProxy?.deploymentGuide?.publicHostname
    ?? 'jarvis.local';
  const trustedProxyHosts = deploymentProfile.reverseProxy?.trustedProxyHosts?.length
    ? deploymentProfile.reverseProxy.trustedProxyHosts
    : ['127.0.0.1'];
  const guard = networkGuard ?? new LocalNetworkGuard({
    allowedHostnames: [
      publicHostname,
      ...(deploymentProfile.topology?.allowedHostnames ?? [])
    ],
    trustedProxyHosts,
    allowForwardedHeaders: deploymentProfile.reverseProxy?.forwardedHeadersAllowed !== false
  });
  const trustedProxy = trustedProxyHosts[0] ?? '127.0.0.1';
  const trustedHttps = guard.evaluate({
    hostHeader: publicHostname,
    remoteAddress: trustedProxy,
    headers: {
      'x-forwarded-host': publicHostname,
      'x-forwarded-for': '192.168.0.42',
      'x-forwarded-proto': 'https'
    }
  });
  const untrustedProxy = guard.evaluate({
    hostHeader: publicHostname,
    remoteAddress: '8.8.8.8',
    headers: {
      'x-forwarded-host': publicHostname,
      'x-forwarded-for': '192.168.0.42',
      'x-forwarded-proto': 'https'
    }
  });
  const invalidProto = guard.evaluate({
    hostHeader: publicHostname,
    remoteAddress: trustedProxy,
    headers: {
      'x-forwarded-host': publicHostname,
      'x-forwarded-for': '192.168.0.42',
      'x-forwarded-proto': 'gopher'
    }
  });
  const checks = [
    {
      checkId: 'deployment_profile_reverse_proxy_enabled',
      status: deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1'
        && deploymentProfile.tls?.strategy === 'reverse-proxy-termination'
        && deploymentProfile.reverseProxy?.deploymentGuide?.guideVersion === 'd-bridge-reverse-proxy-deployment-guide-v1' ? 'passed' : 'blocked'
    },
    {
      checkId: 'trusted_https_forwarded_headers_allowed',
      status: trustedHttps.allowed === true && trustedHttps.proxyPolicy?.allowed === true ? 'passed' : 'blocked',
      proxyPolicy: trustedHttps.proxyPolicy
    },
    {
      checkId: 'untrusted_forwarded_proxy_blocked',
      status: untrustedProxy.allowed === false ? 'passed' : 'blocked',
      blockedBy: untrustedProxy.blockedBy
    },
    {
      checkId: 'invalid_forwarded_proto_blocked',
      status: invalidProto.allowed === false && invalidProto.proxyPolicy?.reason === 'unsupported-forwarded-proto' ? 'passed' : 'blocked',
      proxyPolicy: invalidProto.proxyPolicy
    },
    {
      checkId: 'bridge_soak_artifact_linked',
      status: soakReport?.reportVersion === 'd-bridge-server-soak-report-v1' && soakReport.status === 'passed' ? 'passed' : 'evidence-pending',
      reportStatus: soakReport?.status ?? null
    },
    {
      checkId: 'mobile_live_bridge_e2e_artifact_linked',
      status: mobileLiveBridgeReport?.reportVersion === 'c-mobile-live-bridge-e2e-v1' || mobileLiveBridgeReport?.status ? 'passed' : 'evidence-pending',
      reportStatus: mobileLiveBridgeReport?.status ?? null,
      reason: mobileLiveBridgeReport?.reason ?? null
    }
  ];
  const labChecks = checks.filter((check) => !check.checkId.endsWith('_artifact_linked'));
  return {
    dossierVersion: 'd-bridge-reverse-proxy-lab-dossier-v1',
    generatedAt: clock().toISOString(),
    status: labChecks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    publicHostname,
    trustedProxyHosts,
    topology: deploymentProfile.topology?.mode ?? null,
    checks,
    networkSamples: {
      trustedHttps,
      untrustedProxy,
      invalidProto
    },
    releaseEvidence: {
      bridgeSoakStatus: soakReport?.status ?? 'missing',
      mobileLiveBridgeStatus: mobileLiveBridgeReport?.status ?? 'missing',
      physicalDeviceVerified: mobileLiveBridgeReport?.device?.ready === true || mobileLiveBridgeReport?.actualDeviceVerified === true
    }
  };
}

export function createBridgeServerProductGate({
  deploymentProfile = createBridgeDeploymentProfile(),
  reverseProxyLab = createBridgeReverseProxyLabDossier({ deploymentProfile }),
  soakReport = null,
  mobileLiveBridgeReport = null
} = {}) {
  const checks = [
    {
      checkId: 'deployment_profile_ready',
      status: deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1'
        && deploymentProfile.readinessChecklist?.some((item) => item.id === 'websocket-auxiliary-channel') ? 'passed' : 'blocked'
    },
    {
      checkId: 'reverse_proxy_lab_passed',
      status: reverseProxyLab.dossierVersion === 'd-bridge-reverse-proxy-lab-dossier-v1' && reverseProxyLab.status === 'passed' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_server_soak_passed',
      status: soakReport?.reportVersion === 'd-bridge-server-soak-report-v1' && soakReport.status === 'passed' ? 'passed' : 'external-blocked'
    },
    {
      checkId: 'mobile_live_bridge_e2e_recorded',
      status: mobileLiveBridgeReport?.status ? 'passed' : 'external-blocked',
      reportStatus: mobileLiveBridgeReport?.status ?? null,
      reason: mobileLiveBridgeReport?.reason ?? null
    },
    {
      checkId: 'physical_tls_proxy_evidence',
      status: mobileLiveBridgeReport?.status === 'passed' ? 'passed' : 'external-blocked',
      reason: mobileLiveBridgeReport?.reason ?? 'physical-device-or-tls-proxy-evidence-pending'
    }
  ];
  const blocked = checks.some((check) => check.status === 'blocked');
  const externalBlocked = checks.some((check) => check.status === 'external-blocked');
  return {
    productGateVersion: 'd-bridge-server-product-gate-v1',
    status: blocked ? 'blocked' : (externalBlocked ? 'external-blocked' : 'passed'),
    checks,
    requiredStatus: blocked ? 'blocked' : 'passed',
    externalEvidencePending: externalBlocked
  };
}

export function createBridgeServerReleaseDossier({
  deploymentProfile = createBridgeDeploymentProfile(),
  reverseProxyLab = createBridgeReverseProxyLabDossier({ deploymentProfile }),
  serverProductGate = createBridgeServerProductGate({ deploymentProfile, reverseProxyLab }),
  cacheReleaseDossier = null,
  soakReport = null,
  mobileLiveBridgeReport = null,
  openApi = createBridgeOpenApiSpec(),
  clock = () => new Date()
} = {}) {
  const routeCount = Object.values(openApi.paths ?? {})
    .reduce((sum, methods) => sum + Object.keys(methods).length, 0);
  const hashString = (value) => (typeof value === 'string' && value.length > 0 ? sha256Hex(value) : null);
  const deploymentProfileEvidence = {
    profileVersion: deploymentProfile.profileVersion,
    generatedAt: deploymentProfile.generatedAt,
    topology: {
      mode: deploymentProfile.topology?.mode ?? null,
      localOnly: deploymentProfile.topology?.localOnly === true,
      upstreamUrlHash: hashString(deploymentProfile.topology?.upstreamUrl),
      publicUrlHash: hashString(deploymentProfile.topology?.publicUrl),
      allowedHostnameHashes: (deploymentProfile.topology?.allowedHostnames ?? []).map((host) => hashString(host)),
      trustedProxyHostHashes: (deploymentProfile.topology?.trustedProxyHosts ?? []).map((host) => hashString(host)),
      rawUpstreamUrlStored: false,
      rawPublicUrlStored: false,
      rawHostnamesStored: false
    },
    tls: deploymentProfile.tls,
    reverseProxy: {
      enabled: deploymentProfile.reverseProxy?.enabled === true,
      trustedProxyHostHashes: (deploymentProfile.reverseProxy?.trustedProxyHosts ?? []).map((host) => hashString(host)),
      forwardedHeadersAllowed: deploymentProfile.reverseProxy?.forwardedHeadersAllowed === true,
      websocketUpgrade: deploymentProfile.reverseProxy?.websocketUpgrade === true,
      sseBufferingDisabled: deploymentProfile.reverseProxy?.sseBufferingDisabled === true,
      upstreamHash: hashString(deploymentProfile.reverseProxy?.upstream),
      healthProbePath: deploymentProfile.reverseProxy?.healthProbePath ?? null,
      readinessProbePaths: deploymentProfile.reverseProxy?.readinessProbePaths ?? [],
      caddyfileHash: sha256Hex(canonicalJson(deploymentProfile.reverseProxy?.caddyfile ?? [])),
      deploymentGuide: {
        guideVersion: deploymentProfile.reverseProxy?.deploymentGuide?.guideVersion ?? null,
        topology: deploymentProfile.reverseProxy?.deploymentGuide?.topology ?? null,
        publicHostnameHash: hashString(deploymentProfile.reverseProxy?.deploymentGuide?.publicHostname),
        upstreamHash: hashString(deploymentProfile.reverseProxy?.deploymentGuide?.upstream),
        requiredNetworkGuardEnvKeys: Object.keys(deploymentProfile.reverseProxy?.deploymentGuide?.requiredNetworkGuardEnv ?? {}).sort(),
        requiredNetworkGuardEnvHash: sha256Hex(canonicalJson(deploymentProfile.reverseProxy?.deploymentGuide?.requiredNetworkGuardEnv ?? {})),
        caddyHash: hashString(deploymentProfile.reverseProxy?.deploymentGuide?.caddy),
        nginxHash: hashString(deploymentProfile.reverseProxy?.deploymentGuide?.nginx),
        validation: (deploymentProfile.reverseProxy?.deploymentGuide?.validation ?? []).map((item) => ({
          id: item.id,
          commandHash: hashString(item.command)
        })),
        securityNotes: deploymentProfile.reverseProxy?.deploymentGuide?.securityNotes ?? [],
        rawPublicHostnameStored: false,
        rawUpstreamStored: false,
        rawProxyConfigStored: false,
        rawValidationCommandsStored: false
      },
      rawTrustedProxyHostsStored: false,
      rawUpstreamStored: false,
      rawProxyConfigStored: false
    },
    processManager: deploymentProfile.processManager,
    channels: deploymentProfile.channels,
    readinessChecklist: (deploymentProfile.readinessChecklist ?? []).map((item) => ({
      ...item,
      artifact: undefined,
      artifactHash: hashString(item.artifact),
      rawArtifactPathStored: false
    })),
    runbookVersion: 'd-bridge-server-release-runbook-v1',
    runbookHash: sha256Hex(canonicalJson(deploymentProfile.runbook ?? [])),
    runbookItemHashes: (deploymentProfile.runbook ?? []).map((item) => hashString(item)),
    rawRunbookBodyStored: false,
    environment: deploymentProfile.environment
  };
  const reverseProxyLabEvidence = {
    dossierVersion: reverseProxyLab.dossierVersion,
    generatedAt: reverseProxyLab.generatedAt,
    status: reverseProxyLab.status,
    publicHostnameHash: hashString(reverseProxyLab.publicHostname),
    trustedProxyHostHashes: (reverseProxyLab.trustedProxyHosts ?? []).map((host) => hashString(host)),
    topology: reverseProxyLab.topology,
    checks: reverseProxyLab.checks,
    networkSamplesHash: sha256Hex(canonicalJson(reverseProxyLab.networkSamples ?? {})),
    releaseEvidence: reverseProxyLab.releaseEvidence,
    rawPublicHostnameStored: false,
    rawTrustedProxyHostsStored: false,
    rawNetworkSamplesStored: false
  };
  const serverProductGateEvidence = {
    productGateVersion: serverProductGate.productGateVersion,
    status: serverProductGate.status,
    checks: serverProductGate.checks,
    requiredStatus: serverProductGate.requiredStatus,
    externalEvidencePending: serverProductGate.externalEvidencePending
  };
  const cacheReleaseDossierEvidence = cacheReleaseDossier
    ? {
        dossierVersion: cacheReleaseDossier.dossierVersion,
        status: cacheReleaseDossier.status,
        requiredStatus: cacheReleaseDossier.requiredStatus ?? null,
        artifactManifestHash: cacheReleaseDossier.artifactManifest
          ? sha256Hex(canonicalJson(cacheReleaseDossier.artifactManifest))
          : null,
        operationalHandoffHash: cacheReleaseDossier.operationalHandoffManifest
          ? sha256Hex(canonicalJson(cacheReleaseDossier.operationalHandoffManifest))
          : null,
        wormPackageVersion: cacheReleaseDossier.externalWormPromotionPackage?.packageVersion ?? null,
        rawCacheReleasePayloadStored: false
      }
    : null;
  let artifactManifest = {
    manifestVersion: 'd-bridge-server-release-artifact-manifest-v1',
    openApiRouteCount: routeCount,
    deploymentProfileHash: sha256Hex(canonicalJson(deploymentProfileEvidence)),
    reverseProxyLabHash: sha256Hex(canonicalJson(reverseProxyLabEvidence)),
    serverProductGateHash: sha256Hex(canonicalJson(serverProductGateEvidence)),
    cacheReleaseDossierHash: cacheReleaseDossierEvidence ? sha256Hex(canonicalJson(cacheReleaseDossierEvidence)) : null,
    bridgeSoakArtifactHash: hashString('dist/bridge-server-soak-report.json'),
    bridgeSoakMarkdownArtifactHash: hashString('dist/bridge-server-soak-report.md'),
    openApiContractHash: sha256Hex(canonicalJson({
      routeCount,
      routeNames: Object.values(openApi.paths ?? {})
        .flatMap((methods) => Object.values(methods).map((operation) => operation['x-jarvis-route-name']))
        .filter(Boolean)
        .sort()
    })),
    reverseProxyLabVersion: reverseProxyLab.dossierVersion,
    productGateVersion: serverProductGate.productGateVersion,
    cacheReleaseDossierVersion: cacheReleaseDossier?.dossierVersion ?? null,
    wormArchive: {
      archiveContractVersion: 'd-bridge-server-worm-release-archive-v1',
      storageMode: 'hash_only_bridge_server_release_manifest',
      required: true,
      includedArtifactHashes: [
        sha256Hex(canonicalJson(deploymentProfileEvidence)),
        sha256Hex(canonicalJson(reverseProxyLabEvidence)),
        sha256Hex(canonicalJson(serverProductGateEvidence)),
        cacheReleaseDossierEvidence ? sha256Hex(canonicalJson(cacheReleaseDossierEvidence)) : null,
        hashString('dist/bridge-server-soak-report.json')
      ].filter(Boolean)
    },
    rawBridgeSoakArtifactPathStored: false,
    rawOpenApiSpecStored: false,
    rawDeploymentSecretsStored: false,
    rawReverseProxyNetworkSamplesStored: false,
    rawCacheReleasePayloadStored: false
  };
  const rawNeedles = [
    'dist/bridge-server-soak-report.json',
    'dist/bridge-server-soak-report.md',
    deploymentProfile.readinessChecklist?.find((item) => item.artifact)?.artifact,
    ...(reverseProxyLab.trustedProxyHosts ?? []),
    reverseProxyLab.publicHostname
  ].filter((needle) => typeof needle === 'string' && needle.length >= 8);
  const rawLeakProbe = canonicalJson({
    deploymentProfile: deploymentProfileEvidence,
    reverseProxyLab: reverseProxyLabEvidence,
    serverProductGate: serverProductGateEvidence,
    cacheReleaseDossier: cacheReleaseDossierEvidence,
    artifactManifest
  });
  artifactManifest = {
    ...artifactManifest,
    rawLeakCheck: {
      rawLeakCheckVersion: 'd-bridge-server-release-raw-leak-check-v1',
      rawLeakDetected: rawNeedles.some((needle) => rawLeakProbe.includes(needle)),
      rawNeedleCount: rawNeedles.length,
      scannedFields: ['deploymentProfileEvidence', 'reverseProxyLabEvidence', 'serverProductGateEvidence', 'artifactManifest']
    }
  };
  const releaseWorkflow = {
    workflowVersion: 'd-bridge-server-release-workflow-v1',
    deploymentProfileReady: deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1'
      && deploymentProfile.processManager?.soakCommand === 'npm run bridge:server-soak',
    reverseProxyLabReady: reverseProxyLab.dossierVersion === 'd-bridge-reverse-proxy-lab-dossier-v1'
      && reverseProxyLab.status === 'passed',
    serverProductGateRequiredReady: serverProductGate.productGateVersion === 'd-bridge-server-product-gate-v1'
      && serverProductGate.requiredStatus === 'passed',
    cacheReleaseReady: cacheReleaseDossier?.dossierVersion === 'd-state-cache-release-dossier-v1'
      && cacheReleaseDossier.status === 'passed',
    openApiSurfaceReady: openApi.paths?.['/cache/release-dossier']?.post
      && openApi.paths?.['/server/product-gate']?.post
      && routeCount >= 40,
    liveChannelsReady: deploymentProfile.channels?.sse?.enabled === true
      && deploymentProfile.channels?.websocket?.enabled === true,
    hashOnlyArtifactManifestReady: artifactManifest.rawLeakCheck.rawLeakDetected === false
      && artifactManifest.rawBridgeSoakArtifactPathStored === false
      && artifactManifest.rawOpenApiSpecStored === false
  };
  const operationalHandoffManifest = {
    manifestVersion: 'd-bridge-server-operational-handoff-manifest-v1',
    generatedAt: clock().toISOString(),
    owner: 'bridge-server-release-owner',
    scope: 'local_http_openapi_route_validation_rate_limit_sse_websocket_reverse_proxy_process_manager_soak',
    status: releaseWorkflow.deploymentProfileReady
      && releaseWorkflow.reverseProxyLabReady
      && releaseWorkflow.serverProductGateRequiredReady
      && releaseWorkflow.hashOnlyArtifactManifestReady
      ? 'ready'
      : 'blocked',
    healthHandshakeVersion: 'd-bridge-server-health-handshake-v1',
    healthHandshake: {
      deploymentProfileReady: releaseWorkflow.deploymentProfileReady,
      reverseProxyLabReady: releaseWorkflow.reverseProxyLabReady,
      serverProductGateRequiredReady: releaseWorkflow.serverProductGateRequiredReady,
      cacheReleaseReady: releaseWorkflow.cacheReleaseReady,
      openApiSurfaceReady: releaseWorkflow.openApiSurfaceReady,
      liveChannelsReady: releaseWorkflow.liveChannelsReady,
      rawArtifactPathsStored: artifactManifest.rawBridgeSoakArtifactPathStored,
      rawOpenApiSpecStored: artifactManifest.rawOpenApiSpecStored
    },
    fallbackPolicy: {
      policyVersion: 'd-bridge-server-fallback-policy-v1',
      primaryFlow: 'serve_local_bridge_http_api_behind_private_lan_or_tls_reverse_proxy',
      fallbackFlows: [
        'fall_back_to_sse_when_websocket_upgrade_fails',
        'reject_forwarded_headers_from_untrusted_proxy_hosts',
        'keep_required_release_status_passed_when_physical_mobile_evidence_is_external_pending',
        'block_release_when_openapi_route_contract_or_state_cache_release_dossier_fails'
      ],
      operatorEscalation: 'bridge_server_soak_reverse_proxy_lab_and_mobile_live_bridge_evidence'
    },
    rawBridgeSoakArtifactPathStored: false,
    rawOpenApiSpecStored: false,
    rawDeploymentSecretsStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'd-bridge-server-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "D bridge server deployment profile and WebSocket soak pass" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'bridge_deployment_profile_ready',
      'bridge_reverse_proxy_lab_passed',
      'bridge_server_product_gate_required_passed',
      'bridge_state_cache_release_dossier_passed',
      'bridge_openapi_contract_surface_ready',
      'bridge_websocket_and_sse_channels_ready',
      'bridge_server_release_manifest_hash_only',
      'bridge_server_operational_handoff_ready',
      'bridge_server_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'd-bridge-server-worm-promotion-package-v1',
    providerContractVersion: 'd-bridge-server-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'd-bridge-server-release-artifact-manifest-v1'
      && artifactManifest.wormArchive.archiveContractVersion === 'd-bridge-server-worm-release-archive-v1'
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'd-bridge-server-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawArtifactPathsStored: false,
    rawOpenApiSpecStored: false,
    rawDeploymentSecretsStored: false
  };
  const checks = [
    {
      checkId: 'bridge_deployment_profile_ready',
      status: deploymentProfile.profileVersion === 'd-bridge-deployment-profile-v1'
        && deploymentProfile.processManager?.soakCommand === 'npm run bridge:server-soak' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_reverse_proxy_lab_passed',
      status: reverseProxyLab.dossierVersion === 'd-bridge-reverse-proxy-lab-dossier-v1'
        && reverseProxyLab.status === 'passed' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_server_product_gate_required_passed',
      status: serverProductGate.productGateVersion === 'd-bridge-server-product-gate-v1'
        && serverProductGate.requiredStatus === 'passed' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_state_cache_release_dossier_passed',
      status: cacheReleaseDossier?.dossierVersion === 'd-state-cache-release-dossier-v1'
        && cacheReleaseDossier.status === 'passed' ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_openapi_contract_surface_ready',
      status: openApi.paths?.['/cache/release-dossier']?.post
        && openApi.paths?.['/server/product-gate']?.post
        && routeCount >= 40 ? 'passed' : 'blocked',
      routeCount
    },
    {
      checkId: 'bridge_websocket_and_sse_channels_ready',
      status: deploymentProfile.channels?.sse?.enabled === true
        && deploymentProfile.channels?.websocket?.enabled === true ? 'passed' : 'blocked'
    },
    {
      checkId: 'bridge_physical_mobile_evidence_tracked',
      status: mobileLiveBridgeReport?.status === 'passed' ? 'passed' : 'external-blocked',
      reportStatus: mobileLiveBridgeReport?.status ?? null,
      reason: mobileLiveBridgeReport?.reason ?? 'physical-mobile-live-bridge-evidence-pending'
    },
    {
      checkId: 'bridge_server_release_manifest_hash_only',
      status: artifactManifest.rawLeakCheck.rawLeakDetected === false
        && artifactManifest.wormArchive.includedArtifactHashes.length >= 4
        && artifactManifest.rawBridgeSoakArtifactPathStored === false
        && artifactManifest.rawOpenApiSpecStored === false
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'bridge_server_operational_handoff_ready',
      status: operationalHandoffManifest.manifestVersion === 'd-bridge-server-operational-handoff-manifest-v1'
        && operationalHandoffManifest.healthHandshakeVersion === 'd-bridge-server-health-handshake-v1'
        && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-bridge-server-fallback-policy-v1'
        && operationalHandoffManifest.status === 'ready'
        ? 'passed'
        : 'blocked'
    },
    {
      checkId: 'bridge_server_worm_promotion_package_ready',
      status: externalWormPromotionPackage.packageVersion === 'd-bridge-server-worm-promotion-package-v1'
        && externalWormPromotionPackage.providerContractVersion === 'd-bridge-server-worm-provider-contract-v1'
        && externalWormPromotionPackage.status === 'ready'
        ? 'passed'
        : 'blocked'
    }
  ];
  const blocked = checks.some((check) => check.status === 'blocked');
  const externalBlocked = checks.some((check) => check.status === 'external-blocked');
  return {
    dossierVersion: 'd-bridge-server-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: blocked ? 'blocked' : (externalBlocked ? 'external-blocked' : 'passed'),
    requiredStatus: blocked ? 'blocked' : 'passed',
    checks,
    releaseWorkflow,
    deploymentProfile: deploymentProfileEvidence,
    reverseProxyLab: reverseProxyLabEvidence,
    serverProductGate: serverProductGateEvidence,
    cacheReleaseDossier: cacheReleaseDossierEvidence,
    releaseEvidence: {
      soakReportVersion: soakReport?.reportVersion ?? null,
      soakStatus: soakReport?.status ?? 'missing',
      mobileLiveBridgeStatus: mobileLiveBridgeReport?.status ?? 'missing',
      externalEvidencePending: externalBlocked,
      physicalDeviceVerified: mobileLiveBridgeReport?.status === 'passed'
    },
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage
  };
}

function createBridgeWebSocketChannelProfile() {
  return {
    enabled: true,
    path: '/events/ws',
    protocol: jarvisWebSocketProtocol,
    fallback: 'sse',
    authRequired: true,
    replay: true,
    ack: true,
    heartbeat: true,
    heartbeatIntervalMs: 15_000,
    closePolicy: 'server-closes-on-auth-network-or-protocol-error'
  };
}

function handleEventWebSocketUpgrade({
  request,
  socket,
  bridgeRuntime,
  networkGuard,
  requestValidator,
  serverProfile
}) {
  const path = routePath(request);
  if (path !== '/events/ws') {
    writeUpgradeRejection(socket, 404, 'D_ROUTE_NOT_FOUND', 'WebSocket route not found.');
    return;
  }
  const network = networkGuard.evaluate({
    hostHeader: request.headers.host,
    remoteAddress: request.socket.remoteAddress,
    headers: request.headers
  });
  if (!network.allowed) {
    const networkRateLimit = bridgeRuntime.checkHttpRateLimit({
      action: 'network.public_request',
      ip: request.socket.remoteAddress
    });
    bridgeRuntime.auditLog.write('events.websocket.network_blocked', {
      host: network.host,
      remoteAddress: network.remoteAddress,
      blockedBy: network.blockedBy,
      proxyPolicy: network.proxyPolicy,
      rateLimit: networkRateLimit.rateLimit
    });
    writeUpgradeRejection(socket, 403, 'D_PUBLIC_NETWORK_BLOCKED', 'Bridge accepts only localhost or private LAN WebSocket upgrades.');
    return;
  }
  const limited = bridgeRuntime.checkHttpRateLimit({
    action: 'events.websocket',
    ip: request.socket.remoteAddress,
    token: bearerToken(request) ?? new URL(request.url, 'http://127.0.0.1').searchParams.get('token')
  });
  if (!limited.success) {
    writeUpgradeRejection(socket, 429, 'D_RATE_LIMITED', 'Rate limit exceeded for events.websocket.');
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  const query = requestValidator.validateQuery('events.websocket', url.searchParams);
  if (!query.success) {
    writeUpgradeRejection(socket, query.statusCode ?? 400, query.error?.code ?? 'D_REQUEST_VALIDATION_FAILED', query.error?.message ?? 'Invalid WebSocket query.');
    return;
  }
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    writeUpgradeRejection(socket, 400, 'D_WEBSOCKET_HANDSHAKE_INVALID', 'Missing WebSocket handshake headers.');
    return;
  }
  const token = bearerToken(request) ?? query.value.token;
  const session = bridgeRuntime.openEventStream({
    token,
    sinceEventId: query.value.sinceEventId,
    eventType: query.value.eventType
  });
  if (!session.authenticated) {
    writeUpgradeRejection(socket, session.statusCode ?? 401, session.error?.code ?? 'D_AUTH_MISSING_TOKEN', session.error?.message ?? 'Bearer deviceToken is required.');
    return;
  }

  socket.write(createWebSocketUpgradeResponse({ key, requestedProtocols: request.headers['sec-websocket-protocol'] }));
  const channel = {
    ...serverProfile.webSocketChannel,
    streamId: session.streamId,
    rateLimit: limited.rateLimit
  };
  bridgeRuntime.auditLog.write('events.websocket.opened', {
    streamId: session.streamId,
    deviceId: session.deviceId,
    sinceEventId: query.value.sinceEventId ?? null,
    eventType: query.value.eventType ?? null,
    replayedCount: session.replay.replayedCount
  });
  sendWebSocketJson(socket, {
    type: 'stream.opened',
    streamId: session.streamId,
    channel,
    heartbeatIntervalMs: session.heartbeatIntervalMs,
    reconnect: session.reconnect,
    replay: {
      sinceEventId: session.replay.sinceEventId,
      sinceFound: session.replay.sinceFound,
      replayedCount: session.replay.replayedCount,
      lastEventId: session.replay.lastEventId
    }
  });
  for (const event of session.replay.items) {
    sendWebSocketJson(socket, { type: 'event', event });
  }

  const unsubscribe = bridgeRuntime.eventRelay.subscribe((event) => {
    sendWebSocketJson(socket, { type: 'event', event });
  }, {
    streamId: session.streamId,
    eventType: query.value.eventType
  });
  const heartbeat = setInterval(() => {
    sendWebSocketJson(socket, {
      type: 'heartbeat',
      ...bridgeRuntime.eventRelay.heartbeat(session.streamId)
    });
  }, session.heartbeatIntervalMs);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    bridgeRuntime.eventRelay.closeStream(session.streamId);
  };
  socket.once('close', cleanup);
  socket.once('end', cleanup);
  socket.once('error', cleanup);
  let frameBuffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    if (frameBuffer.length + chunk.length > maximumBridgeWebSocketBufferBytes) {
      sendWebSocketJson(socket, {
        type: 'error',
        error: {
          code: 'D_WEBSOCKET_BUFFER_LIMIT_EXCEEDED',
          message: 'WebSocket receive buffer limit exceeded.'
        }
      });
      socket.end(encodeWebSocketCloseFrame(1009, 'message_too_large'));
      return;
    }
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    const parsed = decodeClientWebSocketFrames(frameBuffer, {
      maximumFrameBytes: maximumBridgeWebSocketFrameBytes
    });
    if (parsed.error) {
      sendWebSocketJson(socket, { type: 'error', error: parsed.error });
      socket.end(encodeWebSocketCloseFrame(parsed.closeCode, parsed.error.code));
      frameBuffer = Buffer.alloc(0);
      return;
    }
    frameBuffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        socket.end(encodeWebSocketCloseFrame());
        return;
      }
      if (frame.opcode !== 0x1) continue;
      let message = null;
      try {
        message = JSON.parse(frame.text);
      } catch {
        sendWebSocketJson(socket, { type: 'error', error: { code: 'D_WEBSOCKET_MESSAGE_INVALID', message: 'WebSocket message must be JSON.' } });
        continue;
      }
      if (message.type === 'ack' && message.eventId) {
        const ack = bridgeRuntime.acknowledgeEvent({
          token,
          eventId: message.eventId,
          streamId: session.streamId
        });
        sendWebSocketJson(socket, { type: 'ack.result', requestId: message.requestId ?? null, ack });
      } else if (message.type === 'ping') {
        sendWebSocketJson(socket, { type: 'pong', requestId: message.requestId ?? null, serverTime: new Date().toISOString() });
      } else {
        sendWebSocketJson(socket, { type: 'error', requestId: message.requestId ?? null, error: { code: 'D_WEBSOCKET_MESSAGE_UNSUPPORTED', message: 'Supported message types: ack, ping.' } });
      }
    }
  });
}

function createWebSocketUpgradeResponse({ key, requestedProtocols }) {
  const accept = createHash('sha1').update(`${key}${webSocketGuid}`).digest('base64');
  const requested = String(requestedProtocols ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const protocol = requested.includes(jarvisWebSocketProtocol) ? jarvisWebSocketProtocol : null;
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    '',
    ''
  ].join('\r\n');
}

function writeUpgradeRejection(socket, statusCode, code, message) {
  const body = JSON.stringify({
    success: false,
    statusCode,
    error: { code, message }
  });
  socket.write([
    `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body
  ].join('\r\n'));
  socket.destroy();
}

function httpStatusText(statusCode) {
  if (statusCode === 400) return 'Bad Request';
  if (statusCode === 401) return 'Unauthorized';
  if (statusCode === 403) return 'Forbidden';
  if (statusCode === 404) return 'Not Found';
  if (statusCode === 429) return 'Too Many Requests';
  return 'Error';
}

function sendWebSocketJson(socket, payload) {
  if (socket.destroyed) return;
  socket.write(encodeWebSocketTextFrame(JSON.stringify(payload)));
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function encodeWebSocketCloseFrame(code = 1000, reason = '') {
  const reasonBuffer = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

export function decodeClientWebSocketFrames(buffer, {
  maximumFrameBytes = maximumBridgeWebSocketFrameBytes
} = {}) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const final = (first & 0x80) === 0x80;
    const reservedBits = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    if (reservedBits !== 0 || !final) {
      return webSocketFrameError('D_WEBSOCKET_FRAGMENT_UNSUPPORTED', 1002, buffer, offset, frames);
    }
    if (!masked) {
      return webSocketFrameError('D_WEBSOCKET_CLIENT_FRAME_UNMASKED', 1002, buffer, offset, frames);
    }
    if (![0x1, 0x8, 0x9, 0xa].includes(opcode)) {
      return webSocketFrameError('D_WEBSOCKET_OPCODE_UNSUPPORTED', 1003, buffer, offset, frames);
    }
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(maximumFrameBytes)) {
        return webSocketFrameError('D_WEBSOCKET_FRAME_LIMIT_EXCEEDED', 1009, buffer, offset, frames);
      }
      length = Number(bigLength);
      headerLength = 10;
    }
    if (length > maximumFrameBytes) {
      return webSocketFrameError('D_WEBSOCKET_FRAME_LIMIT_EXCEEDED', 1009, buffer, offset, frames);
    }
    if (opcode >= 0x8 && length > 125) {
      return webSocketFrameError('D_WEBSOCKET_CONTROL_FRAME_INVALID', 1002, buffer, offset, frames);
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (offset + frameLength > buffer.length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({
      opcode,
      text: opcode === 0x1 ? payload.toString('utf8') : null,
      payload
    });
    offset += frameLength;
  }
  return {
    frames,
    remaining: buffer.subarray(offset),
    error: null,
    closeCode: null
  };
}

function webSocketFrameError(code, closeCode, buffer, offset, frames) {
  return {
    frames,
    remaining: buffer.subarray(offset),
    error: {
      code,
      message: 'WebSocket client frame violates the JARVIS event channel policy.'
    },
    closeCode
  };
}

async function readValidatedBody(request, response, validator, routeName) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const statusCode = error?.expose === true && Number.isInteger(error?.statusCode)
      ? error.statusCode
      : 400;
    const issueCode = error?.code === 'REQUEST_BODY_TOO_LARGE'
      ? 'request_body_too_large'
      : error?.code === 'INVALID_JSON_ENCODING'
        ? 'invalid_json_encoding'
        : 'invalid_json';
    const payload = {
      success: false,
      statusCode,
      error: {
        code: 'D_REQUEST_VALIDATION_FAILED',
        message: statusCode === 413
          ? 'Request body is too large.'
          : `Invalid JSON body for ${routeName}.`
      },
      validation: {
        routeName,
        issues: [{
          path: '$',
          code: issueCode,
          detail: issueCode === 'request_body_too_large'
            ? 'body_limit_exceeded'
            : issueCode === 'invalid_json_encoding'
              ? 'invalid_utf8'
              : 'malformed_json'
        }]
      }
    };
    validator.auditLog?.write('request.validation.failed', payload.validation);
    sendJson(response, statusCode, payload);
    return { success: false };
  }
  const result = validator.validate(routeName, body);
  if (!result.success) {
    sendJson(response, result.statusCode ?? 400, result);
    return { success: false };
  }
  return result;
}

function readValidatedQuery(response, validator, routeName, searchParams) {
  const result = validator.validateQuery(routeName, searchParams);
  if (!result.success) {
    sendJson(response, result.statusCode ?? 400, result);
    return { success: false };
  }
  return result;
}

function rateLimitActionFor(method, path) {
  if (method === 'POST' && path === '/pairing/start') return 'pairing.start';
  if (method === 'POST' && path === '/pairing/confirm') return 'pairing.confirm';
  if (method === 'POST' && path === '/pairing/release-dossier') return 'pairing.release_dossier';
  if (method === 'POST' && path === '/connection/heartbeat') return 'device.heartbeat';
  if (method === 'GET' && path === '/events/fallback-ux') return 'events.fallback_ux';
  if (method === 'POST' && path === '/events/cursors/compact') return 'events.cursor_compact';
  if (method === 'POST' && path === '/events/chaos-drill') return 'events.chaos_drill';
  if (method === 'POST' && path === '/events/product-gate') return 'events.product_gate';
  if (method === 'POST' && path === '/events/release-dossier') return 'events.release_dossier';
  if (method === 'POST' && path === '/devices/token/rotate') return 'device.token.rotate';
  if (method === 'POST' && path === '/devices/token/release-dossier') return 'device.token.release_dossier';
  if (method === 'POST' && path === '/task-approval-result/release-dossier') return 'task_approval_result.release_dossier';
  if (method === 'POST' && path === '/tasks') return 'task.create';
  if (method === 'POST' && routeParams('/approvals/:approvalId/decision', path)) return 'approval.decision';
  if (method === 'POST' && routeParams('/approvals/:approvalId/pc-handoff', path)) return 'approval.pc_handoff';
  if (method === 'POST' && routeParams('/approvals/:approvalId/cancel', path)) return 'approval.cancel';
  if (method === 'POST' && routeParams('/approvals/:approvalId/re-request', path)) return 'approval.re_request';
  if (method === 'POST' && routeParams('/execution-handoffs/:handoffId/confirm', path)) return 'execution.confirm';
  if (method === 'GET' && path === '/pc-agent/poison-packets') return 'pc_agent.poison_queue.read';
  if (method === 'GET' && path === '/pc-console/approval-handoffs') return 'pc_console.handoff.read';
  if (method === 'GET' && path === '/growth/decisions/history') return 'growth.routing.history';
  if (method === 'GET' && path === '/growth/decisions/trends') return 'growth.routing.trend';
  if (method === 'POST' && path === '/growth/routing/release-dossier') return 'growth.routing.release_dossier';
  if (method === 'POST' && routeParams('/pc-console/approval-handoffs/:handoffId/decision', path)) return 'pc_console.handoff.decision';
  if (method === 'GET' && path === '/pc-agent/queue-policy') return 'pc_agent.queue_policy.read';
  if (method === 'POST' && path === '/pc-agent/queue/drain') return 'pc_agent.queue.drain';
  if (method === 'POST' && path === '/pc-agent/queue-policy') return 'pc_agent.queue_policy.update';
  if (method === 'POST' && routeParams('/pc-agent/poison-packets/:queueId/review', path)) return 'pc_agent.poison_packet.review';
  if (method === 'POST' && routeParams('/pc-agent/poison-packets/:queueId/requeue', path)) return 'pc_agent.poison_packet.requeue';
  if (method === 'POST' && routeParams('/pc-agent/poison-packets/:queueId/ignore', path)) return 'pc_agent.poison_packet.ignore';
  if (method === 'POST' && path === '/feedback') return 'feedback';
  if (method === 'POST' && routeParams('/growth/preferences/:hypothesisId/decision', path)) return 'growth.preference.decision';
  if (method === 'POST' && path === '/growth/hygiene/decisions/batch') return 'growth.hygiene.batch_decision';
  if (method === 'POST' && path === '/growth/hygiene/decisions') return 'growth.hygiene.decision';
  for (const action of ['create', 'evaluate', 'review', 'promote', 'rollback']) {
    const suffix = action === 'create'
      ? '/growth/skills/:skillId/revisions'
      : `/growth/skills/:skillId/revisions/:revisionId/${action}`;
    if (method === 'POST' && routeParams(suffix, path)) return `growth.skill_revision.${action}`;
  }
  if (method === 'GET' && path === '/rate-limit/status') return 'rate_limit.status';
  if (method === 'GET' && path === '/rate-limit/abuse-corpus') return 'rate_limit.abuse_corpus';
  if (method === 'POST' && path === '/rate-limit/product-gate') return 'rate_limit.product_gate';
  if (method === 'POST' && path === '/rate-limit/release-dossier') return 'rate_limit.release_dossier';
  if (method === 'POST' && path === '/request-nonces/release-dossier') return 'request_nonce.release_dossier';
  if (method === 'GET' && path === '/cache/schema-snapshot') return 'cache.schema_snapshot';
  if (method === 'POST' && path === '/cache/schema-diff') return 'cache.schema_diff';
  if (method === 'POST' && path === '/cache/compact') return 'cache.compact';
  if (method === 'POST' && path === '/cache/product-gate') return 'cache.product_gate';
  if (method === 'POST' && path === '/cache/release-dossier') return 'cache.release_dossier';
  if (method === 'GET' && path === '/audit/export') return 'audit.export';
  if (method === 'GET' && path === '/audit/siem-export') return 'audit.siem_export';
  if (method === 'POST' && path === '/audit/rotate') return 'audit.rotate';
  if (method === 'POST' && path === '/audit/retention/run') return 'audit.retention_run';
  if (method === 'POST' && path === '/audit/archive/sync') return 'audit.archive_sync';
  if (method === 'POST' && path === '/audit/archive/restore-drill') return 'audit.archive_restore_drill';
  if (method === 'POST' && path === '/audit/product-gate') return 'audit.product_gate';
  if (method === 'POST' && path === '/audit/release-dossier') return 'audit.release_dossier';
  return null;
}

function matchBridgeRouteContract(method, path) {
  for (const [routeName, contract] of Object.entries(allBridgeRouteContracts())) {
    if (contract.method !== method) continue;
    const pattern = contractRoutePattern(contract.path);
    const params = routeParams(pattern, path)
      ?? matchBridgeRouteShapeForValidation(pattern, path);
    if (params) return { routeName, contract, params };
  }
  return null;
}

function matchBridgeRouteShapeForValidation(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (!patternPart.startsWith(':')) {
      if (patternPart !== pathPart) return null;
      continue;
    }
    try {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } catch {
      params[patternPart.slice(1)] = pathPart;
    }
  }
  return params;
}

function contractRoutePattern(path) {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

function parseEnvList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function publicHostnameFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return String(value).replace(/^https?:\/\//i, '').split('/')[0].split(':')[0] || null;
  }
}

function rateLimitHeaders(rateLimit) {
  if (!rateLimit) return {};
  return {
    'x-ratelimit-limit': String(rateLimit.limit),
    'x-ratelimit-remaining': String(rateLimit.remaining),
    'x-ratelimit-reset': rateLimit.resetAt ?? '',
    'x-ratelimit-retry-after-ms': String(rateLimit.retryAfterMs ?? 0),
    'x-ratelimit-action': rateLimit.action
  };
}

function setRateLimitHeaders(response, rateLimit) {
  for (const [key, value] of Object.entries(rateLimitHeaders(rateLimit))) {
    response.setHeader(key, value);
  }
}

export function resolveBridgeListenOptions(env = process.env) {
  const port = Number(env.PORT ?? env.JARVIS_BRIDGE_PORT ?? 17777);
  const host = String(env.JARVIS_BRIDGE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  return { host, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.JARVIS_CORE_API_URL) {
    const { host, port } = resolveBridgeListenOptions();
    const gateway = createCoreBridgeGateway({ coreUrl: process.env.JARVIS_CORE_API_URL,
      networkGuard: new LocalNetworkGuard({
        allowedHostnames: parseEnvList(process.env.JARVIS_BRIDGE_ALLOWED_HOSTS),
        trustedProxyHosts: parseEnvList(process.env.JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS),
        allowForwardedHeaders: process.env.JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS !== 'false',
        allowCgnat: ['1', 'true'].includes(process.env.JARVIS_BRIDGE_ALLOW_TAILSCALE)
      }) });
    gateway.listen(port, host, () => console.log(`JARVIS-D Core gateway listening at http://${host}:${port}`));
    const shutdown = () => { gateway.closeGatewayConnections(); gateway.close(); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  } else {
  if (process.env.JARVIS_BRIDGE_STANDALONE_DEVELOPMENT !== '1') throw new Error('D_GATEWAY_CORE_URL_REQUIRED');
  // 상시 브리지(폰 실사용)는 승인 시 실제 A-G 계획을 실행한다. 끄려면 JARVIS_BRIDGE_REAL_EXECUTION=0.
  // auditRoot를 고정 경로로 주면 기기 등록/토큰이 디스크에 저장되어 브리지 재시작·PC 재부팅 후에도
  // 폰이 재페어링 없이 자동 재연결된다(연결 실패의 근본 원인 해결).
  const bridgeStateDir = process.env.JARVIS_BRIDGE_STATE_DIR
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../logs/bridge-state');
  const { bridgeRuntime } = createAgRuntime({
    bridgeRealExecution: process.env.JARVIS_BRIDGE_REAL_EXECUTION !== '0',
    auditRoot: bridgeStateDir
  });
  bridgeRuntime.growthSkillReviewAuthorizer = createCoreGrowthReviewAuthorizer();
  bridgeRuntime.growthSkillReviewAuthorizationKeyId = process.env.JARVIS_BRIDGE_GROWTH_REVIEW_TOKEN_KEY_ID ?? null;
  // 완료 산출물을 PC 기본 프로그램으로 자동 열기(끄려면 JARVIS_BRIDGE_OPEN_OUTPUTS=0).
  if (process.env.JARVIS_BRIDGE_OPEN_OUTPUTS !== '0') {
    bridgeRuntime.outputOpener = (paths) => {
      for (const rawPath of paths) {
        const target = String(rawPath);
        if (process.platform === 'win32') {
          // start의 첫 따옴표 인자는 창 제목이므로 빈 제목을 먼저 준다.
          spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
        }
      }
    };
  }
  const { host, port } = resolveBridgeListenOptions();
  createBridgeServer(bridgeRuntime).listen(port, host, () => {
    console.log(`JARVIS-D Bridge listening at http://${host}:${port} (${ModuleId.BRIDGE})`);
  });
  }
}
