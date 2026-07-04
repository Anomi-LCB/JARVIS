import { ActionType, createClarificationRequest, stableId } from '../../../shared/src/types.js';

const fallbackCandidates = [
  { label: '로컬 산출물 생성', actionType: ActionType.CREATE_FILE, category: 'document' },
  { label: '브라우저 조사', actionType: ActionType.BROWSER_SEARCH, category: 'research' },
  { label: '파일 목록 조회', actionType: ActionType.LIST_FILES, category: 'filesystem' }
];

export class AmbiguityResolver {
  constructor({ threshold = 0.75, clock = () => new Date() } = {}) {
    this.threshold = threshold;
    this.clock = clock;
  }

  resolve({ taskRequest, candidates }) {
    const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
    const selected = sorted[0] ?? null;
    const runnerUp = sorted[1] ?? null;
    const closeCompetingIntent = Boolean(
      selected
      && runnerUp
      && selected.actionType !== runnerUp.actionType
      && selected.confidence - runnerUp.confidence <= 0.12
    );
    const missingSlots = selected?.missingSlots ?? [];
    const complexNeedsConfirmation = Boolean(selected?.complexity?.needsPlanDecomposition && sorted.length > 1);
    const ambiguous = !selected || selected.confidence < this.threshold || closeCompetingIntent || missingSlots.length > 0 || complexNeedsConfirmation;
    const alternatives = ambiguous
      ? this.ensureThree(taskRequest, sorted)
      : sorted.slice(0, 3);
    const question = this.questionFor({ selected, closeCompetingIntent, missingSlots, complexNeedsConfirmation });
    const clarificationRequest = ambiguous
      ? createClarificationRequest({
          clarificationId: stableId('clarify', taskRequest.requestId, taskRequest.createdAt),
          taskId: taskRequest.taskId,
          question,
          choices: alternatives.map((candidate) => ({
            intentId: candidate.intentId,
            label: candidate.label,
            actionType: candidate.actionType,
            confidence: candidate.confidence,
            riskHint: candidate.riskHint
          })),
          missingSlots,
          selectedIntentId: selected?.intentId ?? null,
          createdAt: this.clock().toISOString()
        })
      : null;
    return {
      ambiguityId: stableId('amb', taskRequest.requestId, taskRequest.createdAt),
      taskId: taskRequest.taskId,
      ambiguous,
      threshold: this.threshold,
      selected,
      alternatives,
      reasonCodes: this.reasonCodes({ selected, closeCompetingIntent, missingSlots, complexNeedsConfirmation }),
      question: ambiguous ? question : null,
      clarificationRequest,
      createdAt: this.clock().toISOString()
    };
  }

  questionFor({ selected, closeCompetingIntent, missingSlots, complexNeedsConfirmation }) {
    if (!selected) return '명령 의도를 확인해야 합니다. 어떤 작업을 원하시나요?';
    if (missingSlots.length > 0) return `실행에 필요한 정보가 부족합니다: ${missingSlots.join(', ')}.`;
    if (closeCompetingIntent) return '여러 실행 의도가 비슷하게 감지되었습니다. 실행 전에 정확한 작업을 선택해야 합니다.';
    if (complexNeedsConfirmation) return '복합 명령으로 보입니다. 한 번에 진행할 단계와 순서를 확인해야 합니다.';
    return '명령 의도가 모호합니다. 실행 전에 후보 중 하나를 선택해야 합니다.';
  }

  reasonCodes({ selected, closeCompetingIntent, missingSlots, complexNeedsConfirmation }) {
    const reasons = [];
    if (!selected) reasons.push('A_AMBIGUITY_NO_INTENT');
    if (selected && selected.confidence < this.threshold) reasons.push('A_AMBIGUITY_LOW_CONFIDENCE');
    if (closeCompetingIntent) reasons.push('A_AMBIGUITY_COMPETING_INTENTS');
    if (missingSlots.length > 0) reasons.push('A_AMBIGUITY_MISSING_SLOTS');
    if (complexNeedsConfirmation) reasons.push('A_AMBIGUITY_COMPLEX_COMMAND');
    return reasons;
  }

  ensureThree(taskRequest, candidates) {
    const existing = candidates.map((candidate) => candidate.actionType);
    const additions = fallbackCandidates
      .filter((candidate) => !existing.includes(candidate.actionType))
      .map((candidate, index) => ({
        intentId: stableId('intent', `${taskRequest.requestId}:${candidate.actionType}:${index}`, taskRequest.createdAt),
        ...candidate,
        confidence: 0.45 - index * 0.05,
        reasons: ['fallback_candidate'],
        riskHint: 'needs-user-selection',
        slots: {}
      }));
    return [...candidates, ...additions].slice(0, 3);
  }
}
