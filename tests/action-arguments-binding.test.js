import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { actionArgumentsBinding } from '../packages/shared/src/action-arguments-binding.js';

test('action binding matches independently fixed canonical bytes and ignores object insertion order', () => {
  const first = { z: [null, false, 2], a: { y: 'value', b: true } };
  const reordered = { a: { b: true, y: 'value' }, z: [null, false, 2] };
  const expected = createHash('sha256').update('{"a":{"b":true,"y":"value"},"z":[null,false,2]}').digest('hex');
  assert.deepEqual(actionArgumentsBinding(first), { version: 'e-action-arguments-v1', argumentsSha256: expected });
  assert.deepEqual(actionArgumentsBinding(reordered), actionArgumentsBinding(first));
});

test('JSON roundtrip preserves bindings for Unicode, escape sequences, arrays, primitives and null-prototype records', () => {
  const record = Object.assign(Object.create(null), { path: '자료/설교.txt', content: '가나다\n"quotes"\t\\slashes\u0000😀', '"key\\': [1, null, true] });
  const values = [record, { '__proto__': null, number: 1.5, exponent: 1e30 }, [false, '한글', [], {}], null, true, 'text', 0, 1.5];
  for (const value of values) {
    const bound = actionArgumentsBinding(value);
    assert.ok(bound, 'a supported JSON value must bind');
    assert.deepEqual(actionArgumentsBinding(JSON.parse(JSON.stringify(value))), bound);
  }
});

test('meaningful argument changes never share the original binding', () => {
  const original = { path: 'approved.txt', content: 'approved', allowOverwrite: false };
  const digest = actionArgumentsBinding(original).argumentsSha256;
  for (const changed of [
    { ...original, path: 'other.txt' }, { ...original, content: 'other' }, { ...original, allowOverwrite: true },
    { path: 'approved.txt', content: 'approved' }, { ...original, content: null }, { ...original, extra: 'condition' }
  ]) assert.notEqual(actionArgumentsBinding(changed)?.argumentsSha256, digest);
  assert.notDeepEqual(actionArgumentsBinding([1, 2]), actionArgumentsBinding([2, 1]));
  assert.notDeepEqual(actionArgumentsBinding({ value: 1 }), actionArgumentsBinding({ value: '1' }));
  assert.notDeepEqual(actionArgumentsBinding({ a: 'b,c:d' }), actionArgumentsBinding({ a: 'b', c: 'd' }));
});

test('non-JSON primitives and nested lossy values cannot receive an execution binding', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol('x'), () => {},
    { omitted: undefined }, { value: NaN }, { value: -0 }, [undefined], [1n], { nested: { value: () => {} } }]) {
    assert.equal(actionArgumentsBinding(value), null);
  }
});

test('special objects, sparse or extended arrays and own symbol fields fail closed', () => {
  class Custom { constructor() { this.path = 'hidden-semantics.txt'; } }
  const extended = [1]; extended.extra = 'not transported';
  const symbolRecord = { path: 'x.txt', [Symbol('hidden')]: 'secret' };
  for (const value of [new Date(0), new Map([['path', 'x']]), new Set([1]), /pattern/u, new Number(1), new Custom(),
    new Uint8Array([1]), Array(2), [1, , 3], extended, symbolRecord]) assert.equal(actionArgumentsBinding(value), null);
});

test('accessor arguments are rejected without invoking any getter', () => {
  let reads = 0;
  const enumerable = Object.defineProperty({}, 'path', { enumerable: true, get() { reads++; return 'unexpected.txt'; } });
  const nonEnumerable = Object.defineProperty({}, 'path', { enumerable: false, get() { reads++; return 'unexpected.txt'; } });
  assert.equal(actionArgumentsBinding(enumerable), null);
  assert.equal(actionArgumentsBinding(nonEnumerable), null);
  assert.equal(reads, 0);
});

test('hidden own fields cannot be silently omitted from a lossless argument contract', () => {
  const hiddenData = Object.defineProperty({ content: 'visible' }, 'path', { value: 'unbound.txt', enumerable: false });
  const hiddenToJson = Object.defineProperty({ path: 'approved.txt' }, 'toJSON', { value: () => ({ path: 'changed.txt' }), enumerable: false });
  const extendedArray = Object.defineProperty([1], 'effect', { value: 'unbound', enumerable: false });
  assert.equal(actionArgumentsBinding(hiddenData), null);
  assert.equal(actionArgumentsBinding(hiddenToJson), null);
  assert.equal(actionArgumentsBinding(extendedArray), null);
});

test('cycles are rejected while repeated acyclic values remain ordinary JSON', () => {
  const cyclic = { path: 'x' }; cyclic.self = cyclic;
  const cyclicArray = []; cyclicArray.push(cyclicArray);
  assert.equal(actionArgumentsBinding(cyclic), null); assert.equal(actionArgumentsBinding(cyclicArray), null);
  const repeated = { content: 'shared' }, value = [repeated, repeated];
  assert.deepEqual(actionArgumentsBinding(value), actionArgumentsBinding([{ content: 'shared' }, { content: 'shared' }]));
});
