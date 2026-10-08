import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWearableFieldServer,
  listenWearableFieldServer
} from '../apps/wearable-hud/src/field-server.mjs';
import { createWearablePhysicalFieldReport } from '../apps/wearable-hud/src/field-lab.js';

async function listen(server) {
  return (await listenWearableFieldServer(server)).port;
}

test('wearable field draft resumes privacy-safe aggregate evidence and detects tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-field-resume-'));
  const evidenceDir = join(root, 'field-evidence');
  const server = createWearableFieldServer({ root, evidenceDir, now: () => new Date('2026-08-30T00:00:00.000Z') });
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/field-draft`;
    const report = createWearablePhysicalFieldReport({
      physicalDeviceConfirmed: true,
      capability: { secureContext: true },
      display: {
        viewport: { width: 320, height: 427 },
        layout: { horizontalOverflowPx: 0 },
        privacy: { screenshotStored: false }
      },
      scenarios: { indoorReadability: true }
    });
    const stored = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-jarvis-wearable-request': 'physical-field-draft-v1' },
      body: JSON.stringify(report)
    });
    assert.equal(stored.status, 200);
    const restored = await fetch(url, { headers: { 'x-jarvis-wearable-request': 'physical-field-draft-v1' } });
    const envelope = await restored.json();
    assert.equal(restored.status, 200);
    assert.equal(envelope.report.summary.totalChecks, 12);
    assert.equal(envelope.report.scenarios.indoorReadability, true);
    assert.equal(JSON.stringify(envelope).includes('raw transcript text'), false);

    const rejected = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-jarvis-wearable-request': 'physical-field-draft-v1' },
      body: JSON.stringify({ ...report, token: 'must-not-store' })
    });
    assert.equal(rejected.status, 422);

    const cleared = await fetch(url, { method: 'DELETE', headers: { 'x-jarvis-wearable-request': 'physical-field-draft-v1' } });
    assert.equal(cleared.status, 200);
    assert.equal((await fetch(url, { headers: { 'x-jarvis-wearable-request': 'physical-field-draft-v1' } })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
