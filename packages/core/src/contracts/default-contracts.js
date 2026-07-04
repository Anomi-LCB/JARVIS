import { ActionType, ApprovalDecision, InputSource, ModuleId, TrustBoundary } from '../../../shared/src/types.js';
import { ContractRegistry } from './contract-registry.js';

function ok() {
  return { valid: true, errors: [] };
}

function fail(errors) {
  return { valid: false, errors };
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function collect(checks) {
  const errors = checks.filter((check) => !check.pass).map((check) => check.message);
  return errors.length ? fail(errors) : ok();
}

const isoDateSchema = { type: 'string', format: 'date-time' };
const actionTypeSchema = { enum: Object.values(ActionType) };

export const TaskRequestSchema = {
  type: 'object',
  required: ['requestId', 'taskId', 'createdAt', 'source', 'command', 'attachments'],
  additionalProperties: true,
  properties: {
    requestId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    createdAt: isoDateSchema,
    userId: { type: 'string' },
    source: {
      type: 'object',
      required: ['type', 'module', 'deviceId', 'inputMode'],
      properties: {
        type: { enum: Object.values(InputSource) },
        module: { enum: Object.values(ModuleId) },
        deviceId: { type: 'string', minLength: 1 },
        inputMode: { enum: ['text', 'voice', 'file', 'image'] }
      }
    },
    command: {
      type: 'object',
      required: ['rawText', 'locale'],
      properties: {
        rawText: { type: 'string', minLength: 1 },
        locale: { enum: ['ko-KR', 'en-US'] }
      }
    },
    attachments: { type: 'array' }
  }
};

export const TaskPlanSchema = {
  type: 'object',
  required: ['planId', 'taskId', 'title', 'interpretedIntent', 'action', 'planSteps', 'affectedItems', 'contextSnapshotId', 'createdAt'],
  additionalProperties: true,
  properties: {
    planId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    interpretedIntent: { type: 'string', minLength: 1 },
    action: {
      type: 'object',
      required: ['actionType', 'skillId', 'toolName'],
      properties: {
        actionType: actionTypeSchema,
        skillId: { type: 'string', minLength: 1 },
        toolName: { type: 'string', minLength: 1 },
        arguments: { type: 'object' }
      }
    },
    planSteps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['order', 'description'],
        properties: {
          order: { type: 'integer' },
          description: { type: 'string', minLength: 1 },
          preconditions: { type: 'array' },
          postconditions: { type: 'array' }
        }
      }
    },
    planGraph: { type: ['object', 'null'] },
    failureBranches: { type: 'array' },
    compensationPlan: { type: ['object', 'null'] },
    affectedItems: { type: 'array' },
    contextSnapshotId: { type: 'string', minLength: 1 },
    createdAt: isoDateSchema
  }
};

export const ApprovalCardSchema = {
  type: 'object',
  required: ['approvalId', 'taskId', 'title', 'interpretedIntent', 'riskTier', 'planSteps', 'affectedItems', 'externalTransfer', 'irreversible', 'rollbackAvailable', 'choices', 'createdAt', 'expiresAt'],
  additionalProperties: true,
  properties: {
    approvalId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    interpretedIntent: { type: 'string', minLength: 1 },
    riskTier: { type: 'integer', minimum: 1, maximum: 5 },
    planSteps: { type: 'array', minItems: 1 },
    affectedItems: { type: 'array' },
    externalTransfer: { type: 'boolean' },
    irreversible: { type: 'boolean' },
    rollbackAvailable: { type: 'boolean' },
    choices: { type: 'array', minItems: 4, items: { enum: Object.values(ApprovalDecision) } },
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema
  }
};

export const ExecutionPacketSchema = {
  type: 'object',
  required: ['packetId', 'taskId', 'planId', 'action', 'capabilityToken', 'userConfirmation', 'createdAt'],
  additionalProperties: true,
  properties: {
    packetId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    planId: { type: 'string', minLength: 1 },
    action: {
      type: 'object',
      required: ['actionType', 'toolName', 'skillId', 'arguments'],
      properties: {
        actionType: actionTypeSchema,
        toolName: { type: 'string', minLength: 1 },
        skillId: { type: 'string', minLength: 1 },
        arguments: { type: 'object' }
      }
    },
    capabilityToken: {
      type: 'object',
      required: ['tokenId'],
      properties: { tokenId: { type: 'string', minLength: 1 } }
    },
    userConfirmation: {
      type: 'object',
      required: ['confirmed'],
      properties: { confirmed: { type: 'boolean' }, confirmedAt: isoDateSchema }
    },
    createdAt: isoDateSchema
  }
};

export const TaskRequestContract = {
  schema: TaskRequestSchema,
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.requestId), message: 'TaskRequest.requestId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'TaskRequest.taskId is required.' },
      { pass: isIsoDate(value?.createdAt), message: 'TaskRequest.createdAt must be an ISO date.' },
      { pass: Object.values(InputSource).includes(value?.source?.type), message: 'TaskRequest.source.type is invalid.' },
      { pass: Object.values(ModuleId).includes(value?.source?.module), message: 'TaskRequest.source.module is invalid.' },
      { pass: isNonEmptyString(value?.source?.deviceId), message: 'TaskRequest.source.deviceId is required.' },
      { pass: ['text', 'voice', 'file', 'image'].includes(value?.source?.inputMode), message: 'TaskRequest.source.inputMode is invalid.' },
      { pass: isNonEmptyString(value?.command?.rawText), message: 'TaskRequest.command.rawText is required.' },
      { pass: ['ko-KR', 'en-US'].includes(value?.command?.locale), message: 'TaskRequest.command.locale is invalid.' },
      { pass: Array.isArray(value?.attachments), message: 'TaskRequest.attachments must be an array.' }
    ]);
  }
};

export const IntentCandidateContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.intentId), message: 'IntentCandidate.intentId is required.' },
      { pass: isNonEmptyString(value?.label), message: 'IntentCandidate.label is required.' },
      { pass: Object.values(ActionType).includes(value?.actionType), message: 'IntentCandidate.actionType is invalid.' },
      { pass: typeof value?.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1, message: 'IntentCandidate.confidence must be 0..1.' },
      { pass: Array.isArray(value?.reasons), message: 'IntentCandidate.reasons must be an array.' }
    ]);
  }
};

export const AmbiguitySetContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.ambiguityId), message: 'AmbiguitySet.ambiguityId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'AmbiguitySet.taskId is required.' },
      { pass: isBoolean(value?.ambiguous), message: 'AmbiguitySet.ambiguous must be boolean.' },
      { pass: Array.isArray(value?.alternatives) && value.alternatives.length > 0 && value.alternatives.length <= 3, message: 'AmbiguitySet.alternatives must contain 1..3 candidates.' },
      { pass: isIsoDate(value?.createdAt), message: 'AmbiguitySet.createdAt must be an ISO date.' }
    ]);
  }
};

export const ContextSnapshotContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.snapshotId), message: 'ContextSnapshot.snapshotId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'ContextSnapshot.taskId is required.' },
      { pass: isNonEmptyString(value?.currentDirectory), message: 'ContextSnapshot.currentDirectory is required.' },
      { pass: isIsoDate(value?.createdAt), message: 'ContextSnapshot.createdAt must be an ISO date.' },
      { pass: Array.isArray(value?.recentFiles), message: 'ContextSnapshot.recentFiles must be an array.' },
      { pass: value?.recentFiles?.every?.((item) => isNonEmptyString(item.name) && isNonEmptyString(item.path) && typeof item.sizeBytes === 'number' && isIsoDate(item.modifiedAt)), message: 'ContextSnapshot.recentFiles must contain metadata-only file entries.' },
      { pass: Array.isArray(value?.userPreferences), message: 'ContextSnapshot.userPreferences must be an array.' },
      { pass: value?.workflow && typeof value.workflow === 'object', message: 'ContextSnapshot.workflow is required.' },
      { pass: value?.environment && typeof value.environment === 'object', message: 'ContextSnapshot.environment is required.' },
      { pass: value?.environment?.workspace?.contentRead === false, message: 'ContextSnapshot.environment.workspace.contentRead must be false.' },
      { pass: value?.environment?.redaction?.externalEnvironmentMasked === true, message: 'ContextSnapshot.environment.redaction.externalEnvironmentMasked must be true.' },
      { pass: value?.environment?.desktop === undefined || value.environment.desktop.rawContentStored === false, message: 'ContextSnapshot.environment.desktop.rawContentStored must be false.' },
      { pass: value?.environment?.desktop === undefined || value.environment.desktop.contentRead !== true || value.environment.desktop.approval?.approved === true, message: 'ContextSnapshot.environment.desktop.contentRead requires approved desktop context.' }
    ]);
  }
};

export const TaskPlanContract = {
  schema: TaskPlanSchema,
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.planId), message: 'TaskPlan.planId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'TaskPlan.taskId is required.' },
      { pass: isNonEmptyString(value?.title), message: 'TaskPlan.title is required.' },
      { pass: isNonEmptyString(value?.interpretedIntent), message: 'TaskPlan.interpretedIntent is required.' },
      { pass: Object.values(ActionType).includes(value?.action?.actionType), message: 'TaskPlan.action.actionType is invalid.' },
      { pass: isNonEmptyString(value?.action?.skillId), message: 'TaskPlan.action.skillId is required.' },
      { pass: isNonEmptyString(value?.action?.toolName), message: 'TaskPlan.action.toolName is required.' },
      { pass: Array.isArray(value?.planSteps) && value.planSteps.every((step) => Number.isInteger(step.order) && isNonEmptyString(step.description)), message: 'TaskPlan.planSteps must be structured PlanStep items.' },
      { pass: Array.isArray(value?.affectedItems), message: 'TaskPlan.affectedItems must be an array.' },
      { pass: isNonEmptyString(value?.contextSnapshotId), message: 'TaskPlan.contextSnapshotId is required.' },
      { pass: isIsoDate(value?.createdAt), message: 'TaskPlan.createdAt must be an ISO date.' }
    ]);
  }
};

export const PolicyCheckRequestContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.checkId), message: 'PolicyCheckRequest.checkId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'PolicyCheckRequest.taskId is required.' },
      { pass: isNonEmptyString(value?.planId), message: 'PolicyCheckRequest.planId is required.' },
      { pass: Object.values(ActionType).includes(value?.action?.actionType), message: 'PolicyCheckRequest.action.actionType is invalid.' },
      { pass: value?.contextSnapshot && typeof value.contextSnapshot === 'object', message: 'PolicyCheckRequest.contextSnapshot is required.' },
      { pass: isIsoDate(value?.createdAt), message: 'PolicyCheckRequest.createdAt must be an ISO date.' }
    ]);
  }
};

export const CapabilityRequestContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.requestId), message: 'CapabilityRequest.requestId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'CapabilityRequest.taskId is required.' },
      { pass: isNonEmptyString(value?.planId), message: 'CapabilityRequest.planId is required.' },
      { pass: isNonEmptyString(value?.approvalId), message: 'CapabilityRequest.approvalId is required.' },
      { pass: Object.values(ActionType).includes(value?.action?.actionType), message: 'CapabilityRequest.action.actionType is invalid.' },
      { pass: isIsoDate(value?.createdAt), message: 'CapabilityRequest.createdAt must be an ISO date.' }
    ]);
  }
};

export const ApprovalCardContract = {
  schema: ApprovalCardSchema,
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.approvalId), message: 'ApprovalCard.approvalId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'ApprovalCard.taskId is required.' },
      { pass: isNonEmptyString(value?.title), message: 'ApprovalCard.title is required.' },
      { pass: isNonEmptyString(value?.interpretedIntent), message: 'ApprovalCard.interpretedIntent is required.' },
      { pass: Number.isInteger(value?.riskTier) && value.riskTier >= 1 && value.riskTier <= 5, message: 'ApprovalCard.riskTier must be 1..5.' },
      { pass: Array.isArray(value?.planSteps) && value.planSteps.length > 0, message: 'ApprovalCard.planSteps must not be empty.' },
      { pass: Array.isArray(value?.affectedItems), message: 'ApprovalCard.affectedItems must be an array.' },
      { pass: isBoolean(value?.externalTransfer), message: 'ApprovalCard.externalTransfer must be boolean.' },
      { pass: isBoolean(value?.irreversible), message: 'ApprovalCard.irreversible must be boolean.' },
      { pass: isBoolean(value?.rollbackAvailable), message: 'ApprovalCard.rollbackAvailable must be boolean.' },
      { pass: Array.isArray(value?.choices) && value.choices.length >= 4, message: 'ApprovalCard.choices must include approval actions.' },
      { pass: isIsoDate(value?.createdAt), message: 'ApprovalCard.createdAt must be an ISO date.' },
      { pass: isIsoDate(value?.expiresAt), message: 'ApprovalCard.expiresAt must be an ISO date.' }
    ]);
  }
};

export const ApprovalDecisionContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.approvalId), message: 'ApprovalDecision.approvalId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'ApprovalDecision.taskId is required.' },
      { pass: Object.values(ApprovalDecision).includes(value?.decision), message: 'ApprovalDecision.decision is invalid.' },
      { pass: isIsoDate(value?.decidedAt), message: 'ApprovalDecision.decidedAt must be an ISO date.' },
      { pass: [ModuleId.MOBILE, ModuleId.CORE, ModuleId.PC_AGENT].includes(value?.decidedBy?.module), message: 'ApprovalDecision.decidedBy.module must be C_MOBILE, A_CORE, or B_PC_AGENT.' },
      { pass: isNonEmptyString(value?.decidedBy?.deviceId), message: 'ApprovalDecision.decidedBy.deviceId is required.' }
    ]);
  }
};

export const ExecutionPacketContract = {
  schema: ExecutionPacketSchema,
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.packetId), message: 'ExecutionPacket.packetId is required.' },
      { pass: isNonEmptyString(value?.taskId), message: 'ExecutionPacket.taskId is required.' },
      { pass: Object.values(ActionType).includes(value?.action?.actionType), message: 'ExecutionPacket.action.actionType is invalid.' },
      { pass: isNonEmptyString(value?.action?.toolName), message: 'ExecutionPacket.action.toolName is required.' },
      { pass: isNonEmptyString(value?.action?.skillId), message: 'ExecutionPacket.action.skillId is required.' },
      { pass: value?.action?.arguments && typeof value.action.arguments === 'object', message: 'ExecutionPacket.action.arguments is required.' },
      { pass: isNonEmptyString(value?.capabilityToken?.tokenId), message: 'ExecutionPacket.capabilityToken.tokenId is required.' },
      { pass: isBoolean(value?.userConfirmation?.confirmed), message: 'ExecutionPacket.userConfirmation.confirmed must be boolean.' }
    ]);
  }
};

export const SkillManifestContract = {
  validate(value) {
    return collect([
      { pass: isNonEmptyString(value?.skillId), message: 'SkillManifest.skillId is required.' },
      { pass: /^\d+\.\d+\.\d+$/.test(value?.version ?? ''), message: 'SkillManifest.version must be semver.' },
      { pass: isNonEmptyString(value?.label), message: 'SkillManifest.label is required.' },
      { pass: Object.values(ModuleId).includes(value?.module), message: 'SkillManifest.module is invalid.' },
      { pass: Object.values(ActionType).includes(value?.actionType), message: 'SkillManifest.actionType is invalid.' },
      { pass: isNonEmptyString(value?.toolName), message: 'SkillManifest.toolName is required.' },
      { pass: value?.capability && typeof value.capability === 'object', message: 'SkillManifest.capability is required.' },
      { pass: Array.isArray(value?.capability?.allowedModes) && value.capability.allowedModes.length > 0, message: 'SkillManifest.capability.allowedModes is required.' },
      { pass: isBoolean(value?.capability?.requiresApproval), message: 'SkillManifest.capability.requiresApproval must be boolean.' },
      { pass: isBoolean(value?.capability?.externalTransfer), message: 'SkillManifest.capability.externalTransfer must be boolean.' },
      { pass: Object.values(TrustBoundary).includes(value?.safety?.trustBoundary), message: 'SkillManifest.safety.trustBoundary is invalid.' },
      { pass: value?.adapterContract && typeof value.adapterContract === 'object', message: 'SkillManifest.adapterContract is required.' }
    ]);
  }
};

export function createDefaultContractRegistry() {
  const registry = new ContractRegistry();
  registry.register('TaskRequest', TaskRequestContract);
  registry.register('IntentCandidate', IntentCandidateContract);
  registry.register('AmbiguitySet', AmbiguitySetContract);
  registry.register('ContextSnapshot', ContextSnapshotContract);
  registry.register('TaskPlan', TaskPlanContract);
  registry.register('PolicyCheckRequest', PolicyCheckRequestContract);
  registry.register('CapabilityRequest', CapabilityRequestContract);
  registry.register('ApprovalCard', ApprovalCardContract);
  registry.register('ApprovalDecision', ApprovalDecisionContract);
  registry.register('ExecutionPacket', ExecutionPacketContract);
  registry.register('SkillManifest', SkillManifestContract);
  return registry;
}
