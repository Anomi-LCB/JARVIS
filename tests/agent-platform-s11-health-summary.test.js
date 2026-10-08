import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeHealthRecords } from '../apps/wearable-hud/src/health-record-summary.js';

const fixture = JSON.parse(readFileSync(new URL('../packages/core/fixtures/s11-synthetic-wearable-records.json', import.meta.url), 'utf8'));

test('S11 summarizes synthetic wearable records with gaps, source units, timestamps and stale status without diagnosis', () => {
  const summary = summarizeHealthRecords({ records: fixture.records, ...fixture.observedRange,
    now: fixture.now, staleAfterMs: fixture.staleAfterMs });
  assert.equal(summary.schemaVersion, 'jarvis-health-record-summary-v1');
  assert.equal(summary.recordCount, 6, 'record outside selected date range is ignored');
  assert.deepEqual(summary.metrics.steps.missingDates, ['2026-09-15', '2026-09-17']);
  assert.equal(summary.metrics.steps.samples[0].originalUnit, 'steps');
  assert.equal(summary.metrics.steps.samples[1].originalUnit, 'count');
  assert.equal(summary.metrics.steps.samples[1].value, 800);
  assert.equal(summary.metrics.heart_rate.latestObservedAt, '2026-09-17T08:00:00.000Z');
  assert.equal(summary.metrics.heart_rate.stale, true);
  assert.equal(summary.metrics.sleep_duration.samples[0].value, 450);
  assert.equal(summary.metrics.sleep_duration.unit, 'minutes');
  assert.equal(summary.diagnosisProvided, false);
  assert.equal(summary.medicalInterpretation, 'none');
  if (process.env.JARVIS_S11_ORACLE_EVIDENCE_PATH) {
    writeFileSync(process.env.JARVIS_S11_ORACLE_EVIDENCE_PATH, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'S11',
      fixtureId: fixture.fixtureId, fixtureSha256: 'ca01b85138ca0856c9c0cbc5dc11da5d652195ed7e861e2eccf65e38979e49c6',
      range: fixture.observedRange, summary }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});

test('S11 refuses unknown metrics, mixed/unknown units, invalid timestamps and unbounded values', () => {
  for (const change of [
    { metric: 'blood_pressure', value: 120, unit: 'mmHg' },
    { metric: 'heart_rate', value: 72, unit: 'steps' },
    { metric: 'steps', value: 3, unit: 'steps', observedAt: 'not-a-time' },
    { metric: 'steps', value: -1, unit: 'steps' }
  ]) {
    const record = { metric: 'steps', value: 1, unit: 'steps', observedAt: '2026-09-15T12:00:00Z', source: 'fixture', ...change };
    assert.throws(() => summarizeHealthRecords({ records: [record], startDate: '2026-09-14', endDate: '2026-09-17', now: fixture.now }), /health-record-invalid/);
  }
  assert.throws(() => summarizeHealthRecords({ records: Array(20_001).fill(fixture.records[0]),
    startDate: '2026-09-14', endDate: '2026-09-17', now: fixture.now }), /bounded-array/);
  assert.throws(() => summarizeHealthRecords({ records: [], startDate: '2026-09-18', endDate: '2026-09-17', now: fixture.now }), /range-or-clock-invalid/);
});
