import { createServer } from 'node:http';
import { CoreFacade } from './core-facade.js';
import { CoreRuntime } from './runtime/core-runtime.js';
import { CoreRuntimeSupervisor } from './runtime/core-supervisor.js';
import { CoreWorkerDaemon } from './runtime/core-worker-daemon.js';
import { CoreAdminScope, createCoreAdminAuthProvider } from './security/core-admin-auth.js';
import { createCoreServiceLifecyclePlan, verifyCoreServiceReadiness } from './install/core-service-planner.js';
import { ApprovalDecision, createApprovalDecision, ModuleId } from '../../shared/src/types.js';
import { bearerToken, readJsonBody, routeParams, routePath, safeHandle, sendJson } from '../../shared/src/http.js';

export function createCoreServer(coreFacade = new CoreFacade(), {
  runtime = new CoreRuntime({ eventBus: coreFacade.eventBus }),
  adminTokenHash = defaultCoreAdminTokenHashFromEnv(process.env),
  adminToken = process.env.JARVIS_CORE_ADMIN_TOKEN ?? (adminTokenHash ? null : 'local-core-admin'),
  adminTokens = [],
  adminAuth = null,
  orchestrationWorker = null,
  runtimeSupervisor = null,
  workerDaemon = null
} = {}) {
  runtime.init({ profile: 'core-api' });
  runtime.start();
  const supervisor = runtimeSupervisor ?? new CoreRuntimeSupervisor({ runtime, worker: orchestrationWorker });
  const daemon = workerDaemon ?? (orchestrationWorker ? new CoreWorkerDaemon({ worker: orchestrationWorker }) : null);
  const adminAuthProvider = adminAuth ?? createCoreAdminAuthProvider({ adminToken, adminTokenHash, adminTokens, clock: runtime.clock });
  return createServer((request, response) => safeHandle(response, async () => {
    const path = routePath(request);
    if (request.method === 'GET' && path === '/health') {
      return sendJson(response, 200, runtime.health());
    }
    if (request.method === 'GET' && path === '/admin/diagnostics') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.READ_DIAGNOSTICS,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      return sendJson(response, 200, {
        ...runtime.diagnostics(),
        supervisor: supervisor.status(),
        workerDaemon: daemon?.status?.() ?? null,
        adminAuth: adminAuthProvider.status(),
        core: coreFacade.adminDiagnostics?.() ?? adminDiagnostics(coreFacade)
      });
    }
    if (request.method === 'GET' && path === '/runtime/supervisor') {
      return sendJson(response, 200, supervisor.status());
    }
    if (request.method === 'POST' && path === '/runtime/supervisor/tick') {
      const body = await readJsonBody(request);
      return sendJson(response, 200, await supervisor.tick({
        reason: body.reason ?? 'api-tick',
        drainLimit: body.drainLimit ?? 0
      }));
    }
    if (request.method === 'POST' && path === '/runtime/service-plan') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.ADMIN,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      const body = await readJsonBody(request);
      const plan = createCoreServiceLifecyclePlan({
        action: body.action ?? 'status',
        cwd: body.cwd ?? process.cwd(),
        execute: body.execute === true,
        port: body.port,
        logs: body.logs ?? {}
      });
      const readiness = await verifyCoreServiceReadiness({
        cwd: body.cwd ?? process.cwd(),
        osPlatform: body.osPlatform,
        isAdministrator: body.isAdministrator === true,
        plan
      });
      return sendJson(response, 200, {
        reportVersion: 'a-core-service-lifecycle-report-v1',
        plan,
        readiness
      });
    }
    if (request.method === 'GET' && path === '/openapi.json') {
      return sendJson(response, 200, createCoreOpenApiSpec(coreFacade));
    }
    if (request.method === 'GET' && path === '/tasks') {
      return sendJson(response, 200, { items: [...coreFacade.tasks.values()].map(taskSummary) });
    }
    if (request.method === 'POST' && path === '/tasks') {
      const body = await readJsonBody(request);
      const task = coreFacade.createTask(body.rawText ?? body.command ?? '', body.options ?? {});
      return sendJson(response, 201, taskSummary(task, { detail: true }));
    }
    const taskParams = routeParams('/tasks/:taskId', path);
    if (request.method === 'GET' && taskParams) {
      const task = coreFacade.getTask(taskParams.taskId);
      if (!task) return sendJson(response, 404, { success: false, reason: 'task-not-found' });
      return sendJson(response, 200, taskSummary(task, { detail: true }));
    }
    const approveParams = routeParams('/tasks/:taskId/approve', path);
    if (request.method === 'POST' && approveParams) {
      const task = coreFacade.getTask(approveParams.taskId);
      if (!task) return sendJson(response, 404, { success: false, reason: 'task-not-found' });
      const body = await readJsonBody(request);
      const decision = createApprovalDecision({
        approvalId: task.approvalCard.approvalId,
        taskId: task.taskId,
        decision: body.decision ?? ApprovalDecision.APPROVE,
        deviceId: body.deviceId ?? 'core_api',
        sourceModule: ModuleId.CORE,
        editRequest: body.editRequest,
        responseText: body.responseText,
        decidedAt: body.decidedAt
      });
      return sendJson(response, 200, coreFacade.submitApprovalDecision(decision));
    }
    const resumeParams = routeParams('/tasks/:taskId/resume', path);
    if (request.method === 'GET' && resumeParams) {
      return sendJson(response, 200, coreFacade.resumeTask(resumeParams.taskId));
    }
    const runParams = routeParams('/tasks/:taskId/run', path);
    if (request.method === 'POST' && runParams) {
      if (!orchestrationWorker?.runTask) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const task = coreFacade.getTask(runParams.taskId);
      if (!task) return sendJson(response, 404, { success: false, reason: 'task-not-found' });
      const body = await readJsonBody(request);
      const approvalDecision = body.approvalDecision ?? (body.decision ? createApprovalDecision({
        approvalId: task.approvalCard.approvalId,
        taskId: task.taskId,
        decision: body.decision,
        deviceId: body.deviceId ?? 'core_api_worker',
        sourceModule: ModuleId.CORE,
        decidedAt: body.decidedAt
      }) : null);
      const result = await orchestrationWorker.runTask(runParams.taskId, {
        approvalDecision,
        userConfirmation: body.userConfirmation,
        dryRun: body.dryRun === true
      });
      return sendJson(response, result.success ? 200 : 409, result);
    }
    const queueParams = routeParams('/tasks/:taskId/queue', path);
    if (request.method === 'POST' && queueParams) {
      if (!orchestrationWorker?.enqueueTask) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const task = coreFacade.getTask(queueParams.taskId);
      if (!task) return sendJson(response, 404, { success: false, reason: 'task-not-found' });
      const body = await readJsonBody(request);
      return sendJson(response, 202, orchestrationWorker.enqueueTask(queueParams.taskId, body.options ?? {}));
    }
    if (request.method === 'GET' && path === '/worker/queue') {
      if (!orchestrationWorker?.queueStatus) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.queueStatus());
    }
    if (request.method === 'POST' && path === '/worker/queue/drain') {
      if (!orchestrationWorker?.drain) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, await orchestrationWorker.drain({ limit: body.limit ?? 5 }));
    }
    if (request.method === 'GET' && path === '/worker/leases') {
      if (!orchestrationWorker?.leaseTable?.status) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.leaseTable.status());
    }
    if (request.method === 'POST' && path === '/worker/leases/recover') {
      if (!orchestrationWorker?.recoverExpiredLeases) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, orchestrationWorker.recoverExpiredLeases({
        now: body.now ?? undefined
      }));
    }
    if (request.method === 'GET' && path === '/worker/timeouts') {
      if (!orchestrationWorker?.timeoutSchedulerStatus) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.timeoutSchedulerStatus());
    }
    if (request.method === 'POST' && path === '/worker/state-product-gate') {
      if (!orchestrationWorker?.workerStateMachineProductGate) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, orchestrationWorker.workerStateMachineProductGate({ now: body.now ?? undefined }));
    }
    if (request.method === 'GET' && path === '/worker/daemon') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.READ_DIAGNOSTICS,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      if (!daemon?.status) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_DAEMON_UNAVAILABLE' } });
      }
      return sendJson(response, 200, daemon.status());
    }
    if (request.method === 'POST' && path === '/worker/daemon/start') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      if (!daemon?.start) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_DAEMON_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, daemon.start({ reason: body.reason ?? 'api-start' }));
    }
    if (request.method === 'POST' && path === '/worker/daemon/stop') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      if (!daemon?.stop) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_DAEMON_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, daemon.stop({ reason: body.reason ?? 'api-stop' }));
    }
    if (request.method === 'POST' && path === '/worker/daemon/tick') {
      const guard = requireAdmin(request, adminAuthProvider, {
        requiredScope: CoreAdminScope.CONTROL_WORKER_DAEMON,
        route: path
      });
      if (!guard.allowed) return sendJson(response, adminStatusCode(guard), guard);
      if (!daemon?.tick) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_DAEMON_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, await daemon.tick({
        reason: body.reason ?? 'api-tick',
        drainLimit: body.drainLimit ?? undefined,
        recoverLeases: body.recoverLeases ?? undefined
      }));
    }
    const compensationRunParams = routeParams('/tasks/:taskId/compensation/run', path);
    if (request.method === 'POST' && compensationRunParams) {
      if (!orchestrationWorker?.runCompensation) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      const body = await readJsonBody(request);
      return sendJson(response, 200, await orchestrationWorker.runCompensation(compensationRunParams.taskId, body));
    }
    const planArtifactParams = routeParams('/tasks/:taskId/plan-artifacts', path);
    if (request.method === 'GET' && planArtifactParams) {
      if (!orchestrationWorker?.exportNodeArtifactBundles) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.exportNodeArtifactBundles(planArtifactParams.taskId));
    }
    const planProductGateParams = routeParams('/tasks/:taskId/plan-graph/product-gate', path);
    if (request.method === 'POST' && planProductGateParams) {
      if (!orchestrationWorker?.runPlanGraphProductGate) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.runPlanGraphProductGate(planProductGateParams.taskId));
    }
    if (request.method === 'GET' && path === '/worker/plan-artifacts') {
      if (!orchestrationWorker?.nodeArtifactRetentionStatus) {
        return sendJson(response, 503, { success: false, error: { code: 'A_WORKER_UNAVAILABLE' } });
      }
      return sendJson(response, 200, orchestrationWorker.nodeArtifactRetentionStatus());
    }
    const compensationParams = routeParams('/tasks/:taskId/compensation', path);
    if (request.method === 'POST' && compensationParams) {
      const body = await readJsonBody(request);
      return sendJson(response, 200, coreFacade.beginCompensation(compensationParams.taskId, body));
    }
    sendJson(response, 404, { success: false, error: { code: 'A_ROUTE_NOT_FOUND', path } });
  }));
}

function defaultCoreAdminTokenHashFromEnv(env) {
  const normalized = String(env.JARVIS_CORE_ADMIN_TOKEN_SHA256 ?? '').replace(/^sha256:/, '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function requireAdmin(request, authProvider, { requiredScope = CoreAdminScope.ADMIN, route = 'unknown' } = {}) {
  const token = bearerToken(request);
  return authProvider.verifyBearer(token, {
    requiredScope,
    route,
    method: request.method
  });
}

function adminStatusCode(guard) {
  return guard?.error?.code === 'A_ADMIN_SCOPE_DENIED' ? 403 : 401;
}

function adminDiagnostics(coreFacade) {
  return {
    taskCount: coreFacade.tasks.size,
    recentEvents: coreFacade.eventBus.recent(20),
    eventDelivery: coreFacade.eventBus.deliveryStatus?.() ?? null,
    skillMatrix: coreFacade.skillRouter.capabilityMatrix(),
    skillPluginRegistry: coreFacade.skillRouter.pluginRegistry(),
    skillCompatibilitySnapshot: coreFacade.skillRouter.compatibilitySnapshot({ label: 'admin-diagnostics', record: false }),
    contextTelemetry: coreFacade.contextBuilder?.desktopTelemetryReport?.() ?? null,
    contextProviderContract: coreFacade.contextBuilder?.desktopProviderContractStatus?.() ?? null,
    contractSchemas: coreFacade.contractRegistry.schemas()
  };
}

export function createCoreOpenApiSpec(coreFacade = new CoreFacade()) {
  const schemas = coreFacade.contractRegistry?.schemas?.().definitions ?? {};
  const errorEnvelope = {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' }
        }
      }
    }
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'JARVIS A Core API',
      version: '1.0.0'
    },
    servers: [{ url: 'http://127.0.0.1:4071' }],
    paths: {
      '/health': {
        get: {
          operationId: 'getCoreHealth',
          responses: {
            200: { description: 'Core runtime health.' }
          }
        }
      },
      '/openapi.json': {
        get: {
          operationId: 'getCoreOpenApiSpec',
          responses: {
            200: { description: 'OpenAPI 3.1 contract for A Core API.' }
          }
        }
      },
      '/tasks': {
        get: {
          operationId: 'listCoreTasks',
          responses: {
            200: {
              description: 'Task summaries.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: { type: 'array', items: { $ref: '#/components/schemas/CoreTaskSummary' } }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          operationId: 'createCoreTask',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rawText: { type: 'string' },
                    command: { type: 'string' },
                    options: { type: 'object' }
                  }
                }
              }
            }
          },
          responses: {
            201: { description: 'Created task detail.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CoreTaskDetail' } } } },
            400: { description: 'Invalid request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}': {
        get: {
          operationId: 'getCoreTask',
          parameters: [pathTaskIdParameter()],
          responses: {
            200: { description: 'Task detail.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CoreTaskDetail' } } } },
            404: { description: 'Task not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/approve': {
        post: {
          operationId: 'decideCoreApproval',
          parameters: [pathTaskIdParameter()],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    decision: { type: 'string', enum: Object.values(ApprovalDecision) },
                    deviceId: { type: 'string' },
                    editRequest: { type: 'object' },
                    responseText: { type: 'string' },
                    decidedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Approval decision result.' },
            404: { description: 'Task not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/run': {
        post: {
          operationId: 'runTaskThroughCoreWorker',
          parameters: [pathTaskIdParameter()],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    decision: { type: 'string', enum: Object.values(ApprovalDecision) },
                    approvalDecision: { $ref: '#/components/schemas/ApprovalDecision' },
                    userConfirmation: {
                      type: 'object',
                      properties: {
                        confirmed: { type: 'boolean' }
                      }
                    },
                    dryRun: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Worker completed the A-E-B-G-F run.' },
            409: { description: 'Worker could not complete the run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/queue': {
        post: {
          operationId: 'enqueueCoreWorkerTask',
          parameters: [pathTaskIdParameter()],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    options: {
                      type: 'object',
                      properties: {
                        maxAttempts: { type: 'integer', minimum: 1 },
                        baseBackoffMs: { type: 'integer', minimum: 0 },
                        timeoutMs: { type: 'integer', minimum: 0 }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            202: { description: 'Task was queued for Core worker drain.' },
            404: { description: 'Task not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/queue': {
        get: {
          operationId: 'getCoreWorkerQueue',
          responses: {
            200: { description: 'Core worker queue status.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/queue/drain': {
        post: {
          operationId: 'drainCoreWorkerQueue',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    limit: { type: 'integer', minimum: 1 }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Drain result for runnable Core worker queue items.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/leases': {
        get: {
          operationId: 'getCoreWorkerLeases',
          responses: {
            200: { description: 'Core worker task lease status.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/leases/recover': {
        post: {
          operationId: 'recoverCoreWorkerLeases',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    now: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Expired Core worker lease recovery result.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/timeouts': {
        get: {
          operationId: 'getCoreWorkerTimeoutScheduler',
          responses: {
            200: { description: 'Core worker timeout scheduler and persistence status.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/state-product-gate': {
        post: {
          operationId: 'runCoreWorkerStateProductGate',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    now: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'A-08 state machine, lease backend, heartbeat, and timeout scheduler product gate.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/resume': {
        get: {
          operationId: 'resumeCoreTask',
          parameters: [pathTaskIdParameter()],
          responses: {
            200: { description: 'Durable orchestration resume context.' }
          }
        }
      },
      '/tasks/{taskId}/compensation': {
        post: {
          operationId: 'beginCoreCompensation',
          parameters: [pathTaskIdParameter()],
          responses: {
            200: { description: 'Compensation plan and state transition result.' }
          }
        }
      },
      '/tasks/{taskId}/compensation/run': {
        post: {
          operationId: 'runCoreCompensationReplay',
          parameters: [pathTaskIdParameter()],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    failureBranchId: { type: 'string' },
                    targetNodeIds: { type: 'array', items: { type: 'string' } },
                    mode: { type: 'string' },
                    reason: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Node-level compensation replay result.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/plan-artifacts': {
        get: {
          operationId: 'exportCorePlanNodeArtifacts',
          parameters: [pathTaskIdParameter()],
          responses: {
            200: { description: 'Sanitized node artifact export for a plan graph run.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/tasks/{taskId}/plan-graph/product-gate': {
        post: {
          operationId: 'runCorePlanGraphProductGate',
          parameters: [pathTaskIdParameter()],
          responses: {
            200: { description: 'A-06 plan graph scheduler, artifact retention, compensation runner, and release dossier product gate.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/plan-artifacts': {
        get: {
          operationId: 'getCorePlanNodeArtifactRetentionStatus',
          responses: {
            200: { description: 'Plan node artifact retention status.' },
            503: { description: 'Worker unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/daemon': {
        get: {
          operationId: 'getCoreWorkerDaemon',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Core worker daemon status.' },
            503: { description: 'Worker daemon unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/daemon/start': {
        post: {
          operationId: 'startCoreWorkerDaemon',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Core worker daemon start result.' },
            503: { description: 'Worker daemon unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/daemon/stop': {
        post: {
          operationId: 'stopCoreWorkerDaemon',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Core worker daemon stop result.' },
            503: { description: 'Worker daemon unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/worker/daemon/tick': {
        post: {
          operationId: 'tickCoreWorkerDaemon',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Core worker daemon tick result.' },
            503: { description: 'Worker daemon unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/admin/diagnostics': {
        get: {
          operationId: 'getCoreAdminDiagnostics',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Admin diagnostics.' },
            401: { description: 'Admin token required.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      },
      '/runtime/supervisor': {
        get: {
          operationId: 'getCoreRuntimeSupervisor',
          responses: {
            200: { description: 'Core runtime supervisor status.' }
          }
        }
      },
      '/runtime/supervisor/tick': {
        post: {
          operationId: 'tickCoreRuntimeSupervisor',
          responses: {
            200: { description: 'Core runtime supervisor heartbeat result.' }
          }
        }
      },
      '/runtime/service-plan': {
        post: {
          operationId: 'createCoreServiceLifecyclePlan',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Core Windows service lifecycle plan and readiness report.' },
            401: { description: 'Admin token required.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
            403: { description: 'Admin scope denied.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer'
        }
      },
      schemas: {
        ...schemas,
        ErrorEnvelope: errorEnvelope,
        CoreTaskSummary: {
          type: 'object',
          required: ['taskId', 'status'],
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            title: { type: 'string' },
            actionType: { type: 'string' },
            toolName: { type: 'string' },
            approvalId: { type: 'string' },
            riskTier: { type: 'integer' }
          }
        },
        CoreTaskDetail: {
          allOf: [
            { $ref: '#/components/schemas/CoreTaskSummary' },
            {
              type: 'object',
              properties: {
                request: { $ref: '#/components/schemas/TaskRequest' },
                plan: { $ref: '#/components/schemas/TaskPlan' },
                approvalCard: { $ref: '#/components/schemas/ApprovalCard' },
                executionResult: { type: 'object' },
                executionVerification: { type: 'object' },
                learningResult: { type: 'object' },
                orchestrationTrace: { type: 'object' }
              }
            }
          ]
        }
      }
    }
  };
}

function pathTaskIdParameter() {
  return {
    name: 'taskId',
    in: 'path',
    required: true,
    schema: { type: 'string' }
  };
}

function taskSummary(task, { detail = false } = {}) {
  const base = {
    taskId: task.taskId,
    status: task.status,
    title: task.plan?.title,
    actionType: task.plan?.action?.actionType,
    toolName: task.plan?.action?.toolName,
    approvalId: task.approvalCard?.approvalId,
    riskTier: task.approvalCard?.riskTier
  };
  if (!detail) return base;
  return {
    ...base,
    request: task.request,
    ambiguity: task.ambiguity,
    plan: task.plan,
    policy: task.policy,
    approvalCard: task.approvalCard,
    executionResult: task.executionResult,
    executionVerification: task.executionVerification,
    learningResult: task.learningResult,
    lifecycle: task.lifecycle?.events ?? [],
    orchestrationTrace: task.orchestrationTrace
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const port = Number(process.env.PORT ?? 4071);
  const server = createCoreServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`JARVIS Core API listening on http://127.0.0.1:${port}`);
  });
}
