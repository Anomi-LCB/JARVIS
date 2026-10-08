import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceCommandTurn, observeVoiceCommandTurn } from '../apps/mobile/src/voice/voice-command-turn.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(root, 'packages/core/fixtures/s07-korean-correction-transcript-events.json'), 'utf8'));

test('S07 mobile voice turn keeps Korean partial as draft and dispatches only the corrected final instruction', () => {
  let turn = createVoiceCommandTurn();
  const dispatched = [];
  const observations = fixture.utterances.map(event => {
    const result = observeVoiceCommandTurn(turn, event);
    turn = result.turn;
    if (result.committed) dispatched.push(result.transcript);
    return { accepted: result.accepted, committed: result.committed, transcript: result.transcript ?? null,
      correctionApplied: result.correctionApplied ?? false };
  });
  assert.equal(observations[0].committed, false);
  assert.deepEqual(dispatched, [fixture.utterances[1].expectedDispatch]);
  assert.equal(dispatched.some(command => command.includes('회의록')), false);
  assert.equal(turn.status, 'committed');
  assert.equal(turn.correctionApplied, true);
  assert.equal(observeVoiceCommandTurn(turn, { transcript: '또 다른 최종 명령', isFinal: true }).accepted, false);

  const evidence = { schemaVersion: 1, scenarioId: 'S07-SYNTHETIC-TEXT', fixtureId: fixture.fixtureId,
    modality: fixture.modality, observations, dispatchedCommands: dispatched, finalTurnState: turn,
    acousticAudioIncluded: fixture.acousticAudioIncluded, providerCalls: 0, networkRequests: 0, externalWrites: 0 };
  const path = process.env.JARVIS_S07_EVIDENCE_PATH;
  if (path) writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('S07 correction parsing only accepts explicit correction markers and keeps uncorrected Korean commands intact', () => {
  let turn = createVoiceCommandTurn();
  const plain = observeVoiceCommandTurn(turn, { transcript: '회의록 말고 행사 일정만 수정해줘', isFinal: true });
  assert.equal(plain.transcript, '회의록 말고 행사 일정만 수정해줘');
  assert.equal(plain.correctionApplied, false);
  turn = createVoiceCommandTurn();
  const correction = observeVoiceCommandTurn(turn, { transcript: '문서 A 수정해. 정정할게, 문서 B만 수정해.', isFinal: true });
  assert.equal(correction.transcript, '문서 B만 수정해.');
  assert.equal(correction.correctionApplied, true);
});
