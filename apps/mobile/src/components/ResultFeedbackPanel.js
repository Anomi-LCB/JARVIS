export function createResultFeedbackState({
  result,
  feedbackText = '',
  pending = false,
  error = null,
  lastSubmittedAt = null,
  rollbackConfirmation = null,
  rollbackProof = null,
  fileAction = null
} = {}) {
  const status = result?.verification?.status ?? result?.verificationStatus ?? 'not_required';
  const executionResult = result?.executionResult ?? result;
  const outputPaths = executionResult?.outputPaths ?? [];
  const rollbackAvailable = executionResult?.rollbackAvailable === true;
  const text = String(feedbackText ?? '').trim();
  const feedbackError = error ?? result?.feedbackError ?? null;
  const filePreviews = outputPaths.map((path, index) => createResultFilePreview(path, index, fileAction));
  const confirmation = createRollbackConfirmationState({
    result: executionResult,
    pending,
    confirmation: rollbackConfirmation
  });
  return {
    status: executionResult?.status ?? result?.status ?? 'unknown',
    verificationStatus: status,
    outputPaths,
    filePreviews,
    rollbackAvailable,
    rollbackAction: {
      label: '되돌리기',
      enabled: rollbackAvailable && pending !== true,
      requiresConfirmation: true,
      disabledReason: rollbackAvailable ? null : 'rollback-not-available',
      confirmation,
      proofModal: rollbackProof ? createRollbackProofModalState({ result: executionResult, rollback: rollbackProof }) : null
    },
    feedbackText: text,
    submission: {
      pending,
      error: feedbackError,
      lastSubmittedAt
    },
    feedbackActions: [
      { feedbackType: 'result_good', label: '좋아요', enabled: pending !== true },
      { feedbackType: 'needs_edit', label: '수정 필요', enabled: pending !== true && text.length > 0 },
      { feedbackType: 'rerun_requested', label: '다시 실행', enabled: pending !== true },
      { feedbackType: 'do_not_remember', label: '기억하지 않기', enabled: pending !== true }
    ],
    growthReviewAction: {
      label: '성장 리뷰',
      enabled: pending !== true,
      nextRoute: 'GrowthReviewScreen'
    }
  };
}

export function createResultFilePreview(path, index = 0, fileAction = null) {
  const value = String(path ?? '');
  const name = value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  const previewId = `file_preview_${index + 1}`;
  const uri = createResultFileUri(value);
  const previewType = extension === 'xlsx'
    ? 'spreadsheet'
    : ['txt', 'md', 'csv', 'json', 'log'].includes(extension)
      ? 'text'
      : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)
        ? 'image'
        : extension === 'pdf'
          ? 'pdf'
          : 'file';
  const mimeType = mimeTypeForExtension(extension);
  const lastAction = fileAction?.previewId === previewId ? fileAction : null;
  return {
    previewId,
    path: value,
    uri,
    name,
    extension,
    mimeType,
    openable: value.length > 0,
    shareable: value.length > 0,
    previewType,
    actions: {
      preview: {
        actionId: `${previewId}:preview`,
        label: '미리보기',
        enabled: value.length > 0,
        nativeAdapter: 'react-native-linking',
        expectedNativeMethod: 'Linking.openURL',
        uri,
        fallbackMode: 'path-visible'
      },
      share: {
        actionId: `${previewId}:share`,
        label: '공유',
        enabled: value.length > 0,
        nativeAdapter: 'expo-sharing',
        expectedNativeMethod: 'Sharing.shareAsync',
        uri,
        mimeType,
        fallbackMode: 'path-visible'
      }
    },
    lastAction
  };
}

export function createResultFileUri(path) {
  const value = String(path ?? '').trim();
  if (!value) return '';
  if (/^(file|content|http|https):\/\//i.test(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

export function mimeTypeForExtension(extension) {
  const ext = String(extension ?? '').toLowerCase();
  const map = {
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    json: 'application/json',
    log: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    txt: 'text/plain',
    webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return map[ext] ?? 'application/octet-stream';
}

export function createRollbackConfirmationState({
  result,
  pending = false,
  confirmation = null
} = {}) {
  const rollbackAvailable = result?.rollbackAvailable === true;
  const changedItems = result?.changedItems ?? [];
  const outputPaths = result?.outputPaths ?? [];
  const visible = confirmation?.visible === true;
  const confirmed = confirmation?.confirmed === true;
  return {
    confirmationVersion: 'c-result-rollback-confirmation-v1',
    visible,
    confirmed,
    pending: pending === true || confirmation?.pending === true,
    title: '되돌리기 확인',
    body: rollbackAvailable
      ? 'B의 rollback 증거를 확인하고 산출물 변경을 되돌립니다.'
      : '이 결과는 모바일에서 되돌릴 수 없습니다.',
    affectedItemCount: changedItems.length,
    outputPathCount: outputPaths.length,
    primaryAction: {
      label: '되돌리기 실행',
      enabled: rollbackAvailable && visible && pending !== true
    },
    cancelAction: {
      label: '취소',
      enabled: pending !== true
    },
    blockedReason: rollbackAvailable ? null : 'rollback-not-available'
  };
}

export function createRollbackProofModalState({ result, rollback, visible = true } = {}) {
  const transaction = rollback?.transaction ?? null;
  const rolledBack = rollback?.rolledBack ?? [];
  const skipped = rollback?.skipped ?? [];
  return {
    modalVersion: 'c-result-rollback-proof-modal-v1',
    visible,
    taskId: rollback?.taskId ?? result?.taskId ?? null,
    status: rollback?.success === true ? 'verified' : 'needs_review',
    title: '되돌림 증거',
    transactionId: transaction?.transactionId ?? null,
    transactionStatus: transaction?.status ?? null,
    rolledBackCount: rolledBack.length,
    skippedCount: skipped.length,
    undoJournalVerified: rollback?.plan?.dryRun === true || transaction?.status?.startsWith?.('completed') === true,
    proofRows: [
      ...rolledBack.map((item, index) => ({
        rowId: `rolled_back_${index + 1}`,
        status: 'rolled_back',
        path: item.path ?? item.outputPath ?? item.undoJournalId ?? null,
        action: item.action ?? item.changeType ?? 'rollback'
      })),
      ...skipped.map((item, index) => ({
        rowId: `skipped_${index + 1}`,
        status: 'skipped',
        path: item.path ?? item.outputPath ?? item.undoJournalId ?? null,
        reason: item.reason ?? 'manual-review'
      }))
    ],
    closeAction: {
      label: '확인',
      enabled: true
    }
  };
}
