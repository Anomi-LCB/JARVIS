import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  MAXIMUM_WORKFLOW_NODES,
  resolveWorkflowValue,
  topologicalWaves,
  validateWorkflowSpec
} from '../packages/core/src/mission/workflow-ir.js';
import {
  compileLocalWorkflowMission,
  extractLocalWorkflowSpecPath
} from '../packages/core/src/mission/workflow-natural-compiler.js';

function validSpec() {
  return {
    schemaVersion: 'jarvis-local-workflow-v1',
    workflowId: 'orders-summary',
    description: 'Paid-order summary workflow',
    nodes: [
      { id: 'read', op: 'data.readJson', args: { path: 'orders.json' } },
      {
        id: 'filter',
        op: 'data.filter',
        dependsOn: ['read'],
        args: {
          rows: { $ref: { nodeId: 'read', pointer: '/rows', expectedType: 'array' } },
          field: 'status',
          equals: 'paid'
        },
        retry: { maxAttempts: 2, backoffMs: 10 }
      },
      {
        id: 'stats',
        op: 'text.stats',
        dependsOn: ['read'],
        args: { text: { $ref: { nodeId: 'read', pointer: '/note', expectedType: 'string' } } }
      },
      {
        id: 'write',
        op: 'write.json',
        dependsOn: ['filter', 'stats'],
        args: {
          outputPath: 'customer-summary.json',
          data: { $ref: { nodeId: 'filter', expectedType: 'array' } }
        }
      }
    ],
    outputs: [{ nodeId: 'write', path: 'customer-summary.json', mediaType: 'application/json' }]
  };
}

test('typed workflow IR validates and creates stable topological waves', () => {
  const normalized = validateWorkflowSpec(validSpec());
  assert.equal(normalized.schemaVersion, 'jarvis-local-workflow-v1');
  assert.equal(normalized.description, 'Paid-order summary workflow');
  assert.deepEqual(normalized.outputs, [
    { nodeId: 'write', path: 'customer-summary.json', mediaType: 'application/json' }
  ]);
  assert.deepEqual(normalized.nodes[0].dependsOn, []);
  assert.deepEqual(normalized.nodes[0].args, { path: 'orders.json' });
  assert.deepEqual(
    topologicalWaves(validSpec()).map((wave) => wave.map((node) => node.id)),
    [['read'], ['filter', 'stats'], ['write']]
  );
});

test('typed references resolve nested values, escaped JSON pointers, and clone outputs', () => {
  const outputs = new Map([['source', {
    rows: [{ customer: 'A', total: 12 }],
    'a/b': { '~score': 9 }
  }]]);
  const resolved = resolveWorkflowValue({
    rows: { $ref: { nodeId: 'source', pointer: '/rows', expectedType: 'array' } },
    score: { $ref: { nodeId: 'source', pointer: '/a~1b/~0score', expectedType: 'integer' } }
  }, outputs);

  assert.deepEqual(resolved, { rows: [{ customer: 'A', total: 12 }], score: 9 });
  resolved.rows[0].total = 999;
  assert.equal(outputs.get('source').rows[0].total, 12);
  assert.throws(
    () => resolveWorkflowValue(
      { $ref: { nodeId: 'source', pointer: '/rows', expectedType: 'object' } },
      outputs
    ),
    (error) => error?.code === 'B_WORKFLOW_REFERENCE_TYPE_MISMATCH'
  );
});

test('workflow IR rejects duplicate ids, unsupported operations, unknown dependencies, and cycles', async (t) => {
  await t.test('duplicate id', () => {
    const spec = validSpec();
    spec.nodes[1].id = 'read';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_NODE_DUPLICATE');
  });
  await t.test('unsupported operation', () => {
    const spec = validSpec();
    spec.nodes[0].op = 'javascript.eval';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_OPERATION_UNSUPPORTED');
  });
  await t.test('unknown dependency', () => {
    const spec = validSpec();
    spec.nodes[1].dependsOn = ['missing'];
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_DEPENDENCY_UNKNOWN');
  });
  await t.test('dependency cycle', () => {
    const spec = validSpec();
    spec.nodes[0].dependsOn = ['write'];
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_DEPENDENCY_CYCLE');
  });
});

test('workflow IR rejects unsafe, malformed, and undeclared references', async (t) => {
  await t.test('reference must point to a declared predecessor', () => {
    const spec = validSpec();
    spec.nodes[1].dependsOn = [];
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_REFERENCE_UNSAFE');
  });
  await t.test('reference cannot address prototype properties', () => {
    const spec = validSpec();
    spec.nodes[1].args.rows.$ref.pointer = '/__proto__/polluted';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_REFERENCE_UNSAFE');
  });
  await t.test('reference shape is exact', () => {
    const spec = validSpec();
    spec.nodes[1].args.rows.extra = true;
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_UNKNOWN_FIELD');
  });
  await t.test('pointer escape must be RFC 6901', () => {
    const spec = validSpec();
    spec.nodes[1].args.rows.$ref.pointer = '/bad~2escape';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_REFERENCE_INVALID');
  });
});

test('workflow IR enforces the 64-node execution bound', () => {
  const nodes = Array.from({ length: MAXIMUM_WORKFLOW_NODES + 1 }, (_, index) => ({
    id: `node_${index}`,
    op: 'write.text',
    args: { path: `${index}.txt`, content: 'bounded' }
  }));
  assert.throws(
    () => validateWorkflowSpec({ schemaVersion: 'jarvis-local-workflow-v1', workflowId: 'too-large', nodes }),
    (error) => error?.code === 'A_WORKFLOW_NODE_LIMIT'
  );
});

test('workflow IR rejects unsafe or unbound declared outputs', async (t) => {
  await t.test('output node must exist', () => {
    const spec = validSpec();
    spec.outputs[0].nodeId = 'missing';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_OUTPUT_NODE_UNKNOWN');
  });
  await t.test('output path stays relative', () => {
    const spec = validSpec();
    spec.outputs[0].path = '../outside.json';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_OUTPUT_PATH_INVALID');
  });
  await t.test('output media type is bounded', () => {
    const spec = validSpec();
    spec.outputs[0].mediaType = 'not-a-media-type';
    assert.throws(() => validateWorkflowSpec(spec), (error) => error?.code === 'A_WORKFLOW_OUTPUT_MEDIA_TYPE_INVALID');
  });
});

test('natural workflow compiler extracts a Korean particle-suffixed relative path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-compiler-'));
  try {
    await mkdir(join(root, 'I01'), { recursive: true });
    await writeFile(join(root, 'I01/orders.workflow.json'), JSON.stringify(validSpec()));
    const context = {
      workspaceRoot: root,
      mission: {
        objective: 'I01/orders.workflow.json에 정의된 검증 워크플로를 실행하고 customer-summary.json을 생성해.',
        successCriteria: [
          { criterionId: 'criterion_1' },
          { criterionId: 'criterion_2' }
        ]
      },
      observations: []
    };
    const plan = compileLocalWorkflowMission(context);

    assert.equal(plan.decision, 'continue');
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].expectedToolName, 'workflow.execute');
    assert.equal(plan.actions[0].arguments.specPath, resolve(root, 'I01/orders.workflow.json'));
    assert.equal(plan.criteriaAssessment.every((criterion) => criterion.status === 'unsatisfied'), true);
    assert.equal(plan.planning.modelRoundTrips, 0);

    const completed = compileLocalWorkflowMission({
      ...context,
      observations: [{
        actionId: 'mission_action_1',
        toolName: 'workflow.execute',
        outcome: 'success',
        verification: { status: 'passed' }
      }]
    });
    assert.equal(completed.decision, 'complete');
    assert.deepEqual(completed.criteriaAssessment.map((criterion) => criterion.status), ['satisfied', 'satisfied']);
    assert.deepEqual(completed.criteriaAssessment[0].evidenceActionIds, ['mission_action_1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('natural workflow compiler accepts quoted absolute paths and fails closed outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'jarvis-workflow-outside-'));
  try {
    const insidePath = join(root, 'folder with spaces', 'safe.workflow.json');
    await mkdir(join(root, 'folder with spaces'), { recursive: true });
    await writeFile(insidePath, JSON.stringify(validSpec()));
    const inside = compileLocalWorkflowMission({
      workspaceRoot: root,
      mission: { objective: `"${insidePath}"를 실행해`, successCriteria: [] },
      observations: []
    });
    assert.equal(inside.decision, 'continue');
    assert.equal(inside.actions[0].arguments.specPath, resolve(insidePath));

    const outsidePath = join(outside, 'escape.workflow.json');
    const blocked = compileLocalWorkflowMission({
      workspaceRoot: root,
      mission: { objective: `"${outsidePath}"를 실행해`, successCriteria: [{ criterionId: 'criterion_1' }] },
      observations: []
    });
    assert.equal(blocked.decision, 'blocked');
    assert.equal(blocked.blockedReason, 'local-workflow-spec-outside-workspace');
    assert.equal(extractLocalWorkflowSpecPath(`../${outsidePath.split(/[\\/]/u).at(-1)}를 실행해`, root), null);
    assert.equal(compileLocalWorkflowMission({
      workspaceRoot: root,
      mission: { objective: '일반 파일 정리를 실행해', successCriteria: [] },
      observations: []
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('natural workflow compiler requires passed G verification before completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-verification-gate-'));
  try {
    const context = {
      workspaceRoot: root,
      mission: {
        objective: 'target.workflow.json을 실행해',
        successCriteria: [{ criterionId: 'criterion_1' }]
      },
      observations: [{
        actionId: 'mission_action_1',
        toolName: 'workflow.execute',
        outcome: 'success',
        verification: { status: 'failed' }
      }]
    };

    const plan = compileLocalWorkflowMission(context);

    assert.equal(plan.decision, 'blocked');
    assert.equal(plan.blockedReason, 'local-workflow-verification-failed');
    assert.equal(plan.criteriaAssessment[0].status, 'unsatisfied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow paths may use a normal directory whose name begins with two dots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workflow-dot-prefix-'));
  try {
    const path = join(root, '..safe', 'target.workflow.json');
    assert.equal(extractLocalWorkflowSpecPath('..safe/target.workflow.json을 실행해', root), path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
