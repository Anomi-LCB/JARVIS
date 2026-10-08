import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedEvidence } from '../scripts/research-ledger-evidence-audit.mjs';

test('evidence audit only classifies changed records and finds exact copies by historical hash', () => {
  const snapshot = { candidates: [{ id: 'candidate-a', attempts: [{ id: 'attempt-a', evidence: [
    { path: 'artifacts/old.json', sha256: 'abc', integrity: 'changed' },
    { path: 'artifacts/current.json', sha256: 'def', integrity: 'intact' }
  ] }] }] };
  const rows = classifyChangedEvidence(snapshot, new Map([['abc', ['artifacts/renamed.json', 'artifacts/old.json']]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'exact-copy-found');
  assert.deepEqual(rows[0].matches, ['artifacts/renamed.json']);
});

test('evidence audit does not call an unmatched record permanently lost', () => {
  const snapshot = { candidates: [{ id: 'candidate-a', attempts: [{ id: 'attempt-a', evidence: [
    { path: 'artifacts/old.json', sha256: 'abc', integrity: 'changed' }
  ] }] }] };
  const rows = classifyChangedEvidence(snapshot, new Map());
  assert.equal(rows[0].classification, 'no-exact-copy-found-in-scanned-roots');
});
