import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
  IMPOSSIBLE_WORKFLOW_SCHEMA_VERSION,
  createImpossibleWorkflow30CorpusFingerprint,
  impossibleWorkflow30Cases,
  materializeImpossibleCommand
} from '../scripts/impossible-workflow-30-cases.mjs';
import { fixtureIds, materializeImpossibleWorkflow30Fixture } from '../scripts/impossible-workflow-30-fixtures.mjs';

const allowedOperations = new Set([
  'data.readJson', 'data.readCsv', 'text.read', 'data.filter', 'data.sort', 'data.unique', 'data.groupAggregate', 'data.join', 'data.pivot', 'data.validate',
  'compute.ledger', 'compute.units', 'graph.toposort', 'graph.shortestPath', 'graph.criticalPath', 'solver.knapsack', 'solver.schedule',
  'fs.inventory', 'fs.search', 'fs.duplicates', 'text.stats', 'template.renderMany', 'process.run', 'process.pipeline', 'sqlite.import', 'sqlite.query',
  'write.json', 'write.csv', 'write.text', 'assert.count', 'assert.equals'
]);

test('impossible workflow corpus is frozen at exactly 30 distinct natural-language missions', () => {
  assert.equal(impossibleWorkflow30Cases.length, 30);
  assert.equal(new Set(impossibleWorkflow30Cases.map((item) => item.id)).size, 30);
  assert.deepEqual(fixtureIds(), impossibleWorkflow30Cases.map((item) => item.id).sort());
  assert.equal(IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256, '762029795b18e71bb1e2fe15958f90dbe580a5e707779cab91f34863366da047');
  assert.equal(createImpossibleWorkflow30CorpusFingerprint().corpusSha256, IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256);
  for (const item of impossibleWorkflow30Cases) {
    assert.equal(item.workflow.schemaVersion, IMPOSSIBLE_WORKFLOW_SCHEMA_VERSION);
    assert.match(item.specFilename, /^[a-z0-9-]+\.workflow\.json$/u);
    assert.match(item.commandTemplate, /<CASE_DIR>\/.*\.workflow\.json/u);
    assert.match(item.commandTemplate, /workflow\.execute/u);
    assert.match(item.commandTemplate, /shell\.execute/u);
    assert.equal(item.workflow.nodes.length >= 4, true, item.id);
    assert.equal(item.workflow.outputs.length >= 2, true, item.id);
    assert.equal(new Set(item.workflow.nodes.map((node) => node.id)).size, item.workflow.nodes.length, item.id);
    const seen = new Set();
    for (const node of item.workflow.nodes) {
      assert.equal(allowedOperations.has(node.op), true, `${item.id}:${node.op}`);
      for (const dependency of node.dependsOn ?? []) assert.equal(seen.has(dependency), true, `${item.id}:${node.id}->${dependency}`);
      seen.add(node.id);
    }
    assert.equal(item.workflow.nodes.some((node) => node.op.startsWith('write.')), true, item.id);
  }
});

test('fixture materializer writes the exact frozen workflow spec and keeps the command path concrete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-workflow-fixture-'));
  try {
    for (const testCase of impossibleWorkflow30Cases) {
      const caseDir = join(root, testCase.id);
      const materialized = await materializeImpossibleWorkflow30Fixture(testCase, caseDir);
      const parsed = JSON.parse(await readFile(materialized.specPath, 'utf8'));
      assert.deepEqual(parsed, JSON.parse(JSON.stringify(testCase.workflow)), testCase.id);
      assert.equal(materialized.files.length >= 1, true, testCase.id);
      assert.match(materialized.inputManifestSha256, /^[a-f0-9]{64}$/u);
      const command = materializeImpossibleCommand(testCase, caseDir);
      assert.equal(command.includes('<CASE_DIR>'), false);
      assert.equal(command.includes(testCase.specFilename), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
