import assert from 'node:assert/strict';
import test from 'node:test';
import { runNewsSourceGroundingEvaluation } from '../scripts/news-source-grounding-evaluation.mjs';

test('fixed source-grounding corpus agrees with every predeclared deterministic oracle', async () => {
  const report = await runNewsSourceGroundingEvaluation({ now: () => '2026-09-28T00:00:00.000Z' });
  assert.equal(report.suiteId, 'news-source-grounding-contract-v1');
  assert.equal(report.evidenceClass, 'synthetic-contract');
  assert.equal(report.caseCount, 15);
  assert.equal(report.passed, 15);
  assert.equal(report.failed, 0);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.externalRequests, 0);
  assert.equal(report.results.find(result => result.id === 'NGE-13-fact-check-unimplemented').actual, false);
  assert.equal(report.results.find(result => result.id === 'NGE-13-fact-check-unimplemented').semanticEntailment, 'not-evaluated');
  assert.match(report.limitations.join(' '), /not an independent holdout/u);
});
