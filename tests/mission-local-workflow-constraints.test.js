import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { verifyLocalWorkflowConstraints } from '../packages/core/src/mission/mission-local-workflow-constraints.js';

const root = resolve('isolated-constraint-fixture');
function fixture() {
  const spec = { nodes: [{ id: 'read', op: 'data.readCsv', args: { path: resolve(root, 'inputs/a.csv') } },
    { id: 'write', op: 'write.csv', args: { path: resolve(root, 'outputs/result.csv') } }] };
  const action = { actionId: 'local-workflow', operation: { dispatch: { arguments: { spec } } } };
  const mission = { constraints: [`허용 루트는 ${root} 하나이다.`, '외부 네트워크·계정·전송을 사용하지 않는다.',
    '명령에 명시된 입력 파일만 읽고 원본 파일을 수정하지 않는다.'], waves: [{ actions: [action] }] };
  return { mission, action, spec, roots: [root] };
}

test('bounded local constraints require the exact sole executed spec and disjoint original inputs and writes', () => {
  const f = fixture(), proof = verifyLocalWorkflowConstraints(f);
  assert.equal(proof.passed, true);
  assert.deepEqual(proof.checks.map(item => item.check), ['single-allowed-root', 'local-adapter-operations-only', 'declared-inputs-preserved']);
});

test('plain Korean workspace and no-transfer constraints are checked against the executed local-only spec', () => {
  const f = fixture();
  f.mission.constraints = ['작업공간 안의 파일만 읽고 쓴다.', '외부 전송은 하지 않는다.'];
  const proof = verifyLocalWorkflowConstraints(f);
  assert.equal(proof.passed, true);
  assert.deepEqual(proof.checks.map(item => item.check), ['workspace-only-file-effects', 'no-external-transfer']);
  f.spec.nodes.push({ id: 'remote', op: 'browser.search', args: {} });
  assert.equal(verifyLocalWorkflowConstraints(f).passed, false);
});

test('short no-transfer constraint retains exact local-only proof and rejects unknown additions',()=>{
 const f=fixture();f.mission.constraints=['외부 전송 금지'];assert.equal(verifyLocalWorkflowConstraints(f).passed,true);
 f.spec.nodes.push({id:'send',op:'mail.send',args:{}});assert.equal(verifyLocalWorkflowConstraints(f).passed,false);
 f.mission.constraints=['외부 전송 금지, 단 예외 허용'];assert.equal(verifyLocalWorkflowConstraints(f).passed,false);
});

test('bounded local constraints accept SQLite outputs while keeping imported data read-only and SQL queries read-only', () => {
  const make = () => {
    const f = fixture(), databasePath = resolve(root, 'outputs/store.sqlite');
    f.spec.nodes.push({ id: 'import', op: 'sqlite.import', dependsOn: ['read'], args: {
      items: { $ref: { nodeId: 'read', pointer: '/items', expectedType: 'array' } }, databasePath, table: 'records', mode: 'replace' } },
    { id: 'query', op: 'sqlite.query', dependsOn: ['import'], args: {
      databasePath: { $ref: { nodeId: 'import', pointer: '', expectedType: 'object' } }, sql: 'SELECT * FROM "records"' } });
    return f;
  };
  assert.equal(verifyLocalWorkflowConstraints(make()).passed, true);
  for (const mutate of [
    value => { value.spec.nodes.find(node => node.op === 'sqlite.import').args.databasePath = value.spec.nodes[0].args.path; },
    value => { value.spec.nodes.at(-1).args.sql = 'DELETE FROM "records"'; },
    value => { value.spec.nodes.find(node => node.op === 'sqlite.import').args.databasePath = resolve(root, '../outside.sqlite'); }
  ]) { const value = make(); mutate(value); assert.equal(verifyLocalWorkflowConstraints(value).passed, false); }
});

test('unknown or appended constraint claims cannot piggyback on a supported clause', () => {
  for (const statement of ['fixtures 외 파일을 읽거나 덮어쓰지 않는다.', '외부 네트워크·계정·전송을 사용하지 않는다. 결과는 의학적으로 안전하다.',
    '원본이 절대 변하지 않았고 법적 효력이 있다.']) {
    const f = fixture(); f.mission.constraints = [statement];
    assert.equal(verifyLocalWorkflowConstraints(f).passed, false);
    assert.equal(verifyLocalWorkflowConstraints(f).checks[0].supported, false);
  }
});

test('process or SQLite mutation operations never satisfy the bounded network and input-preservation constraint', () => {
  for (const op of ['process.run', 'process.pipeline', 'sqlite.import', 'sqlite.query', 'new.remoteWrite']) {
    const f = fixture(); f.spec.nodes.push({ id: 'effect', op, args: {} });
    assert.equal(verifyLocalWorkflowConstraints(f).passed, false, op);
  }
});

test('original overwrite, overlapping read directory, wrong root and a hidden earlier dispatch are rejected', () => {
  const mutations = [
    f => { f.spec.nodes[1].args.path = f.spec.nodes[0].args.path; },
    f => { f.action.operation.dispatch.arguments.allowOverwrite = true; },
    f => { f.spec.nodes.unshift({ id: 'inventory', op: 'fs.inventory', args: { path: root } }); },
    f => { f.spec.nodes[1].args.path = resolve(root, '../outside.txt'); },
    f => { f.mission.constraints[0] = `허용 루트는 ${resolve(root, '../other')} 하나이다.`; },
    f => { f.roots.push(resolve(root, '../other')); },
    f => { f.mission.waves[0].actions.push({ actionId: 'hidden', operation: { dispatch: { toolName: 'shell.execute', arguments: {} } } }); },
    f => { f.action.operation.dispatch.arguments.spec = { nodes: [] }; }
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(verifyLocalWorkflowConstraints(f).passed, false); }
});
