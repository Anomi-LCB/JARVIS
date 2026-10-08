import { createHash } from 'node:crypto';
import { ActionType, ModuleId, TrustBoundary } from '../../../packages/shared/src/types.js';
import { LocalWorkflowToolAdapter } from '../../pc-agent/src/adapters/workflow/local-workflow-adapter.js';

export const LOCAL_WORKFLOW_VERIFIER_CONTRACT = Object.freeze({
  verifierId: 'g-local-workflow-proof-v1',
  invariants: Object.freeze([
    'workflow-identity',
    'positive-node-count',
    'receipt-cardinality',
    'receipt-identity-status-hash',
    'nonempty-manifest',
    'manifest-unique-path-sha256-and-size'
  ])
});
export const LOCAL_WORKFLOW_VERIFIER_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(LOCAL_WORKFLOW_VERIFIER_CONTRACT))
  .digest('hex');

export function verifyLocalWorkflowEvidence(evidence) {
  const workflow = evidence?.adapterEvidence?.workflow;
  const manifest = evidence?.adapterEvidence?.manifest;
  const reasons = [];
  if (!workflow || !workflow.workflowId || !/^[a-f0-9]{64}$/iu.test(String(workflow.specSha256 ?? ''))) reasons.push('workflow-identity-missing');
  if (!Number.isInteger(workflow?.nodeCount) || workflow.nodeCount < 1) reasons.push('workflow-node-count-missing');
  if (!Array.isArray(workflow?.receipts) || workflow.receipts.length !== workflow.nodeCount) reasons.push('workflow-receipts-incomplete');
  const receiptIds = new Set((workflow?.receipts ?? []).map((receipt) => String(receipt?.nodeId ?? '')));
  if ((workflow?.receipts ?? []).some((receipt) => typeof receipt?.nodeId !== 'string'
    || !receipt.nodeId
    || !['success', 'skipped'].includes(receipt?.status)
    || !/^[a-f0-9]{64}$/iu.test(String(receipt?.resultSha256 ?? '')))
    || receiptIds.size !== (workflow?.receipts ?? []).length) reasons.push('workflow-receipts-invalid');
  if (!Array.isArray(manifest) || manifest.length < 1) reasons.push('workflow-artifact-manifest-empty');
  const manifestPaths = new Set((manifest ?? []).map((item) => String(item?.path ?? '')));
  if ((manifest ?? []).some((item) => typeof item?.path !== 'string'
    || !item.path
    || !/^[a-f0-9]{64}$/iu.test(String(item?.sha256 ?? ''))
    || !Number.isInteger(item?.size)
    || item.size < 0)
    || manifestPaths.size !== (manifest ?? []).length) reasons.push('workflow-artifact-manifest-invalid');
  return { valid: reasons.length === 0, reasons };
}

Object.defineProperty(verifyLocalWorkflowEvidence, 'verifierFingerprint', {
  value: LOCAL_WORKFLOW_VERIFIER_FINGERPRINT
});

export function createLocalWorkflowCapabilityPackage() {
  return {
    packageId: 'jarvis.local-workflow',
    version: '1.1.0',
    skill: {
      skillId: 'local_workflow_execute_skill',
      version: '1.1.0',
      label: 'Verified Local Workflow Execute',
      module: ModuleId.PC_AGENT,
      category: 'workflow',
      actionType: ActionType.CREATE_FILE,
      toolName: 'workflow.execute',
      match: {
        workflows: ['typed-local-workflow'],
        outputFormats: ['json', 'csv', 'txt', 'db'],
        keywords: ['워크플로', 'workflow', '.workflow.json', '의존성 순서', '파이프라인']
      },
      capability: {
        readsLocalFiles: true,
        writesLocalFiles: true,
        externalNetwork: false,
        externalTransfer: false,
        reversible: true,
        requiresApproval: true,
        maxRiskTier: 4,
        allowedModes: ['shadow', 'execute']
      },
      safety: {
        trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
        dataClasses: ['workflow_spec', 'file_content', 'process_output'],
        blockedWhen: [
          'outsideAllowedRoots=true',
          'unregisteredOperation=true',
          'workflowCycle=true',
          'evidenceSchemaMissing=true'
        ]
      },
      adapterContract: {
        preview: true,
        execute: true,
        rollback: true,
        evidence: ['workflow', 'manifest']
      }
    },
    argumentSchema: {
      type: 'object',
      fields: ['specPath', 'spec', 'workspaceRoot', 'allowOverwrite', 'expectedSha256']
    },
    evidenceSchema: {
      required: [
        'outputPaths',
        'changedItems',
        'files',
        'undoJournalId',
        'adapterEvidence.workflow',
        'adapterEvidence.manifest'
      ],
      adapterEvidence: ['workflow', 'manifest']
    },
    verifierId: LOCAL_WORKFLOW_VERIFIER_CONTRACT.verifierId,
    verifierFingerprint: LOCAL_WORKFLOW_VERIFIER_FINGERPRINT,
    verifyEvidence: verifyLocalWorkflowEvidence,
    createAdapter({ allowedRoots, undoJournal, clock, processRunner } = {}) {
      return new LocalWorkflowToolAdapter({ allowedRoots, undoJournal, clock, processRunner });
    }
  };
}
