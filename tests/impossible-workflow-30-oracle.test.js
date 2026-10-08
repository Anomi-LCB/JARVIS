import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
  impossibleWorkflow30OracleContracts,
  verifyImpossibleWorkflow30Case
} from '../scripts/impossible-workflow-30-oracle.mjs';
import { impossibleWorkflow30Cases } from '../scripts/impossible-workflow-30-cases.mjs';
import { materializeImpossibleWorkflow30Fixture } from '../scripts/impossible-workflow-30-fixtures.mjs';

test('independent oracle contracts are a separate frozen 30-case set', () => {
  assert.equal(impossibleWorkflow30OracleContracts.length, 30);
  assert.equal(new Set(impossibleWorkflow30OracleContracts.map((item) => item.caseId)).size, 30);
  assert.equal(IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256, '8b221098309064bb9a4e5a6bec82b064d3ce45b9125366639f04cc5d40530a47');
  assert.equal(Object.isFrozen(impossibleWorkflow30OracleContracts), true);
  assert.equal(Object.isFrozen(impossibleWorkflow30OracleContracts[0].expected), true);
});

test('independent oracle accepts directly constructed correct bytes and rejects tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-oracle-'));
  try {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', 'unit-conversion.json'), '{"value":1250000}\n', 'utf8');
    await writeFile(join(root, 'outputs', 'unit-conversion-proof.json'), '{"passed":true,"count":1}\n', 'utf8');
    const passing = await verifyImpossibleWorkflow30Case('IW10', root);
    assert.equal(passing.passed, true, JSON.stringify(passing));
    await writeFile(join(root, 'outputs', 'unit-conversion.json'), '{"value":1249999}\n', 'utf8');
    const tampered = await verifyImpossibleWorkflow30Case('IW10', root);
    assert.equal(tampered.passed, false);
    assert.equal(tampered.checks.some((item) => item.checkId === 'numeric_value_exact' && !item.passed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent oracle fails closed when product outputs are absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-oracle-missing-'));
  try {
    const result = await verifyImpossibleWorkflow30Case('IW01', root);
    assert.equal(result.passed, false);
    assert.equal(result.checks.filter((item) => !item.passed).length >= 2, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent oracle rejects previously accepted token bags and fabricated semantics', async () => {
  const attacks = {
    IW04: { primary: 'expense-pivot.json', value: { items: [{ department: '개발' }, { '01': 125 }, { '02': 150 }, { department: '영업' }, { '01': 80 }, { '02': 120 }] } },
    IW07: { primary: 'customer-orders.json', value: { items: [{ id: 'o1', customerId: 'c2' }, { id: 'o2', customerId: 'c1' }] } },
    IW12: { primary: 'priced-products.json', value: { items: [{ sku: 'p1' }, { sku: 'p2' }] } },
    IW17: { primary: 'resource-schedule.json', value: { items: [
      { id: 'A', start: 0, end: 3, resource: 0 }, { id: 'B', start: 0, end: 2, resource: 0 },
      { id: 'C', start: 0, end: 4, resource: 0 }, { id: 'D', start: 0, end: 1, resource: 0 },
      { id: 'E', start: 0, end: 2, resource: 0 }
    ] } },
    IW19: { primary: 'tree-inventory.json', value: { items: ['a/report.txt', 'b/nested/log.txt', 'b/nested/copy.txt', 'c/copy-again.txt', 'c/notes.md'].map((path) => ({ path, size: 1, sha256: 'a'.repeat(64) })) } },
    IW20: { primary: 'error-search.json', value: { items: ['ERROR-101', 'ERROR-203', 'ERROR-404'].map((match) => ({ path: 'wrong.txt', match, index: 0 })) } },
    IW21: { primary: 'duplicate-groups.json', value: { groups: [{ sha256: 'b'.repeat(64), files: ['b/nested/copy.txt', 'c/copy-again.txt'] }] } },
    IW23: { primary: 'rendered-documents.json', value: { items: [{ text: '{{name}} O-1 가람' }, { text: '{{name}} O-2 나래' }, { text: '{{name}} O-3 다온' }] } },
    IW29: { primary: 'sqlite-summary.csv', csv: 'category,total\nA,15\nB,23\n', database: 'transactions.db' },
    IW30: { primary: 'sqlite-inventory.csv', csv: 'id,name,quantity\ni1,연필,10\ni2,공책,8\ni3,지우개,4\n', database: 'inventory.db' }
  };
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-oracle-attacks-'));
  try {
    for (const [caseId, attack] of Object.entries(attacks)) {
      const caseRoot = join(root, caseId);
      const testCase = impossibleWorkflow30Cases.find((item) => item.id === caseId);
      await materializeImpossibleWorkflow30Fixture(testCase, caseRoot);
      await mkdir(join(caseRoot, 'outputs'), { recursive: true });
      await writeFile(join(caseRoot, 'outputs', attack.primary), attack.csv ?? `${JSON.stringify(attack.value)}\n`, 'utf8');
      await writeFile(join(caseRoot, 'outputs', attack.primary.replace(/\.(?:json|csv)$/u, '-proof.json')), '{"passed":true}\n', 'utf8');
      if (attack.database) await writeFile(join(caseRoot, 'outputs', attack.database), 'NOT_A_SQLITE_DATABASE', 'utf8');
      const result = await verifyImpossibleWorkflow30Case(caseId, caseRoot);
      assert.equal(result.passed, false, `${caseId} should reject fabricated semantics`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proof must assert top-level passed=true and contain no explicit false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-impossible-proof-'));
  try {
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', 'unit-conversion.json'), '{"value":1250000}\n', 'utf8');
    for (const proof of ['{}\n', '{"passed":false}\n', '{"passed":true,"nested":{"passed":false}}\n']) {
      await writeFile(join(root, 'outputs', 'unit-conversion-proof.json'), proof, 'utf8');
      const result = await verifyImpossibleWorkflow30Case('IW10', root);
      assert.equal(result.passed, false);
      assert.equal(result.checks.some((item) => item.checkId === 'proof_assertion_passed' && !item.passed), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
