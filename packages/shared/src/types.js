export const ModuleId = Object.freeze({
  CORE: 'A_CORE',
  PC_AGENT: 'B_PC_AGENT',
  MOBILE: 'C_MOBILE',
  BRIDGE: 'D_BRIDGE',
  POLICY_SECURITY: 'E_POLICY_SECURITY',
  GROWTH_MEMORY: 'F_GROWTH_MEMORY',
  VERIFICATION: 'G_VERIFICATION'
});

export const TaskStatus = Object.freeze({
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  RETRYING: 'RETRYING',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED'
});

export const ApprovalDecision = Object.freeze({
  APPROVE: 'approve',
  EDIT: 'edit',
  REJECT: 'reject',
  RESPOND: 'respond'
});

export const ActionType = Object.freeze({
  CREATE_FILE: 'CREATE_FILE',
  LIST_FILES: 'LIST_FILES',
  COPY_FILE: 'COPY_FILE',
  MOVE_FILE: 'MOVE_FILE',
  BROWSER_SEARCH: 'BROWSER_SEARCH',
  UPLOAD_FILE: 'UPLOAD_FILE',
  DELETE_FILE: 'DELETE_FILE',
  MAKE_PAYMENT: 'MAKE_PAYMENT',
  CHANGE_SYSTEM_SETTING: 'CHANGE_SYSTEM_SETTING',
  READ_SECRET: 'READ_SECRET'
});

export const TrustBoundary = Object.freeze({
  USER_COMMAND: 'USER_COMMAND',
  SYSTEM_POLICY: 'SYSTEM_POLICY',
  LOCAL_FILE_CONTENT: 'LOCAL_FILE_CONTENT',
  WEB_CONTENT: 'WEB_CONTENT',
  EMAIL_CONTENT: 'EMAIL_CONTENT',
  PDF_CONTENT: 'PDF_CONTENT',
  TOOL_METADATA: 'TOOL_METADATA',
  MODEL_OUTPUT: 'MODEL_OUTPUT'
});

export const InputSource = Object.freeze({
  CLI: 'cli',
  PC_UI: 'pc_ui',
  MOBILE: 'mobile',
  VOICE: 'voice',
  TRIGGER: 'trigger',
  API: 'api'
});

export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

export function stableId(prefix, value, createdAt = nowIso()) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  return `${prefix}_${normalized || 'item'}_${Date.parse(createdAt).toString(36)}`;
}

export function createTaskRequest({
  rawText,
  deviceId = 'local_cli',
  inputMode = 'text',
  source = InputSource.MOBILE,
  sourceModule = ModuleId.MOBILE,
  userId = 'local_user',
  locale = 'ko-KR',
  attachments = [],
  metadata = {},
  createdAt = nowIso()
}) {
  return {
    requestId: stableId('req', rawText, createdAt),
    taskId: stableId('task', rawText, createdAt),
    createdAt,
    userId,
    source: {
      type: source,
      module: sourceModule,
      deviceId,
      inputMode
    },
    command: {
      rawText,
      locale
    },
    attachments,
    context: {
      userTimezone: 'Asia/Seoul'
    },
    metadata
  };
}

export function createIntentCandidate({
  intentId,
  label,
  actionType,
  category = 'local',
  confidence = 0,
  reasons = [],
  riskHint,
  slots = {},
  entities = {},
  missingSlots = [],
  complexity = {}
}) {
  return { intentId, label, actionType, category, confidence, reasons, riskHint, slots, entities, missingSlots, complexity };
}

export function createContextSnapshot({
  snapshotId,
  taskId,
  currentDirectory,
  createdAt = nowIso(),
  recentFiles = [],
  userPreferences = [],
  workflow = null,
  environment = {}
}) {
  return { snapshotId, taskId, currentDirectory, createdAt, recentFiles, userPreferences, workflow, environment };
}

export function createPolicyCheckRequest({ checkId, taskId, planId, action, contextSnapshot, createdAt = nowIso() }) {
  return { checkId, taskId, planId, action, contextSnapshot, createdAt };
}

export function createPlanStep({
  order,
  description,
  module = ModuleId.CORE,
  preconditions = [],
  postconditions = [],
  evidence = [],
  rollbackHint = null
}) {
  return { order, description, module, preconditions, postconditions, evidence, rollbackHint };
}

export function createTaskPlan({
  planId,
  taskId,
  title,
  interpretedIntent,
  action,
  planSteps,
  planGraph = null,
  failureBranches = [],
  compensationPlan = null,
  affectedItems = [],
  contextSnapshotId,
  route,
  policyCheckRequest,
  assumptions = [],
  riskNotes = [],
  planningGuardrails = [],
  guardrailAudit = null,
  replanOf = null,
  createdAt = nowIso()
}) {
  return {
    planId,
    taskId,
    title,
    interpretedIntent,
    action,
    planSteps,
    planGraph,
    failureBranches,
    compensationPlan,
    affectedItems,
    contextSnapshotId,
    route,
    policyCheckRequest,
    assumptions,
    riskNotes,
    planningGuardrails,
    guardrailAudit,
    replanOf,
    createdAt
  };
}

export function createCapabilityRequest({ requestId, taskId, planId, approvalId, action, constraints = {}, createdAt = nowIso() }) {
  return { requestId, taskId, planId, approvalId, action, constraints, createdAt };
}

export function createExecutionPacket({
  packetId,
  taskId,
  planId,
  action,
  capabilityToken,
  requestedMode = 'execute',
  userConfirmation,
  approvalDecision,
  traceId,
  createdAt = nowIso()
}) {
  return {
    packetId,
    taskId,
    planId,
    action,
    capabilityToken,
    requestedMode,
    userConfirmation: {
      approvalId: approvalDecision?.approvalId ?? userConfirmation?.approvalId,
      confirmed: Boolean(userConfirmation?.confirmed),
      confirmedAt: userConfirmation?.confirmedAt ?? createdAt
    },
    approvalDecision,
    traceId,
    createdAt
  };
}

export function createApprovalCard({
  approvalId,
  taskId,
  title,
  interpretedIntent,
  riskTier,
  planSteps,
  affectedItems = [],
  externalTransfer = false,
  irreversible = false,
  rollbackAvailable = true,
  warnings = [],
  clarificationRequest = null,
  createdAt = nowIso(),
  expiresAt
}) {
  return {
    approvalId,
    taskId,
    title,
    interpretedIntent,
    riskTier,
    planSteps,
    affectedItems,
    externalTransfer,
    irreversible,
    rollbackAvailable,
    warnings,
    clarificationRequest,
    choices: Object.values(ApprovalDecision),
    createdAt,
    expiresAt
  };
}

export function createApprovalDecision({ approvalId, taskId, decision, deviceId, sourceModule = ModuleId.MOBILE, editRequest, responseText, decidedAt = nowIso() }) {
  return {
    approvalId,
    taskId,
    decision,
    decidedAt,
    decidedBy: {
      deviceId,
      module: sourceModule
    },
    editRequest,
    responseText
  };
}

export function createClarificationRequest({
  clarificationId,
  taskId,
  question,
  choices = [],
  missingSlots = [],
  selectedIntentId = null,
  createdAt = nowIso()
}) {
  return { clarificationId, taskId, question, choices, missingSlots, selectedIntentId, createdAt };
}

export function createOrchestrationTrace({
  traceId,
  taskId,
  planId = null,
  status = 'started',
  steps = [],
  failures = [],
  createdAt = nowIso(),
  updatedAt = createdAt
}) {
  return { traceId, taskId, planId, status, steps, failures, createdAt, updatedAt };
}

export function createError(code, message, statusCode = 400) {
  return {
    success: false,
    statusCode,
    error: { code, message }
  };
}

export function maskSensitive(value) {
  if (Array.isArray(value)) {
    return value.map(maskSensitive);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/password|token|apiKey|secret|cookie|authorization|비밀번호|주민번호|계좌/i.test(key)) {
        return [key, '[masked]'];
      }
      return [key, maskSensitive(item)];
    })
  );
}
