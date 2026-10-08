export const defaultVoiceAutoSubmitConfidence = 0.5;
export const defaultVoiceRepeatWindowMs = 90_000;

export function normalizeVoiceConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null;
  return numeric;
}

export function evaluateVoiceAutoSubmit(
  evidence = {},
  { minimumConfidence = defaultVoiceAutoSubmitConfidence } = {}
) {
  const confidence = normalizeVoiceConfidence(evidence?.confidence);
  const threshold = Number.isFinite(Number(minimumConfidence))
    ? Math.min(1, Math.max(0, Number(minimumConfidence)))
    : defaultVoiceAutoSubmitConfidence;
  if (confidence === null) {
    return {
      accepted: true,
      confidence: null,
      threshold,
      reason: 'confidence-unavailable'
    };
  }
  if (confidence < threshold) {
    return {
      accepted: false,
      confidence,
      threshold,
      reason: 'low-confidence'
    };
  }
  return {
    accepted: true,
    confidence,
    threshold,
    reason: 'confidence-accepted'
  };
}

function normalizeRepeatText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s.,!?"'`~:;()[\]{}<>·…_-]+/g, '');
}

const affirmativeReadbackResponses = new Set([
  '네',
  '예',
  '응',
  '맞아',
  '맞아요',
  '맞습니다',
  '네맞아',
  '네맞아요',
  '예맞아',
  '예맞아요',
  '그게맞아',
  '그게맞아요'
]);

const negativeReadbackResponses = new Set([
  '아니',
  '아니요',
  '아냐',
  '틀려',
  '틀렸어',
  '틀렸어요',
  '다시',
  '다시말할게',
  '취소'
]);

export function evaluateVoiceReadbackConfirmation(
  previous,
  { transcript, engine, evidence, now = Date.now() } = {},
  { windowMs = defaultVoiceRepeatWindowMs } = {}
) {
  const previousAt = Number(previous?.at);
  const candidateTranscript = String(previous?.transcript ?? '').trim();
  const withinWindow = Boolean(candidateTranscript)
    && Number.isFinite(previousAt)
    && Number(now) - previousAt <= windowMs;
  if (!withinWindow) {
    return {
      handled: false,
      accepted: false,
      rejected: false,
      reason: candidateTranscript ? 'confirmation-expired' : 'confirmation-missing'
    };
  }

  const response = normalizeRepeatText(transcript);
  const candidateEngine = String(previous?.evidence?.engine ?? 'platform-default').trim() || 'platform-default';
  const responseEngine = String(engine ?? 'platform-default').trim() || 'platform-default';
  const independentEngineCount = new Set([candidateEngine, responseEngine]).size;
  const responseIsControl = affirmativeReadbackResponses.has(response) || negativeReadbackResponses.has(response);
  const responseConfidence = normalizeVoiceConfidence(evidence?.confidence);
  if (responseIsControl && responseConfidence !== null && responseConfidence < defaultVoiceAutoSubmitConfidence) {
    return {
      handled: true,
      accepted: false,
      rejected: false,
      reason: 'confirmation-low-confidence',
      confidence: responseConfidence
    };
  }
  if (affirmativeReadbackResponses.has(response)) {
    return {
      handled: true,
      accepted: true,
      rejected: false,
      reason: 'explicit-affirmation',
      transcript: candidateTranscript,
      evidence: previous.evidence ?? null,
      confirmationCount: 2,
      independentEngineCount,
      confirmationEngine: responseEngine,
      confirmationConfidence: responseConfidence
    };
  }
  if (negativeReadbackResponses.has(response)) {
    return {
      handled: true,
      accepted: false,
      rejected: true,
      reason: 'explicit-rejection',
      transcript: candidateTranscript,
      evidence: previous.evidence ?? null,
      confirmationCount: 2,
      independentEngineCount,
      confirmationEngine: responseEngine,
      confirmationConfidence: responseConfidence
    };
  }
  return {
    handled: false,
    accepted: false,
    rejected: false,
    reason: 'confirmation-response-unrecognized'
  };
}

export function evaluateVoiceRepeatConfirmation(
  previous,
  { transcript, engine, now = Date.now() } = {},
  { windowMs = defaultVoiceRepeatWindowMs } = {}
) {
  const key = normalizeRepeatText(transcript);
  const normalizedEngine = String(engine ?? 'platform-default').trim() || 'platform-default';
  const previousAt = Number(previous?.at);
  const withinWindow = Number.isFinite(previousAt) && Number(now) - previousAt <= windowMs;
  const previousObservations = withinWindow && Array.isArray(previous?.observations)
    ? previous.observations
    : withinWindow && previous?.key
      ? [{ key: previous.key, count: previous.count ?? 1, engines: previous.engines ?? [] }]
      : [];
  const existing = previousObservations.find((observation) => observation?.key === key);
  const engines = [...new Set([...(Array.isArray(existing?.engines) ? existing.engines : []), normalizedEngine])];
  const count = existing ? Number(existing.count ?? 1) + 1 : 1;
  const observations = [
    ...previousObservations.filter((observation) => observation?.key !== key),
    { key, count, engines }
  ].filter((observation) => observation.key).slice(-4);
  const accepted = Boolean(key) && (engines.length >= 2 || count >= 3);
  return {
    accepted,
    count,
    independentEngineCount: engines.length,
    reason: accepted
      ? engines.length >= 2 ? 'independent-engine-consensus' : 'same-engine-triple-consensus'
      : existing ? 'more-confirmation-required' : 'new-confirmation-candidate',
    candidate: accepted ? null : { at: Number(now), observations }
  };
}
