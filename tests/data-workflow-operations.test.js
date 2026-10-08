import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATA_WORKFLOW_OPERATIONS,
  executeDataWorkflowOperation as execute
} from '../apps/pc-agent/src/adapters/workflow/data-workflow-operations.js';

function throwsCode(operation, code) { assert.throws(operation, (error) => error.code === code); }

test('project, derive, normalize and rank compose over unseen multilingual records without mutating inputs', () => {
  const source = [
    { profile: { name: '  ÉLODIE ' }, team: 'B', qty: '3', price: '7.5', cost: 2 },
    { profile: { name: ' 김현 ' }, team: 'A', qty: '5', price: '4', cost: 1 },
    { profile: { name: ' Zoë ' }, team: 'B', qty: '4', price: '8', cost: 2 }
  ];
  const original = structuredClone(source);
  const normalized = execute('data.normalize', { items: source, fields: ['profile.name'], case: 'lower', unicode: 'NFC' });
  const projected = execute('data.project', { items: normalized, fields: { name: 'profile.name', team: 'team', qty: 'qty', price: 'price', cost: 'cost' } });
  const derived = execute('data.derive', {
    items: projected,
    fields: { margin: { op: 'multiply', left: { field: 'qty' }, right: { op: 'subtract', left: { field: 'price' }, right: { field: 'cost' } } } }
  });
  const ranked = execute('data.window', { items: derived, partitionBy: ['team'], orderBy: [{ field: 'margin', order: 'desc' }], kind: 'rank', as: 'position' });
  assert.deepEqual(ranked.items.map(({ name, margin, position }) => ({ name, margin, position })), [
    { name: 'zoë', margin: 24, position: 1 }, { name: 'élodie', margin: 16.5, position: 2 }, { name: '김현', margin: 15, position: 1 }
  ]);
  assert.deepEqual(source, original);
  assert.equal(DATA_WORKFLOW_OPERATIONS.length, 11);
  assert.equal(Object.isFrozen(DATA_WORKFLOW_OPERATIONS), true);
});

test('flatten retains provenance and empty arrays produce no records before union and pagination', () => {
  const flattened = execute('data.flatten', { items: [{ id: 'p', lines: [{ sku: 's1' }, { sku: 's2' }] }, { id: 'q', lines: [] }], field: 'lines', as: 'line' });
  const projected = execute('data.project', { items: flattened, fields: { parent: 'id', sku: 'line.sku' } });
  const combined = execute('data.union', { items: projected, others: [[{ parent: 'x', sku: 's2' }, { parent: 'x', sku: 's3' }]], keys: ['sku'] });
  assert.deepEqual(combined.items, [{ parent: 'p', sku: 's1' }, { parent: 'p', sku: 's2' }, { parent: 'x', sku: 's3' }]);
  assert.deepEqual(execute('data.limit', { items: combined, offset: 1, count: 1 }), { items: [{ parent: 'p', sku: 's2' }], count: 1 });
  assert.deepEqual(execute('data.limit', { items: combined, offset: 100, count: 1 }), { items: [], count: 0 });
  assert.equal(execute('data.union', { items: [1], others: [[1]] }).count, 2);
});

test('derive allows only explicit arithmetic and handles every operation deterministically', () => {
  const fields = {
    plus: { op: 'add', left: { field: 'x' }, right: 3 },
    minus: { op: 'subtract', left: { field: 'x' }, right: 3 },
    product: { op: 'multiply', left: 7, right: 3 },
    quotient: { op: 'divide', left: 7, right: 2 },
    remainder: { op: 'modulo', left: 7, right: 3 },
    low: { op: 'min', left: 7, right: 3 },
    high: { op: 'max', left: 7, right: 3 },
    absolute: { op: 'abs', value: -1.25 },
    rounded: { op: 'round', value: 3.14159, digits: 3 },
    floor: { op: 'floor', value: -1.25 },
    ceil: { op: 'ceil', value: -1.25 },
    literal: { value: 42 }
  };
  assert.deepEqual(execute('data.derive', { items: [{ x: '1e1' }], fields }).items[0], {
    x: '1e1', plus: 13, minus: 7, product: 21, quotient: 3.5, remainder: 1,
    low: 3, high: 7, absolute: 1.25, rounded: 3.142, floor: -2, ceil: -1, literal: 42
  });
  throwsCode(() => execute('data.derive', { items: [{ x: 1 }], fields: { x: { op: 'eval', value: 'process.exit()' } } }), 'WORKFLOW_EXPRESSION_UNSUPPORTED');
  throwsCode(() => execute('data.derive', { items: [], fields: { x: { op: 'add', left: 1, right: 2, code: 'ignored' } } }), 'WORKFLOW_EXPRESSION_INVALID');
});

test('arithmetic refuses absent values, coercion, division by zero and unsafe magnitudes', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', null, true, '0x10']) {
    throwsCode(() => execute('data.derive', { items: [{ x: value }], fields: { y: { field: 'x' } } }), 'WORKFLOW_NUMBER_INVALID');
  }
  throwsCode(() => execute('data.derive', { items: [{}], fields: { y: { field: 'x' } } }), 'WORKFLOW_FIELD_MISSING');
  for (const op of ['divide', 'modulo']) throwsCode(() => execute('data.derive', { items: [{}], fields: { x: { op, left: 2, right: 0 } } }), 'WORKFLOW_DIVISION_BY_ZERO');
  throwsCode(() => execute('data.derive', { items: [{}], fields: { x: { op: 'multiply', left: Number.MAX_SAFE_INTEGER, right: 2 } } }), 'WORKFLOW_NUMBER_OVERFLOW');
  throwsCode(() => execute('data.statistics', { items: [{ value: Number.MAX_SAFE_INTEGER }, { value: 1 }], field: 'value' }), 'WORKFLOW_NUMBER_OVERFLOW');
  throwsCode(() => execute('data.limit', { items: [NaN], count: 1 }), 'WORKFLOW_NUMBER_INVALID');
});

test('derive fields all read the original input and output is detached from caller data', () => {
  const input = [{ value: 7, nested: { text: 'before' } }];
  const result = execute('data.derive', { items: input, fields: { value: 2, prior: { field: 'value' } } });
  assert.equal(result.items[0].prior, 7);
  result.items[0].nested.text = 'after';
  assert.equal(input[0].nested.text, 'before');
});

test('reconcile produces exact added removed changed and unchanged categories with collision-safe composite keys', () => {
  const before = [{ id: 'a|b', sub: 'c', score: 2 }, { id: 'a', sub: 'b|c', score: 3 }, { id: 'gone', sub: '', score: 1 }];
  const after = [{ id: 'a|b', sub: 'c', score: 2 }, { id: 'a', sub: 'b|c', score: 5 }, { id: 'new', sub: '', score: 9 }];
  const result = execute('data.reconcile', { items: before, other: after, keys: ['id', 'sub'] });
  assert.deepEqual(result.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(result.items.map((row) => [row.status, row.key.id, row.changedFields]), [['changed', 'a', ['score']], ['removed', 'gone', []], ['added', 'new', []]]);
  assert.equal(execute('data.reconcile', { items: before, other: after, keys: ['id', 'sub'], includeUnchanged: true }).count, 4);
  const projectedComparison = execute('data.reconcile', { items: [{ id: 1, x: 1, note: 'old' }], other: [{ id: 1, x: 1, note: 'new' }], keys: ['id'], fields: ['x'] });
  assert.equal(projectedComparison.count, 0);
});

test('reconcile sees dotted literal keys and property-order equivalence and rejects ambiguous keys', () => {
  const result = execute('data.reconcile', { items: [{ id: 1, 'a.b': 1, obj: { x: 1, y: 2 } }], other: [{ id: 1, 'a.b': 2, obj: { y: 2, x: 1 } }], keys: ['id'] });
  assert.deepEqual(result.items[0].changedFields, ['a.b']);
  throwsCode(() => execute('data.reconcile', { items: [{ id: 1 }, { id: 1 }], other: [], keys: ['id'] }), 'WORKFLOW_RECONCILE_DUPLICATE_KEY');
  throwsCode(() => execute('data.reconcile', { items: [{}], other: [], keys: ['id'] }), 'WORKFLOW_FIELD_MISSING');
  throwsCode(() => execute('data.reconcile', { items: [{ id: 1 }], other: [{ id: 1 }], keys: ['id'], fields: ['absent'] }), 'WORKFLOW_FIELD_MISSING');
});

test('exact dotted columns from aggregation compose while array paths explicitly select nested properties', () => {
  const rows = [{ 'line.sku': '  ORIGINAL ', line: { sku: 'nested' }, quantity: 2 }];
  const projected = execute('data.project', { items: rows, fields: { direct: 'line.sku', nested: ['line', 'sku'] } });
  assert.deepEqual(projected.items, [{ direct: '  ORIGINAL ', nested: 'nested' }]);
  const normalized = execute('data.normalize', { items: rows, fields: ['line.sku'], case: 'lower' });
  assert.deepEqual(normalized.items, [{ 'line.sku': 'original', line: { sku: 'nested' }, quantity: 2 }]);
  const explicit = execute('data.normalize', { items: rows, fields: [['line', 'sku']], case: 'upper' });
  assert.equal(explicit.items[0].line.sku, 'NESTED');
  assert.equal(explicit.items[0]['line.sku'], '  ORIGINAL ');
  throwsCode(() => execute('data.project', { items: [{ 'constructor.name': 'pretend-safe' }], fields: ['constructor.name'] }), 'WORKFLOW_PROPERTY_PATH_UNSAFE');
});

test('window handles stable ties, dense rank, row number and partition resets', () => {
  const items = [{ id: 'z', group: 'B', score: 5 }, { id: 'a', group: 'A', score: 9 }, { id: 'x', group: 'B', score: 5 }, { id: 'y', group: 'B', score: 3 }];
  const args = { items, partitionBy: ['group'], orderBy: [{ field: 'score', order: 'desc' }], as: 'n' };
  assert.deepEqual(execute('data.window', { ...args, kind: 'rank' }).items.map((row) => [row.id, row.n]), [['z', 1], ['x', 1], ['y', 3], ['a', 1]]);
  assert.deepEqual(execute('data.window', { ...args, kind: 'denseRank' }).items.map((row) => row.n), [1, 1, 2, 1]);
  assert.deepEqual(execute('data.window', { ...args, kind: 'rowNumber' }).items.map((row) => row.n), [1, 2, 3, 1]);
  assert.deepEqual(execute('data.window', { ...args, kind: 'runningSum', valueField: 'score' }).items.map((row) => row.n), [5, 10, 13, 9]);
});

test('window validates singleton groups and mixed sort types and does not invent missing values', () => {
  for (const value of [null, {}, []]) throwsCode(() => execute('data.window', { items: [{ v: value }], orderBy: ['v'] }), 'WORKFLOW_ORDER_TYPE_MISMATCH');
  throwsCode(() => execute('data.window', { items: [{ v: 1 }, { v: '2' }], orderBy: ['v'] }), 'WORKFLOW_ORDER_TYPE_MISMATCH');
  throwsCode(() => execute('data.window', { items: [{}], orderBy: ['v'] }), 'WORKFLOW_FIELD_MISSING');
  throwsCode(() => execute('data.window', { items: [], orderBy: [{ field: 'v', order: 'sideways' }] }), 'WORKFLOW_ARGUMENT_INVALID');
});

test('statistics computes population moments and interpolated quantiles and explicitly represents empty input', () => {
  const result = execute('data.statistics', { items: [2, 4, 4, 4, 5, 5, 7, 9].map((value) => ({ value: String(value) })), field: 'value' });
  assert.deepEqual(result.statistics, { count: 8, min: 2, max: 9, sum: 40, mean: 5, median: 4.5, variance: 4, stddev: 2, q1: 4, q3: 5.5 });
  assert.equal(result.count, 1);
  assert.deepEqual(result.items[0], result.statistics);
  assert.deepEqual(execute('data.statistics', { items: [], field: 'value' }).statistics, { count: 0, min: null, max: null, sum: 0, mean: null, median: null, variance: null, stddev: null, q1: null, q3: null });
  const decimals = execute('data.statistics', { items: Array.from({ length: 1000 }, () => ({ x: 0.1 })), field: 'x' });
  assert.equal(decimals.statistics.sum, 100);
});

test('text transforms honor unicode, null, literal replacement tokens and redact multiple private fields', () => {
  const normalized = execute('data.normalize', { items: [{ name: ' ＡＢＣ ', empty: '  ', other: null }], fields: ['name', 'empty', 'other'], unicode: 'NFKC', case: 'lower', nullEmpty: true });
  assert.deepEqual(normalized.items, [{ name: 'abc', empty: null, other: null }]);
  const replaced = execute('text.replace', { items: [{ note: 'a.a' }], fields: ['note'], search: 'a', replacement: '$&' });
  assert.equal(replaced.items[0].note, '$&.$&');
  const emails = execute('text.redact', { items: [{ note: '담당자 alice+tag@example.co.kr, BOB@EXAMPLE.COM, 전화 010-1234-5678' }], fields: ['note'], preset: 'email', mask: '<hidden>' });
  assert.equal(emails.items[0].note, '담당자 <hidden>, <hidden>, 전화 010-1234-5678');
  const phones = execute('text.redact', { items: [{ note: '01012345678 / +82 10-1234-5678 / (02) 123-4567' }], fields: ['note'], preset: 'phone' });
  assert.equal(phones.items[0].note, '[REDACTED] / [REDACTED] / [REDACTED]');
  assert.equal(execute('text.redact', { items: [{ note: 'a'.repeat(100_000) }], fields: ['note'], preset: 'email' }).items[0].note.length, 100_000);
});

test('own-property path and JSON boundaries reject prototype, getter and cycle attacks', () => {
  for (const field of ['__proto__.x', 'constructor', ['safe', 'prototype']]) {
    throwsCode(() => execute('data.project', { items: [{ safe: {} }], fields: [field] }), 'WORKFLOW_PROPERTY_PATH_UNSAFE');
  }
  throwsCode(() => execute('data.project', { items: [JSON.parse('{"__proto__":{"admin":true}}')], fields: ['admin'] }), 'WORKFLOW_PROPERTY_PATH_UNSAFE');
  let getterCalls = 0;
  const getter = { get value() { getterCalls += 1; return 1; } };
  throwsCode(() => execute('data.project', { items: [getter], fields: ['value'] }), 'WORKFLOW_JSON_VALUE_INVALID');
  assert.equal(getterCalls, 0);
  throwsCode(() => execute('data.project', { items: [Object.create({ inherited: 1 })], fields: ['inherited'] }), 'WORKFLOW_TYPE_MISMATCH');
  const cyclic = {}; cyclic.self = cyclic;
  throwsCode(() => execute('data.limit', { items: [cyclic], count: 1 }), 'WORKFLOW_DATA_CYCLE');
  throwsCode(() => execute('data.limit', { items: [1n], count: 1 }), 'WORKFLOW_JSON_VALUE_INVALID');
  throwsCode(() => execute('data.limit', { items: Array(2), count: 1 }), 'WORKFLOW_JSON_VALUE_INVALID');
});

test('expansion, recursion and row budgets fail before producing unbounded output', () => {
  throwsCode(() => execute('data.limit', { items: Array.from({ length: 10_001 }, () => 1), count: 1 }), 'WORKFLOW_ROW_LIMIT');
  throwsCode(() => execute('data.union', { items: Array(6000).fill(1), others: [Array(6000).fill(2)] }), 'WORKFLOW_ROW_LIMIT');
  const expansion = { items: [{ text: 'x'.repeat(100_000) }], fields: ['text'], search: 'x', replacement: 'y'.repeat(200) };
  throwsCode(() => execute('text.replace', expansion), 'WORKFLOW_DATA_BUDGET_EXCEEDED');
  const aliases = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`copy${index}`, 'text']));
  throwsCode(() => execute('data.project', { items: [{ text: 'x'.repeat(140_000) }], fields: aliases }), 'WORKFLOW_DATA_BUDGET_EXCEEDED');
  let expression = 1;
  for (let i = 0; i < 18; i += 1) expression = { op: 'abs', value: expression };
  throwsCode(() => execute('data.derive', { items: [{}], fields: { result: expression } }), 'WORKFLOW_EXPRESSION_LIMIT');
});

test('invalid options and absent fields fail explicitly even for empty datasets', () => {
  for (const [op, args, code] of [
    ['data.project', { items: [], fields: [] }, 'WORKFLOW_FIELDS_INVALID'],
    ['data.normalize', { items: [], fields: ['x'], trim: 'yes' }, 'WORKFLOW_ARGUMENT_INVALID'],
    ['data.limit', { items: [], count: -1 }, 'WORKFLOW_ARGUMENT_INVALID'],
    ['text.replace', { items: [], fields: ['x'], search: '', replacement: 'z' }, 'WORKFLOW_ARGUMENT_INVALID'],
    ['text.redact', { items: [], fields: ['x'], preset: 'everything' }, 'WORKFLOW_ARGUMENT_INVALID'],
    ['data.normalize', { items: [{ x: 1 }], fields: ['x'] }, 'WORKFLOW_TYPE_MISMATCH'],
    ['data.flatten', { items: [{}], field: 'x' }, 'WORKFLOW_FIELD_MISSING'],
    ['data.project', { items: [{ x: 1 }], fields: ['missing'] }, 'WORKFLOW_FIELD_MISSING']
  ]) throwsCode(() => execute(op, args), code);
  throwsCode(() => execute('data.eval', {}), 'WORKFLOW_OPERATION_UNSUPPORTED');
});
