import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationContext } from '../src/ui/conversation-context.js';

test('a control center conversation survives reload while different endpoints and tabs remain separate', () => {
  const state = new Map();
  const storage = { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value) };
  let count = 0;
  const makeId = () => `id-${++count}`;
  const first = createConversationContext({ storage, makeId });
  const conversation = first.idFor('/api/core/');
  assert.equal(first.idFor('/api/core'), conversation);
  const reload = createConversationContext({ storage, makeId });
  assert.equal(reload.idFor('/api/core'), conversation);
  assert.notEqual(reload.idFor('http://other-core.test'), conversation);
  assert.notEqual(createConversationContext({ storage: null, makeId }).idFor('/api/core'), conversation);
});

test('blocked storage still retains a consistent conversation for commands in the same page', () => {
  const brokenStorage = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } };
  const context = createConversationContext({ storage: brokenStorage, makeId: () => 'ephemeral' });
  assert.equal(context.idFor('/api/core'), context.idFor('/api/core'));
});
