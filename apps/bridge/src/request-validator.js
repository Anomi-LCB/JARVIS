import { createHash } from 'node:crypto';
import { createError, maskSensitive, TaskStatus } from '../../../packages/shared/src/types.js';

const maxStringLength = 4000;
const allowedTaskStatuses = Object.values(TaskStatus);
const safePathIdPattern = /^[\p{L}\p{N}._:-]+$/u;
const bearerTokenPattern = /^Bearer\s+[A-Za-z0-9._~-]+\.[A-Za-z0-9._~-]+\.[A-Za-z0-9._~-]+$/i;

export const bridgeRouteContracts = Object.freeze({
  body: {
    'pairing.confirm': { method: 'POST', path: '/pairing/confirm', required: ['deviceId', 'deviceName', 'pairingCode'], optional: ['pairingId'], public: true, response: 'PairingConfirmResponse' },
    'pairing.release_dossier': { method: 'POST', path: '/pairing/release-dossier', optional: ['reason'], response: 'PairingReleaseDossierResponse' },
    'device.token.rotate': { method: 'POST', path: '/devices/token/rotate', optional: ['reason'] },
    'device.token.rotation_drill': { method: 'POST', path: '/devices/token/rotation-drill', optional: ['nextSecret'] },
    'device.token.release_dossier': { method: 'POST', path: '/devices/token/release-dossier', optional: ['nextSecret', 'reason'], response: 'DeviceTokenReleaseDossierResponse' },
    'request_nonce.compact': { method: 'POST', path: '/request-nonces/compact', optional: ['dryRun', 'reason'] },
    'request_nonce.product_gate': { method: 'POST', path: '/request-nonces/product-gate', optional: ['drillRequestId'], response: 'RequestNonceProductGateResponse' },
    'request_nonce.release_dossier': { method: 'POST', path: '/request-nonces/release-dossier', optional: ['drillRequestId', 'reason'], response: 'RequestNonceReleaseDossierResponse' },
    'events.ack': { method: 'POST', path: '/events/ack', required: ['eventId'], optional: ['streamId'] },
    'events.cursor_compact': { method: 'POST', path: '/events/cursors/compact', optional: ['keepLast', 'dryRun', 'reason'], response: 'EventCursorCompactionResponse' },
    'events.chaos_drill': { method: 'POST', path: '/events/chaos-drill', optional: ['cycles'], response: 'EventStreamChaosDrillResponse' },
    'events.product_gate': { method: 'POST', path: '/events/product-gate', optional: ['cycles'], response: 'EventStreamProductGateResponse' },
    'events.release_dossier': { method: 'POST', path: '/events/release-dossier', optional: ['cycles', 'reason'], response: 'EventStreamReleaseDossierResponse' },
    'server.product_gate': { method: 'POST', path: '/server/product-gate', optional: ['soakReport', 'mobileLiveBridgeReport'], public: true, response: 'BridgeServerProductGateResponse' },
    'rate_limit.product_gate': { method: 'POST', path: '/rate-limit/product-gate', optional: [], response: 'RateLimitProductGateResponse' },
    'rate_limit.release_dossier': { method: 'POST', path: '/rate-limit/release-dossier', optional: ['reason'], response: 'RateLimitReleaseDossierResponse' },
    'task.create': { method: 'POST', path: '/tasks', required: ['rawText|command.rawText'], optional: ['requestId'], response: 'TaskResponse' },
    'approval.decision': { method: 'POST', path: '/approvals/{approvalId}/decision', params: ['approvalId'], required: ['decision'], optional: ['editRequest', 'responseText'], response: 'ApprovalDecisionResponse' },
    'approval.pc_handoff': { method: 'POST', path: '/approvals/{approvalId}/pc-handoff', params: ['approvalId'], optional: ['reason'] },
    'approval.cancel': { method: 'POST', path: '/approvals/{approvalId}/cancel', params: ['approvalId'], optional: ['reason'] },
    'approval.re_request': { method: 'POST', path: '/approvals/{approvalId}/re-request', params: ['approvalId'], optional: ['reason'] },
    'task_approval_result.release_dossier': { method: 'POST', path: '/task-approval-result/release-dossier', optional: ['reason'], response: 'TaskApprovalResultReleaseDossierResponse' },
    'pc_console.handoff.decision': { method: 'POST', path: '/pc-console/approval-handoffs/{handoffId}/decision', params: ['handoffId'], required: ['decision'], optional: ['operatorId', 'note'] },
    'pc_agent.queue.drain': { method: 'POST', path: '/pc-agent/queue/drain', optional: ['limit'] },
    'pc_agent.queue_policy.update': { method: 'POST', path: '/pc-agent/queue-policy', optional: ['maxAttempts', 'baseBackoffMs', 'reason'] },
    'pc_agent.poison_packet.review': { method: 'POST', path: '/pc-agent/poison-packets/{queueId}/review', params: ['queueId'], optional: ['decision', 'note'] },
    'pc_agent.poison_packet.requeue': { method: 'POST', path: '/pc-agent/poison-packets/{queueId}/requeue', params: ['queueId'], optional: ['patch', 'note'] },
    'pc_agent.poison_packet.ignore': { method: 'POST', path: '/pc-agent/poison-packets/{queueId}/ignore', params: ['queueId'], optional: ['note'] },
    feedback: { method: 'POST', path: '/feedback', required: ['taskId', 'feedbackType'], optional: ['text'] },
    'growth.preference.decision': { method: 'POST', path: '/growth/preferences/{hypothesisId}/decision', params: ['hypothesisId'], required: ['decision'], optional: ['reason'] },
    'growth.hygiene.decision': { method: 'POST', path: '/growth/hygiene/decisions', required: ['targetType', 'targetId', 'action'], optional: ['reason'] },
    'growth.hygiene.batch_decision': { method: 'POST', path: '/growth/hygiene/decisions/batch', required: ['decisions'], optional: ['reason'] },
    'growth.routing.release_dossier': { method: 'POST', path: '/growth/routing/release-dossier', optional: ['windowMinutes', 'reason'], response: 'GrowthRoutingReleaseDossierResponse' },
    'cache.schema_diff': { method: 'POST', path: '/cache/schema-diff', required: ['baseline'], response: 'CacheSchemaDiffResponse' },
    'cache.compact': { method: 'POST', path: '/cache/compact', optional: ['reason'] },
    'cache.product_gate': { method: 'POST', path: '/cache/product-gate', optional: ['baseline', 'reason', 'requireDurableExternalStore'], response: 'CacheProductGateResponse' },
    'cache.release_dossier': { method: 'POST', path: '/cache/release-dossier', optional: ['baseline', 'reason', 'requireDurableExternalStore'], response: 'CacheReleaseDossierResponse' },
    'audit.rotate': { method: 'POST', path: '/audit/rotate', optional: ['reason'], response: 'AuditRotationResponse' },
    'audit.retention_run': { method: 'POST', path: '/audit/retention/run', optional: ['dryRun', 'reason'], response: 'AuditRetentionRunResponse' },
    'audit.archive_sync': { method: 'POST', path: '/audit/archive/sync', optional: ['dryRun', 'targetDir', 'reason'], response: 'AuditArchiveSyncResponse' },
    'audit.archive_restore_drill': { method: 'POST', path: '/audit/archive/restore-drill', optional: ['archivePath'], response: 'AuditArchiveRestoreDrillResponse' },
    'audit.product_gate': { method: 'POST', path: '/audit/product-gate', optional: [], response: 'AuditProductGateResponse' },
    'audit.release_dossier': { method: 'POST', path: '/audit/release-dossier', optional: ['reason'], response: 'AuditReleaseDossierResponse' }
  },
  query: {
    'events.feed': { method: 'GET', path: '/events', optional: ['sinceEventId', 'eventType'], response: 'EventFeedResponse' },
    'events.stream': { method: 'GET', path: '/events/stream', optional: ['token', 'sinceEventId', 'eventType'] },
    'events.websocket': { method: 'GET', path: '/events/ws', optional: ['token', 'sinceEventId', 'eventType'], response: 'WebSocketEventChannelResponse' },
    'events.reconnect_plan': { method: 'GET', path: '/events/reconnect-plan', optional: ['sinceEventId', 'eventType', 'attempt', 'lastError'], response: 'ReconnectPlanResponse' },
    'tasks.list': { method: 'GET', path: '/tasks', optional: ['status'], response: 'TaskListResponse' },
    'pc_agent.poison_queue.read': { method: 'GET', path: '/pc-agent/poison-packets', optional: ['includeIgnored'] },
    'pc_console.handoff.read': { method: 'GET', path: '/pc-console/approval-handoffs', optional: ['status'] },
    'growth.routing.history': { method: 'GET', path: '/growth/decisions/history', optional: ['routeName', 'kind', 'limit'], response: 'GrowthDecisionHistoryResponse' },
    'growth.routing.trend': { method: 'GET', path: '/growth/decisions/trends', optional: ['windowMinutes'], response: 'GrowthRoutingTrendResponse' },
    'audit.summary': { method: 'GET', path: '/audit/summary', optional: ['category', 'severity', 'cursor', 'limit'], response: 'AuditSummaryResponse' },
    'audit.export': { method: 'GET', path: '/audit/export', optional: ['category', 'severity', 'cursor', 'limit', 'reason'], response: 'AuditExportResponse' },
    'audit.siem_export': { method: 'GET', path: '/audit/siem-export', optional: ['category', 'severity', 'cursor', 'limit', 'reason', 'format'], response: 'AuditSiemExportResponse' }
  },
  path: {
    health: { method: 'GET', path: '/health', public: true, response: 'HealthResponse' },
    openapi: { method: 'GET', path: '/openapi.json', public: true, response: 'OpenApiResponse' },
    'server.profile': { method: 'GET', path: '/server/profile', public: true, response: 'ServerProfileResponse' },
    'server.deployment_profile': { method: 'GET', path: '/server/deployment-profile', public: true, response: 'ServerDeploymentProfileResponse' },
    'server.reverse_proxy_lab': { method: 'GET', path: '/server/reverse-proxy-lab', public: true, response: 'BridgeReverseProxyLabDossierResponse' },
    'pairing.start': { method: 'POST', path: '/pairing/start', public: true, response: 'PairingStartResponse' },
    'devices.list': { method: 'GET', path: '/devices', response: 'DeviceListResponse' },
    'devices.inventory': { method: 'GET', path: '/devices/inventory', response: 'DeviceInventoryResponse' },
    'device.token.policy': { method: 'GET', path: '/devices/token/policy' },
    'request_nonce.policy': { method: 'GET', path: '/request-nonces/policy' },
    'request_nonce.clock_skew_fixtures': { method: 'GET', path: '/request-nonces/clock-skew-fixtures' },
    'device.revoke': { method: 'DELETE', path: '/devices/{deviceId}', params: ['deviceId'] },
    'device.heartbeat': { method: 'POST', path: '/connection/heartbeat' },
    'task.status': { method: 'GET', path: '/tasks/{taskId}', params: ['taskId'], response: 'TaskStatusResponse' },
    'approvals.list': { method: 'GET', path: '/approvals', response: 'ApprovalListResponse' },
    'approval.history': { method: 'GET', path: '/approvals/{approvalId}/history', params: ['approvalId'] },
    'approval.read': { method: 'GET', path: '/approvals/{approvalId}', params: ['approvalId'] },
    'approval.renew': { method: 'POST', path: '/approvals/{approvalId}/renew', params: ['approvalId'] },
    'execution.confirm': { method: 'POST', path: '/execution-handoffs/{handoffId}/confirm', params: ['handoffId'] },
    'result.read': { method: 'GET', path: '/results/{taskId}', params: ['taskId'], response: 'ResultResponse' },
    'result.rollback': { method: 'POST', path: '/results/{taskId}/rollback', params: ['taskId'], optional: ['reason'], response: 'ResultRollbackResponse' },
    'events.stream.status': { method: 'GET', path: '/events/stream/status' },
    'events.fallback_ux': { method: 'GET', path: '/events/fallback-ux', response: 'EventFallbackUxResponse' },
    'rate_limit.status': { method: 'GET', path: '/rate-limit/status', response: 'RateLimitStatusResponse' },
    'rate_limit.abuse_corpus': { method: 'GET', path: '/rate-limit/abuse-corpus', response: 'RateLimitAbuseCorpusResponse' },
    'pc_agent.queue_policy.read': { method: 'GET', path: '/pc-agent/queue-policy' },
    'growth.review.latest': { method: 'GET', path: '/growth/review/latest' },
    'cache.snapshot': { method: 'GET', path: '/cache/snapshot', response: 'CacheSnapshotResponse' },
    'cache.schema_snapshot': { method: 'GET', path: '/cache/schema-snapshot', response: 'CacheSchemaSnapshotResponse' }
  }
});

export function createBridgeOpenApiSpec() {
  const paths = {};
  for (const [routeName, contract] of Object.entries(allBridgeRouteContracts())) {
    const method = contract.method.toLowerCase();
    paths[contract.path] ??= {};
    paths[contract.path][method] = {
      operationId: routeName.replace(/[.]/g, '_'),
      summary: `JARVIS D Bridge ${routeName}`,
      'x-jarvis-route-name': routeName,
      'x-required-fields': contract.required ?? [],
      'x-optional-fields': contract.optional ?? [],
      parameters: [
        ...pathParameters(contract.params ?? []),
        ...queryParameters(contract.optional ?? [], contract.method),
        ...headerParameters(contract)
      ],
      requestBody: contract.method === 'POST'
        ? {
            required: routeName in bridgeRouteContracts.body,
            content: {
              'application/json': {
                schema: requestBodySchema(contract)
              }
            }
          }
        : undefined,
      security: contract.public ? [] : [{ deviceToken: [] }],
      responses: {
        200: {
          description: 'Success envelope or route payload',
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${contract.response ?? 'SuccessEnvelope'}` }
            }
          }
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/AuthError' },
        429: { $ref: '#/components/responses/RateLimited' }
      }
    };
    if (paths[contract.path][method].requestBody === undefined) {
      delete paths[contract.path][method].requestBody;
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'JARVIS D Bridge API',
      version: '1.0.0'
    },
    paths,
    components: {
      securitySchemes: {
        deviceToken: { type: 'http', scheme: 'bearer' }
      },
      responses: {
        ValidationError: {
          description: 'D_REQUEST_VALIDATION_FAILED typed error envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorEnvelope' } } }
        },
        AuthError: {
          description: 'D_AUTH_* typed error envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/TypedErrorEnvelope' } } }
        },
        RateLimited: {
          description: 'D_RATE_LIMITED typed error envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RateLimitEnvelope' } } }
        }
      },
      schemas: {
        SuccessEnvelope: {
          type: 'object',
          required: ['success'],
          properties: { success: { const: true } },
          additionalProperties: true
        },
        TypedErrorEnvelope: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { const: false },
            statusCode: { type: 'integer' },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' }
              }
            }
          }
        },
        ValidationErrorEnvelope: {
          allOf: [
            { $ref: '#/components/schemas/TypedErrorEnvelope' },
            {
              type: 'object',
              required: ['validation'],
              properties: {
                validation: {
                  type: 'object',
                  required: ['routeName', 'issues'],
                  properties: {
                    routeName: { type: 'string' },
                    issues: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['path', 'code'],
                        properties: {
                          path: { type: 'string' },
                          code: { type: 'string' },
                          detail: { type: 'string' }
                        },
                        additionalProperties: true
                      }
                    },
                    sanitizedPreview: {}
                  }
                }
              }
            }
          ]
        },
        RateLimitEnvelope: {
          allOf: [
            { $ref: '#/components/schemas/TypedErrorEnvelope' },
            {
              type: 'object',
              properties: {
                rateLimit: { $ref: '#/components/schemas/RateLimitState' }
              }
            }
          ]
        },
        RateLimitState: {
          type: 'object',
          required: ['action', 'limit', 'remaining'],
          properties: {
            action: { type: 'string' },
            limit: { type: 'integer' },
            remaining: { type: 'integer' },
            resetAt: { type: 'string' },
            retryAfterMs: { type: 'integer' }
          },
          additionalProperties: true
        },
        RateLimitStatusResponse: {
          type: 'object',
          required: ['success', 'snapshot'],
          properties: {
            success: { const: true },
            snapshot: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        RateLimitAbuseCorpusResponse: {
          type: 'object',
          required: ['success', 'report'],
          properties: {
            success: { const: true },
            report: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        RateLimitReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-rate-limit-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            productGateEvidence: { type: 'object', additionalProperties: true },
            artifactManifest: { type: 'object', additionalProperties: true },
            operationalHandoffManifest: { type: 'object', additionalProperties: true },
            ciNightlyGatePlan: { type: 'object', additionalProperties: true },
            externalWormPromotionPackage: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        RequestNonceReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-request-nonce-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            productGateEvidence: { type: 'object', additionalProperties: true },
            artifactManifest: { type: 'object', additionalProperties: true },
            operationalHandoffManifest: { type: 'object', additionalProperties: true },
            ciNightlyGatePlan: { type: 'object', additionalProperties: true },
            externalWormPromotionPackage: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        GrowthDecisionHistoryResponse: {
          type: 'object',
          required: ['success', 'historyVersion', 'items'],
          properties: {
            success: { const: true },
            historyVersion: { const: 'd-growth-review-decision-history-v1' },
            generatedAt: { type: 'string' },
            filters: { type: 'object', additionalProperties: true },
            totalStored: { type: 'integer' },
            items: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        GrowthRoutingTrendResponse: {
          type: 'object',
          required: ['success', 'trendVersion', 'totalDecisions'],
          properties: {
            success: { const: true },
            trendVersion: { const: 'd-growth-routing-trend-v1' },
            generatedAt: { type: 'string' },
            windowMinutes: { type: 'integer' },
            totalDecisions: { type: 'integer' },
            successRate: { type: 'number' },
            averageLatencyMs: { type: 'number' },
            byRoute: { type: 'object', additionalProperties: true },
            byKind: { type: 'object', additionalProperties: true },
            batchSelection: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        GrowthRoutingReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-growth-routing-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            history: { $ref: '#/components/schemas/GrowthDecisionHistoryResponse' },
            trend: { $ref: '#/components/schemas/GrowthRoutingTrendResponse' },
            routingCoverage: { type: 'object', additionalProperties: true },
            routeContracts: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            artifactManifest: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        HealthResponse: {
          type: 'object',
          required: ['module'],
          properties: {
            module: { type: 'string' },
            status: { type: 'string' }
          },
          additionalProperties: true
        },
        OpenApiResponse: {
          type: 'object',
          required: ['openapi', 'paths', 'components'],
          properties: {
            openapi: { type: 'string' },
            paths: { type: 'object', additionalProperties: true },
            components: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        ServerProfileResponse: {
          type: 'object',
          required: ['module', 'serverStack', 'middleware', 'routes'],
          properties: {
            module: { type: 'string' },
            serverStack: { type: 'string' },
            frameworkCompatibility: { type: 'object', additionalProperties: true },
            webSocketChannel: { type: 'object', additionalProperties: true },
            middleware: { type: 'array', items: { type: 'string' } },
            routes: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        ServerDeploymentProfileResponse: {
          type: 'object',
          required: ['profileVersion', 'module', 'topology', 'tls', 'reverseProxy', 'processManager', 'channels'],
          properties: {
            profileVersion: { const: 'd-bridge-deployment-profile-v1' },
            module: { type: 'string' },
            topology: { type: 'object', additionalProperties: true },
            tls: { type: 'object', additionalProperties: true },
            reverseProxy: { type: 'object', additionalProperties: true },
            processManager: { type: 'object', additionalProperties: true },
            channels: { type: 'object', additionalProperties: true },
            readinessChecklist: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        BridgeReverseProxyLabDossierResponse: {
          type: 'object',
          required: ['dossierVersion', 'status', 'checks', 'networkSamples'],
          properties: {
            dossierVersion: { const: 'd-bridge-reverse-proxy-lab-dossier-v1' },
            generatedAt: { type: 'string' },
            status: { type: 'string', enum: ['passed', 'blocked'] },
            publicHostname: { type: 'string' },
            trustedProxyHosts: { type: 'array', items: { type: 'string' } },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            networkSamples: { type: 'object', additionalProperties: true },
            releaseEvidence: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        BridgeServerProductGateResponse: {
          type: 'object',
          required: ['productGateVersion', 'status', 'checks', 'requiredStatus'],
          properties: {
            productGateVersion: { const: 'd-bridge-server-product-gate-v1' },
            status: { type: 'string', enum: ['passed', 'blocked', 'external-blocked'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            requiredStatus: { type: 'string' },
            externalEvidencePending: { type: 'boolean' }
          },
          additionalProperties: true
        },
        PairingStartResponse: {
          type: 'object',
          required: ['pairingId', 'pairingCode', 'qrPayload'],
          properties: {
            pairingId: { type: 'string' },
            pairingCode: { type: 'string' },
            expiresAt: { type: 'string' },
            attemptsRemaining: { type: 'integer' },
            qrPayload: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        PairingConfirmResponse: {
          type: 'object',
          required: ['deviceId', 'deviceToken', 'expiresAt'],
          properties: {
            deviceId: { type: 'string' },
            deviceToken: { type: 'string' },
            expiresAt: { type: 'string' },
            token: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        PairingReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-pairing-device-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            pairingEvidence: { type: 'object', additionalProperties: true },
            registryBackend: { type: 'object', additionalProperties: true },
            artifactManifest: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        DeviceListResponse: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            inventory: { type: 'object', additionalProperties: true },
            persistence: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        DeviceInventoryResponse: {
          type: 'object',
          required: ['inventoryVersion', 'items', 'persistence'],
          properties: {
            inventoryVersion: { const: 'd-device-inventory-v1' },
            generatedAt: { type: 'string' },
            persistence: { type: 'object', additionalProperties: true },
            totalDevices: { type: 'integer' },
            activeDevices: { type: 'integer' },
            revokedDevices: { type: 'integer' },
            expiredDevices: { type: 'integer' },
            byStatus: { type: 'object', additionalProperties: true },
            byTrustLabel: { type: 'object', additionalProperties: true },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            recovery: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        DeviceTokenReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-device-token-auth-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            policy: { type: 'object', additionalProperties: true },
            rotationDrill: { type: 'object', additionalProperties: true },
            signingKeyProvider: { type: 'object', additionalProperties: true },
            authProof: { type: 'object', additionalProperties: true },
            inventoryEvidence: { type: 'object', additionalProperties: true },
            artifactManifest: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        TaskResponse: {
          type: 'object',
          required: ['taskId', 'status'],
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            approvalRequired: { type: 'boolean' }
          },
          additionalProperties: true
        },
        TaskStatusResponse: {
          type: 'object',
          required: ['taskId', 'status'],
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            task: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        TaskListResponse: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        ApprovalDecisionResponse: {
          type: 'object',
          required: ['success'],
          properties: {
            success: { type: 'boolean' },
            decision: { type: 'object', additionalProperties: true },
            task: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        ApprovalListResponse: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        EventFeedResponse: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            replay: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        WebSocketEventChannelResponse: {
          type: 'object',
          required: ['success', 'channel'],
          properties: {
            success: { const: false },
            error: { type: 'object', additionalProperties: true },
            channel: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        ReconnectPlanResponse: {
          type: 'object',
          required: ['reconnect'],
          properties: {
            reconnect: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        EventStreamReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks', 'releaseWorkflow', 'releaseExercise', 'artifactManifest', 'releaseHash'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-event-stream-release-dossier-v1' },
            status: { enum: ['passed', 'blocked'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            releaseWorkflow: {
              type: 'object',
              required: ['workflowVersion', 'productGateReady', 'cursorPersistenceReady', 'releaseExerciseReady', 'promotionStatus'],
              properties: {
                workflowVersion: { const: 'd-event-stream-release-workflow-v1' },
                productGateReady: { type: 'boolean' },
                cursorPersistenceReady: { type: 'boolean' },
                reconnectBackoffReady: { type: 'boolean' },
                networkChaosReady: { type: 'boolean' },
                fallbackUxReady: { type: 'boolean' },
                cursorCompactionReady: { type: 'boolean' },
                releaseExerciseReady: { type: 'boolean' },
                promotionStatus: { type: 'string' }
              },
              additionalProperties: true
            },
            releaseExercise: {
              type: 'object',
              required: ['exerciseVersion', 'status', 'eventIdHash', 'streamIdHash', 'ackCursorHash', 'persistedAck'],
              properties: {
                exerciseVersion: { const: 'd-event-stream-release-exercise-v1' },
                status: { enum: ['passed', 'blocked'] },
                eventIdHash: { type: 'string' },
                streamIdHash: { type: 'string' },
                ackCursorHash: { type: 'string' },
                replayedCount: { type: 'integer' },
                persistedAck: { type: 'boolean' }
              },
              additionalProperties: true
            },
            productGate: { type: 'object', additionalProperties: true },
            artifactManifest: {
              type: 'object',
              required: ['manifestVersion', 'releaseExerciseHash', 'rawDeviceTokenStored', 'rawLeakCheck', 'wormArchive'],
              properties: {
                manifestVersion: { const: 'd-event-stream-release-artifact-manifest-v1' },
                releaseExerciseHash: { type: 'string' },
                rawDeviceTokenStored: { const: false },
                rawDeviceIdStored: { const: false },
                rawEventIdsStored: { const: false },
                rawStreamIdsStored: { const: false },
                rawCursorJournalPathStored: { const: false },
                rawLeakCheck: {
                  type: 'object',
                  properties: {
                    checkedNeedleCount: { type: 'integer' },
                    rawLeakDetected: { const: false }
                  },
                  additionalProperties: true
                },
                wormArchive: {
                  type: 'object',
                  properties: {
                    archiveContractVersion: { const: 'd-event-stream-worm-release-archive-v1' },
                    storageMode: { type: 'string' }
                  },
                  additionalProperties: true
                }
              },
              additionalProperties: true
            },
            releaseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }
          },
          additionalProperties: true
        },
        ResultResponse: {
          type: 'object',
          required: ['taskId'],
          properties: {
            taskId: { type: 'string' },
            result: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        ResultRollbackResponse: {
          type: 'object',
          required: ['success', 'rollback'],
          properties: {
            success: { const: true },
            rollback: { type: 'object', additionalProperties: true },
            task: { type: 'object', additionalProperties: true },
            audit: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        TaskApprovalResultReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-bridge-task-approval-result-release-dossier-v1' },
            dossierSha256: { type: 'string' },
            generatedAt: { type: 'string' },
            status: { enum: ['passed', 'blocked'] },
            reason: { type: 'string' },
            checks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            liveWorkflow: { type: 'object', additionalProperties: true },
            routeContracts: {
              type: 'array',
              items: { type: 'object', additionalProperties: true }
            },
            artifactManifest: { type: 'object', additionalProperties: true },
            rateLimit: { $ref: '#/components/schemas/RateLimitState' }
          },
          additionalProperties: true
        },
        AuditSummaryResponse: {
          type: 'object',
          required: ['chain', 'total', 'latest'],
          properties: {
            chain: { type: 'object', additionalProperties: true },
            total: { type: 'integer' },
            latest: { type: 'array', items: { type: 'object', additionalProperties: true } },
            byCategory: { type: 'object', additionalProperties: true },
            bySeverity: { type: 'object', additionalProperties: true },
            pageInfo: { type: 'object', additionalProperties: true },
            retention: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        AuditExportResponse: {
          type: 'object',
          required: ['success', 'bundle', 'verification'],
          properties: {
            success: { const: true },
            bundle: {
              type: 'object',
              required: ['schemaVersion', 'exportId', 'manifestHash', 'signature', 'entries'],
              properties: {
                schemaVersion: { type: 'string' },
                exportId: { type: 'string' },
                manifestHash: { type: 'string' },
                signature: { type: 'string' },
                entries: { type: 'array', items: { type: 'object', additionalProperties: true } }
              },
              additionalProperties: true
            },
            verification: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        AuditRotationResponse: {
          type: 'object',
          required: ['success', 'rotation'],
          properties: {
            success: { const: true },
            rotation: {
              type: 'object',
              required: ['archivedEntries', 'archiveHash', 'chain'],
              properties: {
                archivedEntries: { type: 'integer' },
                archivePath: { type: ['string', 'null'] },
                archiveHash: { type: 'string' },
                chain: { type: 'object', additionalProperties: true }
              },
              additionalProperties: true
            }
          },
          additionalProperties: true
        },
        AuditProductGateResponse: {
          type: 'object',
          required: ['success', 'productGateVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            productGateVersion: { const: 'd-bridge-audit-log-product-gate-v1' },
            status: { enum: ['passed', 'failed'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            siem: { type: 'object', additionalProperties: true },
            archiveSync: { type: 'object', additionalProperties: true },
            restoreDrill: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        AuditReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-bridge-audit-log-release-dossier-v1' },
            status: { enum: ['passed', 'blocked'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            productGate: { $ref: '#/components/schemas/AuditProductGateResponse' },
            artifactManifest: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        CacheSnapshotResponse: {
          type: 'object',
          required: ['tasks', 'approvals', 'persistence'],
          properties: {
            tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            approvals: { type: 'array', items: { type: 'object', additionalProperties: true } },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
            persistence: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        CacheSchemaSnapshotResponse: {
          type: 'object',
          required: ['success', 'snapshot'],
          properties: {
            success: { const: true },
            snapshot: { type: 'object', additionalProperties: true },
            externalStore: { type: 'object', additionalProperties: true },
            compactionLock: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        CacheSchemaDiffResponse: {
          type: 'object',
          required: ['success', 'diff'],
          properties: {
            success: { const: true },
            diff: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        CacheProductGateResponse: {
          type: 'object',
          required: ['success', 'productGateVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            productGateVersion: { const: 'd-state-cache-product-gate-v1' },
            status: { enum: ['passed', 'failed'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            rotationDrill: { type: 'object', additionalProperties: true },
            externalStorePolicy: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        CacheReleaseDossierResponse: {
          type: 'object',
          required: ['success', 'dossierVersion', 'status', 'checks'],
          properties: {
            success: { const: true },
            dossierVersion: { const: 'd-state-cache-release-dossier-v1' },
            status: { enum: ['passed', 'blocked'] },
            checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            productGate: { $ref: '#/components/schemas/CacheProductGateResponse' },
            archiveRestoreDrill: { type: 'object', additionalProperties: true },
            artifactManifest: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        }
      }
    }
  };
}

export function createBridgeApiContractSnapshot(openApi = createBridgeOpenApiSpec(), { label = 'current' } = {}) {
  const routes = Object.entries(openApi.paths ?? {})
    .flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({
      path,
      method: method.toUpperCase(),
      operationId: operation.operationId,
      routeName: operation['x-jarvis-route-name'],
      requiredFields: operation['x-required-fields'] ?? [],
      optionalFields: operation['x-optional-fields'] ?? [],
      responseRef: operation.responses?.[200]?.content?.['application/json']?.schema?.$ref ?? null,
      secured: Array.isArray(operation.security) ? operation.security.length > 0 : true
    })))
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  const snapshot = {
    snapshotVersion: 'd-bridge-api-schema-snapshot-v1',
    label,
    generatedAt: new Date().toISOString(),
    openApiVersion: openApi.openapi,
    routeCount: routes.length,
    schemaCount: Object.keys(openApi.components?.schemas ?? {}).length,
    routes
  };
  return {
    ...snapshot,
    contractHash: sha256(canonicalJson({
      openApiVersion: snapshot.openApiVersion,
      routes: snapshot.routes,
      schemas: openApi.components?.schemas ?? {}
    }))
  };
}

export function diffBridgeApiContractSnapshots(baseline, current) {
  const baselineRoutes = new Map((baseline?.routes ?? []).map((route) => [`${route.method} ${route.path}`, route]));
  const currentRoutes = new Map((current?.routes ?? []).map((route) => [`${route.method} ${route.path}`, route]));
  const diffs = [];
  for (const [key, route] of baselineRoutes) {
    if (!currentRoutes.has(key)) {
      diffs.push({ type: 'route_removed', key, route });
      continue;
    }
    const next = currentRoutes.get(key);
    if (JSON.stringify(route.requiredFields) !== JSON.stringify(next.requiredFields)) {
      diffs.push({ type: 'required_fields_changed', key, before: route.requiredFields, after: next.requiredFields });
    }
    if (route.responseRef !== next.responseRef) {
      diffs.push({ type: 'response_schema_changed', key, before: route.responseRef, after: next.responseRef });
    }
    if (route.secured !== next.secured) {
      diffs.push({ type: 'security_changed', key, before: route.secured, after: next.secured });
    }
  }
  for (const [key, route] of currentRoutes) {
    if (!baselineRoutes.has(key)) diffs.push({ type: 'route_added', key, route });
  }
  return {
    diffVersion: 'd-bridge-api-schema-snapshot-diff-v1',
    status: diffs.some((diff) => ['route_removed', 'required_fields_changed', 'response_schema_changed', 'security_changed'].includes(diff.type)) ? 'failed' : 'passed',
    baselineHash: baseline?.contractHash ?? null,
    currentHash: current?.contractHash ?? null,
    diffCount: diffs.length,
    diffs
  };
}

export function createBridgeClientTypeDeclarations(openApi = createBridgeOpenApiSpec(), snapshot = createBridgeApiContractSnapshot(openApi)) {
  const routeNames = snapshot.routes.map((route) => route.routeName).filter(Boolean);
  const routeUnion = routeNames.map((routeName) => `  | ${JSON.stringify(routeName)}`).join('\n') || '  | never';
  const operationMap = snapshot.routes
    .map((route) => `  ${JSON.stringify(route.routeName)}: { method: ${JSON.stringify(route.method)}; path: ${JSON.stringify(route.path)}; response: ${JSON.stringify(route.responseRef)}; secured: ${route.secured}; };`)
    .join('\n');
  return [
    '// Generated by scripts/bridge-client-contract-gate.mjs',
    '// d-bridge-openapi-client-types-v1',
    `export const bridgeApiContractHash = ${JSON.stringify(snapshot.contractHash)};`,
    `export const bridgeApiSnapshotVersion = ${JSON.stringify(snapshot.snapshotVersion)};`,
    'export type BridgeRouteName =',
    `${routeUnion};`,
    'export interface BridgeOperationMap {',
    operationMap,
    '}',
    'export type BridgeOperation<RouteName extends BridgeRouteName> = BridgeOperationMap[RouteName];',
    ''
  ].join('\n');
}

const taskApprovalResultRouteNames = Object.freeze([
  'task.create',
  'tasks.list',
  'task.status',
  'approvals.list',
  'approval.read',
  'approval.history',
  'approval.renew',
  'approval.decision',
  'approval.cancel',
  'approval.re_request',
  'approval.pc_handoff',
  'execution.confirm',
  'result.read',
  'result.rollback',
  'feedback'
]);

export function createBridgeTaskApprovalResultResponseFixtures(openApi = createBridgeOpenApiSpec(), snapshot = createBridgeApiContractSnapshot(openApi)) {
  const schemas = openApi.components?.schemas ?? {};
  const routeByName = new Map(snapshot.routes.map((route) => [route.routeName, route]));
  const fixtures = taskApprovalResultRouteNames.map((routeName) => {
    const route = routeByName.get(routeName) ?? null;
    const responseSchemaName = route?.responseRef?.replace('#/components/schemas/', '') ?? null;
    const schemaAvailable = responseSchemaName ? Boolean(schemas[responseSchemaName]) : false;
    return {
      fixtureId: `fixture:${routeName}`,
      routeName,
      method: route?.method ?? null,
      path: route?.path ?? null,
      secured: route?.secured ?? true,
      responseRef: route?.responseRef ?? null,
      responseSchemaName,
      schemaAvailable,
      example: createBridgeResponseExample(routeName, responseSchemaName)
    };
  });
  const missingRoutes = fixtures.filter((fixture) => !fixture.path).map((fixture) => fixture.routeName);
  const unresolvedSchemas = fixtures.filter((fixture) => !fixture.schemaAvailable).map((fixture) => ({
    routeName: fixture.routeName,
    responseRef: fixture.responseRef
  }));
  const fixtureHash = sha256(canonicalJson(fixtures.map((fixture) => ({
    routeName: fixture.routeName,
    method: fixture.method,
    path: fixture.path,
    responseRef: fixture.responseRef,
    example: fixture.example
  }))));
  return {
    fixtureVersion: 'd-bridge-task-approval-result-response-fixtures-v1',
    generatedAt: new Date().toISOString(),
    status: missingRoutes.length === 0 && unresolvedSchemas.length === 0 ? 'passed' : 'failed',
    fixtureHash,
    routeCount: fixtures.length,
    securedRouteCount: fixtures.filter((fixture) => fixture.secured).length,
    missingRoutes,
    unresolvedSchemas,
    fixtures
  };
}

export function runBridgeTaskApprovalResultContractGate({
  openApi = createBridgeOpenApiSpec(),
  generatedTypesText = null,
  baselineSnapshot = null
} = {}) {
  const snapshot = createBridgeApiContractSnapshot(openApi, { label: 'task-approval-result-current' });
  const generatedTypes = generatedTypesText ?? createBridgeClientTypeDeclarations(openApi, snapshot);
  const fixtures = createBridgeTaskApprovalResultResponseFixtures(openApi, snapshot);
  const currentSubset = filterBridgeSnapshotByRouteNames(snapshot, taskApprovalResultRouteNames, 'task-approval-result-current');
  const baselineSubset = filterBridgeSnapshotByRouteNames(baselineSnapshot ?? snapshot, taskApprovalResultRouteNames, 'task-approval-result-baseline');
  const subsetDiff = diffBridgeApiContractSnapshots(baselineSubset, currentSubset);
  const driftGate = runBridgeClientServerDriftGate({
    openApi,
    baselineSnapshot: baselineSnapshot ?? snapshot,
    generatedTypesText: generatedTypes
  });
  const generatedRouteCoverage = taskApprovalResultRouteNames.map((routeName) => ({
    routeName,
    covered: generatedTypes.includes(JSON.stringify(routeName))
  }));
  const checks = [
    { id: 'task_approval_result_route_surface_complete', passed: fixtures.missingRoutes.length === 0 },
    { id: 'task_approval_result_response_fixtures_complete', passed: fixtures.status === 'passed' && fixtures.routeCount === taskApprovalResultRouteNames.length },
    { id: 'task_approval_result_schema_refs_resolved', passed: fixtures.unresolvedSchemas.length === 0 },
    { id: 'task_approval_result_generated_types_cover_routes', passed: generatedRouteCoverage.every((route) => route.covered) },
    { id: 'task_approval_result_contract_diff_clean', passed: subsetDiff.status === 'passed' },
    { id: 'task_approval_result_client_server_drift_clean', passed: driftGate.status === 'passed' }
  ];
  return {
    gateVersion: 'd-bridge-task-approval-result-contract-gate-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    routeNames: taskApprovalResultRouteNames,
    fixtures,
    subsetDiff,
    driftGate,
    generatedRouteCoverage,
    checks
  };
}

export function runBridgeMalformedRequestCorpus({ validator = new BridgeRequestValidator() } = {}) {
  const cases = [
    {
      caseId: 'task_create_empty_command',
      source: 'body',
      routeName: 'task.create',
      input: { command: { rawText: '\u0000   ' } },
      expectedCode: 'required_command_text'
    },
    {
      caseId: 'approval_decision_unsupported',
      source: 'body',
      routeName: 'approval.decision',
      input: { decision: 'launch' },
      expectedCode: 'unsupported_decision'
    },
    {
      caseId: 'growth_hygiene_batch_bad_action',
      source: 'body',
      routeName: 'growth.hygiene.batch_decision',
      input: { decisions: [{ targetType: 'memory_event', targetId: 'evt_1', action: 'publish' }] },
      expectedCode: 'unsupported_enum'
    },
    {
      caseId: 'task_status_unsafe_path',
      source: 'path',
      routeName: 'task.status',
      input: { taskId: 'task_bad/escape' },
      expectedCode: 'unsafe_path_param'
    },
    {
      caseId: 'malformed_bearer_token',
      source: 'headers',
      routeName: 'tasks.list',
      input: { authorization: 'Bearer legacy-token' },
      expectedCode: 'malformed_bearer_token'
    },
    {
      caseId: 'growth_history_invalid_query',
      source: 'query',
      routeName: 'growth.routing.history',
      input: new URLSearchParams('kind=unknown&limit=999'),
      expectedCode: 'unsupported_enum'
    }
  ];
  const items = cases.map((item) => {
    const result = item.source === 'body'
      ? validator.validate(item.routeName, item.input)
      : item.source === 'path'
        ? validator.validatePath(item.routeName, item.input)
        : item.source === 'headers'
          ? validator.validateHeaders(item.routeName, item.input)
          : validator.validateQuery(item.routeName, item.input);
    const issueCodes = result.validation?.issues?.map((issue) => issue.code) ?? [];
    return {
      ...item,
      input: item.source === 'query' ? item.input.toString() : item.input,
      passed: result.success !== true && issueCodes.includes(item.expectedCode),
      actualCodes: issueCodes,
      sanitizedPreview: result.validation?.sanitizedPreview ?? null
    };
  });
  return {
    corpusVersion: 'd-bridge-malformed-request-corpus-v1',
    status: items.every((item) => item.passed) ? 'passed' : 'failed',
    fixtureCount: items.length,
    passedCount: items.filter((item) => item.passed).length,
    coverage: [...new Set(items.map((item) => item.source))].sort(),
    items
  };
}

export function runBridgeClientServerDriftGate({
  openApi = createBridgeOpenApiSpec(),
  generatedTypesText = null,
  baselineSnapshot = null
} = {}) {
  const currentSnapshot = createBridgeApiContractSnapshot(openApi, { label: 'current' });
  const baseline = baselineSnapshot ?? currentSnapshot;
  const diff = diffBridgeApiContractSnapshots(baseline, currentSnapshot);
  const expectedHash = currentSnapshot.contractHash;
  const generatedHash = generatedTypesText ? extractGeneratedContractHash(generatedTypesText) : expectedHash;
  return {
    gateVersion: 'd-bridge-client-server-drift-gate-v1',
    status: diff.status === 'passed' && generatedHash === expectedHash ? 'passed' : 'failed',
    expectedHash,
    generatedHash,
    generatedTypesVersion: generatedTypesText?.includes('d-bridge-openapi-client-types-v1') ? 'd-bridge-openapi-client-types-v1' : null,
    diff
  };
}

export class PayloadSanitizer {
  sanitize(value) {
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string') return value;
      return value.replace(/\p{C}/gu, '').trim().slice(0, maxStringLength);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.sanitize(item)])
    );
  }

  auditSafe(value) {
    return maskSensitive(this.sanitize(value));
  }
}

export class BridgeTierGuard {
  inspectTaskCommand(commandText) {
    const text = String(commandText ?? '');
    const externalTransfer = /전송|보내|send|post|upload|band|카톡|메일|email/i.test(text);
    const destructive = /삭제|포맷|초기화|delete|remove|format|wipe/i.test(text);
    return {
      externalTransfer,
      destructive,
      mobileRequiresPcConfirmation: externalTransfer || destructive
    };
  }
}

export class BridgeRequestValidator {
  constructor({ sanitizer = new PayloadSanitizer(), tierGuard = new BridgeTierGuard(), auditLog = null } = {}) {
    this.sanitizer = sanitizer;
    this.tierGuard = tierGuard;
    this.auditLog = auditLog;
  }

  validate(routeName, body = {}) {
    const sanitized = this.sanitizer.sanitize(body);
    const issues = [];
    const requireString = (path, { min = 1, max = 500 } = {}) => {
      const value = getPath(sanitized, path);
      if (typeof value !== 'string' || value.trim().length < min) {
        issues.push({ path, code: 'required_string' });
        return null;
      }
      if (value.length > max) issues.push({ path, code: 'string_too_long', max });
      return value;
    };
    const optionalString = (path, { min = 0, max = 500 } = {}) => {
      if (getPath(sanitized, path) === undefined) return null;
      const value = getPath(sanitized, path);
      if (typeof value !== 'string') {
        issues.push({ path, code: 'must_be_string' });
        return null;
      }
      if (value.trim().length < min) issues.push({ path, code: 'string_too_short', min });
      if (value.length > max) issues.push({ path, code: 'string_too_long', max });
      return value;
    };
    const optionalInteger = (path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
      if (getPath(sanitized, path) === undefined) return null;
      const value = Number(getPath(sanitized, path));
      if (!Number.isInteger(value)) {
        issues.push({ path, code: 'must_be_integer' });
        return null;
      }
      if (value < min || value > max) issues.push({ path, code: 'integer_out_of_range', min, max });
      setPath(sanitized, path, value);
      return value;
    };
    const optionalObject = (path) => {
      if (getPath(sanitized, path) === undefined) return null;
      const value = getPath(sanitized, path);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, code: 'must_be_object' });
        return null;
      }
      return value;
    };
    const enumValue = (path, allowed, { required = false } = {}) => {
      const value = getPath(sanitized, path);
      if (value === undefined) {
        if (required) issues.push({ path, code: 'required_enum', allowed });
        return null;
      }
      if (typeof value !== 'string' || !allowed.includes(value)) {
        issues.push({ path, code: 'unsupported_enum', allowed });
        return null;
      }
      return value;
    };

    if (routeName === 'pairing.confirm') {
      requireString('deviceId', { max: 120 });
      requireString('deviceName', { max: 120 });
      requireString('pairingCode', { min: 6, max: 12 });
      optionalString('pairingId', { max: 120 });
    } else if (routeName === 'pairing.release_dossier') {
      optionalString('reason', { max: 300 });
    } else if (routeName === 'device.token.rotate') {
      optionalString('reason', { max: 240 });
    } else if (routeName === 'device.token.rotation_drill') {
      optionalString('nextSecret', { min: 32, max: 512 });
    } else if (routeName === 'device.token.release_dossier') {
      optionalString('nextSecret', { min: 32, max: 512 });
      optionalString('reason', { max: 300 });
    } else if (routeName === 'request_nonce.compact') {
      optionalString('reason', { max: 240 });
      if (sanitized.dryRun !== undefined && typeof sanitized.dryRun !== 'boolean') {
        issues.push({ path: 'dryRun', code: 'must_be_boolean' });
      }
    } else if (routeName === 'events.ack') {
      requireString('eventId', { max: 160 });
      optionalString('streamId', { max: 160 });
    } else if (routeName === 'events.cursor_compact') {
      optionalInteger('keepLast', { min: 1, max: 1000 });
      if (sanitized.dryRun !== undefined && typeof sanitized.dryRun !== 'boolean') {
        issues.push({ path: 'dryRun', code: 'must_be_boolean' });
      }
      optionalString('reason', { max: 300 });
    } else if (routeName === 'events.chaos_drill' || routeName === 'events.product_gate' || routeName === 'events.release_dossier') {
      optionalInteger('cycles', { min: 1, max: 10 });
      if (routeName === 'events.release_dossier') optionalString('reason', { max: 300 });
    } else if (routeName === 'server.product_gate') {
      optionalObject('soakReport');
      optionalObject('mobileLiveBridgeReport');
    } else if (routeName === 'task.create') {
      const rawText = typeof sanitized.rawText === 'string'
        ? sanitized.rawText
        : getPath(sanitized, 'command.rawText');
      if (!rawText || !String(rawText).trim()) issues.push({ path: 'rawText|command.rawText', code: 'required_command_text' });
      if (String(rawText ?? '').length > 2000) issues.push({ path: 'command.rawText', code: 'command_too_long', max: 2000 });
      if (sanitized.requestId !== undefined) requireString('requestId', { max: 160 });
      sanitized.bridgeSafety = this.tierGuard.inspectTaskCommand(rawText);
    } else if (routeName === 'approval.decision') {
      const decision = requireString('decision', { max: 20 });
      if (decision && !['approve', 'edit', 'reject', 'respond'].includes(decision)) {
        issues.push({ path: 'decision', code: 'unsupported_decision' });
      }
      if (sanitized.editRequest !== undefined && typeof sanitized.editRequest !== 'string') {
        issues.push({ path: 'editRequest', code: 'must_be_string' });
      }
      if (sanitized.responseText !== undefined && typeof sanitized.responseText !== 'string') {
        issues.push({ path: 'responseText', code: 'must_be_string' });
      }
    } else if (routeName === 'approval.pc_handoff' || routeName === 'approval.cancel' || routeName === 'approval.re_request') {
      optionalString('reason', { max: 300 });
    } else if (routeName === 'task_approval_result.release_dossier') {
      optionalString('reason', { max: 300 });
    } else if (routeName === 'pc_console.handoff.decision') {
      enumValue('decision', ['approve', 'reject'], { required: true });
      optionalString('operatorId', { max: 120 });
      optionalString('note', { max: 1000 });
    } else if (routeName === 'pc_agent.queue.drain') {
      optionalInteger('limit', { min: 1, max: 50 });
    } else if (routeName === 'pc_agent.queue_policy.update') {
      optionalInteger('maxAttempts', { min: 1, max: 10 });
      optionalInteger('baseBackoffMs', { min: 100, max: 60000 });
      optionalString('reason', { max: 300 });
    } else if (routeName === 'pc_agent.poison_packet.review') {
      optionalString('decision', { max: 80 });
      optionalString('note', { max: 1000 });
    } else if (routeName === 'pc_agent.poison_packet.requeue') {
      optionalObject('patch');
      optionalString('note', { max: 1000 });
    } else if (routeName === 'pc_agent.poison_packet.ignore') {
      optionalString('note', { max: 1000 });
    } else if (routeName === 'feedback') {
      requireString('taskId', { max: 160 });
      requireString('feedbackType', { max: 80 });
      if (sanitized.text !== undefined && typeof sanitized.text !== 'string') {
        issues.push({ path: 'text', code: 'must_be_string' });
      }
    } else if (routeName === 'growth.preference.decision') {
      enumValue('decision', ['confirm', 'reject'], { required: true });
      optionalString('reason', { max: 500 });
    } else if (routeName === 'growth.hygiene.decision') {
      enumValue('targetType', ['memory_event', 'pattern', 'preference_candidate', 'failure'], { required: true });
      requireString('targetId', { max: 180 });
      enumValue('action', ['keep', 'delete', 'redact', 'defer'], { required: true });
      optionalString('reason', { max: 500 });
    } else if (routeName === 'growth.hygiene.batch_decision') {
      if (!Array.isArray(sanitized.decisions) || sanitized.decisions.length === 0) {
        issues.push({ path: 'decisions', code: 'required_non_empty_array' });
      } else if (sanitized.decisions.length > 20) {
        issues.push({ path: 'decisions', code: 'array_too_long', max: 20 });
      } else {
        sanitized.decisions.forEach((decision, index) => {
          if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
            issues.push({ path: `decisions.${index}`, code: 'must_be_object' });
            return;
          }
          if (!['memory_event', 'pattern', 'preference_candidate', 'failure'].includes(decision.targetType)) {
            issues.push({ path: `decisions.${index}.targetType`, code: 'unsupported_enum' });
          }
          if (typeof decision.targetId !== 'string' || !decision.targetId.trim() || decision.targetId.length > 180) {
            issues.push({ path: `decisions.${index}.targetId`, code: 'required_string' });
          }
          if (!['keep', 'delete', 'redact', 'defer'].includes(decision.action)) {
            issues.push({ path: `decisions.${index}.action`, code: 'unsupported_enum' });
          }
          if (decision.reason !== undefined && typeof decision.reason !== 'string') {
            issues.push({ path: `decisions.${index}.reason`, code: 'must_be_string' });
          }
          if (typeof decision.reason === 'string' && decision.reason.length > 500) {
            issues.push({ path: `decisions.${index}.reason`, code: 'string_too_long', max: 500 });
          }
        });
      }
      optionalString('reason', { max: 500 });
    } else if (routeName === 'growth.routing.release_dossier') {
      optionalInteger('windowMinutes', { min: 1, max: 10_080 });
      optionalString('reason', { max: 300 });
    } else if (routeName === 'cache.compact' || routeName === 'cache.product_gate' || routeName === 'cache.release_dossier') {
      optionalString('reason', { max: 300 });
      if (routeName === 'cache.product_gate' || routeName === 'cache.release_dossier') {
        if (sanitized.baseline !== undefined && (typeof sanitized.baseline !== 'object' || Array.isArray(sanitized.baseline) || sanitized.baseline === null)) {
          issues.push({ path: 'baseline', code: 'must_be_object' });
        }
        if (sanitized.requireDurableExternalStore !== undefined && typeof sanitized.requireDurableExternalStore !== 'boolean') {
          issues.push({ path: 'requireDurableExternalStore', code: 'must_be_boolean' });
        }
      }
    } else if (routeName === 'audit.rotate' || routeName === 'audit.retention_run') {
      if (routeName === 'audit.retention_run') {
        const rawDryRun = sanitized.dryRun;
        if (rawDryRun !== undefined && typeof rawDryRun !== 'boolean') issues.push({ path: 'dryRun', code: 'must_be_boolean' });
      }
      optionalString('reason', { max: 300 });
    } else if (routeName === 'audit.archive_sync') {
      const rawDryRun = sanitized.dryRun;
      if (rawDryRun !== undefined && typeof rawDryRun !== 'boolean') issues.push({ path: 'dryRun', code: 'must_be_boolean' });
      optionalString('targetDir', { max: 1000 });
      optionalString('reason', { max: 300 });
    } else if (routeName === 'audit.archive_restore_drill') {
      optionalString('archivePath', { max: 1000 });
    } else if (routeName === 'audit.release_dossier') {
      optionalString('reason', { max: 300 });
    }

    if (issues.length > 0) {
      const error = createError('D_REQUEST_VALIDATION_FAILED', `Invalid ${routeName} payload.`, 400);
      const result = {
        ...error,
        validation: {
          routeName,
          issues,
          sanitizedPreview: this.sanitizer.auditSafe(sanitized)
        }
      };
      this.auditLog?.write('request.validation.failed', {
        routeName,
        issues,
        sanitizedPreview: result.validation.sanitizedPreview
      });
      return result;
    }
    return { success: true, value: sanitized };
  }

  validatePath(routeName, params = {}) {
    const contract = allBridgeRouteContracts()[routeName];
    const expected = contract?.params ?? [];
    const sanitized = this.sanitizer.sanitize(params);
    const issues = [];
    for (const name of expected) {
      const value = sanitized[name];
      if (typeof value !== 'string' || !value.trim()) {
        issues.push({ path: name, code: 'required_path_param' });
        continue;
      }
      if (value.length > 180) issues.push({ path: name, code: 'path_param_too_long', max: 180 });
      if (value.includes('/') || value.includes('\\') || value.includes('..')) {
        issues.push({ path: name, code: 'unsafe_path_param' });
      }
      if (!safePathIdPattern.test(value)) {
        issues.push({ path: name, code: 'unsupported_path_param_chars' });
      }
    }
    for (const key of Object.keys(sanitized)) {
      if (!expected.includes(key)) issues.push({ path: key, code: 'unexpected_path_param' });
    }
    if (issues.length > 0) {
      return this.validationError(routeName, 'path', issues, sanitized);
    }
    return { success: true, value: sanitized };
  }

  validateHeaders(routeName, headers = {}) {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value ?? '')])
    );
    const issues = [];
    const contentType = normalized['content-type'];
    if (routeName in bridgeRouteContracts.body) {
      if (contentType !== undefined && !contentType.toLowerCase().includes('application/json')) {
        issues.push({ path: 'content-type', code: 'unsupported_content_type', expected: 'application/json' });
      }
    }
    const authorization = normalized.authorization;
    if (authorization !== undefined) {
      if (authorization.length > 3200) {
        issues.push({ path: 'authorization', code: 'header_too_long', max: 3200 });
      } else if (!bearerTokenPattern.test(authorization)) {
        issues.push({ path: 'authorization', code: 'malformed_bearer_token' });
      }
    }
    const requestId = normalized['x-request-id'];
    if (requestId !== undefined) {
      if (requestId.length > 160) issues.push({ path: 'x-request-id', code: 'header_too_long', max: 160 });
      if (/[\r\n]/.test(requestId)) issues.push({ path: 'x-request-id', code: 'header_control_character' });
    }
    if (issues.length > 0) {
      return this.validationError(routeName, 'headers', issues, {
        authorization: authorization ? '[masked]' : undefined,
        'content-type': contentType,
        'x-request-id': requestId
      });
    }
    return {
      success: true,
      value: {
        authorizationPresent: Boolean(authorization),
        contentType: contentType ?? null,
        requestId: requestId ?? null
      }
    };
  }

  validateQuery(routeName, searchParams = new URLSearchParams()) {
    const query = Object.fromEntries(searchParams.entries());
    const sanitized = this.sanitizer.sanitize(query);
    const issues = [];
    const optionalString = (path, { max = 500 } = {}) => {
      const value = sanitized[path];
      if (value === undefined) return null;
      if (typeof value !== 'string') {
        issues.push({ path, code: 'must_be_string' });
        return null;
      }
      if (value.length > max) issues.push({ path, code: 'string_too_long', max });
      return value;
    };
    const optionalEnum = (path, allowed) => {
      const value = sanitized[path];
      if (value === undefined || value === '') return null;
      if (!allowed.includes(value)) {
        issues.push({ path, code: 'unsupported_enum', allowed });
        return null;
      }
      return value;
    };
    const optionalInteger = (path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
      const raw = sanitized[path];
      if (raw === undefined || raw === '') return null;
      const value = Number(raw);
      if (!Number.isInteger(value)) {
        issues.push({ path, code: 'must_be_integer' });
        return null;
      }
      if (value < min || value > max) issues.push({ path, code: 'integer_out_of_range', min, max });
      sanitized[path] = value;
      return value;
    };
    const optionalBoolean = (path) => {
      const raw = sanitized[path];
      if (raw === undefined || raw === '') return false;
      if (!['true', 'false'].includes(raw)) {
        issues.push({ path, code: 'must_be_boolean_string' });
        return false;
      }
      sanitized[path] = raw === 'true';
      return sanitized[path];
    };

    if (routeName === 'events.feed' || routeName === 'events.stream' || routeName === 'events.websocket') {
      optionalString('sinceEventId', { max: 160 });
      optionalString('eventType', { max: 120 });
      if (routeName === 'events.stream' || routeName === 'events.websocket') optionalString('token', { max: 3000 });
    } else if (routeName === 'events.reconnect_plan') {
      optionalString('sinceEventId', { max: 160 });
      optionalString('eventType', { max: 120 });
      optionalInteger('attempt', { min: 0, max: 50 });
      optionalString('lastError', { max: 300 });
    } else if (routeName === 'tasks.list') {
      optionalEnum('status', allowedTaskStatuses);
    } else if (routeName === 'pc_agent.poison_queue.read') {
      optionalBoolean('includeIgnored');
    } else if (routeName === 'pc_console.handoff.read') {
      optionalEnum('status', ['awaiting_pc_confirmation', 'accepted', 'rejected', 'expired']);
    } else if (routeName === 'growth.routing.history') {
      optionalString('routeName', { max: 120 });
      optionalEnum('kind', ['feedback', 'preference', 'hygiene', 'hygiene_batch']);
      optionalInteger('limit', { min: 1, max: 200 });
    } else if (routeName === 'growth.routing.trend') {
      optionalInteger('windowMinutes', { min: 1, max: 10_080 });
    } else if (routeName === 'audit.summary' || routeName === 'audit.export' || routeName === 'audit.siem_export') {
      optionalEnum('category', ['access', 'security', 'approval', 'workflow', 'system']);
      optionalEnum('severity', ['info', 'warning', 'error']);
      optionalInteger('cursor', { min: 0, max: 1_000_000 });
      optionalInteger('limit', { min: 1, max: 200 });
      if (routeName === 'audit.export' || routeName === 'audit.siem_export') optionalString('reason', { max: 300 });
      if (routeName === 'audit.siem_export') optionalEnum('format', ['jsonl', 'cef', 'both']);
    }

    if (issues.length > 0) {
      const error = createError('D_REQUEST_VALIDATION_FAILED', `Invalid ${routeName} query.`, 400);
      const result = {
        ...error,
        validation: {
          routeName,
          issues,
          sanitizedPreview: this.sanitizer.auditSafe(sanitized)
        }
      };
      this.auditLog?.write('request.query_validation.failed', {
        routeName,
        issues,
        sanitizedPreview: result.validation.sanitizedPreview
      });
      return result;
    }
    return { success: true, value: sanitized };
  }

  validationError(routeName, source, issues, sanitizedPreview) {
    const error = createError('D_REQUEST_VALIDATION_FAILED', `Invalid ${routeName} ${source}.`, 400);
    const result = {
      ...error,
      validation: {
        routeName,
        source,
        issues,
        sanitizedPreview: this.sanitizer.auditSafe(sanitizedPreview)
      }
    };
    this.auditLog?.write(`request.${source}_validation.failed`, {
      routeName,
      issues,
      sanitizedPreview: result.validation.sanitizedPreview
    });
    return result;
  }
}

export function allBridgeRouteContracts() {
  return {
    ...bridgeRouteContracts.body,
    ...bridgeRouteContracts.query,
    ...bridgeRouteContracts.path
  };
}

function pathParameters(params) {
  return params.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', maxLength: 180, pattern: '^[\\p{L}\\p{N}._:-]+$' }
  }));
}

function queryParameters(optional, method) {
  if (method !== 'GET') return [];
  return optional.map((name) => ({
    name,
    in: 'query',
    required: false,
    schema: querySchemaFor(name)
  }));
}

function headerParameters(contract) {
  const headers = [
    {
      name: 'Authorization',
      in: 'header',
      required: false,
      schema: { type: 'string', maxLength: 3200, pattern: '^Bearer\\s+.+' }
    },
    {
      name: 'X-Request-Id',
      in: 'header',
      required: false,
      schema: { type: 'string', maxLength: 160 }
    }
  ];
  if (contract.method === 'POST') {
    headers.push({
      name: 'Content-Type',
      in: 'header',
      required: false,
      schema: { type: 'string', const: 'application/json' }
    });
  }
  return headers;
}

function requestBodySchema(contract) {
  const required = (contract.required ?? []).map((field) => field.includes('|') ? field.split('|')[0] : field);
  const properties = Object.fromEntries(
    [...(contract.required ?? []), ...(contract.optional ?? [])]
      .map((field) => field.includes('|') ? field.split('|')[0] : field)
      .map((field) => [field, bodyPropertySchema(field)])
  );
  return {
    type: 'object',
    required,
    properties,
    additionalProperties: true
  };
}

function bodyPropertySchema(field) {
  if (/maxAttempts|baseBackoffMs/.test(field)) return { type: 'integer' };
  if (/patch|soakReport|mobileLiveBridgeReport/.test(field)) return { type: 'object', additionalProperties: true };
  if (/decision|action|targetType|feedbackType/.test(field)) return { type: 'string' };
  return { type: 'string' };
}

function querySchemaFor(name) {
  if (name === 'attempt') return { type: 'integer', minimum: 0, maximum: 50 };
  if (name === 'cursor') return { type: 'integer', minimum: 0 };
  if (name === 'limit') return { type: 'integer', minimum: 1, maximum: 200 };
  if (name === 'windowMinutes') return { type: 'integer', minimum: 1, maximum: 10_080 };
  if (name === 'includeIgnored') return { type: 'boolean' };
  return { type: 'string' };
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function setPath(value, path, nextValue) {
  const parts = path.split('.');
  let current = value;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = nextValue;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function filterBridgeSnapshotByRouteNames(snapshot, routeNames, label) {
  const allow = new Set(routeNames);
  const routes = (snapshot?.routes ?? []).filter((route) => allow.has(route.routeName));
  const next = {
    snapshotVersion: snapshot?.snapshotVersion ?? 'd-bridge-api-schema-snapshot-v1',
    label,
    generatedAt: new Date().toISOString(),
    openApiVersion: snapshot?.openApiVersion ?? null,
    routeCount: routes.length,
    schemaCount: snapshot?.schemaCount ?? 0,
    routes
  };
  return {
    ...next,
    contractHash: sha256(canonicalJson({
      openApiVersion: next.openApiVersion,
      routes: next.routes
    }))
  };
}

function createBridgeResponseExample(routeName, responseSchemaName) {
  const task = {
    taskId: 'task_fixture_001',
    status: 'awaiting_approval',
    rawText: 'Create a weekly operations report',
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  const approval = {
    approvalId: 'approval_fixture_001',
    taskId: task.taskId,
    status: 'pending',
    riskTier: 2,
    expiresAt: '2026-01-01T00:05:00.000Z'
  };
  const result = {
    taskId: task.taskId,
    status: 'completed',
    summary: 'Report generated',
    outputPath: 'C:/Users/user/Documents/Jarvis/out/weekly-report.xlsx'
  };
  const handoff = {
    handoffId: 'handoff_fixture_001',
    approvalId: approval.approvalId,
    status: 'pending_pc_confirmation'
  };
  const common = { success: true, fixtureSchema: responseSchemaName };
  if (routeName === 'task.create') return { ...common, taskId: task.taskId, task, approval };
  if (routeName === 'tasks.list') return { ...common, items: [task], cursor: null };
  if (routeName === 'task.status') return { ...common, task };
  if (routeName === 'approvals.list') return { ...common, items: [approval] };
  if (routeName === 'approval.read') return { ...common, approval };
  if (routeName === 'approval.history') return { ...common, approvalId: approval.approvalId, items: [{ eventType: 'approval.created', at: task.createdAt }] };
  if (routeName === 'approval.renew') return { ...common, approval: { ...approval, expiresAt: '2026-01-01T00:10:00.000Z' } };
  if (routeName === 'approval.decision') return { ...common, decision: 'approve', approval: { ...approval, status: 'approved' }, handoff };
  if (routeName === 'approval.cancel') return { ...common, approval: { ...approval, status: 'cancelled' } };
  if (routeName === 'approval.re_request') return { ...common, previousApprovalId: approval.approvalId, replacement: { ...approval, approvalId: 'approval_fixture_002' } };
  if (routeName === 'approval.pc_handoff') return { ...common, handoff };
  if (routeName === 'execution.confirm') return { ...common, handoff: { ...handoff, status: 'confirmed' }, task: { ...task, status: 'running' } };
  if (routeName === 'result.read') return { ...common, result };
  if (routeName === 'result.rollback') return { ...common, rollback: { taskId: task.taskId, status: 'queued', rollbackId: 'rollback_fixture_001' } };
  if (routeName === 'feedback') return { ...common, stored: true, feedback: { taskId: task.taskId, feedbackType: 'result_good' } };
  return { ...common, routeName };
}

function extractGeneratedContractHash(text) {
  const match = /bridgeApiContractHash\s*=\s*["']([^"']+)["']/.exec(String(text ?? ''));
  return match?.[1] ?? null;
}
