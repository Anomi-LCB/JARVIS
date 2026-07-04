export const ReadinessStatus = Object.freeze({
  GO: 'go',
  REVIEW: 'review',
  BLOCKED: 'blocked'
});

export class ReleaseReadiness {
  evaluate({ documentStreams, simulationResult, canAssist, commandProfile, plan }) {
    const blockers = [];
    const watchItems = [];

    for (const stream of documentStreams) {
      if (stream.health === 'blocked' || stream.stage === 'blocked') {
        blockers.push({
          id: stream.id,
          title: stream.title,
          reason: `${stream.title} is blocked`,
          nextAction: stream.nextAction
        });
      } else if (stream.health === 'watch' || stream.risk === 'high') {
        watchItems.push({
          id: stream.id,
          title: stream.title,
          reason: `${stream.title} needs review`,
          nextAction: stream.nextAction
        });
      }
    }

    for (const failedCheck of simulationResult.failedChecks) {
      watchItems.push({
        id: 'G',
        title: '테스트/검증 시뮬레이션',
        reason: failedCheck,
        nextAction: '실패 체크를 사용자 확인 또는 자동 검증으로 해소'
      });
    }

    if (!canAssist) {
      blockers.push({
        id: 'E',
        title: '권한/승인/보안 시스템',
        reason: `${commandProfile.title} approval is not cleared`,
        nextAction: '관리자 승인 또는 낮은 권한의 dry-run으로 전환'
      });
    }
    if (plan && !plan.executable) {
      blockers.push({
        id: 'B',
        title: '로컬 PC 제어 프로그램',
        reason: `${plan.capability} is blocked by local execution policy`,
        nextAction: '명령을 allowlist capability로 재분류하거나 사용자 확인 가능한 dry-run으로 전환'
      });
    }

    const averageProgress = Math.round(
      documentStreams.reduce((sum, stream) => sum + stream.progress, 0) / documentStreams.length
    );
    const penalty = blockers.length * 18 + watchItems.length * 5;
    const score = Math.max(0, Math.min(100, averageProgress - penalty));

    return {
      status: blockers.length ? ReadinessStatus.BLOCKED : watchItems.length ? ReadinessStatus.REVIEW : ReadinessStatus.GO,
      score,
      blockers,
      watchItems: watchItems.slice(0, 6),
      goCriteria: [
        { label: 'A-G streams present', pass: documentStreams.length === 7 },
        { label: 'Security gate cleared', pass: canAssist },
        { label: 'Local plan allowlisted', pass: plan ? plan.executable : true },
        { label: 'Simulation has no blockers', pass: simulationResult.failedChecks.length === 0 },
        { label: 'Readiness score above 70', pass: score >= 70 }
      ],
      summary: this.summaryFor({ blockers, watchItems, score })
    };
  }

  summaryFor({ blockers, watchItems, score }) {
    if (blockers.length) {
      return `BLOCKED · ${blockers.length} blockers · score ${score}`;
    }
    if (watchItems.length) {
      return `REVIEW · ${watchItems.length} watch items · score ${score}`;
    }
    return `GO · all gates clear · score ${score}`;
  }
}

export function formatReadinessReport(state) {
  const lines = [
    `# JARVIS A-G Readiness Report`,
    ``,
    `Command: ${state.command}`,
    `Status: ${state.readiness.status.toUpperCase()}`,
    `Score: ${state.readiness.score}`,
    `Summary: ${state.readiness.summary}`,
    ``,
    `## Go Criteria`,
    ...state.readiness.goCriteria.map((item) => `- ${item.pass ? '[x]' : '[ ]'} ${item.label}`),
    ``,
    `## Approval Summary`,
    ...(state.approvalSummary?.length
      ? state.approvalSummary.map(
          (item) => `- ${item.id}: ${item.status} / ${item.requiredLevel} / expires ${item.expiresAt} / renewals ${item.renewalCount}`
        )
      : ['- none']),
    ``,
    `## A-G Streams`,
    ...state.documentStreams.map(
      (stream) => `- ${stream.id} ${stream.title}: ${stream.stage} / ${stream.health} / ${stream.progress}%`
    ),
    ``,
    `## Blockers`,
    ...(state.readiness.blockers.length
      ? state.readiness.blockers.map((item) => `- ${item.id} ${item.reason} -> ${item.nextAction}`)
      : ['- none']),
    ``,
    `## Watch Items`,
    ...(state.readiness.watchItems.length
      ? state.readiness.watchItems.map((item) => `- ${item.id} ${item.reason} -> ${item.nextAction}`)
      : ['- none']),
    ``,
    `## Next Action Plan`,
    ...(state.actionPlan?.nextActions?.length
      ? state.actionPlan.nextActions.map(
          (item) => `- [${item.priority}] ${item.docId} ${item.type}: ${item.action} (${item.evidence})`
        )
      : ['- none'])
  ];
  return lines.join('\n');
}
