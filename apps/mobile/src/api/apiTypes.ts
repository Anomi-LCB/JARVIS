export type AttachmentRef = {
  attachmentId: string;
  name: string;
  mimeType: string;
  uri?: string;
};

export type TaskRequest = {
  requestId: string;
  createdAt: string;
  source: {
    module: 'C_MOBILE';
    deviceId: string;
    inputMode: 'text' | 'voice' | 'file' | 'image';
  };
  command: {
    rawText: string;
    locale: 'ko-KR';
    attachments?: AttachmentRef[];
  };
  context?: {
    currentScreen?: string;
    userTimezone: string;
  };
};

export type AffectedItem = {
  type: string;
  path?: string;
  label?: string;
};

export type ApprovalCard = {
  approvalId: string;
  taskId: string;
  title: string;
  interpretedIntent: string;
  riskTier: 1 | 2 | 3 | 4 | 5;
  planSteps: string[];
  affectedItems: AffectedItem[];
  externalTransfer: boolean;
  irreversible: boolean;
  rollbackAvailable: boolean;
  estimatedRuntimeMs?: number;
  warnings: string[];
  choices: ApprovalDecision['decision'][];
  expiresAt?: string;
  status?: 'pending' | 'expired' | 'approved' | 'rejected' | 'edited' | 'responded' | 'cancelled';
};

export type ApprovalDecision = {
  approvalId: string;
  taskId: string;
  decision: 'approve' | 'edit' | 'reject' | 'respond';
  decidedAt: string;
  decidedBy: {
    deviceId: string;
    module: 'C_MOBILE';
  };
  editRequest?: string;
  responseText?: string;
};

export type ApprovalHistoryItem = {
  eventId: string;
  approvalId: string;
  taskId: string | null;
  eventType: string;
  label: string;
  status: string | null;
  actor: string | null;
  detail?: string | null;
  reason?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type ApprovalHistoryView = {
  approvalId: string;
  taskId: string | null;
  items: ApprovalHistoryItem[];
};

export type ApprovalPcConfirmationHandoff = {
  success: true;
  handoffId: string;
  type: 'approval_pc_confirmation';
  approvalId: string;
  taskId: string;
  status: 'awaiting_pc_confirmation';
  reason: string;
  requestedBy: {
    module: 'C_MOBILE';
    deviceId: string;
  };
  createdAt: string;
  expiresAt: string | null;
  requiresPcConfirmation: true;
  instructions: string[];
};

export type TaskStatus = {
  taskId: string;
  status:
    | 'CREATED'
    | 'PLANNING'
    | 'WAITING_APPROVAL'
    | 'APPROVED'
    | 'EXECUTING'
    | 'VERIFYING'
    | 'COMPLETED'
    | 'FAILED'
    | 'BLOCKED'
    | 'CANCELLED';
  title: string;
  summary: string;
  updatedAt: string;
  progress?: {
    currentStep: string;
    stepIndex: number;
    totalSteps: number;
  };
};

export type ExecutionResultView = {
  taskId: string;
  status: 'success' | 'failed' | 'blocked' | 'rolled_back';
  summary: string;
  outputPaths: string[];
  changedItems: AffectedItem[];
  rollbackAvailable: boolean;
  blockedReason?: string;
  verificationStatus?: 'not_required' | 'pending' | 'passed' | 'failed';
};

export type PoisonQueueItem = {
  queueId: string;
  idempotencyKey?: string;
  taskId: string | null;
  packetId: string | null;
  toolName: string | null;
  status: 'quarantined' | 'ignored' | 'queued' | 'retry_scheduled' | 'running' | 'succeeded';
  attempts: number;
  queuedAt: string;
  nextAttemptAt: string;
  quarantinedAt?: string | null;
  requeuedAt?: string | null;
  ignoredAt?: string | null;
  reason?: string | null;
  error?: {
    code?: string;
    message?: string;
    errors?: string[];
  } | null;
  reviewStatus?: 'needs_review' | 'reviewed' | 'requeued' | 'ignored' | 'review_failed_validation' | string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
};

export type PoisonQueueView = {
  items: PoisonQueueItem[];
  queue: {
    total: number;
    queued: number;
    retryScheduled: number;
    running: number;
    succeeded: number;
    quarantined: number;
    ignored: number;
  };
};

export type QueueRetryPolicy = {
  maxAttempts: number;
  baseBackoffMs: number;
  queuePath?: string;
  updatedAt?: string | null;
};

export type OfflineCommandItem = {
  localId: string;
  rawText: string;
  createdAt: string;
  attachments: AttachmentRef[];
  syncStatus: 'pending' | 'sent' | 'cancelled';
};

export type MobileNotification = {
  notificationId: string;
  eventId?: string;
  eventType: string;
  title: string;
  body: string;
  taskId?: string;
  approvalId?: string;
  severity: 'info' | 'success' | 'warning';
  channelId: 'approvals' | 'execution' | 'security' | 'alerts' | 'general';
  read: boolean;
  createdAt: string;
  appState?: 'active' | 'inactive' | 'background';
  deliveryStatus: 'pending' | 'delivered' | 'blocked' | 'failed' | 'queued';
  deliveryError?: string | null;
  deliveryId?: string;
  deliveredAt?: string | null;
  queuedAt?: string;
  deliveryMode?: 'expo-foreground' | 'expo-background-push' | 'in-app-local-fallback' | 'background-local-queued';
  pushTokenRegistered?: boolean;
  receiptId?: string;
};

export type MobileNotificationPermission = {
  status: 'notDetermined' | 'granted' | 'denied';
  granted: boolean;
  changedAt: string | null;
  source: 'expo-notifications';
  nativePromptAvailable: boolean;
  promptRequested?: boolean;
  lastPrompt?: {
    promptId: string;
    source: 'expo-notifications';
    nativePromptAvailable: boolean;
    requestedAt: string;
    result: 'granted' | 'denied';
  } | null;
};

export type MobileNotificationAdapterStatus = {
  adapterName: string;
  expectedNativeModule?: 'expo-notifications';
  nativeAvailable: boolean;
  fallbackUsed: boolean;
  deliveryMode: 'expo-foreground' | 'expo-background-push' | 'in-app-local-fallback' | 'background-local-queued' | 'in-app-local';
  supportsPushToken: boolean;
  supportsReceipts?: boolean;
  channels?: MobileNotification['channelId'][];
};

export type MobilePushTokenStatus = {
  registered: boolean;
  platform: 'expo' | string | null;
  deviceId?: string | null;
  projectId?: string | null;
  tokenFingerprint: string | null;
  tokenPreview: string | null;
  registeredAt?: string;
  plaintextExposed: false;
};

export type MobilePushTokenRotation = {
  rotationId: string;
  status: 'rotated' | 'failed';
  reason: string;
  rotatedAt: string;
  previousTokenFingerprint: string | null;
  nextTokenFingerprint?: string | null;
  previousTokenPreserved: boolean;
  issueId?: string;
  plaintextExposed?: false;
};

export type MobilePushTokenRotationIssue = {
  issueId: string;
  status: 'failed' | 'resolved';
  reason: string;
  retryable: boolean;
  previousTokenPreserved: boolean;
  previousTokenFingerprint: string | null;
  createdAt: string;
  resolvedAt?: string;
};

export type MobilePushTokenRotationStatus = {
  history: MobilePushTokenRotation[];
  issueQueue: MobilePushTokenRotationIssue[];
  lastRotation: MobilePushTokenRotation | null;
  unresolvedIssues: MobilePushTokenRotationIssue[];
};

export type MobileNotificationDelivery = {
  deliveryId: string;
  notificationId: string;
  eventType: string;
  channelId: MobileNotification['channelId'];
  adapterName: string;
  status: 'delivered' | 'queued';
  deliveredAt: string | null;
  queuedAt?: string;
  appState?: 'active' | 'inactive' | 'background';
  presentationPolicy?: 'foreground-local' | 'background-queue';
  nativeAvailable?: boolean;
  fallbackUsed?: boolean;
  pushTokenRegistered?: boolean;
  deliveryMode?: MobileNotification['deliveryMode'];
  receipt?: MobileNotificationReceipt;
};

export type MobileNotificationReceipt = {
  receiptId: string;
  deliveryId: string;
  notificationId: string;
  status: 'ok' | 'queued' | 'failed';
  provider: 'expo-notifications' | 'local-fallback';
  appState: 'active' | 'inactive' | 'background';
  retryable: boolean;
  checkedAt: string;
  verifiedAt?: string;
  retriedAt?: string;
};

export type MobileNotificationIssue = {
  receiptId: string;
  deliveryId: string;
  notificationId: string;
  eventType: string;
  status: 'queued' | 'failed' | 'resolved';
  retryable: boolean;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
};

export type MobileNotificationProviderReceiptDrill = {
  drillId: string;
  status: 'passed' | 'needs-evidence';
  checkedAt: string;
  mode: 'expo-provider-native' | 'expo-provider-contract-fallback';
  provider: 'expo-notifications' | 'local-fallback';
  expectedNativeModule: 'expo-notifications';
  nativeProviderReceipt: boolean;
  foreground: null | {
    receiptId: string;
    status: MobileNotificationReceipt['status'];
    provider: MobileNotificationReceipt['provider'];
  };
  background: null | {
    receiptId: string;
    status: MobileNotificationReceipt['status'];
    provider: MobileNotificationReceipt['provider'];
  };
  receiptVerification: {
    success: boolean;
    checkedAt: string;
    checked: number;
    ok: number;
    queued: number;
    failed: number;
    retryQueued: boolean;
    unresolvedIssues: MobileNotificationIssue[];
  };
  visualEvidence: Array<{
    state: 'foreground' | 'background';
    evidenceType: 'native-provider-receipt' | 'runtime-visual-contract';
    receiptId: string;
    status: MobileNotificationReceipt['status'];
  }>;
};

export type SecureTokenStorageStatus = {
  exists: boolean;
  backendName: string;
  nativeAdapter?: {
    adapterName: string;
    configuredPlugin: boolean;
    nativeAvailable: boolean;
    supportsSyncStorage: boolean;
    platformBacked: boolean;
    fallbackUsed: boolean;
    fallbackStoreName: string;
    encryptedAtRest: boolean;
    plaintextExposed: false;
    expectedNativeModule: 'expo-secure-store';
    checkedAt: string;
  };
  nativeBacked?: boolean;
  fallbackUsed?: boolean;
  platformBacked?: boolean;
  sealed?: boolean;
  algorithm?: 'aes-256-gcm';
  storedAt?: string;
  plaintextExposed?: false;
};

export type MobileSessionStatus = {
  configured: boolean;
  locked: boolean;
  lastUnlockedAt: string | null;
  timeoutMs: number;
  failedAttempts: number;
  maxFailedAttempts: number;
  lockoutMs: number;
  lockedUntil: string | null;
  lifecycle: {
    appState: 'active' | 'inactive' | 'background';
    lastBackgroundedAt: string | null;
    lockOnBackground: boolean;
    lockOnInactive: boolean;
    relockAfterMs: number;
  };
};

export type GrowthReview = {
  reviewId: string;
  period: string;
  generatedAt: string;
  summary: string;
  repeatedTasks: unknown[];
  preferenceCandidates: unknown[];
  failureLessons: unknown[];
  maturityScore?: {
    total: number;
    level: string;
    dimensions: Record<string, number>;
    thresholdStatus: string;
    thresholdAlerts: unknown[];
    learningVerification: {
      linked: boolean;
      verifierId: string;
      status: string;
      passRate: number | null;
      failed: number;
      criticalFailed: number;
    };
    trend: unknown;
    nextActions: string[];
  };
  recommendations: unknown[];
};
