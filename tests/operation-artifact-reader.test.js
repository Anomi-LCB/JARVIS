import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rename, symlink, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationArtifactReader } from '../apps/pc-agent/src/operation-artifact-reader.js';
import { executionPacketFingerprint } from '../packages/shared/src/execution-packet-fingerprint.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'jarvis-artifact-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, 'result.txt'), taskId = 'task_한글', operationId = `mission_op_${'a'.repeat(32)}`;
  const action = { toolName: 'filesystem.createTextFile', arguments: { path, content: '검증할 원문' } };
  await writeFile(path, action.arguments.content);
  const record = { operationId, taskId, fingerprint: executionPacketFingerprint({ taskId, action, requestedMode: 'execute' }),
    state: 'succeeded', executionAuthority: false, receipt: { taskId, status: 'COMPLETED', evidence: { evidenceId: 'e1' },
      executionResult: { taskId, executedBy: { toolName: action.toolName }, success: true, packetId: 'p1', outputPaths: [path] } } };
  const reader = createOperationArtifactReader({ readOperation: async () => record, allowedRoots: [base], allowedTaskIds: [taskId], ...options });
  return { base, path, action, record, reader, input: { operationId, taskId, action } };
}

test('reads actual UTF8 bytes under a selected operation without granting completion', async t => {
  const f = await fixture(t), value = await f.reader(f.input);
  assert.equal(Buffer.from(value.bytes, 'base64').toString('utf8'), f.action.arguments.content);
  assert.equal(value.size, Buffer.byteLength(f.action.arguments.content));
  assert.equal(value.verifiedCompletion, false); assert.equal(value.executionAuthority, false);
});
test('forged receipt and unselected task are denied before publishing bytes', async t => {
  for (const key of ['fingerprint', 'state', 'operationId']) {
    const f = await fixture(t); f.record[key] = 'forged';
    await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_RECEIPT_MISMATCH' });
  }
  const f = await fixture(t);
  await assert.rejects(f.reader({ ...f.input, taskId: 'other' }), { code: 'A_PC_ARTIFACT_SCOPE_DENIED' });
});
test('journal success cannot hide changed file bytes', async t => {
  const f = await fixture(t); await writeFile(f.path, 'tampered');
  await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_CONTENT_MISMATCH' });
});
test('actual B status success is supported but explicit false or unknown status never proves success',async t=>{
  for(const mode of ['status-only','explicit-false','unknown']){
    const f=await fixture(t),result=f.record.receipt.executionResult;
    delete result.success;result.status='success';
    if(mode==='explicit-false')result.success=false;
    if(mode==='unknown')result.status='unknown';
    if(mode==='status-only')assert.equal((await f.reader(f.input)).verifiedCompletion,false);
    else await assert.rejects(f.reader(f.input),{code:'A_PC_ARTIFACT_RECEIPT_MISMATCH'});
  }
});
test('oversized artifact or original content is never exported', async t => {
  const f = await fixture(t); await writeFile(f.path, Buffer.alloc(65537));
  await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_BUDGET_EXCEEDED' });
  f.action.arguments.content = 'x'.repeat(65537);
  await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_BUDGET_EXCEEDED' });
});
test('rename-and-replace during descriptor read invalidates observation', async t => {
  let replaced = false, f;
  f = await fixture(t, { onRead: async () => {
    if (replaced) return; replaced = true;
    await rename(f.path, join(f.base, 'old.txt')); await writeFile(f.path, f.action.arguments.content);
  } });
  await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_CHANGED' });
});
test('physical symlink escape is denied', { skip: process.platform === 'win32' ? 'Windows symlink privilege is not assumed' : false }, async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'jarvis-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private'), f.action.arguments.content); await rm(f.path);
  await symlink(join(outside, 'private'), f.path);
  await assert.rejects(f.reader(f.input), { code: 'A_PC_ARTIFACT_OUTSIDE_ROOT' });
});
test('caller or journal adapter cannot change snapshotted target while awaiting receipt', async t => {
  const f = await fixture(t);
  const reader = createOperationArtifactReader({ allowedRoots: [f.base], allowedTaskIds: [f.input.taskId],
    readOperation: async input => { input.action.arguments.path = join(f.base, 'other'); f.action.arguments.path = join(f.base, 'other'); return f.record; } });
  assert.equal(Buffer.from((await reader(f.input)).bytes, 'base64').toString('utf8'), '검증할 원문');
});
test('same file bytes and inode in a replaced root cannot reuse its configured physical scope',async t=>{
  const f=await fixture(t),replacement=f.base+'-replacement',old=f.base+'-old';
  t.after(async()=>{await rm(replacement,{recursive:true,force:true});await rm(old,{recursive:true,force:true});});
  await mkdir(replacement);await link(f.path,join(replacement,'result.txt'));
  await rename(f.base,old);await rename(replacement,f.base);
  await assert.rejects(f.reader(f.input),{code:'A_PC_ARTIFACT_ROOT_CHANGED'});
});
test('root replacement during descriptor reading invalidates even a pre-existing hardlink of identical content',async t=>{
  let f,swapped=false;
  f=await fixture(t,{onRead:async()=>{
    if(swapped)return;swapped=true;await rename(f.base,f.base+'-old');await rename(f.base+'-replacement',f.base);
  }});
  t.after(async()=>{await rm(f.base+'-replacement',{recursive:true,force:true});await rm(f.base+'-old',{recursive:true,force:true});});
  await mkdir(f.base+'-replacement');await link(f.path,join(f.base+'-replacement','result.txt'));
  await assert.rejects(f.reader(f.input),{code:process.platform==='win32'?'EPERM':'A_PC_ARTIFACT_ROOT_CHANGED'});
});
test('ordinary directory changes retain identity and root scope is a digest rather than raw path metadata',async t=>{
  const f=await fixture(t),first=await f.reader(f.input);
  await writeFile(join(f.base,'unrelated.txt'),'normal change');
  const second=await f.reader(f.input);
  assert.match(first.rootScopeSha256,/^[a-f0-9]{64}$/u);assert.equal(first.rootScopeSha256,second.rootScopeSha256);
  assert.equal(first.physical,undefined);assert.equal(first.dev,undefined);
});
test('persisted expected root digest survives a reader restart and refuses replacement roots',async t=>{
  const f=await fixture(t),first=await f.reader(f.input),options={readOperation:async()=>f.record,allowedRoots:[f.base],allowedTaskIds:[f.input.taskId],expectedRootScopeSha256:first.rootScopeSha256};
  assert.equal((await createOperationArtifactReader(options)(f.input)).rootScopeSha256,first.rootScopeSha256);
  const old=f.base+'-old';t.after(()=>rm(old,{recursive:true,force:true}));
  await rename(f.base,old);await mkdir(f.base);await writeFile(f.path,f.action.arguments.content);
  assert.throws(()=>createOperationArtifactReader(options),{code:'A_PC_ARTIFACT_ROOT_SCOPE_MISMATCH'});
});

for(const mode of ['normal','during-receipt','during-read'])test(`managed PC artifact catalog binds actual bytes and rejects revoked publication: ${mode}`,async t=>{
 const f=await fixture(t),scope=new PcLocalTaskScope({dbPath:':memory:',managedCatalog:true});t.after(()=>scope.close());
 scope.replaceCatalog({expectedRevision:0,allowedTaskIds:[f.input.taskId],allowedArtifactTaskIds:[f.input.taskId],allowedCommandTaskIds:[]});
 const revoke=()=>scope.replaceCatalog({expectedRevision:1,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});let revoked=false;
 const reader=createOperationArtifactReader({allowedTaskIds:[],allowedRoots:[f.base],taskCatalog:scope,readOperation:async()=>{if(mode==='during-receipt')revoke();return f.record;},onRead:async()=>{if(mode==='during-read'&&!revoked){revoked=true;revoke();}}});
 if(mode==='normal'){const value=await reader(f.input);assert.equal(Buffer.from(value.bytes,'base64').toString('utf8'),f.action.arguments.content);assert.equal(value.executionAuthority,false);}
 else await assert.rejects(reader(f.input),/LOCAL_SCOPE_CHANGED/u);
});
