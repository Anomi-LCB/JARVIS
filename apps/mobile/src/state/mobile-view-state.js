export function createInitialMobileViewState() {
  return {
    route: 'PairingScreen',
    connection: {
      connected: false,
      bridgeUrl: null,
      lastCheckedAt: null,
      latencyMs: null,
      error: null
    },
    device: {
      paired: false,
      pairingStatus: 'unpaired',
      authTokenExists: false,
      tokenStorage: {
        exists: false,
        sealed: false,
        plaintextExposed: false
      }
    },
    security: {
      session: {
        configured: false,
        locked: false,
        lastUnlockedAt: null,
        failedAttempts: 0,
        lifecycle: {
          appState: 'active',
          lastBackgroundedAt: null
        }
      },
      sensitiveActionReady: true
    },
    command: {
      rawText: '',
      sending: false,
      error: null
    },
    approvals: {
      items: [],
      selected: null,
      loading: false,
      error: null
    },
    task: {
      current: null,
      result: null
    },
    offline: {
      autoSend: false,
      pending: []
    },
    events: {
      lastEventId: null,
      unreadCount: 0,
      items: []
    },
    notifications: {
      unreadCount: 0,
      appState: 'active',
      permission: {
        status: 'notDetermined',
        granted: false,
        changedAt: null,
        promptRequested: false,
        lastPrompt: null
      },
      items: [],
      deliveryLog: [],
      receiptLog: [],
      issueQueue: []
    },
    feedback: {
      lastSent: null,
      error: null
    },
    growth: {
      latestReview: null
    },
    poisonQueue: {
      latest: null,
      items: [],
      queue: null,
      loading: false,
      error: null,
      refreshState: {
        lastRefreshedAt: null,
        processed: 0,
        visualSnapshot: { tone: 'clear', badgeLabel: '정상' }
      }
    },
    queuePolicy: {
      latest: null,
      draft: null,
      saving: false,
      error: null
    }
  };
}

export function setRoute(state, route) {
  return { ...state, route };
}

export function setConnection(state, connection) {
  return { ...state, connection: { ...state.connection, ...connection } };
}

export function setDevice(state, device) {
  return { ...state, device: { ...state.device, ...device } };
}

export function setSecurity(state, security) {
  return { ...state, security: { ...state.security, ...security } };
}

export function setApprovals(state, approvals) {
  return { ...state, approvals: { ...state.approvals, ...approvals } };
}

export function setTask(state, task) {
  return { ...state, task: { ...state.task, ...task } };
}

export function setOffline(state, offline) {
  return { ...state, offline: { ...state.offline, ...offline } };
}

export function setEvents(state, events) {
  return { ...state, events: { ...state.events, ...events } };
}

export function setNotifications(state, notifications) {
  return { ...state, notifications: { ...state.notifications, ...notifications } };
}

export function setFeedback(state, feedback) {
  return { ...state, feedback: { ...state.feedback, ...feedback } };
}

export function setGrowth(state, growth) {
  return { ...state, growth: { ...state.growth, ...growth } };
}

export function setPoisonQueue(state, poisonQueue) {
  return { ...state, poisonQueue: { ...state.poisonQueue, ...poisonQueue } };
}

export function setQueuePolicy(state, queuePolicy) {
  return { ...state, queuePolicy: { ...state.queuePolicy, ...queuePolicy } };
}
