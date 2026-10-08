const minimumVoiceConfidence = 0.75;
const repeatWindowMs = 30_000;

export function normalizePcVoicePhrase(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function createPcVoiceDecisionPrompt(handoff = {}) {
  const challenge = handoff.voiceChallenge ?? {};
  const phrase = normalizePcVoicePhrase(challenge.phrase);
  return {
    challengeId: String(challenge.challengeId ?? ''),
    phrase,
    approveUtterance: phrase ? `자비스 ${phrase} 승인` : '',
    rejectUtterance: phrase ? `자비스 ${phrase} 거절` : '',
    expiresAt: challenge.expiresAt ?? null,
    attemptsRemaining: Number(challenge.attemptsRemaining ?? 0)
  };
}

export function evaluatePcVoiceDecision({
  transcript,
  confidence = null,
  engine = 'browser-speech-recognition',
  handoff,
  previousCandidate = null,
  nowMs = Date.now()
} = {}) {
  const prompt = createPcVoiceDecisionPrompt(handoff);
  const privacy = { transcriptStored: false, rawAudioStored: false };
  if (!prompt.challengeId || !prompt.phrase) {
    return { accepted: false, needsRepeat: false, reason: 'challenge-missing', privacy };
  }
  const expiresAtMs = Date.parse(prompt.expiresAt ?? '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return { accepted: false, needsRepeat: false, reason: 'challenge-expired', privacy };
  }

  const normalized = normalizePcVoicePhrase(transcript);
  const decision = normalized === prompt.approveUtterance
    ? 'approve'
    : normalized === prompt.rejectUtterance
      ? 'reject'
      : null;
  if (!decision) {
    return { accepted: false, needsRepeat: false, reason: 'exact-phrase-required', privacy };
  }

  const numericConfidence = confidence == null ? null : Number(confidence);
  const confidenceKnown = Number.isFinite(numericConfidence);
  const sameCandidate = previousCandidate?.challengeId === prompt.challengeId
    && previousCandidate?.decision === decision
    && nowMs - Number(previousCandidate?.at ?? 0) <= repeatWindowMs;
  const confirmationCount = sameCandidate ? Number(previousCandidate.count ?? 1) + 1 : 1;
  const candidate = {
    challengeId: prompt.challengeId,
    decision,
    count: confirmationCount,
    at: nowMs
  };
  if ((!confidenceKnown || numericConfidence < minimumVoiceConfidence) && confirmationCount < 2) {
    return {
      accepted: false,
      needsRepeat: true,
      reason: confidenceKnown ? 'low-confidence-repeat-required' : 'unknown-confidence-repeat-required',
      candidate,
      privacy
    };
  }

  return {
    accepted: true,
    needsRepeat: false,
    decision,
    reason: confirmationCount >= 2 ? 'exact-phrase-repeated' : 'high-confidence-exact-phrase',
    proof: {
      mode: 'pc-voice-challenge',
      challengeId: prompt.challengeId,
      challengeResponse: prompt.phrase,
      spokenDecision: decision,
      confidence: confidenceKnown ? Math.max(0, Math.min(1, numericConfidence)) : null,
      confirmationCount,
      engine: String(engine ?? 'browser-speech-recognition').slice(0, 120),
      transcriptStored: false,
      rawAudioStored: false
    },
    privacy
  };
}

export class PcVoiceConfirmationController {
  constructor({
    windowRef = globalThis,
    onDecision = async () => ({ success: false, error: { code: 'PC_VOICE_DECISION_HANDLER_MISSING' } }),
    onState = () => {},
    clock = () => Date.now()
  } = {}) {
    this.windowRef = windowRef;
    this.onDecision = onDecision;
    this.onState = onState;
    this.clock = clock;
    this.active = false;
    this.recognizer = null;
    this.handoff = null;
    this.previousCandidate = null;
    this.localAttemptsRemaining = 4;
    this.sessionId = 0;
    this.state = this.createState('idle');
  }

  supported() {
    return Boolean(this.windowRef?.SpeechRecognition ?? this.windowRef?.webkitSpeechRecognition);
  }

  snapshot() {
    return { ...this.state, privacy: { transcriptStored: false, rawAudioStored: false } };
  }

  start(handoff) {
    const prompt = createPcVoiceDecisionPrompt(handoff);
    if (!this.supported()) {
      this.emit('unsupported', { reason: 'speech-recognition-unavailable' });
      return this.snapshot();
    }
    if (!prompt.challengeId || !prompt.phrase) {
      this.emit('error', { reason: 'challenge-missing' });
      return this.snapshot();
    }
    this.stop({ silent: true });
    this.active = true;
    this.handoff = handoff;
    this.previousCandidate = null;
    this.localAttemptsRemaining = Math.max(1, Math.min(4, prompt.attemptsRemaining || 4));
    const sessionId = ++this.sessionId;
    this.emit('prompting', { handoffId: handoff.handoffId, challengeId: prompt.challengeId });
    this.speakThenListen(
      `PC 음성 확인입니다. 승인하려면 ${prompt.approveUtterance}, 거절하려면 ${prompt.rejectUtterance}라고 말해 주세요.`,
      sessionId
    );
    return this.snapshot();
  }

  stop({ silent = false } = {}) {
    this.active = false;
    this.sessionId += 1;
    if (this.recognizer) {
      try {
        this.recognizer.abort();
      } catch {
        // The recognizer may already be ending.
      }
    }
    this.recognizer = null;
    this.windowRef?.speechSynthesis?.cancel?.();
    this.previousCandidate = null;
    if (!silent) this.emit('idle', { reason: 'stopped' });
    return this.snapshot();
  }

  listen(sessionId) {
    if (!this.active || sessionId !== this.sessionId) return;
    const Recognition = this.windowRef.SpeechRecognition ?? this.windowRef.webkitSpeechRecognition;
    const recognizer = new Recognition();
    this.recognizer = recognizer;
    recognizer.lang = 'ko-KR';
    recognizer.interimResults = false;
    recognizer.continuous = false;
    recognizer.maxAlternatives = 3;
    let handled = false;
    recognizer.onstart = () => this.emit('listening', {
      handoffId: this.handoff?.handoffId ?? null,
      challengeId: this.handoff?.voiceChallenge?.challengeId ?? null
    });
    recognizer.onresult = (event) => {
      handled = true;
      void this.handleResult(event, sessionId);
    };
    recognizer.onerror = (event) => {
      handled = true;
      if (!this.active || sessionId !== this.sessionId) return;
      const recoverable = ['no-speech', 'audio-capture', 'network', 'aborted'].includes(String(event?.error ?? ''));
      this.retryOrStop(recoverable ? 'recognition-retry' : 'recognition-error', sessionId);
    };
    recognizer.onend = () => {
      if (!handled && this.active && sessionId === this.sessionId) this.retryOrStop('recognition-ended', sessionId);
    };
    try {
      recognizer.start();
    } catch {
      this.retryOrStop('recognition-start-failed', sessionId);
    }
  }

  async handleResult(event, sessionId) {
    if (!this.active || sessionId !== this.sessionId) return;
    const alternatives = Array.from(event?.results?.[event.resultIndex ?? 0] ?? []);
    const best = alternatives.sort((left, right) => Number(right?.confidence ?? -1) - Number(left?.confidence ?? -1))[0];
    const evaluated = evaluatePcVoiceDecision({
      transcript: best?.transcript ?? '',
      confidence: best?.confidence ?? null,
      handoff: this.handoff,
      previousCandidate: this.previousCandidate,
      nowMs: this.clock()
    });
    if (evaluated.needsRepeat) {
      this.previousCandidate = evaluated.candidate;
      this.emit('repeat-required', {
        handoffId: this.handoff.handoffId,
        challengeId: evaluated.candidate.challengeId,
        confirmationCount: evaluated.candidate.count
      });
      this.speakThenListen('음성 신뢰도가 낮습니다. 같은 확인 문구를 한 번 더 말해 주세요.', sessionId);
      return;
    }
    if (!evaluated.accepted) {
      this.retryOrStop(evaluated.reason, sessionId);
      return;
    }

    this.active = false;
    this.emit('submitting', {
      handoffId: this.handoff.handoffId,
      challengeId: evaluated.proof.challengeId,
      decision: evaluated.decision,
      confirmationCount: evaluated.proof.confirmationCount
    });
    const result = await this.onDecision({
      handoff: this.handoff,
      decision: evaluated.decision,
      voiceProof: evaluated.proof
    });
    if (result?.success === false) {
      this.emit('error', { reason: result.error?.code ?? 'pc-voice-decision-failed' });
      return;
    }
    this.emit('completed', {
      handoffId: this.handoff.handoffId,
      decision: evaluated.decision,
      taskStatus: result?.taskStatus ?? result?.execution?.status ?? null
    });
  }

  retryOrStop(reason, sessionId) {
    if (!this.active || sessionId !== this.sessionId) return;
    this.localAttemptsRemaining -= 1;
    this.previousCandidate = null;
    if (this.localAttemptsRemaining <= 0) {
      this.active = false;
      this.emit('error', { reason: 'voice-attempts-exhausted' });
      return;
    }
    this.emit('retrying', { reason, attemptsRemaining: this.localAttemptsRemaining });
    this.speakThenListen('확인 문구가 정확히 들리지 않았습니다. 화면의 문구대로 다시 말해 주세요.', sessionId);
  }

  speakThenListen(text, sessionId) {
    if (!this.active || sessionId !== this.sessionId) return;
    const synthesis = this.windowRef?.speechSynthesis;
    const Utterance = this.windowRef?.SpeechSynthesisUtterance;
    if (!synthesis || !Utterance) {
      setTimeout(() => this.listen(sessionId), 120);
      return;
    }
    synthesis.cancel();
    const utterance = new Utterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1;
    utterance.onend = () => this.listen(sessionId);
    utterance.onerror = () => this.listen(sessionId);
    synthesis.speak(utterance);
  }

  emit(status, details = {}) {
    this.state = this.createState(status, details);
    this.onState(this.snapshot());
  }

  createState(status, details = {}) {
    return {
      status,
      supported: this.supported(),
      active: this.active,
      ...details,
      privacy: { transcriptStored: false, rawAudioStored: false }
    };
  }
}
