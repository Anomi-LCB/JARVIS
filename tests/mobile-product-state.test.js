import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMobileProductState } from '../apps/mobile/src/state/mobile-product-demo.js';

test('mobile production state never pre-fills a fake pairing credential', () => {
  const state = createMobileProductState();

  assert.equal(state.device.paired, false);
  assert.equal(state.device.pairingStatus, 'unpaired');
  assert.equal(state.device.pairingCode, '');
});

test('mobile disconnect clears the in-memory pairing credential', async () => {
  const source = await readFile('apps/mobile/src/App.tsx', 'utf8');
  const disconnectBody = source.match(/async function disconnect\(\) \{([\s\S]*?)\n  \}\n\n  async function submitCommand/)?.[1] ?? '';

  assert.match(disconnectBody, /pairingStatus:\s*'unpaired'/);
  assert.match(disconnectBody, /pairingCode:\s*''/);
  assert.match(disconnectBody, /SecureStore\.deleteItemAsync\(storageKeys\.deviceToken\)/);
  assert.match(disconnectBody, /SecureStore\.deleteItemAsync\(storageKeys\.bridgeUrl\)/);
});
