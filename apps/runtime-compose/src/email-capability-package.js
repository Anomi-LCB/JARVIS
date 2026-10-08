import { createHash } from 'node:crypto';
import { EmailSendToolAdapter } from '../../pc-agent/src/pc-agent-runtime.js';
import { defaultSkillManifest } from '../../../packages/core/src/routing/default-skill-manifest.js';
import { registerMissionArgumentSchema } from '../../../packages/core/src/planning/mission-action-arguments.js';

const contract = Object.freeze({ verifierId: 'g-email-smtp-acceptance-shape-v1',
  invariants: ['smtp-acceptance-identity', 'single-recipient', 'no-rejected-or-pending', 'effect-receipt-binding'] });
const fingerprint = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

// This checks the recorded provider-acceptance contract. It is not proof of inbox delivery.
export function verifyEmailAcceptanceEvidence(evidence) {
  const receipt = evidence?.adapterEvidence?.email, effects = evidence?.changedItems;
  const reasons = [];
  if (receipt?.verificationVersion !== 'b-email-smtp-acceptance-v1' || receipt.passed !== true
    || receipt.providerAccepted !== true || receipt.recipientMatched !== true
    || !['smtp-provider-envelope-and-data-acceptance', 'persistent-idempotency-ledger'].includes(receipt.method)) reasons.push('smtp-acceptance-invalid');
  if (receipt?.acceptedRecipientCount !== 1 || receipt.rejectedRecipientCount !== 0 || receipt.pendingRecipientCount !== 0)
    reasons.push('smtp-recipient-cardinality-invalid');
  if (receipt?.responseCode != null && (!Number.isInteger(receipt.responseCode) || Math.floor(receipt.responseCode / 100) !== 2))
    reasons.push('smtp-response-code-invalid');
  if (!Array.isArray(effects) || effects.length !== 1 || effects[0]?.type !== 'external_email_delivery'
    || effects[0].channel !== 'smtp' || effects[0].providerAccepted !== true || !hash(effects[0].recipientSha256)
    || !hash(effects[0].subjectSha256) || effects[0].providerMessageIdSha256 !== receipt?.providerMessageIdSha256
    || (receipt?.providerMessageIdSha256 != null && !hash(receipt.providerMessageIdSha256))
    || !Number.isInteger(effects[0].attachmentCount) || effects[0].attachmentCount < 0
    || !Array.isArray(effects[0].attachmentSha256s) || effects[0].attachmentSha256s.length !== effects[0].attachmentCount
    || effects[0].attachmentSha256s.some(value => !hash(value))) reasons.push('smtp-effect-receipt-mismatch');
  return { valid: reasons.length === 0, reasons };
}
Object.defineProperty(verifyEmailAcceptanceEvidence, 'verifierFingerprint', { value: fingerprint });

export function createEmailCapabilityPackage(adapter) {
  return { packageId: 'jarvis.email-smtp', version: '1.0.0',
    skill: structuredClone(defaultSkillManifest.find(skill => skill.toolName === 'email.send')),
    argumentSchema: { type: 'object', fields: ['to','recipientMode','subject','body','attachmentQuery','attachmentPath',
      'attachmentSha256','attachmentRef','attachments','idempotencyKey'] },
    evidenceSchema: { required: ['changedItems','adapterEvidence.email'], adapterEvidence: [] },
    verifierId: contract.verifierId, verifierFingerprint: fingerprint, verifyEvidence: verifyEmailAcceptanceEvidence,
    createAdapter: () => adapter };
}

/** Adopt only the reviewed built-in route, keeping its ledger/instance and rollback on activation failure. */
export function activateEmailCapability({ pcAgent, capabilityPackageRegistry, skillRouter }) {
  const tool = 'email.send', adapter = pcAgent.registry.get(tool);
  if (!(adapter instanceof EmailSendToolAdapter)) throw new Error('A_EMAIL_BUILTIN_ROUTE_REQUIRED');
  const definition = createEmailCapabilityPackage(adapter);
  const targets = { skillRouter, adapterRegistry: pcAgent.registry,
    evidenceSchemaRegistry: pcAgent.evidenceCollector.schemaRegistry, registerArgumentSchema: registerMissionArgumentSchema };
  if (capabilityPackageRegistry.activations.has(tool)) return capabilityPackageRegistry.activate(definition, targets);
  const existingSkill = skillRouter.skills.get(definition.skill.skillId);
  if (!existingSkill || existingSkill.toolName !== tool) throw new Error('A_EMAIL_BUILTIN_SKILL_REQUIRED');
  for (const key of ['version','module','category','actionType','match','capability','safety','adapterContract']) {
    if (canonical(existingSkill[key]) !== canonical(definition.skill[key])) throw new Error('A_EMAIL_CUSTOM_SKILL_PRESERVED');
  }
  const validation = capabilityPackageRegistry.validate(definition, { adapter, targets });
  if (!validation.valid) throw Object.assign(new Error('A_EMAIL_PACKAGE_INVALID'), { reasons: validation.errors });
  const containers = [[skillRouter,'skills'],[pcAgent.registry,'adapters'],[pcAgent.registry,'contracts'],
    [pcAgent.evidenceCollector.schemaRegistry,'schemas']];
  const snapshots = containers.map(([owner,key]) => new Map(owner[key]));
  try {
    skillRouter.skills.delete(definition.skill.skillId);
    pcAgent.registry.adapters.delete(tool); pcAgent.registry.contracts.delete(tool);
    return capabilityPackageRegistry.activate(definition, targets);
  } catch (error) {
    containers.forEach(([owner,key],index) => { owner[key].clear(); for (const [id,value] of snapshots[index]) owner[key].set(id,value); });
    throw error;
  }
}
