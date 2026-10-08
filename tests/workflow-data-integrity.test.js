import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

const adapter = new LocalWorkflowToolAdapter({ allowedRoots: [process.cwd()] });
const code = (expected) => (error) => error.code === expected;

test('join preserves the established right prefix but fails on a second field collision', () => {
  assert.deepEqual(adapter.opJoin({ left: [{ id: 1, x: 2 }], right: [{ id: 1, x: 3 }], on: 'id' }).items, [{ id: 1, x: 2, right_x: 3 }]);
  assert.throws(() => adapter.opJoin({
    left: [{ id: 1, x: 2, right_x: 'must remain' }],
    right: [{ id: 1, x: 3 }], on: 'id'
  }), code('WORKFLOW_JOIN_FIELD_COLLISION'));
  assert.throws(() => adapter.opJoin({
    left: [{ id: 1, x: 2 }], right: [{ id: 1, right_x: 'must remain', x: 3 }], on: 'id'
  }), code('WORKFLOW_JOIN_FIELD_COLLISION'));
});

test('join cannot match two rows whose required keys are missing', () => {
  for (const type of ['inner', 'left', 'right', 'full']) {
    assert.throws(() => adapter.opJoin({ left: [{ a: 'left' }], right: [{ b: 'right' }], on: 'id', type }), code('WORKFLOW_JOIN_KEY_MISSING'));
    assert.throws(() => adapter.opJoin({ left: [{ id: 1 }], right: [{ b: 'right' }], on: 'id', type }), code('WORKFLOW_JOIN_KEY_MISSING'));
  }
  assert.deepEqual(adapter.opJoin({ left: [{ id: 1 }], right: [{ id: 2 }], on: 'id' }).items, []);
});

test('group aggregation refuses aliases and reserved result fields that erase group identity', () => {
  assert.throws(() => adapter.opGroupAggregate({
    items: [{ sum: 'east', amount: 2 }, { sum: 'west', amount: 3 }],
    groupBy: 'sum', field: 'amount', operation: 'sum', as: 'sum'
  }), code('WORKFLOW_AGGREGATE_FIELD_COLLISION'));
  assert.throws(() => adapter.opGroupAggregate({
    items: [{ value: 'east', amount: 2 }], groupBy: 'value', field: 'amount', operation: 'sum', as: 'total'
  }), code('WORKFLOW_AGGREGATE_FIELD_COLLISION'));
  assert.deepEqual(adapter.opGroupAggregate({
    items: [{ region: 'east', amount: 2 }, { region: 'east', amount: 3 }],
    groupBy: 'region', field: 'amount', operation: 'sum', as: 'total'
  }).items, [{ region: 'east', total: 5, value: 5 }]);
});

test('explicit aggregate schemas omit only the legacy value alias and preserve grouped values', () => {
  const items = [{ value: 'east', amount: 2 }, { value: 'east', amount: 4 }];
  for (const [operation, expected] of [['sum', 6], ['count', 2], ['avg', 3], ['min', 2], ['max', 4]]) {
    const result = adapter.opGroupAggregate({ items, groupBy: 'value', field: 'amount', operation,
      as: 'total', includeValueAlias: false });
    assert.deepEqual(result.items, [{ value: 'east', total: expected }]);
  }
  assert.deepEqual(adapter.opGroupAggregate({ items: [{ region: 'east', amount: 2 }],
    groupBy: 'region', field: 'amount', operation: 'sum', as: 'total', includeValueAlias: false
  }).items, [{ region: 'east', total: 2 }]);
  assert.throws(() => adapter.opGroupAggregate({ items, groupBy: 'value', field: 'amount',
    operation: 'sum', as: 'value', includeValueAlias: false }), code('WORKFLOW_AGGREGATE_FIELD_COLLISION'));
});

test('pivot refuses a generated column that would erase the row key', () => {
  assert.throws(() => adapter.opPivot({
    items: [{ region: 'east', kind: 'region', amount: 2 }], row: 'region', column: 'kind', value: 'amount'
  }), code('WORKFLOW_PIVOT_FIELD_COLLISION'));
  assert.deepEqual(adapter.opPivot({
    items: [{ region: 'east', kind: 'hardware', amount: 2 }, { region: 'east', kind: 'software', amount: 3 }],
    row: 'region', column: 'kind', value: 'amount'
  }).items, [{ region: 'east', hardware: 2, software: 3 }]);
});
