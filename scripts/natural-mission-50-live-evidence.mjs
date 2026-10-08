import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { probeProductServices } from './product-runtime.mjs';

const root = resolve('artifacts/natural-mission-50-audit');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const missions = (await json('logs/missions.json')).missions
  .filter(mission => mission.objective.includes('natural-mission-live-20260908/source.json'))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
assert.equal(missions.length, 3);
assert.deepEqual(missions.map(mission => mission.status), ['BLOCKED', 'BLOCKED', 'COMPLETED']);
const final = missions.at(-1);
assert.equal(final.completion.status, 'verified');
assert.equal(final.observations[0].verification.status, 'passed');
assert.equal(final.observations[0].data.workflow.nodeCount, 8);
const source = await json('workspace/natural-mission-live-20260908/source.json');
const ranked = await json('workspace/natural-mission-live-20260908/ranked.json');
const stats = await json('workspace/natural-mission-live-20260908/stats.json');
assert.deepEqual(ranked, source.map(row => ({ ...row, 금액: row.수량 * row.가격 })).sort((a, b) => b.금액 - a.금액));
assert.equal(stats.sum, 103);
assert.equal(stats.median, 35);
assert.equal(stats.count, 3);
const journals = [];
for (const original of await json(join(root, 'validation/production-undo-before-ui.json'))) {
  const bytes = await readFile(original.path);
  assert.equal(sha(bytes.subarray(0, original.size)), original.sha256);
  journals.push({ ...original, currentSize: bytes.length, prefixIntact: true, appendedBytes: bytes.length - original.size });
}
const status = await probeProductServices();
assert.equal(status.operational, true);
await writeFile(join(root, 'validation/live-ui-final-mission.json'), JSON.stringify(final, null, 2));
const proof = {
  capturedAt: new Date().toISOString(), status: 'PASSED', method: 'Observed in CUA browser: quick-task textbox, execute button, automatic mission routing and owner-session renewal; final DOM showed 완료 1/1 and 검증 완료, no approval question; zero warning/error console entries.',
  missions: missions.map(mission => ({ missionId: mission.missionId, status: mission.status, stopReason: mission.stopReason, createdAt: mission.createdAt })),
  finalMissionId: final.missionId, nodeCount: 8, completion: final.completion.status,
  outputValues: { ranked, stats },
  outputFiles: await Promise.all(['source.json', 'ranked.json', 'stats.json'].map(async name => {
    const path = resolve('workspace/natural-mission-live-20260908', name); const bytes = await readFile(path);
    return { path, sha256: sha(bytes), size: bytes.length };
  })),
  productionUndoJournals: journals, services: status
};
await writeFile(join(root, 'validation/live-qa.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ status: proof.status, finalMissionId: final.missionId, services: status.status, journals }, null, 2));
