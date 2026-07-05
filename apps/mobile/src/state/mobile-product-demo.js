export const routeMeta = {
  HomeScreen: {
    label: '홈',
    description: '자비스에게 시키고, 승인하고, 결과를 받는 단일 화면입니다.'
  },
  PairingScreen: {
    label: '페어링',
    description: 'D Bridge URL과 pairing code로 PC 브릿지에 연결합니다.'
  },
  CommandScreen: {
    label: '명령',
    description: '자연어 명령을 TaskRequest로 만들고 D Bridge로 전송합니다.'
  },
  ApprovalQueueScreen: {
    label: '승인 대기',
    description: 'A/E가 만든 승인 카드를 확인합니다.'
  },
  ApprovalDetailScreen: {
    label: '승인 상세',
    description: '계획, 위험, 영향, 되돌리기 여부를 보고 의사를 전달합니다.'
  },
  TaskStatusScreen: {
    label: '작업 상태',
    description: 'B의 실행 상태와 G 검증 단계를 추적합니다.'
  },
  ResultScreen: {
    label: '결과',
    description: '결과, 산출물, 변경사항, 피드백을 확인합니다.'
  },
  SettingsScreen: {
    label: '설정',
    description: '연결, 세션 잠금, 알림, 재시도 정책을 관리합니다.'
  },
  GrowthReviewScreen: {
    label: '성장 리뷰',
    description: 'F의 반복 작업과 선호 후보를 읽기 전용으로 검토합니다.'
  },
  PoisonQueueScreen: {
    label: '격리 큐',
    description: 'B의 실패/격리 패킷을 모바일에서 검토합니다.'
  }
};

export const taskStatusSteps = [
  '요청 접수',
  '계획 생성',
  '승인 확인',
  'PC 실행',
  '결과 검증'
];

export const decisionLabels = {
  approve: '승인',
  edit: '수정 요청',
  reject: '거절',
  respond: '되묻기',
  cancel: '취소',
  re_request: '재요청',
  pc_handoff: 'PC 확인 요청'
};

export const feedbackLabels = {
  result_good: '좋음',
  needs_edit: '수정 필요',
  rerun_requested: '다시 실행',
  do_not_remember: '기억하지 마'
};

export function createMobileProductState(now = '2026-06-17T10:30:00+09:00') {
  const approval = {
    approvalId: 'appr_mobile_001',
    taskId: 'task_mobile_001',
    title: '주간 사역 보고서 엑셀 생성',
    interpretedIntent: '모바일에서 입력한 자연어 명령을 A가 해석하고, B가 허용된 작업 폴더에 XLSX 파일을 생성합니다.',
    riskTier: 5,
    planSteps: [
      '요청 문장을 TaskRequest로 정규화',
      'A Core에서 엑셀 생성 계획 수립',
      'E Policy에서 낮은 위험 승인 카드 발급',
      'B PC Agent가 허용 루트 안에 파일 생성',
      'G Verification이 산출물과 rollback 가능 여부 검증'
    ],
    affectedItems: [
      { type: 'create_file', path: 'C:/Users/user/Documents/Jarvis/workspace/weekly-report.xlsx' },
      { type: 'write_audit', label: 'approval.decision.sent 감사 로그' }
    ],
    externalTransfer: false,
    irreversible: false,
    rollbackAvailable: true,
    estimatedRuntimeMs: 4200,
    warnings: [],
    choices: ['approve', 'edit', 'reject', 'respond'],
    expiresAt: '2026-12-31T23:59:00+09:00',
    status: 'pending'
  };

  return {
    connection: {
      connected: false,
      bridgeUrl: 'http://127.0.0.1:17777',
      effectiveBridgeUrl: null,
      lastCheckedAt: null,
      latencyMs: null,
      error: null
    },
    device: {
      deviceId: 'mobile_lcb_001',
      deviceName: 'JARVIS Mobile Console',
      paired: false,
      pairingStatus: 'unpaired',
      pairingCode: '482913',
      authTokenExists: false,
      tokenStorage: {
        exists: false,
        sealed: false,
        plaintextExposed: false,
        backendName: 'expo-secure-store'
      }
    },
    security: {
      configured: true,
      locked: false,
      sessionMethod: 'PIN-ready',
      lifecycle: 'active',
      lastAppState: 'active',
      lastAppStateChangedAt: null,
      lastLifecycleLockReason: null,
      lastLifecycleLockAt: null,
      sensitiveActionReady: true
    },
    command: {
      rawText: '주간 사역 보고서 엑셀 만들어',
      sending: false,
      error: null,
      lastRequest: null
    },
    approvals: {
      items: [
        approval,
        {
          ...approval,
          approvalId: 'appr_mobile_002',
          taskId: 'task_mobile_002',
          title: '외부 발송 포함 안내문 배포',
          interpretedIntent: '안내문 초안을 만든 뒤 외부 채널 발송까지 요청했습니다. 모바일 단순 승인은 차단됩니다.',
          riskTier: 2,
          externalTransfer: true,
          rollbackAvailable: false,
          affectedItems: [
            { type: 'create_file', path: 'C:/Users/user/Documents/Jarvis/workspace/notice-draft.docx' },
            { type: 'external_transfer', label: '외부 채널 발송 후보' }
          ],
          warnings: ['Tier 2 작업은 PC 직접 확인 필요', '외부 전송 포함']
        }
      ],
      selectedApprovalId: approval.approvalId,
      lastDecision: null,
      historyById: {
        [approval.approvalId]: [
          {
            eventId: 'hist_appr_mobile_001_created',
            approvalId: approval.approvalId,
            taskId: approval.taskId,
            eventType: 'approval.created',
            label: '승인 카드 생성',
            status: 'WAITING_APPROVAL',
            actor: 'A_CORE',
            detail: approval.interpretedIntent,
            createdAt: now,
            metadata: { riskTier: approval.riskTier }
          }
        ],
        appr_mobile_002: [
          {
            eventId: 'hist_appr_mobile_002_created',
            approvalId: 'appr_mobile_002',
            taskId: 'task_mobile_002',
            eventType: 'approval.created',
            label: '승인 카드 생성',
            status: 'WAITING_APPROVAL',
            actor: 'A_CORE',
            detail: '외부 발송 포함 안내문 배포 승인 카드가 생성되었습니다.',
            createdAt: now,
            metadata: { riskTier: 2 }
          },
          {
            eventId: 'hist_appr_mobile_002_blocked',
            approvalId: 'appr_mobile_002',
            taskId: 'task_mobile_002',
            eventType: 'approval.decision.blocked',
            label: '모바일 결정 차단',
            status: 'blocked',
            actor: 'E_POLICY_SECURITY',
            reason: 'PC_CONFIRMATION_REQUIRED',
            createdAt: now,
            metadata: { externalTransfer: true }
          }
        ]
      }
    },
    task: {
      current: {
        taskId: approval.taskId,
        title: approval.title,
        status: 'WAITING_APPROVAL',
        summary: '승인 카드 검토 대기 중입니다.',
        updatedAt: now,
        progress: {
          currentStep: '승인 확인',
          stepIndex: 3,
          totalSteps: 5
        },
        blockedReason: null
      }
    },
    result: {
      taskId: approval.taskId,
      status: 'success',
      summary: 'weekly-report.xlsx 생성과 검증이 완료되었습니다.',
      outputPaths: ['C:/Users/user/Documents/Jarvis/workspace/weekly-report.xlsx'],
      changedItems: [
        { type: 'create_file', path: 'C:/Users/user/Documents/Jarvis/workspace/weekly-report.xlsx' },
        { type: 'write_audit', label: 'UndoJournal + VerificationReport' }
      ],
      rollbackAvailable: true,
      verificationStatus: 'passed'
    },
    offline: {
      pending: [
        {
          localId: 'local_queued_001',
          rawText: '다음 주 공지 초안 만들어',
          createdAt: now,
          syncStatus: 'pending',
          attachments: []
        }
      ],
      autoSend: false
    },
    notifications: {
      unreadCount: 2,
      appState: 'active',
      permission: {
        status: 'notDetermined',
        granted: false,
        changedAt: null,
        source: 'expo-notifications',
        promptRequested: false,
        lastPrompt: null
      },
      items: [
        {
          notificationId: 'notif_approval_waiting',
          eventType: 'approval.waiting',
          title: '승인 대기',
          body: '검토할 승인 카드 2건이 있습니다.',
          severity: 'warning',
          channelId: 'approvals',
          read: false,
          createdAt: now,
          deliveryStatus: 'blocked'
        },
        {
          notificationId: 'notif_growth_review',
          eventType: 'growth.review.ready',
          title: '성장 리뷰 도착',
          body: '반복 작업과 선호 후보를 확인할 수 있습니다.',
          severity: 'info',
          channelId: 'general',
          read: false,
          createdAt: now,
          deliveryStatus: 'blocked'
        }
      ],
      deliveryLog: [],
      receiptLog: [],
      issueQueue: []
    },
    feedback: {
      text: '결과 형식이 좋고 다음에도 같은 열 구성을 유지해줘.',
      lastSent: null
    },
    growth: {
      review: {
        reviewId: 'growth_review_mobile_001',
        period: '2026-W25',
        generatedAt: now,
        summary: '반복 보고서 생성과 짧은 제목 선호가 관찰되었습니다.',
        repeatedTasks: [
          { task: '주간 보고서 엑셀 생성', count: 5 },
          { task: '공지문 초안 작성', count: 3 }
        ],
        preferenceCandidates: [
          {
            hypothesisId: 'pref_short_titles',
            statement: '사용자는 보고서 제목을 짧고 행정적으로 정리하는 편을 선호합니다.',
            confidence: 0.82,
            status: 'candidate',
            evidenceEventIds: ['evt_approval_edit_001', 'evt_feedback_003']
          }
        ],
        failureLessons: [
          { lessonId: 'fail_external_transfer', summary: '외부 발송은 초안 생성까지만 모바일 승인 허용' }
        ],
        recommendations: [
          { recommendationId: 'rec_weekly_template', summary: '주간 보고서 템플릿을 기본값으로 제안' }
        ]
      },
      lastDecision: null
    },
    poisonQueue: {
      queue: {
        total: 3,
        queued: 1,
        retryScheduled: 1,
        running: 0,
        succeeded: 0,
        quarantined: 1,
        ignored: 0,
        maxAttempts: 4,
        baseBackoffMs: 1800
      },
      refreshState: {
        lastRefreshedAt: now,
        processed: 0,
        visualSnapshot: { tone: 'warning', badgeLabel: '1건 검토' }
      },
      items: [
        {
          queueId: 'poison_q_001',
          taskId: 'task_mobile_poison',
          packetId: 'packet_failed_001',
          toolName: 'filesystem.createTextFile',
          status: 'quarantined',
          reviewStatus: 'needs_review',
          reason: 'adapter_validation_failed',
          attempts: 3,
          queuedAt: now,
          nextAttemptAt: now,
          quarantinedAt: now,
          error: {
            code: 'B_PACKET_SCHEMA_INVALID',
            message: 'ExecutionPacket payload validation failed.'
          }
        },
        {
          queueId: 'poison_q_002',
          taskId: 'task_retry_waiting',
          packetId: 'packet_retry_002',
          toolName: 'excel.createWorkbook',
          status: 'retry_scheduled',
          reviewStatus: 'queued',
          reason: 'transient_adapter_timeout',
          attempts: 1,
          queuedAt: now,
          nextAttemptAt: now,
          error: null
        }
      ],
      selectedQueueId: 'poison_q_001',
      lastAction: null
    },
    queuePolicy: {
      maxAttempts: 4,
      baseBackoffMs: 1800,
      updatedAt: now,
      queuePath: 'logs/pc-agent-packet-queue.jsonl'
    },
    liveBridge: {
      restored: false,
      loading: false,
      lastAction: null,
      lastResponse: null,
      error: null,
      deviceTokenPreview: null,
      deviceTokenLoaded: false,
      startSession: null
    },
    auditTrail: [
      { eventId: 'audit_mobile_001', label: 'C does not execute PC actions directly.', createdAt: now },
      { eventId: 'audit_mobile_002', label: 'ApprovalDecision is sent through D Bridge.', createdAt: now }
    ],
    screenMessage: '모바일은 명령·승인·확인만 담당하고 실제 실행은 B가 수행합니다.'
  };
}
