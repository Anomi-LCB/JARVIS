import { ApprovalDecision } from '../../../../packages/shared/src/types.js';
import { approvalExpiryState } from '../approval/approval-expiry.js';
import {
  createApprovalActionAccessibility,
  createApprovalActionVisualSnapshot
} from '../accessibility/approval-accessibility.js';

export function createApprovalActionState({ card, safety, approveReadiness } = {}) {
  const requiresPcConfirmation = safety?.requiresPcConfirmation === true;
  const sessionLocked = approveReadiness?.allowed === false;
  const expiry = safety?.expiry ?? approvalExpiryState(card);
  const expired = expiry.expired === true;
  const blockedReason = expired
    ? expiry.blockedReason
    : requiresPcConfirmation
      ? 'Tier 3 이상은 PC에서 직접 확인해야 합니다.'
      : sessionLocked
        ? '모바일 세션 잠금 해제가 필요합니다.'
        : null;
  const approveEnabled = !expired && !requiresPcConfirmation && !sessionLocked;
  const responseEnabled = !expired && !sessionLocked;
  const safetyFacts = {
    riskTier: card?.riskTier,
    mobileApprovalAllowed: safety?.mobileApprovalAllowed === true,
    requiresPcConfirmation,
    externalTransfer: safety?.externalTransfer === true,
    rollbackAvailable: safety?.rollbackAvailable === true,
    affectedItemCount: safety?.affectedItemCount ?? 0,
    expired,
    expiresAt: expiry.expiresAt
  };
  const primaryAction = {
    decision: ApprovalDecision.APPROVE,
    label: approveEnabled ? '승인' : expired ? '만료됨' : '승인 불가',
    enabled: approveEnabled,
    blockedReason
  };
  const pcHandoffAction = {
    action: 'request_pc_confirmation',
    label: 'PC 확인 요청',
    enabled: requiresPcConfirmation && !expired,
    blockedReason: requiresPcConfirmation
      ? expired
        ? blockedReason
        : null
      : '모바일 승인이 가능한 작업입니다.'
  };
  const secondaryActions = [
    {
      decision: ApprovalDecision.EDIT,
      label: '수정 요청',
      enabled: responseEnabled,
      blockedReason: responseEnabled ? null : blockedReason
    },
    {
      decision: ApprovalDecision.REJECT,
      label: '거절',
      enabled: !expired,
      blockedReason: expired ? blockedReason : null
    },
    {
      decision: ApprovalDecision.RESPOND,
      label: '질문 응답',
      enabled: responseEnabled,
      blockedReason: responseEnabled ? null : blockedReason
    }
  ];
  const actions = [primaryAction, ...secondaryActions];
  return {
    approvalId: card?.approvalId,
    taskId: card?.taskId,
    expiry,
    primaryAction: {
      ...primaryAction,
      accessibility: createApprovalActionAccessibility(primaryAction, { safetyFacts }),
      visualSnapshot: createApprovalActionVisualSnapshot(primaryAction, { safetyFacts })
    },
    pcHandoffAction: {
      ...pcHandoffAction,
      accessibility: createApprovalActionAccessibility(pcHandoffAction, { safetyFacts }),
      visualSnapshot: createApprovalActionVisualSnapshot(pcHandoffAction, { safetyFacts })
    },
    secondaryActions: secondaryActions.map((action) => ({
      ...action,
      accessibility: createApprovalActionAccessibility(action, { safetyFacts }),
      visualSnapshot: createApprovalActionVisualSnapshot(action, { safetyFacts })
    })),
    actionVisualSnapshot: actions.map((action) => createApprovalActionVisualSnapshot(action, { safetyFacts })),
    safetyFacts
  };
}

export function createApprovalDiffReviewState({ approvalDiff = null, card = null } = {}) {
  const diff = approvalDiff ?? card?.approvalDiff ?? card?.shadow?.approvalDiff ?? null;
  const affectedPaths = diff?.affectedPaths ?? [];
  const warningCount = diff?.warnings?.length ?? 0;
  const conflictCount = diff?.conflictCount ?? 0;
  const expectedChangesCount = diff?.expectedChangesCount ?? 0;
  const readOnly = diff?.readOnly === true;
  const severity = diff?.severity ?? (conflictCount > 0 ? 'conflict' : warningCount > 0 ? 'warning' : readOnly ? 'read_only' : 'approval_required');
  return {
    stateVersion: 'c-approval-diff-review-ui-v1',
    approvalId: card?.approvalId ?? null,
    taskId: card?.taskId ?? null,
    available: Boolean(diff),
    diffVersion: diff?.diffVersion ?? null,
    severity,
    tone: severity === 'conflict' ? 'danger' : severity === 'warning' ? 'warning' : readOnly ? 'neutral' : 'approval',
    summary: diff?.summary ?? '승인 전 변경 미리보기가 없습니다.',
    readOnly,
    requiresUserApproval: diff?.requiresUserApproval === true,
    safeToAutoApprove: diff?.safeToAutoApprove === true,
    expectedChangesCount,
    conflictCount,
    warningCount,
    affectedPaths,
    affectedPathPreview: affectedPaths.slice(0, 5).map((path) => ({
      path,
      label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      kind: inferAffectedPathKind(path)
    })),
    warnings: diff?.warnings ?? [],
    actions: [
      {
        actionKey: 'approve_with_diff',
        label: readOnly ? '확인' : '변경 승인',
        enabled: Boolean(diff) && conflictCount === 0,
        blockedReason: conflictCount > 0 ? '충돌을 먼저 해결해야 합니다.' : null
      },
      {
        actionKey: 'request_edit_from_diff',
        label: '수정 요청',
        enabled: Boolean(diff),
        blockedReason: null
      }
    ]
  };
}

function inferAffectedPathKind(path) {
  const text = String(path ?? '').toLowerCase();
  if (text.endsWith('.xlsx')) return 'workbook';
  if (text.endsWith('.txt') || text.endsWith('.md')) return 'document';
  if (text.includes('://')) return 'url';
  return 'file';
}
