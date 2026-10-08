const correctionMarkers = [
  /(?:^|[.!?。！？]\s*)아니요?(?=$|[\s,，:.!?。！？])[,，:.!?。！？]*\s*/gu,
  /(?:^|[.!?。！？]\s*)아니야(?=$|[\s,，:.!?。！？])[,，:.!?。！？]*\s*/gu,
  /(?:^|[.!?。！？]\s*)정정할게(?=$|[\s,，:.!?。！？])[,，:.!?。！？]*\s*/gu,
  /(?:^|[.!?。！？]\s*)정정하면(?=$|[\s,，:.!?。！？])[,，:.!?。！？]*\s*/gu
];
const cancellation = /(?:^|[.!?。！？]\s*)(?:취소(?:해(?:줘)?)?|중단(?:해(?:줘)?)?|그만|하지\s*마)[.!?。！？]*$/u;

export function createVoiceCommandTurn() {
  return { version: 1, status: 'listening', draft: '', command: null, correctionApplied: false };
}

/** Keep partials as drafts and commit only a finalized transcript. */
export function observeVoiceCommandTurn(turn, { transcript, isFinal } = {}) {
  const current = turn?.version === 1 ? turn : createVoiceCommandTurn();
  if (current.status !== 'listening') return { turn: current, accepted: false, committed: false };
  const value = normalize(transcript);
  if (!value) return { turn: current, accepted: false, committed: false };
  if (isFinal !== true) return { turn: { ...current, draft: value }, accepted: true, committed: false, transcript: value };
  const correction = latestCorrection(value);
  // A recognizer can finalize at the correction marker before hearing its replacement.
  // Never fall back to the command that the user has just superseded.
  if (correction && !correction.text) return {
    turn: { ...current, draft: value, command: null, correctionApplied: true },
    accepted: false, committed: false, reason: 'correction-incomplete'
  };
  const command = correction?.text ?? value;
  if (cancellation.test(command)) return {
    turn: { ...current, status: 'cancelled', draft: value, command: null, correctionApplied: Boolean(correction) },
    accepted: false, committed: false, reason: 'turn-cancelled'
  };
  if (!command) return { turn: current, accepted: false, committed: false };
  const next = { ...current, status: 'committed', draft: value, command, correctionApplied: Boolean(correction) };
  return { turn: next, accepted: true, committed: true, transcript: command, correctionApplied: Boolean(correction) };
}

function latestCorrection(value) {
  let latestIndex = -1;
  let latestEnd = -1;
  for (const marker of correctionMarkers) {
    marker.lastIndex = 0;
    let match;
    while ((match = marker.exec(value)) !== null) {
      if (match.index > latestIndex) { latestIndex = match.index; latestEnd = marker.lastIndex; }
      if (match[0].length === 0) marker.lastIndex += 1;
    }
  }
  if (latestIndex < 0) return null;
  const text = normalize(value.slice(latestEnd));
  return { text };
}

function normalize(value) { return String(value ?? '').trim().replace(/\s+/gu, ' '); }
