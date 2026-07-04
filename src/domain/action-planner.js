const priorityRank = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4
};

export class ActionPlanner {
  plan({ readiness, documentStreams, commandProfile }) {
    const actions = [
      ...readiness.blockers.map((item) => this.fromIssue(item, 'critical', 'unblock')),
      ...readiness.watchItems.map((item) => this.fromIssue(item, item.id === 'B' || item.id === 'E' ? 'high' : 'medium', 'stabilize')),
      ...documentStreams
        .filter((stream) => stream.stage === 'ready' || stream.stage === 'building')
        .map((stream) => ({
          id: `${stream.id}-next`,
          docId: stream.id,
          title: `${stream.title} 다음 구현`,
          priority: stream.risk === 'high' ? 'high' : 'medium',
          type: 'build',
          action: stream.nextAction,
          evidence: stream.evidence
        }))
    ];

    const deduped = this.dedupe(actions);
    const ordered = deduped.sort(
      (a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.docId.localeCompare(b.docId)
    );

    return {
      focus: this.focusFor(readiness.status, commandProfile.title),
      nextActions: ordered.slice(0, 7),
      counts: {
        critical: ordered.filter((item) => item.priority === 'critical').length,
        high: ordered.filter((item) => item.priority === 'high').length,
        medium: ordered.filter((item) => item.priority === 'medium').length,
        low: ordered.filter((item) => item.priority === 'low').length
      }
    };
  }

  fromIssue(issue, priority, type) {
    return {
      id: `${issue.id}-${type}`,
      docId: issue.id,
      title: issue.title,
      priority,
      type,
      action: issue.nextAction,
      evidence: issue.reason
    };
  }

  dedupe(actions) {
    const bestByAction = new Map();
    for (const action of actions) {
      const key = `${action.docId}:${action.action}`;
      const current = bestByAction.get(key);
      if (!current || priorityRank[action.priority] < priorityRank[current.priority]) {
        bestByAction.set(key, action);
      }
    }
    return [...bestByAction.values()];
  }

  focusFor(readinessStatus, commandTitle) {
    if (readinessStatus === 'blocked') {
      return `${commandTitle} 차단 해소`;
    }
    if (readinessStatus === 'review') {
      return `${commandTitle} 검증 안정화`;
    }
    return `${commandTitle} 릴리스 진행`;
  }
}
