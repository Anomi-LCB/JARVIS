import test from 'node:test';
import assert from 'node:assert/strict';
import { countCurrentScenarioStatuses, countDeclaredScenarioStatuses } from '../scripts/agent-platform-status.mjs';

test('integration status reports the latest observed run separately from the frozen corpus declaration', () => {
  const evaluation = {
    measurementContract: { statuses: ['completed', 'failed', 'blocked', 'unimplemented', 'not-run'] },
    scenarios: [
      { id: 'G02', status: 'not-run' },
      { id: 'G03', status: 'not-run' },
      { id: 'M06', status: 'not-run' }
    ]
  };
  const history = [
    { scenarioId: 'G02', observedAt: '2026-09-28T00:00:00Z', outcome: 'failed' },
    { scenarioId: 'G02', observedAt: '2026-09-29T00:00:00Z', outcome: 'completed' },
    { scenarioId: 'G03', observedAt: '2026-09-29T00:00:00Z', outcome: 'blocked' }
  ];

  assert.deepEqual(countCurrentScenarioStatuses(evaluation, history), {
    completed: 1, failed: 0, blocked: 1, unimplemented: 0, 'not-run': 1
  });
  assert.deepEqual(countDeclaredScenarioStatuses(evaluation), {
    completed: 0, failed: 0, blocked: 0, unimplemented: 0, 'not-run': 3
  });
});
